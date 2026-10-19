import { NextRequest, NextResponse } from "next/server";
import { getTrustedIP } from "@/lib/dex/trusted-ip";

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
      note: `crossed ${EARLY_WARN_THRESHOLD}/min (public limit ${LIMIT_PUBLIC}/min)`,
    })
  );
}

const rateLimit = new Map<string, { count: number; reset: number }>();

function rateLimitHandler(ip: string, limit: number, pathname: string, now: number): NextResponse | null {
  const record = rateLimit.get(ip);
  if (!record || record.reset < now) {
    rateLimit.set(ip, { count: 1, reset: now + WINDOW_MS });
    return null;
  }
  if (record.count >= limit) {
    console.warn(
      JSON.stringify({
        timestamp: new Date(now).toISOString(),
        action: "rate_limit_exceeded",
        ip,
        path: pathname,
        limit,
      })
    );
    return new NextResponse(JSON.stringify({ error: "Rate limit exceeded" }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
  }
  record.count++;
  return null;
}

export async function middleware(req: NextRequest) {
  const pathname = req.nextUrl.pathname;
  if (EXEMPT.some((path) => pathname.startsWith(path))) {
    return NextResponse.next();
  }

  const now = Date.now();
  const connection = req.socket as any;
  const remoteAddress = connection?.remoteAddress || connection?.socket?.remoteAddress;

  if (!remoteAddress) {
    return new NextResponse(JSON.stringify({ error: "Unable to determine client IP" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const clientIP = remoteAddress.toString();
  const trustedIP = getTrustedIP(req, clientIP);

  let isInternal = false;
  let logNote = "";

  if (trustedIP) {
    isInternal = true;
  } else {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) {
      const ips = xff.split(",").map((ip) => ip.trim());
      const firstIP = ips[0];
      if (firstIP && !/^10\.|^172\.(1[6-9]|2[0-9]|3[0-1])\.|^192\.168\./.test(firstIP)) {
        logNote = `Suspicious X-Forwarded-For with public IP ${firstIP} from ${clientIP}`;
      }
    }
  }

  if (logNote) {
    console.warn(
      JSON.stringify({
        timestamp: new Date(now).toISOString(),
        action: "xff_spoof_attempt",
        clientIP,
        xff: req.headers.get("x-forwarded-for") || null,
        note: logNote,
      })
    );
  }

  const limit = isInternal ? LIMIT_INTERNAL : LIMIT_PUBLIC;
  const rateLimitResponse = rateLimitHandler(clientIP, limit, pathname, now);
  if (rateLimitResponse) return rateLimitResponse;

  if (isInternal && lastWarn.size < EARLY_WARN_MAX_KEYS) {
    const prev = lastWarn.get(clientIP);
    if (prev === undefined || now - prev >= WINDOW_MS) {
      lastWarn.set(clientIP, now);
      console.warn(
        JSON.stringify({
          timestamp: new Date(now).toISOString(),
          action: "traffic_alert",
          ip: clientIP,
          path: pathname,
          note: `crossed ${EARLY_WARN_THRESHOLD}/min (internal limit ${LIMIT_INTERNAL}/min)`,
        })
      );
    }
  }

  return NextResponse.next();
}
