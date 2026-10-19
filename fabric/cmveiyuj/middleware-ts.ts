import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";

// Rate limiting constants (existing)
const WINDOW_MS = 60_000;
const LIMIT_INTERNAL = 2_000;
const LIMIT_PUBLIC = 240;
const MAX_KEYS = 5_000;
const EXEMPT = ["/api/dex/stream", "/api/revive"];

// Behavioral anomaly detection constants
const BEHAVIOR_WINDOW_MS = 300_000; // 5 minutes
const MAX_BEHAVIOR_KEYS = 10_000;
const SUSPICIOUS_ENDPOINTS = new Set([
  "/api/dex/settle",
  "/api/dex/transfer",
  "/api/dex/order",
  "/api/dex/swap",
  "/api/dex/pool"
]);
const SUSPICIOUS_PARAMS = ["amount", "price", "tokenIn", "tokenOut", "slippage"];
const RATE_CHANGE_THRESHOLD = 3.0; // 3x normal rate
const MIN_REQUESTS_FOR_BASELINE = 5;

// Risk scoring weights
const WEIGHTS = {
  RATE_ANOMALY: 0.3,
  ENDPOINT_ANOMALY: 0.25,
  PARAM_ANOMALY: 0.2,
  HEADER_ANOMALY: 0.15,
  SEQUENCE_ANOMALY: 0.1
};

// In-memory stores (in production, use Redis)
const requestCounts = new Map<string, { count: number; resetTime: number }>();
const behaviorProfiles = new Map<string, {
  firstSeen: number;
  lastSeen: number;
  requestCount: number;
  endpointCounts: Map<string, number>;
  paramPatterns: Map<string, Set<string>>;
  headerPatterns: Map<string, Set<string>>;
  sequence: string[];
  avgInterval: number;
  lastRequestTime: number;
}>();
const riskScores = new Map<string, { score: number; lastUpdated: number; blockLevel: number }>();

function getClientIP(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const ips = forwarded.split(",").map(ip => ip.trim());
    return ips[ips.length - 1]; // Last IP (closest to server)
  }
  return req.ip ?? "unknown";
}

function isInternalRequest(ip: string): boolean {
  return !ip || ip === "unknown" || ip.startsWith("127.") || ip.startsWith("10.") || ip.startsWith("192.168.");
}

function getRateLimit(ip: string): number {
  return isInternalRequest(ip) ? LIMIT_INTERNAL : LIMIT_PUBLIC;
}

function updateRequestCount(ip: string, pathname: string): { allowed: boolean; current: number; limit: number } {
  const now = Date.now();
  const limit = getRateLimit(ip);
  let entry = requestCounts.get(ip);

  if (!entry || now > entry.resetTime) {
    entry = { count: 1, resetTime: now + WINDOW_MS };
    requestCounts.set(ip, entry);
    return { allowed: true, current: 1, limit };
  }

  if (entry.count >= limit) {
    return { allowed: false, current: entry.count, limit };
  }

  entry.count++;
  return { allowed: true, current: entry.count, limit };
}

function updateBehaviorProfile(ip: string, req: NextRequest): void {
  const now = Date.now();
  let profile = behaviorProfiles.get(ip);

  if (!profile) {
    profile = {
      firstSeen: now,
      lastSeen: now,
      requestCount: 0,
      endpointCounts: new Map(),
      paramPatterns: new Map(),
      headerPatterns: new Map(),
      sequence: [],
      avgInterval: 0,
      lastRequestTime: now
    };
    behaviorProfiles.set(ip, profile);
  }

  const timeSinceLast = now - profile.lastRequestTime;
  profile.requestCount++;
  profile.lastSeen = now;

  // Update average interval
  if (profile.requestCount > 1) {
    profile.avgInterval = (profile.avgInterval * (profile.requestCount - 1) + timeSinceLast) / profile.requestCount;
  }

  // Update endpoint counts
  const pathname = req.nextUrl.pathname;
  const endpointCount = profile.endpointCounts.get(pathname) ?? 0;
  profile.endpointCounts.set(pathname, endpointCount + 1);

  // Update parameter patterns (for suspicious endpoints)
  if (SUSPICIOUS_ENDPOINTS.has(pathname)) {
    const searchParams = req.nextUrl.searchParams;
    SUSPICIOUS_PARAMS.forEach(param => {
      const value = searchParams.get(param);
      if (value !== null) {
        let paramSet = profile.paramPatterns.get(param);
        if (!paramSet) {
          paramSet = new Set();
          profile.paramPatterns.set(param, paramSet);
        }
        paramSet.add(value);
      }
    });
  }

  // Update header patterns
  const headersToCheck = ["user-agent", "accept", "content-type", "referer"];
  headersToCheck.forEach(header => {
    const value = req.headers.get(header);
    if (value !== null) {
      let headerSet = profile.headerPatterns.get(header);
      if (!headerSet) {
        headerSet = new Set();
        profile.headerPatterns.set(header, headerSet);
      }
      headerSet.add(value);
    }
  });

  // Update sequence (keep last 10 requests)
  profile.sequence.push(pathname);
  if (profile.sequence.length > 10) {
    profile.sequence.shift();
  }

  profile.lastRequestTime = now;

  // Cleanup old profiles
  if (behaviorProfiles.size > MAX_BEHAVIOR_KEYS) {
    const oldestIp = Array.from(behaviorProfiles.entries())
      .sort(([,a], [,b]) => a.lastSeen - b.lastSeen)[0][0];
    behaviorProfiles.delete(oldestIp);
    riskScores.delete(oldestIp);
  }
}

function calculateRiskScore(ip: string, req: NextRequest): number {
  const profile = behaviorProfiles.get(ip);
  if (!profile || profile.requestCount < MIN_REQUESTS_FOR_BASELINE) {
    return 0;
  }

  let score = 0;
  const now = Date.now();

  // 1. Rate anomaly detection
  const timeWindow = Math.min(now - profile.firstSeen, BEHAVIOR_WINDOW_MS);
  const expectedRate = profile.requestCount / (timeWindow / 1000) * 60; // requests per minute
  const currentRate = getRateLimit(ip);
  if (expectedRate > 0 && currentRate > 0) {
    const rateRatio = expectedRate / currentRate;
    if (rateRatio > RATE_CHANGE_THRESHOLD) {
      score += WEIGHTS.RATE_ANOMALY * Math.min(rateRatio / RATE_CHANGE_THRESHOLD, 1);
    }
  }

  // 2. Endpoint anomaly detection
  const totalRequests = profile.requestCount;
  const suspiciousEndpointCount = Array.from(profile.endpointCounts.entries())
    .reduce((sum, [endpoint, count]) => {
      return SUSPICIOUS_ENDPOINTS.has(endpoint) ? sum + count : sum;
    }, 0);
  const endpointRatio = suspiciousEndpointCount / totalRequests;
  if (endpointRatio > 0.7) { // More than 70% requests to suspicious endpoints
    score += WEIGHTS.ENDPOINT_ANOMALY * endpointRatio;
  }

  // 3. Parameter anomaly detection
  let paramAnomalyScore = 0;
  let paramCount = 0;
  profile.paramPatterns.forEach((values, param) => {
    if (values.size > 10) { // Too many unique values for a parameter
      paramAnomalyScore += 1;
    }
    paramCount++;
  });
  if (paramCount > 0) {
    score += WEIGHTS.PARAM_ANOMALY * (paramAnomalyScore / paramCount);
  }

  // 4. Header anomaly detection
  let headerAnomalyScore = 0;
  let headerCount = 0;
  profile.headerPatterns.forEach((values, header) => {
    if (values.size > 20) { // Too many unique header values
      headerAnomalyScore += 1;
    }
    headerCount++;
  });
  if (headerCount > 0) {
    score += WEIGHTS.HEADER_ANOMALY * (headerAnomalyScore / headerCount);
  }

  // 5. Sequence anomaly detection
  const sequence = profile.sequence;
  if (sequence.length >= 3) {
    // Check for repetitive patterns (e.g., same endpoint 3+ times in a row)
    let repetitiveCount = 0;
    for (let i = 0; i < sequence.length - 2; i++) {
      if (sequence[i] === sequence[i+1] && sequence[i+1] === sequence[i+2]) {
        repetitiveCount++;
        i += 2; // Skip ahead to avoid overlapping counts
      }
    }
    if (repetitiveCount > 0) {
      score += WEIGHTS.SEQUENCE_ANOMALY * Math.min(repetitiveCount / 3, 1);
    }

    // Check for rapid-fire suspicious endpoint access
    let rapidSuspicious = 0;
    for (let i = 0; i < sequence.length - 1; i++) {
      if (SUSPICIOUS_ENDPOINTS.has(sequence[i]) && SUSPICIOUS_ENDPOINTS.has(sequence[i+1])) {
        const timeBetween = profile.lastRequestTime - (profile.firstSeen + i * 1000); // Rough estimate
        if (timeBetween < 1000) { // Less than 1 second between suspicious requests
          rapidSuspicious++;
        }
      }
    }
    if (rapidSuspicious > 0) {
      score += WEIGHTS.SEQUENCE_ANOMALY * Math.min(rapidSuspicious / 2, 1);
    }
  }

  return Math.min(score, 1.0); // Cap at 1.0
}

function getBlockLevel(score: number): number {
  if (score >= 0.9) return 3; // Full block
  if (score >= 0.7) return 2; // Moderate throttling
  if (score >= 0.4) return 1; // Light throttling
  return 0; // No block
}

function applyBlock(req: NextRequest, ip: string, score: number, blockLevel: number): NextResponse | null {
  if (blockLevel === 0) return null;

  const now = Date.now();
  riskScores.set(ip, { score, lastUpdated: now, blockLevel });

  // Log the anomaly
  console.warn(JSON.stringify({
    timestamp: new Date(now).toISOString(),
    action: "behavioral_anomaly_detected",
    ip,
    path: req.nextUrl.pathname,
    riskScore: score,
    blockLevel,
    reason: `Behavioral anomaly detected: score ${score.toFixed(2)}`,
    requestCount: behaviorProfiles.get(ip)?.requestCount ?? 0
  }));

  // Apply blocking based on level
  switch (blockLevel) {
    case 1: // Light throttling - add delay
      return new NextResponse("Too Many Requests - Light Throttling", {
        status: 429,
        headers: {
          "Retry-After": "2",
          "X-Risk-Score": score.toString(),
          "X-Block-Level": "1"
        }
      });
    case 2: // Moderate throttling - longer delay and stricter limit
      return new NextResponse("Too Many Requests - Moderate Throttling", {
        status: 429,
        headers: {
          "Retry-After": "10",
          "X-Risk-Score": score.toString(),
          "X-Block-Level": "2"
        }
      });
    case 3: // Full block
      return new NextResponse("Access Denied - Security Policy", {
        status: 403,
        headers: {
          "X-Risk-Score": score.toString(),
          "X-Block-Level": "3"
        }
      });
    default:
      return null;
  }
}

export async function middleware(req: NextRequest, event: NextFetchEvent) {
  const pathname = req.nextUrl.pathname;

  // Exempt paths
  if (EXEMPT.some(path => pathname.startsWith(path))) {
    return NextResponse.next();
  }

  const ip = getClientIP(req);

  // Update rate limiting
  const rateLimitResult = updateRequestCount(ip, pathname);
  if (!rateLimitResult.allowed) {
    console.warn(JSON.stringify({
      timestamp: new Date().toISOString(),
      action: "rate_limit_exceeded",
      ip,
      path: pathname,
      current: rateLimitResult.current,
      limit: rateLimitResult.limit
    }));
    return new NextResponse("Too Many Requests", {
      status: 429,
      headers: { "Retry-After": "60" }
    });
  }

  // Update behavioral profile
  updateBehaviorProfile(ip, req);

  // Calculate risk score and apply behavioral blocking
  const riskScore = calculateRiskScore(ip, req);
  const blockLevel = getBlockLevel(riskScore);

  const behavioralBlock = applyBlock(req, ip, riskScore, blockLevel);
  if (behavioralBlock) {
    return behavioralBlock;
  }

  return NextResponse.next();
}

// Export config for matcher
export const config = {
  matcher: [
    "/api/dex/:path*",
    "/api/revive"
  ]
};