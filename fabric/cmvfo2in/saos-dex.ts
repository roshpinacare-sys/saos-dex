import { NextRequest, NextResponse } from 'next/server';
import winston from 'winston';

// הגדרת logger סטנדרטי עם Winston
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'security-events.log' })
  ],
});

// מערך של נתיבי API רגישים
const SENSITIVE_APIS = [
  '/api/dex/security',
  '/api/dex/wallets',
  '/api/dex/transfer',
  '/api/dex/portfolio',
  '/api/dex/proofs'
];

// פונקציה לרישום אירועי אבטחה
function logSecurityEvent(
  level: 'info' | 'warn' | 'error',
  eventType: string,
  request: NextRequest,
  response?: NextResponse,
  userId?: string
) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    eventType,
    ip: request.headers.get('x-forwarded-for') || request.ip || 'unknown',
    path: request.nextUrl.pathname,
    method: request.method,
    headers: Object.fromEntries(request.headers.entries()),
    userId,
    response: response ? {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries())
    } : undefined
  };

  logger.log(level, JSON.stringify(logEntry));
  
  // שליחה למערכת ניהור מרכזית (Syslog)
  if (process.env.SYSLOG_URL) {
    fetch(process.env.SYSLOG_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(logEntry)
    }).catch(err => {
      console.error('Failed to send log to syslog:', err);
    });
  }
}

// פונקציה לבדיקת IP לא מוכר
function isUnknownIp(ip: string): boolean {
  // בדיקה אם ה-IP הוא ברשימת ה-IPים המוכרים
  const knownIps = process.env.KNOWN_IPS?.split(',') || [];
  return !knownIps.includes(ip);
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  
  // זיהוי ניסיונות כניסה כושלים (401/403)
  if (pathname.startsWith('/api/') && 
      (request.method === 'POST' || request.method === 'PUT' || request.method === 'DELETE')) {
    
    // בדיקת הרשאות כללית (ניתן להרחיב בהמשך)
    const authHeader = request.headers.get('authorization');
    if (!authHeader || authHeader !== `Bearer ${process.env.API_TOKEN}`) {
      logSecurityEvent(
        'warn',
        'unauthorized_access_attempt',
        request,
        NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
        undefined
      );
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }
  
  // רישום גישה ל-APIs רגישים
  if (SENSITIVE_APIS.some(api => pathname.startsWith(api))) {
    const userId = request.headers.get('x-user-id') || 'anonymous';
    
    // בדיקת IP לא מוכר
    const ip = request.headers.get('x-forwarded-for') || request.ip || 'unknown';
    if (isUnknownIp(ip)) {
      logSecurityEvent(
        'warn',
        'access_from_unknown_ip',
        request,
        undefined,
        userId
      );
    }
    
    logSecurityEvent(
      'info',
      'sensitive_api_access',
      request,
      undefined,
      userId
    );
  }
  
  // רישום שינויי הרשאות (ניתן להרחיב בהמשך)
  if (pathname.startsWith('/api/dex/security') && request.method === 'POST') {
    logSecurityEvent(
      'info',
      'permission_change',
      request,
      undefined,
      request.headers.get('x-user-id') || 'system'
    );
  }
  
  return NextResponse.next();
}

// הגדרת הנתיבים שה-middleware יעבוד עליהם
export const config = {
  matcher: ['/api/dex/:path*']
};
