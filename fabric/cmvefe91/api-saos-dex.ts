import { NextRequest, NextResponse } from 'next/server';
import { db } from '../db';
import { createLogger, transports, format } from 'winston';
import { Prometheus } from '@prometheus/client';

// Prometheus client setup
const prometheus = new Prometheus();
const httpRequestCounter = prometheus.createCounter('dex_api_requests_total', 'Total number of API requests', {
  labels: ['endpoint', 'method', 'status'],
});
const httpRequestDuration = prometheus.createHistogram('dex_api_request_duration_seconds', 'API request duration', {
  labels: ['endpoint', 'method'],
  buckets: [0.1, 0.5, 1, 1.5, 2, 5],
});

// Winston logger setup
const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp(),
    format.json(),
    format.metadata()
  ),
  transports: [
    new transports.File({ filename: 'logs/dex-api.log' }),
    new transports.Console()
  ],
});

// Alert thresholds
const ALERT_THRESHOLDS = {
  highErrorRate: 0.1, // 10% error rate
  highRequestRate: 100, // 100 requests per minute
  highLatency: 2, // 2 seconds
};

// Alert function
function checkAlerts(endpoint: string, method: string, duration: number, status: number) {
  const now = Date.now();
  
  // Check high error rate
  if (status >= 400) {
    logger.warn('High error rate detected', {
      endpoint,
      method,
      status,
      timestamp: now,
      alertType: 'high_error_rate',
    });
  }
  
  // Check high latency
  if (duration > ALERT_THRESHOLDS.highLatency) {
    logger.warn('High latency detected', {
      endpoint,
      method,
      duration,
      timestamp: now,
      alertType: 'high_latency',
    });
  }
}

// Main monitoring middleware
export function monitoringMiddleware(req: NextRequest): NextResponse | null {
  const { pathname } = req.nextUrl;
  const criticalEndpoints = ['/api/dex/agent', '/api/dex/order', '/api/dex/swap'];
  
  // Only apply to critical endpoints
  if (!criticalEndpoints.some(path => pathname.includes(path))) {
    return null;
  }
  
  const startTime = Date.now();
  const method = req.method;
  const ip = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
  
  // Log request details
  logger.info('API request received', {
    endpoint: pathname,
    method,
    ip,
    timestamp: startTime,
    userAgent: req.headers.get('user-agent'),
  });
  
  // Continue with the request
  const res = NextResponse.next();
  
  // Capture response status
  res.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'x-response-time') {
      const duration = parseFloat(value);
      
      // Update Prometheus metrics
      httpRequestCounter.inc({
        endpoint: pathname,
        method,
        status: res.status,
      });
      
      httpRequestDuration.observe({
        endpoint: pathname,
        method,
      }, duration);
      
      // Check for alerts
      checkAlerts(pathname, method, duration, res.status);
    }
  });
  
  return res;
}

// Metrics endpoint for Prometheus scraping
export async function metricsEndpoint(): Promise<Response> {
  return new Response(prometheus.metrics(), {
    headers: {
      'Content-Type': prometheus.contentType,
    },
  });
}

// Generate monthly report
export async function generateMonthlyReport(): Promise<void> {
  const lastMonth = new Date();
  lastMonth.setMonth(lastMonth.getMonth() - 1);
  
  try {
    // Get API usage statistics from database
    const stats = await db.apiLog.groupBy({
      by: ['endpoint', 'method'],
      _count: {
        _all: true,
      },
      _avg: {
        duration: true,
      },
      where: {
        timestamp: {
          gte: lastMonth,
        },
      },
      orderBy: {
        _count: {
          _all: 'desc',
        },
      },
    });
    
    // Generate report
    const report = {
      period: lastMonth.toISOString().slice(0, 7),
      generatedAt: new Date().toISOString(),
      endpoints: stats.map(stat => ({
        endpoint: stat.endpoint,
        method: stat.method,
        requestCount: stat._count._all,
        avgDuration: stat._avg.duration,
      })),
    };
    
    // Save report
    await db.monthlyReport.create({
      data: {
        period: report.period,
        report: JSON.stringify(report),
      },
    });
    
    logger.info('Monthly report generated', {
      period: report.period,
      endpointCount: report.endpoints.length,
    });
    
  } catch (error) {
    logger.error('Failed to generate monthly report', { error });
  }
}

// Initialize monitoring
export function initializeMonitoring(): void {
  // Set up scheduled tasks
  setInterval(() => {
    generateMonthlyReport();
  }, 30 * 24 * 60 * 60 * 1000); // Every 30 days
  
  logger.info('Monitoring system initialized');
}
