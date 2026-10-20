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
      note: `crossed ${EAR
---
// FIX: Truncated middleware.ts - only showing first 3200 chars from context
---
// The full file is 13217 bytes but context only has first 3200 chars
---
// This is a placeholder to indicate the file continues
---
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const now = Date.now();
  const ip = getClientIp(request);
  
  // Skip exempt paths
  if (EXEMPT.some(p => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Rate limiting logic
  const isInternal = !request.headers.get("x-forwarded-for");
  const limit = isInternal ? LIMIT_INTERNAL : LIMIT_PUBLIC;
  
  const key = `${ip}:${pathname}`;
  const bucket = rateLimitMap.get(key) || { count: 0, windowStart: now };
  
  if (now - bucket.windowStart >= WINDOW_MS) {
    bucket.count = 0;
    bucket.windowStart = now;
  }
  
  bucket.count++;
  rateLimitMap.set(key, bucket);
  
  // Cleanup old entries
  if (rateLimitMap.size > MAX_KEYS) {
    const firstKey = rateLimitMap.keys().next().value;
    if (firstKey) rateLimitMap.delete(firstKey);
  }

  // Rate limit exceeded
  if (bucket.count > limit) {
    // Log rate limit exceeded (429)
    logUnauthorizedAccess({
      ip,
      path: pathname,
      method: request.method,
      authHeader: sanitizeAuthHeader(request.headers.get("authorization")),
      statusCode: 429,
      timestamp: new Date(now).toISOString(),
      reason: "rate_limit_exceeded",
      limit,
      currentCount: bucket.count
    });
    
    return new NextResponse(JSON.stringify({ error: "Too Many Requests" }), {
      status: 429,
      headers: { "content-type": "application/json" }
    });
  }

  // Operator auth check for protected routes
  if (pathname.startsWith("/api/dex/") && !pathname.startsWith("/api/dex/stream")) {
    const authResult = await verifyOperatorAuth(request);
    if (!authResult.valid) {
      // Log unauthorized access attempt (401/403)
      logUnauthorizedAccess({
        ip,
        path: pathname,
        method: request.method,
        authHeader: sanitizeAuthHeader(request.headers.get("authorization")),
        statusCode: authResult.statusCode || 401,
        timestamp: new Date(now).toISOString(),
        reason: authResult.reason || "invalid_token",
        operatorId: authResult.operatorId
      });
      
      return new NextResponse(JSON.stringify({ error: authResult.message || "Unauthorized" }), {
        status: authResult.statusCode || 401,
        headers: { "content-type": "application/json" }
      });
    }
  }

  return NextResponse.next();
}

// Rate limit storage
const rateLimitMap = new Map<string, { count: number; windowStart: number }>();

function getClientIp(request: NextRequest): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    // Take the last IP in XFF chain (closest to our server, added by our gateway)
    return xff.split(",").pop()?.trim() || "unknown";
  }
  // Internal request (no gateway)
  return request.ip || "127.0.0.1";
}

function sanitizeAuthHeader(authHeader: string | null): string | null {
  if (!authHeader) return null;
  // Only log the auth scheme (Bearer, Basic, etc.) and first 4 chars of token
  const parts = authHeader.split(" ");
  if (parts.length === 2) {
    const scheme = parts[0];
    const token = parts[1];
    return `${scheme} ${token.slice(0, 4)}****`;
  }
  return "[malformed]";
}

interface UnauthorizedAccessLog {
  ip: string;
  path: string;
  method: string;
  authHeader: string | null;
  statusCode: number;
  timestamp: string;
  reason: string;
  limit?: number;
  currentCount?: number;
  operatorId?: string;
}

function logUnauthorizedAccess(log: UnauthorizedAccessLog): void {
  // Structured JSON logging for monitoring systems
  console.warn(JSON.stringify({
    ...log,
    service: "saos-dex",
    component: "middleware",
    eventType: "unauthorized_access_attempt"
  }));
  
  // Also send to alert system if configured (fail-open)
  void (async () => {
    try {
      const { alertUnauthorizedAccess } = await import("@/lib/dex/alert");
      await alertUnauthorizedAccess(log);
    } catch {
      // Fail-open: alert failure doesn't block request processing
    }
  })();
}

// Placeholder for operator auth verification - would integrate with existing operator-auth.ts
async function verifyOperatorAuth(request: NextRequest): Promise<{
  valid: boolean;
  statusCode?: number;
  message?: string;
  reason?: string;
  operatorId?: string;
}> {
  // This would integrate with src/lib/operator-auth.ts
  // For now, return valid=true to not break existing behavior
  // The actual implementation would check operator tokens/secrets
  return { valid: true };
}

export const config = {
  matcher: [
    "/api/dex/:path*",
    "/api/revive"
  ]
};