import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { z } from 'zod';

// סכמת ולידציה לנתוני התראה
const AlertSchema = z.object({
  type: z.enum(['api_spike', 'repeated_ip', 'protected_access', 'critical_function']),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  sourceIp: z.string().ip(),
  endpoint: z.string(),
  timestamp: z.string().datetime(),
  details: z.object({}).optional(),
});

type AlertData = z.infer<typeof AlertSchema>;

// מנגנון ניטור ורישום פעילות בזמן אמת
class ActivityMonitor {
  private recentRequests = new Map<string, { count: number; firstSeen: number }>();
  private alertThresholds = {
    apiSpike: 100, // בקשות לדקה
    repeatedIp: 50, // ניסיונות מאותה IP
    protectedEndpoint: 10, // ניסיונות לנתיב מוגן
  };

  // רישום בקשה חדשה
  logRequest(req: NextRequest) {
    const ip = this.getClientIp(req);
    const endpoint = req.nextUrl.pathname;
    const now = Date.now();
    
    // עדכון סטטיסטיקות
    if (!this.recentRequests.has(ip)) {
      this.recentRequests.set(ip, { count: 1, firstSeen: now });
    } else {
      const entry = this.recentRequests.get(ip)!;
      entry.count += 1;
    }
    
    // בדיקת אנומליות
    this.checkForAnomalies(ip, endpoint, now);
  }

  // קבלת IP לקוח
  private getClientIp(req: NextRequest): string {
    const xff = req.headers.get('x-forwarded-for');
    if (xff) {
      const ips = xff.split(',').map(ip => ip.trim()).filter(Boolean);
      return ips[ips.length - 1] || 'unknown';
    }
    return req.headers.get('x-real-ip') || 'unknown';
  }

  // בדיקת אנומליות
  private checkForAnomalies(ip: string, endpoint: string, timestamp: number) {
    const entry = this.recentRequests.get(ip);
    if (!entry) return;
    
    // בדיקת עלייה חדה בבקשות
    if (entry.count > this.alertThresholds.apiSpike) {
      this.createAlert({
        type: 'api_spike',
        severity: 'high',
        sourceIp: ip,
        endpoint,
        timestamp: new Date(timestamp).toISOString(),
        details: { requestCount: entry.count }
      });
    }
    
    // בדיקת ניסיונות חוזרים
    if (entry.count > this.alertThresholds.repeatedIp) {
      this.createAlert({
        type: 'repeated_ip',
        severity: 'medium',
        sourceIp: ip,
        endpoint,
        timestamp: new Date(timestamp).toISOString(),
        details: { requestCount: entry.count }
      });
    }
    
    // בדיקת ניסיונות לנתיבים מוגנים
    const protectedEndpoints = ['/api/dex/order', '/api/dex/swap', '/api/dex/portfolio'];
    if (protectedEndpoints.some(path => endpoint.includes(path)) && entry.count > this.alertThresholds.protectedEndpoint) {
      this.createAlert({
        type: 'protected_access',
        severity: 'high',
        sourceIp: ip,
        endpoint,
        timestamp: new Date(timestamp).toISOString(),
        details: { requestCount: entry.count }
      });
    }
  }

  // יצירת התראה
  private async createAlert(alertData: AlertData) {
    try {
      // ולידציה נוספת
      const validatedData = AlertSchema.parse(alertData);
      
      // שמירה במסד הנתונים
      await db.alert.create({
        data: {
          ...validatedData,
          processed: false,
        }
      });
      
      // שליחת התראה בזמן אמת (כאן ניתן להוסיף שליחת דואר/נוטיפיקציה)
      this.sendAlertNotification(validatedData);
      
      // ניקוי ישן
      this.cleanupOldEntries();
    } catch (error) {
      console.error('Failed to create alert:', error);
    }
  }

  // שליחת התראה
  private sendAlertNotification(alert: AlertData) {
    // כאן יישום שליחת התראות למערכות חיצוניות
    // לדוגמה: שליחת דואר אלקטרוני, נוטיפיקציות לסלאק, וכו'
    console.log(`ALERT [${alert.severity}]: ${alert.type} from ${alert.sourceIp}`);
  }

  // ניקוי רשומות ישנות
  private cleanupOldEntries() {
    const now = Date.now();
    const maxAge = 60 * 60 * 1000; // שעה אחת
    
    for (const [ip, entry] of this.recentRequests.entries()) {
      if (now - entry.firstSeen > maxAge) {
        this.recentRequests.delete(ip);
      }
    }
  }
}

// יצירת אינסטנס גלובלי
const activityMonitor = new ActivityMonitor();

// API להגדרת מדיניות ניטור
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    // עדכון ספי התראה
    if (body.thresholds) {
      activityMonitor['alertThresholds'] = {
        ...activityMonitor['alertThresholds'],
        ...body.thresholds
      };
      
      return NextResponse.json({ success: true, message: 'Thresholds updated' });
    }
    
    // קבלת דוחות
    if (body.report) {
      const { startDate, endDate } = body.report;
      
      const alerts = await db.alert.findMany({
        where: {
          timestamp: {
            gte: new Date(startDate),
            lte: new Date(endDate)
          }
        },
        orderBy: { timestamp: 'desc' }
      });
      
      return NextResponse.json({ alerts });
    }
    
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}

// מידלוור לניטור כל בקשה
export function middleware(req: NextRequest) {
  // דילוג על נתיבים פנימיים
  if (req.nextUrl.pathname.startsWith('/_next') || 
      req.nextUrl.pathname.startsWith('/api/monitoring')) {
    return NextResponse.next();
  }
  
  // רישום הבקשה
  activityMonitor.logRequest(req);
  
  // המשך לבקשה הרגילה
  return NextResponse.next();
}

// ייצוא המוניטור לשימוש באפליקציה
export { activityMonitor };
