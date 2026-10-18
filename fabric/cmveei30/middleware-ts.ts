import { NextRequest, NextResponse } from "next/server";

/**
 * Advanced anomaly detection middleware with behavioral learning
 * Tracks request patterns per IP and detects deviations from normal behavior
 */
const WINDOW_MS = 60_000;
const LIMIT_INTERNAL = 2_000;
const LIMIT_PUBLIC = 240;
const MAX_KEYS = 5_000;
const EXEMPT = ["/api/dex/stream", "/api/revive"];

// Critical endpoints that require special monitoring
const CRITICAL_ENDPOINTS = [
  "/api/dex/order",
  "/api/dex/swap",
  "/api/dex/transfer",
  "/api/dex/cancel",
  "/api/dex/bridge",
  "/api/dex/onramp",
  "/api/dex/settle"
];

// Suspicious parameter patterns
const SUSPICIOUS_PARAMS = [
  /\b(union|select|insert|update|delete|drop|exec|execute)\b/i,
  /\b(<script|javascript:|vbscript:|onload|onerror|onclick)\b/i,
  /\b(../../|\\.\\.|%2e%2e%2f|%252e%252e%252f)/i,
  /\b(alert\(|prompt\(|confirm\(|eval\()\b/i
];

interface RequestPattern {
  timestamp: number;
  method: string;
  pathname: string;
  params: Record<string, string>;
  isCritical: boolean;
  hasSuspiciousParams: boolean;
}

interface IPBehavior {
  requests: RequestPattern[];
  firstSeen: number;
  lastSeen: number;
  avgRate: number;
  criticalRate: number;
  anomalyScore: number;
  blockedUntil: number;
}

const buckets = new Map<string, IPBehavior>();

function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1] ?? "proxied";
    return "proxied";
  }
  return req.headers.get("x-real-ip") ?? "local";
}

function hasSuspiciousParams(params: URLSearchParams): boolean {
  for (const [key, value] of params.entries()) {
    const combined = `${key}=${value}`;
    for (const pattern of SUSPICIOUS_PARAMS) {
      if (pattern.test(combined)) return true;
    }
  }
  return false;
}

function calculateAnomalyScore(behavior: IPBehavior, now: number): number {
  if (behavior.requests.length < 10) return 0; // Need minimum data

  const recent = behavior.requests.slice(-20);
  const timeWindow = now - behavior.firstSeen;
  const rate = timeWindow > 0 ? (behavior.requests.length * 60000) / timeWindow : 0;

  // Calculate deviation from normal rate
  const rateDeviation = behavior.avgRate > 0 ? Math.abs(rate - behavior.avgRate) / behavior.avgRate : 0;

  // Check for critical endpoint abuse
  const criticalRequests = recent.filter(r => r.isCritical).length;
  const criticalRatio = criticalRequests / recent.length;

  // Check for suspicious parameters
  const suspiciousRequests = recent.filter(r => r.hasSuspiciousParams).length;
  const suspiciousRatio = suspiciousRequests / recent.length;

  // Check for rapid bursts (more than 3x avg rate in last 10s)
  const last10s = behavior.requests.filter(r => now - r.timestamp < 10_000).length;
  const burstScore = last10s > 0 ? Math.min(last10s / (behavior.avgRate * 0.1), 5) : 0;

  // Combine factors
  let score = 0;
  score += Math.min(rateDeviation, 3);
  score += criticalRatio * 2;
  score += suspiciousRatio * 3;
  score += Math.min(burstScore, 2);

  return Math.min(score, 10);
}

function logAnomaly(ip: string, behavior: IPBehavior, reason: string, now: number) {
  const logEntry = {
    timestamp: new Date(now).toISOString(),
    ip,
    reason,
    requestCount: behavior.requests.length,
    avgRate: Math.round(behavior.avgRate),
    criticalRate: Math.round(behavior.criticalRate * 60),
    anomalyScore: Math.round(behavior.anomalyScore * 100) / 100,
    firstSeen: new Date(behavior.firstSeen).toISOString(),
    lastSeen: new Date(behavior.lastSeen).toISOString()
  };

  console.error("[ANOMALY-DETECTION]", JSON.stringify(logEntry));

  // In production, this would send to Sentry/Prometheus
  // Example: Sentry.captureMessage(`Anomaly detected: ${reason}`, { extra: logEntry });
}

function cleanupOldBuckets(now: number) {
  if (buckets.size <= MAX_KEYS) return;

  const it = buckets.entries();
  const toRemove = [];

  for (let i = 0; i < Math.min(1000, buckets.size); i++) {
    const entry = it.next();
    if (entry.done) break;
    const [ip, behavior] = entry.value;
    if (now - behavior.lastSeen > 300_000) { // 5 minutes inactive
      toRemove.push(ip);
    }
  }

  for (const ip of toRemove) {
    buckets.delete(ip);
  }
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  if (EXEMPT.some((p) => pathname.includes(p))) return NextResponse.next();

  const ip = clientIp(req);
  const isPublic = req.headers.has("x-forwarded-for");
  const baseLimit = isPublic ? LIMIT_PUBLIC : LIMIT_INTERNAL;
  const now = Date.now();

  // Get or create behavior tracking
  let behavior = buckets.get(ip);
  if (!behavior) {
    behavior = {
      requests: [],
      firstSeen: now,
      lastSeen: now,
      avgRate: 0,
      criticalRate: 0,
      anomalyScore: 0,
      blockedUntil: 0
    };
    buckets.set(ip, behavior);
  }

  behavior.lastSeen = now;

  // Cleanup old entries periodically
  if (now % 30_000 < 1000) { // Every ~30 seconds
    cleanupOldBuckets(now);
  }

  // Check if currently blocked
  if (now < behavior.blockedUntil) {
    const retryAfter = Math.ceil((behavior.blockedUntil - now) / 1000);
    return NextResponse.json(
      {
        ok: false,
        error: `temporarily blocked due to anomalous behavior - retry after ${retryAfter}s`,
        anomaly: true
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(retryAfter),
          "X-Anomaly-Detected": "true"
        }
      }
    );
  }

  // Extract request info
  const method = req.method;
  const params = req.nextUrl.searchParams;
  const isCritical = CRITICAL_ENDPOINTS.some(endpoint => pathname.includes(endpoint));
  const hasSuspiciousParams = hasSuspiciousParams(params);

  const requestPattern: RequestPattern = {
    timestamp: now,
    method,
    pathname,
    params: Object.fromEntries(params.entries()),
    isCritical,
    hasSuspiciousParams
  };

  behavior.requests.push(requestPattern);

  // Keep only recent requests (last 100)
  if (behavior.requests.length > 100) {
    behavior.requests = behavior.requests.slice(-100);
  }

  // Update behavioral metrics
  const timeWindow = now - behavior.firstSeen;
  behavior.avgRate = timeWindow > 0 ? (behavior.requests.length * 60000) / timeWindow : 0;

  const criticalCount = behavior.requests.filter(r => r.isCritical).length;
  behavior.criticalRate = timeWindow > 0 ? (criticalCount * 60000) / timeWindow : 0;

  // Calculate anomaly score
  behavior.anomalyScore = calculateAnomalyScore(behavior, now);

  // Determine if we should block based on anomaly score
  let limit = baseLimit;
  if (behavior.anomalyScore > 7) {
    // High anomaly - reduce limit significantly
    limit = Math.max(10, Math.floor(baseLimit * (1 - behavior.anomalyScore / 15)));
    logAnomaly(ip, behavior, "High anomaly score detected", now);
  } else if (behavior.anomalyScore > 4) {
    // Medium anomaly - reduce limit moderately
    limit = Math.max(50, Math.floor(baseLimit * (1 - behavior.anomalyScore / 10)));
    logAnomaly(ip, behavior, "Medium anomaly score detected", now);
  }

  // Clean old requests from window
  while (behavior.requests.length > 0 &&
         behavior.requests[0] !== undefined &&
         now - behavior.requests[0].timestamp >= WINDOW_MS) {
    behavior.requests.shift();
  }

  // Check rate limit
  if (behavior.requests.length >= limit) {
    const oldest = behavior.requests[0] ?? { timestamp: now };
    const retryAfter = Math.max(1, Math.ceil((WINDOW_MS - (now - oldest.timestamp)) / 1000));

    // Increase block time for repeat offenders
    const baseBlockTime = Math.min(300, retryAfter * 2); // Max 5 minutes
    const anomalyMultiplier = 1 + (behavior.anomalyScore / 10);
    const blockTime = Math.min(600, baseBlockTime * anomalyMultiplier); // Max 10 minutes

    behavior.blockedUntil = now + (blockTime * 1000);

    logAnomaly(ip, behavior, `Rate limit exceeded (${limit}/min) - blocking for ${blockTime}s`, now);

    return NextResponse.json(
      {
        ok: false,
        error: `rate-limited: ${limit} req/min per IP (anomaly detection - retry later)`,
        anomaly: true,
        anomalyScore: behavior.anomalyScore
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(blockTime),
          "X-RateLimit-Limit": String(limit),
          "X-RateLimit-Remaining": "0",
          "X-Anomaly-Score": String(behavior.anomalyScore),
          "X-Anomaly-Detected": "true"
        }
      }
    );
  }

  const res = NextResponse.next();
  res.headers.set("X-RateLimit-Limit", String(limit));
  res.headers.set("X-RateLimit-Remaining", String(Math.max(0, limit - behavior.requests.length)));
  res.headers.set("X-Anomaly-Score", String(Math.round(behavior.anomalyScore * 100) / 100));
  return res;
}

export const config = {
  matcher: ["/api/dex/:path*"]
};