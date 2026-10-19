import { NextRequest, NextResponse } from "next/server";

// Existing rate limit constants
const WINDOW_MS = 60_000;
const LIMIT_INTERNAL = 2_000;
const LIMIT_PUBLIC = 240;
const MAX_KEYS = 5_000;
const EXEMPT = ["/api/dex/stream", "/api/revive"];

// Attack pattern detection constants
const SUSPICIOUS_USER_AGENTS = [
  /sqlmap/i,
  /nikto/i,
  /nessus/i,
  /metasploit/i,
  /burpsuite/i,
  /acunetix/i,
  /nmap/i,
  /hydra/i,
  /dirbuster/i,
  /gobuster/i,
  /w3af/i,
  /havij/i,
  /legion/i
];

const SUSPICIOUS_HEADERS = [
  "x-forwarded-host",
  "x-original-url",
  "x-rewrite-url",
  "x-custom-ip",
  "x-real-ip",
  "x-cluster-client-ip"
];

const SQL_INJECTION_PATTERNS = [
  /('|\\)?\s*(union|select|insert|update|delete|drop|create|alter|exec|execute|truncate|declare)/i,
  /\s+(and|or)\s+\d+\s*=\s*\d+/i,
  /\s+and\s+\d+\s*=\s*\d+/i,
  /\s+or\s+\d+\s*=\s*\d+/i,
  /\s*;\s*(drop|delete|update|insert)/i,
  /\bwaitfor\s+delay\b/i,
  /\bbenchmark\s*\(/i,
  /\bsleep\s*\(/i
];

const XSS_PATTERNS = [
  /<script[^>]*>[\s\S]*?<\/script>/i,
  /javascript:/i,
  /on(load|click|error|mouseover|submit|focus|blur|change)\s*=/,i,
  /<iframe[^>]*>[\s\S]*?<\/iframe>/i,
  /<img[^>]*src[^>]*=/i,
  /<svg[^>]*onload/i,
  /eval\s*\(/i,
  /expression\s*\(/i
];

const PORT_SCAN_INDICATORS = [
  /:\d{2,5}$/,
  /(?:^|\\.)(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?):\d{2,5}/,
  /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}/,
  /(?:scan|probe|test|check).*port/i
];

// Rate limiting storage
const requestCounts = new Map<string, { count: number; resetTime: number }>();
const blockedIPs = new Map<string, number>(); // ip -> unblockTime

function getIP(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? 
         req.headers.get("x-real-ip") ?? 
         req.ip ?? 
         "unknown";
}

function isExemptPath(pathname: string): boolean {
  return EXEMPT.some(path => pathname.startsWith(path));
}

function detectSuspiciousUserAgent(userAgent: string | null): boolean {
  if (!userAgent) return false;
  return SUSPICIOUS_USER_AGENTS.some(pattern => pattern.test(userAgent));
}

function detectSuspiciousHeaders(headers: Headers): boolean {
  return SUSPICIOUS_HEADERS.some(header => headers.has(header));
}

function detectSQLInjectionInParams(searchParams: URLSearchParams): boolean {
  for (const [key, value] of searchParams.entries()) {
    if (SQL_INJECTION_PATTERNS.some(pattern => pattern.test(key)) ||
        SQL_INJECTION_PATTERNS.some(pattern => pattern.test(value))) {
      return true;
    }
  }
  return false;
}

function detectXSSInParams(searchParams: URLSearchParams): boolean {
  for (const [key, value] of searchParams.entries()) {
    if (XSS_PATTERNS.some(pattern => pattern.test(key)) ||
        XSS_PATTERNS.some(pattern => pattern.test(value))) {
      return true;
    }
  }
  return false;
}

function detectPortScanIndicators(searchParams: URLSearchParams): boolean {
  for (const [key, value] of searchParams.entries()) {
    const combined = `${key}=${value}`;
    if (PORT_SCAN_INDICATORS.some(pattern => pattern.test(combined))) {
      return true;
    }
  }
  return false;
}

function detectAbnormalBodySize(req: NextRequest): boolean {
  const contentLength = req.headers.get("content-length");
  if (!contentLength) return false;
  const size = parseInt(contentLength, 10);
  return isNaN(size) ? false : size > 1024 * 1024; // 1MB limit
}

function logAttackEvent(ip: string, type: string, details: Record<string, unknown>): void {
  console.warn(JSON.stringify({
    timestamp: new Date().toISOString(),
    action: "attack_detected",
    ip,
    type,
    ...details
  }));
}

function blockIP(ip: string, durationMs: number = 300_000): void {
  const unblockTime = Date.now() + durationMs;
  blockedIPs.set(ip, unblockTime);
  // Cleanup old blocks periodically
  if (blockedIPs.size > 1000) {
    const now = Date.now();
    for (const [blockedIp, unblock] of blockedIPs.entries()) {
      if (unblock < now) blockedIPs.delete(blockedIp);
    }
  }
}

function isIPBlocked(ip: string): boolean {
  const unblockTime = blockedIPs.get(ip);
  if (unblockTime === undefined) return false;
  if (Date.now() >= unblockTime) {
    blockedIPs.delete(ip);
    return false;
  }
  return true;
}

function updateRateLimit(ip: string, limit: number): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const entry = requestCounts.get(ip);
  
  if (!entry || now > entry.resetTime) {
    requestCounts.set(ip, { count: 1, resetTime: now + WINDOW_MS });
    return { allowed: true, remaining: limit - 1 };
  }
  
  if (entry.count >= limit) {
    return { allowed: false, remaining: 0 };
  }
  
  entry.count++;
  return { allowed: true, remaining: limit - entry.count };
}

export async function middleware(req: NextRequest, event: NextFetchEvent) {
  const pathname = req.nextUrl.pathname;
  
  if (isExemptPath(pathname)) {
    return NextResponse.next();
  }
  
  const ip = getIP(req);
  
  // Check if IP is blocked
  if (isIPBlocked(ip)) {
    return new NextResponse("Access temporarily blocked due to suspicious activity", {
      status: 429,
      headers: {
        "Content-Type": "text/plain",
        "Retry-After": "300"
      }
    });
  }
  
  // Attack pattern detection
  const userAgent = req.headers.get("user-agent") || "";
  const searchParams = req.nextUrl.searchParams;
  
  let attackType = null;
  let attackDetails: Record<string, unknown> = {};
  
  if (detectSuspiciousUserAgent(userAgent)) {
    attackType = "suspicious_user_agent";
    attackDetails.user_agent = userAgent.substring(0, 200);
  } else if (detectSuspiciousHeaders(req.headers)) {
    attackType = "suspicious_headers";
    attackDetails.headers = Array.from(req.headers.entries())
      .filter(([key]) => SUSPICIOUS_HEADERS.includes(key.toLowerCase()))
      .reduce((obj, [key, value]) => ({ ...obj, [key]: value }), {});
  } else if (detectSQLInjectionInParams(searchParams)) {
    attackType = "sql_injection_attempt";
    attackDetails.params = Object.fromEntries(searchParams);
  } else if (detectXSSInParams(searchParams)) {
    attackType = "xss_attempt";
    attackDetails.params = Object.fromEntries(searchParams);
  } else if (detectPortScanIndicators(searchParams)) {
    attackType = "port_scan_indicators";
    attackDetails.params = Object.fromEntries(searchParams);
  } else if (detectAbnormalBodySize(req)) {
    attackType = "abnormal_body_size";
    attackDetails.content_length = req.headers.get("content-length");
  }
  
  if (attackType) {
    logAttackEvent(ip, attackType, attackDetails);
    blockIP(ip, 600_000); // Block for 10 minutes
    
    return new NextResponse("Request blocked due to security policy", {
      status: 403,
      headers: {
        "Content-Type": "text/plain"
      }
    });
  }
  
  // Rate limiting logic (existing)
  const isInternal = !req.headers.get("x-forwarded-for");
  const limit = isInternal ? LIMIT_INTERNAL : LIMIT_PUBLIC;
  const { allowed, remaining } = updateRateLimit(ip, limit);
  
  if (!allowed) {
    return new NextResponse("Rate limit exceeded", {
      status: 429,
      headers: {
        "Content-Type": "text/plain",
        "Retry-After": "60",
        "X-RateLimit-Remaining": String(remaining),
        "X-RateLimit-Limit": String(limit),
        "X-RateLimit-Reset": String(Date.now() + WINDOW_MS)
      }
    });
  }
  
  // Early warning (existing)
  const now = Date.now();
  const prev = lastWarn.get(ip);
  if (prev !== undefined && now - prev < WINDOW_MS) {
    // Do nothing, already warned this minute
  } else {
    lastWarn.set(ip, now);
    if (lastWarn.size > EARLY_WARN_MAX_KEYS) {
      const oldest = lastWarn.keys().next().value;
      if (oldest !== undefined) lastWarn.delete(oldest);
    }
    console.warn(JSON.stringify({
      timestamp: new Date(now).toISOString(),
      action: "traffic_alert",
      ip,
      path: pathname,
      note: `crossed ${EARLY_WARN_THRESHOLD} (public limit ${LIMIT_PUBLIC})`,
      count: remaining + 1 // Approximate current count
    }));
  }
  
  const response = NextResponse.next();
  response.headers.set("X-RateLimit-Remaining", String(remaining));
  response.headers.set("X-RateLimit-Limit", String(limit));
  response.headers.set("X-RateLimit-Reset", String(Date.now() + WINDOW_MS));
  
  return response;
}

// Existing early warning variables (moved to bottom to avoid TDZ)
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
      note: `crossed ${EARLY_WARN_THRESHOLD}`
    })
  );
}