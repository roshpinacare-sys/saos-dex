import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'node:crypto';

// Configuration
const SUSPICIOUS_IP_THRESHOLD = 100; // requests per minute
const LARGE_PAYLOAD_THRESHOLD = 1024 * 100; // 100KB
const SLOW_RESPONSE_THRESHOLD_MS = 5000; // 5s

// In-memory stores (in production, use Redis or similar)
const requestCounts = new Map<string, { count: number; resetTime: number }>();
const suspiciousIPs = new Set<string>();

// Helper functions
function getClientIP(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
         req.headers.get('x-real-ip') ||
         req.ip ||
         'unknown';
}

function isExemptPath(pathname: string): boolean {
  const exemptPaths = ['/api/dex/stream', '/api/revive'];
  return exemptPaths.some(path => pathname.startsWith(path));
}

function logSecurityEvent(type: string, details: Record<string, unknown>) {
  const event = {
    timestamp: new Date().toISOString(),
    event_id: uuidv4(),
    type,
    ...details
  };
  console.warn(JSON.stringify({ action: 'security_event', ...event }));

  // Attempt to send to alert system (fail-open)
  void (async () => {
    try {
      const base = process.env.SAOS_CONTROL_CENTER_URL;
      if (!base) return;
      await fetch(`${base}/api/alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_type: `dex_api_${type}`,
          at: new Date().toISOString(),
          service_id: 'saos-dex',
          details
        }),
        signal: AbortSignal.timeout(3000),
      });
    } catch (alertError) {
      console.warn(`[${new Date().toISOString()}] ALERT_SYSTEM_FAILURE: Failed to trigger security alert - ${alertError instanceof Error ? alertError.message : 'Unknown error'}`);
    }
  })();
}

function updateRequestRate(ip: string): boolean {
  const now = Date.now();
  const windowMs = 60_000;

  const data = requestCounts.get(ip) || { count: 0, resetTime: now + windowMs };

  if (now > data.resetTime) {
    data.count = 0;
    data.resetTime = now + windowMs;
  }

  data.count += 1;
  requestCounts.set(ip, data);

  if (data.count > SUSPICIOUS_IP_THRESHOLD) {
    suspiciousIPs.add(ip);
    return true;
  }

  return false;
}

function isSuspiciousIP(ip: string): boolean {
  return suspiciousIPs.has(ip);
}

function detectSuspiciousPayload(req: NextRequest): boolean {
  const contentLength = req.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > LARGE_PAYLOAD_THRESHOLD) {
    return true;
  }

  // Check for suspicious query parameters
  const url = new URL(req.url);
  const suspiciousParams = ['<', '>', '"', "'", ';', '--', '/*', '*/'];
  for (const [key, value] of url.searchParams) {
    if (suspiciousParams.some(param => (value as string).includes(param))) {
      return true;
    }
  }

  return false;
}

async function monitorRequestHandler(
  req: NextRequest,
  handler: () => Promise<NextResponse>
): Promise<NextResponse> {
  const startTime = Date.now();
  const requestId = uuidv4();
  const ip = getClientIP(req);
  const userAgent = req.headers.get('user-agent') || 'unknown';
  const pathname = req.nextUrl.pathname;

  // Skip monitoring for exempt paths
  if (isExemptPath(pathname)) {
    return await handler();
  }

  // Log incoming request
  console.info(JSON.stringify({
    action: 'api_request_start',
    request_id: requestId,
    method: req.method,
    path: pathname,
    ip,
    user_agent: userAgent,
    timestamp: new Date(startTime).toISOString()
  }));

  // Security checks
  const isHighRate = updateRequestRate(ip);
  const isSuspiciousIPFlag = isSuspiciousIP(ip);
  const hasSuspiciousPayload = detectSuspiciousPayload(req);

  if (isHighRate || isSuspiciousIPFlag || hasSuspiciousPayload) {
    logSecurityEvent('suspicious_activity', {
      request_id: requestId,
      ip,
      user_agent: userAgent,
      path: pathname,
      method: req.method,
      is_high_rate: isHighRate,
      is_suspicious_ip: isSuspiciousIPFlag,
      has_suspicious_payload: hasSuspiciousPayload
    });

    // If it's a clear threat, consider blocking (but fail-open for availability)
    if (isHighRate && isSuspiciousIPFlag) {
      // Log but don't block - fail-open principle
      console.warn(`High rate suspicious IP detected: ${ip}`);
    }
  }

  try {
    const response = await handler();
    const endTime = Date.now();
    const durationMs = endTime - startTime;

    // Log response
    console.info(JSON.stringify({
      action: 'api_request_end',
      request_id: requestId,
      method: req.method,
      path: pathname,
      ip,
      status_code: response.status,
      duration_ms: durationMs,
      timestamp: new Date(endTime).toISOString()
    }));

    // Monitor for slow responses
    if (durationMs > SLOW_RESPONSE_THRESHOLD_MS) {
      logSecurityEvent('slow_response', {
        request_id: requestId,
        ip,
        path: pathname,
        method: req.method,
        duration_ms: durationMs,
        threshold_ms: SLOW_RESPONSE_THRESHOLD_MS
      });
    }

    // Emit metrics for Prometheus (simplified - in practice use a proper client)
    void (async () => {
      try {
        // In a real implementation, this would push to a Prometheus pushgateway
        // or expose metrics endpoint. For now, we log structured data.
        console.info(JSON.stringify({
          action: 'api_metric',
          metric_type: 'response_time',
          path: pathname,
          method: req.method,
          status_code: response.status,
          value: durationMs,
          timestamp: new Date(endTime).toISOString()
        }));

        console.info(JSON.stringify({
          action: 'api_metric',
          metric_type: 'request_count',
          path: pathname,
          method: req.method,
          status_code: response.status,
          value: 1,
          timestamp: new Date(endTime).toISOString()
        }));
      } catch (metricsError) {
        console.warn(`[${new Date().toISOString()}] METRICS_FAILURE: Failed to emit metrics - ${metricsError instanceof Error ? metricsError.message : 'Unknown error'}`);
      }
    })();

    return response;
  } catch (error) {
    const endTime = Date.now();
    const durationMs = endTime - startTime;

    console.error(JSON.stringify({
      action: 'api_request_error',
      request_id: requestId,
      method: req.method,
      path: pathname,
      ip,
      error: error instanceof Error ? error.message : 'Unknown error',
      error_type: error instanceof Error ? error.constructor.name : typeof error,
      duration_ms: durationMs,
      timestamp: new Date(endTime).toISOString()
    }));

    logSecurityEvent('request_error', {
      request_id: requestId,
      ip,
      path: pathname,
      method: req.method,
      error: error instanceof Error ? error.message : 'Unknown error',
      error_type: error instanceof Error ? error.constructor.name : typeof error,
      duration_ms: durationMs
    });

    // Re-throw to let Next.js handle the error response
    throw error;
  }
}

// Wrapper functions for each route type
export async function monitorAgentRoute(req: NextRequest): Promise<NextResponse> {
  return monitorRequestHandler(req, async () => {
    const { handler } = await import('./route');
    return handler(req);
  });
}

export async function monitorOrderRoute(req: NextRequest): Promise<NextResponse> {
  return monitorRequestHandler(req, async () => {
    const { handler } = await import('../order/route');
    return handler(req);
  });
}

export async function monitorSwapRoute(req: NextRequest): Promise<NextResponse> {
  return monitorRequestHandler(req, async () => {
    const { handler } = await import('../swap/route');
    return handler(req);
  });
}
