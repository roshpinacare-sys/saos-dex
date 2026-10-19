import { NextRequest, NextResponse } from 'next/server';

/**
 * middleware.ts — הגנת-גבולות: זיהוי וחסימת דפוסי-תקיפה בסיסיים
 * ═════════════════════════════════════════════════════════════════════════════════════
 * שכבת הגנה ראשונה לפני API routes. מזהה וחוסמת/מסמנת לבדיקה נוספת:
 *  · SQL Injection (UNION, SELECT, --)
 *  · XSS (<script>, onerror=)
 *  · Path Traversal (../)
 *  · SSRF (127.0.0.1, localhost, 10.x.x.x)
 * תואם לכל סוגי בקשות (GET, POST, PUT, DELETE) עם רישום לוגים לחשדות.
 * נכתב בהתאם לממצאי ביקורת עומק על חוסר מנגנוני זיהוי חריגות.
 */

const EXEMPT = ['/api/dex/stream', '/api/revive'];

// ── רשימות דפוסי תקיפה ────────────────────────────────────────────────────────────
const sqlInjectionPatterns = [
  /\b(UNION|SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|EXECUTE|TRUNCATE|DECLARE)\b/i,
  /\b(OR|AND)\s+\d+\s*=[^\s]*\d+/i,
  /--|\/\*\*\//,
  /;\s*$/, // סוגריים נקודה-פסיק בסוף פרמטר
];

const xssPatterns = [
  /<script[^>]*?>.*?<\/script>/i,
  /<iframe[^>]*?>.*?<\/iframe>/i,
  /<[^>]*(on\w+)=['\"].*?['\"][^>]*?>/i, // יצירת אירועים (onerror= onload=)
  /javascript:/i,
  /data:text\/html,/i,
  /<svg[^>]*?>.*?<\/svg>/i,
];

const pathTraversalPatterns = [
  /\.\./, // ניסיון לעלות בתיקיות
  /%2e%2e/i, // URL-encoded ../
  /%2e%2e%2f/i,
];

const ssrfPatterns = [
  /127\.0\.0\.1/,
  /localhost/,
  /10\.\d{1,3}\.\d{1,3}\.\d{1,3}/,
  /192\.168\.\d{1,3}\.\d{1,3}/,
  /172\.(1[6-9]|2[0-9]|3[01])\.\d{1,3}\.\d{1,3}/,
  /169\.254\.\d{1,3}\.\d{1,3}/,
];

// ── פונקציות עזר לבדיקת דפוסים ─────────────────────────────────────────────────────
function containsPattern(input: string, patterns: RegExp[]): boolean {
  if (!input) return false;
  return patterns.some(pattern => pattern.test(input));
}

function logSuspiciousActivity(
  req: NextRequest,
  attackType: string,
  details: Record<string, unknown>
): void {
  const timestamp = new Date().toISOString();
  const ip = req.headers.get('x-forwarded-for') || req.ip || 'unknown';
  const userAgent = req.headers.get('user-agent') || 'unknown';
  
  console.warn(JSON.stringify({
    timestamp,
    action: 'security_alert',
    attackType,
    ip,
    path: req.nextUrl.pathname,
    method: req.method,
    userAgent,
    details,
  }));
}

// ── פונקציית המידלוור הראשית ────────────────────────────────────────────────────────
export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  
  // פטורים מהבדיקות (כמו בקוד המקורי)
  if (EXEMPT.some(exempt => pathname.startsWith(exempt))) {
    return NextResponse.next();
  }
  
  // בדיקות SQL Injection ב-URL וב-body
  if (containsPattern(pathname, sqlInjectionPatterns)) {
    logSuspiciousActivity(req, 'SQL_INJECTION', { location: 'path', pattern: pathname });
    return new NextResponse('Security: SQL Injection pattern detected', { status: 403 });
  }
  
  // בדיקות XSS ב-URL וב-headers
  if (containsPattern(pathname, xssPatterns)) {
    logSuspiciousActivity(req, 'XSS', { location: 'path', pattern: pathname });
    return new NextResponse('Security: XSS pattern detected', { status: 403 });
  }
  
  // בדיקות Path Traversal ב-URL
  if (containsPattern(pathname, pathTraversalPatterns)) {
    logSuspiciousActivity(req, 'PATH_TRAVERSAL', { location: 'path', pattern: pathname });
    return new NextResponse('Security: Path Traversal attempt detected', { status: 403 });
  }
  
  // בדיקות SSRF ב-URL
  if (containsPattern(pathname, ssrfPatterns)) {
    logSuspiciousActivity(req, 'SSRF', { location: 'path', pattern: pathname });
    return new NextResponse('Security: SSRF attempt detected', { status: 403 });
  }
  
  // בדיקת body עבור POST/PUT/DELETE
  if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
    const contentType = req.headers.get('content-type') || '';
    
    if (contentType.includes('application/json')) {
      const body = req.body.toString();
      
      if (containsPattern(body, sqlInjectionPatterns)) {
        logSuspiciousActivity(req, 'SQL_INJECTION', { location: 'body', pattern: '...' });
        return new NextResponse('Security: SQL Injection pattern detected in body', { status: 403 });
      }
      
      if (containsPattern(body, xssPatterns)) {
        logSuspiciousActivity(req, 'XSS', { location: 'body', pattern: '...' });
        return new NextResponse('Security: XSS pattern detected in body', { status: 403 });
      }
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      // בדיקת form data
      const formData = req.body.toString();
      
      if (containsPattern(formData, sqlInjectionPatterns)) {
        logSuspiciousActivity(req, 'SQL_INJECTION', { location: 'form', pattern: '...' });
        return new NextResponse('Security: SQL Injection pattern detected in form data', { status: 403 });
      }
      
      if (containsPattern(formData, xssPatterns)) {
        logSuspiciousActivity(req, 'XSS', { location: 'form', pattern: '...' });
        return new NextResponse('Security: XSS pattern detected in form data', { status: 403 });
      }
    }
  }
  
  // בדיקת headers
  const headers = Array.from(req.headers.entries());
  for (const [key, value] of headers) {
    if (containsPattern(value, xssPatterns)) {
      logSuspiciousActivity(req, 'XSS', { location: 'headers', header: key, pattern: '...' });
      return new NextResponse('Security: XSS pattern detected in headers', { status: 403 });
    }
    
    if (key.toLowerCase().includes('referer') && containsPattern(value, ssrfPatterns)) {
      logSuspiciousActivity(req, 'SSRF', { location: 'referer', pattern: value });
      return new NextResponse('Security: SSRF attempt detected in referer header', { status: 403 });
    }
  }
  
  // אם עברו כל הבדיקות
  return NextResponse.next();
}

// ── קונפיגורציה של המידלוור ────────────────────────────────────────────────────────
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|public/).*)',
  ],
};