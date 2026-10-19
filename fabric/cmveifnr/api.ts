import { NextRequest, NextResponse } from 'next/server';

// ── פרופיל משתמש דינמי ───────────────────────────────────────────────────────
interface UserProfile {
  id: string;
  requestCount: number;
  lastActivity: number;
  paths: Map<string, number>;
  commonParams: Map<string, Set<string>>;
  avgRequestsPerMinute: number;
  riskScore: number;
  blockedUntil?: number;
}

// ── גלובל סטורייג' ────────────────────────────────────────────────────────────
const userProfiles = new Map<string, UserProfile>();
const BLOCK_DURATION = 5 * 60 * 1000; // 5 דקות חסימה
const MAX_PROFILES = 10000; // הגבלת זיכרון
const MAX_REQUESTS_PER_MINUTE = 300; // סף כללי לבקשות לדקה
const CRITICAL_PATHS = [
  '/api/dex/settle',
  '/api/dex/order',
  '/api/dex/swap',
  '/api/dex/cancel'
];

// ── פונקציות עזר ───────────────────────────────────────────────────────────────
function getUserProfile(ip: string): UserProfile {
  let profile = userProfiles.get(ip);
  const now = Date.now();
  
  if (!profile) {
    if (userProfiles.size >= MAX_PROFILES) {
      // ניקוי פרופילים ישנים
      const oldest = Array.from(userProfiles.entries())
        .sort((a, b) => a[1].lastActivity - b[1].lastActivity)[0];
      if (oldest) userProfiles.delete(oldest[0]);
    }
    
    profile = {
      id: ip,
      requestCount: 0,
      lastActivity: now,
      paths: new Map(),
      commonParams: new Map(),
      avgRequestsPerMinute: 0,
      riskScore: 0
    };
    userProfiles.set(ip, profile);
  }
  
  profile.lastActivity = now;
  return profile;
}

function updateRiskScore(profile: UserProfile, path: string, params: URLSearchParams): number {
  let score = 0;
  
  // 1. דירוג על סמך נתיבים קריטיים
  if (CRITICAL_PATHS.includes(path)) {
    score += 30;
  }
  
  // 2. דירוג על סמך קצב בקשות
  const now = Date.now();
  const minuteAgo = now - 60 * 1000;
  
  // ספירת בקשות בדקה האחרונה
  let recentRequests = 0;
  for (const [_, profile] of userProfiles) {
    if (profile.id === profile.id && profile.lastActivity > minuteAgo) {
      recentRequests++;
    }
  }
  
  if (recentRequests > MAX_REQUESTS_PER_MINUTE) {
    score += 40;
  }
  
  // 3. דירוג על סמך חריגות בדפוסי נתיבים
  const pathCount = profile.paths.get(path) || 0;
  profile.paths.set(path, pathCount + 1);
  
  // אם זו הפעם הראשונה שהמשתמש פונה לנתיב זה
  if (pathCount === 0) {
    score += 20;
  }
  
  // 4. דירוג על סמך פרמטרים חדשים/חשודים
  for (const [key, value] of params.entries()) {
    const paramValues = profile.commonParams.get(key) || new Set();
    
    if (!paramValues.has(value)) {
      score += 10;
      paramValues.add(value);
    }
    
    profile.commonParams.set(key, paramValues);
  }
  
  // 5. דירוג על סמך ניסיונות חוזרים לאחר חסימה
  if (profile.blockedUntil && now < profile.blockedUntil) {
    score += 50;
  }
  
  // עדכון ציון הסיכון בפרופיל
  profile.riskScore = Math.min(100, score);
  
  return profile.riskScore;
}

function applySecurityMeasures(profile: UserProfile, response: NextResponse): NextResponse {
  const now = Date.now();
  
  if (profile.riskScore > 70) {
    // חסימה זמנית
    profile.blockedUntil = now + BLOCK_DURATION;
    return NextResponse.json(
      { error: 'Access temporarily blocked due to suspicious activity', riskScore: profile.riskScore },
      { status: 429 }
    );
  } else if (profile.riskScore > 40) {
    // הגבלת קצב
    response.headers.set('X-Risk-Score', profile.riskScore.toString());
    response.headers.set('Retry-After', '60');
    return response;
  }
  
  return response;
}

// ── מידלוור ראשי ───────────────────────────────────────────────────────────────
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const ip = request.ip || 'unknown';
  const path = request.nextUrl.pathname;
  const method = request.method;
  
  // פטורים לניטור
  if (path.startsWith('/api/dex/stream') || path.startsWith('/api/revive')) {
    return NextResponse.next();
  }
  
  const profile = getUserProfile(ip);
  const params = request.nextUrl.searchParams;
  
  // עדכון סטטיסטיקות
  profile.requestCount++;
  
  // חישוב ציון סיכון
  const riskScore = updateRiskScore(profile, path, params);
  
  // יישום אמצעי ביטחון
  const response = NextResponse.next();
  const securedResponse = applySecurityMeasures(profile, response);
  
  // לוג חריגות למעקב
  if (riskScore > 30) {
    console.log(`[ANOMALY DETECTED] IP: ${ip}, Path: ${path}, Risk Score: ${riskScore}`);
  }
  
  return securedResponse;
}

// ── קונפיגורציה ───────────────────────────────────────────────────────────────
export const config = {
  matcher: [
    '/api/dex/:path*',
    '/api/revive/:path*'
  ]
};
