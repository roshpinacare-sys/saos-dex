import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

// טיפוסים עבור ניטור API
interface ApiLog {
  id: number;
  endpoint: string;
  method: string;
  ip: string;
  userAgent: string;
  timestamp: Date;
  requestBody: string;
  responseBody: string;
  statusCode: number;
  responseTime: number;
  userId?: string;
  riskScore: number;
}

interface SuspiciousPattern {
  endpoint: string;
  ip: string;
  pattern: string;
  count: number;
  lastSeen: Date;
}

// ממשק לפעולות API
interface ApiOperation {
  requiresAuth: boolean;
  allowedMethods: string[];
  riskLevel: 'low' | 'medium' | 'high';
  rateLimit: number;
}

// הגדרת רמות הרשאות לפי נקודות API
const API_PERMISSIONS: Record<string, ApiOperation> = {
  '/api/dex/agent': {
    requiresAuth: true,
    allowedMethods: ['GET', 'POST'],
    riskLevel: 'high',
    rateLimit: 10
  },
  '/api/dex/order': {
    requiresAuth: true,
    allowedMethods: ['POST', 'DELETE'],
    riskLevel: 'high',
    rateLimit: 20
  },
  '/api/dex/swap': {
    requiresAuth: true,
    allowedMethods: ['POST'],
    riskLevel: 'high',
    rateLimit: 15
  }
};

// פונקציית עזר לזיהוי IP
function getClientIp(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const ips = xff.split(',').map(ip => ip.trim()).filter(Boolean);
    return ips[ips.length - 1] || 'unknown';
  }
  return req.headers.get('x-real-ip') || 'unknown';
}

// חישוב ציון סיכון לבקשה
function calculateRiskScore(req: NextRequest, endpoint: string): number {
  let score = 0;
  
  // בדיקת רמת הסיכון של ה-endpoint
  const operation = API_PERMISSIONS[endpoint];
  if (operation) {
    if (operation.riskLevel === 'high') score += 3;
    else if (operation.riskLevel === 'medium') score += 2;
    else score += 1;
  }
  
  // בדיקת כותרות חשודות
  const userAgent = req.headers.get('user-agent') || '';
  if (!userAgent || userAgent.includes('bot') || userAgent.includes('crawler')) {
    score += 2;
  }
  
  // בדיקת גודל בקשה
  const contentLength = req.headers.get('content-length');
  if (contentLength && parseInt(contentLength) > 1024 * 10) { // > 10KB
    score += 1;
  }
  
  return score;
}

// בדיקת דפוס בקשות חשודות
async function checkSuspiciousPatterns(ip: string, endpoint: string): Promise<SuspiciousPattern | null> {
  try {
    // בדיקה במסד הנתונים אם יש דפוס חשוד
    const recentRequests = await db.apiLog.findMany({
      where: {
        ip,
        endpoint,
        timestamp: {
          gte: new Date(Date.now() - 60 * 60 * 1000) // שעה אחרונה
        }
      },
      orderBy: { timestamp: 'desc' }
    });
    
    if (recentRequests.length > 50) { // יותר מ-50 בקשות בשעה
      return {
        endpoint,
        ip,
        pattern: 'high-frequency',
        count: recentRequests.length,
        lastSeen: new Date()
      };
    }
    
    // בדיקת ניסיונות חוזרים עם פרמטרים דומים
    const similarRequests = recentRequests.filter(req => {
      // כאן ניתן להוסיף לוגיקה מתוחכמת יותר לזיהוי דפוסים
      return true; // פשוט לדוגמה
    });
    
    if (similarRequests.length > 20) {
      return {
        endpoint,
        ip,
        pattern: 'repeated-similar',
        count: similarRequests.length,
        lastSeen: new Date()
      };
    }
    
    return null;
  } catch (error) {
    console.error('Error checking suspicious patterns:', error);
    return null;
  }
}

// פונקציית מידלוור עבור ניטור API
export async function apiMonitoringMiddleware(req: NextRequest): Promise<NextResponse | null> {
  const startTime = Date.now();
  const { pathname } = req.nextUrl;
  const ip = getClientIp(req);
  const userAgent = req.headers.get('user-agent') || '';
  
  // בדיקה אם ה-endpoint דורש ניטור
  const monitoredEndpoints = Object.keys(API_PERMISSIONS);
  const isMonitored = monitoredEndpoints.some(endpoint => pathname.startsWith(endpoint));
  
  if (!isMonitored) {
    return null; // לא לעשות כלום אם זה לא endpoint מנוטר
  }
  
  const endpoint = monitoredEndpoints.find(e => pathname.startsWith(e)) || pathname;
  const operation = API_PERMISSIONS[endpoint];
  
  // בדיקת תקינות מתודה
  if (!operation.allowedMethods.includes(req.method)) {
    return NextResponse.json(
      { error: 'Method not allowed' },
      { status: 405 }
    );
  }
  
  // בדיקת הרשאות
  if (operation.requiresAuth) {
    // כאן יש להוסיף לוגיקת אימות ממשית
    // לדוגמה: const user = await authenticateUser(req);
    // if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  
  // חישוב ציון סיכון
  const riskScore = calculateRiskScore(req, endpoint);
  
  // בדיקת דפוסים חשודים
  const suspiciousPattern = await checkSuspiciousPatterns(ip, endpoint);
  
  // רישום הבקשה
  try {
    // קריאה ל-body בצורה סינכרונית לצורך רישום
    const clonedReq = req.clone();
    const requestBody = await clonedReq.text();
    
    // שמירה במסד הנתונים
    await db.apiLog.create({
      data: {
        endpoint,
        method: req.method,
        ip,
        userAgent,
        timestamp: new Date(),
        requestBody,
        responseBody: '', // יעודכן אחרי קבלת התגובה
        statusCode: 0, // יעודכן אחרי קבלת התגובה
        responseTime: 0, // יעודכן אחרי קבלת התגובה
        riskScore
      }
    });
  } catch (error) {
    console.error('Error logging request:', error);
  }
  
  // המשך לטיפול בבקשה
  const res = NextResponse.next();
  
  // טיפול בתגובה
  const originalRes = res;
  const responseBody: string[] = [];
  
  // החלפת ה-body כדי לתעד אותו
  const newRes = new Proxy(originalRes, {
    get(target, prop, receiver) {
      if (prop === 'text') {
        return async () => {
          const body = await Reflect.apply(target.text, target, []);
          responseBody.push(body);
          return body;
        };
      }
      return Reflect.get(target, prop, receiver);
    }
  });
  
  // חישוב זמן תגובה
  const responseTime = Date.now() - startTime;
  
  // עדכון רישום ה-API עם נתוני התגובה
  try {
    await db.apiLog.updateMany({
      where: {
        ip,
        endpoint,
        timestamp: {
          gte: new Date(startTime - 1000) // בטווח של שנייה אחרי הבקשה
        }
      },
      data: {
        responseBody: responseBody.join(''),
        statusCode: newRes.status,
        responseTime
      }
    });
  } catch (error) {
    console.error('Error updating response log:', error);
  }
  
  // התראות עבור פעילות חריגה
  if (suspiciousPattern) {
    console.warn(`Suspicious pattern detected: ${suspiciousPattern.pattern} from ${ip} on ${endpoint}`);
    
    // כאן ניתן להוסיף לוגיקה לשליחת התראות
    // לדוגמה: sendAlert(suspiciousPattern);
  }
  
  if (riskScore > 5) {
    console.warn(`High risk score: ${riskScore} for request from ${ip} on ${endpoint}`);
    
    // כאן ניתן להוסיף לוגיקה לטיפול בבקשות בסיכון גבוה
    // לדוגמה: additionalVerification(req);
  }
  
  return newRes;
}

// פונקציית עזר להחלת המידלוור על נקודות API מסוימות
export function applyApiMonitoring(req: NextRequest): NextResponse | null {
  const { pathname } = req.nextUrl;
  
  // החלת המידלוור רק על נקודות API קריטיות
  if (pathname.startsWith('/api/dex/agent') || 
      pathname.startsWith('/api/dex/order') || 
      pathname.startsWith('/api/dex/swap')) {
    return apiMonitoringMiddleware(req);
  }
  
  return null; // לא להחיל על נקודות API אחרות
}
