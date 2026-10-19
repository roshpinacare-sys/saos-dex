import { NextRequest, NextResponse } from "next/server";

// Pre-compiled regex patterns for attack detection
const SQLI_PATTERN = /(union|select|insert|update|delete|drop|--|;|'\s*OR\s*'1'='1)/i;
const XSS_PATTERN = /(<script>|<\/script>|javascript:|onload=|onerror=|alert\()/i;
const PATH_TRAVERSAL_PATTERN = /(\.\.\/|\.\.\\)+/g;
const SSRF_PATTERN = /(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])|(http|https|gopher|file):\/\//i;

// Sensitive parameter names that are commonly abused in SSRF
const SSRF_PARAM_NAMES = new Set(["url", "callback", "redirect", "uri", "destination", "next", "target", "proxy", "domain", "server"]);

/**
 * Attack pattern detection middleware
 * Checks for SQLi, XSS, path traversal, and SSRF patterns in request
 */
export function attackPatternDetection(req: NextRequest) {
  const url = req.nextUrl;
  
  // Check path for path traversal
  if (PATH_TRAVERSAL_PATTERN.test(url.pathname)) {
    logAttackEvent(req.ip ?? "unknown", "path_traversal", url.pathname);
    return NextResponse.json({ error: "Bad Request" }, { status: 400 });
  }

  // Check query parameters
  for (const [key, value] of url.searchParams) {
    const paramValue = String(value);
    
    // SQLi and XSS in query params
    if (SQLI_PATTERN.test(paramValue) || XSS_PATTERN.test(paramValue)) {
      logAttackEvent(req.ip ?? "unknown", "sqli_xss", `${key}=[REDACTED]`);
      return NextResponse.json({ error: "Bad Request" }, { status: 400 });
    }
    
    // Path traversal in query params
    if (PATH_TRAVERSAL_PATTERN.test(paramValue)) {
      logAttackEvent(req.ip ?? "unknown", "path_traversal", `${key}=[REDACTED]`);
      return NextResponse.json({ error: "Bad Request" }, { status: 400 });
    }
    
    // SSRF in query parameters (check both param name and value)
    if (SSRF_PARAM_NAMES.has(key.toLowerCase()) && SSRF_PATTERN.test(paramValue)) {
      logAttackEvent(req.ip ?? "unknown", "ssrf", `${key}=[REDACTED]`);
      return NextResponse.json({ error: "Bad Request" }, { status: 400 });
    }
    
    // Also check param name itself for SSRF patterns (less common but possible)
    if (SSRF_PATTERN.test(key)) {
      logAttackEvent(req.ip ?? "unknown", "ssrf", `param_name=[REDACTED]`);
      return NextResponse.json({ error: "Bad Request" }, { status: 400 });
    }
  }

  // Check headers (limited to common injection points)
  const headersToCheck = ["user-agent", "referer", "x-forwarded-for"];
  for (const headerName of headersToCheck) {
    const headerValue = req.headers.get(headerName);
    if (headerValue) {
      if (SQLI_PATTERN.test(headerValue) || XSS_PATTERN.test(headerValue)) {
        logAttackEvent(req.ip ?? "unknown", "sqli_xss_header", `${headerName}=[REDACTED]`);
        return NextResponse.json({ error: "Bad Request" }, { status: 400 });
      }
    }
  }

  // Note: Body checking is omitted here as Next.js middleware
  // doesn't have easy access to raw body without consuming it,
  // which would break downstream route handlers. Body inspection
  // should happen in specific API routes that need it.

  return null; // Continue to next middleware/handler
}

function logAttackEvent(ip: string, type: string, detail: string): void {
  // Secure logging - never log full user input to prevent log injection
  console.warn(JSON.stringify({
    timestamp: new Date().toISOString(),
    event: "attack_pattern_detected",
    ip: ip.replace(/[^0-9.a-fA-F:]/g, ""), // Basic IP sanitization
    type: type,
    detail: detail.substring(0, 100) // Limit detail length
  }));
}
