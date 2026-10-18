import { NextRequest, NextResponse } from 'next/server';

/**
 * attackDetectionMiddleware — מנגנון זיהוי תקיפות ידועות ב-API
 * ════════════════════════════════════════════════════════════════════════════════
 * מסנן בקשות חשודות לפי דפוסי תקיפה מוכרים (SQLi, XSS, Path Traversal, SSRF)
 * מופעל כ-middleware ברמת ה-API של saos-dex. כל ניסיון תקיפה:
 * - נרשם בלוג עם פרטים מלאים (IP, סוג, נתיב, timestamp)
 * - מחזיר תשובה 403 Forbidden ללקוח
 */
export function attackDetectionMiddleware(req: NextRequest): NextResponse | null {
  // פטורים: נתיבים שידוע שאינם רגישים לתקיפות
  const exemptPaths = ['/api/dex/stream', '/api/revive'];
  if (exemptPaths.some(path => req.nextUrl.pathname.includes(path))) {
    return null; // המשך למידלוור הבא
  }

  // קבלת ה-IP האמיתי (האחרון ב-X-Forwarded-For או x-real-ip)
  const ip = req.headers.get('x-forwarded-for')?.split(',').pop()?.trim() || 
              req.headers.get('x-real-ip') || 
              'unknown';

  // זיהוי SQLi (חיפוש אחר ביטויים חשודים ב-params, headers או body)
  const sqlInjectionPatterns = [
    /\bUNION\b/i, /\bSELECT\b/i, /\bINSERT\b/i, /\bUPDATE\b/i, /\bDELETE\b/i,
    /\bDROP\b/i, /\bEXEC\b/i, /\bEXECUTE\b/i, /\bxp_cmdshell\b/i,
    /\b--\b/g, /\/\*\*\/\b/g, /\bOR\b\s*\d+\s*=\s*\d+/i,
    /\bAND\b\s*\d+\s*=\s*\d+/i
  ];

  // זיהוי XSS (חיפוש אחר תגיות סקריפט או אירועים חשודים)
  const xssPatterns = [
    /<script[^>]*?>.*?<\/script>/gi,
    /<iframe[^>]*?>/gi,
    /<object[^>]*?>/gi,
    /<embed[^>]*?>/gi,
    /on\w+\s*=\s*['\"].*?['\"]/gi,
    /javascript:/gi,
    /vbscript:/gi,
    /data:text\/html/i
  ];

  // זיהוי Path Traversal (חיפוש אחר ../ בנתיב)
  const pathTraversalPattern = /\.\./g;

  // זיהוי SSRF (חיפוש אחר כתובות פנימיות)
  const ssrfPatterns = [
    /127\.0\.0\.1/,
    /localhost/,
    /192\.168\./,
    /10\.\d+\.\d+\.\d+/,
    /172\.(1[6-9]|2[0-9]|3[01])\./,
    /169\.254\./,
    /file:\/\//,
    /gopher:\///
  ];

  // בדיקת נתיבים ופרמטרים
  const url = req.nextUrl;
  const path = url.pathname;
  const searchParams = url.searchParams.toString();
  const headers = JSON.stringify(Object.fromEntries(req.headers.entries()));
  const method = req.method;
  
  // בדיקת גוף הבקשה (אם קיים)
  let body = '';
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    try {
      body = req.text();
    } catch (e) {
      body = '[unreadable-body]';
    }
  }

  // בדיקה עבור SQLi
  const hasSqlInjection = sqlInjectionPatterns.some(pattern => {
    return pattern.test(path) || 
           pattern.test(searchParams) || 
           pattern.test(headers) || 
           pattern.test(body);
  });

  // בדיקה עבור XSS
  const hasXss = xssPatterns.some(pattern => {
    return pattern.test(path) || 
           pattern.test(searchParams) || 
           pattern.test(headers) || 
           pattern.test(body);
  });

  // בדיקה עבור Path Traversal
  const hasPathTraversal = pathTraversalPattern.test(path);

  // בדיקה עבור SSRF
  const hasSsrf = ssrfPatterns.some(pattern => {
    return pattern.test(path) || 
           pattern.test(searchParams) || 
           pattern.test(headers) || 
           pattern.test(body);
  });

  // אם נמצאה תקיפה
  if (hasSqlInjection || hasXss || hasPathTraversal || hasSsrf) {
    const attackTypes = [];
    if (hasSqlInjection) attackTypes.push('SQL Injection');
    if (hasXss) attackTypes.push('XSS');
    if (hasPathTraversal) attackTypes.push('Path Traversal');
    if (hasSsrf) attackTypes.push('SSRF');

    // רישום בלוג
    const timestamp = new Date().toISOString();
    console.log(`[ATTACK DETECTED] ${timestamp} | IP: ${ip} | Type: ${attackTypes.join(', ')} | Path: ${path}`);

    // החזרת תשובת 403
    return NextResponse.json(
      { 
        ok: false, 
        error: 'Forbidden: Attack detected' 
      },
      { status: 403 }
    );
  }

  // אם לא נמצאה תקיפה - המשך רגיל
  return null;
}

// הוספת המידלוור לזרימת ה-Next.js
export function middleware(req: NextRequest): NextResponse {
  const attackResponse = attackDetectionMiddleware(req);
  if (attackResponse) {
    return attackResponse;
  }

  // המשך למידלוור הבא (rate limit וכו')
  return NextResponse.next();
}

// הגדרת הנתיבים שעליהם יופעל המידלוור
export const config = {
  matcher: ['/api/dex/:path*'], // הפעלה על כל הנתיבים ב-API
};