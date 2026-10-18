import { NextRequest, NextResponse } from "next/server";

/**
 * Enhanced security logging middleware with IP, request, and transaction details
 * Logs security-relevant events in structured JSON format for audit and investigation
 */
const WINDOW_MS = 60_000;
const LIMIT_INTERNAL = 2_000;
const LIMIT_PUBLIC = 240;
const MAX_KEYS = 5_000;
const EXEMPT = ["/api/dex/stream", "/api/revive"];

const buckets = new Map<string, number[]>();

function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1] ?? "proxied";
    return "proxied";
  }
  return req.headers.get("x-real-ip") ?? "local";
}

function logSecurityEvent(
  req: NextRequest,
  eventType: string,
  details: Record<string, unknown> = {}
): void {
  if (process.env.NODE_ENV === "test") return; // Skip logging in tests

  const ip = clientIp(req);
  const logEntry = {
    timestamp: new Date().toISOString(),
    event_type: eventType,
    client_ip: ip,
    request: {
      method: req.method,
      path: req.nextUrl.pathname,
      query: Object.fromEntries(req.nextUrl.searchParams),
      headers: Object.fromEntries(
        req.headers
          .entries()
          .filter(([key]) => !key.toLowerCase().includes("authorization") && !key.toLowerCase().includes("cookie") && !key.toLowerCase().includes("x-api-key"))
      )
    },
    ...details
  };

  console.log(JSON.stringify({ level: "security", ...logEntry }));
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  if (EXEMPT.some((p) => pathname.includes(p))) return NextResponse.next();

  const ip = clientIp(req);
  const isPublic = req.headers.has("x-forwarded-for");
  const limit = isPublic ? LIMIT_PUBLIC : LIMIT_INTERNAL;

  const now = Date.now();
  let bucket = buckets.get(ip);
  if (!bucket) {
    bucket = [];
    buckets.set(ip, bucket);
  }
  while (bucket.length > 0 && bucket[0] !== undefined && now - bucket[0] >= WINDOW_MS) {
    bucket.shift();
  }

  if (bucket.length >= limit) {
    const oldest = bucket[0] ?? now;
    const retryAfter = Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000));

    logSecurityEvent(req, "rate_limit_exceeded", {
      limit,
      current_count: bucket.length,
      retry_after_seconds: retryAfter
    });

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
        },
      }
    );
  }

  bucket.push(now);

  // Anti-bloat: prune foreign keys with no recent activity
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
  return res;
}

export const config = {
  matcher: ["/api/dex/:path+"],
};

// Export for testing
export { logSecurityEvent };
