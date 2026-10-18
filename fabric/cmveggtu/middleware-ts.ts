import { NextRequest, NextResponse } from 'next/server';

/**
 * middleware.ts — מנגנון זיהוי חריגות התנהגותי מתקדם
 * כולל:
 * 1. ניתוח סטטיסטי של קצב בקשות לכל IP עם זיהוי פיצוצים פתאומיים
 * 2. מעקב אחרי דפוסי גישה לנקודות API קריטיות
 * 3. ניתוח כותרות בקשות חריגות
 * 4. מנגנון התרעה דינמי
 * 5. יכולת למידה ראשונית של התנהגות נורמלית
 */

// קבועים למנגנון הזיהוי
const WINDOW_MS = 60_000;
const BASE_LIMIT_INTERNAL = 2_000;
const BASE_LIMIT_PUBLIC = 240;
const MAX_KEYS = 5_000;
const EXEMPT = ["/api/dex/stream", "/api/revive"];

// נקודות API קריטיות למעקב מיוחד
const CRITICAL_APIS = [
  "/api/dex/settle",
  "/api/dex/transfer",
  "/api/dex/order",
  "/api/dex/cancel",
  "/api/dex/swap"
];

// מבני נתונים למעקב
const buckets = new Map<string, number[]>(); // קצב בקשות לכל IP
const criticalApiHits = new Map<string, Map<string, number>>(); // גישות ל-API קריטיים לפי IP
const suspiciousHeaders = new Map<string, Set<string>>(); // IP עם כותרות חריגות
const learningData = new Map<string, {
  avgRequestsPerMin: number;
  avgCriticalApiHits: number;
  lastUpdated: number;
}>(); // נתוני למידה

// פונקציות עזר
function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1] ?? "proxied";
    return "proxied";
  }
  return req.headers.get("x-real-ip") ?? "local";
}

// זיהוי פיצוצים (burst detection)
function detectBurst(ip: string, currentTime: number): boolean {
  const bucket = buckets.get(ip) || [];
  const recentRequests = bucket.filter(time => currentTime - time < 5000); // בחלון 5 שניות
  
  // אם יותר מ-20 בקשות ב-5 שניות - זה פיצוץ
  return recentRequests.length > 20;
}

// ניתוח כותרות חריגות
function analyzeHeaders(req: NextRequest, ip: string): boolean {
  const suspicious = new Set<string>();
  
  // בדיקת User-Agent
  const userAgent = req.headers.get("user-agent") || "";
  if (!userAgent || userAgent.length < 10 || userAgent === "-" || 
      userAgent.includes("bot") || userAgent.includes("crawler") || 
      userAgent.includes("spider")) {
    suspicious.add("suspicious-user-agent");
  }
  
  // בדיקת Referer חסר או לא תואם
  const referer = req.headers.get("referer") || "";
  if (referer && !referer.includes(req.nextUrl.hostname)) {
    suspicious.add("invalid-referer");
  }
  
  // בדיקת Origin חסר או לא תואם
  const origin = req.headers.get("origin") || "";
  if (origin && !origin.includes(req.nextUrl.hostname)) {
    suspicious.add("invalid-origin");
  }
  
  // שמירת תוצאות
  if (suspicious.size > 0) {
    const existing = suspiciousHeaders.get(ip) || new Set<string>();
    suspicious.forEach(item => existing.add(item));
    suspiciousHeaders.set(ip, existing);
    
    // אם יותר מ-3 סימני חשד - נחזיר true
    return existing.size > 3;
  }
  
  return false;
}

// התרעה למערכות ניטור חיצוניות
function alertExternalSystem(ip: string, reason: string, details: Record<string, any>) {
  // ביישום מציאותי, כאן ישלח התרעה למערכת ניטור חיצונית
  // כמו Splunk, ELK, סיגינט, או כל מערכת מותאמת אישית
  console.log(`[SECURITY ALERT] IP: ${ip}, Reason: ${reason}`, details);
  
  // בדוגמה זו, נדפיס ללוג בלבד
  // ביישום אמיתי, כאן יהיה קריאת HTTP למערכת התרעות
}

// למידה ראשונית של התנהגות נורמלית
function updateLearningData(ip: string, criticalApiHitsCount: number) {
  const now = Date.now();
  const existing = learningData.get(ip);
  
  if (!existing) {
    // נתונים ראשוניים ל-IP חדש
    learningData.set(ip, {
      avgRequestsPerMin: BASE_LIMIT_PUBLIC,
      avgCriticalApiHits: criticalApiHitsCount,
      lastUpdated: now
    });
  } else {
    // עדכון ממוצעים
    const timeDiff = now - existing.lastUpdated;
    if (timeDiff > 300_000) { // עדכון כל 5 דקות
      learningData.set(ip, {
        avgRequestsPerMin: (existing.avgRequestsPerMin * 0.7) + (BASE_LIMIT_PUBLIC * 0.3),
        avgCriticalApiHits: (existing.avgCriticalApiHits * 0.7) + (criticalApiHitsCount * 0.3),
        lastUpdated: now
      });
    }
  }
}

// חישוב גבולות דינמיים
function calculateDynamicLimits(ip: string): { internal: number; public: number } {
  const learning = learningData.get(ip);
  
  if (!learning) {
    return { internal: BASE_LIMIT_INTERNAL, public: BASE_LIMIT_PUBLIC };
  }
  
  // התאמת גבולות לפי נתוני הלמידה
  // אם ה-IP התנהג טוב בעבר, נעלה את הגבול
  const internalMultiplier = learning.avgRequestsPerMin > BASE_LIMIT_PUBLIC * 0.8 ? 1.2 : 1.0;
  const publicMultiplier = learning.avgCriticalApiHits > 5 ? 0.8 : 1.0; // אם גישה רבה ל-API קריטי, נוריד קצב
  
  return {
    internal: Math.min(BASE_LIMIT_INTERNAL * internalMultiplier, BASE_LIMIT_INTERNAL * 2),
    public: Math.max(BASE_LIMIT_PUBLIC * publicMultiplier, BASE_LIMIT_PUBLIC * 0.5)
  };
}

// פונקציית ה-middleware הראשית
export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  
  // פטורים
  if (EXEMPT.some((p) => pathname.includes(p))) {
    return NextResponse.next();
  }
  
  const ip = clientIp(req);
  const isPublic = req.headers.has("x-forwarded-for");
  const currentTime = Date.now();
  
  // קבלת גבולות דינמיים
  const { internal: limitInternal, public: limitPublic } = calculateDynamicLimits(ip);
  const limit = isPublic ? limitPublic : limitInternal;
  
  // ניהול חלון זמן לקצב בקשות
  let bucket = buckets.get(ip);
  if (!bucket) {
    bucket = [];
    buckets.set(ip, bucket);
  }
  
  // ניקוי בקשות ישנות
  while (bucket.length > 0 && bucket[0] !== undefined && currentTime - bucket[0] >= WINDOW_MS) {
    bucket.shift();
  }
  
  // זיהוי פיצוצים
  if (detectBurst(ip, currentTime)) {
    alertExternalSystem(ip, "burst-detected", {
      requestCount: bucket.length,
      timeWindow: WINDOW_MS,
      criticalPath: pathname
    });
    
    // תגובה מהירה לפיצוץ
    return NextResponse.json(
      {
        ok: false,
        error: "burst-detected: too many requests in short time"
      },
      { status: 429 }
    );
  }
  
  // ניתוג API קריטי
  let criticalApiHitsCount = 0;
  const criticalApiMap = criticalApiHits.get(ip) || new Map<string, number>();
  
  if (CRITICAL_APIS.some(api => pathname.includes(api))) {
    criticalApiHitsCount = criticalApiMap.get(pathname) || 0;
    criticalApiMap.set(pathname, criticalApiHitsCount + 1);
    criticalApiHits.set(ip, criticalApiMap);
    
    // זיהוי חזרות חשודות על API קריטי
    if (criticalApiHitsCount > 10) { // יותר מ-10 בקשות לאותו API באותו דקה
      alertExternalSystem(ip, "repeated-critical-api-access", {
        api: pathname,
        hitCount: criticalApiHitsCount,
        timeWindow: WINDOW_MS
      });
      
      return NextResponse.json(
        {
          ok: false,
          error: "repeated-critical-api-access: too many requests to critical endpoint"
        },
        { status: 429 }
      );
    }
  }
  
  // עדכון נתוני למידה
  updateLearningData(ip, criticalApiHitsCount);
  
  // ניתוח כותרות חריגות
  if (analyzeHeaders(req, ip)) {
    alertExternalSystem(ip, "suspicious-headers", {
      headers: Object.fromEntries(req.headers.entries()),
      path: pathname
    });
    
    // תגובה לכותרות חריגות
    return NextResponse.json(
      {
        ok: false,
        error: "suspicious-headers: request headers indicate potential threat"
      },
      { status: 403 }
    );
  }
  
  // בדיקת קצב בקשות רגילה
  if (bucket.length >= limit) {
    const oldest = bucket[0] ?? currentTime;
    const retryAfter = Math.max(1, Math.ceil((WINDOW_MS - (currentTime - oldest)) / 1000));
    
    // התרעה על חריגת קצב
    alertExternalSystem(ip, "rate-limit-exceeded", {
      requestCount: bucket.length,
      limit: limit,
      timeWindow: WINDOW_MS,
      retryAfter: retryAfter
    });
    
    return NextResponse.json(
      {
        ok: false,
        error: `rate-limited: ${limit} req/min per IP (honest budget — retry later)`
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(retryAfter),
          "X-RateLimit-Limit": String(limit),
          "X-RateLimit-Remaining": "0"
        }
      }
    );
  }
  
  // הוספת הבקשה הנוכחית לחלון
  bucket.push(currentTime);
  
  // ניקוי זיכרון: מחיקת IP ישנים
  if (buckets.size > MAX_KEYS) {
    const it = buckets.keys();
    for (let i = 0; i < 1_000; i += 1) {
      const k = it.next();
      if (k.done) break;
      if (k.value !== ip) {
        buckets.delete(k.value);
        criticalApiHits.delete(k.value);
        suspiciousHeaders.delete(k.value);
        learningData.delete(k.value);
      }
    }
  }
  
  // הוספת כותרות לתגובה
  const res = NextResponse.next();
  res.headers.set("X-RateLimit-Limit", String(limit));
  res.headers.set("X-RateLimit-Remaining", String(Math.max(0, limit - bucket.length)));
  
  // הוספת כותרת זיהוי
  res.headers.set("X-Security-Status", "monitored");
  
  return res;
}

export const config = {
  matcher: ["/api/dex/:path*"]
};