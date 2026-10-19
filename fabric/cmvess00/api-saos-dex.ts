import { NextRequest, NextResponse } from 'next/server';

// ── IDS/IPS Middleware — זיהוי דפוסי תקיפה ב-API ──────────────────────────────────
// מופעל רק אם IDS_ENABLED מוגדר (כברירת מחדל כבוי)
const IDS_ENABLED = process.env.IDS_ENABLED === 'true';

// רשימות רגילות (blacklists) לזיהוי איומים ידועים
const SQLI_PATTERNS = [
  /\b(union|select|insert|update|delete|drop|create|alter|exec|execute|truncate|xp_cmdshell)\b/i,
  /\b(UNION\s+ALL|SELECT\s+|INSERT\s+INTO|UPDATE\s+SET|DELETE\s+FROM|DROP\s+TABLE)\b/i,
  /';\s*(--|#|\*\*|\/\*|\*\/)/,
  /\/\*.*?\*\//
];

const XSS_PATTERNS = [
  /<\s*script\s*>/i,
  /<\s*iframe\s*>/i,
  /<\s*img\s+src\s*=\s*["']?javascript:/i,
  /on\w+\s*=\s*["']?javascript:/i,
  /<\s*object\s*>/i,
  /<\s*embed\s*>/i,
  /<\s*link\s+href\s*=\s*["']?javascript:/i,
  /document\.cookie/i,
  /alert\s*\(/i
];

const PATH_TRAVERSAL_PATTERNS = [
  /\.\./,
  /%2e%2e/i,
  /%2e\.%2e/i,
  /\.\.\//
];

const SSRF_PATTERNS = [
  /127\.0\.0\.1/,
  /localhost/,
  /0\.0\.0\.0/,
  /10\.\d{1,3}\.\d{1,3}\.\d{1,3}/,
  /172\.(1[6-9]|2[0-9]|3[01])\.\d{1,3}\.\d{1,3}/,
  /192\.168\.\d{1,3}\.\d{1,3}/,
  /169\.254\.\d{1,3}\.\d{1,3}/
];

// ── פונקציות עזר לניתוח בקשה ──────────────────────────────────────────────────────
function scanText(text: string, patterns: RegExp[], context: string): { found: boolean, pattern?: string } {
  if (!text) return { found: false };
  
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      return { found: true, pattern: pattern.toString() };
    }
  }
  return { found: false };
}

function logAttackAttempt(req: NextRequest, attackType: string, pattern?: string): void {
  const timestamp = new Date().toISOString();
  const ip = req.ip || req.headers.get('x-forwarded-for') || 'unknown';
  const method = req.method;
  const url = req.url;
  
  // יצירת לוג מבני JSON לניתוח וניטור
  const logEntry = {
    timestamp,
    attack_type: attackType,
    pattern,
    ip,
    method,
    url,
    headers: Object.fromEntries(req.headers.entries()),
    // לא כוללים את כל ה-body כדי למנוע דליפת נתונים
    body_size: req.headers.get('content-length') || 'unknown'
  };
  
  console.warn(`[IDS] ניסיון תקיפה זוהה: ${JSON.stringify(logEntry)}`);
}

// ── Middleware ראשי ────────────────────────────────────────────────────────────────
export function middleware(req: NextRequest): NextResponse {
  // בדיקה אם IDS מופעל
  if (!IDS_ENABLED) {
    return NextResponse.next();
  }
  
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;
  const ip = req.ip || req.headers.get('x-forwarded-for') || 'unknown';
  
  // ── בדיקות עבור SQL Injection ──────────────────────────────────────────────────
  const sqlInQuery = scanText(url.searchParams.toString(), SQLI_PATTERNS, 'query');
  const sqlInPath = scanText(pathname, SQLI_PATTERNS, 'path');
  
  if (sqlInQuery.found || sqlInPath.found) {
    logAttackAttempt(req, 'SQL_INJECTION', sqlInQuery.found ? sqlInQuery.pattern : sqlInPath.pattern);
    return new NextResponse(
      JSON.stringify({ error: 'SQL Injection attempt detected' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }
  
  // ── בדיקות עבור XSS ─────────────────────────────────────────────────────────────
  const xssInQuery = scanText(url.searchParams.toString(), XSS_PATTERNS, 'query');
  const xssInPath = scanText(pathname, XSS_PATTERNS, 'path');
  const xssInHeaders = Array.from(req.headers.entries()).find(([_, value]) => 
    scanText(value, XSS_PATTERNS, 'header').found
  );
  
  if (xssInQuery.found || xssInPath.found || xssInHeaders) {
    logAttackAttempt(req, 'XSS_ATTACK', 
      xssInQuery.found ? xssInQuery.pattern : 
      xssInPath.found ? xssInPath.pattern : 
      xssInHeaders?.[1]);
    return new NextResponse(
      JSON.stringify({ error: 'XSS attack attempt detected' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }
  
  // ── בדיקות עבור Path Traversal ─────────────────────────────────────────────────
  const pathTraversal = scanText(pathname, PATH_TRAVERSAL_PATTERNS, 'path');
  
  if (pathTraversal.found) {
    logAttackAttempt(req, 'PATH_TRAVERSAL', pathTraversal.pattern);
    return new NextResponse(
      JSON.stringify({ error: 'Path traversal attempt detected' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }
  
  // ── בדיקות עבור SSRF ───────────────────────────────────────────────────────────
  const ssrfInQuery = Array.from(url.searchParams.entries()).find(([key, value]) => {
    if (['callback', 'redirect', 'url', 'target', 'next', 'return'].includes(key.toLowerCase())) {
      return scanText(value, SSRF_PATTERNS, 'query').found;
    }
    return false;
  });
  
  if (ssrfInQuery) {
    logAttackAttempt(req, 'SSRF_ATTACK', ssrfInQuery[1]);
    return new NextResponse(
      JSON.stringify({ error: 'SSRF attack attempt detected' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }
  
  // ── בדיקת תדירות בקשות (למניעת brute force) ──────────────────────────────────
  // ניתן להרחיב זאת בהמשך עם מנגנון rate limiting מתקדם
  
  // אם כל הבדיקות עברו בהצלחה
  return NextResponse.next();
}

// ── הגדרת הנתיבים שה-middleware יופעל עליהם ───────────────────────────────────
export const config = {
  matcher: [
    '/api/:path*',
    '/api/dex/:path*',
    '/api/revive/:path*'
  ]
};
