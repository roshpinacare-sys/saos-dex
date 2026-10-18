import { NextRequest, NextResponse } from "next/server";

/**
 * middleware.ts — הוספת זיהוי סריקה/ברוטפורס מעל rate-limit קיים
 * 1. עוקב אחרי בקשות ל-IP ב-10 שניות (לכל נתיב וסך הכל)
 * 2. מזהה סריקה: 5+ נתיבים ל-IP ב-10 שניות
 * 3. מזהה ברוטפורס: 20+ בקשות לנתיב מוגן ב-60 שניות
 * 4. מחזיר 429 עם הודעה מתאימה + לוג מבנה
 * 5. מנקה רשומות >60 שניות
 * 6. לא משנה את ה-rate-limit הקיים
 */

const SCAN_WINDOW_MS = 10_000; // 10 שניות
const SCAN_PATH_THRESHOLD = 5; // 5 נתיבים שונים
const BRUTEFORCE_WINDOW_MS = 60_000; // 60 שניות
const BRUTEFORCE_THRESHOLD = 20; // 20 בקשות לנתיב מוגן
const MAX_ENTRIES = 50_000; // מגבלת זיכרון

// מבני נתונים למעקב
const ipRequestCounts = new Map<string, { timestamp: number; count: number }>();
const ipPathCounts = new Map<string, Map<string, { timestamp: number; count: number }>>();
const protectedPaths = ["/api/dex/auth/login", "/api/dex/withdraw", "/api/dex/transfer"];

// פונקצייע עזר לניקוי רשומות ישנות
function cleanupOldEntries() {
  const now = Date.now();
  
  // ניקוי ספירת בקשות כללית
  for (const [ip, data] of ipRequestCounts) {
    if (now - data.timestamp > BRUTEFORCE_WINDOW_MS) {
      ipRequestCounts.delete(ip);
    }
  }
  
  // ניקוי ספירת נתיבים
  for (const [ip, pathMap] of ipPathCounts) {
    for (const [path, data] of pathMap) {
      if (now - data.timestamp > BRUTEFORCE_WINDOW_MS) {
        pathMap.delete(path);
      }
    }
    
    // מחיקת IP אם אין נתיבים נותרים
    if (pathMap.size === 0) {
      ipPathCounts.delete(ip);
    }
  }
}

// פונקציית זיהוי סריקה
function detectScan(ip: string, path: string): boolean {
  const pathMap = ipPathCounts.get(ip);
  if (!pathMap) return false;
  
  // ספירת נתיבים ייחודיים בחלון הזמן
  const uniquePaths = new Set<string>();
  const now = Date.now();
  
  for (const [p, data] of pathMap) {
    if (now - data.timestamp <= SCAN_WINDOW_MS) {
      uniquePaths.add(p);
    }
  }
  
  return uniquePaths.size >= SCAN_PATH_THRESHOLD;
}

// פונקציית זיהוי ברוטפורס
function detectBruteforce(ip: string, path: string): boolean {
  if (!protectedPaths.includes(path)) return false;
  
  const pathMap = ipPathCounts.get(ip);
  if (!pathMap) return false;
  
  const pathData = pathMap.get(path);
  if (!pathData) return false;
  
  const now = Date.now();
  return (
    now - pathData.timestamp <= BRUTEFORCE_WINDOW_MS &&
    pathData.count >= BRUTEFORCE_THRESHOLD
  );
}

// עדכון ספירות בקשות
function updateRequestCounts(ip: string, path: string) {
  const now = Date.now();
  
  // עדכון ספירה כללית
  const ipData = ipRequestCounts.get(ip);
  if (ipData) {
    ipData.count += 1;
    ipData.timestamp = now;
  } else {
    ipRequestCounts.set(ip, { timestamp: now, count: 1 });
  }
  
  // עדכון ספירת נתיבים
  let pathMap = ipPathCounts.get(ip);
  if (!pathMap) {
    pathMap = new Map();
    ipPathCounts.set(ip, pathMap);
  }
  
  const pathData = pathMap.get(path);
  if (pathData) {
    pathData.count += 1;
    pathData.timestamp = now;
  } else {
    pathMap.set(path, { timestamp: now, count: 1 });
  }
  
  // בקרת זיכרון
  if (ipRequestCounts.size > MAX_ENTRIES) {
    cleanupOldEntries();
  }
}

// פונקציית ה-middleware המשופרת
export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  const ip = clientIp(req);
  
  // עדכון ספירות
  updateRequestCounts(ip, pathname);
  
  // בדיקת סריקה
  if (detectScan(ip, pathname)) {
    const userAgent = req.headers.get("user-agent") || "unknown";
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      ip,
      path: pathname,
      eventType: "scan",
      count: ipPathCounts.get(ip)?.size || 0,
      userAgent
    }));
    
    return NextResponse.json(
      {
        ok: false,
        error: "scan detected: too many paths in short time"
      },
      { status: 429 }
    );
  }
  
  // בדיקת ברוטפורס
  if (detectBruteforce(ip, pathname)) {
    const userAgent = req.headers.get("user-agent") || "unknown";
    const pathData = ipPathCounts.get(ip)?.get(pathname);
    
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      ip,
      path: pathname,
      eventType: "bruteforce",
      count: pathData?.count || 0,
      userAgent
    }));
    
    return NextResponse.json(
      {
        ok: false,
        error: "bruteforce detected: too many requests to protected path"
      },
      { status: 429 }
    );
  }
  
  // המשך ל-rate-limit הקיים
  return originalMiddleware(req);
}

// הפונקציה המקורית של ה-middleware (rate-limit)
function originalMiddleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  if (EXEMPT.some((p) => pathname.includes(p))) return NextResponse.next();

  const ip = clientIp(req);
  const isPublic = req.headers.has("x-forwarded-for");
  const limit = isPublic ? LIMIT_PUBLIC : LIMIT_INTERNAL;

  const now = Date.now();
  let bucket = buckets.get(ip);
  if (!bucket) {
    bucket = [];
    buckets.set(ip, bucket);
  }
  while (bucket.length > 0 && bucket[0] !== undefined && now - bucket[0] >= WINDOW_MS) {
    bucket.shift();
  }
  if (bucket.length >= limit) {
    const oldest = bucket[0] ?? now;
    const retryAfter = Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000));
    return NextResponse.json(
      {
        ok: false,
        error: `rate-limited: ${limit} req/min per IP (honest budget — retry later)`,
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(retryAfter),
          "X-RateLimit-Limit": String(limit),
          "X-RateLimit-Remaining": "0",
        },
      },
    );
  }
  bucket.push(now);

  // אנטי-נפיחה: מפתחות-זרים-ללא-תנועה-מת-נגזמים (תקיפת-זיוף-IP לא-תנפח-זיכרון)
  if (buckets.size > MAX_KEYS) {
    const it = buckets.keys();
    for (let i = 0; i < 1_000; i += 1) {
      const k = it.next();
      if (k.done) break;
      if (k.value !== ip) buckets.delete(k.value);
    }
  }

  const res = NextResponse.next();
  res.headers.set("X-RateLimit-Limit", String(limit));
  res.headers.set("X-RateLimit-Remaining", String(Math.max(0, limit - bucket.length)));
  return res;
}

// פונקציית עזר לקבלת IP (מהמקור)
function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1] ?? "proxied";
    return "proxied";
  }
  return req.headers.get("x-real-ip") ?? "local";
}

// קבועים מהמקור
const WINDOW_MS = 60_000;
const LIMIT_INTERNAL = 2_000;
const LIMIT_PUBLIC = 240;
const MAX_KEYS = 5_000;
const EXEMPT = ["/api/dex/stream", "/api/revive"];
const buckets = new Map<string, number[]>();

// ייצוא הקונפיגורציה
export const config = {
  matcher: ["/api/dex/:pat"],
};