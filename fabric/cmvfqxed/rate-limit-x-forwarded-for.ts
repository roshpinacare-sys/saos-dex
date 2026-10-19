import { NextRequest, NextResponse } from 'next/server';

// סוד מפתח משותף לאימות פנימי - בפרויקט אמיתי יילקח מסביבה מאובטחת
const INTERNAL_SHARED_SECRET = process.env.INTERNAL_SHARED_SECRET || 'saos-dex-internal-key-2026';

// פונקציית עזר לאימות סוד מפתח
function verifyInternalSecret(request: NextRequest): boolean {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }
  
  const providedSecret = authHeader.substring(7); // הסרת 'Bearer '
  return providedSecret === INTERNAL_SHARED_SECRET;
}

// פונקציית עזר לקבלת IP אמיתי מ-X-Forwarded-For
function getRealIp(request: NextRequest): string {
  const xForwardedFor = request.headers.get('X-Forwarded-For');
  if (xForwardedFor) {
    // לוקח את ה-IP האחרון ברשימה (הכי קרוב לשרת)
    return xForwardedFor.split(',').pop()?.trim() || 'unknown';
  }
  return 'unknown';
}

// פונקציית עזר לבדיקת IP פנימי
function isInternalIp(ip: string): boolean {
  // בדיקת IP פנימי - בפרויקט אמיתי יהיה קונפיגורציה מרכזית
  return ip.startsWith('10.') || ip.startsWith('192.168.') || ip === '127.0.0.1';
}

// מערכת rate-limit משופרת
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

function updateRateLimit(ip: string, isInternal: boolean): boolean {
  const now = Date.now();
  const windowMs = 60_000; // 1 דקה
  const limit = isInternal ? 2_000 : 240; // הגבלות מותאמות
  
  // ניקוי רשומים ישנים
  if (now > windowMs * 2) {
    for (const [key, value] of rateLimitStore.entries()) {
      if (now > value.resetTime + windowMs * 2) {
        rateLimitStore.delete(key);
      }
    }
  }
  
  const key = `${ip}:${isInternal ? 'internal' : 'public'}`;
  let record = rateLimitStore.get(key);
  
  if (!record || now > record.resetTime) {
    record = { count: 1, resetTime: now + windowMs };
    rateLimitStore.set(key, record);
    return true; // מותר
  }
  
  if (record.count >= limit) {
    return false; // חריגה
  }
  
  record.count++;
  rateLimitStore.set(key, record);
  return true; // מותר
}

// רישום אירועי אבטחה
function logSecurityEvent(request: NextRequest, ip: string, event: string, details?: any) {
  const timestamp = new Date().toISOString();
  const userAgent = request.headers.get('User-Agent') || 'unknown';
  
  console.log(JSON.stringify({
    timestamp,
    event,
    ip,
    userAgent,
    path: request.nextUrl.pathname,
    ...details
  }));
}

// מתווסף למידלוואר הקיים
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  
  // פטורים קיימים
  const exempt = ['/api/dex/stream', '/api/revive'];
  if (exempt.some(path => pathname.startsWith(path))) {
    return NextResponse.next();
  }
  
  // קביעת מקור הבקשה ו-IP
  const hasAuthHeader = request.headers.has('Authorization');
  const hasXForwardedFor = request.headers.has('X-Forwarded-For');
  const ip = getRealIp(request);
  
  // קביעת האם הבקשה פנימית
  const isInternal = 
    verifyInternalSecret(request) || 
    (hasXForwardedFor && isInternalIp(ip));
  
  // בדיקת rate-limit משופרת
  const allowed = updateRateLimit(ip, isInternal);
  
  if (!allowed) {
    // רישום ניסיון חריגה
    logSecurityEvent(request, ip, 'rate_limit_exceeded', {
      isInternal,
      path: pathname,
      hasAuthHeader,
      hasXForwardedFor
    });
    
    return new NextResponse(
      JSON.stringify({
        error: 'Rate limit exceeded',
        path: pathname,
        timestamp: new Date().toISOString()
      }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'X-Rate-Limit-Exceeded': 'true'
        }
      }
    );
  }
  
  // רישום בקשות חשודות (ניסיונות עקיפה)
  const isSuspicious = 
    !isInternal && hasAuthHeader ||
    isInternal && !hasAuthHeader && !hasXForwardedFor;
  
  if (isSuspicious) {
    logSecurityEvent(request, ip, 'suspicious_request', {
      isInternal,
      hasAuthHeader,
      hasXForwardedFor,
      path: pathname
    });
  }
  
  return NextResponse.next();
}

// ניתן להוסיף קונפיגורציה לניהול המפתחות וה-IP הפנימיים
export const config = {
  matcher: [
    '/api/dex/:path*',
    '/api/revive/:path*'
  ]
};