import { NextRequest, NextResponse } from 'next/server';

// ── מנגנון ניתוח התנהגותי מתקדם ──

// טיפוסים למערכת ניתוח התנהגות
interface BehaviorMetrics {
  ip: string;
  userAgent: string;
  requestCount: number;
  lastRequest: number;
  endpointHits: Map<string, number>;
  suspiciousPatterns: {
    rapidRepeats: number;
    parameterVariation: number;
    headerAnomalies: number;
  };
  blockedUntil?: number;
}

// תצורת גבולות לניתוח התנהגות
const BEHAVIOR_CONFIG = {
  // גבולות לזיהוי חריגות
  MAX_REQUESTS_PER_MINUTE: 300,
  MAX_ENDPOINT_HITS_PER_MINUTE: 50,
  MAX_RAPID_REPEATS: 10,
  MAX_PARAMETER_VARIATION: 20,
  MAX_HEADER_ANOMALIES: 5,
  
  // חסימה הדרגתית
  BLOCK_DURATION_MS: 60 * 60 * 1000, // 1 שעה
  WARNING_THRESHOLD: 3,
  
  // נקודות קצה רגישות לניטור מוגבר
  SENSITIVE_ENDPOINTS: [
    '/api/dex/order',
    '/api/dex/settle',
    '/api/dex/transfer',
    '/api/dex/swap',
    '/api/dex/pool',
    '/api/dex/wallets',
    '/api/dex/portfolio'
  ],
  
  // כותרות חשודות לניטור
  SUSPICIOUS_HEADERS: [
    'x-forwarded-for',
    'x-real-ip',
    'via',
    'x-cluster-client-ip',
    'connection',
    'cache-control',
    'accept-encoding'
  ],
  
  // פרמטרים לא טיפוסיים לניטור
  SUSPICIOUS_PARAMETERS: [
    'script',
    'javascript',
    'onload',
    'onerror',
    'onclick',
    'eval',
    'iframe',
    'object',
    'embed',
    'formaction'
  ]
};

// אחסון בזיכרון למטרים לדמו (בייצור ישתמשו ב-Redis או מסד נתונים)
const behaviorStore = new Map<string, BehaviorMetrics>();

// פונקציית עזר לניקוי נתונים ישנים
function cleanupOldMetrics(): void {
  const now = Date.now();
  for (const [key, metrics] of behaviorStore.entries()) {
    if (now - metrics.lastRequest > 5 * 60 * 1000) { // 5 דקות
      behaviorStore.delete(key);
    }
  }
}

// פונקציית עזר לזיהוי IP אמיתי
function getRealIp(request: NextRequest): string {
  // העדפת IP אמיתי על פני X-Forwarded-For
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    // לוקח את ה-IP האחרון ברשימה (הקרוב ביותר לשרת)
    const ips = forwardedFor.split(',').map(ip => ip.trim());
    return ips[ips.length - 1];
  }
  
  return request.ip || 'unknown';
}

// פונקציית עזר לניתוח פרמטרים חשודים
function analyzeParameters(url: string): number {
  try {
    const params = new URL(url).searchParams;
    let suspiciousCount = 0;
    
    for (const [key, value] of params.entries()) {
      const lowerKey = key.toLowerCase();
      const lowerValue = value.toLowerCase();
      
      // בדיקה לפרמטרים חשודים
      if (BEHAVIOR_CONFIG.SUSPICIOUS_PARAMETERS.some(param => 
          lowerKey.includes(param) || lowerValue.includes(param))) {
        suspiciousCount++;
      }
      
      // בדיקה לניסיונות SQL injection
      if (/[\'"\;\-\-\(\)\=\<\>\{\}]/.test(value)) {
        suspiciousCount += 2;
      }
    }
    
    return suspiciousCount;
  } catch {
    return 0;
  }
}

// פונקציית עזר לניתוח כותרות חשודות
function analyzeHeaders(headers: Headers): number {
  let suspiciousCount = 0;
  
  for (const [key, value] of headers.entries()) {
    const lowerKey = key.toLowerCase();
    const lowerValue = value.toLowerCase();
    
    // בדיקה לכותרות חשודות
    if (BEHAVIOR_CONFIG.SUSPICIOUS_HEADERS.includes(lowerKey)) {
      suspiciousCount++;
    }
    
    // בדיקה לניסיונות זיוף IP
    if (lowerKey === 'x-forwarded-for' && 
        lowerValue.includes(',')) {
      suspiciousCount += 2;
    }
    
    // בדיקה ל-user agents חשודים
    if (lowerKey === 'user-agent' && 
        (lowerValue.includes('bot') || 
         lowerValue.includes('crawler') ||
         lowerValue.includes('spider') ||
         lowerValue.includes('scanner'))) {
      suspiciousCount++;
    }
  }
  
  return suspiciousCount;
}

// פונקציית עזר לניתוח דפוסי חזרה מהירה
function analyzeRapidRepeats(request: NextRequest, metrics: BehaviorMetrics): number {
  const now = Date.now();
  const recentRequests = Array.from(metrics.endpointHits.entries())
    .filter(([endpoint, count]) => {
      return count > 1 && BEHAVIOR_CONFIG.SENSITIVE_ENDPOINTS.includes(endpoint);
    })
    .reduce((sum, [, count]) => sum + count, 0);
  
  return recentRequests;
}

// פונקציית עזר לרישום אירועי אבטחה
function logSecurityEvent(event: {
  type: 'BLOCKED' | 'WARNING' | 'SUSPICIOUS';
  ip: string;
  endpoint: string;
  userAgent: string;
  metrics: Partial<BehaviorMetrics>;
  reason: string;
}): void {
  // ביישום אמיתי, יש לשלוח למערכת ניטור כמו ELK, Splunk, וכו'
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    event_type: 'security_event',
    ...event
  }));
}

// פונקציית עזר להחלטה על חסימה
function shouldBlock(metrics: BehaviorMetrics): boolean {
  const now = Date.now();
  
  // בדיקה אם כבר חסום
  if (metrics.blockedUntil && now < metrics.blockedUntil) {
    return true;
  }
  
  // בדיקת גבולות
  const totalRequests = metrics.requestCount;
  const endpointHits = Array.from(metrics.endpointHits.values())
    .reduce((sum, count) => sum + count, 0);
  
  if (totalRequests > BEHAVIOR_CONFIG.MAX_REQUESTS_PER_MINUTE ||
      endpointHits > BEHAVIOR_CONFIG.MAX_ENDPOINT_HITS_PER_MINUTE ||
      metrics.suspiciousPatterns.rapidRepeats > BEHAVIOR_CONFIG.MAX_RAPID_REPEATS ||
      metrics.suspiciousPatterns.parameterVariation > BEHAVIOR_CONFIG.MAX_PARAMETER_VARIATION ||
      metrics.suspiciousPatterns.headerAnomalies > BEHAVIOR_CONFIG.MAX_HEADER_ANOMALIES) {
    return true;
  }
  
  return false;
}

// פונקציית עזר להחלטה על התראה
function shouldWarn(metrics: BehaviorMetrics): boolean {
  const now = Date.now();
  
  // בדיקת גבולות להתראה (חסר קצת מהגבולות לחסימה)
  const totalRequests = metrics.requestCount;
  const endpointHits = Array.from(metrics.endpointHits.values())
    .reduce((sum, count) => sum + count, 0);
  
  if (totalRequests > BEHAVIOR_CONFIG.MAX_REQUESTS_PER_MINUTE * 0.8 ||
      endpointHits > BEHAVIOR_CONFIG.MAX_ENDPOINT_HITS_PER_MINUTE * 0.8 ||
      metrics.suspiciousPatterns.rapidRepeats > BEHAVIOR_CONFIG.MAX_RAPID_REPEATS * 0.8 ||
      metrics.suspiciousPatterns.parameterVariation > BEHAVIOR_CONFIG.MAX_PARAMETER_VARIATION * 0.8 ||
      metrics.suspiciousPatterns.headerAnomalies > BEHAVIOR_CONFIG.MAX_HEADER_ANOMALIES * 0.8) {
    return true;
  }
  
  return false;
}

// הפונקציה הראשית של המידלוור
export async function middleware(request: NextRequest): Promise<NextResponse> {
  // ניקוי נתונים ישנים מדי פעם
  if (Math.random() < 0.01) {
    cleanupOldMetrics();
  }
  
  // קבלת IP אמיתי
  const ip = getRealIp(request);
  const userAgent = request.headers.get('user-agent') || 'unknown';
  const url = request.url;
  const pathname = new URL(url).pathname;
  
  // אחזור או יצירת מטריקות התנהגות
  const key = `${ip}:${userAgent}`;
  let metrics = behaviorStore.get(key);
  
  if (!metrics) {
    metrics = {
      ip,
      userAgent,
      requestCount: 0,
      lastRequest: Date.now(),
      endpointHits: new Map(),
      suspiciousPatterns: {
        rapidRepeats: 0,
        parameterVariation: 0,
        headerAnomalies: 0
      }
    };
    behaviorStore.set(key, metrics);
  }
  
  // עדכון מטריקות
  const now = Date.now();
  metrics.lastRequest = now;
  metrics.requestCount++;
  
  // עדכון ספירת נקודות קצה
  const currentEndpointCount = metrics.endpointHits.get(pathname) || 0;
  metrics.endpointHits.set(pathname, currentEndpointCount + 1);
  
  // ניתוח דפוסים חשודים
  metrics.suspiciousPatterns.parameterVariation += analyzeParameters(url);
  metrics.suspiciousPatterns.headerAnomalies += analyzeHeaders(request.headers);
  metrics.suspiciousPatterns.rapidRepeats = analyzeRapidRepeats(request, metrics);
  
  // החלטה על חסימה או התראה
  const block = shouldBlock(metrics);
  const warn = shouldWarn(metrics);
  
  // טיפול בחסימה
  if (block) {
    metrics.blockedUntil = now + BEHAVIOR_CONFIG.BLOCK_DURATION_MS;
    
    logSecurityEvent({
      type: 'BLOCKED',
      ip,
      endpoint: pathname,
      userAgent,
      metrics: {
        requestCount: metrics.requestCount,
        suspiciousPatterns: metrics.suspiciousPatterns
      },
      reason: 'Behavior threshold exceeded'
    });
    
    return new NextResponse('Access denied due to suspicious activity', {
      status: 429,
      headers: {
        'Retry-After': Math.floor(BEHAVIOR_CONFIG.BLOCK_DURATION_MS / 1000).toString(),
        'X-Reason': 'suspicious_behavior',
        'Content-Type': 'application/json'
      }
    });
  }
  
  // טיפול בהתראה (לא חוסם אלא רק רושם)
  if (warn) {
    logSecurityEvent({
      type: 'WARNING',
      ip,
      endpoint: pathname,
      userAgent,
      metrics: {
        requestCount: metrics.requestCount,
        suspiciousPatterns: metrics.suspiciousPatterns
      },
      reason: 'Approaching behavior threshold'
    });
  }
  
  // עדכון המאגר
  behaviorStore.set(key, metrics);
  
  // המשך לבקשה הרגילה
  return NextResponse.next();
}

// ניתון גישה לנתיבים מסוימים ללא ניתוח
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|api/revive).*)',
  ],
};
