import { NextRequest, NextResponse } from "next/server";
import winston from "winston";
import { Counter, Histogram, collectDefaultMetrics, Registry } from "prom-client";

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()],
});

const register = new Registry();
collectDefaultMetrics({ register });

const requestCounter = new Counter({
  name: "dex_api_requests_total",
  help: "Total number of DEX API requests",
  labelNames: ["method", "endpoint", "status_code", "action"],
  registers: [register],
});

const requestDuration = new Histogram({
  name: "dex_api_request_duration_seconds",
  help: "Duration of DEX API requests in seconds",
  labelNames: ["method", "endpoint", "action"],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register],
});

const errorCounter = new Counter({
  name: "dex_api_errors_total",
  help: "Total number of DEX API client and server errors",
  labelNames: ["method", "endpoint", "status_code", "ip"],
  registers: [register],
});

const WINDOW_MS = 60_000;
const HIGH_FREQ_THRESHOLD = 100;
const ERROR_THRESHOLD = 50;
const MAX_KEYS = 5_000;
const EXEMPT = ["/api/dex/stream", "/api/revive"];

const requestBuckets = new Map<string, number[]>();
const errorBuckets = new Map<string, number[]>();

function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1] ?? "proxied";
    return "proxied";
  }
  return req.headers.get("x-real-ip") ?? "local";
}

function isSuspiciousPath(pathname: string): boolean {
  const suspiciousPatterns = ["\\.\\.", "<script", "' OR '", "1=1", "; DROP", "UNION SELECT"];
  return suspiciousPatterns.some((pattern) => pathname.toLowerCase().includes(pattern));
}

function getActionFromPathname(pathname: string): string {
  if (pathname.includes("/api/dex/agent")) return "agent";
  if (pathname.includes("/api/dex/order")) return "order";
  if (pathname.includes("/api/dex/swap")) return "swap";
  return "other";
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  if (EXEMPT.some((p) => pathname.includes(p))) return NextResponse.next();

  const ip = clientIp(req);
  const isPublic = req.headers.has("x-forwarded-for");
  const limit = isPublic ? 240 : 2_000;
  const now = Date.now();

  let bucket = requestBuckets.get(ip);
  if (!bucket) {
    bucket = [];
    requestBuckets.set(ip, bucket);
  }
  while (bucket.length > 0 && bucket[0] !== undefined && now - bucket[0] >= WINDOW_MS) {
    bucket.shift();
  }

  const startTime = Date.now();
  const res = NextResponse.next();
  const endTime = Date.now();
  const durationMs = endTime - startTime;

  const action = getActionFromPathname(pathname);
  const statusCode = res.status;

  logger.info("DEX API request", {
    method: req.method,
    pathname,
    ip,
    query: Object.fromEntries(req.nextUrl.searchParams),
    status: statusCode,
    duration_ms: durationMs,
  });

  requestCounter.inc({
    method: req.method,
    endpoint: pathname,
    status_code: String(statusCode),
    action,
  });

  requestDuration.observe({
    method: req.method,
    endpoint: pathname,
    action,
  }, durationMs / 1000);

  if (statusCode >= 400) {
    errorCounter.inc({
      method: req.method,
      endpoint: pathname,
      status_code: String(statusCode),
      ip,
    });

    let errorBucket = errorBuckets.get(ip);
    if (!errorBucket) {
      errorBucket = [];
      errorBuckets.set(ip, errorBucket);
    }
    while (errorBucket.length > 0 && errorBucket[0] !== undefined && now - errorBucket[0] >= WINDOW_MS) {
      errorBucket.shift();
    }
    errorBucket.push(now);

    if (errorBucket.length > ERROR_THRESHOLD) {
      logger.warn(`High error rate detected from IP ${ip}: ${errorBucket.length} errors in the last minute`);
    }
  }

  if (bucket.length > HIGH_FREQ_THRESHOLD) {
    logger.warn(`High frequency request detected from IP ${ip}: ${bucket.length} requests in the last minute`);
  }

  if (isSuspiciousPath(pathname)) {
    logger.warn(`Suspicious path detected from IP ${ip}: ${pathname}`);
  }

  if (requestBuckets.size > MAX_KEYS) {
    const it = requestBuckets.keys();
    for (let i = 0; i < 1_000; i += 1) {
      const k = it.next();
      if (k.done) break;
      if (k.value !== ip) requestBuckets.delete(k.value);
    }
  }

  if (errorBuckets.size > MAX_KEYS) {
    const it = errorBuckets.keys();
    for (let i = 0; i < 1_000; i += 1) {
      const k = it.next();
      if (k.done) break;
      if (k.value !== ip) errorBuckets.delete(k.value);
    }
  }

  res.headers.set("X-RateLimit-Limit", String(limit));
  res.headers.set("X-RateLimit-Remaining", String(Math.max(0, limit - bucket.length)));

  return res;
}

export const config = {
  matcher: ["/api/dex/:path+"],
};
