import { NextRequest, NextResponse } from "next/server";

// Attack pattern database — compiled regexes for known exploit vectors
const ATTACK_PATTERNS = [
  // SQL Injection
  { pattern: /(?:union\s+select|insert\s+into|drop\s+table|alter\s+table|select\s+.*from|where\s+1=1)/i, severity: "CRITICAL" },
  // XSS
  { pattern: /(<script[^>]*>|onerror=|onload=|javascript:|<img[^>]+onerror)/i, severity: "CRITICAL" },
  // Path Traversal
  { pattern: /(\.\./|\.\./\.\./|%2e%2e|%2f|\/\.\.)/, severity: "HIGH" },
  // Command Injection
  { pattern: /(?:exec|system|shell_exec|passthru|shell|`[^`]+`)/i, severity: "CRITICAL" },
  // CSRF tokens / Referer checks
  { pattern: /(?:_csrf|X-CSRF-Token|referer)/i, severity: "INFO" }, // logged only
].map(p => ({ ...p, regex: new RegExp(p.pattern.source, "i") }));

// Rate‑tracker per IP for burst detection
const ipLastSeen = new Map<string, number>();
const IP_COOLDOWN_MS = 60_000; // 1‑minute window

function recordIpSeen(ip: string): void {
  ipLastSeen.set(ip, Date.now());
  if (ipLastSeen.size > 10_000) {
    const oldest = ipLastSeen.keys().next().value;
    ipLastSeen.delete(oldest);
  }
}

function isRepeatedAttacker(ip: string): boolean {
  const last = ipLastSeen.get(ip);
  if (!last) return false;
  return Date.now() - last < IP_COOLDOWN_MS;
}

export function attackDetector(req: NextRequest) {
  const ip = req.ip ?? "unknown";
  const pathname = req.nextUrl.pathname;
  const now = Date.now();
  
  recordIpSeen(ip);
  
  // Repeated‑attack short‑circuit — flag for escalation
  const repeated = isRepeatedAttacker(ip);
  
  for (const { pattern, severity } of ATTACK_PATTERNS) {
    if (pattern.test(pathname) || pattern.test(req.nextUrl.search)) {
      const event = {
        timestamp: new Date(now).toISOString(),
        action: "attack_detected",
        severity,
        ip,
        path: pathname,
        query: req.nextUrl.search,
        repeated,
      };
      
      // Log to central system (non‑blocking)
      console.warn(JSON.stringify(event));
      
      // Emit to event‑management endpoint if configured
      const endpoint = process.env.ATTACK_LOG_ENDPOINT;
      if (endpoint) {
        fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(event),
          // Fail‑open — never block the request because of logging failure
          keepalive: true,
        }).catch(() => {});
      }
      
      // Immediate block for CRITICAL / HIGH severity
      if (severity === "CRITICAL" || severity === "HIGH") {
        return NextResponse.json(
          { error: "request blocked by attack detector", code: "ATTACK_BLOCKED" },
          { status: 403 }
        );
      }
    }
  }
  
  return null; // allow the request through
}

// Wrap NextResponse for all /api/dex/* routes
export function withAttackDetection(handler: (req: NextRequest) => Promise<NextResponse>) {
  return async (req: NextRequest) => {
    const block = attackDetector(req);
    if (block) return block;
    return handler(req);
  };
}
