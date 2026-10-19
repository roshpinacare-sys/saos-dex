import { NextRequest, NextResponse } from 'next/server';
import pino from 'pino';

// יצירת מופע logger עם פורמט JSON
const logger = pino({
  level: 'info',
  transport: {
    target: 'pino-pretty',
    options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' }
  }
});

// רשימת נתיבי API רגישים לניטור
type SensitiveApiPath = '/api/dex/security' | '/api/dex/wallets' | '/api/dex/truth' | '/api/dex/relay' | '/api/dex/operator-auth';

const SENSITIVE_PATHS: SensitiveApiPath[] = [
  '/api/dex/security',
  '/api/dex/wallets',
  '/api/dex/truth',
  '/api/dex/relay',
  '/api/dex/operator-auth'
];

// מאחסן IPים לא מוכרים לזמן קצר (למניעת לוג חוזר)
const unknownIPs = new Set<string>();
const IP_CACHE_DURATION = 60 * 60 * 1000; // 1 שעה

// פונקציה לבדיקת אם IP מוכר
function isKnownIP(ip: string): boolean {
  // בדיקה במסד הנתונים או רשימת IPים מורשים
  // לדוגמה: ניתן להוסיף בדיקה למסד נתונים כאן
  return false;
}

// פונקציה לרישום אירוע אבטחה
function logSecurityEvent(
  level: 'info' | 'warn' | 'error',
  event: string,
  request: NextRequest,
  details: Record<string, any> = {}
) {
  const ip = request.headers.get('x-forwarded-for') || request.ip || 'unknown';
  const userAgent = request.headers.get('user-agent') || 'unknown';
  
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    source: {
      ip,
      userAgent,
      path: request.nextUrl.pathname,
      method: request.method
    },
    headers: Object.fromEntries(request.headers.entries()),
    details
  };

  logger[level](logEntry);
}

// מידלוור לניטור אירועי אבטחה
export function securityLoggingMiddleware(request: NextRequest): NextResponse | null {
  const ip = request.headers.get('x-forwarded-for') || request.ip || 'unknown';
  const path = request.nextUrl.pathname;
  const method = request.method;
  
  // רישום גישה לנתיבים רגישים
  if (SENSITIVE_PATHS.some(sensitivePath => path.startsWith(sensitivePath))) {
    logSecurityEvent('info', 'sensitive_api_access', request, {
      path,
      method
    });
  }
  
  // רישום IPים לא מוכרים
  if (!isKnownIP(ip) && !unknownIPs.has(ip)) {
    unknownIPs.add(ip);
    
    // הסרת IP מהקאש לאחר זמן מוגדר
    setTimeout(() => {
      unknownIPs.delete(ip);
    }, IP_CACHE_DURATION);
    
    logSecurityEvent('warn', 'unknown_ip_access', request, {
      path,
      method
    });
  }
  
  // המשך בזרימה הרגילה של הבקשה
  return null;
}

// פונקציה לרישום שגיאות הרשאה
export function logAuthError(request: NextRequest, statusCode: number, reason?: string) {
  logSecurityEvent('error', 'authentication_failure', request, {
    statusCode,
    reason
  });
}

// פונקציה לרישום שינויי הרשאות
export function logPermissionChange(
  user: string,
  action: 'grant' | 'revoke',
  resource: string,
  admin: string
) {
  logger.info({
    timestamp: new Date().toISOString(),
    level: 'info',
    event: 'permission_change',
    details: {
      user,
      action,
      resource,
      admin
    }
  });
}

// פונקציה לרישום חריגות בקצב בקשות
export function logRateLimitExceeded(request: NextRequest, limit: number, windowMs: number) {
  logSecurityEvent('warn', 'rate_limit_exceeded', request, {
    limit,
    windowMs
  });
}

// הטמעת המידלוור ב-Next.js
export async function middleware(request: NextRequest) {
  // הפעלת מידלוור הניטור
  const securityResult = securityLoggingMiddleware(request);
  
  // אם המידלוור חזר תשובה, החזר אותה
  if (securityResult) {
    return securityResult;
  }
  
  // המשך לטיפול הבא בשרשרת
  return NextResponse.next();
}

// הגדרת נתיבים שהמידלוור יופעל עליהם
export const config = {
  matcher: [
    '/api/dex/:path*',
    '/api/revive/:path*'
  ]
};