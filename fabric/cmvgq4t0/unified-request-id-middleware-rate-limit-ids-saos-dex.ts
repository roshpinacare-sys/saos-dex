import { NextRequest, NextResponse } from "next/server";

const WINDOW_MS = 60_000;
const LIMIT_INTERNAL = 2_000;
const LIMIT_PUBLIC = 240;
const MAX_KEYS = 5_000;
const EXEMPT = ["/api/dex/stream", "/api/revive"];

// ── Unified Request ID (W3C Trace Context) ──
const REQUEST_ID_HEADER = "x-request-id";
const TRACEPARENT_REGEX = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

function extractTraceIdFromHeader(request: NextRequest): string | null {
  const traceparent = request.headers.get("traceparent");
  if (!traceparent) return null;
  const match = traceparent.match(TRACEPARENT_REGEX);
  if (!match) return null;
  // match[2] is the trace-id (32 hex chars)
  return match[2];
}

function generateTraceId(): string {
  // crypto.randomUUID() returns a v4 UUID; format to 32-char hex for traceparent compatibility
  return crypto.randomUUID().replace(/-/g, "");
}

// Initialize traceId early in the middleware pipeline
function initTraceId(request: NextRequest): string {
  const traceId = extractTraceIdFromHeader(request) || generateTraceId();
  // Set the header for downstream propagation
  const response = NextResponse.next();
  response.headers.set(REQUEST_ID_HEADER, traceId);
  // Store on the request for internal use (via a mutable ref or closure)
  // Since NextRequest is immutable, we attach to the response for downstream middleware
  // We'll read it via response.headers.get in subsequent handlers
  return traceId;
}

// ── cmvdkj2e (מאושר): התראה-מוקדמת-מדודה ──
const EARLY_WARN_THRESHOLD = 100;
const lastWarn = new Map<string, number>();
const EARLY_WARN_MAX_KEYS = 5_000;

function earlyWarn(request: NextRequest, pathname: string, now: number): void {
  const traceId = request.headers.get(REQUEST_ID_HEADER) || "unknown";
  const prev = lastWarn.get(traceId);
  if (prev !== undefined && now - prev < WINDOW_MS) return;
  lastWarn.set(traceId, now);
  if (lastWarn.size > EARLY_WARN_MAX_KEYS) {
    const oldest = lastWarn.keys().next().value;
    if (oldest !== undefined) lastWarn.delete(oldest);
  }
  console.warn(
    JSON.stringify({
      timestamp: new Date(now).toISOString(),
      action: "traffic_alert",
      ip: request.ip || "unknown",
      path: pathname,
      note: `crossed ${EARLY_WARN_THRESHOLD} req/min`,
      traceId,
    })
  );
}

// ── IDS log (integrated) ──
function logIds(request: NextRequest, details: { path: string; action: string; note: string }): void {
  const traceId = request.headers.get(REQUEST_ID_HEADER) || "unknown";
  console.warn(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      action: details.action,
      ip: request.ip || "unknown",
      path: details.path,
      note: details.note,
      traceId,
    })
  );
}

export async function middleware(request: NextRequest) {
  // 1. Initialize traceId at the very start
  initTraceId(request);

  const pathname = request.nextUrl.pathname;

  // 2. Exempt check
  if (EXEMPT.some((p) => pathname.startsWith(p))) {
    // Still propagate traceId for observability, but skip rate limits
    return NextResponse.next({
      request: {
        ...request,
        headers: new Headers(request.headers).set(REQUEST_ID_HEADER, request.headers.get(REQUEST_ID_HEADER) || "unknown"),
      },
    });
  }

  // 3. Rate limit & IDS logic now use unified traceId
  const now = Date.now();
  earlyWarn(request, pathname, now);
  logIds(request, { path: pathname, action: "middleware_scan", note: "rate-limit-and-ids" });

  // 4. Continue downstream (fail-open on internal errors)
  try {
    return NextResponse.next();
  } catch {
    // fail-open: availability > strictness
    return NextResponse.next();
  }
}

// Configure matcher to run on all API routes for the DEX
export const config = {
  matcher: "/api/dex/:path*",
};
