import { NextRequest, NextResponse } from 'next/server';

// ── מבני נתונים והגדרות ────────────────────────────────────────────────────────
interface UserProfile {
  ip: string;
  requestCount: number;
  avgRequestSize: number;
  popularEndpoints: Map<string, number>;
  lastActivity: number;
  avgRequestsPerMinute: number;
  endpointVariety: number;
  suspiciousPatterns: string[];
  blockLevel: 0 | 1 | 2 | 3; // 0: פתוח, 1: חשוד, 2: חסום, 3: חסום לצמיתות
  lastViolationTime: number;
}

// סימולטור Redis בזיכרון (ביישום אמיתי היינו מחליפים ב-Redis)
const userProfiles = new Map<string, UserProfile>();
const SUSPICIOUS_LOG_FILE = './suspicious_activity.log';

// ── פרמטרים לזיהוי סטיות ────────────────────────────────────────────────────────
const SUSPICIOUS_ENDPOINT_THRESHOLD = 0.7; // גישה ל-70% מהבקשות לנקודת קצה חדשה
const REQUEST_SIZE_DEVIATION = 2.5; // סטייה של 2.5 סטיות תקן בגודל בקשה
const REPEATED_NONCE_THRESHOLD = 3; // נסיונות חוזרים עם אותו nonce
const VIOLATION_WINDOW_MS = 5 * 60 * 1000; // 5 דקות לחסימה הדרגתית

// ── עזרים ──────────────────────────────────────────────────────────────────────
function getEndpointKey(req: NextRequest): string {
  return req.nextUrl.pathname;
}

function getUserIp(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
}

function calculateStandardDeviation(values: number[]): number {
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const squareDiffs = values.map(value => Math.pow(value - avg, 2));
  const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(avgSquareDiff);
}

function logSuspiciousActivity(profile: UserProfile, reason: string): void {
  const logEntry = {
    timestamp: new Date().toISOString(),
    ip: profile.ip,
    reason,
    blockLevel: profile.blockLevel,
    profile: {
      avgRequestsPerMinute: profile.avgRequestsPerMinute,
      endpointVariety: profile.endpointVariety,
      popularEndpoints: Object.fromEntries(profile.popularEndpoints),
    },
  };

  // ביישום אמיתי: כתיבה לקובץ/Redis/SIEM
  console.log('[SUSPICIOUS_ACTIVITY]', JSON.stringify(logEntry, null, 2));
}

// ── עדכון פרופיל משתמש ────────────────────────────────────────────────────────
function updateUserProfile(profile: UserProfile, req: NextRequest): void {
  const now = Date.now();
  const endpoint = getEndpointKey(req);
  const requestSize = parseInt(req.headers.get('content-length') || '0', 10);

  // עדכון סטטיסטיקות בסיסיות
  profile.requestCount++;
  profile.lastActivity = now;

  // חישוב ממוצע גודל בקשה
  const sizes = Array.from(profile.popularEndpoints.values()).concat(requestSize);
  profile.avgRequestSize = sizes.reduce((a, b) => a + b, 0) / sizes.length;

  // עדכון נקודות קצה פופולריות
  const currentEndpointCount = profile.popularEndpoints.get(endpoint) || 0;
  profile.popularEndpoints.set(endpoint, currentEndpointCount + 1);

  // חישוב מגוון נקודות קצה (0-1)
  profile.endpointVariety = 1 - (Math.max(...profile.popularEndpoints.values()) / profile.requestCount);

  // חישוב קצב בקשות לדקה
  const timeWindow = 60 * 1000; // 1 דקה
  const recentRequests = Array.from(userProfiles.values())
    .filter(p => p.ip === profile.ip && (now - p.lastActivity) < timeWindow)
    .reduce((sum, p) => sum + p.requestCount, 0);
  
  profile.avgRequestsPerMinute = recentRequests;
}

// ── זיהוי סטיות ────────────────────────────────────────────────────────────────
function detectAnomalies(profile: UserProfile, req: NextRequest): { isSuspicious: boolean; reason: string } {
  const now = Date.now();
  const endpoint = getEndpointKey(req);
  const requestSize = parseInt(req.headers.get('content-length') || '0', 10);
  
  // 1. זיהוי קצב בקשות חריג
  if (profile.avgRequestsPerMinute > 1000) {
    return { isSuspicious: true, reason: 'high_request_rate' };
  }

  // 2. זיהוי גישה לנקודת קצה לא אופיינית
  const maxEndpointCount = Math.max(...profile.popularEndpoints.values());
  const currentEndpointCount = profile.popularEndpoints.get(endpoint) || 0;
  
  if (profile.requestCount > 10 && 
      currentEndpointCount / maxEndpointCount < SUSPICIOUS_ENDPOINT_THRESHOLD &&
      profile.endpointVariety > 0.8) {
    return { isSuspicious: true, reason: 'unusual_endpoint_access' };
  }

  // 3. זיהוי שינוי פתאומי בגודל בקשה
  if (profile.requestCount > 5 && 
      requestSize > profile.avgRequestSize + (REQUEST_SIZE_DEVIATION * calculateStandardDeviation(
        Array.from(profile.popularEndpoints.values()).concat(requestSize)
      ))) {
    return { isSuspicious: true, reason: 'abnormal_request_size' };
  }

  // 4. זיהוי רצף בקשות חוזרות (סימולציה ל-nonce)
  const nonce = req.nextUrl.searchParams.get('nonce');
  if (nonce) {
    const recentNonces = Array.from(userProfiles.values())
      .filter(p => p.ip === profile.ip && (now - p.lastActivity) < 10000) // 10 שניות
      .map(p => p.suspiciousPatterns.includes(`nonce:${nonce}`) ? 1 : 0)
      .reduce((sum, val) => sum + val, 0);
    
    if (recentNonces >= REPEATED_NONCE_THRESHOLD) {
      return { isSuspicious: true, reason: 'repeated_nonce_pattern' };
    }
  }

  return { isSuspicious: false, reason: '' };
}

// ── חסימה הדרגתית ─────────────────────────────────────────────────────────────
function applyProgressiveBlocking(profile: UserProfile): boolean {
  const now = Date.now();
  
  // איפוס רמת חסימה אם חלפו די זמן מההפרה האחרונה
  if (now - profile.lastViolationTime > VIOLATION_WINDOW_MS) {
    profile.blockLevel = Math.max(0, profile.blockLevel - 1);
    profile.lastViolationTime = 0;
  }

  // עלייה ברמת חסימה
  if (profile.blockLevel < 3) {
    profile.blockLevel++;
    profile.lastViolationTime = now;
  }

  // החלטה על חסימה
  return profile.blockLevel >= 2;
}

// ── מידלוור ראשי ────────────────────────────────────────────────────────────────
export async function middleware(req: NextRequest): Promise<NextResponse> {
  const ip = getUserIp(req);
  const endpoint = getEndpointKey(req);
  
  // פטורים לניתוח
  if (endpoint.startsWith('/api/dex/stream') || endpoint.startsWith('/api/revive')) {
    return NextResponse.next();
  }

  // קבלת או יצירת פרופיל משתמש
  let profile = userProfiles.get(ip);
  if (!profile) {
    profile = {
      ip,
      requestCount: 0,
      avgRequestSize: 0,
      popularEndpoints: new Map(),
      lastActivity: 0,
      avgRequestsPerMinute: 0,
      endpointVariety: 0,
      suspiciousPatterns: [],
      blockLevel: 0,
      lastViolationTime: 0,
    };
    userProfiles.set(ip, profile);
  }

  // עדכון פרופיל עם הבקשה הנוכחית
  updateUserProfile(profile, req);

  // זיהוי סטיות
  const { isSuspicious, reason } = detectAnomalies(profile, req);

  // טיפול בחשד
  if (isSuspicious) {
    profile.suspiciousPatterns.push(reason);
    logSuspiciousActivity(profile, reason);
    
    // החלת חסימה הדרגתית
    const shouldBlock = applyProgressiveBlocking(profile);
    
    if (shouldBlock) {
      return new NextResponse('Access temporarily blocked due to suspicious activity', {
        status: 429,
        headers: {
          'X-Block-Reason': reason,
          'X-Block-Level': profile.blockLevel.toString(),
          'Retry-After': '300', // 5 דקות
        },
      });
    }
  }

  // המשך ל-rate-limiting הקיים (אם קיים)
  // ... קוד ה-rate-limiting הקיים כאן ...

  return NextResponse.next();
}

// ── הגדרו�י נתיבים ───────────────────────────────────────────────────────────────
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};