import { NextRequest, NextResponse } from 'next/server';

// ── מנגנון ניתוח התנהגותי מתקדם לזיהוי דפוסי תקיפה ב-API קריטיים ──
// פיתוח: ניתוח התנהגותי + חסימה הדרגתית + לוגינג + התראות

// ── קבועי תצורה ──
const BEHAVIORAL_ANALYSIS_ENABLED = process.env.BEHAVIORAL_ANALYSIS_ENABLED === 'true';
const CRITICAL_APIS = ['/api/dex/settle', '/api/dex/transfer', '/api/dex/order'];
const ANALYSIS_WINDOW_MS = 60_000; // חלון ניתוח של 60 שניות
const SUSPICIOUS_THRESHOLD = 15; // סף חשד לפעילות חריגה
const BLOCK_DURATION = 300_000; // חסימה של 5 דקות
const MAX_REQUESTS_PER_IP = 50; // מכסה מרבית לפעילות נורמלית

// ── מאחסון בזיכרון למעקב אחר התנהגות (ביישום אמיתי יהיה Redis או DB) ──
const ipBehaviorMap = new Map<string, {
  requestCount: number;
  firstRequest: number;
  lastRequest: number;
  suspiciousPatterns: {
    rapidRequests: number;
    unusualEndpoints: Set<string>;
    repeatedNonces: Set<string>;
    suspiciousHeaders: Map<string, number>;
  };
  blockedUntil?: number;
}>();

// ── פונקציות עזר לניתוח התנהגות ──
function analyzeRequestBehavior(ip: string, pathname: string, headers: Headers, body: unknown) {
  const now = Date.now();
  
  // קבל או צור רשומת התנהגות ל-IP
  let behavior = ipBehaviorMap.get(ip);
  if (!behavior) {
    behavior = {
      requestCount: 0,
      firstRequest: now,
      lastRequest: now,
      suspiciousPatterns: {
        rapidRequests: 0,
        unusualEndpoints: new Set(),
        repeatedNonces: new Set(),
        suspiciousHeaders: new Map(),
      },
    };
    ipBehaviorMap.set(ip, behavior);
  }
  
  // עדכן נתוני בסיס
  behavior.requestCount++;
  behavior.lastRequest = now;
  
  // ניתוח דפוסים חשודים
  if (CRITICAL_APIS.includes(pathname)) {
    // בדיקת קצב בקשות מהיר
    if (now - behavior.lastRequest < 1_000) {
      behavior.suspiciousPatterns.rapidRequests++;
    }
    
    // זיהוי יעדים לא אופייניים (למשל: גישה חוזרת לאותו API בזמן קצר)
    if (behavior.suspiciousPatterns.unusualEndpoints.has(pathname)) {
      behavior.suspiciousPatterns.rapidRequests += 2;
    } else {
      behavior.suspiciousPatterns.unusualEndpoints.add(pathname);
    }
    
    // ניתוח כותרות חריגות
    const userAgent = headers.get('user-agent');
    if (userAgent && (userAgent.includes('bot') || userAgent.includes('crawler'))) {
      const current = behavior.suspiciousHeaders.get('user-agent') || 0;
      behavior.suspiciousHeaders.set('user-agent', current + 1);
    }
    
    // זיהוי נונסים חוזרים (אם קיים בבקשה)
    try {
      const bodyObj = body as Record<string, unknown>;
      if (bodyObj.nonce) {
        const nonce = String(bodyObj.nonce);
        if (behavior.suspiciousPatterns.repeatedNonces.has(nonce)) {
          behavior.suspiciousPatterns.rapidRequests += 3;
        } else {
          behavior.suspiciousPatterns.repeatedNonces.add(nonce);
        }
      }
    } catch (e) {
      // בדיקת גוף הבקשה נכשלה - נתעלם
    }
  }
  
  return behavior;
}

function assessThreatLevel(behavior: ReturnType<typeof analyzeRequestBehavior>): 'low' | 'medium' | 'high' | 'critical' {
  const { suspiciousPatterns } = behavior;
  const score = suspiciousPatterns.rapidRequests;
  
  if (score > 20) return 'critical';
  if (score > 15) return 'high';
  if (score > 10) return 'medium';
  return 'low';
}

function shouldBlockIp(ip: string, behavior: ReturnType<typeof analyzeRequestBehavior>): boolean {
  // בדיקה אם ה-IP כבר חסום
  if (behavior.blockedUntil && Date.now() < behavior.blockedUntil) {
    return true;
  }
  
  // בדיקת סף חשד
  const threatLevel = assessThreatLevel(behavior);
  return threatLevel === 'critical' || 
         (threatLevel === 'high' && behavior.requestCount > MAX_REQUESTS_PER_IP);
}

function blockIp(ip: string, duration: number = BLOCK_DURATION) {
  const behavior = ipBehaviorMap.get(ip);
  if (behavior) {
    behavior.blockedUntil = Date.now() + duration;
    
    // רישום התראה למערכת ניטור חיצונית
    logSecurityEvent({
      type: 'ip_blocked',
      ip,
      duration,
      reason: 'suspicious_behavior_detected',
      severity: 'high',
    });
  }
}

function logSecurityEvent(event: {
  type: string;
  ip: string;
  [key: string]: unknown;
}) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    ...event,
  };
  
  // לוג מקומי
  console.log(`[SECURITY] ${JSON.stringify(logEntry)}`);
  
  // התראה למערכת ניטור חיצונית (אם מוגדר)
  if (process.env.SECURITY_MONITORING_URL) {
    fetch(`${process.env.SECURITY_MONITORING_URL}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(logEntry),
    }).catch(err => console.warn(`Failed to send security event: ${err.message}`));
  }
}

// ── פונקציית ה-middleware המרכזית ──
export async function middleware(request: NextRequest) {
  // בדיקה אם המנגנון מופעל
  if (!BEHAVIORAL_ANALYSIS_ENABLED) {
    return NextResponse.next();
  }
  
  const { pathname } = request.nextUrl;
  const ip = request.ip || request.headers.get('x-forwarded-for') || 'unknown';
  
  // רק ניתוח ל-API קריטיים
  if (!CRITICAL_APIS.some(api => pathname.startsWith(api))) {
    return NextResponse.next();
  }
  
  try {
    // ניתוח התנהגות
    const body = await request.json().catch(() => ({}));
    const behavior = analyzeRequestBehavior(ip, pathname, request.headers, body);
    
    // הערכת איום
    const threatLevel = assessThreatLevel(behavior);
    
    // בדיקת הצורך בחסימה
    if (shouldBlockIp(ip, behavior)) {
      blockIp(ip);
      
      // רישום אירוע חסימה
      logSecurityEvent({
        type: 'request_blocked',
        ip,
        path: pathname,
        threatLevel,
        reason: 'suspicious_behavior_pattern',
        requestCount: behavior.requestCount,
      });
      
      return new NextResponse('Access denied due to suspicious activity', { 
        status: 429,
        headers: {
          'Retry-After': '300',
          'X-Security-Action': 'blocked',
          'X-Threat-Level': threatLevel,
        },
      });
    }
    
    // רישום אירוע חשוד (אם קיים)
    if (threatLevel !== 'low') {
      logSecurityEvent({
        type: 'suspicious_request',
        ip,
        path: pathname,
        threatLevel,
        requestCount: behavior.requestCount,
        suspiciousPatterns: {
          rapidRequests: behavior.suspiciousPatterns.rapidRequests,
          unusualEndpoints: Array.from(behavior.suspiciousPatterns.unusualEndpoints),
          repeatedNonces: Array.from(behavior.suspiciousPatterns.repeatedNonces),
          suspiciousHeaders: Object.fromEntries(behavior.suspiciousHeaders),
        },
      });
    }
    
    // הוספת כותרת עם נתוני אבטחה לבקשה המשך
    const response = NextResponse.next();
    response.headers.set('X-Security-Analyzed', 'true');
    response.headers.set('X-Threat-Level', threatLevel);
    response.headers.set('X-Request-Count', behavior.requestCount.toString());
    
    return response;
    
  } catch (error) {
    // במקרה של שגיאה, אפשר גישה אך רשום את האירוע
    console.error(`Behavioral analysis error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    
    logSecurityEvent({
      type: 'analysis_error',
      ip,
      path: pathname,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    
    return NextResponse.next();
  }
}

// ── ניקוי רקע של נתונים ישנים ──
// פונקציה לניקוי נתוני IP ישנים (מופעלת באופן תקופתי)
export function cleanupOldIpData() {
  const now = Date.now();
  const staleThreshold = now - 24 * 60 * 60 * 1000; // 24 שעות
  
  for (const [ip, behavior] of ipBehaviorMap.entries()) {
    if (behavior.lastRequest < staleThreshold) {
      ipBehaviorMap.delete(ip);
    }
  }
}

// הפעלת ניקוי תקופתי (ביישום אמיתי יש להגדיר זאת ב-Cron job)
if (typeof setInterval === 'function') {
  setInterval(cleanupOldIpData, 60 * 60 * 1000); // כל שעה
}
