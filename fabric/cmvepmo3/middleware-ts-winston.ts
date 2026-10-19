import { NextRequest, NextResponse } from 'next/server';
import winston from 'winston';

// ── Winston Logger Setup ──────────────────────────────────────────────────────
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'saos-dex-middleware' },
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console({
      format: winston.format.simple(),
      level: process.env.NODE_ENV === 'production' ? 'warn' : 'debug'
    })
  ]
});

// ── In-Memory Request Tracking ─────────────────────────────────────────────────
interface RequestRecord {
  count: number;
  firstSeen: number;
  paths: Set<string>;
  statusCodes: Map<number, number>;
}

const ipRequests = new Map<string, RequestRecord>();
const WINDOW_MS = 60_000;
const BURST_THRESHOLD = 50; // requests in WINDOW_MS
const SUSPICIOUS_PATHS = [
  '/api/dex/admin',
  '/api/dex/internal',
  '../',
  '..\\',
  '.env',
  'wp-admin',
  'phpmyadmin'
];
const INJECTION_PATTERNS = [
  /('('|"|`)|;|\||\$|\{|\}|\(|\)|\\|\||\*|\?)/i,
  /select\s+.*\s+from/i,
  /insert\s+into/i,
  /delete\s+from/i,
  /union\s+all/i,
  /drop\s+table/i,
  /script/i,
  /javascript/i,
  /onload/i,
  /onclick/i
];

// ── Helper Functions ──────────────────────────────────────────────────────────
function isSuspiciousPath(path: string): boolean {
  return SUSPICIOUS_PATHS.some(suspicious => path.includes(suspicious));
}

function hasInjectionPattern(input: string): boolean {
  return INJECTION_PATTERNS.some(pattern => pattern.test(input));
}

function classifyError(status: number): string {
  if (status >= 400 && status < 500) return 'client_error';
  if (status >= 500) return 'server_error';
  return 'other';
}

function detectAnomaly(ip: string, record: RequestRecord): boolean {
  // Detect burst behavior
  if (record.count > BURST_THRESHOLD) {
    logger.warn('Burst behavior detected', { ip, count: record.count, window: WINDOW_MS });
    return true;
  }

  // Detect path pattern changes
  if (record.paths.size > 10) {
    logger.warn('Unusual path diversity detected', { ip, pathCount: record.paths.size });
    return true;
  }

  // Detect high error rates
  const errorCount = Array.from(record.statusCodes.values())
    .reduce((sum, count, idx) => {
      const status = Array.from(record.statusCodes.keys())[idx];
      return classifyError(status) === 'client_error' ? sum + count : sum;
    }, 0);

  if (errorCount > record.count * 0.3) {
    logger.warn('High error rate detected', { ip, errorCount, total: record.count });
    return true;
  }

  return false;
}

function updateRequestRecord(ip: string, path: string, status: number): void {
  const now = Date.now();
  let record = ipRequests.get(ip);

  if (!record) {
    record = {
      count: 0,
      firstSeen: now,
      paths: new Set(),
      statusCodes: new Map()
    };
    ipRequests.set(ip, record);
  }

  record.count++;
  record.paths.add(path);

  const currentCount = record.statusCodes.get(status) || 0;
  record.statusCodes.set(status, currentCount + 1);

  // Clean old records
  if (now - record.firstSeen > WINDOW_MS) {
    ipRequests.delete(ip);
  }

  // Detect anomalies
  if (detectAnomaly(ip, record)) {
    logger.warn('Anomaly threshold exceeded', { ip, path, status });
    // Could trigger additional alerting here
  }
}

// ── Main Middleware ───────────────────────────────────────────────────────────
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { ip, method, url, headers } = request;
  const path = new URL(url).pathname;
  const userAgent = headers.get('user-agent') || 'unknown';
  const referer = headers.get('referer') || 'unknown';
  
  // Initialize response object
  let response: NextResponse;
  
  // Track request
  updateRequestRecord(ip, path, 200); // Will update with actual status later

  // Detailed logging
  logger.info('API request', {
    ip,
    method,
    path,
    userAgent,
    referer,
    timestamp: new Date().toISOString()
  });

  // Check for suspicious paths
  if (isSuspiciousPath(path)) {
    logger.warn('Suspicious path detected', { ip, path });
    // Continue but log for potential blocking later
  }

  // Check for injection patterns in query params
  const urlObj = new URL(url);
  for (const [key, value] of urlObj.searchParams.entries()) {
    if (hasInjectionPattern(value)) {
      logger.warn('Potential injection attempt', { ip, path, key, value });
      // Continue but log for potential blocking later
    }
  }

  // Check for admin/internal access attempts
  if (path.startsWith('/api/dex/admin') || path.startsWith('/api/dex/internal')) {
    const authHeader = headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logger.warn('Unauthorized admin/internal access attempt', { ip, path });
      // Continue but log for potential blocking later
    }
  }

  // Clone the request to read the body for potential attacks
  // Note: This has performance implications and should be used judiciously
  const clonedRequest = request.clone();
  const body = await clonedRequest.text().catch(() => '');
  
  if (hasInjectionPattern(body)) {
    logger.warn('Potential injection in request body', { ip, path, bodyPreview: body.substring(0, 100) });
  }

  // Continue with the request
  try {
    response = NextResponse.next();
  } catch (error) {
    logger.error('Middleware error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }

  // Update with actual status code
  const actualStatus = response.status;
  updateRequestRecord(ip, path, actualStatus);

  // Log errors
  if (actualStatus >= 400) {
    logger.warn(`HTTP ${actualStatus} error`, {
      ip,
      method,
      path,
      userAgent,
      timestamp: new Date().toISOString()
    });
  }

  // Add security headers
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  
  return response;
}

// ── Export logger for use in other modules ─────────────────────────────────────
export { logger };