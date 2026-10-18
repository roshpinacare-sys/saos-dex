import { NextRequest, NextResponse } from "next/server";
import client from "prom-client";
import winston from "winston";

// Configuration
const ENABLE_ANOMALY_DETECTION = process.env.ENABLE_ANOMALY_DETECTION === "true";
const WINDOW_MS = 60_000;
const LIMIT_INTERNAL = 2_000;
const LIMIT_PUBLIC = 240;
const MAX_KEYS = 5_000;
const EXEMPT = ["/api/dex/stream", "/api/revive"];
const SENSITIVE_PATHS = ["/api/dex/agent", "/api/dex/order", "/api/dex/swap", "/api/dex/portfolio", "/api/dex/wallets"];
const INJECTION_PATTERNS = [/(\%27|\')(\s*)(--|#|\/\*)/i, /union\s+select/i, /insert\s+into/i, /delete\s+from/i, /drop\s+table/i, /\.\.(%2e|%252e)+/i, /(%2f|%252f)+/i];

// Prometheus metrics
const anomaliesTotal = new client.Counter({
  name: "dex_middleware_anomalies_total",
  help: "Total number of detected anomalies by type",
  labelNames: ["type", "path", "method"],
});
const blockedRequestsTotal = new client.Counter({
  name: "dex_middleware_blocked_requests_total",
  help: "Total number of blocked requests by reason",
  labelNames: ["reason"],
});
const suspiciousIpScore = new client.Gauge({
  name: "dex_middleware_suspicious_ip_score",
  help: "Current suspicious score per IP (0-100)",
  labelNames: ["ip"],
});
const error4xxTotal = new client.Counter({
  name: "dex_middleware_error_4xx_total",
  help: "Total 4xx errors by IP and path",
  labelNames: ["ip", "path", "status"],
});
const error5xxTotal = new client.Counter({
  name: "dex_middleware_error_5xx_total",
  help: "Total 5xx errors by IP and path",
  labelNames: ["ip", "path", "status"],
});

// Winston logger
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "logs/anomaly.log" })
  ],
});

// In-memory stores
const buckets = new Map<string, number[]>();
const ipHistory = new Map<string, string[]>();
const errorCounts = new Map<string, Map<string, number>>(); // ip -> path -> count
const suspiciousScores = new Map<string, number>();

function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1] ?? "proxied";
    return "proxied";
  }
  return req.headers.get("x-real-ip") ?? "local";
}

function detectInjection(path: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(path));
}

function detectSensitiveAccess(path: string): boolean {
  return SENSITIVE_PATHS.some((sensitive) => path.startsWith(sensitive));
}

function updateIpHistory(ip: string, currentIp: string): void {
  if (!ipHistory.has(ip)) {
    ipHistory.set(ip, []);
  }
  const history = ipHistory.get(ip)!;
  if (history.length > 0 && history[history.length - 1] !== currentIp) {
    history.push(currentIp);
    if (history.length > 5) history.shift();
  } else if (history.length === 0) {
    history.push(currentIp);
  }
}

function calculateGeoJumpScore(history: string[]): number {
  if (history.length < 2) return 0;
  const first = history[0];
  const last = history[history.length - 1];
  // Simple heuristic: if IPs are different, assume potential geo-jump
  // In production, use IP geolocation service
  return first !== last ? 30 : 0;
}

function updateErrorCount(ip: string, path: string, status: number): void {
  if (!errorCounts.has(ip)) {
    errorCounts.set(ip, new Map<string, number>());
  }
  const pathMap = errorCounts.get(ip)!;
  const count = pathMap.get(path) ?? 0;
  pathMap.set(path, count + 1);
}

function checkErrorThreshold(ip: string, path: string, status: number): boolean {
  if (!errorCounts.has(ip)) return false;
  const pathMap = errorCounts.get(ip)!;
  const count = pathMap.get(path) ?? 0;
  return status >= 400 && status < 500 && count > 5;
}

function logAnomaly(ip: string, path: string, method: string, anomalyType: string, riskScore: number, userAgent: string): void {
  if (!ENABLE_ANOMALY_DETECTION) return;

  logger.warn("Security anomaly detected", {
    timestamp: new Date().toISOString(),
    ip,
    path,
    method,
    userAgent,
    anomalyType,
    riskScore,
  });

  anomaliesTotal.inc({ type: anomalyType, path, method });
  suspiciousIpScore.set({ ip }, Math.min(100, suspiciousScores.get(ip) ?? 0 + riskScore)); 
  suspiciousScores.set(ip, Math.min(100, (suspiciousScores.get(ip) ?? 0) + riskScore));
}

function shouldBlockRequest(ip: string, path: string, method: string): { blocked: boolean; reason: string; riskScore: number } {
  if (!ENABLE_ANOMALY_DETECTION) return { blocked: false, reason: "", riskScore: 0 };

  let riskScore = 0;
  let blockReason = "";

  // Check for injection patterns
  if (detectInjection(path)) {
    riskScore += 40;
    blockReason = "injection_attempt";
  }

  // Check for sensitive path access without auth (simplified)
  if (detectSensitiveAccess(path)) {
    riskScore += 30;
    if (!blockReason) blockReason = "sensitive_path_access";
  }

  // Check error thresholds
  if (checkErrorThreshold(ip, path, 400)) {
    riskScore += 20;
    if (!blockReason) blockReason = "repeated_4xx_errors";
  }

  const shouldBlock = riskScore >= 50;
  return { blocked: shouldBlock, reason: blockReason || "high_risk", riskScore };
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  if (EXEMPT.some((p) => pathname.includes(p))) return NextResponse.next();

  const ip = clientIp(req);
  const isPublic = req.headers.has("x-forwarded-for");
  const limit = isPublic ? LIMIT_PUBLIC : LIMIT_INTERNAL;
  const method = req.method;
  const userAgent = req.headers.get("user-agent") ?? "unknown";

  const now = Date.now();
  let bucket = buckets.get(ip);
  if (!bucket) {
    bucket = [];
    buckets.set(ip, bucket);
  }
  while (bucket.length > 0 && bucket[0] !== undefined && now - bucket[0] >= WINDOW_MS) {
    bucket.shift();
  }

  // Rate limiting
  if (bucket.length >= limit) {
    const oldest = bucket[0] ?? now;
    const retryAfter = Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000));
    blockedRequestsTotal.inc({ reason: "rate_limit" });
    return NextResponse.json(
      {
        ok: false,
        error: `rate-limited: ${limit} req/min per IP (honest budget — retry later)`,
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(retryAfter),
          "X-RateLimit-Limit": String(limit),
          "X-RateLimit-Remaining": "0",
          "X-Anomaly-Flag": "true",
        },
      }
    );
  }
  bucket.push(now);

  // Anomaly detection
  const { blocked, reason, riskScore } = shouldBlockRequest(ip, pathname, method);
  if (blocked) {
    blockedRequestsTotal.inc({ reason });
    logAnomaly(ip, pathname, method, reason, riskScore, userAgent);
    return NextResponse.json(
      {
        ok: false,
        error: `blocked: ${reason}`,
      },
      {
        status: 403,
        headers: {
          "X-Anomaly-Flag": "true",
        },
      }
    );
  }

  // Update IP history for geo-jump detection
  updateIpHistory(ip, ip);
  const history = ipHistory.get(ip)!;
  const geoScore = calculateGeoJumpScore(history);
  if (geoScore > 0) {
    logAnomaly(ip, pathname, method, "geo_jump", geoScore, userAgent);
  }

  // Anti-memory-explosion: prune old IPs
  if (buckets.size > MAX_KEYS) {
    const it = buckets.keys();
    for (let i = 0; i < 1_000; i += 1) {
      const k = it.next();
      if (k.done) break;
      if (k.value !== ip) buckets.delete(k.value);
    }
  }

  const res = NextResponse.next();
  res.headers.set("X-RateLimit-Limit", String(limit));
  res.headers.set("X-RateLimit-Remaining", String(Math.max(0, limit - bucket.length)));
  if (ENABLE_ANOMALY_DETECTION && riskScore > 0) {
    res.headers.set("X-Anomaly-Flag", "true");
  }
  return res;
}

export const config = {
  matcher: ["/api/dex/:path*"],
};
