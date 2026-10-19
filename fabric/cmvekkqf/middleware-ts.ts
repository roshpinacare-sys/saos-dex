import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

// Initialize Pino logger with transport to external systems
const logger = pino({
  level: process.env.NODE_ENV === "production" ? "info" : "debug",
  transport: {
    target: "pino-http",
    options: {
      // In production, this would send to external systems like ELK/Datadog
      // For demo, we'll use a file transport that could be forwarded
      target: "pino/file",
      options: { destination: "./logs/saos-dex.log" }
    }
  },
  base: { service: "saos-dex-middleware" }
});

// Metrics counters for monitoring
const requestMetrics = new Map<string, Map<string, number>>();

function incrementMetric(method: string, path: string, statusCode: number): void {
  if (!requestMetrics.has(method)) {
    requestMetrics.set(method, new Map());
  }
  const pathMap = requestMetrics.get(method)!;
  const key = `${path}:${Math.floor(statusCode / 100)}xx`;
  pathMap.set(key, (pathMap.get(key) || 0) + 1);
}

function getMetrics(): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {};
  for (const [method, pathMap] of requestMetrics.entries()) {
    result[method] = {};
    for (const [key, value] of pathMap.entries()) {
      result[method][key] = value;
    }
  }
  return result;
}

// Attack pattern detection
const SQL_INJECTION_PATTERNS = [
  /(\b(union|select|insert|update|delete|drop|create|alter)\b.*\b(from|into|set|where)\b)/i,
  /('\s*(or|and)\s*'\s*=\s*'\s*)/i,
  /(;\s*(drop|delete|update|insert)\b)/i,
  /(--|#|\/\*|\*\/)/,
  /\bexec\s*\(/i,
  /\bwaitfor\s+delay\b/i
];

const PATH_TRAVERSAL_PATTERNS = [
  /\.\.(\/|%2F|%5C)/,
  /(%2E%2E%2F|%2E%2E%5C)/,
  /(etc\/passwd|shadow|passwd)/i,
  /(wp-config|web\.config)/i
];

const ADMIN_PATH_PATTERNS = [
  /\/admin/i,
  /\/dashboard/i,
  /\/manage/i,
  /\/superuser/i,
  /\/root/i
];

function detectAttackPatterns(req: NextRequest): { type: string; details: string } | null {
  const url = req.nextUrl.pathname + req.nextUrl.search;
  const headers = Object.entries(req.headers).map(([k, v]) => `${k}:${v}`).join(" ");

  // Check for SQL injection
  for (const pattern of SQL_INJECTION_PATTERNS) {
    if (pattern.test(url) || pattern.test(headers)) {
      return { type: "SQL_INJECTION", details: `Pattern matched: ${pattern}` };
    }
  }

  // Check for path traversal
  for (const pattern of PATH_TRAVERSAL_PATTERNS) {
    if (pattern.test(url)) {
      return { type: "PATH_TRAVERSAL", details: `Pattern matched: ${pattern}` };
    }
  }

  // Check for admin path access attempts
  for (const pattern of ADMIN_PATH_PATTERNS) {
    if (pattern.test(url)) {
      return { type: "ADMIN_ACCESS_ATTEMPT", details: `Pattern matched: ${pattern}` };
    }
  }

  return null;
}

// Sensitive paths requiring enhanced monitoring
const SENSITIVE_PATHS = [
  "/api/dex/agent",
  "/api/dex/order",
  "/api/dex/swap"
];

function isSensitivePath(pathname: string): boolean {
  return SENSITIVE_PATHS.some(path => pathname.startsWith(path));
}

const WINDOW_MS = 60_000;
const LIMIT_INTERNAL = 2_000;
const LIMIT_PUBLIC = 240;
const MAX_KEYS = 5_000;
const EXEMPT = ["/api/dex/stream", "/api/revive"];

// ── cmvdkj2e (מאושר): התראה-מוקדמת-מדודה ──
const EARLY_WARN_THRESHOLD = 100; // מתחת-לתקרה-הציבורית (240)
const lastWarn = new Map<string, number>(); // ip -> חותמת-ההתראה-האחרונה
const EARLY_WARN_MAX_KEYS = 5_000;

function earlyWarn(ip: string, pathname: string, now: number): void {
  const prev = lastWarn.get(ip);
  if (prev !== undefined && now - prev < WINDOW_MS) return; // פעם-בדקה-ל-IP
  lastWarn.set(ip, now);
  if (lastWarn.size > EARLY_WARN_MAX_KEYS) {
    const oldest = lastWarn.keys().next().value;
    if (oldest !== undefined) lastWarn.delete(oldest);
  }
  logger.warn({
    timestamp: new Date(now).toISOString(),
    action: "traffic_alert",
    ip,
    path: pathname,
    note: `crossed ${EARLY_WARN_THRESHOLD}/min threshold (public limit: ${LIMIT_PUBLIC}/min)`,
    service: "saos-dex-middleware"
  });
}

export async function middleware(req: NextRequest, res: NextResponse) {
  const pathname = req.nextUrl.pathname;
  const now = Date.now();

  // Exempt paths from rate limiting
  if (EXEMPT.some(path => pathname.startsWith(path))) {
    return NextResponse.next();
  }

  // Determine client IP
  const forwarded = req.headers.get("x-forwarded-for");
  const ip = forwarded
    ? forwarded.split(",")[0].trim()
    : req.headers.get("x-real-ip") ?? "unknown";

  // Internal vs public rate limits
  const isInternalRequest = !forwarded; // No X-Forwarded-For means internal/sandbox
  const limit = isInternalRequest ? LIMIT_INTERNAL : LIMIT_PUBLIC;

  // Initialize IP tracking if needed
  if (!global.rateLimitIpMap) global.rateLimitIpMap = new Map();
  if (!global.rateLimitIpMap.has(ip)) {
    global.rateLimitIpMap.set(ip, { count: 0, resetTime: now + WINDOW_MS });
  }

  const ipData = global.rateLimitIpMap.get(ip)!;

  // Reset counter if window expired
  if (now > ipData.resetTime) {
    ipData.count = 0;
    ipData.resetTime = now + WINDOW_MS;
  }

  ipData.count++;

  // Rate limit exceeded
  if (ipData.count > limit) {
    // Log rate limit violation
    logger.warn({
      timestamp: new Date(now).toISOString(),
      action: "rate_limit_exceeded",
      ip,
      path: pathname,
      count: ipData.count,
      limit,
      isInternalRequest,
      service: "saos-dex-middleware"
    });

    // Increment 429 metric
    incrementMetric(req.method, pathname, 429);

    return new NextResponse("Too Many Requests", { status: 429 });
  }

  // Enhanced monitoring for sensitive paths
  if (isSensitivePath(pathname)) {
    logger.info({
      timestamp: new Date(now).toISOString(),
      action: "sensitive_path_access",
      ip,
      method: req.method,
      path: pathname,
      userAgent: req.headers.get("user-agent") || "unknown",
      service: "saos-dex-middleware"
    });
  }

  // Attack pattern detection
  const attack = detectAttackPatterns(req);
  if (attack) {
    logger.error({
      timestamp: new Date(now).toISOString(),
      action: "attack_detected",
      ip,
      method: req.method,
      path: pathname,
      attackType: attack.type,
      details: attack.details,
      userAgent: req.headers.get("user-agent") || "unknown",
      service: "saos-dex-middleware"
    });

    // Increment 403 metric for attacks
    incrementMetric(req.method, pathname, 403);

    return new NextResponse("Forbidden", { status: 403 });
  }

  // Early warning for traffic spikes
  if (ipData.count >= EARLY_WARN_THRESHOLD && ipData.count < limit) {
    earlyWarn(ip, pathname, now);
  }

  // Continue to next middleware/handler
  const response = NextResponse.next();

  // Capture response status for metrics (simplified - in real implementation
  // this would be done in an onResponse handler)
  // For now, we'll increment metrics based on expected success
  // In production, this would be enhanced to capture actual status codes
  incrementMetric(req.method, pathname, 200);

  return response;
}

// Export metrics function for external monitoring systems
export { getMetrics };