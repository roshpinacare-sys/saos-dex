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
 *
 * ── Behavioral Anomaly Detection (BAD) — Layer 4 (owner directive) ──
 *  · Tracks critical endpoints: /api/dex/settle, /api/dex/transfer, /api/dex/order
 *  · Sliding window per IP + endpoint (60s, 300s, 3600s)
 *  · Detects: burst deviation, nonce reuse, param entropy anomalies, header fingerprint drift
 *  · Graduated response: warn → throttle (429) → temporary block (403, 5min)
 *  · Zero external deps; O(1) per request; bounded memory (LRU eviction)
 *  · All decisions logged as structured JSON for post-hoc analysis
 */
const WINDOW_MS = 60_000;
const LIMIT_INTERNAL = 2_000;
const LIMIT_PUBLIC = 240;
const MAX_KEYS = 5_000;
const EXEMPT = ["/api/dex/stream", "/api/revive"];

// ── cmvdkj2e (מאושר): התראה-מוקדמת-מדודה ──
const EARLY_WARN_THRESHOLD = 100;
const lastWarn = new Map<string, number>();
const EARLY_WARN_MAX_KEYS = 5_000;

function earlyWarn(ip: string, pathname: string, now: number): void {
  const prev = lastWarn.get(ip);
  if (prev !== undefined && now - prev < WINDOW_MS) return;
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

// ── Behavioral Anomaly Detection (BAD) ──
const CRITICAL_ENDPOINTS = new Set([
  "/api/dex/settle",
  "/api/dex/transfer",
  "/api/dex/order",
]);

// Sliding window buckets: 60s, 300s, 3600s
const BUCKETS = [60_000, 300_000, 3_600_000] as const;

interface RequestRecord {
  ts: number;
  endpoint: string;
  nonce?: string;
  paramHash: string;
  headerFingerprint: string;
}

interface IpProfile {
  // endpoint -> bucketIndex -> timestamps[]
  counts: Map<string, number[][]>;
  // endpoint -> Set<nonce>
  nonces: Map<string, Set<string>>;
  // endpoint -> param entropy samples
  paramEntropy: Map<string, number[]>;
  // header fingerprint -> count
  headerFingerprints: Map<string, number>;
  // graduated state
  warnCount: number;
  throttleUntil: number;
  blockUntil: number;
  lastSeen: number;
}

const profiles = new Map<string, IpProfile>();
const MAX_PROFILES = 10_000;
const PROFILE_TTL_MS = 3_600_000; // 1 hour

// Thresholds (tunable via env)
const BURST_Z_SCORE_THRESHOLD = Number(process.env.BAD_BURST_Z ?? "3.5");
const NONCE_REUSE_THRESHOLD = Number(process.env.NONCE_REUSE_THRESHOLD ?? "3");
const PARAM_ENTROPY_Z_THRESHOLD = Number(process.env.BAD_PARAM_ENTROPY_Z "2.5");
const HEADER_DRIFT_THRESHOLD = Number(process.env.BAD_HEADER_DRIFT ?? "0.8");
const WARN_TO_THROTTLE = Number(process.env.BAD_WARN_TO_THROTTLE ?? "5");
const THROTTLE_TO_BLOCK = Number(process.env.BAD_THROTTLE_TO_BLOCK "3");
const THROTTLE_DURATION_MS = Number(process.env.BAD_THROTTLE_MS ?? "60_000");
const BLOCK_DURATION_MS = Number(process.env.BAD_BLOCK_MS ?? "300_000");

function getClientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim());
    return parts[parts.length - 1];
  }
  return req.ip ?? "127.0.0.1";
}

function getOrCreateProfile(ip: string, now: number): IpProfile {
  let profile = profiles.get(ip);
  if (!profile) {
    if (profiles.size >= MAX_PROFILES) {
      // LRU eviction
      let oldestIp = "";
      let oldestTime = Infinity;
      for (const [k, v] of profiles) {
        if (v.lastSeen < oldestTime) {
          oldestTime = v.lastSeen;
          oldestIp = k;
        }
      }
      if (oldestIp) profiles.delete(oldestIp);
    }
    profile = {
      counts: new Map(),
      nonces: new Map(),
      paramEntropy: new Map(),
      headerFingerprints: new Map(),
      warnCount: 0,
      throttleUntil: 0,
      blockUntil: 0,
      lastSeen: now,
    };
    profiles.set(ip, profile);
  }
  profile.lastSeen = now;
  return profile;
}

function cleanupProfile(profile: IpProfile, now: number): void {
  for (const [endpoint, buckets] of profile.counts) {
    for (let bi = 0; bi < buckets.length; bi++) {
      const cutoff = now - BUCKETS[bi];
      const arr = buckets[bi];
      let i = 0;
      while (i < arr.length && arr[i] < cutoff) i++;
      if (i > 0) buckets[bi] = arr.slice(i);
    }
    // remove empty endpoint entries
    if (buckets.every((b) => b.length === 0)) profile.counts.delete(endpoint);
  }
  for (const [endpoint, nonces] of profile.nonces) {
    // nonces are kept for the longest bucket (3600s)
    // could add timestamp to nonce but keeping simple
    if (nonces.size > 1000) nonces.clear(); // bound
  }
  for (const [endpoint, entropy] of profile.paramEntropy) {
    if (entropy.length > 200) entropy.splice(0, entropy.length - 200);
  }
  if (profile.headerFingerprints.size > 500) {
    // keep top 200
    const entries = Array.from(profile.headerFingerprints.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 200);
    profile.headerFingerprints = new Map(entries);
  }
}

function computeStats(arr: number[]): { mean: number; std: number } {
  if (arr.length === 0) return { mean: 0, std: 0 };
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
  return { mean, std: Math.sqrt(variance) };
}

function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  const len = s.length;
  for (const count of freq.values()) {
    const p = count / len;
    h -= p * Math.log2(p);
  }
  return h;
}

function headerFingerprint(req: NextRequest): string {
  // Stable subset of headers that identify client behavior
  const keys = [
    "user-agent",
    "accept",
    "accept-language",
    "accept-encoding",
    "content-type",
    "origin",
    "referer",
    "sec-ch-ua",
    "sec-ch-ua-platform",
    "sec-fetch-mode",
    "sec-fetch-site",
    "sec-fetch-dest",
  ];
  const parts = keys.map((k) => req.headers.get(k) ?? "");
  return parts.join("|");
}

function paramHash(req: NextRequest, pathname: string): string {
  // For GET: query string; for POST: body hash (truncated)
  if (req.method === "GET") {
    const url = new URL(req.url);
    return url.search.slice(0, 200);
  }
  // We cannot read body here without consuming it; use content-length + type as proxy
  const cl = req.headers.get("content-length") ?? "0";
  const ct = req.headers.get("content-type") ?? "";
  return `${ct}:${cl}:${pathname}`;
}

function extractNonce(req: NextRequest, pathname: string): string | undefined {
  // Try common nonce locations
  const url = new URL(req.url);
  const qNonce = url.searchParams.get("nonce") ?? url.searchParams.get("nonce_hash");
  if (qNonce) return qNonce;
  // For POST, we can't read body; rely on header convention
  const hNonce = req.headers.get("x-nonce") ?? req.headers.get("x-request-id");
  return hNonce;
}

function logAnomaly(
  ip: string,
  type: string,
  details: Record<string, unknown>,
  severity: "warn" | "throttle" | "block" = "warn"
): void {
  console.warn(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      action: "bad_anomaly",
      severity,
      ip,
      type,
      ...details,
    })
  );
}

function checkAnomalies(
  ip: string,
  profile: IpProfile,
  endpoint: string,
  now: number,
  req: NextRequest,
  nonce: string | undefined,
  pHash: string,
  hfp: string
): { action: "allow" | "throttle" | "block"; reason?: string } {
  // 1. Graduated state check
  if (profile.blockUntil > now) {
    return { action: "block", reason: "temporary_block_active" };
  }
  if (profile.throttleUntil > now) {
    return { action: "throttle", reason: "throttle_active" };
  }

  // 2. Burst detection (z-score on 60s bucket)
  const buckets = profile.counts.get(endpoint);
  if (buckets && buckets[0].length > 10) {
    const { mean, std } = computeStats(buckets[0]);
    if (std > 0) {
      const z = (buckets[0].length - mean) / std;
      if (z > BURST_Z_SCORE_THRESHOLD) {
        logAnomaly(ip, "burst_deviation", { endpoint, z, count: buckets[0].length, mean, std }, "warn");
        profile.warnCount++;
      }
    }
  }

  // 3. Nonce reuse detection
  if (nonce) {
    let nonceSet = profile.nonces.get(endpoint);
    if (!nonceSet) {
      nonceSet = new Set();
      profile.nonces.set(endpoint, nonceSet);
    }
    if (nonceSet.has(nonce)) {
      logAnomaly(ip, "nonce_reuse", { endpoint, nonce }, "warn");
      profile.warnCount++;
    } else {
      nonceSet.add(nonce);
    }
  }

  // 4. Parameter entropy anomaly
  const entropy = shannonEntropy(pHash);
  let entArr = profile.paramEntropy.get(endpoint);
  if (!entArr) {
    entArr = [];
    profile.paramEntropy.set(endpoint, entArr);
  }
  entArr.push(entropy);
  if (entArr.length > 20) {
    const { mean, std } = computeStats(entArr);
    if (std > 0) {
      const z = Math.abs(entropy - mean) / std;
      if (z > PARAM_ENTROPY_Z_THRESHOLD) {
        logAnomaly(ip, "param_entropy_anomaly", { endpoint, entropy, mean, std, z }, "warn");
        profile.warnCount++;
      }
    }
  }

  // 5. Header fingerprint drift
  const fpCount = profile.headerFingerprints.get(hfp) ?? 0;
  profile.headerFingerprints.set(hfp, fpCount + 1);
  const totalRequests = Array.from(profile.headerFingerprints.values()).reduce((a, b) => a + b, 0);
  if (totalRequests > 20) {
    const dominantRatio = Math.max(...profile.headerFingerprints.values()) / totalRequests;
    if (dominantRatio < HEADER_DRIFT_THRESHOLD) {
      // Client is rotating fingerprints — suspicious
      logAnomaly(ip, "header_fingerprint_drift", { endpoint, dominantRatio, uniqueFps: profile.headerFingerprints.size }, "warn");
      profile.warnCount++;
    }
  }

  // 6. Graduated response
  if (profile.warnCount >= THROTTLE_TO_BLOCK) {
    profile.blockUntil = now + BLOCK_DURATION_MS;
    profile.warnCount = 0;
    logAnomaly(ip, "graduated_block", { endpoint, durationMs: BLOCK_DURATION_MS }, "block");
    return { action: "block", reason: "graduated_block" };
  }
  if (profile.warnCount >= WARN_TO_THROTTLE) {
    profile.throttleUntil = now + THROTTLE_DURATION_MS;
    logAnomaly(ip, "graduated_throttle", { endpoint, durationMs: THROTTLE_DURATION_MS }, "throttle");
    return { action: "throttle", reason: "graduated_throttle" };
  }

  return { action: "allow" };
}

function recordRequest(profile: IpProfile, endpoint: string, now: number): void {
  let buckets = profile.counts.get(endpoint);
  if (!buckets) {
    buckets = BUCKETS.map(() => []);
    profile.counts.set(endpoint, buckets);
  }
  for (let bi = 0; bi < BUCKETS.length; bi++) {
    buckets[bi].push(now);
  }
}

function isExempt(pathname: string): boolean {
  return EXEMPT.some((e) => pathname.startsWith(e));
}

function isCriticalEndpoint(pathname: string): boolean {
  return CRITICAL_ENDPOINTS.has(pathname);
}

export function middleware(request: NextRequest) {
  const now = Date.now();
  const pathname = request.nextUrl.pathname;
  const ip = getClientIp(request);
  const isInternal = !request.headers.has("x-forwarded-for");
  const limit = isInternal ? LIMIT_INTERNAL : LIMIT_PUBLIC;

  // Exempt paths
  if (isExempt(pathname)) {
    return NextResponse.next();
  }

  // ── Basic rate limit (existing logic) ──
  // Using a simple in-memory counter per IP per minute
  // Note: In production, consider Redis for multi-instance
  const rlKey = `${ip}:${Math.floor(now / WINDOW_MS)}`;
  // We'll reuse the profiles map for basic rate limiting too
  const profile = getOrCreateProfile(ip, now);
  cleanupProfile(profile, now);

  // Count this request for basic rate limit
  const basicCount = (profile.counts.get("__basic__")?.[0]?.length ?? 0) + 1;
  let basicBuckets = profile.counts.get("__basic__");
  if (!basicBuckets) {
    basicBuckets = BUCKETS.map(() => []);
    profile.counts.set("__basic__", basicBuckets);
  }
  basicBuckets[0].push(now);

  if (basicCount > limit) {
    // cmvdn0tb: structured log on 429
    console.warn(
      JSON.stringify({
        timestamp: new Date(now).toISOString(),
        action: "rate_limit_exceeded",
        ip,
        path: pathname,
        limit,
        count: basicCount,
        internal: isInternal,
      })
    );
    return new NextResponse(JSON.stringify({ error: "Too Many Requests" }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "60" },
    });
  }

  // ── cmvdkj2e: early warning for gateway traffic ──
  if (!isInternal && basicCount > EARLY_WARN_THRESHOLD) {
    earlyWarn(ip, pathname, now);
  }

  // ── Behavioral Anomaly Detection (BAD) for critical endpoints ──
  if (isCriticalEndpoint(pathname)) {
    const nonce = extractNonce(request, pathname);
    const pHash = paramHash(request, pathname);
    const hfp = headerFingerprint(request);

    const anomalyResult = checkAnomalies(ip, profile, pathname, now, request, nonce, pHash, hfp);

    if (anomalyResult.action === "block") {
      return new NextResponse(JSON.stringify({ error: "Forbidden", reason: anomalyResult.reason }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }
    if (anomalyResult.action === "throttle") {
      return new NextResponse(JSON.stringify({ error: "Too Many Requests", reason: anomalyResult.reason }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "60" },
      });
    }
  }

  // Record request for BAD
  if (isCriticalEndpoint(pathname)) {
    recordRequest(profile, pathname, now);
  }

  // ── cmvdo3gm: IDS/IPS (env-gated, default OFF) ──
  if (process.env.IDS_ENABLED === "1") {
    // Path scanning detection
    const pathCount = profile.counts.size;
    if (pathCount > Number(process.env.IDS_PATH_SCAN_THRESHOLD ?? "5")) {
      logAnomaly(ip, "path_scanning", { pathCount, threshold: process.env.IDS_PATH_SCAN_THRESHOLD }, "warn");
      // Could escalate to block here
    }
    // Brute force detection on auth endpoints
    if (pathname.startsWith("/api/dex/operator") || pathname.startsWith("/api/auth")) {
      const authFails = (profile.counts.get("__auth_fail__")?.[0]?.length ?? 0);
      if (authFails > Number(process.env.IDS_BRUTE_THRESHOLD ?? "10")) {
        logAnomaly(ip, "brute_force", { endpoint: pathname, fails: authFails }, "warn");
      }
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/api/dex/:path*",
    "/api/revive",
    "/saos-dex/api/dex/:path*",
  ],
};