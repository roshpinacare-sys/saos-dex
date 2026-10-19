import { NextRequest, NextResponse } from 'next/server';

// ── טיפוסים וממשקים ────────────────────────────────────────────────────────
type EndpointKey = string;
type IpAddress = string;

interface RequestLog {
  timestamp: number;
  endpoint: EndpointKey;
  ip: IpAddress;
  userAgent?: string;
  referer?: string;
  body: string;
}

interface EndpointStats {
  count: number;
  recentRequests: RequestLog[];
  averageRate: number;
  lastSpikeAlert?: number;
}

interface BehavioralAnomaly {
  type: 'rate_spike' | 'repeated_request' | 'suspicious_headers' | 'endpoint_spike';
  ip: IpAddress;
  endpoint: EndpointKey;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  timestamp: number;
}

// ── קבועים והגדרות ──────────────────────────────────────────────────────────
const WINDOW_MS = 60_000; // חלון זמן של דקה
const MAX_LOG_ENTRIES = 100; // מספר הבקשות המרבי לשמירה לניתוח
const SPIKE_MULTIPLIER = 10; // כפולות הגידול לזיהוי ספייק
const REPEAT_THRESHOLD = 3; // סף חזרות על בקשה זהה
const HEADER_SUSPICIOUS_PATTERNS = [
  /bot/i,
  /crawler/i,
  /scanner/i,
  /\b(\d{1,3}\.){3}\d{1,3}\b/ // כתובות IP ב-User-Agent
];

// ── מצב גלובלי (בפועל, יהיה במטמון חיצוני בסביבת הפקודה) ───────────────────
const requestLogs = new Map<IpAddress, RequestLog[]>();
const endpointStats = new Map<EndpointKey, EndpointStats>();
const blockedIps = new Set<IpAddress>();
const blockDurations = new Map<IpAddress, number>();

// ── פונקציות עזר ────────────────────────────────────────────────────────────
function getCurrentTime(): number {
  return Date.now();
}

function cleanupOldData(): void {
  const now = getCurrentTime();
  
  // ניקוי רשימות בקשות ישנות
  for (const [ip, logs] of requestLogs.entries()) {
    const recentLogs = logs.filter(log => now - log.timestamp < WINDOW_MS);
    if (recentLogs.length !== logs.length) {
      requestLogs.set(ip, recentLogs);
    }
    
    if (recentLogs.length === 0) {
      requestLogs.delete(ip);
    }
  }
  
  // ניקוי סטטיסטיקות נקודות קצה ישנות
  for (const [endpoint, stats] of endpointStats.entries()) {
    const recentRequests = stats.recentRequests.filter(
      req => now - req.timestamp < WINDOW_MS
    );
    
    if (recentRequests.length !== stats.recentRequests.length) {
      endpointStats.set(endpoint, {
        ...stats,
        recentRequests,
        count: recentRequests.length,
        averageRate: recentRequests.length / (WINDOW_MS / 1000)
      });
    }
    
    if (recentRequests.length === 0) {
      endpointStats.delete(endpoint);
    }
  }
  
  // בדיקת חסימות שפג תוקפן
  for (const [ip, unblockTime] of blockDurations.entries()) {
    if (now > unblockTime) {
      blockedIps.delete(ip);
      blockDurations.delete(ip);
    }
  }
}

function logAnomaly(anomaly: BehavioralAnomaly): void {
  const logEntry = {
    timestamp: new Date(anomaly.timestamp).toISOString(),
    type: anomaly.type,
    ip: anomaly.ip,
    endpoint: anomaly.endpoint,
    severity: anomaly.severity,
    description: anomaly.description
  };
  
  console.log('[BEHAVIORAL_ANOMALY]', JSON.stringify(logEntry));
  
  // כאן ניתן להוסיף לוגים למערכת חיצונית, כגון:
  // - שליחה ל-Sentry
  // - שמירה ב-DB
  // - התראות לצוות אבטחה
}

function isSuspiciousHeaders(headers: Headers): boolean {
  const userAgent = headers.get('User-Agent') || '';
  const referer = headers.get('Referer') || '';
  
  // בדיקת User-Agent
  for (const pattern of HEADER_SUSPICIOUS_PATTERNS) {
    if (pattern.test(userAgent)) {
      return true;
    }
  }
  
  // בדיקת Referer ריק עם User-Agent סטנדרטי חשוד
  if (!referer && userAgent.includes('Mozilla/') === false) {
    return true;
  }
  
  return false;
}

function detectRepeatedRequests(logs: RequestLog[]): boolean {
  if (logs.length < REPEAT_THRESHOLD) return false;
  
  // בדיקת חזרות על אותם פרמטרים בתוך חלון זמן קצר
  const recentLogs = logs.filter(log => getCurrentTime() - log.timestamp < 5000);
  if (recentLogs.length < REPEAT_THRESHOLD) return false;
  
  // בדיקת חזרות על גוף הבקשה (הפשט - ביישום מלא יש להוסיף נרמול)
  const bodyCounts = new Map<string, number>();
  
  for (const log of recentLogs) {
    const count = bodyCounts.get(log.body) || 0;
    bodyCounts.set(log.body, count + 1);
    
    if (count + 1 >= REPEAT_THRESHOLD) {
      return true;
    }
  }
  
  return false;
}

function detectRateSpike(currentRate: number, endpoint: EndpointKey): boolean {
  const stats = endpointStats.get(endpoint);
  if (!stats || stats.count < 5) return false; // לא מספיק נתונים
  
  const spikeThreshold = stats.averageRate * SPIKE_MULTIPLIER;
  return currentRate > spikeThreshold;
}

function detectEndpointSpike(ip: IpAddress, endpoint: EndpointKey): boolean {
  const logs = requestLogs.get(ip) || [];
  const endpointLogs = logs.filter(log => log.endpoint === endpoint);
  
  if (endpointLogs.length < 5) return false; // לא מספיק נתונים
  
  const endpointRate = endpointLogs.length / (WINDOW_MS / 1000);
  const overallRate = logs.length / (WINDOW_MS / 1000);
  
  // אם קצב הבקשות לנקודת קצה ספציפית גבוה פי 5 מהקצב הכללי
  return endpointRate > overallRate * 5;
}

function blockIp(ip: IpAddress, duration: number): void {
  blockedIps.add(ip);
  blockDurations.set(ip, getCurrentTime() + duration);
  
  logAnomaly({
    type: 'endpoint_spike',
    ip,
    endpoint: 'general',
    severity: 'high',
    description: `IP blocked for ${duration}ms due to suspicious behavior`,
    timestamp: getCurrentTime()
  });
}

// ── פונקציית ה-middleware הראשית ─────────────────────────────────────────────
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const now = getCurrentTime();
  const ip = request.ip || 'unknown';
  const endpoint = request.nextUrl.pathname;
  
  // בדיקת חסימות קיימות
  if (blockedIps.has(ip)) {
    const unblockTime = blockDurations.get(ip) || 0;
    if (now < unblockTime) {
      return new NextResponse('Access temporarily blocked', { 
        status: 429,
        headers: { 
          'X-Block-Reason': 'suspicious_behavior',
          'Retry-After': Math.ceil((unblockTime - now) / 1000).toString()
        }
      });
    } else {
      // הסרת החסימה אם פג תוקפה
      blockedIps.delete(ip);
      blockDurations.delete(ip);
    }
  }
  
  // ניקוי נתונים ישנים מדי פעם
  if (Math.random() < 0.01) {
    cleanupOldData();
  }
  
  // רישום הבקשה
  const requestLog: RequestLog = {
    timestamp: now,
    endpoint,
    ip,
    userAgent: request.headers.get('User-Agent'),
    referer: request.headers.get('Referer'),
    body: await request.text()
  };
  
  // עדכון רשימות הבקשות
  const ipLogs = requestLogs.get(ip) || [];
  ipLogs.push(requestLog);
  
  // שמירת רק כמות מוגבלת של בקשות
  if (ipLogs.length > MAX_LOG_ENTRIES) {
    ipLogs.splice(0, ipLogs.length - MAX_LOG_ENTRIES);
  }
  
  requestLogs.set(ip, ipLogs);
  
  // עדכון סטטיסטיקות נקודות קצה
  const endpointStat = endpointStats.get(endpoint) || {
    count: 0,
    recentRequests: [],
    averageRate: 0
  };
  
  endpointStat.count++;
  endpointStat.recentRequests.push(requestLog);
  
  // חישוב קצב ממוצע מחדש
  const recentEndpointRequests = endpointStat.recentRequests.filter(
    req => now - req.timestamp < WINDOW_MS
  );
  
  endpointStats.set(endpoint, {
    ...endpointStat,
    recentRequests: recentEndpointRequests,
    averageRate: recentEndpointRequests.length / (WINDOW_MS / 1000)
  });
  
  // זיהוי חריגות התנהגותיות
  const anomalies: BehavioralAnomaly[] = [];
  
  // 1. זיהוי שינויים פתאומיים בקצב הבקשות
  const ipRate = ipLogs.length / (WINDOW_MS / 1000);
  if (detectRateSpike(ipRate, endpoint)) {
    anomalies.push({
      type: 'rate_spike',
      ip,
      endpoint,
      severity: 'medium',
      description: `Request rate spike detected: ${ipRate.toFixed(2)} req/s`,
      timestamp: now
    });
  }
  
  // 2. זיהוי רצפי בקשות חוזרות
  if (detectRepeatedRequests(ipLogs)) {
    anomalies.push({
      type: 'repeated_request',
      ip,
      endpoint,
      severity: 'medium',
      description: 'Repeated identical requests detected',
      timestamp: now
    });
  }
  
  // 3. זיהוי כותרות בקשות חשודות
  if (isSuspiciousHeaders(request.headers)) {
    anomalies.push({
      type: 'suspicious_headers',
      ip,
      endpoint,
      severity: 'low',
      description: 'Suspicious request headers detected',
      timestamp: now
    });
  }
  
  // 4. זיהוי ספייק בנקודת קצה ספציפית
  if (detectEndpointSpike(ip, endpoint)) {
    anomalies.push({
      type: 'endpoint_spike',
      ip,
      endpoint,
      severity: 'high',
      description: `Unusual spike in requests to ${endpoint}`,
      timestamp: now
    });
  }
  
  // טיפול בחריגות
  for (const anomaly of anomalies) {
    logAnomaly(anomaly);
    
    // חסימה הדרגתית לחריגות ברמה גבוהה וקריטית
    if (anomaly.severity === 'high' || anomaly.severity === 'critical') {
      const duration = anomaly.severity === 'critical' ? 300_000 : 60_000; // 5 דקות / 1 דקה
      blockIp(ip, duration);
      
      return new NextResponse('Access temporarily blocked', { 
        status: 429,
        headers: { 
          'X-Block-Reason': 'suspicious_behavior',
          'Retry-After': Math.ceil(duration / 1000).toString()
        }
      });
    }
  }
  
  // המשך לבקשה רגילה אם אין חסימה
  return NextResponse.next();
}

// ── ניתוב ───────────────────────────────────────────────────────────────────
export const config = {
  matcher: [
    '/api/dex/:path*',
    '/api/revive/:path*'
  ]
};
