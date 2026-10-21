import { NextRequest, NextResponse } from 'next/server';

// ── ייבואים נדרשים ────────────────────────────────────────────────────
// Pino ללוגים (קיים בפרויקט) + כלים לניתוח ואחסון
import pino from 'pino';
const logger = pino({});

// ── טיפוסים למעקב התנהגות ────────────────────────────────────────────────
type UserBehavior = {
  ip: string;
  requests: {
    timestamp: number;
    path: string;
    method: string;
    headers: Record<string, string>;
    params: Record<string, string>;
    userAgent: string;
  }[];
  baseline: {
    pathFrequency: Record<string, number>;
    commonParams: Record<string, Record<string, number>>;
    userAgentPattern: string;
    sensitivePathAccess: Record<string, number>;
  };
  anomalies: number;
  lastAnomaly: number | null;
};

// ── קבועים ותצורה ────────────────────────────────────────────────────────
const BEHAVIOR_WINDOW_MS = 60_000; // חלון זמן לניתוח התנהגות (דקה)
const BASELINE_SIZE = 100; // כמות בקשות לבניית בסיס
const ANOMALY_THRESHOLD = 3; // כמות חריגות להתראה
const BLOCK_THRESHOLD = 5; // כמות חריגות לחסימה
const SENSITIVE_PATHS = [
  '/api/dex/settle',
  '/api/dex/transfer',
  '/api/dex/order',
  '/api/dex/cancel',
  '/api/dex/swap',
];

// ── אחסון זיכרוני להתנהגות משתמשים (בפרודקשן יש להחליף ב-Redis או דומה) ──
const userBehaviors = new Map<string, UserBehavior>();

// ── פונקציות עזר לניתוח התנהגות ────────────────────────────────────────
function updateBaseline(behavior: UserBehavior, request: UserBehavior['requests'][0]) {
  // עדכון תדירות נתיבים
  if (!behavior.baseline.pathFrequency[request.path]) {
    behavior.baseline.pathFrequency[request.path] = 0;
  }
  behavior.baseline.pathFrequency[request.path]++;

  // עדכון פרמטרים נפוצים
  if (!behavior.baseline.commonParams[request.path]) {
    behavior.baseline.commonParams[request.path] = {};
  }
  
  for (const [key, value] of Object.entries(request.params)) {
    if (!behavior.baseline.commonParams[request.path][key]) {
      behavior.baseline.commonParams[request.path][key] = 0;
    }
    behavior.baseline.commonParams[request.path][key]++;
  }

  // עדכון User-Agent בסיסי
  if (!behavior.baseline.userAgentPattern) {
    behavior.baseline.userAgentPattern = request.userAgent;
  }

  // עדכון גישה לנתיבים רגישים
  if (SENSITIVE_PATHS.includes(request.path)) {
    if (!behavior.baseline.sensitivePathAccess[request.path]) {
      behavior.baseline.sensitivePathAccess[request.path] = 0;
    }
    behavior.baseline.sensitivePathAccess[request.path]++;
  }
}

function detectAnomalies(behavior: UserBehavior, request: UserBehavior['requests'][0]): {
  type: 'frequency' | 'params' | 'headers' | 'sensitive' | 'userAgent';
  severity: 'low' | 'medium' | 'high';
  description: string;
} | null {
  const now = Date.now();
  const recentRequests = behavior.requests.filter(
    req => now - req.timestamp < BEHAVIOR_WINDOW_MS
  );

  // 1. ניתוח תדירות גבוהה לנתיב
  if (recentRequests.length > 30) {
    const pathFrequency = recentRequests.filter(req => req.path === request.path).length;
    if (pathFrequency > 15) {
      return {
        type: 'frequency',
        severity: 'medium',
        description: `High frequency requests to ${request.path}: ${pathFrequency} in last minute`
      };
    }
  }

  // 2. ניתוח פרמטרים לא טיפוסיים
  if (behavior.baseline.commonParams[request.path]) {
    for (const [key, value] of Object.entries(request.params)) {
      const commonValue = behavior.baseline.commonParams[request.path][key];
      if (commonValue && recentRequests.length > BASELINE_SIZE / 2) {
        const frequency = recentRequests.filter(
          req => req.params[key] === value
        ).length;
        
        if (frequency < 2 && commonValue > 5) {
          return {
            type: 'params',
            severity: 'medium',
            description: `Unusual parameter value for ${key}: ${value} (baseline: ${commonValue})`
          };
        }
      }
    }
  }

  // 3. ניתוכ כותרות חשודות
  if (request.userAgent.length > 200 || !request.userAgent.includes('Mozilla')) {
    return {
      type: 'headers',
      severity: 'high',
      description: `Suspicious User-Agent: ${request.userAgent}`
    };
  }

  // 4. גישה חוזרת לנתיבים רגישים
  if (SENSITIVE_PATHS.includes(request.path)) {
    const accessCount = behavior.baseline.sensitivePathAccess[request.path] || 0;
    if (accessCount > 10) {
      return {
        type: 'sensitive',
        severity: 'high',
        description: `Frequent access to sensitive path: ${request.path} (${accessCount} times)`
      };
    }
  }

  // 5. סטייה ב-User-Agent
  if (behavior.baseline.userAgentPattern && 
      request.userAgent !== behavior.baseline.userAgentPattern &&
      !request.userAgent.includes(behavior.baseline.userAgentPattern.split('/')[0])) {
    return {
      type: 'userAgent',
      severity: 'low',
      description: `User-Agent changed from baseline: ${behavior.baseline.userAgentPattern} -> ${request.userAgent}`
    };
  }

  return null;
}

function logAnomaly(ip: string, request: UserBehavior['requests'][0], anomaly: NonNullable<ReturnType<typeof detectAnomalies>>) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    event: 'behavior_anomaly',
    ip,
    path: request.path,
    method: request.method,
    anomalyType: anomaly.type,
    severity: anomaly.severity,
    description: anomaly.description,
    baseline: {
      pathFrequency: userBehaviors.get(ip)?.baseline.pathFrequency || {},
      userAgent: userBehaviors.get(ip)?.baseline.userAgentPattern || 'unknown',
    },
    requestDetails: {
      headers: request.headers,
      params: request.params,
      userAgent: request.userAgent,
    }
  };

  logger.warn(logEntry);
}

// ── פונקציית המידלוור המרכזית ─────────────────────────────────────────────
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const ip = request.headers.get('x-forwarded-for') || 'unknown';
  const path = request.nextUrl.pathname;
  const method = request.method;
  
  // פטורים קיימים (כמו במידלוור המקורי)
  const exemptPaths = ['/api/dex/stream', '/api/revive'];
  if (exemptPaths.some(exempt => path.startsWith(exempt))) {
    return NextResponse.next();
  }

  // קבלת נתוני בקשה
  const userAgent = request.headers.get('user-agent') || '';
  const params = Object.fromEntries(request.nextUrl.searchParams.entries());
  
  // קביעת סוג הבקשה (פנימית/ציבורית) - כמו במידלוור המקורי
  const isInternal = !request.headers.get('x-forwarded-for');
  const rateLimit = isInternal ? LIMIT_INTERNAL : LIMIT_PUBLIC;

  // אחזור או יצירת רשומת התנהגות
  let behavior = userBehaviors.get(ip);
  if (!behavior) {
    behavior = {
      ip,
      requests: [],
      baseline: {
        pathFrequency: {},
        commonParams: {},
        userAgentPattern: userAgent,
        sensitivePathAccess: {},
      },
      anomalies: 0,
      lastAnomaly: null,
    };
    userBehaviors.set(ip, behavior);
  }

  // הוספת הבקשה הנוכחית להיסטוריה
  const requestRecord = {
    timestamp: Date.now(),
    path,
    method,
    headers: Object.fromEntries(request.headers.entries()),
    params,
    userAgent,
  };
  
  behavior.requests.push(requestRecord);
  
  // ניקוי בקשות ישנות מעבר לחלון הזמן
  const now = Date.now();
  behavior.requests = behavior.requests.filter(req => now - req.timestamp < BEHAVIOR_WINDOW_MS);

  // בניית בסיס התנהגות (אם יש מספיק נתונים)
  if (behavior.requests.length > BASELINE_SIZE) {
    updateBaseline(behavior, requestRecord);
  }

  // ניתוח חריגות (רק אם יש בסיס)
  let anomaly = null;
  if (behavior.requests.length > BASELINE_SIZE) {
    anomaly = detectAnomalies(behavior, requestRecord);
    
    if (anomaly) {
      // רישום החריגה
      logAnomaly(ip, requestRecord, anomaly);
      behavior.anomalies++;
      behavior.lastAnomaly = now;
      
      // בדיקת סף חסימה
      if (behavior.anomalies >= BLOCK_THRESHOLD) {
        logger.error({
          timestamp: new Date().toISOString(),
          event: 'user_blocked',
          ip,
          path,
          anomalyCount: behavior.anomalies,
          reason: 'Exceeded anomaly threshold'
        });
        
        return new NextResponse('Behavior anomaly threshold exceeded', {
          status: 429,
          headers: {
            'Retry-After': '300',
            'Content-Type': 'application/json',
          },
        });
      }
      
      // התראה לאחר חריגה
      if (behavior.anomalies >= ANOMALY_THRESHOLD) {
        logger.warn({
          timestamp: new Date().toISOString(),
          event: 'behavior_warning',
          ip,
          path,
          anomalyCount: behavior.anomalies,
          anomalyType: anomaly.type,
        });
      }
    }
  }

  // המשך לביצוע הרגיל של המידלוור המקורי (rate limiting)
  // ... (קוד ה-rate-limit המקורי מהמידלוור הקיים)

  return NextResponse.next();
}

// ── ייצוא פונקציית המידלוור ─────────────────────────────────────────────
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};