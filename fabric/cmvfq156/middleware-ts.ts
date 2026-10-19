import { NextRequest, NextResponse } from 'next/server';

// ── מנגנון ניתוח התנהגותי בקובץ middleware.ts ──

// ניטור דפוסי בקשות אנומליים
const BEHAVIORAL_ANALYSIS = {
  // סף גילוי חריגות
  ANOMALY_THRESHOLDS: {
    REPEATED_PATHS: 3, // גישה חוזרת לאותו נתיב עם פרמטרים דומים
    SIMILAR_REQUESTS: 5, // רצף של בקשות דומות
    RATE_CHANGE_FACTOR: 2, // שינוי פתאומי בקצב הבקשות
    SUSPICIOUS_HEADERS: 2, // כמות כותרות חשודות
  },
  
  // נתיבים קריטיים לניטור
  CRITICAL_PATHS: [
    '/api/dex/settle',
    '/api/dex/transfer',
    '/api/dex/order',
    '/api/dex/cancel',
    '/api/dex/swap',
    '/api/dex/pool',
  ],
  
  // כותרות חשודות
  SUSPICIOUS_HEADERS: [
    'x-forwarded-for',
    'x-real-ip',
    'via',
    'x-cluster-client-ip',
    'cf-connecting-ip',
  ],
};

type RequestPattern = {
  ip: string;
  path: string;
  params: Record<string, string>;
  headers: Record<string, string>;
  timestamp: number;
};

type BehavioralMetrics = {
  requestCount: number;
  lastRequestTime: number;
  repeatedPaths: Map<string, number>;
  similarRequests: number;
  suspiciousHeaders: number;
  rateChange: number;
};

// מאחסן נתוני התנהגות לפי IP
const behavioralStore = new Map<string, BehavioralMetrics>();

// פונקציית עזר לניתור דפוסי בקשות
function analyzeRequestPattern(request: NextRequest, ip: string): {
  anomalyScore: number;
  anomalyType?: string;
} {
  const path = request.nextUrl.pathname;
  const params = Object.fromEntries(request.nextUrl.searchParams.entries());
  const headers: Record<string, string> = {};
  
  // בדיקת כותרות חשודות
  let suspiciousHeaders = 0;
  BEHAVIORAL_ANALYSIS.SUSPICIOUS_HEADERS.forEach(header => {
    if (request.headers.get(header)) {
      suspiciousHeaders++;
      headers[header] = request.headers.get(header)!;
    }
  });
  
  // חישוב ניקוד חריגות
  let anomalyScore = suspiciousHeaders;
  let anomalyType: string | undefined;
  
  // גילוי גישה חוזרת לנתיבים קריטיים
  if (BEHAVIORAL_ANALYSIS.CRITICAL_PATHS.includes(path)) {
    const now = Date.now();
    const metrics = behavioralStore.get(ip) || {
      requestCount: 0,
      lastRequestTime: 0,
      repeatedPaths: new Map(),
      similarRequests: 0,
      suspiciousHeaders: 0,
      rateChange: 1,
    };
    
    // בדיקת דפוס חוזר
    const pathKey = `${path}-${JSON.stringify(params)}`;
    const lastCount = metrics.repeatedPaths.get(pathKey) || 0;
    metrics.repeatedPaths.set(pathKey, lastCount + 1);
    
    if (lastCount >= BEHAVIORAL_ANALYSIS.ANOMALY_THRESHOLDS.REPEATED_PATHS) {
      anomalyScore += 3;
      anomalyType = 'REPEATED_PATHS';
    }
    
    // בדיקת קצב בקשות
    const timeDiff = now - metrics.lastRequestTime;
    if (timeDiff < 5000) { // פחות מ-5 שניות בין בקשות
      metrics.similarRequests++;
      
      if (metrics.similarRequests >= BEHAVIORAL_ANALYSIS.ANOMALY_THRESHOLDS.SIMILAR_REQUESTS) {
        anomalyScore += 2;
        anomalyType = 'SIMILAR_REQUESTS';
      }
    } else {
      metrics.similarRequests = 0;
    }
    
    // גילוי שינוי פתאומי בקצב
    if (metrics.rateChange > BEHAVIORAL_ANALYSIS.ANOMALY_THRESHOLDS.RATE_CHANGE_FACTOR) {
      anomalyScore += 2;
      anomalyType = 'RATE_CHANGE';
    }
    
    // עדכון מטריקות
    metrics.requestCount++;
    metrics.lastRequestTime = now;
    metrics.suspiciousHeaders = suspiciousHeaders;
    
    behavioralStore.set(ip, metrics);
  }
  
  return { anomalyScore, anomalyType };
}

// פונקציית עזר להפעלת פעולות הגנה
function applyProtection(request: NextRequest, ip: string, anomalyScore: number, anomalyType?: string): {
  response: NextResponse;
  action: 'ALLOW' | 'CHALLENGE' | 'BLOCK' | 'RATE_LIMIT';
} {
  const response = NextResponse.next();
  
  if (anomalyScore >= 5) {
    // חסימה מלאה
    return {
      response: new NextResponse('Access denied due to suspicious activity', { status: 403 }),
      action: 'BLOCK',
    };
  } else if (anomalyScore >= 3) {
    // בדיקת אימות נוספת
    response.headers.set('X-Security-Challenge', 'CAPTCHA_REQUIRED');
    return {
      response,
      action: 'CHALLENGE',
    };
  } else if (anomalyScore >= 2) {
    // הגבלת קצב מתקדמת
    response.headers.set('X-Rate-Limit', 'REDUCED');
    return {
      response,
      action: 'RATE_LIMIT',
    };
  }
  
  return {
    response,
    action: 'ALLOW',
  };
}

// מימוש המנגנון במידלוור
export function middleware(request: NextRequest) {
  // פטורים לניתוח (נתיבים ציבוריים וניטור)
  const EXEMPT_PATHS = [
    '/api/dex/stream',
    '/api/revive',
    '/api/health',
  ];
  
  if (EXEMPT_PATHS.includes(request.nextUrl.pathname)) {
    return NextResponse.next();
  }
  
  // זיהוי IP
  const forwardedFor = request.headers.get('x-forwarded-for');
  const realIp = request.headers.get('x-real-ip');
  const ip = forwardedFor ? forwardedFor.split(',')[0].trim() : realIp || 'unknown';
  
  // ניתור התנהגות
  const { anomalyScore, anomalyType } = analyzeRequestPattern(request, ip);
  
  // דיווח על חריגות
  if (anomalyScore > 0) {
    console.warn(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        action: 'behavioral_anomaly_detected',
        ip,
        path: request.nextUrl.pathname,
        anomalyType,
        anomalyScore,
        headers: Object.fromEntries(request.headers.entries()),
        params: Object.fromEntries(request.nextUrl.searchParams.entries()),
      })
    );
  }
  
  // הפעלת פעולות הגנה
  const { response, action } = applyProtection(request, ip, anomalyScore, anomalyType);
  
  // הוספת מידע לכותרות למעקב
  response.headers.set('X-Security-Action', action);
  response.headers.set('X-Anomaly-Score', anomalyScore.toString());
  
  return response;
}

// ניקוי סדיר של נתוני התנהגות (כל 5 דקות)
setInterval(() => {
  const now = Date.now();
  const EXPIRY_TIME = 30 * 60 * 1000; // 30 דקות
  
  for (const [ip, metrics] of behavioralStore.entries()) {
    if (now - metrics.lastRequestTime > EXPIRY_TIME) {
      behavioralStore.delete(ip);
    }
  }
}, 5 * 60 * 1000); // כל 5 דקות