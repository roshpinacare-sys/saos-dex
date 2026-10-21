// src/lib/dex/behavioral-monitor.ts
/**
 * Behavioral Monitor for SAOS-DEX API
 * Detects reentrancy, front-running, sandwich attacks and anomalous patterns
 * Integrates with existing alert system (src/lib/dex/alert.ts) and rate-limit (middleware.ts)
 */

import { createHash } from "node:crypto";
import { alertSecurityEvent } from "./alert";

// ─── Types ──────────────────────────────────────────────────────────────

export interface ApiCallRecord {
  timestamp: number;
  ip: string;
  method: string;
  path: string;
  paramsHash: string; // sha256 of JSON params (no secrets)
  durationMs: number;
  statusCode: number;
  userAgent?: string;
  requestId: string;
}

export interface SuspiciousPattern {
  type: "reentrancy" | "front-running" | "sandwich" | "velocity" | "cost-anomaly" | "burst";
  severity: "low" | "medium" | "high" | "critical";
  ip: string;
  path: string;
  details: Record<string, unknown>;
  detectedAt: number;
  relatedCalls: string[]; // requestIds
}

export interface RiskReport {
  generatedAt: number;
  windowMs: number;
  totalCalls: number;
  uniqueIPs: number;
  patterns: SuspiciousPattern[];
  topOffenders: { ip: string; count: number; patterns: string[] }[];
}

// ─── Configuration ──────────────────────────────────────────────────────

const CONFIG = {
  // Sliding windows
  WINDOW_MS: 60_000, // 1 minute for velocity
  LONG_WINDOW_MS: 5 * 60_000, // 5 minutes for patterns
  
  // Thresholds
  REENTRANCY_MAX_CALLS: 3, // same path+params within window
  REENTRANCY_WINDOW_MS: 500, // 500ms
  
  VELOCITY_MAX_CALLS_PER_IP: 200, // per minute (below rate-limit)
  
  BURST_MAX_CALLS: 10, // within 1 second
  BURST_WINDOW_MS: 1_000,
  
  COST_ANOMALY_MULTIPLIER: 3, // 3x median gas/cost
  
  FRONT_RUN_WINDOW_MS: 2_000, // 2s between suspicious order pairs
  SANDWICH_WINDOW_MS: 5_000, // 5s for sandwich pattern
  
  // Storage limits
  MAX_RECORDS: 10_000,
  MAX_PATTERNS: 1_000,
  
  // Alerting
  ALERT_COOLDOWN_MS: 30_000, // per IP+type
} as const;

// ─── In-Memory Stores (replace with Redis in clustered deployments) ──────

const callRecords: ApiCallRecord[] = [];
const detectedPatterns: SuspiciousPattern[] = [];
const alertCooldowns = new Map<string, number>(); // key -> lastAlertTime

// ─── Helpers ─────────────────────────────────────────────────────────────

function hashParams(params: unknown): string {
  return createHash("sha256").update(JSON.stringify(params)).digest("hex").slice(0, 16);
}

function now(): number {
  return Date.now();
}

function pruneOldRecords(cutoff: number): void {
  while (callRecords.length > 0 && callRecords[0].timestamp < cutoff) {
    callRecords.shift();
  }
  while (detectedPatterns.length > 0 && detectedPatterns[0].detectedAt < cutoff) {
    detectedPatterns.shift();
  }
}

function addAlertCooldown(key: string): boolean {
  const last = alertCooldowns.get(key);
  const n = now();
  if (last !== undefined && n - last < CONFIG.ALERT_COOLDOWN_MS) {
    return false;
  }
  alertCooldowns.set(key, n);
  if (alertCooldowns.size > 5_000) {
    const oldest = alertCooldowns.keys().next().value;
    if (oldest) alertCooldowns.delete(oldest);
  }
  return true;
}

// ─── Core Detection Engine ──────────────────────────────────────────────

function detectReentrancy(record: ApiCallRecord): SuspiciousPattern | null {
  const cutoff = record.timestamp - CONFIG.REENTRANCY_WINDOW_MS;
  const similar = callRecords.filter(
    (r) =>
      r.ip === record.ip &&
      r.path === record.path &&
      r.paramsHash === record.paramsHash &&
      r.timestamp >= cutoff &&
      r.requestId !== record.requestId
  );
  
  if (similar.length >= CONFIG.REENTRANCY_MAX_CALLS) {
    return {
      type: "reentrancy",
      severity: "high",
      ip: record.ip,
      path: record.path,
      details: {
        callCount: similar.length + 1,
        windowMs: CONFIG.REENTRANCY_WINDOW_MS,
        paramsHash: record.paramsHash,
      },
      detectedAt: record.timestamp,
      relatedCalls: [record.requestId, ...similar.map((r) => r.requestId)],
    };
  }
  return null;
}

function detectVelocity(record: ApiCallRecord): SuspiciousPattern | null {
  const cutoff = record.timestamp - CONFIG.WINDOW_MS;
  const ipCalls = callRecords.filter(
    (r) => r.ip === record.ip && r.timestamp >= cutoff
  );
  
  if (ipCalls.length >= CONFIG.VELOCITY_MAX_CALLS_PER_IP) {
    return {
      type: "velocity",
      severity: "medium",
      ip: record.ip,
      path: record.path,
      details: {
        callsInWindow: ipCalls.length,
        windowMs: CONFIG.WINDOW_MS,
      },
      detectedAt: record.timestamp,
      relatedCalls: ipCalls.map((r) => r.requestId),
    };
  }
  return null;
}

function detectBurst(record: ApiCallRecord): SuspiciousPattern | null {
  const cutoff = record.timestamp - CONFIG.BURST_WINDOW_MS;
  const burstCalls = callRecords.filter(
    (r) => r.ip === record.ip && r.timestamp >= cutoff
  );
  
  if (burstCalls.length >= CONFIG.BURST_MAX_CALLS) {
    return {
      type: "burst",
      severity: "high",
      ip: record.ip,
      path: record.path,
      details: {
        callsInWindow: burstCalls.length,
        windowMs: CONFIG.BURST_WINDOW_MS,
      },
      detectedAt: record.timestamp,
      relatedCalls: burstCalls.map((r) => r.requestId),
    };
  }
  return null;
}

function detectCostAnomaly(record: ApiCallRecord): SuspiciousPattern | null {
  // Only for order/swap/pool routes where cost/gas is relevant
  const costPaths = ["/api/dex/order", "/api/dex/swap", "/api/dex/pool", "/api/dex/route"];
  if (!costPaths.some((p) => record.path.startsWith(p))) return null;
  
  // Extract cost from params (best effort)
  // In practice, you'd parse the actual params from request body
  // For now, we use duration as proxy for computational cost
  const cutoff = record.timestamp - CONFIG.LONG_WINDOW_MS;
  const similarCalls = callRecords.filter(
    (r) => r.path === record.path && r.timestamp >= cutoff
  );
  
  if (similarCalls.length < 10) return null; // need baseline
  
  const durations = similarCalls.map((r) => r.durationMs).sort((a, b) => a - b);
  const median = durations[Math.floor(durations.length / 2)];
  
  if (record.durationMs > median * CONFIG.COST_ANOMALY_MULTIPLIER && median > 10) {
    return {
      type: "cost-anomaly",
      severity: "medium",
      ip: record.ip,
      path: record.path,
      details: {
        durationMs: record.durationMs,
        medianDurationMs: median,
        multiplier: record.durationMs / median,
      },
      detectedAt: record.timestamp,
      relatedCalls: [record.requestId],
    };
  }
  return null;
}

function detectFrontRunning(record: ApiCallRecord): SuspiciousPattern | null {
  // Look for rapid order placement/cancellation pairs on same market
  const orderPaths = ["/api/dex/order", "/api/dex/cancel"];
  if (!orderPaths.some((p) => record.path.startsWith(p))) return null;
  
  const cutoff = record.timestamp - CONFIG.FRONT_RUN_WINDOW_MS;
  const recentOrders = callRecords.filter(
    (r) =>
      orderPaths.some((p) => r.path.startsWith(p)) &&
      r.ip !== record.ip && // different IP (potential front-runner)
      r.timestamp >= cutoff
  );
  
  if (recentOrders.length > 0) {
    // Heuristic: multiple order/cancel from different IPs in short window
    const uniqueIPs = new Set(recentOrders.map((r) => r.ip)).size;
    if (uniqueIPs >= 2) {
      return {
        type: "front-running",
        severity: "high",
        ip: record.ip,
        path: record.path,
        details: {
          competingIPs: uniqueIPs,
          windowMs: CONFIG.FRONT_RUN_WINDOW_MS,
          competingCalls: recentOrders.map((r) => r.requestId),
        },
        detectedAt: record.timestamp,
        relatedCalls: [record.requestId, ...recentOrders.map((r) => r.requestId)],
      };
    }
  }
  return null;
}

function detectSandwich(record: ApiCallRecord): SuspiciousPattern | null {
  // Sandwich: large order surrounded by two smaller orders from same IP
  // Simplified: detect 3 rapid orders on same path from same IP with middle being largest
  const orderPaths = ["/api/dex/order", "/api/dex/swap"];
  if (!orderPaths.some((p) => record.path.startsWith(p))) return null;
  
  const cutoff = record.timestamp - CONFIG.SANDWICH_WINDOW_MS;
  const ipOrders = callRecords.filter(
    (r) =>
      r.ip === record.ip &&
      orderPaths.some((p) => r.path.startsWith(p)) &&
      r.timestamp >= cutoff
  );
  
  if (ipOrders.length >= 3) {
    // Sort by timestamp
    ipOrders.sort((a, b) => a.timestamp - b.timestamp);
    // Check if middle call has significantly higher duration (proxy for size)
    const middle = ipOrders[Math.floor(ipOrders.length / 2)];
    const avgOther =
      ipOrders.filter((r) => r !== middle).reduce((sum, r) => sum + r.durationMs, 0) /
      (ipOrders.length - 1);
    
    if (middle.durationMs > avgOther * 2 && avgOther > 5) {
      return {
        type: "sandwich",
        severity: "critical",
        ip: record.ip,
        path: record.path,
        details: {
          middleDurationMs: middle.durationMs,
          avgOtherDurationMs: avgOther,
          orderCount: ipOrders.length,
          windowMs: CONFIG.SANDWICH_WINDOW_MS,
        },
        detectedAt: record.timestamp,
        relatedCalls: ipOrders.map((r) => r.requestId),
      };
    }
  }
  return null;
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Record an API call for behavioral analysis
 * Call this from middleware or route handlers after request completion
 */
export function recordApiCall(
  ip: string,
  method: string,
  path: string,
  params: unknown,
  durationMs: number,
  statusCode: number,
  userAgent?: string,
  requestId?: string
): void {
  const record: ApiCallRecord = {
    timestamp: now(),
    ip,
    method,
    path,
    paramsHash: hashParams(params),
    durationMs,
    statusCode,
    userAgent,
    requestId: requestId ?? createHash("sha256").update(`${ip}:${now()}:${Math.random()}`).digest("hex").slice(0, 12),
  };
  
  callRecords.push(record);
  
  // Prune old records
  if (callRecords.length > CONFIG.MAX_RECORDS) {
    pruneOldRecords(now() - CONFIG.LONG_WINDOW_MS);
  }
  
  // Run detection
  const detectors = [
    detectReentrancy,
    detectVelocity,
    detectBurst,
    detectCostAnomaly,
    detectFrontRunning,
    detectSandwich,
  ];
  
  for (const detect of detectors) {
    const pattern = detect(record);
    if (pattern) {
      detectedPatterns.push(pattern);
      
      // Alert if not in cooldown
      const alertKey = `${pattern.ip}:${pattern.type}`;
      if (addAlertCooldown(alertKey)) {
        void alertSecurityEvent({
          timestamp: new Date(pattern.detectedAt).toISOString(),
          eventType: `behavioral_${pattern.type}`,
          ip: pattern.ip,
          path: pattern.path,
          severity: pattern.severity.toUpperCase() as "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
          details: pattern.details,
        });
      }
    }
  }
  
  // Prune patterns
  if (detectedPatterns.length > CONFIG.MAX_PATTERNS) {
    detectedPatterns.shift();
  }
}

/**
 * Generate a risk report for the current window
 */
export function generateRiskReport(windowMs = CONFIG.LONG_WINDOW_MS): RiskReport {
  const cutoff = now() - windowMs;
  const recentCalls = callRecords.filter((r) => r.timestamp >= cutoff);
  const recentPatterns = detectedPatterns.filter((p) => p.detectedAt >= cutoff);
  
  const ipCounts = new Map<string, number>();
  const ipPatterns = new Map<string, Set<string>>();
  
  for (const p of recentPatterns) {
    ipCounts.set(p.ip, (ipCounts.get(p.ip) ?? 0) + 1);
    const set = ipPatterns.get(p.ip) ?? new Set();
    set.add(p.type);
    ipPatterns.set(p.ip, set);
  }
  
  const topOffenders = Array.from(ipCounts.entries())
    .map(([ip, count]) => ({
      ip,
      count,
      patterns: Array.from(ipPatterns.get(ip) ?? []),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
  
  return {
    generatedAt: now(),
    windowMs,
    totalCalls: recentCalls.length,
    uniqueIPs: new Set(recentCalls.map((r) => r.ip)).size,
    patterns: recentPatterns,
    topOffenders,
  };
}

/**
 * Get recent suspicious patterns (for dashboard/API)
 */
export function getRecentPatterns(limit = 50): SuspiciousPattern[] {
  return detectedPatterns.slice(-limit).reverse();
}

/**
 * Get call records for an IP (for investigation)
 */
export function getCallsForIP(ip: string, limit = 100): ApiCallRecord[] {
  return callRecords.filter((r) => r.ip === ip).slice(-limit).reverse();
}

/**
 * Clear all records (for testing)
 */
export function clearRecords(): void {
  callRecords.length = 0;
  detectedPatterns.length = 0;
  alertCooldowns.clear();
}

// ─── Middleware Integration Helper ──────────────────────────────────────

/**
 * Wrapper for Next.js API routes to automatically record calls
 * Usage: export const GET = withBehavioralMonitor(async (req) => { ... })
 */
export function withBehavioralMonitor(
  handler: (req: Request, context: { ip: string; requestId: string }) => Promise<Response>
) {
  return async (req: Request): Promise<Response> => {
    const start = Date.now();
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
      req.headers.get("x-real-ip") ??
      "unknown";
    const requestId = req.headers.get("x-request-id") ?? createHash("sha256").update(`${ip}:${start}:${Math.random()}`).digest("hex").slice(0, 12);
    
    let params: unknown = {};
    try {
      const clone = req.clone();
      params = await clone.json().catch(() => ({}));
    } catch {}
    
    const response = await handler(req, { ip, requestId });
    
    const durationMs = Date.now() - start;
    recordApiCall(ip, req.method, new URL(req.url).pathname, params, durationMs, response.status, req.headers.get("user-agent") ?? undefined, requestId);
    
    return response;
  };
}

// ─── Scheduled Report Generator (call from cron/interval) ───────────────

export async function generateAndLogPeriodicReport(): Promise<void> {
  const report = generateRiskReport();
  console.log(
    JSON.stringify({
      timestamp: new Date(report.generatedAt).toISOString(),
      type: "behavioral_risk_report",
      summary: {
        totalCalls: report.totalCalls,
        uniqueIPs: report.uniqueIPs,
        patternsDetected: report.patterns.length,
        topOffenderCount: report.topOffenders.length,
      },
      topOffenders: report.topOffenders.slice(0, 5),
    })
  );
  
  // Alert on high-risk conditions
  if (report.patterns.some((p) => p.severity === "critical")) {
    await alertSecurityEvent({
      timestamp: new Date().toISOString(),
      eventType: "behavioral_critical_patterns",
      ip: "multiple",
      path: "/api/dex/*",
      severity: "CRITICAL",
      details: { criticalCount: report.patterns.filter((p) => p.severity === "critical").length },
    });
  }
}