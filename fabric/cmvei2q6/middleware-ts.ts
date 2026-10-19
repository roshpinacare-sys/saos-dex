import { NextRequest, NextResponse } from 'next/server';

// ── מבני נתונים עבור פרופילים התנהגותיים ───────────────────────────────────────
interface BehavioralProfile {
  ip: string;
  requestCount: number;
  paths: Map<string, number>;
  avgParamsSize: number;
  lastRequestTime: number;
  suspiciousActivities: {
    suddenSpikes: number;
    unusualPaths: Set<string>;
    repeatedNonces: Set<string>;
    suspiciousHeaders: Set<string>;
  };
  score: number;
  blocked: boolean;
  blockLevel: 0 | 1 | 2; // 0: חופשי, 1: מוגבל, 2: חסום
}

interface SuspiciousEvent {
  timestamp: string;
  ip: string;
  path: string;
  method: string;
  userAgent?: string;
  reason: string;
  score: number;
}

// ── גלובלים למעקב ואחסון ───────────────────────────────────────────────────────
const profiles = new Map<string, BehavioralProfile>();
const suspiciousEvents: SuspiciousEvent[] = [];
const NONCE_CACHE = new Map<string, { ip: string; timestamp: number }>();
const HEADER_BLACKLIST = [
  'x-forwarded-for',
  'x-real-ip',
  'via',
  'x-cluster-client-ip',
  'cf-connecting-ip',
  'true-client-ip',
  'x-originating-ip'
];

// ── פרמטרי תצורה ───────────────────────────────────────────────────────────────
const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // ניקוי פרופילים כל 24 שעות
const MAX_PROFILE_AGE = 7 * 24 * 60 * 60 * 1000; // 7 ימים
const MAX_SUSPICIOUS_EVENTS = 1000; // מגבלת אירועים חשודים בזיכרון
const SCORE_THRESHOLD_BLOCK = 80; // ציון לחסימה מלאה
const SCORE_THRESHOLD_LIMIT = 50; // ציון להגבלה

// ── ניקוי תקופתי של נתונים ישנים ───────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  
  // ניקוי פרופילים ישנים
  for (const [ip, profile] of profiles) {
    if (now - profile.lastRequestTime > MAX_PROFILE_AGE) {
      profiles.delete(ip);
    }
  }
  
  // ניקוי אירועים חשודים ישנים
  if (suspiciousEvents.length > MAX_SUSPICIOUS_EVENTS) {
    suspiciousEvents.splice(0, suspiciousEvents.length - MAX_SUSPICIOUS_EVENTS);
  }
  
  // ניקוי cache של nonces
  for (const [nonce, data] of NONCE_CACHE) {
    if (now - data.timestamp > 60_000) { // 1 דקת חיים
      NONCE_CACHE.delete(nonce);
    }
  }
}, CLEANUP_INTERVAL);

// ── פונקציות עזר לניתוח התנהגות ────────────────────────────────────────────────
function updateProfile(profile: BehavioralProfile, request: NextRequest): void {
  const now = Date.now();
  const path = request.nextUrl.pathname;
  
  // עדכון סטטיסטיקות בסיסיות
  profile.requestCount++;
  profile.lastRequestTime = now;
  
  // עדכון סטטיסטיקת נתיבים
  const pathCount = profile.paths.get(path) || 0;
  profile.paths.set(path, pathCount + 1);
  
  // חישוב גודל פרמטרים ממוצע
  const paramsSize = JSON.stringify(request.nextUrl.searchParams).length;
  profile.avgParamsSize = (profile.avgParamsSize + paramsSize) / 2;
  
  // בדיקת סטיות
  checkForAnomalies(profile, request);
}

function checkForAnomalies(profile: BehavioralProfile, request: NextRequest): void {
  const now = Date.now();
  const path = request.nextUrl.pathname;
  
  // 1. זיהוי עלייה פתאומית בקצב בקשות
  if (profile.requestCount > 10) {
    const timeDiff = now - profile.lastRequestTime;
    if (timeDiff < 5000) { // יותר מ-10 בקשות ב-5 שניות
      profile.suspiciousActivities.suddenSpikes++;
      logSuspiciousEvent(profile.ip, path, request.method, 'sudden_request_spike', profile.score);
    }
  }
  
  // 2. זיהוי נתיבים לא אופייניים
  const commonPaths = ['/api/dex/state', '/api/dex/order', '/api/dex/swap'];
  if (!commonPaths.some(p => path.startsWith(p)) && profile.paths.size > 5) {
    const isUnusual = Array.from(profile.paths.entries())
      .filter(([p]) => !commonPaths.some(cp => p.startsWith(cp)))
      .every(([p, count]) => count < 3);
      
    if (isUnusual) {
      profile.suspiciousActivities.unusualPaths.add(path);
      logSuspiciousEvent(profile.ip, path, request.method, 'unusual_path_access', profile.score);
    }
  }
  
  // 3. זיהוי nonces חוזרים
  const nonce = request.headers.get('x-nonce');
  if (nonce) {
    const cached = NONCE_CACHE.get(nonce);
    if (cached && cached.ip === profile.ip) {
      profile.suspiciousActivities.repeatedNonces.add(nonce);
      logSuspiciousEvent(profile.ip, path, request.method, 'repeated_nonce', profile.score);
    } else {
      NONCE_CACHE.set(nonce, { ip: profile.ip, timestamp: now });
    }
  }
  
  // 4. זיהוי כותרות חשודות
  for (const header of request.headers.entries()) {
    const [name, value] = header;
    const lowerName = name.toLowerCase();
    
    if (HEADER_BLACKLIST.some(bl => lowerName.includes(bl))) {
      profile.suspiciousActivities.suspiciousHeaders.add(`${name}: ${value.substring(0, 50)}...`);
      logSuspiciousEvent(profile.ip, path, request.method, 'suspicious_header', profile.score);
    }
    
    // בדיקת כותרות SQL injection פוטנציאליות
    if (lowerName.includes('user-agent') && 
        (value.includes('union') || value.includes('select') || value.includes('insert'))) {
      profile.suspiciousActivities.suspiciousHeaders.add(`${name}: SQL injection attempt`);
      logSuspiciousEvent(profile.ip, path, request.method, 'sql_injection_attempt', profile.score);
    }
  }
}

function calculateScore(profile: BehavioralProfile): number {
  let score = 0;
  
  // בסיס ציון לפי כמות בקשות
  score += Math.min(profile.requestCount / 10, 20);
  
  // ציון על סטיות
  score += profile.suspiciousActivities.suddenSpikes * 5;
  score += profile.suspiciousActivities.unusualPaths.size * 3;
  score += profile.suspiciousActivities.repeatedNonces.size * 4;
  score += profile.suspiciousActivities.suspiciousHeaders.size * 6;
  
  // ציון על גודל פרמטרים חריג
  if (profile.avgParamsSize > 1000) {
    score += (profile.avgParamsSize - 1000) / 100;
  }
  
  return Math.min(Math.round(score), 100);
}

function updateBlockStatus(profile: BehavioralProfile): void {
  const score = calculateScore(profile);
  profile.score = score;
  
  if (score >= SCORE_THRESHOLD_BLOCK) {
    profile.blocked = true;
    profile.blockLevel = 2;
  } else if (score >= SCORE_THRESHOLD_LIMIT) {
    profile.blockLevel = 1;
  } else {
    profile.blockLevel = 0;
  }
}

function logSuspiciousEvent(ip: string, path: string, method: string, reason: string, score: number): void {
  const event: SuspiciousEvent = {
    timestamp: new Date().toISOString(),
    ip,
    path,
    method,
    userAgent: '', // ניתן להוסיף אם נדרש
    reason,
    score
  };
  
  suspiciousEvents.push(event);
  
  // לוג למערכת
  console.warn(`[SECURITY] Suspicious activity detected:`, event);
}

// ── הפונקציה הראשית למידלוואר ─────────────────────────────────────────────────
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const ip = request.ip || request.headers.get('x-forwarded-for') || 'unknown';
  const path = request.nextUrl.pathname;
  
  // פטורים קיימים
  const EXEMPT = ['/api/dex/stream', '/api/revive'];
  if (EXEMPT.some(exempt => path.startsWith(exempt))) {
    return NextResponse.next();
  }
  
  // קבלת או יצירת פרופיל
  let profile = profiles.get(ip);
  if (!profile) {
    profile = {
      ip,
      requestCount: 0,
      paths: new Map(),
      avgParamsSize: 0,
      lastRequestTime: Date.now(),
      suspiciousActivities: {
        suddenSpikes: 0,
        unusualPaths: new Set(),
        repeatedNonces: new Set(),
        suspiciousHeaders: new Set()
      },
      score: 0,
      blocked: false,
      blockLevel: 0
    };
    profiles.set(ip, profile);
  }
  
  // עדכון פרופיל עם הבקשה הנוכחית
  updateProfile(profile, request);
  
  // עדכון סטטוס חסימה
  updateBlockStatus(profile);
  
  // בדיקת חסימות
  if (profile.blocked) {
    logSuspiciousEvent(ip, path, request.method, 'ip_blocked', profile.score);
    return new NextResponse('Access denied: IP blocked due to suspicious activity', { 
      status: 403,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
  
  // הגבלות מדורגות
  if (profile.blockLevel === 1) {
    // הגבלת קצב בקשות ל-10 בדקה
    const now = Date.now();
    const recentRequests = Array.from(profile.paths.entries())
      .filter(([_, count]) => count > 0)
      .reduce((sum, [_, count]) => sum + count, 0);
    
    if (recentRequests > 10) {
      logSuspiciousEvent(ip, path, request.method, 'rate_limit_exceeded', profile.score);
      return new NextResponse('Access denied: Rate limit exceeded', { 
        status: 429,
        headers: { 
          'Content-Type': 'text/plain',
          'X-RateLimit-Limit': '10',
          'X-RateLimit-Remaining': '0',
          'Retry-After': '60'
        }
      });
    }
  }
  
  // המשך לבקשה רגילה אם לא נחסמ
  return NextResponse.next();
}

// ── נקודות קצה לניהול ודיווח (אופציונלי) ───────────────────────────────────────
// ניתן להוסיף נקודות קצה כדי לאסוף נתונים על פרופילים ואירועים חשודים
export const config = {
  matcher: [
    '/api/:path*',
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};