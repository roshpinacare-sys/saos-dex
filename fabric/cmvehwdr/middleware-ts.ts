import { NextRequest, NextResponse } from 'next/server';

/**
 * middleware.ts — מנגנון ניתוח התנהגותי מתקדם עם פרופילים דינמיים
 * ═════════════════════════════════════════════════════════════════════════════════════
 * זיהוי חריגות התנהגותיות בזמן אמת וחסימה הדרגתית לפי היסטוריית IP/משתמש
 * החליף את מנגנון ה-rate-limiting הקיים במלואו (EXEC-CD-44).
 */

// ── סוגי חריגות ופעולות ────────────────────────────────────────────────────────
type AnomalyType = 'request_spike' | 'unusual_path' | 'repeated_params' | 'unusual_headers';
type Action = 'warn' | 'block_5m' | 'block_30m';

// ── תצורה גלובלית ───────────────────────────────────────────────────────────────
const WINDOW_MS = 5 * 60 * 1000; // 5 דקות
const SPIKE_THRESHOLD = 2.0; // >200% מהממוצע
const PATH_SIGMA = 3; // >3 סטיות סטנדרטיות
const PARAM_REPEAT_THRESHOLD = 10; // >10 בקשות עם אותו nonce
const HEADER_SIGMA = 5; // >5 סטיות סטנדרטיות

// ── פרופיל התנהגותי ל-IP ───────────────────────────────────────────────────────
interface BehaviorProfile {
  ip: string;
  requestCount: number;
  paths: Map<string, number>;
  avgRequestInterval: number;
  lastRequestTime: number;
  paramPatterns: Map<string, number>; // nonce -> count
  headerEntropy: number;
  anomalies: number;
  lastAction?: Action;
  lastActionTime?: number;
}

// ── ניהול פרופילים ───────────────────────────────────────────────────────────────
const profiles = new Map<string, BehaviorProfile>();
const MAX_PROFILES = 10000;

function getOrCreateProfile(ip: string): BehaviorProfile {
  let profile = profiles.get(ip);
  if (!profile) {
    profile = {
      ip,
      requestCount: 0,
      paths: new Map(),
      avgRequestInterval: 0,
      lastRequestTime: Date.now(),
      paramPatterns: new Map(),
      headerEntropy: 0,
      anomalies: 0,
    };
    profiles.set(ip, profile);
    
    // שמירה על גודל קבוע
    if (profiles.size > MAX_PROFILES) {
      const oldest = profiles.keys().next().value;
      if (oldest) profiles.delete(oldest);
    }
  }
  return profile;
}

// ── חישוב סטיות סטנדרטיות ───────────────────────────────────────────────────────
function calculateSigma(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
  return Math.sqrt(variance);
}

// ── זיהוי חריגות ───────────────────────────────────────────────────────────────
function detectAnomalies(profile: BehaviorProfile, req: NextRequest): AnomalyType | null {
  const now = Date.now();
  const path = req.nextUrl.pathname;
  
  // 1. קפיצה פתאומית בקצב הבקשות
  if (profile.requestCount > 10) {
    const timeDiff = now - profile.lastRequestTime;
    const currentRate = 60000 / timeDiff; // בקשות לדקה
    const historicalRate = 60000 / profile.avgRequestInterval;
    
    if (currentRate > historicalRate * SPIKE_THRESHOLD) {
      return 'request_spike';
    }
  }
  
  // 2. נתיבים לא אופייניים
  const pathCounts = Array.from(profile.paths.values());
  if (pathCounts.length > 5) {
    const pathSigma = calculateSigma(pathCounts);
    const pathAvg = pathCounts.reduce((a, b) => a + b, 0) / pathCounts.length;
    
    if (profile.paths.get(path) && Math.abs(profile.paths.get(path)! - pathAvg) > PATH_SIGMA * pathSigma) {
      return 'unusual_path';
    }
  }
  
  // 3. פרמטרים חוזרים
  const searchParams = req.nextUrl.searchParams;
  const nonce = searchParams.get('nonce');
  
  if (nonce) {
    const currentCount = profile.paramPatterns.get(nonce) || 0;
    profile.paramPatterns.set(nonce, currentCount + 1);
    
    if (currentCount + 1 > PARAM_REPEAT_THRESHOLD) {
      return 'repeated_params';
    }
  }
  
  // 4. כותרות חריגות
  const headers = Array.from(req.headers.entries());
  if (headers.length > 0) {
    const headerValues = headers.map(([_, value]) => {
      // פישוט ערכי הכותרות לחישוב אנטרופיה
      return value.replace(/\d+/g, 'X').replace(/\.[a-zA-Z]+/g, '.X');
    });
    
    const headerSigma = calculateSigma(headerValues.map(v => v.length));
    const headerAvg = headerValues.reduce((sum, val) => sum + val.length, 0) / headerValues.length;
    
    const currentHeaderEntropy = headers.reduce((entropy, [key, value]) => {
      // חישוב אנטרופיה מוגברת לכותרות
      const normalizedValue = value.replace(/\d+/g, 'X').replace(/\.[a-zA-Z]+/g, '.X');
      return entropy + normalizedValue.length;
    }, 0);
    
    profile.headerEntropy = currentHeaderEntropy;
    
    if (Math.abs(currentHeaderEntropy - headerAvg) > HEADER_SIGMA * headerSigma) {
      return 'unusual_headers';
    }
  }
  
  return null;
}

// ── חסימה הדרגתית ───────────────────────────────────────────────────────────────
function getAction(profile: BehaviorProfile, anomalyType: AnomalyType): Action {
  profile.anomalies++;
  
  if (profile.anomalies === 1) {
    return 'warn';
  } else if (profile.anomalies === 2) {
    return 'block_5m';
  } else {
    return 'block_30m';
  }
}

// ── עדכון פרופיל ───────────────────────────────────────────────────────────────
function updateProfile(profile: BehaviorProfile, req: NextRequest) {
  const now = Date.now();
  const path = req.nextUrl.pathname;
  
  // עדכון ספירת בקשות
  profile.requestCount++;
  
  // עדכון נתיבים
  const pathCount = (profile.paths.get(path) || 0) + 1;
  profile.paths.set(path, pathCount);
  
  // עדכון ממוצע זמן בין בקשות
  if (profile.lastRequestTime) {
    const interval = now - profile.lastRequestTime;
    profile.avgRequestInterval = (profile.avgRequestInterval + interval) / 2;
  }
  
  profile.lastRequestTime = now;
}

// ── לוג חריגה ───────────────────────────────────────────────────────────────────
function logAnomaly(profile: BehaviorProfile, req: NextRequest, anomalyType: AnomalyType, action: Action) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    ip: profile.ip,
    anomalyType,
    action,
    request: {
      method: req.method,
      path: req.nextUrl.pathname,
      search: req.nextUrl.search,
      userAgent: req.headers.get('user-agent') || 'N/A',
      referer: req.headers.get('referer') || 'N/A',
    },
    profile: {
      requestCount: profile.requestCount,
      avgRequestInterval: Math.round(profile.avgRequestInterval),
      uniquePaths: profile.paths.size,
      anomalies: profile.anomalies,
    },
  };
  
  console.log(JSON.stringify(logEntry, null, 2));
}

// ── פונקציית המידלוור הראשית ─────────────────────────────────────────────────────
export function middleware(req: NextRequest) {
  // פטורים לנתיבים ספציפיים
  const exemptPaths = ['/api/dex/stream', '/api/revive'];
  if (exemptPaths.some(path => req.nextUrl.pathname.startsWith(path))) {
    return NextResponse.next();
  }
  
  // קבלת IP מהקצה האמיתי (X-Forwarded-For)
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  
  // קבלת/יצירת פרופיל
  const profile = getOrCreateProfile(ip);
  
  // עדכון פרופיל עם הבקשה הנוכחית
  updateProfile(profile, req);
  
  // זיהוי חריגות
  const anomalyType = detectAnomalies(profile, req);
  
  if (anomalyType) {
    // קביעת פעולה מתאימה
    const action = getAction(profile, anomalyType);
    
    // רישום החריגה
    logAnomaly(profile, req, anomalyType, action);
    
    // בדיקת חסימות קודמות
    if (profile.lastAction && profile.lastActionTime) {
      const timeSinceLastAction = Date.now() - profile.lastActionTime;
      
      if (profile.lastAction === 'block_5m' && timeSinceLastAction < 5 * 60 * 1000) {
        return new NextResponse('Access temporarily blocked (5 minutes)', { 
          status: 429,
          headers: { 'Retry-After': '300' }
        });
      } else if (profile.lastAction === 'block_30m' && timeSinceLastAction < 30 * 60 * 1000) {
        return new NextResponse('Access temporarily blocked (30 minutes)', { 
          status: 429,
          headers: { 'Retry-After': '1800' }
        });
      }
    }
    
    // יישום הפעולה
    profile.lastAction = action;
    profile.lastActionTime = Date.now();
    
    if (action === 'warn') {
      console.warn(`Anomaly detected for IP ${ip}: ${anomalyType}`);
      return NextResponse.next();
    } else {
      const retryAfter = action === 'block_5m' ? '300' : '1800';
      return new NextResponse(`Access temporarily blocked due to suspicious activity`, { 
        status: 429,
        headers: { 'Retry-After': retryAfter }
      });
    }
  }
  
  return NextResponse.next();
}

// ── קונפיגורציית מידלוור ────────────────────────────────────────────────────────
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
