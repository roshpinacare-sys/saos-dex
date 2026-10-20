import { NextRequest, NextResponse } from "next/server";

// Behavior Anomaly Detection Module for SAOS-DEX
// Monitors request patterns, risk scoring, and dynamic thresholds

// ── In-memory state (reset on server restart) ─────────────────────
const riskScores = new Map<string, number>(); // ip:riskScore
const endpointCounts = new Map<string, Map<string, number>>(); // ip -> endpoint -> count
const lastReset = new Date();
const RESET_INTERVAL_MS = 60_000; // 1 minute reset window

// ── Dynamic risk thresholds ───────────────────────────────────────
const BASE_RISK_SCORE = 0.0;
const CRITICAL_ENDPOINTS = ["/api/dex/settle", "/api/dex/transfer"];
const HIGH_FREQUENCY_THRESHOLD = 50; // requests per minute per IP
const SUSPICIOUS_NONCE_WINDOW = 30_000; // 30 seconds
const NONCE_DEDUP_THRESHOLD = 3; // same nonce 3+ times = suspicious

// ── Time-of-day weighting factors ─────────────────────────────────
const PEAK_HOURS = [22, 23, 0, 1, 2, 3, 4, 5]; // night/early morning
const OFF_PEAK_MULTIPLIER = 0.5; // lower sensitivity off-peak
const PEAK_MULTIPLIER = 1.5; // higher sensitivity peak

function getTimeWeight(): number {
  const hour = new Date().getHours();
  return PEAK_HOURS.includes(hour) ? PEAK_MULTIPLIER : OFF_PEAK_MULTIPLIER;
}

// ── Helper: extract normalized endpoint ───────────────────────────
function getEndpointKey(req: NextRequest): string {
  const path = req.nextUrl.pathname;
  // Normalize paths with query params to base endpoint
  const basePath = path.split("?")[0];
  return basePath;
}

// ── Helper: extract nonce from request ────────────────────────────
function extractNonce(req: NextRequest): string | null {
  // Check common nonce sources
  const search = req.nextUrl.search;
  const nonceParam = search.get("nonce");
  if (nonceParam) return nonceParam;
  
  // Check body for nonce (for POST requests)
  // Note: body is async, so we store for later check or use headers
  const nonceHeader = req.headers.get("x-nonce");
  if (nonceHeader) return nonceHeader;
  
  return null;
}

// ── Helper: get IP address ────────────────────────────────────────
function getClientIP(req: NextRequest): string {
  // Prefer X-Forwarded-For (last IP in chain, closest to server)
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const ips = xff.split(",").map(s => s.trim());
    return ips[ips.length - 1] || "unknown";
  }
  return req.ip || "unknown";
}

// ── Core: update risk score ───────────────────────────────────────
function updateRiskScore(ip: string, endpoint: string, nonce: string | null): void {
  let score = riskScores.get(ip) ?? BASE_RISK_SCORE;
  
  // 1. Critical endpoint check
  if (CRITICAL_ENDPOINTS.includes(endpoint)) {
    score += 0.3; // critical endpoint access
  }
  
  // 2. Endpoint frequency check
  const ipEndpointMap = endpointCounts.get(ip) ?? new Map();
  const currentCount = ipEndpointMap.get(endpoint) ?? 0;
  ipEndpointMap.set(endpoint, currentCount + 1);
  endpointCounts.set(ip, ipEndpointMap);
  
  if (currentCount + 1 >= HIGH_FREQUENCY_THRESHOLD) {
    score += 0.4; // high frequency detected
  }
  
  // 3. Nonce anomaly check
  if (nonce) {
    const ipNonceMap = (riskScores.get(ip) ?? 0).toString(); // placeholder - use proper map
    // Simple dedup: if same nonce seen recently from same IP
    score += 0.2; // nonce anomaly flag
  }
  
  // 4. Time-of-day weighting
  const timeWeight = getTimeWeight();
  score *= timeWeight;
  
  // Clamp score to 0-1 range
  const clampedScore = Math.min(Math.max(score, 0), 1);
  riskScores.set(ip, clampedScore);
}

// ── Helper: reset scores periodically ─────────────────────────────
function resetRiskScores(): void {
  const now = new Date();
  if (now - lastReset > RESET_INTERVAL_MS) {
    riskScores.clear();
    endpointCounts.clear();
    lastReset = now;
    console.log("[anomaly-detector] Risk scores reset");
  }
}

// ── Export: main middleware handler ───────────────────────────────
export async function middleware(req: NextRequest) {
  // Reset scores periodically
  resetRiskScores();
  
  const ip = getClientIP(req);
  const endpoint = getEndpointKey(req);
  const nonce = extractNonce(req);
  
  // Update risk score
  updateRiskScore(ip, endpoint, nonce);
  
  // Get current risk score
  const currentScore = riskScores.get(ip) ?? BASE_RISK_SCORE;
  
  // Dynamic threshold based on time and load
  const timeWeight = getTimeWeight();
  const dynamicThreshold = 0.6 * timeWeight; // base threshold 0.6, adjusted for time
  
  // Anomaly detection logic
  const isAnomaly = currentScore >= dynamicThreshold;
  
  if (isAnomaly) {
    // Log suspicious activity
    console.warn(JSON.stringify({
      timestamp: new Date().toISOString(),
      action: "behavior_anomaly_detected",
      ip,
      endpoint,
      riskScore: currentScore,
      dynamicThreshold,
      nonce,
      note: "Behavioral anomaly detected - risk score above dynamic threshold"
    }));
    
    // In a production system, here you would:
    // - Add to a persistent alert store
    // - Trigger rate limiting
    // - Potentially flag for manual review
    // - Export to external monitoring system
  }
  
  // Continue request processing
  return NextResponse.next();
}

// ── Export: get current risk scores for monitoring ────────────────
export function getRiskMetrics() {
  resetRiskScores();
  
  const scoresArray = Array.from(riskScores.entries()).map(([ip, score]) => ({
    ip,
    riskScore: score,
    category: score > 0.8 ? "critical" : score > 0.6 ? "high" : score > 0.4 ? "medium" : "low"
  }));
  
  const endpointSummary = Array.from(endpointCounts.entries()).map(([ip, endpoints] => ({
    ip,
    endpointCount: endpoints.size,
    topEndpoints: Array.from(endpoints.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3)
  }));
  
  return {
    timestamp: new Date().toISOString(),
    totalIpsTracked: riskScores.size,
    highRiskIps: scoresArray.filter(s => s.riskScore > 0.6).length,
    criticalIps: scoresArray.filter(s => s.riskScore > 0.8).length,
    scoreDistribution: {
      critical: scoresArray.filter(s => s.riskScore > 0.8).length,
      high: scoresArray.filter(s => s.riskScore > 0.6 && s.riskScore <= 0.8).length,
      medium: scoresArray.filter(s => s.riskScore > 0.4 && s.riskScore <= 0.6).length,
      low: scoresArray.filter(s => s.riskScore <= 0.4).length
    },
    endpointSummary,
    timeWeight: getTimeWeight()
  };
}
