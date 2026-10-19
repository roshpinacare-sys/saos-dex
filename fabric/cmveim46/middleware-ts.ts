import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";

// Rate limiting constants (existing)
const WINDOW_MS = 60_000;
const LIMIT_INTERNAL = 2_000;
const LIMIT_PUBLIC = 240;
const MAX_KEYS = 5_000;
const EXEMPT = ["/api/dex/stream", "/api/revive"];

// Behavioral anomaly detection constants
const BEHAVIOR_WINDOW_MS = 300_000; // 5 minutes
const MAX_PROFILES = 10_000;
const SUSPICIOUS_PATHS = ["/api/dex/settle", "/api/dex/transfer", "/api/dex/order", "/api/dex/swap"];
const REQUEST_VELOCITY_THRESHOLD = 50; // requests per minute
const PATH_ENTROPY_THRESHOLD = 0.7; // Shannon entropy threshold for path diversity

// In-memory stores (in production, replace with Redis or similar)
const requestCounts = new Map<string, { count: number; resetTime: number }>();
const behaviorProfiles = new Map<string, {
  firstSeen: number;
  lastSeen: number;
  requestCount: number;
  pathFrequencies: Map<string, number>;
  hourlyPattern: number[24];
  avgIntervalMs: number;
  lastRequestTime: number;
}>();

function getClientIP(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    req.headers.get("x-real-ip") ??
    req.ip ??
    "unknown";
}

function hashProfileKey(ip: string, userAgent: string | null): string {
  return createHash("sha256")
    .update(`${ip}|${userAgent || ""}`)
    .digest("hex")
    .slice(0, 16);
}

function updateBehaviorProfile(
  profileKey: string,
  ip: string,
  pathname: string,
  now: number
): void {
  const profile = behaviorProfiles.get(profileKey) ?? {
    firstSeen: now,
    lastSeen: now,
    requestCount: 0,
    pathFrequencies: new Map(),
    hourlyPattern: new Array(24).fill(0),
    avgIntervalMs: 0,
    lastRequestTime: now,
  };

  const hour = new Date(now).getHours();
  profile.lastSeen = now;
  profile.requestCount += 1;
  profile.hourlyPattern[hour] += 1;

  const currentPathCount = profile.pathFrequencies.get(pathname) ?? 0;
  profile.pathFrequencies.set(pathname, currentPathCount + 1);

  if (profile.lastRequestTime > 0) {
    const interval = now - profile.lastRequestTime;
    if (profile.avgIntervalMs === 0) {
      profile.avgIntervalMs = interval;
    } else {
      // Exponential moving average with alpha=0.1
      profile.avgIntervalMs = 0.1 * interval + 0.9 * profile.avgIntervalMs;
    }
  }
  profile.lastRequestTime = now;

  behaviorProfiles.set(profileKey, profile);

  // Cleanup old profiles
  if (behaviorProfiles.size > MAX_PROFILES) {
    const oldestKey = Array.from(behaviorProfiles.entries())
      .sort(([, a], [, b]) => a.lastSeen - b.lastSeen)
      [0][0];
    behaviorProfiles.delete(oldestKey);
  }
}

function calculatePathEntropy(pathFrequencies: Map<string, number>): number {
  const total = Array.from(pathFrequencies.values()).reduce((sum, count) => sum + count, 0);
  if (total === 0) return 0;

  let entropy = 0;
  for (const count of pathFrequencies.values()) {
    const p = count / total;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  // Normalize by log2 of unique paths
  const maxEntropy = Math.log2(pathFrequencies.size);
  return maxEntropy > 0 ? entropy / maxEntropy : 0;
}

function detectBehavioralAnomaly(
  profileKey: string,
  ip: string,
  pathname: string,
  now: number
): { isAnomaly: boolean; reason: string } | null {
  const profile = behaviorProfiles.get(profileKey);
  if (!profile || profile.requestCount < 10) {
    // Not enough data to establish baseline
    return null;
  }

  const hour = new Date(now).getHours();
  const expectedHourlyRate = profile.hourlyPattern[hour] / Math.max(1, profile.requestCount / 24);
  const currentPathFreq = profile.pathFrequencies.get(pathname) ?? 0;
  const pathEntropy = calculatePathEntropy(profile.pathFrequencies);

  // Check 1: Sudden change in request velocity
  if (profile.avgIntervalMs > 0) {
    const expectedInterval = profile.avgIntervalMs;
    // This would need the last request time from current context - simplified
    // In practice, we'd compare current interval to historical average
  }

  // Check 2: Access to suspicious paths with low historical frequency
  if (SUSPICIOUS_PATHS.includes(pathname)) {
    const historicalFreq = currentPathFreq;
    const totalRequests = profile.requestCount;
    const historicalRatio = historicalFreq / totalRequests;
    
    // If user suddenly accesses sensitive endpoints they rarely use
    if (historicalRatio < 0.01 && totalRequests > 50) {
      return {
        isAnomaly: true,
        reason: `sudden access to sensitive endpoint ${pathname} (historical ratio: ${historicalRatio.toFixed(3)})`,
      };
    }
  }

  // Check 3: Abnormally high path diversity (potential scanning)
  if (pathEntropy > PATH_ENTROPY_THRESHOLD && profile.requestCount > 20) {
    return {
      isAnomaly: true,
      reason: `high path entropy (${pathEntropy.toFixed(3)}) indicating potential endpoint scanning`,
    };
  }

  // Check 4: Request rate deviation from hourly baseline
  const minuteOfHour = new Date(now).getMinutes();
  const expectedRateThisMinute = (profile.hourlyPattern[hour] / 60) * (1 + Math.sin(minuteOfHour * Math.PI / 30));
  // Simplified: in practice we'd track per-minute rates

  return null;
}

function logAnomaly(
  ip: string,
  profileKey: string,
  pathname: string,
  reason: string,
  now: number
): void {
  console.warn(
    JSON.stringify({
      timestamp: new Date(now).toISOString(),
      action: "behavioral_anomaly_detected",
      ip,
      profile_key: profileKey,
      path: pathname,
      reason,
    })
  );
}

async function rateLimit(req: NextRequest): Promise<NextResponse | null> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return null;

  const pathname = req.nextUrl.pathname;
  if (EXEMPT.some((exempt) => pathname.startsWith(exempt))) return null;

  const ip = getClientIP(req);
  const userAgent = req.headers.get("user-agent") || null;
  const profileKey = hashProfileKey(ip, userAgent);
  const now = Date.now();

  // Rate limiting (existing logic)
  const rateLimitInfo = requestCounts.get(ip) ?? { count: 0, resetTime: now + WINDOW_MS };
  if (now > rateLimitInfo.resetTime) {
    requestCounts.set(ip, { count: 1, resetTime: now + WINDOW_MS });
  } else {
    rateLimitInfo.count += 1;
    requestCounts.set(ip, rateLimitInfo);

    const limit = pathname.startsWith("/api/") && !pathname.startsWith("/api/dex/stream")
      ? LIMIT_PUBLIC
      : LIMIT_INTERNAL;
    
    if (rateLimitInfo.count > limit) {
      return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
    }
  }

  // Behavioral anomaly detection (new)
  updateBehaviorProfile(profileKey, ip, pathname, now);
  const anomaly = detectBehavioralAnomaly(profileKey, ip, pathname, now);

  if (anomaly) {
    logAnomaly(ip, profileKey, pathname, anomaly.reason, now);
    return NextResponse.json(
      { error: "Behavioral anomaly detected", detail: anomaly.reason },
      { status: 403 }
    );
  }

  return null;
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const rateLimitResponse = await rateLimit(req);
  if (rateLimitResponse) return rateLimitResponse;

  return NextResponse.next();
}
