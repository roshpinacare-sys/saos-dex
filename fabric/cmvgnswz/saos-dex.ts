import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Unified Request ID middleware for saos-dex
 * Initializes trace-id from 'x-request-id' header or generates UUID v4
 * Propagates request_id through all logging layers
 */

// Thread-local storage for request context
const requestContext = new AsyncLocalStorage<Map<string, string>>();

export function getRequestId(): string | undefined {
  const store = requestContext.getStore();
  return store?.get("request_id");
}

export function setRequestId(id: string): void {
  const store = requestContext.getStore();
  if (store) {
    store.set("request_id", id);
  }
}

export function withRequestContext<T>(requestId: string, fn: () => T): T {
  const store = new Map<string, string>();
  store.set("request_id", requestId);
  return requestContext.run(store, fn);
}

const WINDOW_MS = 60_000;
const LIMIT_INTERNAL = 2_000;
const LIMIT_PUBLIC = 240;
const MAX_KEYS = 5_000;
const EXEMPT = ["/api/dex/stream", "/api/revive"];

// ── cmvdkj2e (מאושר): התראה-מוקדמת-מדודה ──
const EARLY_WARN_THRESHOLD = 100;
const lastWarn = new Map<string, number>();
const EARLY_WARN_MAX_KEYS = 5_000;

function earlyWarn(ip: string, pathname: string, now: number, requestId?: string): void {
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
      request_id: requestId,
      note: `crossed ${EARLY_WARN_THRESHOLD}/min threshold`,
    })
  );
}

// Rate limit trackers
const internalHits = new Map<string, { count: number; resetAt: number }>();
const publicHits = new Map<string, { count: number; resetAt: number }>();

function getClientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    // Take the last IP in XFF chain (closest to our server, added by our gateway)
    return xff.split(",").pop()?.trim() ?? "unknown";
  }
  return req.ip ?? "unknown";
}

function isExempt(pathname: string): boolean {
  return EXEMPT.some((exempt) => pathname.startsWith(exempt));
}

function cleanupMap(map: Map<string, { count: number; resetAt: number }>, now: number): void {
  if (map.size > MAX_KEYS) {
    for (const [key, value] of map.entries()) {
      if (value.resetAt < now) {
        map.delete(key);
      }
    }
    // If still over limit, remove oldest entries
    if (map.size > MAX_KEYS) {
      const keysToDelete = Array.from(map.keys()).slice(0, map.size - MAX_KEYS);
      keysToDelete.forEach((k) => map.delete(k));
    }
  }
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const pathname = req.nextUrl.pathname;
  const now = Date.now();
  
  // Initialize or extract request ID
  const incomingRequestId = req.headers.get("x-request-id") ?? randomUUID();
  const requestId = incomingRequestId;
  
  // Run middleware logic within request context
  return withRequestContext(requestId, async () => {
    // Add request_id to response headers for downstream propagation
    const responseHeaders = new Headers();
    responseHeaders.set("x-request-id", requestId);
    
    // Skip rate limiting for exempt paths
    if (isExempt(pathname)) {
      return NextResponse.next({ headers: responseHeaders });
    }
    
    const ip = getClientIp(req);
    const isInternal = !req.headers.has("x-forwarded-for");
    const limit = isInternal ? LIMIT_INTERNAL : LIMIT_PUBLIC;
    const hitsMap = isInternal ? internalHits : publicHits;
    
    cleanupMap(hitsMap, now);
    
    const entry = hitsMap.get(ip) ?? { count: 0, resetAt: now + WINDOW_MS };
    
    if (now > entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + WINDOW_MS;
    }
    
    entry.count++;
    hitsMap.set(ip, entry);
    
    // Early warning for public traffic
    if (!isInternal && entry.count >= EARLY_WARN_THRESHOLD) {
      earlyWarn(ip, pathname, now, requestId);
    }
    
    // Rate limit exceeded
    if (entry.count > limit) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      
      // Log rate limit hit with request_id
      console.warn(
        JSON.stringify({
          timestamp: new Date(now).toISOString(),
          action: "rate_limit_exceeded",
          ip,
          path: pathname,
          request_id: requestId,
          limit,
          current: entry.count,
          retry_after_seconds: retryAfter,
        })
      );
      
      return new NextResponse(
        JSON.stringify({ error: "Too Many Requests", request_id: requestId }),
        {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": String(retryAfter),
            "x-request-id": requestId,
            "x-ratelimit-limit": String(limit),
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(Math.ceil(entry.resetAt / 1000)),
          },
        }
      );
    }
    
    // Success - add rate limit headers
    responseHeaders.set("x-ratelimit-limit", String(limit));
    responseHeaders.set("x-ratelimit-remaining", String(Math.max(0, limit - entry.count)));
    responseHeaders.set("x-ratelimit-reset", String(Math.ceil(entry.resetAt / 1000)));
    
    return NextResponse.next({ headers: responseHeaders });
  });
}

export const config = {
  matcher: [
    "/api/dex/:path*",
    "/api/revive",
    "/saos-dex/api/dex/:path*",
  ],
};