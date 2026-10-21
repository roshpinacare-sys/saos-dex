// src/lib/dex/anomaly-detector.ts
import { createHash } from "node:crypto";

// Configuration constants
const WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const MAX_KEYS = 10_000; // Prevent memory bloat
const ANOMALY_THRESHOLD_STDDEV = 3; // 3 standard deviations
const ANOMALY_THRESHOLD_ABSOLUTE = 100; // 100 requests/minute from single IP
const MIN_SAMPLES_FOR_STATS = 10; // Minimum samples before statistical detection

// In-memory stores (per-process, suitable for single-instance deployment)
const requestCounts = new Map<string, number[]>(); // key -> timestamps[]
const pathAccessCounts = new Map<string, Map<string, number>>(); // ip -> (path -> count)
const alertedAnomalies = new Map<string, number>(); // anomalyKey -> lastAlertTime
const ALERT_COOLDOWN_MS = 60_000; // 1 minute cooldown per anomaly type per IP

/**
 * Generates a consistent key for tracking requests
 */
function makeKey(ip: string, path: string): string {
  return `${ip}:${path}`;
}

/**
 * Generates a key for anomaly alert deduplication
 */
function makeAnomalyKey(ip: string, path: string, type: string): string {
  return `${type}:${ip}:${path}`;
}

/**
 * Cleans up old timestamps outside the window
 */
function pruneTimestamps(timestamps: number[], now: number): number[] {
  const cutoff = now - WINDOW_MS;
  return timestamps.filter(ts => ts > cutoff);
}

/**
 * Calculates mean and standard deviation of request counts per minute
 */
function calculateStats(timestamps: number[], now: number): { mean: number; stddev: number; count: number } {
  if (timestamps.length < MIN_SAMPLES_FOR_STATS) {
    return { mean: 0, stddev: 0, count: timestamps.length };
  }
  
  // Bucket into 1-minute intervals
  const buckets = new Map<number, number>();
  const windowStart = now - WINDOW_MS;
  
  for (const ts of timestamps) {
    if (ts < windowStart) continue;
    const minuteBucket = Math.floor(ts / 60_000) * 60_000;
    buckets.set(minuteBucket, (buckets.get(minuteBucket) || 0) + 1);
  }
  
  const counts = Array.from(buckets.values());
  if (counts.length === 0) return { mean: 0, stddev: 0, count: 0 };
  
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const variance = counts.reduce((sum, c) => sum + Math.pow(c - mean, 2), 0) / counts.length;
  const stddev = Math.sqrt(variance);
  
  return { mean, stddev, count: timestamps.length };
}

/**
 * Records a request and checks for anomalies
 * @returns anomaly info if detected, null otherwise
 */
export function recordAndCheckAnomaly(
  ip: string,
  path: string,
  isProtectedPath: boolean,
  userAgent?: string
): { detected: boolean; type: string; details: Record<string, unknown> } | null {
  const now = Date.now();
  const key = makeKey(ip, path);
  
  // Record request timestamp
  const timestamps = requestCounts.get(key) || [];
  timestamps.push(now);
  const pruned = pruneTimestamps(timestamps, now);
  requestCounts.set(key, pruned);
  
  // Track path access per IP for protected path monitoring
  if (isProtectedPath) {
    const ipPaths = pathAccessCounts.get(ip) || new Map();
    ipPaths.set(path, (ipPaths.get(path) || 0) + 1);
    pathAccessCounts.set(ip, ipPaths);
  }
  
  // Cleanup old entries to prevent memory bloat
  if (requestCounts.size > MAX_KEYS) {
    const oldestKey = requestCounts.keys().next().value;
    if (oldestKey) requestCounts.delete(oldestKey);
  }
  if (pathAccessCounts.size > MAX_KEYS) {
    const oldestIp = pathAccessCounts.keys().next().value;
    if (oldestIp) pathAccessCounts.delete(oldestIp);
  }
  
  // Calculate request rate per minute
  const requestsPerMinute = (pruned.length / WINDOW_MS) * 60_000;
  
  // Check absolute threshold anomaly
  if (requestsPerMinute > ANOMALY_THRESHOLD_ABSOLUTE) {
    const anomalyKey = makeAnomalyKey(ip, path, "HIGH_FREQUENCY");
    const lastAlert = alertedAnomalies.get(anomalyKey) || 0;
    if (now - lastAlert > ALERT_COOLDOWN_MS) {
      alertedAnomalies.set(anomalyKey, now);
      return {
        detected: true,
        type: "HIGH_FREQUENCY",
        details: {
          ip,
          path,
          requestsPerMinute: Math.round(requestsPerMinute * 100) / 100,
          threshold: ANOMALY_THRESHOLD_ABSOLUTE,
          windowMs: WINDOW_MS,
          isProtectedPath,
          userAgent: userAgent || "unknown",
          timestamp: new Date(now).toISOString(),
        },
      };
    }
  }
  
  // Check statistical anomaly (3 sigma)
  const { mean, stddev, count } = calculateStats(pruned, now);
  if (count >= MIN_SAMPLES_FOR_STATS && stddev > 0) {
    const currentMinuteCount = pruned.filter(ts => ts > now - 60_000).length;
    if (currentMinuteCount > mean + ANOMALY_THRESHOLD_STDDEV * stddev) {
      const anomalyKey = makeAnomalyKey(ip, path, "STATISTICAL_SPIKE");
      const lastAlert = alertedAnomalies.get(anomalyKey) || 0;
      if (now - lastAlert > ALERT_COOLDOWN_MS) {
        alertedAnomalies.set(anomalyKey, now);
        return {
          detected: true,
          type: "STATISTICAL_SPIKE",
          details: {
            ip,
            path,
            currentCount: currentMinuteCount,
            mean: Math.round(mean * 100) / 100,
            stddev: Math.round(stddev * 100) / 100,
            threshold: "mean + 3*stddev",
            windowMs: WINDOW_MS,
            isProtectedPath,
            userAgent: userAgent || "unknown",
            timestamp: new Date(now).toISOString(),
          },
        };
      }
    }
  }
  
  // Check for repeated access to protected paths
  if (isProtectedPath) {
    const ipPaths = pathAccessCounts.get(ip);
    if (ipPaths) {
      const protectedPathCount = Array.from(ipPaths.entries())
        .filter(([p]) => isProtectedPathCheck(p))
        .reduce((sum, [, c]) => sum + c, 0);
      
      if (protectedPathCount > 20) { // Threshold for repeated protected access
        const anomalyKey = makeAnomalyKey(ip, "protected_paths", "REPEATED_PROTECTED_ACCESS");
        const lastAlert = alertedAnomalies.get(anomalyKey) || 0;
        if (now - lastAlert > ALERT_COOLDOWN_MS) {
          alertedAnomalies.set(anomalyKey, now);
          return {
            detected: true,
            type: "REPEATED_PROTECTED_ACCESS",
            details: {
              ip,
              protectedPathsAccessed: Array.from(ipPaths.keys()).filter(isProtectedPathCheck),
              totalProtectedRequests: protectedPathCount,
              threshold: 20,
              windowMs: WINDOW_MS,
              userAgent: userAgent || "unknown",
              timestamp: new Date(now).toISOString(),
            },
          };
        }
      }
    }
  }
  
  return null;
}

/**
 * Checks if a path is considered protected (requires authentication/authorization)
 */
function isProtectedPathCheck(path: string): boolean {
  const protectedPrefixes = [
    "/api/dex/order",
    "/api/dex/cancel",
    "/api/dex/swap",
    "/api/dex/pool",
    "/api/dex/portfolio",
    "/api/dex/wallets",
    "/api/dex/transfer",
    "/api/dex/bridge",
    "/api/dex/settle",
    "/api/dex/maker",
    "/api/dex/fleet",
    "/api/dex/grid",
    "/api/dex/security",
    "/api/dex/program",
  ];
  return protectedPrefixes.some(prefix => path.startsWith(prefix));
}

/**
 * Triggers an alert by logging structured JSON to console
 * In production, this could be extended to send to external systems
 */
export function triggerAnomalyAlert(anomaly: { type: string; details: Record<string, unknown> }): void {
  const logEntry = {
    timestamp: new Date().toISOString(),
    severity: "HIGH",
    component: "anomaly-detector",
    event_type: "anomaly_detected",
    anomaly_type: anomaly.type,
    details: anomaly.details,
  };
  
  // Structured JSON logging for log aggregation systems
  console.warn(JSON.stringify(logEntry));
  
  // Also log a human-readable summary
  console.warn(
    `[ANOMALY] ${anomaly.type}: IP=${anomaly.details.ip} Path=${anomaly.details.path || "multiple"} ` +
    `Details=${JSON.stringify(anomaly.details)}`
  );
}

/**
 * Middleware integration helper
 * Call this after authentication but before authorization
 */
export function checkRequestAnomaly(
  ip: string,
  path: string,
  userAgent?: string
): { detected: boolean; type: string; details: Record<string, unknown> } | null {
  const isProtected = isProtectedPathCheck(path);
  return recordAndCheckAnomaly(ip, path, isProtected, userAgent);
}

/**
 * Get current statistics for an IP (for debugging/monitoring)
 */
export function getIpStats(ip: string): Record<string, unknown> {
  const now = Date.now();
  const stats: Record<string, unknown> = {};
  
  for (const [key, timestamps] of requestCounts.entries()) {
    if (key.startsWith(`${ip}:`)) {
      const path = key.slice(ip.length + 1);
      const pruned = pruneTimestamps(timestamps, now);
      const { mean, stddev, count } = calculateStats(pruned, now);
      stats[path] = {
        totalRequests: count,
        requestsPerMinute: Math.round((pruned.length / WINDOW_MS) * 60_000 * 100) / 100,
        mean,
        stddev,
      };
    }
  }
  
  const protectedAccess = pathAccessCounts.get(ip);
  if (protectedAccess) {
    stats["protected_paths"] = Object.fromEntries(protectedAccess);
  }
  
  return stats;
}

/**
 * Reset all tracking data (for testing)
 */
export function resetAnomalyDetector(): void {
  requestCounts.clear();
  pathAccessCounts.clear();
  alertedAnomalies.clear();
}
