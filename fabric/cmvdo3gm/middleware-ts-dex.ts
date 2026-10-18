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
 */
const WINDOW_MS = 60_000;
const LIMIT_INTERNAL = 2_000;
const LIMIT_PUBLIC = 240;
const MAX_KEYS = 5_000;
const EXEMPT = ["/api/dex/stream", "/api/revive"];

// IDS/IPS Configuration from environment variables with fallback defaults
const IDS_ENABLED = process.env.IDS_ENABLED?.toLowerCase() === "true" || false;
const IDS_PORT_SCAN_THRESHOLD = parseInt(process.env.IDS_PORT_SCAN_THRESHOLD ?? "5", 10);
const IDS_BRUTE_FORCE_THRESHOLD = parseInt(process.env.IDS_BRUTE_FORCE_THRESHOLD ?? "10", 10);
const IDS_ANOMALY_THRESHOLD = parseInt(process.env.IDS_ANOMALY_THRESHOLD ?? "100", 10);
const IDS_BLOCK_DURATION_MS = parseInt(process.env.IDS_BLOCK_DURATION_MS ?? "300000", 10); // 5 minutes

const buckets = new Map<string, number[]>();
const portScanTracker = new Map<string, { paths: Set<string>; firstSeen: number }>();
const bruteForceTracker = new Map<string, { count: number; firstSeen: number }>();
const anomalyTracker = new Map<string, { count: number; firstSeen: number }>();
const blockedIPs = new Map<string, number>(); // ip -> unblockTime

function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1] ?? "proxied";
    return "proxied";
  }
  return req.headers.get("x-real-ip") ?? "local";
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
  // Clean up tracking data for this IP
  portScanTracker.delete(ip);
  bruteForceTracker.delete(ip);
  anomalyTracker.delete(ip);
}

function detectPortScan(ip: string, pathname: string): boolean {
  if (!IDS_ENABLED) return false;
  const tracker = portScanTracker.get(ip);
  const now = Date.now();

  if (!tracker) {
    portScanTracker.set(ip, { paths: new Set([pathname]), firstSeen: now });
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
  if (!IDS_ENABLED) return false;
  const authPaths = ["/login", "/api/token", "/api/dex/onramp", "/api/dex/faucet"];
  if (!authPaths.some(path => pathname.includes(path))) return false;

  const tracker = bruteForceTracker.get(ip);
  const now = Date.now();

  if (!tracker) {
    bruteForceTracker.set(ip, { count: 1, firstSeen: now });
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
  if (!IDS_ENABLED) return false;
  const tracker = anomalyTracker.get(ip);
  const now = Date.now();

  if (!tracker) {
    anomalyTracker.set(ip, { count: 1, firstSeen: now });
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

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  if (EXEMPT.some((p) => pathname.includes(p))) return NextResponse.next();

  const ip = clientIp(req);

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

  // IDS/IPS Detection Logic
  if (IDS_ENABLED) {
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

export const config = {
  matcher: ["/api/dex/:path*"],
};
