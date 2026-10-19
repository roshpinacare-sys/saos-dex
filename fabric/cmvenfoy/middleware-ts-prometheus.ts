import { NextRequest, NextResponse } from 'next/server';
import { Prometheus } from '@prometheus/client';

// Initialize Prometheus client
const prometheus = new Prometheus({
  prefix: 'saos_dex_',
  port: 9091,
});

// Metrics definition
const requestCounter = prometheus.newCounter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labels: ['method', 'endpoint', 'status_code'],
});

const requestDuration = prometheus.newHistogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labels: ['method', 'endpoint'],
  buckets: [0.1, 0.5, 1, 2, 5],
});

const anomalyDetector = prometheus.newGauge({
  name: 'anomaly_detected',
  help: 'Anomaly detected flag',
  labels: ['type', 'severity'],
});

const requestPatterns = new Map<string, {
  count: number;
  timestamps: number[];
  lastReset: number;
}>();

const ANOMALY_THRESHOLDS = {
  burstRequests: 50, // Requests in 1 minute
  patternChange: 0.5, // 50% change in request pattern
  injectionAttempts: 10, // Suspected injection attempts
};

const CRITICAL_ENDPOINTS = [
  '/api/dex/agent',
  '/api/dex/order',
  '/api/dex/swap',
  '/api/dex/transfer',
  '/api/dex/pool',
];

// Helper function to detect anomalies
function detectAnomaly(ip: string, endpoint: string, method: string): {
  detected: boolean;
  type: string;
  severity: 'low' | 'medium' | 'high';
} {
  const now = Date.now();
  const oneMinute = 60 * 1000;
  const key = `${ip}-${endpoint}`;
  
  if (!requestPatterns.has(key)) {
    requestPatterns.set(key, {
      count: 0,
      timestamps: [],
      lastReset: now,
    });
  }
  
  const pattern = requestPatterns.get(key)!;
  
  // Reset pattern if more than a minute has passed
  if (now - pattern.lastReset > oneMinute) {
    pattern.count = 0;
    pattern.timestamps = [];
    pattern.lastReset = now;
  }
  
  // Add current request
  pattern.count++;
  pattern.timestamps.push(now);
  
  // Remove timestamps older than 1 minute
  pattern.timestamps = pattern.timestamps.filter(
    ts => now - ts <= oneMinute
  );
  
  // Detect burst requests
  if (pattern.count > ANOMALY_THRESHOLDS.burstRequests) {
    return {
      detected: true,
      type: 'burst_requests',
      severity: 'high',
    };
  }
  
  // Detect pattern changes
  if (pattern.timestamps.length > 1) {
    const recentRequests = pattern.timestamps.length;
    const previousRequests = pattern.count - recentRequests;
    
    if (previousRequests > 0) {
      const changeRatio = Math.abs(
        (recentRequests - previousRequests) / previousRequests
      );
      
      if (changeRatio > ANOMALY_THRESHOLDS.patternChange) {
        return {
          detected: true,
          type: 'pattern_change',
          severity: 'medium',
        };
      }
    }
  }
  
  // Detect potential injection attempts
  if (CRITICAL_ENDPOINTS.includes(endpoint)) {
    const suspiciousPatterns = [
      /\b(?:SELECT|INSERT|UPDATE|DELETE|DROP|UNION|SCRIPT)\b/i,
      /\b(?:<|>|\/\*|\*\/|\\|\')\b/i,
    ];
    
    for (const regex of suspiciousPatterns) {
      if (regex.test(method) || regex.test(endpoint)) {
        return {
          detected: true,
          type: 'injection_attempt',
          severity: 'high',
        };
      }
    }
  }
  
  return {
    detected: false,
    type: '',
    severity: 'low',
  };
}

// Helper function to log suspicious requests
function logSuspiciousRequest(
  ip: string,
  endpoint: string,
  method: string,
  anomalyType: string,
  severity: string
): void {
  const timestamp = new Date().toISOString();
  
  console.log(
    JSON.stringify({
      timestamp,
      action: 'suspicious_request',
      ip,
      endpoint,
      method,
      anomalyType,
      severity,
    })
  );
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const start = Date.now();
  const ip = request.headers.get('x-forwarded-for') || 'unknown';
  const endpoint = request.nextUrl.pathname;
  const method = request.method;
  
  // Skip monitoring for exempt endpoints
  if (['/api/dex/stream', '/api/revive'].includes(endpoint)) {
    return NextResponse.next();
  }
  
  // Detect anomalies
  const { detected, type, severity } = detectAnomaly(ip, endpoint, method);
  
  if (detected) {
    // Update anomaly gauge
    anomalyDetector.set(
      { type, severity },
      1
    );
    
    // Log suspicious request
    logSuspiciousRequest(ip, endpoint, method, type, severity);
    
    // Optional: Block requests based on severity
    if (severity === 'high') {
      return new NextResponse(
        JSON.stringify({
          error: 'Request blocked due to suspicious activity',
          type,
        }),
        {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
  }
  
  // Process the request
  const response = NextResponse.next();
  
  // Record metrics
  const duration = (Date.now() - start) / 1000;
  const statusCode = response.status.toString();
  
  requestCounter.inc({ method, endpoint, status_code: statusCode });
  requestDuration.observe({ method, endpoint }, duration);
  
  // Add response headers for monitoring
  response.headers.set('X-Response-Time', `${duration}s`);
  response.headers.set('X-Endpoint-Monitored', 'true');
  
  return response;
}

// Export the Prometheus metrics endpoint
export { prometheus } from '@prometheus/client';