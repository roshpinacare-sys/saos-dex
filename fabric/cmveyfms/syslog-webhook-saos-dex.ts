import { NextRequest, NextResponse } from 'next/server';
import { securityLogger } from '@/lib/security-logger';

/**
 * Security middleware - logs security events to external systems
 * Handles: failed auth attempts, rate limit violations, injection attempts
 */
export async function securityMiddleware(req: NextRequest) {
  const start = Date.now();
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 
             req.headers.get('x-real-ip') || 
             req.ip || 
             'unknown';
  const userAgent = req.headers.get('user-agent') || 'unknown';
  const path = req.nextUrl.pathname;

  // Continue with request
  const res = await NextResponse.next();

  const duration = Date.now() - start;

  // Log failed authentication attempts (401, 403)
  if (res.status === 401 || res.status === 403) {
    await securityLogger.logSecurityEvent({
      eventType: 'AUTH_FAILURE',
      severity: 'WARNING',
      message: `Authentication failed for path ${path}`,
      ipAddress: ip,
      userAgent,
      path,
      statusCode: res.status,
      metadata: { durationMs: duration }
    });
  }

  // Log rate limit violations (429)
  if (res.status === 429) {
    await securityLogger.logSecurityEvent({
      eventType: 'RATE_LIMIT_EXCEEDED',
      severity: 'WARNING',
      message: `Rate limit exceeded for IP ${ip}`,
      ipAddress: ip,
      userAgent,
      path,
      statusCode: res.status,
      metadata: { durationMs: duration }
    });
  }

  // Log potential injection attempts (400, 422 with suspicious patterns)
  if ((res.status === 400 || res.status === 422) && 
      (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH')) {
    const suspiciousPatterns = [
      /(<script|javascript:|onerror=|onload=)/i,
      /(union\s+select|drop\s+table|insert\s+into|delete\s+from)/i,
      /(\bexec\b|\bsystem\b|\bpassthru\b|\bshell_exec\b)/i,
      /(<\?php|<\?|%3C%3Fphp|%3C%3F)/i
    ];

    const hasSuspiciousPattern = suspiciousPatterns.some(pattern => 
      pattern.test(req.nextUrl.searchParams.toString()) ||
      pattern.test(JSON.stringify(req.body) || '')
    );

    if (hasSuspiciousPattern) {
      await securityLogger.logSecurityEvent({
        eventType: 'INJECTION_ATTEMPT',
        severity: 'ERROR',
        message: `Potential injection attempt detected on path ${path}`,
        ipAddress: ip,
        userAgent,
        path,
        statusCode: res.status,
        metadata: { durationMs: duration }
      });
    }
  }

  return res;
}
