import { NextRequest, NextResponse } from 'next/server';
import { createLogger, transports, format } from 'winston';

const logger = createLogger({
  level: 'warn',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    format.errors({ stack: true }),
    format.splat(),
    format.json()
  ),
  transports: [new transports.Console()],
});

const SQL_PATTERNS = [/union\s+/i, /select\s+/i, /insert\s+/i, /update\s+/i, /delete\s+/i, /drop\s+/i, /--/, /;/, /\/\*.*\*\//];
const XSS_PATTERNS = [/<script>/i, /javascript:/i, /onload\s*=/, /onerror\s*=/, /alert\s*\(/i];
const PATH_TRAVERSAL_PATTERNS = [/\.\.\//g, /\.\.\\/g];
const SSRF_PATTERNS = [/127\.0\.0\.1/, /localhost/, /\[::1\]/, /0\.0\.0\.0/, /10\.\d+\.\d+\.\d+/, /192\.168\.\d+\.\d+/, /172\.(1[6-9]|2[0-9]|3[0-1])\.\d+\.\d+/];
const SSRF_PARAMS = ['url', 'callback', 'webhook', 'proxy'];

export function securityMiddleware(req: NextRequest): NextResponse | undefined {
  const ip = req.headers.get('x-real-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown';
  const url = new URL(req.nextUrl.toString());
  const pathname = url.pathname;
  const searchParams = url.searchParams;
  const headers = req.headers;

  // Check path
  for (const pattern of PATH_TRAVERSAL_PATTERNS) {
    if (pattern.test(pathname)) {
      logger.warn({
        event: 'security-threat-detected',
        threatType: 'path-traversal',
        location: 'path',
        value: pathname,
        ip,
        timestamp: new Date().toISOString(),
      });
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  // Check query parameters
  for (const [key, value] of searchParams.entries()) {
    const combined = `${key}=${value}`;
    for (const pattern of SQL_PATTERNS) {
      if (pattern.test(combined)) {
        logger.warn({
          event: 'security-threat-detected',
          threatType: 'sqli',
          location: 'query-param',
          value: combined,
          ip,
          timestamp: new Date().toISOString(),
        });
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }
    for (const pattern of XSS_PATTERNS) {
      if (pattern.test(combined)) {
        logger.warn({
          event: 'security-threat-detected',
          threatType: 'xss',
          location: 'query-param',
          value: combined,
          ip,
          timestamp: new Date().toISOString(),
        });
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }
    for (const pattern of PATH_TRAVERSAL_PATTERNS) {
      if (pattern.test(combined)) {
        logger.warn({
          event: 'security-threat-detected',
          threatType: 'path-traversal',
          location: 'query-param',
          value: combined,
          ip,
          timestamp: new Date().toISOString(),
        });
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }
    if (SSRF_PARAMS.includes(key.toLowerCase())) {
      for (const pattern of SSRF_PATTERNS) {
        if (pattern.test(value)) {
          logger.warn({
            event: 'security-threat-detected',
            threatType: 'ssrf',
            location: 'query-param',
            value: combined,
            ip,
            timestamp: new Date().toISOString(),
          });
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }
      }
    }
  }

  // Check headers
  headers.forEach((value, key) => {
    const combined = `${key}: ${value}`;
    for (const pattern of SQL_PATTERNS) {
      if (pattern.test(combined)) {
        logger.warn({
          event: 'security-threat-detected',
          threatType: 'sqli',
          location: 'header',
          value: combined,
          ip,
          timestamp: new Date().toISOString(),
        });
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }
    for (const pattern of XSS_PATTERNS) {
      if (pattern.test(combined)) {
        logger.warn({
          event: 'security-threat-detected',
          threatType: 'xss',
          location: 'header',
          value: combined,
          ip,
          timestamp: new Date().toISOString(),
        });
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }
    for (const pattern of PATH_TRAVERSAL_PATTERNS) {
      if (pattern.test(combined)) {
        logger.warn({
          event: 'security-threat-detected',
          threatType: 'path-traversal',
          location: 'header',
          value: combined,
          ip,
          timestamp: new Date().toISOString(),
        });
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }
    if (SSRF_PARAMS.includes(key.toLowerCase())) {
      for (const pattern of SSRF_PATTERNS) {
        if (pattern.test(value)) {
          logger.warn({
            event: 'security-threat-detected',
            threatType: 'ssrf',
            location: 'header',
            value: combined,
            ip,
            timestamp: new Date().toISOString(),
          });
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }
      }
    }
  });

  // Note: Body checking is omitted as Next.js middleware does not provide direct access to request body
  // without consuming it, which would break downstream route handlers. Body inspection would require
  // a custom server or API route wrapper, which is beyond the scope of this middleware.

  return undefined; // Allow request to proceed
}
