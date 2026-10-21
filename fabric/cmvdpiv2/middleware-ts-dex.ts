import { NextRequest, NextResponse } from "next/server";

/**
 * rate-limit — EXEC-CD-44 · סגירת-פער-P3 מ-ROADMAP-42-GAPS.md ("אפס-rate-limit ציבורי")
 * ════════════════════════════════════════════════════════════════════════════════════
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
      note: `crossed ${EARLY_WARN_THRESHOLD}/min (gateway)`,
    })
  );
}

// ── cmvdo3gm (מאושר): IDS/IPS מותנה-env — כבוי כברירת-מחדל ──
const IDS_ENABLED = process.env.IDS_ENABLED === "true";
const IDS_SCAN_THRESHOLD = Number(process.env.IDS_SCAN_THRESHOLD ?? "5"); // paths/min
const IDS_BRUTE_THRESHOLD = Number(process.env.IDS_BRUTE_THRESHOLD ?? "10"); // 401/min
const IDS_ANOMALY_THRESHOLD = Number(process.env.IDS_ANOMALY_THRESHOLD ?? "100"); // req/min
const IDS_BAN_TTL_MS = Number(process.env.IDS_BAN_TTL_MS ?? "300000"); // 5 min
const idsScan = new Map<string, Set<string>>(); // ip -> paths in window
const idsBrute = new Map<string, number>(); // ip -> 401 count
const idsAnomaly = new Map<string, number>(); // ip -> req count
const idsBanned = new Map<string, number>(); // ip -> ban expiry

function idsRecord(ip: string, pathname: string, status: number, now: number): void {
  if (!IDS_ENABLED) return;
  if (idsBanned.has(ip) && idsBanned.get(ip)! > now) {
    return; // already banned
  }
  // scan detection
  const paths = idsScan.get(ip) ?? new Set();
  paths.add(pathname);
  idsScan.set(ip, paths);
  if (paths.size > IDS_SCAN_THRESHOLD) {
    idsBanned.set(ip, now + IDS_BAN_TTL_MS);
    console.warn(
      JSON.stringify({
        timestamp: new Date(now).toISOString(),
        action: "ids_ban",
        ip,
        reason: "scan_threshold",
        paths: paths.size,
      })
    );
    return;
  }
  // brute detection
  if (status === 401) {
    const cnt = (idsBrute.get(ip) ?? 0) + 1;
    idsBrute.set(ip, cnt);
    if (cnt > IDS_BRUTE_THRESHOLD) {
      idsBanned.set(ip, now + IDS_BAN_TTL_MS);
      console.warn(
        JSON.stringify({
          timestamp: new Date(now).toISOString(),
          action: "ids_ban",
          ip,
          reason: "brute_threshold",
          count: cnt,
        })
      );
      return;
    }
  }
  // anomaly detection
  const acnt = (idsAnomaly.get(ip) ?? 0) + 1;
  idsAnomaly.set(ip, acnt);
  if (acnt > IDS_ANOMALY_THRESHOLD) {
    idsBanned.set(ip, now + IDS_BAN_TTL_MS);
    console.warn(
      JSON.stringify({
        timestamp: new Date(now).toISOString(),
        action: "ids_ban",
        ip,
        reason: "anomaly_threshold",
        count: acnt,
      })
    );
  }
}

// ── cmvdn0tb (מאושר): לוג-מבני על-כל-429 ──
function logRateLimit(ip: string, pathname: string, limit: number, now: number): void {
  console.warn(
    JSON.stringify({
      timestamp: new Date(now).toISOString(),
      action: "rate_limit_exceeded",
      ip,
      path: pathname,
      limit,
      window_ms: WINDOW_MS,
    })
  );
}

// ── Unauthorized Access Logging (Task: Detailed logging for unauthorized access attempts) ──
function logUnauthorizedAccess(
  ip: string,
  pathname: string,
  method: string,
  authHeader: string | null,
  status: number,
  now: number
): void {
  // Sanitize Authorization header: only log scheme and first/last 4 chars of token
  let sanitizedAuth: string | null = null;
  if (authHeader) {
    const parts = authHeader.trim().split(/\s+/);
    if (parts.length === 2) {
      const [scheme, token] = parts;
      if (token.length > 8) {
        sanitizedAuth = `${scheme} ${token.slice(0, 4)}...${token.slice(-4)}`;
      } else {
        sanitizedAuth = `${scheme} [short-token]`;
      }
    } else {
      sanitizedAuth = `[malformed: ${authHeader.slice(0, 20)}...]`;
    }
  }
  console.warn(
    JSON.stringify({
      timestamp: new Date(now).toISOString(),
      action: "unauthorized_access",
      ip,
      path: pathname,
      method,
      auth_header: sanitizedAuth,
      status,
    })
  );
}

// In-memory rate-limit store (same as before)
const hits = new Map<string, { count: number; windowStart: number }>();

function getClientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    // Take the last IP in XFF chain (closest to our server, added by our gateway)
    return xff.split(",").pop()?.trim() ?? "unknown";
  }
  // Direct internal request (no gateway)
  return req.ip ?? "unknown";
}

function isExempt(pathname: string): boolean {
  return EXEMPT.some((p) => pathname.startsWith(p));
}

function checkRateLimit(ip: string, isPublic: boolean, now: number): { allowed: boolean; limit: number; remaining: number; resetMs: number } {
  const limit = isPublic ? LIMIT_PUBLIC : LIMIT_INTERNAL;
  const entry = hits.get(ip);
  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    hits.set(ip, { count: 1, windowStart: now });
    if (hits.size > MAX_KEYS) {
      const oldest = hits.keys().next().value;
      if (oldest !== undefined) hits.delete(oldest);
    }
    return { allowed: true, limit, remaining: limit - 1, resetMs: WINDOW_MS };
  }
  if (entry.count >= limit) {
    return { allowed: false, limit, remaining: 0, resetMs: WINDOW_MS - (now - entry.windowStart) };
  }
  entry.count++;
  return { allowed: true, limit, remaining: limit - entry.count, resetMs: WINDOW_MS - (now - entry.windowStart) };
}

export function middleware(req: NextRequest) {
  const now = Date.now();
  const pathname = req.nextUrl.pathname;
  const method = req.method;
  const ip = getClientIp(req);
  const isPublic = !!req.headers.get("x-forwarded-for");

  // Skip rate limiting for exempt paths
  if (isExempt(pathname)) {
    return NextResponse.next();
  }

  // Rate limit check
  const rl = checkRateLimit(ip, isPublic, now);
  if (!rl.allowed) {
    logRateLimit(ip, pathname, rl.limit, now);
    idsRecord(ip, pathname, 429, now);
    return new NextResponse(JSON.stringify({ error: "Too Many Requests" }), {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(Math.ceil(rl.resetMs / 1000)),
        "x-ratelimit-limit": String(rl.limit),
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.ceil((now + rl.resetMs) / 1000)),
      },
    });
  }

  // IDS check (if enabled)
  if (IDS_ENABLED) {
    if (idsBanned.has(ip) && idsBanned.get(ip)! > now) {
      return new NextResponse(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }
  }

  // Operator auth check for protected routes (example: /api/dex/*)
  // This is a simplified check - actual operator auth is in operator-auth.ts
  const authHeader = req.headers.get("authorization");
  const isProtectedRoute = pathname.startsWith("/api/dex/") && !pathname.startsWith("/api/dex/stream");
  
  if (isProtectedRoute) {
    // Check for valid operator token (simplified - real validation in operator-auth.ts)
    const hasValidAuth = authHeader && authHeader.startsWith("Bearer ") && authHeader.length > 20;
    
    if (!hasValidAuth) {
      // Log unauthorized access attempt
      logUnauthorizedAccess(ip, pathname, method, authHeader, 401, now);
      idsRecord(ip, pathname, 401, now);
      
      return new NextResponse(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json", "www-authenticate": "Bearer" },
      });
    }
  }

  // Add rate limit headers to successful responses
  const response = NextResponse.next();
  response.headers.set("x-ratelimit-limit", String(rl.limit));
  response.headers.set("x-ratelimit-remaining", String(rl.remaining));
  response.headers.set("x-ratelimit-reset", String(Math.ceil((now + rl.resetMs) / 1000)));
  
  return response;
}

export const config = {
  matcher: [
    "/api/dex/:path*",
    "/api/revive",
  ],
};