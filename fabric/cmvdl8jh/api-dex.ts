import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

type LogEntry = {
  id: number;
  timestamp: Date;
  ip: string;
  method: string;
  path: string;
  userAgent: string | null;
  statusCode: number;
  responseSize: number;
  suspicious: boolean;
  threatType: string | null;
};

// פונקציית עזר להצפנת IP (לפרטיות)
function anonymizeIp(ip: string): string {
  const parts = ip.split('.');
  if (parts.length === 4) {
    parts[0] = '0';
    parts[1] = '0';
    return parts.join('.');
  }
  return 'unknown';
}

// פונקציית זיהוי דפוסי תקיפה
function detectThreat(req: NextRequest, path: string, ip: string): { suspicious: boolean; threatType: string | null } {
  const suspiciousMethods = ['POST', 'PUT', 'DELETE'];
  const suspiciousPaths = [
    '/api/dex/admin',
    '/api/dex/internal',
    '/api/dex/debug',
    '/api/dex/config',
    '/api/dex/backup',
    '/.env',
    '/wp-admin',
    '/phpmyadmin'
  ];

  // בדיקת נתיבים חשודים
  if (suspiciousPaths.some(suspPath => path.includes(suspPath))) {
    return { suspicious: true, threatType: 'suspicious-path' };
  }

  // בדיקת מתודות חשודות על נתיבים רגילים
  if (suspiciousMethods.includes(req.method) && path.includes('/api/dex/')) {
    return { suspicious: true, threatType: 'suspicious-method' };
  }

  // בדיקת ניסיונות SQL injection
  const sqlInjectionPatterns = [
    /('|--|\*|\/\*|\*\/|;|\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|EXEC)\b)/i,
    /(=|\||\&|\%|\#|\@|\!|\?|\<|\>)/
  ];
  
  const url = req.nextUrl.toString();
  const searchParams = req.nextUrl.searchParams.toString();
  
  if (sqlInjectionPatterns.some(pattern => pattern.test(url) || pattern.test(searchParams))) {
    return { suspicious: true, threatType: 'sql-injection-attempt' };
  }

  // בדיקת ניסיונות XSS
  const xssPatterns = [
    /(<script|javascript:|vbscript:|onload=|onerror=)/i,
    /(document\.|window\.|eval\(|alert\()/i
  ];
  
  const headers = req.headers;
  const userAgent = headers.get('user-agent') || '';
  const referer = headers.get('referer') || '';
  
  if (xssPatterns.some(pattern => pattern.test(url) || pattern.test(userAgent) || pattern.test(referer))) {
    return { suspicious: true, threatType: 'xss-attempt' };
  }

  return { suspicious: false, threatType: null };
}

// פונקציית בדיקת קצב בקשות
async function checkRateLimit(ip: string): Promise<boolean> {
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  
  try {
    const count = await db.apiLog.count({
      where: {
        ip: anonymizeIp(ip),
        timestamp: {
          gte: fiveMinutesAgo
        }
      }
    });
    
    // אם יותר מ-100 בקשות ב-5 דקות
    return count > 100;
  } catch (error) {
    console.error('Rate limit check failed:', error);
    return false;
  }
}

// פונקציית שליחת התראה
async function sendAlert(threatType: string, ip: string, path: string, method: string): Promise<void> {
  try {
    // כאן יש להחליף בURL אמיתי של API להתראות
    const alertApiUrl = process.env.ALERT_API_URL || 'https://api.your-security-system.com/alerts';
    
    await fetch(alertApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.ALERT_API_KEY || ''}`
      },
      body: JSON.stringify({
        threatType,
        ip,
        path,
        method,
        timestamp: new Date().toISOString(),
        source: 'saos-dex'
      })
    });
  } catch (error) {
    console.error('Failed to send alert:', error);
  }
}

// פונקציית רישום בקשה
async function logRequest(req: NextRequest, response: NextResponse, suspicious: boolean, threatType: string | null): Promise<void> {
  try {
    await db.apiLog.create({
      data: {
        timestamp: new Date(),
        ip: anonymizeIp(req.ip || 'unknown'),
        method: req.method,
        path: req.nextUrl.pathname,
        userAgent: req.headers.get('user-agent'),
        statusCode: response.status,
        responseSize: response.headers.get('content-length') || '0',
        suspicious,
        threatType
      }
    });
  } catch (error) {
    console.error('Failed to log request:', error);
  }
}

// Middleware ראשי
export async function middleware(req: NextRequest): Promise<NextResponse> {
  const response = NextResponse.next();
  const path = req.nextUrl.pathname;
  const ip = req.ip || 'unknown';
  
  // דילוג על נתיבים סטטיים ומסמכים
  if (
    path.startsWith('/_next/') ||
    path.startsWith('/static/') ||
    path.startsWith('/favicon.ico') ||
    path.endsWith('.css') ||
    path.endsWith('.js') ||
    path.endsWith('.png') ||
    path.endsWith('.jpg')
  ) {
    return response;
  }
  
  // זיהוי פעילות חשודה
  const { suspicious, threatType } = detectThreat(req, path, ip);
  
  // בדיקת קצב בקשות
  const isRateLimited = await checkRateLimit(ip);
  
  // אם נמצאה פעילות חשודה או קצב גבוה, שלח התראה
  if (suspicious || isRateLimited) {
    const alertType = suspicious ? threatType : 'high-rate';
    await sendAlert(alertType, ip, path, req.method);
  }
  
  // רישום הבקשה
  await logRequest(req, response, suspicious || isRateLimited, suspicious ? threatType : isRateLimited ? 'high-rate' : null);
  
  // אם קצב גבוה, החזר תגובת שגיאה
  if (isRateLimited) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again later.' },
      { status: 429 }
    );
  }
  
  return response;
}

// הגדרת matcher עבור middleware
export const config = {
  matcher: [
    '/api/dex/:path*',
    '/dashboard/:path*',
    '/admin/:path*'
  ]
};
