import { NextRequest, NextResponse } from 'next/server';

// סוגים לניטור התנהגותי
type ErrorType = '4xx' | '5xx' | 'sql-injection' | 'path-traversal' | 'admin-access' | 'burst' | 'ip-spike' | 'injection-attempt';

interface RequestMetrics {
  timestamp: number;
  ip: string;
  path: string;
  method: string;
  status?: number;
  errorType?: ErrorType;
  userAgent?: string;
  responseTime?: number;
}

interface BehavioralMonitorConfig {
  burstThreshold: number;
  burstWindowMs: number;
  ipSpikeThreshold: number;
  ipSpikeWindowMs: number;
  sensitivePaths: string[];
  errorRateThreshold: number;
}

const config: BehavioralMonitorConfig = {
  burstThreshold: 50,
  burstWindowMs: 60000, // 1 דקה
  ipSpikeThreshold: 100,
  ipSpikeWindowMs: 300000, // 5 דקות
  sensitivePaths: ['/api/dex/agent', '/api/dex/order', '/api/dex/swap'],
  errorRateThreshold: 0.1, // 10%
};

// אחסון בזיכרון למדידות (ביישום אמיתי ישתמש ב-Redis או בסיס נתונים)
const requestMetrics: RequestMetrics[] = [];
const ipRequestCounts = new Map<string, number[]>();
const errorCounts = new Map<string, number>();

// פונקציות עזר לניטור
function isSensitivePath(path: string): boolean {
  return config.sensitivePaths.some(sensitivePath => path.includes(sensitivePath));
}

function detectSqlInjection(input: string): boolean {
  const sqlPatterns = [
    /(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|EXEC|CREATE|ALTER|GRANT|REVOKE)/i,
    /('|--|;|\*|\/\*|\*\/)/,
    /(\bOR\b|\bAND\b)\s+\d+\s*=\s*\d+/i
  ];
  return sqlPatterns.some(pattern => pattern.test(input));
}

function detectPathTraversal(input: string): boolean {
  const traversalPatterns = [/\.\./, /\\\\/];
  return traversalPatterns.some(pattern => pattern.test(input));
}

function detectAdminAccess(path: string): boolean {
  return path.includes('/admin') || path.includes('/internal');
}

// פונקציה לדיווח למערכות ניטור חיצוניות
function reportToMonitoringSystem(metrics: RequestMetrics): void {
  // ביישום אמיתי, כאן ישלח המידע ל-Prometheus, ELK, Datadog וכו'
  console.log('Reporting to monitoring system:', JSON.stringify(metrics));
  
  // לדוגמה: שליחה ל-Prometheus
  // prometheusCounter.inc({ path: metrics.path, errorType: metrics.errorType });
  
  // לדוגמה: שליחה ל-ELK
  // elkLogger.log('info', 'API request', { metrics });
}

// פונקציה לבדיקת דפוסי תקיפה
function detectAttackPatterns(req: NextRequest, path: string): ErrorType | null {
  const userAgent = req.headers.get('user-agent') || '';
  const ip = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
  
  // בדיקת דפוסי הזרקה
  if (isSensitivePath(path)) {
    const url = req.nextUrl.toString();
    const params = req.nextUrl.searchParams.toString();
    
    if (detectSqlInjection(url) || detectSqlInjection(params)) {
      return 'sql-injection';
    }
    
    if (detectPathTraversal(url) || detectPathTraversal(params)) {
      return 'path-traversal';
    }
    
    if (detectAdminAccess(path)) {
      return 'admin-access';
    }
    
    // בדיקת דפוסי התנהגור חשודים ב-user agent
    if (userAgent.includes('bot') || userAgent.includes('crawler') || userAgent.includes('spider')) {
      return 'injection-attempt';
    }
  }
  
  return null;
}

// פונקציה לבדיקת דפוסי תעבורה חריגים
function detectTrafficAnomalies(ip: string, path: string): ErrorType | null {
  const now = Date.now();
  
  // בדיקת burst
  const ipRequests = ipRequestCounts.get(ip) || [];
  const recentRequests = ipRequests.filter(time => now - time < config.burstWindowMs);
  
  if (recentRequests.length >= config.burstThreshold) {
    return 'burst';
  }
  
  // בדיקת עלייה חדה בתעבורה מ-IP
  if (isSensitivePath(path)) {
    const allIpRequests = Array.from(ipRequestCounts.values()).flat();
    const recentAllRequests = allIpRequests.filter(time => now - time < config.ipSpikeWindowMs);
    
    if (recentAllRequests.length >= config.ipSpikeThreshold) {
      return 'ip-spike';
    }
  }
  
  return null;
}

// פונקציה לחישוב שיעור שגיאות
function calculateErrorRate(): number {
  const totalRequests = requestMetrics.length;
  if (totalRequests === 0) return 0;
  
  const errorRequests = requestMetrics.filter(
    metric => metric.status && (metric.status >= 400 || metric.errorType)
  ).length;
  
  return errorRequests / totalRequests;
}

// פונקציה לניקוי מדידים ישנים
function cleanupOldMetrics(): void {
  const now = Date.now();
  const oldThreshold = now - config.ipSpikeWindowMs;
  
  // ניקוי מדידי IP
  for (const [ip, times] of ipRequestCounts.entries()) {
    const filteredTimes = times.filter(time => time > oldThreshold);
    if (filteredTimes.length === 0) {
      ipRequestCounts.delete(ip);
    } else {
      ipRequestCounts.set(ip, filteredTimes);
    }
  }
  
  // ניקוי מדידים כלליים
  const filteredMetrics = requestMetrics.filter(metric => metric.timestamp > oldThreshold);
  requestMetrics.length = 0;
  requestMetrics.push(...filteredMetrics);
}

// מודול ניטור התנהגותי
export class BehavioralMonitor {
  static recordRequest(req: NextRequest, response: NextResponse, responseTime: number): void {
    const path = req.nextUrl.pathname;
    const ip = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
    const userAgent = req.headers.get('user-agent') || '';
    const status = response.status;
    
    // זיהוי דפוסי תקיפה
    const attackPattern = detectAttackPatterns(req, path);
    
    // זיהוי תעבורה חריגה
    const trafficAnomaly = detectTrafficAnomalies(ip, path);
    
    // סיווג שגיאות
    let errorType: ErrorType | undefined;
    if (attackPattern) {
      errorType = attackPattern;
    } else if (trafficAnomaly) {
      errorType = trafficAnomaly;
    } else if (status && status >= 400) {
      errorType = status >= 500 ? '5xx' : '4xx';
    }
    
    // רישום המדידה
    const metric: RequestMetrics = {
      timestamp: Date.now(),
      ip,
      path,
      method: req.method,
      status,
      errorType,
      userAgent,
      responseTime
    };
    
    requestMetrics.push(metric);
    
    // עדכון ספירת IP
    const ipTimes = ipRequestCounts.get(ip) || [];
    ipTimes.push(metric.timestamp);
    ipRequestCounts.set(ip, ipTimes);
    
    // עדכון ספירת שגיאות
    if (errorType) {
      const currentCount = errorCounts.get(errorType) || 0;
      errorCounts.set(errorType, currentCount + 1);
    }
    
    // דיווח למערכות ניטור חיצוניות
    if (errorType) {
      reportToMonitoringSystem(metric);
    }
    
    // בדיקת שיעור שגיאות
    const errorRate = calculateErrorRate();
    if (errorRate > config.errorRateThreshold) {
      console.warn(`High error rate detected: ${(errorRate * 100).toFixed(2)}%`);
      // ביישום אמיתי, כאן ישלח התראה למערכת ניהול
    }
    
    // ניקוי מדידים ישנים מדי פעם
    if (requestMetrics.length % 100 === 0) {
      cleanupOldMetrics();
    }
  }
  
  static getMetrics(): RequestMetrics[] {
    return [...requestMetrics];
  }
  
  static getErrorCounts(): Map<string, number> {
    return new Map(errorCounts);
  }
}

// פונקציית עזר למדידת זמן תגובה
export function measureResponseTime(handler: (req: NextRequest) => Promise<NextResponse>) {
  return async (req: NextRequest): Promise<NextResponse> => {
    const startTime = Date.now();
    
    try {
      const response = await handler(req);
      const responseTime = Date.now() - startTime;
      
      // רישום המדידה
      BehavioralMonitor.recordRequest(req, response, responseTime);
      
      return response;
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const errorResponse = NextResponse.json(
        { error: 'Internal Server Error' },
        { status: 500 }
      );
      
      // רישום המדידה עם שגיאה
      BehavioralMonitor.recordRequest(req, errorResponse, responseTime);
      
      return errorResponse;
    }
  };
}
