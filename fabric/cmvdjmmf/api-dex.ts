import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

// ממשק לניטור נקודות API קריטיות
interface ApiMonitorLog {
  id: string;
  endpoint: string;
  method: string;
  ip: string;
  userAgent: string;
  timestamp: Date;
  parameters: Record<string, any>;
  riskScore: number;
  anomalies: string[];
}

// פונקציית עזר להערכת סיכון
function calculateRiskScore(params: Record<string, any>, userAgent: string): number {
  let score = 0;
  
  // בדיקת פרמטרים חשודים
  if (params.amount && params.amount > 100000) score += 3;
  if (params.price && params.price < 0.0001) score += 2;
  if (params.pair && params.pair.includes('UNKNOWN')) score += 5;
  
  // בדיקת User-Agent
  if (userAgent.includes('bot') || userAgent.includes('crawler')) score += 2;
  if (!userAgent || userAgent.length < 10) score += 1;
  
  // בדיקת תדירות (ניתן להרחיב)
  if (params.frequency && params.frequency > 100) score += 4;
  
  return score;
}

// פונקציית זיהוי חריגות
function detectAnomalies(params: Record<string, any>): string[] {
  const anomalies: string[] = [];
  
  // בדיקת פרמטרים לא חוקיים
  if (params.amount && (typeof params.amount !== 'number' || params.amount <= 0)) {
    anomalies.push('Invalid amount parameter');
  }
  
  if (params.price && (typeof params.price !== 'number' || params.price <= 0)) {
    anomalies.push('Invalid price parameter');
  }
  
  // בדיקת פורמט זיהוי
  if (params.account && !/^[a-z0-9.-]+$/.test(params.account)) {
    anomalies.push('Invalid account format');
  }
  
  // בדיקת תחום זמן חריג
  if (params.timeframe && (params.timeframe < 1 || params.timeframe > 1440)) {
    anomalies.push('Invalid timeframe parameter');
  }
  
  return anomalies;
}

// פונקציית לוגינג למאגר נתונים
async function logApiMonitor(log: Omit<ApiMonitorLog, 'id'>): Promise<void> {
  try {
    await db.apiMonitor.create({
      data: {
        endpoint: log.endpoint,
        method: log.method,
        ip: log.ip,
        userAgent: log.userAgent,
        timestamp: log.timestamp,
        parameters: JSON.stringify(log.parameters),
        riskScore: log.riskScore,
        anomalies: JSON.stringify(log.anomalies),
      },
    });
  } catch (error) {
    console.error('Failed to log API monitor:', error);
  }
}

// מידלוור ניטור עבור נקודות API קריטיות
export async function apiMonitorMiddleware(req: NextRequest): Promise<NextResponse | null> {
  const criticalEndpoints = ['/api/dex/agent', '/api/dex/order', '/api/dex/swap'];
  const { pathname } = req.nextUrl;
  
  if (!criticalEndpoints.some(endpoint => pathname.includes(endpoint))) {
    return null; // לא נקודת API קריטית, המשך כרגיל
  }
  
  const method = req.method;
  const ip = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
  const userAgent = req.headers.get('user-agent') || 'unknown';
  
  try {
    // קריאת גוף הבקשה לפרסור פרמטרים
    const body = await req.clone().json().catch(() => ({}));
    const queryParams = Object.fromEntries(req.nextUrl.searchParams.entries());
    const parameters = { ...queryParams, ...body };
    
    // חישוב סיכון וזיהוי חריגות
    const riskScore = calculateRiskScore(parameters, userAgent);
    const anomalies = detectAnomalies(parameters);
    
    // לוגינג למאגר נתונים
    await logApiMonitor({
      endpoint: pathname,
      method,
      ip,
      userAgent,
      timestamp: new Date(),
      parameters,
      riskScore,
      anomalies,
    });
    
    // התראות עבור פעילות חריגה
    if (riskScore >= 7) {
      console.warn(`High-risk API call detected: ${method} ${pathname} from ${ip}`);
      // כאן ניתן להוסיף התראות חיצוניות (Slack, Email, etc.)
    }
    
    if (anomalies.length > 0) {
      console.warn(`API anomalies detected: ${anomalies.join(', ')}`);
    }
    
    // חסימת בקשות עם סיכון גבוה מאוד
    if (riskScore >= 10) {
      return NextResponse.json(
        { error: 'Request blocked due to high risk score' },
        { status: 403 }
      );
    }
    
    return null; // המשך עיבוד הבקשה
  } catch (error) {
    console.error('API monitor middleware error:', error);
    return null;
  }
}

// פונקציית סטטיסטיקות לניטור
export async function getApiMonitorStats() {
  try {
    const stats = await db.apiMonitor.groupBy({
      by: ['endpoint'],
      _count: { id: true },
      _avg: { riskScore: true },
      _max: { riskScore: true },
      where: {
        timestamp: {
          gte: new Date(Date.now() - 24 * 60 * 60 * 1000), // 24 שעות אחורה
        },
      },
      orderBy: {
        _count: {
          id: 'desc',
        },
      },
    });
    
    return stats;
  } catch (error) {
    console.error('Failed to fetch API monitor stats:', error);
    return [];
  }
}

// פונקציית ניקוי יומן ישן
export async function cleanupApiMonitorLogs() {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    
    const result = await db.apiMonitor.deleteMany({
      where: {
        timestamp: {
          lt: thirtyDaysAgo,
        },
      },
    });
    
    console.log(`Cleaned up ${result.count} old API monitor logs`);
    return result.count;
  } catch (error) {
    console.error('Failed to cleanup API monitor logs:', error);
    return 0;
  }
}