// Behavioral anomaly detection middleware for SAOS-DEX
// Integrates with existing rate-limit layer; adds baseline profiling and drift detection

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

// In-memory baseline store: ip -> array of recent request signatures (last 100)
const baselineStore = new Map<string, Array<{pathname: string; method: string; nonce?: string; timestamp: number}>>();
const BASELINE_WINDOW = 100; // keep last N requests per IP

// Pino logger instance (structured JSON output)
const logger = pino({ level: "info", transport: { target: "pino/file", options: { destination: "stderr" } } });

// Track per-IP early-warning state (separate from rate-limit)
const warningState = new Map<string, {count: number; lastReset: number}>();
const WARNING_THRESHOLD = 3; // alert after 3 anomalies
const BLOCK_THRESHOLD = 5; // temporary block after 5 anomalies

function getClientIp(req: NextRequest): string {
  // Prefer X-Forwarded-For last element (gateway-added, resistant to single-header spoof)
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map(s => s.trim());
    return parts[parts.length - 1] || "unknown";
  }
  return req.ip ?? "unknown";
}

function generateSignature(req: NextRequest): string {
  const url = new URL(req.url);
  // Include path, method, and optional nonce from query
  const nonce = url.searchParams.get("nonce") || undefined;
  return `${req.method}:${url.pathname}:${nonce || ""}`;
}

function detectAnomalies(ip: string, signature: string, pathname: string): {type: string; detail: string} | null {
  const history = baselineStore.get(ip) || [];
  
  // 1. Sudden spike in request frequency to same path
  const pathCount = history.filter(h => h.pathname === pathname).length;
  if (pathCount >= 50) { // threshold for "burst" within baseline window
    return {
      type: "burst_detected",
      detail: ` ${pathCount} requests to ${pathname} within baseline window`
    };
  }
  
  // 2. Parameter inconsistency (e.g., nonce reuse, operation type changes)
  const lastOfSamePath = history.slice().reverse().find(h => h.pathname === pathname);
  if (lastOfSamePath && lastOfSamePath.nonce !== undefined && signature.includes("nonce") && lastOfSamePath.nonce !== signature.split(":")[2]) {
    return {
      type: "nonce_mismatch",
      detail: `nonce changed from ${lastOfSamePath.nonce} to ${signature.split(":")[2]}`
    };
  }
  
  // 3. Unusual headers / missing expected headers (basic check)
  const userAgent = req.headers.get("user-agent") || "";
  // Flag unusually short or suspicious User-Agents
  if (userAgent.length < 10 || /bot|crawl|scrap|fuzz/i.test(userAgent)) {
    return {
      type: "suspicious_header",
      detail: `suspicious User-Agent: ${userAgent.substring(0, 40)}...`
    };
  }
  
  // 4. Repeated access to sensitive paths with atypical parameters
  if (/\/api\/dex\/(settle|transfer)/.test(pathname)) {
    // Check for missing or empty required params in a simple heuristic
    const search = new URLSearchParams(req.url.split("?")[1] || "");
    if (!search.has("amount") || !search.has("symbol")) {
      return {
        type: "sensitive_path_missing_params",
        detail: `access to ${pathname} without amount/symbol parameters`
      };
    }
  }
  
  return null;
}

export async function middleware(req: NextRequest) {
  const ip = getClientIp(req);
  const url = new URL(req.url);
  const pathname = url.pathname;
  
  // Skip instrumentation and revive routes (already exempt in rate-limit)
  if (pathname === "/api/dex/stream" || pathname === "/api/revive") {
    return NextResponse.next();
  }
  
  const signature = generateSignature(req);
  
  // Store in baseline history (FIFO cap)
  let history = baselineStore.get(ip) || [];
  history.push({ pathname, method: req.method, nonce: signature.includes("nonce") ? signature.split(":")[2] : undefined, timestamp: Date.now() });
  if (history.length > BASELINE_WINDOW) {
    history = history.slice(history.length - BASELINE_WINDOW);
  }
  baselineStore.set(ip, history);
  
  // Detect anomalies
  const anomaly = detectAnomalies(ip, signature, pathname);
  
  if (anomaly) {
    // Update warning state
    const state = warningState.get(ip) || { count: 0, lastReset: Date.now() };
    
    // Rotate window every 5 minutes to avoid permanent bans
    if (state.lastReset && Date.now() - state.lastReset > 300_000) {
      state.count = 0;
      state.lastReset = Date.now();
    }
    
    state.count += 1;
    warningState.set(ip, state);
    
    // Log structured anomaly (JSON via Pino)
    logger.info({\n      timestamp: new Date().toISOString(),
      ip,
      path: pathname,
      anomaly_type: anomaly.type,
      detail: anomaly.detail,
      baseline_count: history.length,
      warning_count: state.count
    });
    
    // Enforce blocking after threshold
    if (state.count >= BLOCK_THRESHOLD) {
      // Temporary block: return 429 with retry-after header
      return new NextResponse("Too Many Anomalies - temporary block", {
        status: 429,
        headers: { "retry-after": "60" }
      });
    }
    
    // Alert after 3 anomalies (but not block yet)
    if (state.count >= WARNING_THRESHOLD) {
      console.warn(JSON.stringify({
        timestamp: new Date().toISOString(),
        action: "behavioral_alert",
        ip,
        path: pathname,
        anomaly_type: anomaly.type,
        detail: anomaly.detail
      }));
    }
  }
  
  return NextResponse.next();
}

// Exported for testing / manual reset (not used in production flow directly but available)
export { baselineStore, warningState };