import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { logger } from '@/lib/logging';
import { prometheus } from '@/lib/metrics';

type BehavioralMetric = {
  endpoint: string;
  ip: string;
  userAgent: string;
  timestamp: number;
  duration: number;
  requestSize: number;
  responseSize: number;
  statusCode: number;
  payload: any;
  anomalyScore: number;
};

export class BehavioralMonitor {
  private static instance: BehavioralMonitor;
  private metricsWindow: Map<string, BehavioralMetric[]> = new Map();
  private readonly WINDOW_SIZE_MS = 60_000; // 1 minute
  private readonly ANOMALY_THRESHOLD = 0.75;
  
  static getInstance(): BehavioralMonitor {
    if (!BehavioralMonitor.instance) {
      BehavioralMonitor.instance = new BehavioralMonitor();
    }
    return BehavioralMonitor.instance;
  }

  async analyzeRequest(req: NextRequest, endpoint: string, payload: any, startTime: number): Promise<NextResponse | null> {
    const ip = this.getClientIp(req);
    const userAgent = req.headers.get('user-agent') || 'unknown';
    const statusCode = 200; // Will be set later
    const duration = Date.now() - startTime;
    
    // Record request/response sizes
    const requestSize = req.headers.get('content-length') || 0;
    const responseSize = 0; // Will be set when response is created
    
    const metric: BehavioralMetric = {
      endpoint,
      ip,
      userAgent,
      timestamp: startTime,
      duration,
      requestSize: Number(requestSize),
      responseSize,
      statusCode,
      payload,
      anomalyScore: 0
    };
    
    // Add to metrics window
    const key = `${ip}-${endpoint}`;
    if (!this.metricsWindow.has(key)) {
      this.metricsWindow.set(key, []);
    }
    this.metricsWindow.get(key)!.push(metric);
    
    // Clean old metrics
    this.cleanOldMetrics();
    
    // Analyze for anomalies
    const anomaly = this.detectAnomalies(metric, key);
    
    if (anomaly) {
      // Log anomaly
      logger.warn('Behavioral anomaly detected', {
        endpoint,
        ip,
        anomalyType: anomaly.type,
        score: anomaly.score,
        details: anomaly.details
      });
      
      // Record Prometheus metrics
      prometheus.inc('dex_behavioral_anomalies_total', { endpoint, type: anomaly.type });
      
      // Check if we should block the request
      if (anomaly.score > this.ANOMALY_THRESHOLD) {
        return NextResponse.json(
          { 
            ok: false, 
            error: 'Behavioral anomaly detected',
            anomaly: {
              type: anomaly.type,
              score: anomaly.score,
              details: anomaly.details
            }
          }, 
          { status: 429 }
        );
      }
    }
    
    return null;
  }

  private getClientIp(req: NextRequest): string {
    const xff = req.headers.get('x-forwarded-for');
    if (xff) {
      const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length > 0) return parts[parts.length - 1] ?? 'proxied';
      return 'proxied';
    }
    return req.headers.get('x-real-ip') ?? 'local';
  }

  private cleanOldMetrics(): void {
    const now = Date.now();
    for (const [key, metrics] of this.metricsWindow.entries()) {
      const filtered = metrics.filter(m => now - m.timestamp < this.WINDOW_SIZE_MS);
      if (filtered.length === 0) {
        this.metricsWindow.delete(key);
      } else {
        this.metricsWindow.set(key, filtered);
      }
    }
  }

  private detectAnomalies(metric: BehavioralMetric, key: string): { type: string; score: number; details: any } | null {
    const windowMetrics = this.metricsWindow.get(key) || [];
    
    if (windowMetrics.length < 5) {
      return null; // Not enough data yet
    }
    
    const anomalies: { type: string; score: number; details: any }[] = [];
    
    // 1. Check for potential reentrancy attacks
    const avgDuration = windowMetrics.reduce((sum, m) => sum + m.duration, 0) / windowMetrics.length;
    if (metric.duration < avgDuration * 0.3) {
      anomalies.push({
        type: 'potential_reentrancy',
        score: 0.8,
        details: {
          currentDuration: metric.duration,
          averageDuration: avgDuration
        }
      });
    }
    
    // 2. Check for potential front-running
    const recentRequests = windowMetrics.filter(m => metric.timestamp - m.timestamp < 5000);
    if (recentRequests.length > 3) {
      anomalies.push({
        type: 'potential_front_running',
        score: Math.min(0.9, recentRequests.length / 10),
        details: {
          recentRequestsCount: recentRequests.length,
          timeWindow: 5000
        }
      });
    }
    
    // 3. Check for unusual request sizes
    const avgRequestSize = windowMetrics.reduce((sum, m) => sum + m.requestSize, 0) / windowMetrics.length;
    if (metric.requestSize > avgRequestSize * 10) {
      anomalies.push({
        type: 'unusual_request_size',
        score: 0.7,
        details: {
          currentSize: metric.requestSize,
          averageSize: avgRequestSize
        }
      });
    }
    
    // 4. Check for unusual response patterns
    const avgResponseSize = windowMetrics.reduce((sum, m) => sum + m.responseSize, 0) / windowMetrics.length;
    if (metric.responseSize > avgResponseSize * 5) {
      anomalies.push({
        type: 'unusual_response_size',
        score: 0.6,
        details: {
          currentSize: metric.responseSize,
          averageSize: avgResponseSize
        }
      });
    }
    
    // 5. Check for potential sandwich attacks
    if (endpoint === '/api/dex/swap' && payload) {
      const swaps = windowMetrics.filter(m => m.endpoint === '/api/dex/swap');
      if (swaps.length > 5) {
        const avgAmount = swaps.reduce((sum, m) => {
          const p = m.payload;
          return sum + (p.amountIn || 0) + (p.amountOut || 0);
        }, 0) / swaps.length;
        
        const currentAmount = (payload.amountIn || 0) + (payload.amountOut || 0);
        if (currentAmount > avgAmount * 20) {
          anomalies.push({
            type: 'potential_sandwich_attack',
            score: 0.85,
            details: {
              currentAmount,
              averageAmount: avgAmount
            }
          });
        }
      }
    }
    
    // 6. Check for unusual timing patterns
    const requestTimes = windowMetrics.map(m => m.timestamp).sort();
    if (requestTimes.length > 10) {
      const intervals = [];
      for (let i = 1; i < requestTimes.length; i++) {
        intervals.push(requestTimes[i] - requestTimes[i-1]);
      }
      
      const avgInterval = intervals.reduce((sum, i) => sum + i, 0) / intervals.length;
      const lastInterval = requestTimes[requestTimes.length - 1] - requestTimes[requestTimes.length - 2];
      
      if (lastInterval < avgInterval * 0.1) {
        anomalies.push({
          type: 'unusual_timing_pattern',
          score: 0.75,
          details: {
            lastInterval,
            averageInterval: avgInterval
          }
        });
      }
    }
    
    // Return the highest scoring anomaly
    if (anomalies.length > 0) {
      return anomalies.reduce((max, anomaly) => 
        anomaly.score > max.score ? anomaly : max
      );
    }
    
    return null;
  }
  
  // Method to record completed request with response details
  recordResponse(metric: BehavioralMetric, responseSize: number, statusCode: number): void {
    metric.responseSize = responseSize;
    metric.statusCode = statusCode;
    
    // Record Prometheus metrics
    prometheus.observe('dex_api_request_duration_seconds', metric.duration, {
      endpoint: metric.endpoint,
      status: String(statusCode)
    });
    
    prometheus.inc('dex_api_requests_total', { 
      endpoint: metric.endpoint,
      status: String(statusCode)
    });
  }
}

// Create a singleton instance
export const behavioralMonitor = BehavioralMonitor.getInstance();

// Middleware integration
export async function behavioralMonitoringMiddleware(req: NextRequest, endpoint: string): Promise<NextResponse | null> {
  // Skip non-critical endpoints
  const criticalEndpoints = ['/api/dex/agent', '/api/dex/order', '/api/dex/swap'];
  if (!criticalEndpoints.includes(endpoint)) {
    return null;
  }
  
  const startTime = Date.now();
  
  try {
    // Clone the request to read the body
    const clonedReq = req.clone();
    const payload = endpoint !== '/api/dex/agent' ? await clonedReq.json().catch(() => ({})) : {};
    
    // Analyze the request
    const response = await behavioralMonitor.analyzeRequest(req, endpoint, payload, startTime);
    if (response) {
      return response;
    }
    
    return null; // Continue to the next handler
  } catch (error) {
    logger.error('Behavioral monitoring error', { error });
    return null; // Continue to the next handler
  }
}

// Example of how to integrate in API routes
export async function withBehavioralMonitoring(
  req: NextRequest, 
  endpoint: string,
  handler: (req: NextRequest) => Promise<NextResponse>
): Promise<NextResponse> {
  const startTime = Date.now();
  
  // Check for behavioral anomalies
  const anomalyResponse = await behavioralMonitoringMiddleware(req, endpoint);
  if (anomalyResponse) {
    return anomalyResponse;
  }
  
  // Execute the handler
  const response = await handler(req);
  
  // Record the response
  const metric: BehavioralMetric = {
    endpoint,
    ip: behavioralMonitor.getClientIp(req),
    userAgent: req.headers.get('user-agent') || 'unknown',
    timestamp: startTime,
    duration: Date.now() - startTime,
    requestSize: Number(req.headers.get('content-length') || 0),
    responseSize: Number(response.headers.get('content-length') || 0),
    statusCode: response.status,
    payload: {},
    anomalyScore: 0
  };
  
  behavioralMonitor.recordResponse(metric, metric.responseSize, metric.statusCode);
  
  return response;
}

// Winston logger configuration
import winston from 'winston';

export const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'dex-api' },
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

// Prometheus metrics configuration
import client from 'prom-client';

const register = new client.Registry();

client.collectDefaultMetrics({ register });

register.registerMetric(new client.Counter({
  name: 'dex_api_requests_total',
  help: 'Total number of API requests',
  labelNames: ['endpoint', 'status']
}));

register.registerMetric(new client.Histogram({
  name: 'dex_api_request_duration_seconds',
  help: 'API request duration in seconds',
  labelNames: ['endpoint', 'status'],
  buckets: [0.1, 0.5, 1, 1.5, 2, 3, 5, 10]
}));

register.registerMetric(new client.Counter({
  name: 'dex_behavioral_anomalies_total',
  help: 'Total number of behavioral anomalies detected',
  labelNames: ['endpoint', 'type']
}));

export const prometheus = {
  inc: (name: string, labels: Record<string, string> = {}) => {
    const metric = register.getSingleMetric(name) as client.Counter;
    if (metric) metric.inc(labels);
  },
  observe: (name: string, value: number, labels: Record<string, string> = {}) => {
    const metric = register.getSingleMetric(name) as client.Histogram;
    if (metric) metric.observe(labels, value);
  },
  metrics: () => register.metrics()
};
