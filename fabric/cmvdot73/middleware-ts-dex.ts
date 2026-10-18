import { NextRequest, NextResponse } from "next/server";
import { createLogger, format, transports } from "winston";

const logger = createLogger({
  level: "warn",
  format: format.combine(
    format.timestamp({ format: "ISO" }), 
    format.errors({ stack: true }), 
    format.splat(), 
    format.json()
  ),
  transports: [new transports.Console()],
});

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
 */
const WINDOW_MS = 60_000;
const LIMIT_INTERNAL = 2_000;
const LIMIT_PUBLIC = 240;
const MAX_KEYS = 5_000;
const EXEMPT = ["/api/dex/stream", "/api/revive"];

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
    
    // רישום אירוע חסימה עם פרטי אבטחה רלוונטיים (ללא מידע רגיש)
    logger.warn("Request blocked due to rate limiting", {
      ip,
      timestamp: new Date(now).toISOString(),
      method: req.method,
      path: pathname,
      headers: {
        "user-agent": req.headers.get("user-agent") ?? "unknown",
        "referer": req.headers.get("referer") ?? "none",
        "x-forwarded-for": req.headers.get("x-forwarded-for") ?? "none",
      },
      reason: "rate limit exceeded",
      limit,
      windowMs: WINDOW_MS,
    });

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
      }
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

export const config = {
  matcher: ["/api/dex/:path*"],
};