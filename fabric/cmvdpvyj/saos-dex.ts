import { NextRequest, NextResponse } from "next/server";

/**
 * anomaly-detector.ts — Real-time anomaly detection for SAOS-DEX
 * Detects unusual access patterns: IP spikes, repeated failed auth, protected path access
 * No secrets, no local paths, no external config dependencies.
 */

interface AccessEvent {
  ip: string;
  path: string;
  timestamp: number;
  userAgent?: string;
  authStatus?: "success" | "failure" | "unauthorized";
}

interface AnomalyAlert {
  severity: "HIGH" | "MEDIUM" | "LOW";
  message: string;
  ip: string;
  path: string;
  requestCount: number;
  windowMs: number;
  timestamp: number;
  anomalyType: "ip_spike" | "repeated_failures" | "protected_path_access" | "unusual_pattern";
}

// In-memory sliding window store (per IP + path)
const accessWindows = new Map<string, number[]>();
const MAX_WINDOW_ENTRIES = 10_000;
const WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const SPIKE_THRESHOLD_STD = 3; // 3 standard deviations
const ABSOLUTE_THRESHOLD_PER_MIN = 100; // 100 req/min from single IP
const FAILURE_THRESHOLD = 10; // 10 failures in window
const PROTECTED_PATHS = [
  "/api/dex/order",
  "/api/dex/cancel",
  "/api/dex/swap",
  "/api/dex/bridge",
  "/api/dex/transfer",
  "/api/dex/wrap",
  "/api/dex/pool",
  "/api/dex/fleet",
  "/api/dex/maker",
  "/api/dex/launchpad",
  "/api/dex/relay",
  "/api/dex/settle",
  "/api/dex/door",
  "/api/dex/fuel",
  "/api/dex/onramp",
  "/api/dex/convert",
  "/api/dex/grid",
];

function getWindowKey(ip: string, path: string): string {
  return `${ip}:${path}`;
}

function pruneWindow(timestamps: number[], now: number): number[] {
  const cutoff = now - WINDOW_MS;
  return timestamps.filter((t) => t > cutoff);
}

function calculateStats(timestamps: number[]): { mean: number; std: number; count: number } {
  const count = timestamps.length;
  if (count === 0) return { mean: 0, std: 0, count: 0 };
  const mean = count / (WINDOW_MS / 60_000); // requests per minute
  // For Poisson-like process, variance ≈ mean, std ≈ sqrt(mean)
  const std = Math.sqrt(mean);
  return { mean, std, count };
}

function isProtectedPath(path: string): boolean {
  return PROTECTED_PATHS.some((p) => path.startsWith(p));
}

function logAlert(alert: AnomalyAlert): void {
  console.warn(JSON.stringify({
    timestamp: new Date(alert.timestamp).toISOString(),
    severity: alert.severity,
    event_type: "anomaly_detected",
    anomaly_type: alert.anomalyType,
    ip: alert.ip,
    path: alert.path,
    request_count: alert.requestCount,
    window_minutes: alert.windowMs / 60_000,
    message: alert.message,
  }));
}

/**
 * Process an access event and detect anomalies.
 * Call this from middleware after auth but before authorization.
 */
export function detectAnomaly(event: AccessEvent): AnomalyAlert | null {
  const now = event.timestamp;
  const key = getWindowKey(event.ip, event.path);
  
  let window = accessWindows.get(key) || [];
  window = pruneWindow(window, now);
  window.push(now);
  
  // Prevent memory bloat
  if (accessWindows.size > MAX_WINDOW_ENTRIES) {
    const firstKey = accessWindows.keys().next().value;
    if (firstKey) accessWindows.delete(firstKey);
  }
  accessWindows.set(key, window);
  
  const { mean, std, count } = calculateStats(window);
  const reqPerMin = count / (WINDOW_MS / 60_000);
  
  // 1. Absolute spike threshold
  if (reqPerMin > ABSOLUTE_THRESHOLD_PER_MIN) {
    const alert: AnomalyAlert = {
      severity: "HIGH",
      message: `IP ${event.ip} exceeded ${ABSOLUTE_THRESHOLD_PER_MIN} req/min on ${event.path} (actual: ${reqPerMin.toFixed(1)})`,
      ip: event.ip,
      path: event.path,
      requestCount: count,
      windowMs: WINDOW_MS,
      timestamp: now,
      anomalyType: "ip_spike",
    };
    logAlert(alert);
    return alert;
  }
  
  // 2. Statistical spike (3 sigma)
  if (count > 10 && reqPerMin > mean + SPIKE_THRESHOLD_STD * std) {
    const alert: AnomalyAlert = {
      severity: "HIGH",
      message: `Statistical anomaly: IP ${event.ip} on ${event.path} at ${reqPerMin.toFixed(1)} req/min (mean: ${mean.toFixed(1)}, std: ${std.toFixed(1)}, threshold: ${(mean + SPIKE_THRESHOLD_STD * std).toFixed(1)})`,
      ip: event.ip,
      path: event.path,
      requestCount: count,
      windowMs: WINDOW_MS,
      timestamp: now,
      anomalyType: "ip_spike",
    };
    logAlert(alert);
    return alert;
  }
  
  // 3. Repeated auth failures
  if (event.authStatus === "failure" || event.authStatus === "unauthorized") {
    const failureKey = `fail:${event.ip}`;
    let failWindow = accessWindows.get(failureKey) || [];
    failWindow = pruneWindow(failWindow, now);
    failWindow.push(now);
    accessWindows.set(failureKey, failWindow);
    
    if (failWindow.length >= FAILURE_THRESHOLD) {
      const alert: AnomalyAlert = {
        severity: "HIGH",
        message: `Repeated auth failures from IP ${event.ip}: ${failWindow.length} failures in ${WINDOW_MS / 60_000} minutes`,
        ip: event.ip,
        path: event.path,
        requestCount: failWindow.length,
        windowMs: WINDOW_MS,
        timestamp: now,
        anomalyType: "repeated_failures",
      };
      logAlert(alert);
      return alert;
    }
  }
  
  // 4. Protected path access without auth (unauthorized)
  if (isProtectedPath(event.path) && event.authStatus === "unauthorized") {
    const alert: AnomalyAlert = {
      severity: "MEDIUM",
      message: `Unauthorized access attempt to protected path ${event.path} from IP ${event.ip}`,
      ip: event.ip,
      path: event.path,
      requestCount: 1,
      windowMs: WINDOW_MS,
      timestamp: now,
      anomalyType: "protected_path_access",
    };
    logAlert(alert);
    return alert;
  }
  
  return null;
}

/**
 * Get current request rate for an IP+path (for monitoring/debugging)
 */
export function getRequestRate(ip: string, path: string): number {
  const now = Date.now();
  const key = getWindowKey(ip, path);
  const window = accessWindows.get(key) || [];
  const pruned = pruneWindow(window, now);
  return pruned.length / (WINDOW_MS / 60_000);
}

/**
 * Clear all windows (for testing)
 */
export function clearAnomalyState(): void {
  accessWindows.clear();
}

// Export types for testing
export type { AccessEvent, AnomalyAlert };
