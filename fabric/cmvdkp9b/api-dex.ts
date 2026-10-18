import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { startOfDay, endOfDay } from 'date-fns';

// ממשקים למערכת הניטור
interface AlertPayload {
  endpoint: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  metadata: Record<string, any>;
  timestamp: string;
}

interface ActivityMetrics {
  requestCount: number;
  errorRate: number;
  uniqueIPs: number;
  avgResponseTime: number;
  suspiciousPatterns: {
    rapidRequests: boolean;
    repeatedFailures: boolean;
    suspiciousIPs: boolean;
  };
}

// מדדים ספציפיים לכל נקודת API
const API_THRESHOLDS = {
  '/api/dex/agent': {
    maxRequestsPerMinute: 100,
    maxErrorRate: 0.1,
    maxUniqueIPs: 20,
    maxAvgResponseTime: 500, // ms
    suspiciousPatternThresholds: {
      rapidRequests: 50,
      repeatedFailures: 10,
      suspiciousIPs: 5
    }
  },
  '/api/dex/order': {
    maxRequestsPerMinute: 200,
    maxErrorRate: 0.15,
    maxUniqueIPs: 30,
    maxAvgResponseTime: 800,
    suspiciousPatternThresholds: {
      rapidRequests: 100,
      repeatedFailures: 20,
      suspiciousIPs: 10
    }
  },
  '/api/dex/swap': {
    maxRequestsPerMinute: 150,
    maxErrorRate: 0.2,
    maxUniqueIPs: 25,
    maxAvgResponseTime: 1000,
    suspiciousPatternThresholds: {
      rapidRequests: 75,
      repeatedFailures: 15,
      suspiciousIPs: 8
    }
  }
};

// פונקציית עזר לזיהוי IP
function getClientIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  );
}

// פונקציית עזר לניטור פעילות
async function monitorActivity(
  endpoint: string,
  request: NextRequest,
  response: NextResponse,
  startTime: number
): Promise<ActivityMetrics> {
  const endTime = Date.now();
  const responseTime = endTime - startTime;
  const ip = getClientIp(request);
  
  // קבלת נתונים מהמסד נתונים
  const oneMinuteAgo = new Date(endTime - 60 * 1000);
  
  // ניתוח פעילות בדקה האחרונה
  const recentActivity = await db.dexActivity.findMany({
    where: {
      endpoint,
      timestamp: {
        gte: oneMinuteAgo
      }
    }
  });
  
  // חישוב מדדים
  const requestCount = recentActivity.length;
  const errorCount = recentActivity.filter(a => a.status >= 400).length;
  const errorRate = requestCount > 0 ? errorCount / requestCount : 0;
  
  // זיהוי IP ייחודיים
  const uniqueIPs = new Set(recentActivity.map(a => a.ip)).size;
  
  // חישוב זמן תגובה ממוצע
  const totalResponseTime = recentActivity.reduce((sum, a) => sum + a.responseTime, 0);
  const avgResponseTime = requestCount > 0 ? totalResponseTime / requestCount : 0;
  
  // זיהוי דפוסים חשודים
  const rapidRequests = requestCount > API_THRESHOLDS[endpoint].suspiciousPatternThresholds.rapidRequests;
  
  // בדיקת ניסיונות חוזרים כושלים
  const failedRequests = recentActivity.filter(a => a.status >= 400);
  const repeatedFailures = failedRequests.length > API_THRESHOLDS[endpoint].suspiciousPatternThresholds.repeatedFailures;
  
  // בדיקת IP חשודים (הרבה בקשות מאותו IP)
  const ipCounts = new Map<string, number>();
  recentActivity.forEach(a => {
    ipCounts.set(a.ip, (ipCounts.get(a.ip) || 0) + 1);
  });
  
  const suspiciousIPs = Array.from(ipCounts.entries()).some(
    ([_, count]) => count > API_THRESHOLDS[endpoint].suspiciousPatternThresholds.suspiciousIPs
  );
  
  // שמירת פעילות נוכחית
  await db.dexActivity.create({
    data: {
      endpoint,
      ip,
      method: request.method,
      status: response.status,
      responseTime,
      userAgent: request.headers.get('user-agent') || '',
      timestamp: new Date()
    }
  });
  
  return {
    requestCount,
    errorRate,
    uniqueIPs,
    avgResponseTime,
    suspiciousPatterns: {
      rapidRequests,
      repeatedFailures,
      suspiciousIPs
    }
  };
}

// פונקציית התראה
async function sendAlert(payload: AlertPayload): Promise<void> {
  try {
    // שליחת התראה למערכת המרכזית
    await fetch(`${process.env.SAOS_CONTROL_CENTER_URL}/api/alerts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SAOS_CONTROL_CENTER_API_KEY}`
      },
      body: JSON.stringify(payload)
    });
    
    // רישום ההתראה במסד הנתונים
    await db.alert.create({
      data: {
        endpoint: payload.endpoint,
        severity: payload.severity,
        message: payload.message,
        metadata: payload.metadata,
        timestamp: new Date(payload.timestamp)
      }
    });
    
    console.log(`Alert sent for ${payload.endpoint}: ${payload.message}`);
  } catch (error) {
    console.error('Failed to send alert:', error);
    // רישום כשלון במסד הנתונים
    await db.alert.create({
      data: {
        endpoint: payload.endpoint,
        severity: 'critical',
        message: `Failed to send alert: ${(error as Error).message}`,
        metadata: { originalPayload: payload },
        timestamp: new Date()
      }
    });
  }
}

// פונקציית בדיקת סף ושליחת התראה
function checkThresholdsAndAlert(
  endpoint: string,
  metrics: ActivityMetrics
): void {
  const thresholds = API_THRESHOLDS[endpoint];
  
  // בדיקת ספים וקביעת רמת חומרה
  if (metrics.requestCount > thresholds.maxRequestsPerMinute) {
    sendAlert({
      endpoint,
      severity: 'high',
      message: 'High request volume detected',
      metadata: {
        requestCount: metrics.requestCount,
        threshold: thresholds.maxRequestsPerMinute,
        uniqueIPs: metrics.uniqueIPs
      },
      timestamp: new Date().toISOString()
    });
  }
  
  if (metrics.errorRate > thresholds.maxErrorRate) {
    sendAlert({
      endpoint,
      severity: 'medium',
      message: 'High error rate detected',
      metadata: {
        errorRate: metrics.errorRate,
        threshold: thresholds.maxErrorRate,
        errorCount: Math.floor(metrics.errorRate * metrics.requestCount)
      },
      timestamp: new Date().toISOString()
    });
  }
  
  if (metrics.uniqueIPs > thresholds.maxUniqueIPs) {
    sendAlert({
      endpoint,
      severity: 'medium',
      message: 'High number of unique IPs',
      metadata: {
        uniqueIPs: metrics.uniqueIPs,
        threshold: thresholds.maxUniqueIPs
      },
      timestamp: new Date().toISOString()
    });
  }
  
  if (metrics.avgResponseTime > thresholds.maxAvgResponseTime) {
    sendAlert({
      endpoint,
      severity: 'low',
      message: 'High average response time',
      metadata: {
        avgResponseTime: metrics.avgResponseTime,
        threshold: thresholds.maxAvgResponseTime
      },
      timestamp: new Date().toISOString()
    });
  }
  
  // בדיקת דפוסים חשודים
  if (metrics.suspiciousPatterns.rapidRequests) {
    sendAlert({
      endpoint,
      severity: 'high',
      message: 'Rapid request pattern detected',
      metadata: {
        pattern: 'rapid_requests',
        requestCount: metrics.requestCount
      },
      timestamp: new Date().toISOString()
    });
  }
  
  if (metrics.suspiciousPatterns.repeatedFailures) {
    sendAlert({
      endpoint,
      severity: 'medium',
      message: 'Repeated failure pattern detected',
      metadata: {
        pattern: 'repeated_failures',
        errorCount: Math.floor(metrics.errorRate * metrics.requestCount)
      },
      timestamp: new Date().toISOString()
    });
  }
  
  if (metrics.suspiciousPatterns.suspiciousIPs) {
    sendAlert({
      endpoint,
      severity: 'high',
      message: 'Suspicious IP pattern detected',
      metadata: {
        pattern: 'suspicious_ips',
        uniqueIPs: metrics.uniqueIPs
      },
      timestamp: new Date().toISOString()
    });
  }
}

// מידלוור ניטור עבור נקודות API קריטיות
export function withMonitoring(endpoint: string) {
  return async (req: NextRequest, handler: () => Promise<NextResponse>) => {
    const startTime = Date.now();
    let response: NextResponse;
    
    try {
      response = await handler();
    } catch (error) {
      response = NextResponse.json(
        { error: 'Internal server error' },
        { status: 500 }
      );
    }
    
    // ניטור פעילות
    const metrics = await monitorActivity(endpoint, req, response, startTime);
    
    // בדיקת ספים ושליחת התראות
    checkThresholdsAndAlert(endpoint, metrics);
    
    return response;
  };
}

// API route לדיווח על מצב המערכת
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const endpoint = searchParams.get('endpoint');
    
    if (!endpoint || !API_THRESHOLDS[endpoint]) {
      return NextResponse.json(
        { error: 'Invalid or missing endpoint parameter' },
        { status: 400 }
      );
    }
    
    // קבלת נתונים מהדקה האחרונה
    const oneMinuteAgo = startOfDay(new Date());
    const now = endOfDay(new Date());
    
    const activity = await db.dexActivity.findMany({
      where: {
        endpoint,
        timestamp: {
          gte: oneMinuteAgo,
          lte: now
        }
      },
      orderBy: {
        timestamp: 'desc'
      }
    });
    
    // חישוב מדדים
    const requestCount = activity.length;
    const errorCount = activity.filter(a => a.status >= 400).length;
    const errorRate = requestCount > 0 ? errorCount / requestCount : 0;
    
    const uniqueIPs = new Set(activity.map(a => a.ip)).size;
    
    const totalResponseTime = activity.reduce((sum, a) => sum + a.responseTime, 0);
    const avgResponseTime = requestCount > 0 ? totalResponseTime / requestCount : 0;
    
    // קבלת התראות אחרונות
    const alerts = await db.alert.findMany({
      where: {
        endpoint,
        timestamp: {
          gte: oneMinuteAgo,
          lte: now
        }
      },
      orderBy: {
        timestamp: 'desc'
      },
      take: 10
    });
    
    return NextResponse.json({
      endpoint,
      metrics: {
        requestCount,
        errorRate,
        uniqueIPs,
        avgResponseTime,
        thresholds: API_THRESHOLDS[endpoint]
      },
      alerts,
      status: 'ok'
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch monitoring data', details: (error as Error).message },
      { status: 500 }
    );
  }
}
