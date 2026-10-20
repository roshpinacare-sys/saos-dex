import { NextRequest, NextResponse } from "next/server";

const WINDOW_MS = 60_000;
const LIMIT_INTERNAL = 2_000;
const LIMIT_PUBLIC = 240;
const MAX_KEYS = 5_000;
const EXEMPT = ["/api/dex/stream", "/api/revive"];

// ── Advanced Behavioral Anomaly Detection ──
// Tracks per-IP patterns for critical endpoints
interface UserPattern {
  requestCount: number;
  lastRequestTs: number;
  nonceSequence: number[]; // Last 5 nonces to detect replay/repetition
  endpointCounts: Map<string, number>; // endpoint -> count within window
  firstSeen: number;
}

const userPatterns = new Map<string, UserPattern>();

// ── cmvdkj2e (מאושר): התראה-מוקדמת-מדודה ──
const EARLY_WARN_THRESHOLD = 100;
const lastWarn = new Map<string, number>();
const EARLY_WARN_MAX_KEYS = 5_000;

function earlyWarn(ip: string, pathname: string, now: number): void {
  const prev = lastWarn.get(ip);
  if (prev !== undefined && now - prev < WINDOW_MS) return;
  lastWarn.set(ip, now);
  if (lastWarn.size > EARLY_WARN_MAX_KEYS) {
    const oldest = lastWarn.keys().next().value;
    if (oldest !== undefined) lastWarn.delete(oldest);
  }
  console.warn(
    JSON.stringify({
      timestamp: new Date(now).toISOString(),
      action: "traffic_alert",
      ip,
      path: pathname,
      note: `crossed ${EARLY_WARN_THRESHOLD} requests per minute`,
    })
  );
}

// ── New: Behavioral anomaly tracking ──
function getUserPattern(ip: string): UserPattern {
  let pattern = userPatterns.get(ip);
  if (!pattern) {
    pattern = {
      requestCount: 0,
      lastRequestTs: 0,
      nonceSequence: [],
      endpointCounts: new Map(),
      firstSeen: Date.now(),
    };
    userPatterns.set(ip, pattern);
  }
  return pattern;
}

function pruneOldPatterns(now: number): void {
  for (const [ip, pattern] of userPatterns) {
    if (now - pattern.firstSeen > 24 * 60 * 60 * 1000) {
      userPatterns.delete(ip);
    }
  }
}

// ── Helper: Extract nonce from request (query or body) ──
function extractNonce(req: NextRequest): string | null {
  // Try query parameter first, then JSON body
  const url = new URL(req.url);
  const queryNonce = url.searchParams.get("nonce");
  if (queryNonce) return queryNonce;
  
  try {
    const body = req.json;
    // Note: This is async, caller should handle or we use a simpler check
    return null; // Simplified for sync middleware
  } catch {
    return null;
  }
}

export async function middleware(request: NextRequest) {
  const ip = request.ip || "unknown";
  const pathname = request.nextUrl.pathname;
  const now = Date.now();
  
  // Prune old patterns periodically
  pruneOldPatterns(now);
  
  const pattern = getUserPattern(ip);
  pattern.requestCount++;
  pattern.lastRequestTs = now;
  
  // Track endpoint usage
  if (!pattern.endpointCounts.has(pathname)) {
    pattern.endpointCounts.set(pathname, 0);
  }
  pattern.endpointCounts.set(pathname, pattern.endpointCounts.get(pathname)! + 1);
  
  // Track nonce sequence for critical endpoints
  if (
    pathname === "/api/dex/settle" ||
    pathname === "/api/dex/transfer" ||
    pathname === "/api/dex/order"
  ) {
    const nonce = extractNonce(request);
    if (nonce) {
      // Keep last 5 nonces
      pattern.nonceSequence.push(nonce);
      if (pattern.nonceSequence.length > 5) {
        pattern.nonceSequence = pattern.nonceSequence.slice(-5);
      }
      
      // Detect nonce repetition/replay
      const uniqueNonces = new Set(pattern.nonceSequence);
      if (uniqueNonces.size < pattern.nonceSequence.length) {
        // Repeated nonce detected within this window
        const event = JSON.stringify({
          timestamp: new Date(now).toISOString(),
          action: "nonce_replay_detected",
          ip,
          endpoint: pathname,
          repeatedNonce: nonce,
          nonceCount: pattern.nonceSequence.length,
          uniqueNonces: uniqueNonces.size,
        });
        console.warn(
          JSON.stringify({
            ...JSON.parse(event),
            note: "Potential nonce replay or replay attack detected",
          })
        );
      }
    }
  }
  
  // ── Rate limiting with behavioral analysis ──
  // Determine if this is an internal or public request
  const isExempt = EXEMPT.some((p) => pathname.startsWith(p));
  
  if (isExempt) {
    // Early warning only for exempt paths if over threshold
    if (pattern.requestCount > EARLY_WARN_THRESHOLD) {
      earlyWarn(ip, pathname, now);
    }
    return NextResponse.next();
  }
  
  // Check critical endpoint patterns first
  if (
    pathname === "/api/dex/settle" ||
    pathname === "/api/dex/transfer" ||
    pathname === "/api/dex/order"
  ) {
    // Higher scrutiny for critical endpoints
    if (pattern.requestCount > LIMIT_INTERNAL) {
      // Additional behavioral check
      const endpointCount = pattern.endpointCounts.get(pathname) || 0;
      
      // Check if this user is hitting the same endpoint disproportionately
      if (endpointCount > LIMIT_INTERNAL * 0.5) {
        // More than 50% of their requests are to this one critical endpoint
        const event = JSON.stringify({
          timestamp: new Date(now).toISOString(),
          action: "critical_endpoint_overuse",
          ip,
          endpoint: pathname,
          requestCount: pattern.requestCount,
          endpointCount,
        });
        console.warn(
          JSON.stringify({
            ...JSON.parse(event),
            note: "Disproportionate usage of critical endpoint",
          })
        );
      }
    }
  }
  
  // Standard rate limiting
  const isInternal = !request.headers.has("x-forwarded-for");
  const effectiveLimit = isInternal ? LIMIT_INTERNAL : LIMIT_PUBLIC;
  
  if (pattern.requestCount > effectiveLimit) {
    // Early warning before hard limit
    if (pattern.requestCount > effectiveLimit * 0.8) {
      earlyWarn(ip, pathname, now);
    }
    
    // Return rate limit response
    return NextResponse.json(
      { error: "Rate limit exceeded", retryAfter: 60 },
      { status: 429, headers: { "Retry-After": "60" } }
    );
  }
  
  return NextResponse.next();
}

// Configure which paths this middleware runs on
export const config = {
  matcher: [
    "/api/dex/:path*",
    "/api/revive",
    "/api/revive/health-check",
  ],
};
