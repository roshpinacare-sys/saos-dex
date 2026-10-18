import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

type SecurityLog = {
  id: number;
  timestamp: Date;
  ip: string;
  userAgent: string;
  resource: string;
  action: string;
  severity: 'info' | 'warning' | 'critical';
  details: Record<string, unknown>;
};

type AnomalyPolicy = {
  threshold: number;
  timeWindow: number; // in seconds
  severity: 'warning' | 'critical';
};

// מדיניות זיהוי חריגות
const anomalyPolicies: AnomalyPolicy[] = [
  { threshold: 50, timeWindow: 60, severity: 'warning' }, // 50+ requests in 60 seconds
  { threshold: 100, timeWindow: 30, severity: 'critical' }, // 100+ requests in 30 seconds
];

// מאחסן זמני לניטור גישות (ביישום מציאי יש להחליף במסד נתונים)
const accessTracker = new Map<string, {
  count: number;
  firstAccess: number;
  lastAccess: number;
}>();

/**
 * רישום אירוע אבטחה
 * @param ip כתובת IP של המשתמש
 * @param userAgent כתובת ה-agent של המשתמש
 * @param המשאב שאליו ניסה לגשת
 * @param הפעולה שניסה לבצע
 * @param רמת חומרה
 * @param פרטים נוספים
 */
export async function logSecurityEvent(
  ip: string,
  userAgent: string,
  resource: string,
  action: string,
  severity: 'info' | 'warning' | 'critical',
  details: Record<string, unknown> = {}
): Promise<void> {
  try {
    // ביישום מציאי יש לשמור במסד הנתונים
    const logEntry: SecurityLog = {
      id: Date.now(),
      timestamp: new Date(),
      ip,
      userAgent,
      resource,
      action,
      severity,
      details
    };

    console.log('[SECURITY LOG]', logEntry);

    // שמירה במסד הנתונים (ביישום מציאי)
    // await db.securityLog.create({
    //   data: {
    //     timestamp: logEntry.timestamp,
    //     ip: logEntry.ip,
    //     userAgent: logEntry.userAgent,
    //     resource: logEntry.resource,
    //     action: logEntry.action,
    //     severity: logEntry.severity,
    //     details: logEntry.details
    //   }
    // });
  } catch (error) {
    console.error('[SECURITY LOG ERROR]', error);
  }
}

/**
 * בדיקת חריגות בפעילות
 * @param ip כתובת IP לבדיקה
 * @param רשימת חריגות שזוהו
 */
export function checkAnomalies(ip: string): { anomaly: true; severity: 'warning' | 'critical' } | { anomaly: false } {
  const now = Date.now();
  const ipData = accessTracker.get(ip);

  if (!ipData) return { anomaly: false };

  // ניקוי רשומות ישנות
  for (const [key, data] of accessTracker.entries()) {
    if (now - data.lastAccess > 300000) { // 5 דקות
      accessTracker.delete(key);
    }
  }

  // בדיקת חריגות לפי מדיניות
  for (const policy of anomalyPolicies) {
    const timeWindowStart = now - (policy.timeWindow * 1000);
    
    if (ipData.firstAccess >= timeWindowStart) {
      if (ipData.count >= policy.threshold) {
        return { anomaly: true, severity: policy.severity };
      }
    }
  }

  return { anomaly: false };
}

/**
 * ממשק התראה לאירועי חריגה
 * @param התראה לשליחה
 */
export async function sendAlert(
  message: string,
  severity: 'warning' | 'critical',
  details: Record<string, unknown> = {}
): Promise<void> {
  // ביישום מציאי כאן ישלח התראה למערכת ניטור (Slack, email, וכו')
  console.log(`[${severity.toUpperCase()} ALERT]`, message, details);

  // שמירה במסד הנתונים
  // await db.alert.create({
  //   data: {
  //     message,
  //     severity,
  //     timestamp: new Date(),
  //     details
  //   }
  // });
}

/**
 * מידלוור לניטור גישה למשאבי ה-dex
 */
export async function dexAccessMiddleware(req: NextRequest): Promise<NextResponse | null> {
  const { pathname } = req.nextUrl;
  const ip = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
  const userAgent = req.headers.get('user-agent') || 'unknown';

  // דילוג על ניטור עבור משאבים פנימיים
  if (pathname.startsWith('/_next') || pathname.startsWith('/static')) {
    return null;
  }

  // רישום גישה
  const now = Date.now();
  const ipData = accessTracker.get(ip) || { count: 0, firstAccess: now, lastAccess: now };
  ipData.count += 1;
  ipData.lastAccess = now;
  accessTracker.set(ip, ipData);

  // בדיקת חריגות
  const anomalyResult = checkAnomalies(ip);
  if (anomalyResult.anomaly) {
    const alertMessage = `חריגה בגישה למערכת - IP: ${ip}, משאב: ${pathname}`;
    
    // רישום האירוע
    await logSecurityEvent(
      ip,
      userAgent,
      pathname,
      'access_attempt',
      anomalyResult.severity,
      { anomaly: true, count: ipData.count }
    );
    
    // שליחת התראה
    await sendAlert(
      alertMessage,
      anomalyResult.severity,
      { ip, userAgent, resource: pathname, accessCount: ipData.count }
    );

    // ניתן להוסיף כאן פעולות נוספות כמו חסימת IP
    // if (anomalyResult.severity === 'critical') {
    //   await blockIp(ip);
    // }
  }

  return null;
}

/**
 * API endpoint לקבלת דוחות אבטחה
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ip = searchParams.get('ip');
  const since = searchParams.get('since');

  try {
    // ביישום מציאי יש לשלוף נתונים ממסד הנתונים
    // const logs = await db.securityLog.findMany({
    //   where: {
    //     ...(ip && { ip }),
    //     ...(since && { timestamp: { gte: new Date(since) } })
    //   },
    //   orderBy: { timestamp: 'desc' }
    // });

    // דוח דמה לצורך הדגמה
    const logs = [
      {
        id: 1,
        timestamp: new Date().toISOString(),
        ip: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
        resource: '/api/dex/orders',
        action: 'GET',
        severity: 'info',
        details: {}
      }
    ];

    return NextResponse.json({ logs });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch security logs' }, { status: 500 });
  }
}

/**
 * API endpoint להגדרת מדיניות זיהוי חריגות
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    
    // בדיקת הרשאות (ביישום מציאי)
    // if (!isAdmin(request)) {
    //   return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    // }

    // עדכון מדיניות
    anomalyPolicies.push({
      threshold: body.threshold,
      timeWindow: body.timeWindow,
      severity: body.severity
    });

    return NextResponse.json({ message: 'Policy updated successfully' });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to update policy' }, { status: 500 });
  }
}