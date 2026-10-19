import { NextRequest, NextResponse } from 'next/server';

// ── הטמעת בדיקות דפוסי תקיפה בסיסיים בניתוח בקשות API ──

// רשימת דפוסי תקיפה בסיסיים לזיהוי
const SQL_INJECTION_PATTERNS = [
  /\bUNION\b/i,
  /\bSELECT\b/i,
  /\bINSERT\b/i,
  /\bUPDATE\b/i,
  /\bDELETE\b/i,
  /\bDROP\b/i,
  /\bEXEC\b/i,
  /\bEXECUTE\b/i,
  /\bxp_cmdshell\b/i,
  /\b--\b/i,
  /\#\b/i,
  /\;\b/i,
  /\bor\s+1\s*=\s*1\b/i,
  /\bor\s+\d+\s*=\s*\d+\b/i,
];

const XSS_PATTERNS = [
  /<script[^>]*?>.*?<\/script>/i,
  /<iframe[^>]*?>.*?<\/iframe>/i,
  /<object[^>]*?>.*?<\/object>/i,
  /<embed[^>]*?>.*?<\/embed>/i,
  /<applet[^>]*?>.*?<\/applet>/i,
  /<form[^>]*?>.*?<\/form>/i,
  /<input[^>]*?>/i,
  /<button[^>]*?>/i,
  /<img[^>]*?onload\s*=\s*"[^"]*javascript:[^"]*"/i,
  /<img[^>]*?onerror\s*=\s*"[^"]*javascript:[^"]*"/i,
  /javascript:/i,
  /onload\s*=\s*"/i,
  /onerror\s*=\s*"/i,
  /onfocus\s*=\s*"/i,
  /onmouseover\s*=\s*"/i,
];

const PATH_TRAVERSAL_PATTERNS = [
  /\.\./i,
  /%2e%2e/i,
  /%2e%2e%2f/i,
  /%2e%5c/i,
  /%2e%5c%2e/i,
];

// רשימת כתובות IP פנימיות ורשתות פרטיות לחסימת SSRF
const INTERNAL_IPS = [
  '127.0.0.1',
  'localhost',
  '0.0.0.0',
  '10.',
  '192.168.',
  '172.16.',
  '172.17.',
  '172.18.',
  '172.19.',
  '172.20.',
  '172.21.',
  '172.22.',
  '172.23.',
  '172.24.',
  '172.25.',
  '172.26.',
  '172.27.',
  '172.28.',
  '172.29.',
  '172.30.',
  '172.31.',
  '169.254.',
];

// מבנה למעקב ניסיונות חוזרים מ-IP מסוים
const ipAttempts = new Map<string, number>();
const MAX_ATTEMPTS = 5; // מספר הניסיונות המקסימלי לפני חסימה
const RESET_INTERVAL = 300_000; // 5 דקות במילישניות

// פונקציה לבדיקת כתובות IP פנימיות
function isInternalIp(ip: string): boolean {
  return INTERNAL_IPS.some(internalIp => {
    if (internalIp.endsWith('.')) {
      return ip.startsWith(internalIp);
    }
    return ip === internalIp;
  });
}

// פונקציה לבדיקת ניסיונות SSRF
function checkSSRF(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    return isInternalIp(parsedUrl.hostname);
  } catch {
    return false;
  }
}

// פונקציה לבדיקת התקפות
function detectAttack(req: NextRequest): { attackType: string | null, details: any } {
  const url = req.url;
  const method = req.method;
  const headers = Object.fromEntries(req.headers.entries());
  const body = req.body ? req.body.toString() : '';
  
  // בדיקת SSRF בפרמטרים של ה-URL
  const urlParams = new URLSearchParams(url.split('?')[1]);
  for (const [key, value] of urlParams) {
    if (checkSSRF(value)) {
      return {
        attackType: 'SSRF',
        details: { param: key, value }
      };
    }
  }
  
  // בדיקת SQL Injection ב-headers, query params ו-body
  for (const pattern of SQL_INJECTION_PATTERNS) {
    if (pattern.test(url) || 
        Object.values(headers).some(header => pattern.test(header)) ||
        pattern.test(body)) {
      return {
        attackType: 'SQL_INJECTION',
        details: { pattern: pattern.source }
      };
    }
  }
  
  // בדיקת XSS ב-headers, query params ו-body
  for (const pattern of XSS_PATTERNS) {
    if (pattern.test(url) || 
        Object.values(headers).some(header => pattern.test(header)) ||
        pattern.test(body)) {
      return {
        attackType: 'XSS',
        details: { pattern: pattern.source }
      };
    }
  }
  
  // בדיקת Path Traversal בנתיב
  for (const pattern of PATH_TRAVERSAL_PATTERNS) {
    if (pattern.test(url)) {
      return {
        attackType: 'PATH_TRAVERSAL',
        details: { pattern: pattern.source }
      };
    }
  }
  
  return { attackType: null, details: null };
}

// פונקציה לרישום ניסיון התקפה
function logAttack(req: NextRequest, attackType: string, details: any) {
  const ip = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
  const timestamp = new Date().toISOString();
  const method = req.method;
  const url = req.url;
  const headers = Object.fromEntries(req.headers.entries());
  const body = req.body ? req.body.toString() : '';
  
  const logEntry = {
    timestamp,
    ip,
    attackType,
    details,
    method,
    url,
    headers,
    body: body.substring(0, 500) // מגבלת אורך ל-body
  };
  
  // רישום ללוג אבטחה מרכזי (כאן ניתן לשלוח למערכת לוגים מרוחקת)
  console.log('SECURITY_ALERT:', JSON.stringify(logEntry));
}

// פונקטציה לניהול ניסיונות חוזרים וחסימה הדרגתית
function checkAndBlockIp(ip: string): boolean {
  // ניקוי ניסיונות ישנים
  if (ipAttempts.size > 0) {
    const now = Date.now();
    for (const [ip, timestamp] of ipAttempts.entries()) {
      if (now - timestamp > RESET_INTERVAL) {
        ipAttempts.delete(ip);
      }
    }
  }
  
  // בדיקת ניסיונות קיימים
  const attempts = ipAttempts.get(ip) || 0;
  if (attempts >= MAX_ATTEMPTS) {
    return true; // חסום
  }
  
  // עדכון ניסיונות
  ipAttempts.set(ip, Date.now());
  return false; // לא חסום
}

// הפונקציה הראשית של ה-middleware
export function middleware(req: NextRequest) {
  // פטורים לנתיבים שאינם קשורים ל-API או לנתיבים מוכרים
  const { pathname } = new URL(req.url);
  if (!pathname.startsWith('/api/') || 
      pathname.startsWith('/api/dex/stream') || 
      pathname.startsWith('/api/revive')) {
    return NextResponse.next();
  }
  
  // קבלת IP מקור
  const ip = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
  
  // בדיקת ניסיונות חוזרים וחסימה הדרגתית
  if (checkAndBlockIp(ip)) {
    logAttack(req, 'REPEATED_ATTEMPTS', { ip, attempts: MAX_ATTEMPTS });
    return new NextResponse('Access temporarily blocked due to suspicious activity', { 
      status: 429,
      headers: { 'Retry-After': '300' }
    });
  }
  
  // זיהוי התקפות
  const { attackType, details } = detectAttack(req);
  
  if (attackType) {
    // רישום ההתקפה
    logAttack(req, attackType, details);
    
    // החזרת תגובת שגיאה
    return new NextResponse(`Security alert: ${attackType} attempt detected`, { 
      status: 403,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
  
  // המשך עיבוד הבקשה אם לא זוהתה התקפה
  return NextResponse.next();
}

// הגדרת הנתיבים שה-middleware יופעל עבורם
export const config = {
  matcher: '/api/:path*',
};
