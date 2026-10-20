import { NextRequest, NextResponse } from "next/server";

// Attack pattern database — compiled regexes for known exploit vectors
const ATTACK_PATTERNS = [
  // SQL Injection
  { pattern: /(?:union\s+select|insert\s+into|drop\s+table|alter\s+table|select\s+.*from|\bwhere\b)/i, severity: "CRITICAL" },
  // XSS
  { pattern: /<script[^>]*>|on(?:click|error|load|mouseover)|javascript:/i, severity: "CRITICAL" },
  // Path Traversal
  { pattern: /\.\./, severity: "HIGH" },
  // Command Injection
  { pattern: /(?:exec|system|shell|bash|cmd)\s*\|?\s*/i, severity: "CRITICAL" },
  // Path traversal with encoded chars
  { pattern: /%2e%2e|%2f|%5c|\.\./i, severity: "HIGH" },
  // NoSQL Injection
  { pattern: /(?:\$where|\$ne|\$regex|findOne\s*\()/i, severity: "HIGH" },
  // CSRF tokens / Referrer checks would go here
  { pattern: /(?:base64|eval)\s*\|?\s*/i, severity: "MEDIUM" },
];

// In-memory warning tracker — IP -> { count, firstSeen, lastSeen }
const attackTracker = new Map<string, { count: number; firstSeen: number; lastSeen: number }>();
const MAX_KEYS = 10_000;

function trimTracker() {
  if (attackTracker.size > MAX_KEYS) {
    const oldestKey = attackTracker.keys().next().value;
    if (oldestKey !== undefined) attackTracker.delete(oldestKey);
  }
}

// Send alert to external event system (placeholder — integrate with your alerting platform)
async function sendAlert(ip: string, pathname: string, pattern: string, severity: string, params: string) {
  // TODO: integrate with SAOS control center / monitoring system
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "attack_detected",
      severity,
      ip,
      path: pathname,
      pattern,
      params,
    })
  );
}

export async function middleware(request: NextRequest) {
  const ip = request.ip ?? "unknown";
  const pathname = request.nextUrl.pathname;
  const now = Date.now();

  // Skip exempt paths (long-poll, revive, etc.)
  const exempt = ["/api/dex/stream", "/api/revive"];
  if (exempt.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Normalize pathname for matching (decode once, lowercase)
  const decodedPathname = decodeURI(pathname).toLowerCase();

  // Scan against attack patterns
  const matches: Array<{ pattern: RegExp; severity: string }> = [];
  for (const { pattern, severity } of ATTACK_PATTERNS) {
    if (pattern.test(decodedPathname)) {
      matches.push({ pattern, severity });
    }
  }

  // Also check query parameters for injection vectors
  const searchParams = request.nextUrl.searchParams;
  const paramValues = Array.from(searchParams.values()).map((v) => decodeURI(v).toLowerCase());
  for (const paramVal of paramValues) {
    for (const { pattern, severity } of ATTACK_PATTERNS) {
      if (pattern.test(paramVal)) {
        matches.push({ pattern, severity });
        break; // one match per param is enough
      }
    }
  }

  if (matches.length > 0) {
    // Block the request immediately
    const blockedAt = now;
    let tracker = attackTracker.get(ip);
    if (!tracker) {
      tracker = { count: 0, firstSeen: blockedAt, lastSeen: blockedAt };
      attackTracker.set(ip, tracker);
    }
    tracker.count += 1;
    tracker.lastSeen = blockedAt;
    if (!tracker.firstSeen) tracker.firstSeen = blockedAt;
    trimTracker();

    // Determine escalation based on severity and repeat count
    const isRepeat = tracker.count > 1;
    let alertSeverity: string = isRepeat ? "CRITICAL" : matches[0].severity;

    // Send alert for first occurrence or repeated attacks
    if (isRepeat || matches[0].severity === "CRITICAL") {
      await sendAlert(ip, pathname, matches[0].pattern.source, alertSeverity, JSON.stringify(searchParams.entries()));
    }

    // Respond with 403 and security log
    const errorBody = JSON.stringify({
      error: "request_blocked",
      reason: "attack_pattern_detected",
      pattern: matches[0].pattern.source,
      severity: alertSeverity,
    });

    return new NextResponse(errorBody, {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }

  // No attack detected — pass through
  return NextResponse.next();
}

// Rate‑limit wrapper for the middleware — internal calls get a higher quota
// (this is a conceptual integration; actual rate-limit logic lives in the existing middleware)
export const config = {
  matcher: ["/api/dex/:path*", "/api/revive", "/api/health"],
};
