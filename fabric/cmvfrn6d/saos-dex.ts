import { NextRequest, NextResponse } from 'next/server';

/**
 * securityPatterns.ts — Middleware לזיהוי דפוסי תקיפה ידועים
 * ═════════════════════════════════════════════════════════════════════════════════════
 * בודק בקשות נכנסות (API) עבור SQLi, XSS, Path Traversal, SSRF
 * חוסם בקשות חשודות עם 400 + הודעה גנרית, לוג ברמת WARNING
 * רשום ב-middleware.ts לפני כל הנתיבים
 */

// ביטויים רגולריים לזיהוי דפוסי תקיפה
const SQLI_PATTERNS = [
  /\bUNION\b/i,
  /\bSELECT\b/i,
  /\bINSERT\b/i,
  /\bUPDATE\b/i,
  /\bDELETE\b/i,
  /\bDROP\b/i,
  /\b--\b/,
  /\;/,
  /\/\*.*\*\//
];

const XSS_PATTERNS = [
  /<script/i,
  /javascript:/i,
  /onload=/i,
  /onerror=/i,
  /\balert\(/i
];

const PATH_TRAVERSAL_PATTERNS = [
  /\.\./,
  /\\\\\\\\\\\\\\\\./
];

const SSRF_PATTERNS = [
  /127\.0\.0\.1/,
  /localhost/,
  /\[::1\]/,
  /0\.0\.0\.0/,
  /10\.\d{1,3}\.\d{1,3}\.\d{1,3}/,
  /172\.\d{1,3}\.\d{1,3}\.\d{1,3}/,
  /192\.168\.\d{1,3}\.\d{1,3}/
];

// פונקציית עזר לבדיקת ערך כנגד דפוסים
function matchesPattern(value: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(value));
}

// פונקציית לוג ללא פרטים רגישים
function logSecurityWarning(type: string, request: NextRequest): void {
  console.warn(`[${new Date().toISOString()}] SECURITY: Blocked ${type} attempt from ${request.ip} to ${request.url}`);
}

export function securityMiddleware(request: NextRequest): NextResponse | null {
  // בדיקת query parameters
  const url = new URL(request.url);
  for (const [key, value] of url.searchParams.entries()) {
    if (
      matchesPattern(value, SQLI_PATTERNS) ||
      matchesPattern(value, XSS_PATTERNS) ||
      matchesPattern(value, PATH_TRAVERSAL_PATTERNS) ||
      matchesPattern(value, SSRF_PATTERNS)
    ) {
      logSecurityWarning('SQLi/XSS/Path Traversal/SSRF', request);
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
  }

  // בדיקת headers
  const headers = request.headers;
  for (const [key, value] of headers.entries()) {
    if (
      matchesPattern(value, SQLI_PATTERNS) ||
      matchesPattern(value, XSS_PATTERNS) ||
      matchesPattern(value, PATH_TRAVERSAL_PATTERNS) ||
      matchesPattern(value, SSRF_PATTERNS)
    ) {
      logSecurityWarning('Malicious Header', request);
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
  }

  // בדיקת body (רק עבור POST, PUT, PATCH)
  if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
    const contentType = headers.get('content-type');
    if (contentType?.includes('application/json')) {
      try {
        const body = request.body;
        if (body) {
          const buffer = Buffer.concat([body as any]);
          const bodyText = buffer.toString('utf-8');
          
          // ניסיון לפענח כ-JSON
          try {
            const bodyJson = JSON.parse(bodyText);
            const jsonString = JSON.stringify(bodyJson);
            
            if (
              matchesPattern(jsonString, SQLI_PATTERNS) ||
              matchesPattern(jsonString, XSS_PATTERNS) ||
              matchesPattern(jsonString, PATH_TRAVERSAL_PATTERNS) ||
              matchesPattern(jsonString, SSRF_PATTERNS)
            ) {
              logSecurityWarning('Malicious JSON Body', request);
              return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
            }
          } catch {
            // אם לא JSON, בדוק כמחרוזת רגילה
            if (
              matchesPattern(bodyText, SQLI_PATTERNS) ||
              matchesPattern(bodyText, XSS_PATTERNS) ||
              matchesPattern(bodyText, PATH_TRAVERSAL_PATTERNS) ||
              matchesPattern(bodyText, SSRF_PATTERNS)
            ) {
              logSecurityWarning('Malicious Body', request);
              return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
            }
          }
        }
      } catch (error) {
        console.error('Error reading request body:', error);
      }
    }
  }

  // אם כל הבדיקות עברו, המשך למידלוור הבא
  return null;
}
