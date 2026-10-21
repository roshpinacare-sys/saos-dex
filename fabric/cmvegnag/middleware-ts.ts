import { NextRequest, NextResponse } from "next/server";

// Behavior analytics state — persisted across requests in the same process
const riskState = new Map<string, { score: number; lastReset: number; endpointHistory: Map<string, number[]> }>();

const WINDOW_MS = 60_000;
const BASE_SCORE = 0;
const MAX_SCORE = 100;
const CRITICAL_SCORE = 80;
const RESET_TIMEOUT = 300_000; // 5 minutes

// Exempt endpoints that should not be scored
const EXEMPT_ENDPOINTS = new Set([
  "/api/dex/stream",
  "/api/revive",
]);

// Critical endpoints that trigger higher scoring
const CRITICAL_ENDPOINTS = new Set([
  "/api/dex/settle",
  "/api/dex/transfer",
]);

// Suspicious nonce patterns
const SUSPICIOUS_NONCE_PATTERNS = [
  /^0{32}$/, // All zeros
  /^ff{32}$/, // All F's
  /^(\d{1,2})\1{31}$/, // Repeated single digit
];

function calculateRiskScore(ip: string, endpoint: string, now: number): number {
  let score = BASE_SCORE;

  // 1. IP reputation — new IPs get higher initial scrutiny
  const ipEntry = riskState.get(ip);
  if (!ipEntry) {
    // New IP — start with baseline scrutiny
    score += 15;
  } else {
    // Decay existing score over time
    const timeSinceReset = now - ipEntry.lastReset;
    if (timeSinceReset > RESET_TIMEOUT) {
      // Old state — reset completely
      score = BASE_SCORE;
    } else {
      // Decay by 50% each window
      score = Math.max(BASE_SCORE, ipEntry.score - (ipEntry.score * 0.5 * (timeSinceReset / RESET_TIMEOUT)));
    }
  }

  // 2. Endpoint sensitivity
  if (CRITICAL_ENDPOINTS.has(endpoint)) {
    score += 25;
  }

  // 3. Behavioral analysis — request frequency
  const endpointHistory = ipEntry?.endpointHistory?.get(endpoint) || new Map();
  const timestamps = endpointHistory.get("timestamps") || [];
  const recentRequests = timestamps.filter(ts => now - ts < WINDOW_MS).length;

  if (recentRequests > 50) {
    score += 20; // Flood detection
  } else if (recentRequests > 20) {
    score += 10; // Elevated activity
  }

  // 4. Nonce pattern analysis (for order endpoints)
  if (endpoint.includes("/order") || endpoint.includes("/settle")) {
    const nonceParam = extractNonceParameter(endpoint);
    if (nonceParam) {
      const isSuspicious = SUSPICIOUS_NONCE_PATTERNS.some(pattern => pattern.test(nonceParam));
      if (isSuspicious) {
        score += 30; // Suspicious nonce
      }
    }
  }

  // 5. Temporal patterns — unusual hour activity
  const hour = now / 3600000 % 24;
  if (hour >= 0 && hour < 6) {
    score += 5; // Late night activity
  }

  return Math.min(score, MAX_SCORE);
}

function extractNonceParameter(endpoint: string): string | null {
  // Try to extract nonce from query parameters or path
  const url = new URL(endpoint, "http://localhost");
  return url.searchParams.get("nonce") || null;
}

export function checkBehavioralAnomaly(req: NextRequest) {
  const ip = req.ip || "unknown";
  const pathname = req.nextUrl.pathname;
  const now = Date.now();

  // Skip exempt endpoints
  if (EXEMPT_ENDPOINTS.has(pathname)) {
    return { action: "allow", score: 0, reason: "exempt endpoint" };
  }

  // Calculate risk score
  const score = calculateRiskScore(ip, pathname, now);

  // Determine action based on score
  let action: "allow" | "warn" | "block";
  let reason: string;

  if (score >= CRITICAL_SCORE) {
    action = "block";
    reason = `critical risk score: ${score}`;
  } else if (score >= 60) {
    action = "warn";
    reason = `elevated risk score: ${score}`;
  } else {
    action = "allow";
    reason = `normal operation: ${score}`;
  }

  // Log suspicious activity
  if (action !== "allow") {
    const endpointHistory = riskState.get(ip)?.endpointHistory?.get(pathname) || new Map();
    const timestamps = endpointHistory.get("timestamps") || [];
    timestamps.push(now);
    endpointHistory.set("timestamps", timestamps);

    // Keep only recent timestamps
    const recentTimestamps = timestamps.filter(ts => now - ts < WINDOW_MS);
    if (recentTimestamps.length > 100) {
      endpointHistory.set("timestamps", recentTimestamps.slice(-100));
    }

    riskState.set(ip, {
      score,
      lastReset: now,
      endpointHistory: riskState.get(ip)?.endpointHistory || new Map().set(pathname, endpointHistory),
    });

    console.warn(JSON.stringify({
      timestamp: new Date(now).toISOString(),
      action: "behavioral_anomaly_detected",
      ip,
      endpoint: pathname,
      riskScore: score,
      reason,
    }));
  }

  // Reset score after cooldown if needed
  const ipEntry = riskState.get(ip);
  if (ipEntry && now - ipEntry.lastReset > RESET_TIMEOUT) {
    ipEntry.score = BASE_SCORE;
    ipEntry.lastReset = now;
  }

  return { action, score, reason };
}

// Export utility for manual score reset
export function resetRiskScore(ip: string): void {
  const entry = riskState.get(ip);
  if (entry) {
    entry.score = BASE_SCORE;
    entry.lastReset = Date.now();
    console.info(`Risk score manually reset for IP: ${ip}`);
  }
}

// Rate limiter integration helper
export function withBehavioralCheck(handler: (req: NextRequest) => Promise<NextResponse>) {
  return async (req: NextRequest) => {
    const result = checkBehavioralAnomaly(req);

    if (result.action === "block") {
      return new NextResponse(
        JSON.stringify({ error: "request blocked due to behavioral anomaly", reason: result.reason }),
        { status: 429, headers: { "Content-Type": "application/json" } }
      );
    }

    if (result.action === "warn") {
      // Continue but add warning header
      const res = await handler(req);
      res.headers.set("X-Risk-Score", result.score.toString());
      res.headers.set("X-Risk-Action", result.action);
      return res;
    }

    // Allow — proceed normally
    return handler(req);
  };
}
