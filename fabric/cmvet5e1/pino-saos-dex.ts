import { NextRequest, NextResponse } from 'next/server';
import pino from 'pino';

const logger = pino({
  level: 'warn',
  formatters: {
    level: (label) => ({
      level: label,
    }),
  },
});

const SECURITY_SENSITIVE_PATHS = [
  '/api/dex/security',
  '/api/dex/wallets',
  '/api/dex/transfer',
  '/api/dex/order',
  '/api/dex/swap',
];

const SECURITY_RELATED_STATUS_CODES = [401, 403, 404, 429];

export function securityLoggerMiddleware(request: NextRequest): NextResponse | null {
  const ip = request.ip || request.headers.get('x-forwarded-for') || 'unknown';
  const method = request.method;
  const pathname = request.nextUrl.pathname;
  const userAgent = request.headers.get('user-agent') || 'unknown';
  
  // Log security-related status codes
  if (SECURITY_RELATED_STATUS_CODES.some(code => 
    pathname.startsWith('/api') && request.nextUrl.searchParams.get(`status_${code}`)
  )) {
    const statusCode = parseInt(request.nextUrl.searchParams.get(`status_${SECURITY_RELATED_STATUS_CODES.find(c => request.nextUrl.searchParams.has(`status_${c}`))}`) || '0');
    
    logger.warn({
      event: 'security_status_code',
      ip,
      method,
      path: pathname,
      status: statusCode,
      user_agent: userAgent,
      timestamp: new Date().toISOString(),
    });
    
    return null;
  }
  
  // Log access to sensitive paths
  if (SECURITY_SENSITIVE_PATHS.some(path => pathname.startsWith(path))) {
    logger.warn({
      event: 'sensitive_path_access',
      ip,
      method,
      path: pathname,
      user_agent: userAgent,
      timestamp: new Date().toISOString(),
    });
  }
  
  // Log failed authentication attempts
  if (pathname.startsWith('/api') && (pathname.includes('auth') || pathname.includes('login'))) {
    const authHeader = request.headers.get('authorization');
    
    if (!authHeader || authHeader === 'Bearer undefined' || authHeader === 'Basic undefined') {
      logger.warn({
        event: 'failed_authentication',
        ip,
        method,
        path: pathname,
        user_agent: userAgent,
        timestamp: new Date().toISOString(),
      });
    }
  }
  
  // Log IP-based anomalies
  const requestCount = parseInt(request.headers.get('x-request-count') || '1');
  if (requestCount > 100 && pathname.startsWith('/api')) {
    logger.warn({
      event: 'high_request_volume',
      ip,
      method,
      path: pathname,
      request_count: requestCount,
      user_agent: userAgent,
      timestamp: new Date().toISOString(),
    });
  }
  
  return null;
}
