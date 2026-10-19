import { NextRequest, NextResponse } from 'next/server';

// ── מנגנון זיהוי חריגות מתקדם ──
type SecurityEvent = {
  timestamp: string;
  ip: string;
  path: string;
  eventType: string;
  actionTaken: string;
  details?: Record<string, unknown>;
};

// נתיבים רגישים לפיקוח מיוחד
const SENSITIVE_PATHS = [
  '/api/dex/settle',
  '/api/dex/transfer',
  '/api/dex/order',
  '/api/dex/cancel',
  '/api/dex/swap',
];

// תווים חשודים בכותרות
const SUSPICIOUS_CHARS = /[<>'"\;\(\)\{\}\[\]]/;

// מגבלות קצב מתקדמות
const ADVANCED_RATE_LIMITS = {
  '/api/dex/settle': { windowMs: 60000, maxRequests: 10 },
  '/api/dex/transfer': { windowMs: 60000, maxRequests: 15 },
  '/api/dex/order': { windowMs: 60000, maxRequests: 30 },
  '/api/dex/cancel': { windowMs: 60000, maxRequests: 20 },
  '/api/dex/swap': { windowMs: 60000, maxRequests: 25 },
};

// מערכת חסימה הדרגתית
const progressiveBlocking = new Map<string, {
  count: number;
  firstViolation: number;
  blocked: boolean;
}>();

// יומן אירועי אבטחה
const securityLog: SecurityEvent[] = [];

// ── פונקציות עזר ──
function getIp(request: NextRequest): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown-ip'
  );
}

function logSecurityEvent(event: SecurityEvent): void {
  securityLog.push(event);
  console.warn(`[SECURITY EVENT] ${JSON.stringify(event)}`);
  
  // שליחת התראה למערכת חיצונית אם קיימת
  const controlCenterUrl = process.env.SAOS_CONTROL_CENTER_URL;
  if (controlCenterUrl) {
    fetch(`${controlCenterUrl}/api/security-events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(3000),
    }).catch(err => 
      console.warn(`Failed to send security alert: ${err.message}`)
    );
  }
}

function analyzeHeaders(headers: Headers): { suspicious: boolean; reason: string } {
  const userAgent = headers.get('user-agent') || '';
  
  // בדיקת User-Agent לא סטנדרטי
  if (userAgent.length < 10 || userAgent === '-' || userAgent.includes('bot') && !userAgent.includes('Googlebot')) {
    return { suspicious: true, reason: 'Suspicious User-Agent' };
  }
  
  // בדיקת כותרות חסרות
  const requiredHeaders = ['accept', 'content-type'];
  for (const header of requiredHeaders) {
    if (!headers.get(header)) {
      return { suspicious: true, reason: `Missing required header: ${header}` };
    }
  }
  
  // בדיקת תווים חשודים
  for (const [key, value] of headers.entries()) {
    if (SUSPICIOUS_CHARS.test(key) || SUSPICIOUS_CHARS.test(value)) {
      return { suspicious: true, reason: 'Suspicious characters in headers' };
    }
  }
  
  return { suspicious: false, reason: '' };
}

function analyzeRequestBody(body: string): { suspicious: boolean; reason: string } {
  try {
    const parsed = JSON.parse(body);
    
    // בדיקת nonce זהה בבקשות חוזרות
    if (parsed.nonce && typeof parsed.nonce === 'number') {
      // כאן יכולה להיות לוגיקה מתקדמת לזיהוי nonce חוזר
      // לדוגמה: בדיקת היסטוריית nonce ל-IP
    }
    
    // בדיקת ערכים לא סטנדרטיים
    if (parsed.amount && (typeof parsed.amount !== 'number' || parsed.amount <= 0)) {
      return { suspicious: true, reason: 'Invalid amount value' };
    }
    
    if (parsed.price && (typeof parsed.price !== 'number' || parsed.price <= 0)) {
      return { suspicious: true, reason: 'Invalid price value' };
    }
    
  } catch (e) {
    return { suspicious: true, reason: 'Invalid JSON body' };
  }
  
  return { suspicious: false, reason: '' };
}

function checkProgressiveBlock(ip: string): { blocked: boolean; reason: string } {
  const record = progressiveBlocking.get(ip);
  
  if (!record) {
    return { blocked: false, reason: '' };
  }
  
  if (record.blocked) {
    return { blocked: true, reason: 'IP already blocked' };
  }
  
  // בדיקת חלון זמן
  const now = Date.now();
  if (now - record.firstViolation > 24 * 60 * 60 * 1000) { // 24 שעות
    // איפוס אם חלפו 24 שעות
    progressiveBlocking.delete(ip);
    return { blocked: false, reason: '' };
  }
  
  // בדיקת סף חסימה
  if (record.count > 10) {
    record.blocked = true;
    logSecurityEvent({
      timestamp: new Date().toISOString(),
      ip,
      path: 'progressive-blocking',
      eventType: 'IP_BLOCKED',
      actionTaken: 'BLOCKED_IP',
      details: { violationCount: record.count }
    });
    return { blocked: true, reason: 'IP blocked due to repeated violations' };
  }
  
  return { blocked: false, reason: '' };
}

function incrementViolation(ip: string, eventType: string): void {
  const record = progressiveBlocking.get(ip) || {
    count: 0,
    firstViolation: Date.now(),
    blocked: false
  };
  
  record.count++;
  progressiveBlocking.set(ip, record);
  
  // רישום אירוע
  logSecurityEvent({
    timestamp: new Date().toISOString(),
    ip,
    path: 'progressive-blocking',
    eventType,
    actionTaken: 'RECORDED_VIOLATION',
    details: { violationCount: record.count }
  });
}

// ── המידלוור הראשי ──export async function middleware(request: NextRequest): Promise<NextResponse> {
  const ip = getIp(request);
  const pathname = request.nextUrl.pathname;
  const now = Date.now();
  
  // בדיקת חסימה הדרגתית
  const blockCheck = checkProgressiveBlock(ip);
  if (blockCheck.blocked) {
    return new NextResponse('Access denied: IP blocked', { 
      status: 403,
      headers: { 'X-Security-Reason': blockCheck.reason }
    });
  }
  
  // בדיקת נתיבים רגישים
  const isSensitivePath = SENSITIVE_PATHS.some(path => pathname.startsWith(path));
  
  // ניתוח כותרות
  const headerAnalysis = analyzeHeaders(request.headers);
  if (headerAnalysis.suspicious) {
    incrementViolation(ip, 'SUSPICIOUS_HEADERS');
    
    return new NextResponse('Access denied: Suspicious headers', { 
      status: 403,
      headers: { 'X-Security-Reason': headerAnalysis.reason }
    });
  }
  
  // ניתוג גוף הבקשה עבור נתיבים רגישים
  if (isSensitivePath && request.method !== 'GET') {
    try {
      const body = await request.text();
      const bodyAnalysis = analyzeRequestBody(body);
      
      if (bodyAnalysis.suspicious) {
        incrementViolation(ip, 'SUSPICIOUS_REQUEST_BODY');
        
        return new NextResponse('Access denied: Suspicious request body', { 
          status: 403,
          headers: { 'X-Security-Reason': bodyAnalysis.reason }
        });
      }
    } catch (e) {
      incrementViolation(ip, 'REQUEST_BODY_ERROR');
      
      return new NextResponse('Access denied: Error reading request body', { 
        status: 400,
        headers: { 'X-Security-Reason': 'Malformed request body' }
      });
    }
  }
  
  // יישום rate limiting מתקדם
  if (isSensitivePath && ADVANCED_RATE_LIMITS[pathname as keyof typeof ADVANCED_RATE_LIMITS]) {
    const limit = ADVANCED_RATE_LIMITS[pathname as keyof typeof ADVANCED_RATE_LIMITS];
    
    // כאן יכולה להיות לוגיקה מתקדמת של rate limiting
    // לדוגמה: שימוש ב-Redis או בזיכרון מפוצל
    // לצורך הדגמה, נשתמש ב-Map פשוט
    const rateLimitKey = `${ip}:${pathname}:${Math.floor(now / limit.windowMs)}`;
    const rateLimitCount = (globalThis as any).rateLimitMap?.get(rateLimitKey) || 0;
    
    if (rateLimitCount >= limit.maxRequests) {
      incrementViolation(ip, 'RATE_LIMIT_EXCEEDED');
      
      return new NextResponse('Too many requests', { 
        status: 429,
        headers: { 
          'X-Security-Reason': 'Rate limit exceeded',
          'Retry-After': Math.ceil(limit.windowMs / 1000).toString()
        }
      });
    }
    
    // עדכון ספירת rate limiting
    if (!(globalThis as any).rateLimitMap) {
      (globalThis as any).rateLimitMap = new Map();
    }
    (globalThis as any).rateLimitMap.set(rateLimitKey, rateLimitCount + 1);
    
    // ניקוי ישןים
    setInterval(() => {
      const now = Date.now();
      for (const key of (globalThis as any).rateLimitMap.keys()) {
        const timestamp = parseInt(key.split(':')[2]);
        if (now - timestamp > limit.windowMs) {
          (globalThis as any).rateLimitMap.delete(key);
        }
      }
    }, 60000);
  }
  
  // רישום בקשה רגילה
  logSecurityEvent({
    timestamp: new Date().toISOString(),
    ip,
    path: pathname,
    eventType: 'REQUEST_ALLOWED',
    actionTaken: 'ALLOWED',
    details: { method: request.method }
  });
  
  return NextResponse.next();
}

// ── פונקציית עזר לגישה ליומן האבטחה ──export function getSecurityLog(): SecurityEvent[] {
  return [...securityLog];
}

// ── פונקציית עזר לניקוי חסימות ישנות ──export function cleanupOldBlocks(): void {
  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  
  for (const [ip, record] of progressiveBlocking.entries()) {
    if (now - record.firstViolation > oneDayAgo) {
      progressiveBlocking.delete(ip);
    }
  }
}

// קריאה מתוזמנת לניקוי יומעים setInterval(cleanupOldBlocks, 60 * 60 * 1000); // כל שעה