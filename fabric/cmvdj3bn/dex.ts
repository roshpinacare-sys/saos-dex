import { NextRequest, NextResponse } from 'next/server';
import { createLogger, transports, format } from 'winston';
import fs from 'fs';
import path from 'path';

// Create logs directory if it doesn't exist
const logDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}

// Configure logger
const accessLogger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.json()
  ),
  transports: [
    new transports.File({ filename: path.join(logDir, 'access.log') }),
  ],
});

const EXEMPT = ['/api/dex/stream', '/api/revive'];

function clientIp(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1] ?? 'proxied';
    return 'proxied';
  }
  return req.headers.get('x-real-ip') ?? 'local';
}

function logAccess(req: NextRequest, res: NextResponse, ip: string): void {
  accessLogger.info({
    ip,
    path: req.nextUrl.pathname,
    method: req.method,
    statusCode: res.status,
    timestamp: new Date().toISOString(),
  });
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  
  // Log exempt paths for monitoring
  if (EXEMPT.some((p) => pathname.includes(p))) {
    const ip = clientIp(req);
    accessLogger.info({
      ip,
      path: pathname,
      method: req.method,
      statusCode: 200,
      timestamp: new Date().toISOString(),
      exempt: true,
    });
    return NextResponse.next();
  }

  const ip = clientIp(req);
  
  // Log all protected access attempts
  const res = NextResponse.next();
  logAccess(req, res, ip);
  
  return res;
}

export const config = {
  matcher: ['/api/dex/:path*', '/api/revive'],
};