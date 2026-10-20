import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';

// Behavioral monitoring middleware for critical API endpoints
const CRITICAL_ENDPOINTS = [
  '/api/dex/settle',
  '/api/dex/transfer',
  '/api/dex/order',
  '/api/dex/swap',
  '/api/dex/pool'
];

// In-memory stores (in production, use Redis or similar)
const requestLog = new Map<string, Array<{
  timestamp: number;
  ip: string;
  method: string;
  pathname: string;
  params: any;
  status: number;
  subject?: string;
  nonce?: string
}>>();

const ipRequestCounts = new Map<string, { count: number; windowStart: number }>();
const nonceTracker = new Map<string, { lastUsed: number; count: number }>();

// Configuration
const WINDOW_MS = 60_000; // 1 minute
const SUSPICIOUS_RATE_THRESHOLD = 50; // requests per minute
const NONCE_REUSE_THRESHOLD = 3; // same nonce used N times
const UNUSUAL_HOURS_START = 2; // 2 AM
const UNUSUAL_HOURS_END = 5;   // 5 AM

function getClientIP(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 
         req.headers.get('x-real-ip') || 
         req.ip || 
         'unknown';
}

function logRequest(ip: string, pathname: string, method: string, params: any, status: number, subject?: string, nonce?: string) {
  const entry = {
    timestamp: Date.now(),
    ip,
    method,
    pathname,
    params: JSON.stringify(params),
    status,
    subject,
    nonce
  };

  if (!requestLog.has(ip)) {
    requestLog.set(ip, []);
  }
  const logs = requestLog.get(ip)!;
  logs.push(entry);

  // Keep only last 1000 entries per IP
  if (logs.length > 1000) {
    logs.shift();
  }
}

function updateRateLimit(ip: string): number {
  const now = Date.now();
  const windowStart = now - (now % WINDOW_MS);

  let data = ipRequestCounts.get(ip);
  if (!data || data.windowStart !== windowStart) {
    data = { count: 1, windowStart };
    ipRequestCounts.set(ip, data);
  } else {
    data.count++;
  }

  // Clean old entries
  for (const [key, val] of ipRequestCounts.entries()) {
    if (val.windowStart < now - WINDOW_MS * 2) {
      ipRequestCounts.delete(key);
    }
  }

  return data.count;

}

function checkNonceReuse(nonce: string | undefined): { isSuspicious: boolean; count: number } {
  if (!nonce) return { isSuspicious: false, count: 0 };

  const now = Date.now();
  let data = nonceTracker.get(nonce);

  if (!data) {
    data = { lastUsed: now, count: 1 };
    nonceTracker.set(nonce, data);
  } else {
    data.count++;
    data.lastUsed = now;
  }

  // Clean old nonces (older than 1 hour)
  for (const [key, val] of nonceTracker.entries()) {
    if (val.lastUsed < now - 3_600_000) {
      nonceTracker.delete(key);
    }
  }

  return { isSuspicious: data.count >= NONCE_REUSE_THRESHOLD, count: data.count };

}

function isUnusualHour(timestamp: number): boolean {
  const date = new Date(timestamp);
  const hour = date.getHours();
  return hour >= UNUSUAL_HOURS_START && hour < UNUSUAL_HOURS_END;

}

function detectSuspiciousPatterns(ip: string): Array<{ type: string; severity: 'low' | 'medium' | 'high'; details: string }> {
  const alerts: Array<{ type: string; severity: 'low' | 'medium' | 'high'; details: string }> = [];

  const logs = requestLog.get(ip) || [];
  if (logs.length < 10) return alerts; // Need minimum data

  // Check for rapid repeated requests with similar parameters
  const recentLogs = logs.slice(-20); // Last 20 requests
  const paramGroups = new Map<string, number>();

  for (const log of recentLogs) {
    const paramKey = `${log.pathname}:${log.params}`;
    paramGroups.set(paramKey, (paramGroups.get(paramKey) || 0) + 1);
  }

  for (const [key, count] of paramGroups.entries()) {
    if (count >= 5) {
      alerts.push({
        type: 'repeated_similar_requests',
        severity: 'medium',
        details: `IP ${ip} made ${count} similar requests to ${key.split(':')[0]} in short time`
      });
    }
  }

  // Check for nonce reuse
  const nonceGroups = new Map<string, number>();
  for (const log of recentLogs) {
    if (log.nonce) {
      nonceGroups.set(log.nonce, (nonceGroups.get(log.nonce) || 0) + 1);
    }
  }

  for (const [nonce, count] of nonceGroups.entries()) {
    if (count >= NONCE_REUSE_THRESHOLD) {
      alerts.push({
        type: 'nonce_reuse',
        severity: 'high',
        details: `IP ${ip} reused nonce ${nonce.substring(0, 8)}... ${count} times`
      });
    }
  }

  // Check for unusual hour access
  const unusualHourLogs = logs.filter(log => isUnusualHour(log.timestamp));
  if (unusualHourLogs.length > 0) {
    const recentUnusual = unusualHourLogs.slice(-10);
    if (recentUnusual.length >= 3) {
      alerts.push({
        type: 'unusual_hour_access',
        severity: 'low',
        details: `IP ${ip} accessed API ${recentUnusual.length} times during unusual hours (${UNUSUAL_HOURS_START}-${UNUSUAL_HOURS_END})`
      });
    }
  }

  // Check for sudden rate increase
  if (logs.length >= 20) {
    const firstHalf = logs.slice(0, 10);
    const secondHalf = logs.slice(10, 20);
    const timeSpanFirst = (firstHalf[9].timestamp - firstHalf[0].timestamp) || 1;
    const timeSpanSecond = (secondHalf[9].timestamp - secondHalf[0].timestamp) || 1;
    const rateFirst = (firstHalf.length * 60_000) / timeSpanFirst;
    const rateSecond = (secondHalf.length * 60_000) / timeSpanSecond;

    if (rateSecond > rateFirst * 3 && rateSecond > SUSPICIOUS_RATE_THRESHOLD) {
      alerts.push({
        type: 'sudden_rate_increase',
        severity: 'medium',
        details: `IP ${ip} showed sudden rate increase from ${Math.round(rateFirst)} to ${Math.round(rateSecond)} req/min`
      });
    }
  }

  return alerts;

}

export async function middleware(req: NextRequest, res: NextResponse) {
  const pathname = req.nextUrl.pathname;
  const isCritical = CRITICAL_ENDPOINTS.some(endpoint => pathname.startsWith(endpoint));

  if (!isCritical) {
    return NextResponse.next();
  }

  const ip = getClientIP(req);
  const method = req.method;
  let params: any = {};

  try {
    if (req.method === 'GET') {
      params = Object.fromEntries(req.nextUrl.searchParams);
    } else if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      // Note: In real implementation, you'd need to clone the request to read body
      // This is simplified for demonstration
      params = {}; // Body parsing would happen in route handlers
    }
  } catch (e) {
    params = { error: 'Failed to parse params' };
  }

  // Update rate limiting
  const requestRate = updateRateLimit(ip);

  // Extract subject and nonce from params if present
  const subject = params.subject || params.account || undefined;
  const nonce = params.nonce || undefined;

  // Continue with request
  const response = await NextResponse.next();

  // Log the request (non-blocking)
  const status = response.status;
  logRequest(ip, pathname, method, params, status, subject, nonce);

  // Check for suspicious patterns (non-blocking)
  const nonceCheck = checkNonceReuse(nonce);
  if (nonceCheck.isSuspicious) {
    console.warn(JSON.stringify({
      timestamp: new Date().toISOString(),
      action: 'behavioral_alert',
      ip,
      type: 'nonce_reuse',
      severity: 'high',
      details: `Nonce ${nonce?.substring(0, 8)}... reused ${nonceCheck.count} times`,
      pathname,
      method
    }));
  }

  // Rate limit alert
  if (requestRate > SUSPICIOUS_RATE_THRESHOLD) {
    console.warn(JSON.stringify({
      timestamp: new Date().toISOString(),
      action: 'behavioral_alert',
      ip,
      type: 'rate_limit_exceeded',
      severity: 'medium',
      details: `IP ${ip} exceeded rate limit: ${requestRate} requests/minute`,
      pathname,
      method
    }));
  }

  // Periodic suspicious pattern check (every 50 requests to avoid overhead)
  if (requestRate % 50 === 0) {
    const patterns = detectSuspiciousPatterns(ip);
    for (const pattern of patterns) {
      console.warn(JSON.stringify({
        timestamp: new Date().toISOString(),
        action: 'behavioral_alert',
        ip,
        type: pattern.type,
        severity: pattern.severity,
        details: pattern.details,
        pathname,
        method
      }));
    }
  }

  // Add monitoring headers to response
  const headers = new Headers(response.headers);
  headers.set('X-Request-Rate', String(requestRate));
  headers.set('X-Monitored-Endpoint', 'true');

  return new NextResponse(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });

}

export const config = {
  matcher: [
    '/api/dex/settle/:path*',
    '/api/dex/transfer/:path*',
    '/api/dex/order/:path*',
    '/api/dex/swap/:path*',
    '/api/dex/pool/:path*'
  ]
};