import { NextRequest, NextResponse } from 'next/server';

// רשימת רשתות IP פנימיות מורשות (לפי CIDR)
const INTERNAL_IP_RANGES = [
  '10.0.0.0/8',     // RFC 1918 - Private network
  '172.16.0.0/12',   // RFC 1918 - Private network
  '192.168.0.0/16',  // RFC 1918 - Private network
  '127.0.0.0/8',     // Loopback
  '::1/128',         // IPv6 loopback
  'fc00::/7',        // IPv6 Unique Local Addresses
  'fe80::/10',       // IPv6 Link-Local
];

// מגבלות ה-rate-limit
const WINDOW_MS = 60_000;
const LIMIT_INTERNAL = 2_000;
const LIMIT_PUBLIC = 240;
const MAX_KEYS = 5_000;
const EXEMPT = ['/api/dex/stream', '/api/revive'];

// מצב מעקב דפוסים חשודים
const SUSPICIOUS_PATTERN_THRESHOLD = 10; // מספר המעברים המינימלי לסימון כחשוד
const SUSPICIOUS_PATTERN_WINDOW = 5 * 60_000; // 5 דקות
const ipPatternTracking = new Map<string, {
  internalCount: number;
  publicCount: number;
  lastSwitchTime: number | null;
  isFlagged: boolean;
}>();

// פונקציה לבדיקת אם IP הוא פנימי
function isInternalIp(ip: string): boolean {
  // פיצוח IPv6 לכתובת IPv4 אם זהו IPv4-mapped IPv6
  if (ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }

  // בדיקת כתובות IPv4 פנימיות
  const ipParts = ip.split('.').map(Number);
  if (ipParts.length === 4) {
    // 10.x.x.x
    if (ipParts[0] === 10) return true;
    // 172.16.x.x - 172.31.x.x
    if (ipParts[0] === 172 && ipParts[1] >= 16 && ipParts[1] <= 31) return true;
    // 192.168.x.x
    if (ipParts[0] === 192 && ipParts[1] === 168) return true;
    // 127.x.x.x (loopback)
    if (ipParts[0] === 127) return true;
  }

  // בדיקת כתובות IPv6 פנימיות
  if (ip.includes(':')) {
    // Loopback (::1)
    if (ip === '::1') return true;
    
    // Unique Local Addresses (fc00::/7)
    if (ip.startsWith('fc') || ip.startsWith('fd')) return true;
    
    // Link-Local (fe80::/10)
    if (ip.startsWith('fe80')) return true;
  }

  return false;
}

// פונקציה לזיהוי דפוסים חשודים
function detectSuspiciousPattern(ip: string, isInternal: boolean, now: number): boolean {
  let tracking = ipPatternTracking.get(ip);
  
  if (!tracking) {
    tracking = {
      internalCount: 0,
      publicCount: 0,
      lastSwitchTime: null,
      isFlagged: false
    };
    ipPatternTracking.set(ip, tracking);
  }

  // עדכון ספירת הבקשות
  if (isInternal) {
    tracking.internalCount++;
  } else {
    tracking.publicCount++;
  }

  // בדיקת מעבר בין סוגי בקשות
  const lastType = tracking.lastSwitchTime ? 
    (now - tracking.lastSwitchTime < 10_000 ? 
      (isInternal ? 'internal' : 'public') : null) : null;
  
  if (lastType) {
    const currentType = isInternal ? 'internal' : 'public';
    if (lastType !== currentType) {
      tracking.lastSwitchTime = now;
      
      // בדיקת סף החשד
      const totalRequests = tracking.internalCount + tracking.publicCount;
      if (totalRequests >= SUSPICIOUS_PATTERN_THRESHOLD) {
        tracking.isFlagged = true;
        
        // התראה על דפוס חשוד
        console.warn(JSON.stringify({
          timestamp: new Date(now).toISOString(),
          action: 'suspicious_pattern_detected',
          ip,
          internalCount: tracking.internalCount,
          publicCount: tracking.publicCount,
          note: 'Rapid switching between internal and public request patterns'
        }));
        
        return true;
      }
    }
  } else {
    tracking.lastSwitchTime = now;
  }

  // ניקוי רשומות ישנות
  if (now - (tracking.lastSwitchTime || 0) > SUSPICIOUS_PATTERN_WINDOW) {
    ipPatternTracking.delete(ip);
  }

  return false;
}

// פונקציה לקבלת ה-IP האמיתי של הלקוח
function getClientIp(request: NextRequest): string {
  // בדיקת X-Forwarded-For (האיבר האחרון הוא הקרוב ביותר לשרת)
  const xForwardedFor = request.headers.get('x-forwarded-for');
  if (xForwardedFor) {
    const ips = xForwardedFor.split(',').map(ip => ip.trim());
    return ips[ips.length - 1];
  }
  
  // בדיקת X-Real-IP
  const xRealIp = request.headers.get('x-real-ip');
  if (xRealIp) {
    return xRealIp;
  }
  
  // בדיקת ה-IP מהקונקשן
  return request.ip || 'unknown';
}

// מפת ספירת בקשות ל-rate-limit
const requestCounts = new Map<string, number>();

export function middleware(request: NextRequest) {
  const now = Date.now();
  const pathname = request.nextUrl.pathname;
  
  // פטור מ-rate-limit לנתיבים מסוימים
  if (EXEMPT.some(path => pathname.startsWith(path))) {
    return NextResponse.next();
  }
  
  // קבלת ה-IP האמיתי של הלקוח
  const clientIp = getClientIp(request);
  
  // קביעת סוג הבקשה (פנימית/ציבורית)
  const isInternal = isInternalIp(clientIp);
  const limit = isInternal ? LIMIT_INTERNAL : LIMIT_PUBLIC;
  
  // רישום לוג מפורט
  console.log(JSON.stringify({
    timestamp: new Date(now).toISOString(),
    action: 'request_received',
    ip: clientIp,
    isInternal,
    path: pathname,
    userAgent: request.headers.get('user-agent')
  }));
  
  // זיהוי דפוסים חשודים
  const isSuspicious = detectSuspiciousPattern(clientIp, isInternal, now);
  
  // ספירת בקשות ל-rate-limit
  const key = `${clientIp}:${isInternal ? 'internal' : 'public'}`;
  const count = requestCounts.get(key) || 0;
  
  if (count >= limit) {
    // רישום ניסיון חריגה מהמגבלה
    console.warn(JSON.stringify({
      timestamp: new Date(now).toISOString(),
      action: 'rate_limit_exceeded',
      ip: clientIp,
      isInternal,
      path: pathname,
      currentCount: count,
      limit
    }));
    
    // תגובת שגיאה 429 עם הסבר
    return new NextResponse(
      JSON.stringify({
        error: 'Rate limit exceeded',
        message: `Too many ${isInternal ? 'internal' : 'public'} requests from your IP. Try again later.`,
        ip: clientIp,
        isInternal,
        timestamp: new Date().toISOString()
      }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'X-Rate-Limit-Limit': limit.toString(),
          'X-Rate-Limit-Remaining': '0',
          'X-Rate-Limit-Reset': Math.ceil(now / 1000 + 60).toString()
        }
      }
    );
  }
  
  // עדכון ספירת הבקשות
  requestCounts.set(key, count + 1);
  
  // ניקוי ספירות ישנות
  requestCounts.forEach((_, key) => {
    const [ip, type] = key.split(':');
    const lastKey = `${ip}:${type}`;
    const lastCount = requestCounts.get(lastKey) || 0;
    
    if (lastCount > 0 && now - (lastCount * WINDOW_MS / limit) > WINDOW_MS) {
      requestCounts.set(lastKey, 0);
    }
  });
  
  // המשך לבקשה הקסומה
  return NextResponse.next();
}

// הגדרת הנתיבים שהמידלוור יופעל עליהם
export const config = {
  matcher: '/api/:path*',
};
