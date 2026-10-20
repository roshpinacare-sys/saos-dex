import { NextRequest, NextResponse } from 'next/server';
import { createLogger, format, transports } from 'winston';
import { Prometheus } from '@prometheus/client';

// Initialize Prometheus metrics
const prometheus = new Prometheus();
const requestCounter = prometheus.counter({
  name: 'dex_api_requests_total',
  help: 'Total number of DEX API requests',
  labelNames: ['method', 'endpoint', 'status_code', 'ip']
});

const errorCounter = prometheus.counter({
  name: 'dex_api_errors_total',
  help: 'Total number of DEX API errors',
  labelNames: ['error_type', 'endpoint', 'ip']
});

const anomalyGauge = prometheus.gauge({
  name: 'dex_api_anomaly_score',
  help: 'Anomaly score for IP addresses',
  labelNames: ['ip']
});

// Configure Winston logger
const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp(),
    format.json()
  ),
  transports: [
    new transports.Console(),
    new transports.File({ filename: 'dex-security-audit.log' })
  ]
});

// Security patterns for attack detection
const SQL_INJECTION_PATTERNS = [
  /(' OR '1'='1)/,
  /(' OR 1=1--)/,
  /(' OR 1=1#)/,
  /(' OR 1=1\/*)/,
  /(; DROP TABLE)/,
  /UNION SELECT /
];

const PATH_TRAVERSAL_PATTERNS = [
  /\.\./,
  /\\\\/,
  /%2e%2e/,
  /%2e%2e%2f/
];

const ADMIN_PATHS = [
  '/api/dex/admin',
  '/api/dex/internal',
  '/api/dex/debug'
];

// In-memory storage for behavioral tracking
const ipBehavior = new Map<string, {
  requestCount: number;
  errorCount: number;
  lastRequestTime: number;
  anomalyScore: number;
  recentEndpoints: Set<string>;
  errorTypes: Map<string, number>;
}>();

const MAX_BEHAVIOR_RECORDS = 10000;
const ANOMALY_THRESHOLD = 0.7;
const BURST_THRESHOLD = 50; // Requests in 1 minute
const TIME_WINDOW_MS = 60000;

// Helper function to calculate anomaly score
function calculateAnomalyScore(ip: string, request: NextRequest): number {
  const behavior = ipBehavior.get(ip) || {
    requestCount: 0,
    errorCount: 0,
    lastRequestTime: 0,
    anomalyScore: 0,
    recentEndpoints: new Set(),
    errorTypes: new Map()
  };

  const now = Date.now();
  const timeSinceLastRequest = now - behavior.lastRequestTime;
  
  // Reset counters if time window has passed
  if (timeSinceLastRequest > TIME_WINDOW_MS) {
    behavior.requestCount = 0;
    behavior.errorCount = 0;
    behavior.recentEndpoints.clear();
  }

  // Increment request count
  behavior.requestCount += 1;
  behavior.lastRequestTime = now;
  
  // Add endpoint to recent endpoints
  behavior.recentEndpoints.add(request.nextUrl.pathname);

  // Calculate burst detection
  const burstScore = behavior.requestCount > BURST_THRESHOLD ? 0.5 : 0;

  // Calculate endpoint diversity score
  const diversityScore = Math.min(behavior.recentEndpoints.size / 10, 0.3);

  // Calculate error rate score
  const errorRate = behavior.requestCount > 0 ? behavior.errorCount / behavior.requestCount : 0;
  const errorRateScore = Math.min(errorRate * 2, 0.4);

  // Calculate final anomaly score
  const newAnomalyScore = Math.min(burstScore + diversityScore + errorRateScore, 1);
  
  // Update behavior record
  behavior.anomalyScore = newAnomalyScore;
  ipBehavior.set(ip, behavior);

  // Clean up old records if needed
  if (ipBehavior.size > MAX_BEHAVIOR_RECORDS) {
    const oldestKey = ipBehavior.keys().next().value;
    ipBehavior.delete(oldestKey);
  }

  return newAnomalyScore;
}

// Helper function to detect attack patterns
function detectAttackPatterns(request: NextRequest): { attackDetected: boolean; attackType?: string } {
  const url = request.nextUrl.toString();
  const body = request.body ? request.body.toString() : '';
  
  // Check for SQL injection patterns
  for (const pattern of SQL_INJECTION_PATTERNS) {
    if (pattern.test(url) || pattern.test(body)) {
      return { attackDetected: true, attackType: 'SQL_INJECTION' };
    }
  }

  // Check for path traversal patterns
  for (const pattern of PATH_TRAVERSAL_PATTERNS) {
    if (pattern.test(url)) {
      return { attackDetected: true, attackType: 'PATH_TRAVERSAL' };
    }
  }

  // Check for admin access attempts
  for (const adminPath of ADMIN_PATHS) {
    if (url.includes(adminPath)) {
      return { attackDetected: true, attackType: 'ADMIN_ACCESS_ATTEMPT' };
    }
  }

  return { attackDetected: false };
}

// Helper function to classify error type
function classifyError(status: number): string {
  if (status >= 400 && status < 500) {
    return 'CLIENT_ERROR';
  } else if (status >= 500) {
    return 'SERVER_ERROR';
  }
  return 'OTHER';
}

// Main middleware function
export function securityMiddleware(req: NextRequest): NextResponse | null {
  const { pathname } = req.nextUrl;
  const ip = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
  
  // Record the request in Prometheus
  const method = req.method;
  const endpoint = pathname;
  
  // Calculate anomaly score
  const anomalyScore = calculateAnomalyScore(ip, req);
  
  // Update anomaly gauge
  anomalyGauge.set({ ip }, anomalyScore);
  
  // Check for attack patterns
  const { attackDetected, attackType } = detectAttackPatterns(req);
  
  if (attackDetected) {
    // Log security event
    logger.warn('Potential attack detected', {
      ip,
      endpoint,
      method,
      attackType,
      userAgent: req.headers.get('user-agent'),
      timestamp: new Date().toISOString()
    });
    
    // Update error counter
    errorCounter.inc({ error_type: attackType, endpoint, ip });
    
    // Block the request
    return NextResponse.json(
      { error: 'Security violation detected', attackType },
      { status: 403 }
    );
  }
  
  // Check for high anomaly score
  if (anomalyScore > ANOMALY_THRESHOLD) {
    // Log suspicious activity
    logger.warn('Suspicious activity detected', {
      ip,
      anomalyScore,
      endpoint,
      method,
      userAgent: req.headers.get('user-agent'),
      timestamp: new Date().toISOString()
    });
    
    // Continue with the request but log it
    // In a real implementation, you might want to throttle or alert
  }
  
  // Continue with normal request processing
  // We'll intercept the response to log errors
  const originalRes = NextResponse.next();
  
  // Create a custom response that logs errors
  const customRes = new Proxy(originalRes, {
    set: (target, property, value) => {
      if (property === 'status' && (value >= 400 || value >= 500)) {
        const errorType = classifyError(value);
        const behavior = ipBehavior.get(ip) || { errorTypes: new Map() };
        
        // Update error type count
        if (!behavior.errorTypes.has(errorType)) {
          behavior.errorTypes.set(errorType, 0);
        }
        behavior.errorTypes.set(errorType, (behavior.errorTypes.get(errorType) || 0) + 1);
        
        // Update total error count
        if (!behavior.errorCount) behavior.errorCount = 0;
        behavior.errorCount += 1;
        
        // Update behavior record
        ipBehavior.set(ip, behavior);
        
        // Log error
        logger.error('API error occurred', {
          ip,
          endpoint,
          method,
          status: value,
          errorType,
          userAgent: req.headers.get('user-agent'),
          timestamp: new Date().toISOString()
        });
        
        // Update error counter
        errorCounter.inc({ error_type: errorType, endpoint, ip });
      }
      
      // Record the request in Prometheus
      requestCounter.inc({ method, endpoint, status_code: value.toString(), ip });
      
      return Reflect.set(target, property, value);
    }
  });
  
  return customRes;
}

// Export the middleware
export const config = {
  matcher: ['/api/dex/agent/:path*', '/api/dex/order/:path*', '/api/dex/swap/:path*']
};