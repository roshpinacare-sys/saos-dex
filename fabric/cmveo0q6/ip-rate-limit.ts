import { NextRequest, NextResponse } from 'next/server';

// ── Constants ──
const WINDOW_MS = 60_000;
const LIMIT_INTERNAL = 2_000;
const LIMIT_PUBLIC = 240;
const MAX_KEYS = 5_000;
const EXEMPT = ['/api/dex/stream', '/api/revive'];

// ── Early warning threshold ──
const EARLY_WARN_THRESHOLD = 100;
const lastWarn = new Map<string, number>();
const EARLY_WARN_MAX_KEYS = 5_000;

// ── IP tracking ──
const ipCounts = new Map<string, number>();
const ipLastReset = new Map<string, number>();

// ── Helper to get real IP ──
function getRealIP(req: NextRequest): string {
  // Priority: X-Real-IP, then X-Forwarded-For (first IP), then remote address
  const realIP = req.headers.get('x-real-ip');
  if (realIP) return realIP;
  
  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor) {
    // Take the first IP from X-Forwarded-For (the one closest to the proxy)
    return forwardedFor.split(',')[0].trim();
  }
  
  return req.ip || 'unknown';
}

// ── Rate limiting logic ──
function shouldAllowRequest(req: NextRequest, ip: string): boolean {
  if (EXEMPT.includes(req.nextUrl.pathname)) return true;
  
  const now = Date.now();
  const isInternal = !req.headers.get('x-forwarded-for');
  const limit = isInternal ? LIMIT_INTERNAL : LIMIT_PUBLIC;
  
  // Reset counter if window has passed
  const lastReset = ipLastReset.get(ip) || 0;
  if (now - lastReset > WINDOW_MS) {
    ipCounts.set(ip, 0);
    ipLastReset.set(ip, now);
  }
  
  // Get current count
  let count = ipCounts.get(ip) || 0;
  
  // Check if request should be allowed
  if (count >= limit) {
    // Early warning for approaching limit
    if (count < limit + 50 && count >= EARLY_WARN_THRESHOLD) {
      const prev = lastWarn.get(ip);
      if (!prev || now - prev > WINDOW_MS) {
        lastWarn.set(ip, now);
        if (lastWarn.size > EARLY_WARN_MAX_KEYS) {
          const oldest = lastWarn.keys().next().value;
          if (oldest) lastWarn.delete(oldest);
        }
        console.warn(
          JSON.stringify({
            timestamp: new Date(now).toISOString(),
            action: 'traffic_alert',
            ip,
            path: req.nextUrl.pathname,
            note: `approaching limit (${count}/${limit})`,
            isInternal,
          })
        );
      }
    }
    return false;
  }
  
  // Increment and allow
  ipCounts.set(ip, count + 1);
  return true;
}

// ── Middleware ──
export function middleware(req: NextRequest) {
  const ip = getRealIP(req);
  const now = Date.now();
  
  // Log request with real IP
  console.log(
    JSON.stringify({
      timestamp: new Date(now).toISOString(),
      action: 'request',
      ip,
      path: req.nextUrl.pathname,
      isInternal: !req.headers.get('x-forwarded-for'),
      headers: Object.fromEntries(req.headers.entries()),
    })
  );
  
  if (!shouldAllowRequest(req, ip)) {
    return new NextResponse('Too Many Requests', {
      status: 429,
      headers: {
        'Retry-After': '60',
        'X-RateLimit-Limit': req.headers.get('x-forwarded-for') ? LIMIT_PUBLIC.toString() : LIMIT_INTERNAL.toString(),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': new Date(now + WINDOW_MS).toISOString(),
      },
    });
  }
  
  // Add rate limit headers to response
  const count = ipCounts.get(ip) || 0;
  const isInternal = !req.headers.get('x-forwarded-for');
  const limit = isInternal ? LIMIT_INTERNAL : LIMIT_PUBLIC;
  const remaining = Math.max(0, limit - count);
  
  const response = NextResponse.next();
  response.headers.set('X-RateLimit-Limit', limit.toString());
  response.headers.set('X-RateLimit-Remaining', remaining.toString());
  response.headers.set('X-RateLimit-Reset', new Date(now + WINDOW_MS).toISOString());
  response.headers.set('X-Real-IP', ip);
  
  return response;
}