import { NextRequest, NextResponse } from "next/server";

/**
 * rate-limit — EXEC-CD-44 · סגירת-פער-P3 מ-ROADMAP-42-GAPS.md ("אפס-rate-limit ציבורי")
 * ═════════════════════════════════════════════════════════════════════════════════════
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
 * ── W10 · אשרור-הבעלים ("מאשר") — שכבות-מדודות-על-גבי-הליבה-הבלתי-משתנית ──
 * הליבה (חלון-דקה, מדרגות, פטורים, אנטי-נפיחה) נשמרת-מילה-במילה מה-live שקדם-להרכב.
 * השכבות-שנוספו (מקורן-בהצעות-fabric-מאושרות; כולן-לוג-בלבד-או-moot-כברירת-מחדל):
 *  · cmvdn0tb — לוג-מבני-JSON על-כל-429 (ערוץ-ניטור-אמיתי, בלי-השפעה).
 *  · cmvdkj2e — התראה-מוקדמת-מדודה: תעבורת-גייטוויי-בלבד שחצתה 100/דק' (מתחת-
 *    לתקרת-240) מדווחת-פעם-בדקה-ל-IP. ה-harness-הפנימי-נמדד-בקצף-קבוע ולכן
 *    אינו-מדווח — אחרת-רעש-לוג-תמידי-ללא-ערך (תיקון-ה"ספי-סף" מ-W8-a).
 *  · cmvdo3gm — IDS/IPS מותנה-env: כבוי-כברירת-מחדל (IDS_ENABLED-לא-מוגדר →
 *    אפס-שינוי-התנהגות). בהפעלה: סריקת-נתיבים / כוח-גס / חריגה → 403-לתקופה.
 *    כל-הספים-ניתנים-כוונון-env. אזהרה-כנה-בהפעלה: סף-סריקה-5-נתיבים/דק'
 *    עלול-לפגוע-בממשקים-לגיטימיים-הפוגעים-בנקודות-רבות — כוונן-לפני-הפעלה.
 *    (ה-matcher-הכפול-של-ה-live נשמר — כולל-ה-proxy /saos-dex/api/dex/*;
 *     ה-trackers-מנוגמים-בזיכרון-גם-כשמופעלים — תיקוני-W8-a.)
 * ההחלטה-שלא-להרכיב-את-cmvdlfbq/cmvdi78i כמותן: מערכות-זיהוי-כפולות-על-אותם-
 * יעדים-עם-חולשות-מדודות (XFF-ראשון-ניתן-לזיוף; דפוסי-substring-עם-שקרים-
 * חיוביים-המוניים; setInterval-ב-Edge) — ה-IDS-של-cmvdo3gm כולל-את-היכולות-
 * האמיתיות-שלהן. נרשם-באינדקס-השיפוט.
 */
const WINDOW_MS = 60_000;
const LIMIT_INTERNAL = 2_000;
const LIMIT_PUBLIC = 240;
const MAX_KEYS = 5_000;
const EXEMPT = ["/api/dex/stream", "/api/revive"];

// ── cmvdkj2e (מאושר): התראה-מוקדמת-מדודה ──
const EARLY_WARN_THRESHOLD = 100; // מתחת-לתקרה-הציבורית (240)
const lastWarn = new Map<string, number>(); // ip -> חותמת-ההתראה-האחרונה
const EARLY_WARN_MAX_KEYS = 5_000;

function earlyWarn(ip: string, pathname: string, now: number): void {
  const prev = lastWarn.get(ip);
  if (prev !== undefined && now - prev < WINDOW_MS) return; // פעם-בדקה-ל-IP
  lastWarn.set(ip, now);
  if (lastWarn.size > EARLY_WARN_MAX_KEYS) {
    const oldest = lastWarn.keys().next().value;
    if (oldest !== undefined) lastWarn.delete(oldest);
  }
  console.warn(
    JSON.stringify({
      timestamp: new Date(now).toISOString(),
      action: "traffic_alert",
      ip,
      path: pathname,
      note: `crossed ${EARLY_WARN_THRESHOLD} req/min (early warning, below public budget)`,
    }),
  );
}

// ── cmvdn0tb (מאושר): לוג-מבני-על-429 ──
function logUnauthorizedAccess(ip: string, pathname: string, status: number, reason: string): void {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      ip,
      path: pathname,
      action: "unauthorized_access_attempt",
      status,
      reason,
    }),
  );
}

// ── cmvdo3gm (מאושר): IDS/IPS מותנה-env — כבוי-כברירת-מחדל ──
const IDS_ENABLED = process.env.IDS_ENABLED?.toLowerCase() === "true" || false;
const IDS_PORT_SCAN_THRESHOLD = parseInt(process.env.IDS_PORT_SCAN_THRESHOLD ?? "5", 10);
const IDS_BRUTE_FORCE_THRESHOLD = parseInt(process.env.IDS_BRUTE_FORCE_THRESHOLD ?? "10", 10);
const IDS_ANOMALY_THRESHOLD = parseInt(process.env.IDS_ANOMALY_THRESHOLD ?? "100", 10);
const IDS_BLOCK_DURATION_MS = parseInt(process.env.IDS_BLOCK_DURATION_MS ?? "300000", 10); // 5 דקות

const portScanTracker = new Map<string, { paths: Set<string>; firstSeen: number }>();
const bruteForceTracker = new Map<string, { count: number; firstSeen: number }>();
const anomalyTracker = new Map<string, { count: number; firstSeen: number }>();
const blockedIPs = new Map<string, number>(); // ip -> unblockTime

// תיקון-W8-a: גימום-זיכרון-גם-בהפעלה — תוקפי-זיוף-IP לא-ינפחו-את-ה-trackers
function trimTracker<T>(m: Map<string, T>): void {
  if (m.size <= MAX_KEYS) return;
  const it = m.keys();
  for (let i = 0; i < 1_000; i += 1) {
    const k = it.next();
    if (k.done) break;
    m.delete(k.value);
  }
}

function isBlocked(ip: string): boolean {
  const unblockTime = blockedIPs.get(ip);
  if (!unblockTime) return false;
  if (Date.now() >= unblockTime) {
    blockedIPs.delete(ip);
    return false;
  }
  return true;
}

function blockIP(ip: string, durationMs: number): void {
  blockedIPs.set(ip, Date.now() + durationMs);
  // ניקוי-נתוני-מעקב-ל-IP-חסום (מ-cmvdo3gm כמותו)
  portScanTracker.delete(ip);
  bruteForceTracker.delete(ip);
  anomalyTracker.delete(ip);
}

function detectPortScan(ip: string, pathname: string): boolean {
  const tracker = portScanTracker.get(ip);
  const now = Date.now();

  if (!tracker) {
    portScanTracker.set(ip, { paths: new Set([pathname]), firstSeen: now });
    trimTracker(portScanTracker);
    return false;
  }

  tracker.paths.add(pathname);

  // Reset if window expired
  if (now - tracker.firstSeen > WINDOW_MS) {
    tracker.paths.clear();
    tracker.paths.add(pathname);
    tracker.firstSeen = now;
    return false;
  }

  return tracker.paths.size >= IDS_PORT_SCAN_THRESHOLD;
}

function detectBruteForce(ip: string, pathname: string): boolean {
  const authPaths = ["/login", "/api/token", "/api/dex/onramp", "/api/dex/faucet"];
  if (!authPaths.some(path => pathname.includes(path))) return false;

  const tracker = bruteForceTracker.get(ip);
  const now = Date.now();

  if (!tracker) {
    bruteForceTracker.set(ip, { count: 1, firstSeen: now });
    trimTracker(bruteForceTracker);
    return false;
  }

  tracker.count++;

  // Reset if window expired
  if (now - tracker.firstSeen > WINDOW_MS) {
    tracker.count = 1;
    tracker.firstSeen = now;
    return false;
  }

  return tracker.count >= IDS_BRUTE_FORCE_THRESHOLD;
}

function detectAnomaly(ip: string): boolean {
  const tracker = anomalyTracker.get(ip);
  const now = Date.now();

  if (!tracker) {
    anomalyTracker.set(ip, { count: 1, firstSeen: now });
    trimTracker(anomalyTracker);
    return false;
  }

  tracker.count++;

  // Reset if window expired
  if (now - tracker.firstSeen > WINDOW_MS) {
    tracker.count = 1;
    tracker.firstSeen = now;
    return false;
  }

  return tracker.count >= IDS_ANOMALY_THRESHOLD;
}

function logSecurityEvent(ip: string, eventType: string, details: string): void {
  if (process.env.NODE_ENV !== "production") {
    console.log(`[IDS/IPS] ${eventType} from IP ${ip}: ${details}`);
  }
  // In production, this would integrate with the existing logging system
  // For now, we use console as placeholder that aligns with existing patterns
}

const buckets = new Map<string, number[]>();

function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1] ?? "proxied";
    return "proxied";
  }
  return req.headers.get("x-real-ip") ?? "local";
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  if (EXEMPT.some((p) => pathname.includes(p))) return NextResponse.next();

  const ip = clientIp(req);

  // ── שכבת-IDS (cmvdo3gm) — רק-כשהופעלה-מפורשות-על-ידי-הבעלים ──
  if (IDS_ENABLED) {
    // Check if IP is currently blocked
    if (isBlocked(ip)) {
      return NextResponse.json(
        {
          ok: false,
          error: "access blocked due to security policy",
        },
        { status: 403 }
      );
    }

    // Port scan detection
    if (detectPortScan(ip, pathname)) {
      logSecurityEvent(ip, "PORT_SCAN_DETECTED", `Scanned ${portScanTracker.get(ip)?.paths.size} unique paths`);
      blockIP(ip, IDS_BLOCK_DURATION_MS);
      return NextResponse.json(
        {
          ok: false,
          error: "security block: port scan detected",
        },
        { status: 403 }
      );
    }

    // Brute force detection
    if (detectBruteForce(ip, pathname)) {
      logSecurityEvent(ip, "BRUTE_FORCE_DETECTED", `Exceeded auth attempt threshold`);
      blockIP(ip, IDS_BLOCK_DURATION_MS);
      return NextResponse.json(
        {
          ok: false,
          error: "security block: brute force detected",
        },
        { status: 403 }
      );
    }

    // Anomaly detection
    if (detectAnomaly(ip)) {
      logSecurityEvent(ip, "ANOMALY_DETECTED", `Exceeded request rate threshold`);
      blockIP(ip, IDS_BLOCK_DURATION_MS);
      return NextResponse.json(
        {
          ok: false,
          error: "security block: anomalous behavior detected",
        },
        { status: 403 }
      );
    }
  }

  // ── הליבה: EXEC-CD44 מילה-במילה + G104 (trace 1a17d5314095aa65 · §3 תיקון-נגישות) ──
  // נמדד-חי 2026-10-27T13:40Z: שכבת-ה-proxy הפנימית מזריקה XFF לכל-בקשה — גם-תעבורת
  // רשת-מקומית-טהורה (organs/harness/probes מ-127.0.0.1) נשפטה-ציבורית (240/דק') וה-hft-loop
  // לבדו (~120-240/דק') שיתק את-כל-המש (429 מתמשך: army/seed/probes). כוונת-המדרגות
  // המקורית (2,000/דק' לתעבורת-רשת-מקומית) נשמרת: XFF שקצהו-האחרון לופבק = גייטוויי
  // מקומי = מדרגה-פנימית. XFF חיצוני-אמיתי נשאר 240/דק'. אפס-שינוי-מהליבה-עצמה.
  const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
  const isPublic = req.headers.has("x-forwarded-for") ? !LOOPBACK.has(clientIp(req)) : false;
  const limit = isPublic ? LIMIT_PUBLIC : LIMIT_INTERNAL;

  const now = Date.now();

  // התראה-מוקדמת (cmvdkj2e) — תעבורת-גייטוויי-בלבד, לוג-בלבד, מתחת-לתקרה
  if (isPublic && bucketCount(buckets.get(ip)) + 1 >= EARLY_WARN_THRESHOLD) {
    earlyWarn(ip, pathname, now);
  }

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
    logUnauthorizedAccess(ip, pathname, 429, "rate_limit_exceeded"); // cmvdn0tb (מאושר)
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

// עוזר-מקומי-להתראה-המוקדמת: ספירה-נוכחית-בחלון (בלי-לשנות-את-ה-bucket)
function bucketCount(bucket: number[] | undefined): number {
  if (!bucket) return 0;
  const now = Date.now();
  let n = 0;
  for (const t of bucket) if (now - t < WINDOW_MS) n += 1;
  return n;
}

export const config = {
  // ה-matcher-הכפול-של-ה-live נשמר-מילה-במילה — כולל-ה-proxy (תיקון-W8-a ל-cmvdo3gm)
  matcher: ["/api/dex/:path*", "/saos-dex/api/dex/:path*"],
};
