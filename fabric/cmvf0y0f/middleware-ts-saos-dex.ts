import { NextRequest, NextResponse } from "next/server";

// Behavioral analysis middleware for DEX API endpoints
// Monitors /api/dex/agent, /api/dex/order, /api/dex/swap
// Uses sliding window with z-score based anomaly detection

// Prometheus metrics exposed via separate exporter
// dex_behavioral_anomalies_total\ndex_request_deviation_stddev

// In-memory sliding window with TTL (Redis recommended for production)
// Key structure: {endpoint}:{clientIp}
// Values: [{timestamp, requestSize, swapAmount, price, address}]

const WINDOW_SIZE = 100; // last N requests per endpoint+ip
const STDDEV_THRESHOLD = 3; // z-score threshold
const WINDOW_MS = 60_000; // 1 minute sliding window

// Type definitions for collected metrics
interface RequestMetric {
  timestamp: number;
  requestSize: number;
  swapAmount?: number;
  price?: number;
  address?: string;
}

// Sliding windows stored in Map with automatic cleanup
const slidingWindows = new Map<string, RequestMetric[]>();

function cleanWindow(window: RequestMetric[]): RequestMetric[] {
  const now = Date.now();
  return window.filter((metric) => now - metric.timestamp < WINDOW_MS);
}

function calculateZScore(values: number[]): { mean: number; stddev: number } {
  if (values.length < 2) return { mean: 0, stddev: 0 };
  
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  const stddev = Math.sqrt(variance);
  
  return { mean, stddev };
}

function detectAnomaly(metric: RequestMetric, values: number[]): {
  isAnomaly: boolean;
  zScore: number;
  reason: string;
} {
  if (values.length < 3) return { isAnomaly: false, zScore: 0, reason: "insufficient-data" };
  
  const { mean, stddev } = calculateZScore(values);
  
  if (stddev === 0) return { isAnomaly: false, zScore: 0, reason: "zero-variance" };
  
  const zScore = (metric.swapAmount ?? metric.price ?? metric.requestSize) - mean / stddev;
  
  const absZ = Math.abs(zScore);
  
  let reason = "normal";
  if (absZ > STDDEV_THRESHOLD) {
    if (zScore > 0) {
      reason = "high-value-anomaly";
    } else {
      reason = "low-value-anomaly";
    }
  }
  
  return { isAnomaly: absZ > STDDEV_THRESHOLD, zScore, reason };
}

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  
  // Only monitor specified DEX endpoints
  const monitoredEndpoints = ["/api/dex/agent", "/api/dex/order", "/api/dex/swap"];
  
  if (!monitoredEndpoints.some((ep) => pathname.startsWith(ep))) {
    return NextResponse.next();
  }
  
  const clientIp = request.ip || "unknown";
  const windowKey = `${pathname}:${clientIp}`;
  
  // Collect metric data from request
  const metric: RequestMetric = {
    timestamp: Date.now(),
    requestSize: request.headers.get("content-length") ? parseInt(request.headers.get("content-length") ?? "0") : 0,
  };
  
  // Extract relevant data based on endpoint
  try {
    if (pathname.includes("/order")) {
      const body = await request.json();
      metric.swapAmount = body?.amount ?? body?.quantity;
      metric.price = body?.price;
    } else if (pathname.includes("/swap")) {
      const body = await request.json();
      metric.swapAmount = body?.amount ?? body?.quantity;
      metric.price = body?.price;
    } else if (pathname.includes("/agent")) {
      const body = await request.json();
      metric.address = body?.address ?? body?.wallet;
    }
  } catch {
    // If body parsing fails, continue with collected data
  }
  
  // Add to sliding window and clean
  let window = slidingWindows.get(windowKey) || [];
  window.push(metric);
  window = cleanWindow(window);
  
  // Enforce window size limit
  if (window.length > WINDOW_SIZE) {
    window = window.slice(-WINDOW_SIZE);
  }
  
  slidingWindows.set(windowKey, window);
  
  // Detect anomalies if we have enough data
  const values = window.map((m) => m.swapAmount ?? m.price ?? m.requestSize).filter((v): v is number => typeof v === "number");
  
  if (values.length >= 3) {
    const { zScore, reason } = detectAnomaly(metric, values);
    
    if (zScore !== undefined && zScore !== 0) {
      // In production, would increment Prometheus counters here
      // dex_behavioral_anomalies_total.inc();
      // dex_request_deviation_stddev.set({endpoint: pathname}, zScore);
      
      // Log anomaly for alerting
      console.warn(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          action: "behavioral_anomaly_detected",
          endpoint: pathname,
          clientIp,
          zScore,
          reason,
          metric,
        })
      );
    }
  }
  
  // Continue to next middleware
  return NextResponse.next();
}

// Helper function for external use (testing, etc.)
export function getWindowStats(endpoint: string, ip: string): {
  windowSize: number;
  mean: number;
  stddev: number;
  lastValues: number[];
} {
  const windowKey = `${endpoint}:${ip}`;
  const window = slidingWindows.get(windowKey) || [];
  
  const numericValues = window
    .map((m) => m.swapAmount ?? m.price ?? m.requestSize)
    .filter((v): v is number => typeof v === "number");
  
  const { mean, stddev } = calculateZScore(numericValues);
  
  return {
    windowSize: window.length,
    mean,
    stddev,
    lastValues: numericValues.slice(-10),
  };
};