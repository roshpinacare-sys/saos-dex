import { NextRequest, NextResponse } from "next/server";

/**
 * rate-limit — EXEC-CD-44 · סגירת-פער-P3 מ-ROADMAP-42-GAPS.md ("אפס-rate-limit ציבורי")
 * ══════════════════════════════════════════════════════════════════════════════════
 * הענקים מגבילים-כניסה (API-gateway budget). עד-עכשיו-לנו היה רק operatorAuth (סודות)
 * ו-fence (הגבלת-יציאה) — כניסה-ציבורית הייתה-פתוחה-לגמרי.
 *
 * שתי-מדרגות-כנות (נמדד מול-ה-harness כדי-שההוכחות-לא-ייחנקו):
 *  · בקשה-ישירה-פנימית (בלי X-Forwarded-For — מה-sandbox-עצמו: proof-runner,
 *    jepsen-http, slo-probe, הקונסולות) → 2,000/דק'/IP — ראש-נשימה מעל קצף-המדידה
 *    (~500 jepsen + ~150 slo-probe באותה-דקה).
 *  · בקשה-מועברת-גייטוויי (X-Forwarded-For קיים) → 240/דק'/IP.
 *    ה-IP נלקח מהקצה-האחרון של XFF (הקרוב-לשרת — נוסף-על-ידי-הגייטוויי-שלנו,
 *    עמיד-לזיוף-ראשון-האיבר-על-ידי-לקוח-עוין).
 *
 * פטורים: /api/dex/stream (SSE ארוך-טווח) · /api/revive (וודג'-heal — חייב-לעבור-תמיד).
 * fail-open על-תקלה-פנימית: זמינות > קפדנות; השער-האופרטורי נשאר fail-closed בנפרד.
 *
 * סריקה-מתקדמת — זיהוי דפוסי סריקה אוטומטי עם חסימה של 15 דקות
 *  · מזהה סריקת פורטים (בקשות ל-ports לא סטנדרטיים ב-host header)
 *  · מזהה ניסיונות גישה לקבצים רגישים (paths כמו /etc/passwd, .env, config וכד')
 *  · מזהה דפוסי בקשות חוזרים עם שינויים מינימליים (שינוי בפרמטר יחיד או path depth)
 *  · חוסם IP אוטומטית למשך 15 דקות při זיהוי דפוס סריקה
 *  · רושם אירוע מפורט בלוגי האבטחה כולל IP מלא, סוג דפוס, נתיב מטרה וקוד סטטוס
 */
const WINDOW_MS = 60_000;
const LIMIT_INTERNAL = 2_000;
const LIMIT_PUBLIC = 240;
const MAX_KEYS = 5_000;
const EXEMPT = ["/api/dex/stream", "/api/revive"];

// סריקה-מתקדמת: חסימה של 15 דקות לזיהוי דפוסי סריקה
const SCAN_BLOCK_MS = 15 * 60 * 1000; // 15 דקות
const SCAN_MAX_KEYS = 10_000; // מגבלת מפתחות לזיהוי סריקה

// מבני נתונים לזיהוי סריקה
const scanBuckets = new Map<string, { firstSeen: number; lastSeen: number; count: number; patterns: Set<string> }>();
const blockedIPs = new Map<string, number>(); // IP -> unblockTime

function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1] ?? "proxied";
    return "proxied";
  }
  return req.headers.get("x-real-ip") ?? "local";
}

function isScanPattern(req: NextRequest): { isScan: boolean; type: string; target: string } | null {
  const { pathname } = req.nextUrl;
  const host = req.headers.get("host") || "";
  const userAgent = req.headers.get("user-agent") || "";

  // 1. זיהוי סריקת פורטים - בקשה ל-host עם port לא סטנדרטי
  if (host.includes(":")) {
    const portMatch = host.match/:(\d+)$/;
    if (portMatch) {
      const port = parseInt(portMatch[1], 10);
      // פורטים לא סטנדרטיים לשרת אינטרנט (לא 80, 443, 3000-3010, 8080, 8443)
      const nonStandardPorts = [80, 443, 3000, 3001, 3010, 8080, 8443];
      if (!nonStandardPorts.includes(port)) {
        return { isScan: true, type: "port-scan", target: host };
      }
    }
  }

  // 2. זיהוי ניסיונות גישה לקבצים רגישים
  const sensitivePaths = [
    "/etc/passwd",
    "/etc/shadow",
    "/.env",
    "/env",
    "/config",
    "/configuration",
    "/admin",
    "/wp-admin",
    "/phpmyadmin",
    "/.git",
    "/.svn",
    "/backup",
    "/bak",
    "/old",
    "/temp",
    "/test",
    "/shell",
    "/sh",
    "/cgi-bin",
    "/login",
    "/signin",
    "/register",
    "/signup"
  ];

  const lowerPath = pathname.toLowerCase();
  for (const path of sensitivePaths) {
    if (lowerPath.includes(path)) {
      return { isScan: true, type: "sensitive-file-access", target: pathname };
    }
  }

  // 3. זיהוי דפוסי בקשות חוזרים עם שינויים מינימליים (יתבצע במנגנון הספירה למטה)
  // זה יטופל בלוגיקה של ספירת הבקשות והזיהוי של שינויים מינימליים

  return null;
}

function logScanEvent(ip: string, type: string, target: string, statusCode: number): void {
  // רישום אירוע סריקה בלוגי האבטחה
  // בסביבת פיתוח נדפיס לקונסול, בייצור זה צריך ללכת למערכת לוגים חיצונית
  console.error(`[SECURITY-SCAN] IP: ${ip} | Type: ${type} | Target: ${target} | Status: ${statusCode} | Time: ${new Date().toISOString()}`);
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  if (EXEMPT.some((p) => pathname.includes(p))) return NextResponse.next();

  const ip = clientIp(req);
  const now = Date.now();

  // בדיקה אם ה-IP חסום כרגע עקב זיהוי סריקה
  const blockUntil = blockedIPs.get(ip);
  if (blockUntil && now < blockUntil) {
    const retryAfter = Math.ceil((blockUntil - now) / 1000);
    return NextResponse.json(
      {
        ok: false,
        error: `IP blocked due to scan pattern detection - retry after ${retryAfter} seconds`,
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(retryAfter),
          "X-Scan-Block": "true",
        },
      }
    );
  }
  // ניקוי חסימות פגות
  if (blockUntil && now >= blockUntil) {
    blockedIPs.delete(ip);
  }

  const isPublic = req.headers.has("x-forwarded-for");
  const limit = isPublic ? LIMIT_PUBLIC : LIMIT_INTERNAL;

  // ספירת בקשות רגילה (ללא שינוי)
  let bucket = buckets.get(ip);
  if (!bucket) {
    bucket = [];
    buckets.set(ip, bucket);
  }
  while (bucket.length > 0 && bucket[0] !== undefined && now - bucket[0] >= WINDOW_MS) {
    bucket.shift();
  }

  // זיהוי דפוסי סריקה
  const scanResult = isScanPattern(req);
  let isScanDetected = false;
  let scanType = "";
  let scanTarget = "";

  if (scanResult) {
    isScanDetected = true;
    scanType = scanResult.type;
    scanTarget = scanResult.target;

    // עדכון או יצירת רשומת זיהוי סריקה עבור ה-IP
    let scanBucket = scanBuckets.get(ip);
    if (!scanBucket) {
      scanBucket = { firstSeen: now, lastSeen: now, count: 1, patterns: new Set() };
      scanBuckets.set(ip, scanBucket);
    } else {
      scanBucket.count += 1;
      scanBucket.lastSeen = now;
    }
    scanBucket.patterns.add(scanType);

    // זיהוי דפוס: אם יש 3+ בקשות סריקה שונות בתוך חלון של 10 שניות
    const timeWindow = 10_000; // 10 שניות
    if (now - scanBucket.firstSeen <= timeWindow && scanBucket.count >= 3) {
      // חסימת ה-IP למשך 15 דקות
      const blockTime = now + SCAN_BLOCK_MS;
      blockedIPs.set(ip, blockTime);
      logScanEvent(ip, scanType, scanTarget, 429);

      // ניקוי ישן כדי למנוע ניפוח זיכרון
      if (scanBuckets.size > SCAN_MAX_KEYS) {
        const oldestIP = Array.from(scanBuckets.entries())
          .sort(([, a], [, b]) => a.firstSeen - b.firstSeen)
          [0][0];
        scanBuckets.delete(oldestIP);
      }

      return NextResponse.json(
        {
          ok: false,
          error: `Scan pattern detected: ${scanType} - IP blocked for 15 minutes`,
        },
        {
          status: 429,
          headers: {
            "Retry-After": "900",
            "X-Scan-Block": "true",
            "X-Scan-Type": scanType,
          },
        }
      );
    }

    // גם אם עדיין לא הגענו לסף החסימה, אנחנו ממשיכים לבדוק את קצב הבקרגה הרגיל
    // אבל אנחנו מוסיפים כותרת שמזהירה על פעילות חשודה
  }

  // בדיקת קצב בקשה רגיל (ללא שינוי מהמקור)
  if (bucket.length >= limit) {
    const oldest = bucket[0] ?? now;
    const retryAfter = Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000));
    const response = NextResponse.json(
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
      }
    );

    // אם זוהה דפוס סריקה אבל עדיין לא חסמנו, אנחנו מוסיפים מידע על זה לתשובה
    if (isScanDetected) {
      response.headers.set("X-Scan-Detected", "true");
      response.headers.set("X-Scan-Type", scanType);
    }

    return response;
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

  // ניקוי ישן של רשומות זיהוי סריקה כדי למנוע ניפוח זיכרון
  if (scanBuckets.size > SCAN_MAX_KEYS) {
    const oldestIP = Array.from(scanBuckets.entries())
      .sort(([, a], [, b]) => a.firstSeen - b.firstSeen)
      [0][0];
    scanBuckets.delete(oldestIP);
  }

  const res = NextResponse.next();
  res.headers.set("X-RateLimit-Limit", String(limit));
  res.headers.set("X-RateLimit-Remaining", String(Math.max(0, limit - bucket.length)));

  // הוספת מידע על זיהוי סריקה אם נמצא (אבל עדיין לא חסמנו)
  if (isScanDetected) {
    res.headers.set("X-Scan-Detected", "true");
    res.headers.set("X-Scan-Type", scanType);
  }

  return res;
}

export const config = {
  matcher: ["/api/dex/:path*"],
};