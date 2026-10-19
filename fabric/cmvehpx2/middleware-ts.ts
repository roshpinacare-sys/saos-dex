import { NextRequest, NextResponse } from 'next/server';

// ── פרופיל התנהגות עבור כל IP ──
type UserProfile = {
  ip: string;
  requestCount: number;
  paths: Map<string, number>;
  timestamps: number[];
  lastSeen: number;
  riskScore: number;
  blocked: boolean;
  blockDuration: number;
  suspiciousPatterns: {
    repeatedCriticalApi: boolean;
    suspiciousNonceSequence: boolean;
    highFrequency: boolean;
  };
  lastCriticalApiCall: {
    path: string;
    timestamp: number;
    params: Record<string, any>;
  } | null;
};

// ── מאגר גלובלי לפרופילי משתמשים ──
const userProfiles = new Map<string, UserProfile>();
const CRITICAL_APIS = ['/api/dex/settle', '/api/dex/transfer', '/api/dex/order', '/api/dex/cancel'];
const MAX_REQUESTS_PER_MINUTE = 240;
const MAX_CRITICAL_API_CALLS_PER_MINUTE = 5;
const HIGH_FREQUENCY_THRESHOLD = 100; // בקשות בדקה
const SUSPICIOUS_NONCE_THRESHOLD = 5; // רצף של אותו nonce

// ── פונקציות עזר ──
function getRiskScore(profile: UserProfile): number {
  let score = 0;
  
  // הענקת נקודות על פי דפוסים חשודים
  if (profile.suspiciousPatterns.repeatedCriticalApi) score += 40;
  if (profile.suspiciousPatterns.suspiciousNonceSequence) score += 30;
  if (profile.suspiciousPatterns.highFrequency) score += 20;
  
  // עדכון ציון הסיכון על פי כמות הבקשות
  const now = Date.now();
  const recentRequests = profile.timestamps.filter(t => now - t < 60000);
  if (recentRequests.length > MAX_REQUESTS_PER_MINUTE * 0.8) score += 10;
  
  return Math.min(score, 100);
}

function logSuspiciousActivity(profile: UserProfile, activity: string, details: any): void {
  const logEntry = {
    timestamp: new Date().toISOString(),
    ip: profile.ip,
    activity,
    details,
    riskScore: profile.riskScore
  };
  
  console.log(JSON.stringify(logEntry));
}

function analyzeBehavior(profile: UserProfile, request: NextRequest): void {
  const now = Date.now();
  const path = request.nextUrl.pathname;
  
  // עדכון נתונים סטטיסטיים
  profile.requestCount++;
  profile.lastSeen = now;
  
  // עדכון נתיבים פופולריים
  const pathCount = profile.paths.get(path) || 0;
  profile.paths.set(path, pathCount + 1);
  
  // עדכון חותמות זמן
  profile.timestamps.push(now);
  
  // ניקוי חותמות זמן ישנות (מעל דקה)
  profile.timestamps = profile.timestamps.filter(t => now - t < 60000);
  
  // בדיקת נקודות API קריטיות
  if (CRITICAL_APIS.includes(path)) {
    const criticalCallCount = Array.from(profile.paths.values()).reduce((sum, count) => 
      CRITICAL_APIS.some(api => profile.paths.has(api)) ? sum + 1 : sum, 0);
    
    if (criticalCallCount > MAX_CRITICAL_API_CALLS_PER_MINUTE) {
      profile.suspiciousPatterns.repeatedCriticalApi = true;
      logSuspiciousActivity(profile, "repeated_critical_api", { path, count: criticalCallCount });
    }
    
    // שמירת פרטי הקריאה האחרונה לנקודת API קריטית
    profile.lastCriticalApiCall = {
      path,
      timestamp: now,
      params: Object.fromEntries(request.nextUrl.searchParams.entries())
    };
  }
  
  // בדיקת סדרות בקשות חשודות עם אותו nonce
  const nonce = request.nextUrl.searchParams.get('nonce');
  if (nonce) {
    const recentNonces = profile.timestamps
      .filter(t => now - t < 10000) // 10 שניות אחרונות
      .map(t => {
        // בדיקה אם הייתה בקשה עם אותו nonce בזמן זה
        // כאן ניתן להוסיף לוגיקה מורכבת יותר לזיהוי רצפים
        return nonce;
      });
    
    if (recentNonces.length >= SUSPICIOUS_NONCE_THRESHOLD) {
      profile.suspiciousPatterns.suspiciousNonceSequence = true;
      logSuspiciousActivity(profile, "suspicious_nonce_sequence", { nonce, count: recentNonces.length });
    }
  }
  
  // בדיקת תדירות גבוהה
  if (profile.timestamps.length > HIGH_FREQUENCY_THRESHOLD) {
    profile.suspiciousPatterns.highFrequency = true;
    logSuspiciousActivity(profile, "high_frequency", { requestCount: profile.timestamps.length });
  }
  
  // עדכון ציון הסיכון
  profile.riskScore = getRiskScore(profile);
}

function applyMitigation(profile: UserProfile): { blocked: boolean; delay: number } {
  if (profile.blocked) {
    return { blocked: true, delay: 0 };
  }
  
  if (profile.riskScore >= 80) {
    profile.blocked = true;
    profile.blockDuration = 24 * 60 * 60 * 1000; // חסימה ל-24 שעות
    
    logSuspiciousActivity(profile, "user_blocked", { 
      reason: "high_risk_score", 
      score: profile.riskScore,
      duration: profile.blockDuration
    });
    
    return { blocked: true, delay: 0 };
  } else if (profile.riskScore >= 60) {
    // דרישת אימות נוסף (לדוגמה: CAPTCHA)
    logSuspiciousActivity(profile, "additional_verification_required", { score: profile.riskScore });
    return { blocked: false, delay: 5000 };
  } else if (profile.riskScore >= 40) {
    // הגבלת קצב בקשות
    const delay = Math.min(1000, (profile.riskScore - 40) * 50);
    return { blocked: false, delay };
  }
  
  return { blocked: false, delay: 0 };
}

// ── המידלוור הראשי ──
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const ip = request.headers.get('x-forwarded-for') || 'unknown';
  const now = Date.now();
  
  // קבלת או יצירת פרופיל המשתמש
  let profile = userProfiles.get(ip);
  if (!profile) {
    profile = {
      ip,
      requestCount: 0,
      paths: new Map(),
      timestamps: [],
      lastSeen: now,
      riskScore: 0,
      blocked: false,
      blockDuration: 0,
      suspiciousPatterns: {
        repeatedCriticalApi: false,
        suspiciousNonceSequence: false,
        highFrequency: false
      },
      lastCriticalApiCall: null
    };
    userProfiles.set(ip, profile);
  }
  
  // בדיקת חסימה קיימת
  if (profile.blocked) {
    if (now - profile.lastSeen < profile.blockDuration) {
      logSuspiciousActivity(profile, "access_attempt_while_blocked", {});
      return NextResponse.json({ error: 'Access temporarily blocked' }, { status: 429 });
    } else {
      // הסרת החסימה לאחר פג תוקף
      profile.blocked = false;
      profile.blockDuration = 0;
      profile.riskScore = 0;
      profile.suspiciousPatterns = {
        repeatedCriticalApi: false,
        suspiciousNonceSequence: false,
        highFrequency: false
      };
    }
  }
  
  // ניתוח התנהגות
  analyzeBehavior(profile, request);
  
  // החלת מגבלות
  const { blocked, delay } = applyMitigation(profile);
  
  if (blocked) {
    return NextResponse.json({ error: 'Access temporarily blocked' }, { status: 429 });
  }
  
  if (delay > 0) {
    // הוספה של עיכוב בקשה
    await new Promise(resolve => setTimeout(resolve, delay));
    
    // עדכון הפרופיל לאחר העיכוב
    profile.lastSeen = Date.now();
    profile.timestamps.push(profile.lastSeen);
  }
  
  // המשך לבקשה המקורית
  return NextResponse.next();
}

// ── ניקוי פרופילים ישנים ברקע ──
setInterval(() => {
  const now = Date.now();
  for (const [ip, profile] of userProfiles.entries()) {
    if (now - profile.lastSeen > 30 * 60 * 1000) { // 30 דקות
      userProfiles.delete(ip);
    }
  }
}, 5 * 60 * 1000); // כל 5 דקות