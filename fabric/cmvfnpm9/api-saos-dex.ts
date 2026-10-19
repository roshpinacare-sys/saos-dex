import { NextRequest, NextResponse } from 'next/server';

// רשימות דפוסי תקיפה ידועים
const SQLI_PATTERNS = [
  /\b(union|select|insert|delete|update|drop|create|alter|exec|execute|truncate|declare|cast|convert)\b/i,
  /[';"\-\-]/,
  /\b(or|and)\s+\w+/i,
  /\b(windows|schemastats|sp_password|xp_cmdshell)\b/i,
  /\b(\d+\s*=\s*\d+|\w+\s*=\s*\w+)\b/i
];

const XSS_PATTERNS = [
  /<script[^>]*?>.*?<\/script>/gi,
  /<iframe[^>]*?>.*?<\/iframe>/gi,
  /<object[^>]*?>.*?<\/object>/gi,
  /<embed[^>]*?>.*?<\/embed>/gi,
  /<applet[^>]*?>.*?<\/applet>/gi,
  /<link[^>]*?>/gi,
  /<meta[^>]*?>/gi,
  /on\w+\s*=\s*["']?[^"' >]+["']?/gi, // אירועי JavaScript
  /javascript:/gi,
  /vbscript:/gi,
  /data:/gi,
  /\<\?xml/i,
  /<!\[CDATA\[/i
];

const PATH_TRAVERSAL_PATTERNS = [/\.\./, /%2e%2e/i];

const SSRF_PATTERNS = [
  /^https?:\/\/localhost(:\d+)?/i,
  /^https?:\/\/127\.0\.0\.1(:\d+)?/i,
  /^https?:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?/i,
  /^https?:\/\/172\.(1[6-9]|2[0-9]|3[01])\.\d{1,3}\.\d{1,3}(:\d+)?/i,
  /^https?:\/\/192\.168\.\d{1,3}\.\d{1,3}(:\d+)?/i,
  /^https?:\/\/169\.254\.\d{1,3}\.\d{1,3}(:\d+)?/i,
  /^https?:\/\/fc00:\/\/(:\d+)?/i,
  /^https?:\/\/\[?::1\]?(:\d+)?/i
];

/**
 * מנקה ומגן על קלט מפני דפוסי תקיפה ידועים
 * @param value הערך לבדיקה
 * @param type סוג הקלט (query, header, body)
 * @param field שם השדה (אופציונלי)
 * @returns הערך המנוקה או זריקת שגיאה אם נמצאה תקיפה
 */
export function sanitizeInput(value: unknown, type: 'query' | 'header' | 'body', field?: string): string {
  if (typeof value !== 'string') {
    return value as string;
  }

  const originalValue = value;
  let attackType: string | null = null;

  // בדיקת SQLi
  for (const pattern of SQLI_PATTERNS) {
    if (pattern.test(value)) {
      attackType = 'SQL Injection';
      break;
    }
  }

  // בדיקת XSS
  if (!attackType) {
    for (const pattern of XSS_PATTERNS) {
      if (pattern.test(value)) {
        attackType = 'Cross-Site Scripting (XSS)';
        break;
      }
    }
  }

  // בדיקת Path Traversal
  if (!attackType) {
    for (const pattern of PATH_TRAVERSAL_PATTERNS) {
      if (pattern.test(value)) {
        attackType = 'Path Traversal';
        break;
      }
    }
  }

  // בדיקת SSRF
  if (!attackType && type === 'query') {
    for (const pattern of SSRF_PATTERNS) {
      if (pattern.test(value)) {
        attackType = 'Server-Side Request Forgery (SSRF)';
        break;
      }
    }
  }

  // אם נמצאה תקיפה, רשום ללוג וזרוק שגיאה
  if (attackType) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      attackType,
      inputType: type,
      field: field || 'unknown',
      value: originalValue,
      userAgent: 'N/A',
      ip: 'N/A'
    };

    console.warn('Potential attack detected:', JSON.stringify(logEntry));
    
    throw new Error(`Invalid input: Potential ${attackType} attempt detected`);
  }

  // החזר את הערך המנוקה
  return value
    .replace(/<[^>]*>/g, '') // הסרת תגי HTML
    .replace(/[';"\-\-]/g, '') // הסרת תווי SQL
    .replace(/\.\./g, ''); // הסרת ניסיונות Path Traversal
}

/**
 * מידלוור להגנה על כל נקודות הקלט של ה-API
 */
export function securityMiddleware(request: NextRequest): NextResponse | null {
  try {
    // בדיקת query parameters
    const url = new URL(request.url);
    for (const [key, value] of url.searchParams.entries()) {
      sanitizeInput(value, 'query', key);
    }

    // בדיקת headers
    for (const [key, value] of request.headers.entries()) {
      // דילוג על headers סטנדרטיים שצפויים להכיל ערכים מסוגננים
      if (['user-agent', 'accept', 'accept-language', 'content-type', 'cookie'].includes(key.toLowerCase())) {
        continue;
      }
      sanitizeInput(value, 'header', key);
    }

    // בדיקת body עבור נתוני JSON
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const body = request.body;
      if (body && body instanceof ReadableStream) {
        // קריאה של ה-body כאן תגרום לבעיות בקריאה חוזרת בפונקציית ה-Route
        // במקום זאת, ניישם את הבדיקה בכל פונקציית Route באופן ידני
        // או נשתמש ב-body-parser מותאם אישית
      }
    }

    // אם כל הבדיקות עברו בהצלחה
    return null;
  } catch (error) {
    // אם נמצאה תקיפה, החזר תגובת שגיאה
    return new NextResponse(
      JSON.stringify({ 
        error: error instanceof Error ? error.message : 'Invalid input',
        timestamp: new Date().toISOString()
      }),
      { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}