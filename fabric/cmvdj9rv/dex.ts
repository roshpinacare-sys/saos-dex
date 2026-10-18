import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

type AccessLog = {
  id: number;
  timestamp: Date;
  ip: string;
  path: string;
  method: string;
  status: number;
  authorized: boolean;
  userAgent?: string;
  referer?: string;
};

const SUSPICIOUS_THRESHOLD = 5;
const TIME_WINDOW_MS = 60000; // 1 minute

const ipAccessMap = new Map<string, {
  count: number;
  lastAccess: number;
  paths: Set<string>;
}>();

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;
  const ip = getClientIp(req);
  const method = req.method;
  const userAgent = req.headers.get('user-agent');
  const referer = req.headers.get('referer');

  // Check if the path is protected
  const isProtectedPath = pathname.startsWith('/api/dex/') && 
    !pathname.startsWith('/api/dex/public/') &&
    !['/api/dex/stream', '/api/revive'].includes(pathname);

  let authorized = false;
  
  if (isProtectedPath) {
    // Implement your authorization logic here
    // For example, check for valid auth token
    const authHeader = req.headers.get('authorization');
    authorized = !!authHeader; // Simplified for example
  }

  // Log the access attempt
  try {
    await logAccess({
      ip,
      path: pathname,
      method,
      status: authorized ? 200 : 401,
      authorized,
      userAgent,
      referer
    });
  } catch (error) {
    console.error('Failed to log access:', error);
  }

  // Track access patterns for suspicious activity
  trackAccessPattern(ip, pathname);

  // Check for suspicious activity
  const suspicious = detectSuspiciousActivity(ip);
  if (suspicious) {
    console.warn(`Suspicious activity detected from IP: ${ip}`);
    // Here you could trigger an alert or additional logging
    // For example, notify your monitoring system
  }

  // Continue with the request
  if (!isProtectedPath || authorized) {
    return NextResponse.next();
  }

  return NextResponse.json(
    { error: 'Unauthorized access' },
    { status: 401 }
  );
}

function getClientIp(req: NextRequest): string {
  const xForwardedFor = req.headers.get('x-forwarded-for');
  if (xForwardedFor) {
    return xForwardedFor.split(',')[0].trim();
  }
  return req.headers.get('x-real-ip') || 'unknown';
}

async function logAccess(logData: Omit<AccessLog, 'id' | 'timestamp'>) {
  try {
    await db.accessLog.create({
      data: {
        ...logData,
        timestamp: new Date(),
      },
    });
  } catch (error) {
    console.error('Database error while logging access:', error);
    throw error;
  }
}

function trackAccessPattern(ip: string, path: string) {
  const now = Date.now();
  let ipData = ipAccessMap.get(ip);
  
  if (!ipData) {
    ipData = { count: 0, lastAccess: now, paths: new Set() };
    ipAccessMap.set(ip, ipData);
  }
  
  ipData.count += 1;
  ipData.lastAccess = now;
  ipData.paths.add(path);
  
  // Clean up old entries
  if (now - ipData.lastAccess > TIME_WINDOW_MS) {
    ipAccessMap.delete(ip);
  }
}

function detectSuspiciousActivity(ip: string): boolean {
  const ipData = ipAccessMap.get(ip);
  
  if (!ipData) return false;
  
  // Check if IP accessed too many different paths in a short time
  if (ipData.paths.size > SUSPICIOUS_THRESHOLD && 
      Date.now() - ipData.lastAccess < TIME_WINDOW_MS) {
    return true;
  }
  
  // Check if IP made too many requests in a short time
  if (ipData.count > SUSPICIOUS_THRESHOLD * 2 && 
      Date.now() - ipData.lastAccess < TIME_WINDOW_MS) {
    return true;
  }
  
  return false;
}

export const config = {
  matcher: ['/api/dex/:path*'],
};