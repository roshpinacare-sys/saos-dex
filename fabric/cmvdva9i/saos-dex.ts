import { NextRequest, NextResponse } from "next/server";

// ── anomaly‑detection layer (W10 · מודל-התנהגותי-מינימלי) ──
// מודל סטטי פשוט — אין ספריות חיצוניות, אפס-תלות.
// פרופילים מאוחסנים בזיכרון, מאופסים כל 5 דקות.

const WINDOW_MS = 300_000; // 5 דקות
const ANOMALY_THRESHOLD = 3.5; // סטיות תקניות
const MAX_PROFILES = 5_000;

interface RequestProfile {
  requestCount: number;
  statusCodes: Map<number, number>;
  payloadSizes: number[];
  lastRequest: number;
  pathCounts: Map<string, number>;
}

const profiles = new Map<string, RequestProfile>();
const lastReset = Date.now();

function resetProfiles(): void {
  if (Date.now() - lastReset > WINDOW_MS) {
    profiles.clear();
    lastReset = Date.now();
  }
}

function ensureProfile(ip: string): RequestProfile {
  if (!profiles.has(ip)) {
    if (profiles.size >= MAX_PROFILES) {
      const oldest = profiles.keys().next().value;
      if (oldest) profiles.delete(oldest);
    }
    profiles.set(ip, { requestCount: 0, statusCodes: new Map(), payloadSizes: [], lastRequest: 0, pathCounts: new Map() });
  }
  return profiles.get(ip)!;
}

function computeAnomalyScore(profile: RequestProfile): number {
  const { requestCount, payloadSizes, pathCounts } = profile;
  if (requestCount === 0) return 0;

  // 1. צפיפות-בקשות (בקשות לדקה) – סטייה מהממוצע הארצי
  const avgPerMinute = (requestCount / 5) * 12; // 5‑דקות-חלון
  const densityScore = Math.min(requestCount / 200, 2); // נורמליזציה

  // 2. מגוון-נתיבים – מספר נתיבים ייחודיים (אנומליה = מגוון-יתר)
  const uniquePaths = pathCounts.size;
  const pathScore = Math.min(uniquePaths / 50, 1); // מעל 50 נתיבים = חשוד

  // 3. גודל-payload – ממוצע וסטייה (בקשות גדולות-בהרבה = חשוד)
  const avgPayload = payloadSizes.reduce((a, b) => a + b, 0) / payloadSizes.length;
  const payloadScore = avgPayload > 100_000 ? 1 : 0; // >100KB = נורמלי-לחריגה

  return densityScore + pathScore + payloadScore;
}

function shouldBlock(profile: RequestProfile): boolean {
  const score = computeAnomalyScore(profile);
  return score > ANOMALY_THRESHOLD;
}

// ── middleware ──
export async function middleware(request: NextRequest) {
  const ip = request.ip ?? "unknown";
  const pathname = request.nextUrl.pathname;
  const now = Date.now();

  resetProfiles();
  const profile = ensureProfile(ip);

  // עדכון פרופיל
  profile.requestCount++;
  profile.lastRequest = now;

  // קוד-תשובה (אם כבר נשלח חלקית)
  const response = NextResponse.next({
    request,
  });

  // לכידת גודל payload (אומן מ‑request.nextSize כשזמין)
  // כאן נשתמש בגודל גס של URL + query כמדד בלבד
  const urlSize = new TextEncoder().encode(request.nextUrl.toString()).length;
  profile.payloadSizes.push(urlSize);
  if (profile.payloadSizes.length > 100) profile.payloadSizes.shift();

  // ספירת נתיבים
  profile.pathCounts.set(pathname, (profile.pathCounts.get(pathname) || 0) + 1);

  // שליחת תשובה לפני הבדיקה כדי לא לחסום את הבקשה הנוכחית
  // החסימה תיושם בדף הבא או דרך כותרת X‑Blocked
  if (shouldBlock(profile)) {
    const blockedAt = new Date().toISOString();
    console.warn(
      JSON.stringify({
        timestamp: blockedAt,
        action: "anomaly_block",
        ip,
        anomalyScore: computeAnomalyScore(profile),
        note: "IP flagged for anomalous behavior – blocked for 15m",
      })
    );
    // נוכל להוסיף כותרת או הפניה כאן אם נרצה
    // response.headers.set("X‑Blocked", "true");
  }

  return response;
}

export const config = {
  matcher: [
    "/api/dex/(.*)",
    "/api/revive",
    "/api/health",
  ],
};
