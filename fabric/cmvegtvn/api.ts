import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";

// Critical API endpoints requiring enhanced monitoring
const CRITICAL_ENDPOINTS = [
  "/api/dex/order",
  "/api/dex/swap",
  "/api/dex/transfer",
  "/api/dex/cancel",
  "/api/dex/bridge",
  "/api/dex/onramp",
  "/api/dex/settle",
  "/api/dex/portfolio"
];

// Statistical thresholds for anomaly detection
const REQUEST_RATE_THRESHOLD = 50; // requests per minute per user/IP
const SIMILAR_PARAM_THRESHOLD = 5; // consecutive similar requests
const DATA_THROUGHPUT_THRESHOLD = 1024 * 1024; // 1MB per minute

// In-memory stores for behavioral baselines
const userRequestHistory = new Map<string, Array<{ timestamp: number; endpoint: string; paramsHash: string; size: number }>>();
const ipRequestHistory = new Map<string, Array<{ timestamp: number; endpoint: string; paramsHash: string; size: number }>>();

// Cleanup old entries (older than 5 minutes)
function cleanupOldEntries() {
  const now = Date.now();
  const fiveMinutesAgo = now - 5 * 60 * 1000;
  
  for (const [key, history] of [...userRequestHistory.entries(), ...ipRequestHistory.entries()]) {
    const filtered = history.filter(entry => entry.timestamp > fiveMinutesAgo);
    if (filtered.length === 0) {
      if (userRequestHistory.has(key)) userRequestHistory.delete(key);
      if (ipRequestHistory.has(key)) ipRequestHistory.delete(key);
    } else {
      if (userRequestHistory.has(key)) userRequestHistory.set(key, filtered);
      if (ipRequestHistory.has(key)) ipRequestHistory.set(key, filtered);
    }
  }
}

// Generate hash of request parameters for similarity detection
function getParamsHash(req: NextRequest): string {
  try {
    const url = new URL(req.url);
    const searchParams = url.searchParams;
    const paramsArray: [string, string][] = [];
    
    searchParams.forEach((value, key) => {
      paramsArray.push([key, value]);
    });
    
    paramsArray.sort((a, b) => a[0].localeCompare(b[0])); // Sort by key
    const paramsString = paramsArray.map(p => `${p[0]}=${p[1]}`).join("&");
    return createHash("sha256").update(paramsString).digest("hex");
  } catch (e) {
    return "";
  }
}

// Estimate request size in bytes
function estimateRequestSize(req: NextRequest): number {
  let size = 0;
  size += req.url.length || 0;
  
  // Add headers size
  req.headers.forEach((value, key) => {
    size += key.length + value.length;
  });
  
  // Add body size approximation (for POST/PUT)
  if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
    // In real implementation, we'd read the body, but for middleware we approximate
    size += 500; // reasonable approximation for JSON bodies
  }
  
  return size;
}

// Detect anomalies using statistical outlier detection (modified Z-score)
function detectAnomaly(key: string, history: Array<{ timestamp: number; endpoint: string; paramsHash: string; size: number }>, currentReq: { endpoint: string; paramsHash: string; size: number }): { isAnomaly: boolean; reason: string; severity: "low" | "medium" | "high" } {
  if (history.length < 10) {
    return { isAnomaly: false, reason: "Insufficient data for baseline", severity: "low" };
  }
  
  const now = Date.now();
  const oneMinuteAgo = now - 60 * 1000;
  
  // Filter to last minute
  const recentHistory = history.filter(entry => entry.timestamp > oneMinuteAgo);
  
  // 1. Request rate anomaly
  const requestRate = recentHistory.length;
  if (requestRate > REQUEST_RATE_THRESHOLD) {
    return {
      isAnomaly: true,
      reason: `High request rate: ${requestRate}/min (threshold: ${REQUEST_RATE_THRESHOLD}/min)`,
      severity: requestRate > REQUEST_RATE_THRESHOLD * 2 ? "high" : "medium"
    };
  }
  
  // 2. Similar parameter sequence detection
  const sameEndpointCount = recentHistory.filter(entry => entry.endpoint === currentReq.endpoint).length;
  const sameParamsCount = recentHistory.filter(entry => entry.paramsHash === currentReq.paramsHash).length;
  
  if (sameParamsCount >= SIMILAR_PARAM_THRESHOLD) {
    return {
      isAnomaly: true,
      reason: `Repeated identical parameters: ${sameParamsCount} times in last minute`,
      severity: "medium"
    };
  }
  
  // 3. Data throughput anomaly
  const totalData = recentHistory.reduce((sum, entry) => sum + entry.size, 0);
  if (totalData > DATA_THROUGHPUT_THRESHOLD) {
    return {
      isAnomaly: true,
      reason: `High data throughput: ${Math.round(totalData / 1024)}KB/min (threshold: ${Math.round(DATA_THROUGHPUT_THRESHOLD / 1024)}KB/min)`,
      severity: totalData > DATA_THROUGHPUT_THRESHOLD * 2 ? "high" : "medium"
    };
  }
  
  // 4. Unusual endpoint access pattern
  const uniqueEndpoints = new Set(recentHistory.map(entry => entry.endpoint)).size;
  const totalRequests = recentHistory.length;
  const endpointDiversity = uniqueEndpoints / Math.max(totalRequests, 1);
  
  // If user is hitting many different endpoints rapidly (potential scanning)
  if (endpointDiversity > 0.7 && totalRequests > 20) {
    return {
      isAnomaly: true,
      reason: `High endpoint diversity: ${Math.round(endpointDiversity * 100)}% unique endpoints`,
      severity: "medium"
    };
  }
  
  return { isAnomaly: false, reason: "Normal behavior", severity: "low" };
}

// Gradual rate limiting based on anomaly severity
function applyGradualLimiting(severity: "low" | "medium" | "high"): number {
  switch (severity) {
    case "low":
      return 1; // No additional limiting
    case "medium":
      return 2; // Double the delay
    case "high":
      return 4; // Quadruple the delay
    default:
      return 1;
  }
}

export async function middleware(req: NextRequest, res: NextResponse) {
  const pathname = req.nextUrl.pathname;
  
  // Skip non-critical endpoints and exempt paths
  const isCritical = CRITICAL_ENDPOINTS.some(endpoint => pathname.startsWith(endpoint));
  const isExempt = ["/api/dex/stream", "/api/revive"].some(exempt => pathname.startsWith(exempt));
  
  if (!isCritical || isExempt) {
    return NextResponse.next();
  }
  
  // Cleanup old entries periodically
  cleanupOldEntries();
  
  // Extract user identifier (from headers or fallback to IP)
  const userId = req.headers.get("x-user-id") || req.headers.get("authorization") || "anonymous";
  const userIdHash = createHash("sha256").update(userId).digest("hex").substring(0, 16);
  
  // Get client IP (handling X-Forwarded-For)
  const forwardedFor = req.headers.get("x-forwarded-for");
  const ip = forwardedFor ? forwardedFor.split(",")[0].trim() : req.headers.get("x-real-ip") || req.ip || "unknown";
  
  const paramsHash = getParamsHash(req);
  const requestSize = estimateRequestSize(req);
  const now = Date.now();
  
  const currentRequest = {
    endpoint: pathname,
    paramsHash,
    size: requestSize
  };
  
  // Check user-based anomalies
  let userHistory = userRequestHistory.get(userIdHash) || [];
  userHistory = [...userHistory, { timestamp: now, ...currentRequest }];
  userRequestHistory.set(userIdHash, userHistory);
  
  const userAnomaly = detectAnomaly(userIdHash, userHistory, currentRequest);
  
  // Check IP-based anomalies
  let ipHistory = ipRequestHistory.get(ip) || [];
  ipHistory = [...ipHistory, { timestamp: now, ...currentRequest }];
  ipRequestHistory.set(ip, ipHistory);
  
  const ipAnomaly = detectAnomaly(ip, ipHistory, currentRequest);
  
  // Determine overall anomaly status
  const isAnomaly = userAnomaly.isAnomaly || ipAnomaly.isAnomaly;
  const anomalyReason = userAnomaly.isAnomaly ? userAnomaly.reason : ipAnomaly.reason;
  const severity = userAnomaly.isAnomaly ? userAnomaly.severity : ipAnomaly.severity;
  
  // Log anomaly if detected
  if (isAnomaly) {
    try {
      const { createLogger, format, transports } = await import("winston");
      
      // Initialize logger if not already done
      if (!globalThis.winstonLogger) {
        globalThis.winstonLogger = createLogger({
          level: "warn",
          format: format.combine(
            format.timestamp(),
            format.json()
          ),
          transports: [
            new transports.Console(),
            new transports.File({ filename: "logs/anomaly-detection.log" })
          ]
        });
      }
      
      globalThis.winstonLogger.warn("API Anomaly Detected", {
        timestamp: new Date(now).toISOString(),
        userId: userIdHash,
        ip,
        endpoint: pathname,
        method: req.method,
        reason: anomalyReason,
        severity,
        requestSize,
        paramsHash: paramsHash.substring(0, 8)
      });
    } catch (loggerError) {
      // Fallback to console if winston fails
      console.warn(`[ANOMALY-DETECTION] Failed to log anomaly: ${loggerError.message}`);
      console.warn(`[ANOMALY-DETECTION] User: ${userIdHash}, IP: ${ip}, Endpoint: ${pathname}, Reason: ${anomalyReason}`);
    }
  }
  
  // Apply gradual limiting if anomaly detected
  if (isAnomaly) {
    const delayMultiplier = applyGradualLimiting(severity);
    
    // Add delay header for client-side backoff
    const response = NextResponse.next();
    response.headers.set("X-Anomaly-Detected", "true");
    response.headers.set("X-Anomaly-Severity", severity);
    response.headers.set("X-Recommended-Delay-Ms", String(100 * delayMultiplier));
    
    // For high severity, consider blocking or challenging
    if (severity === "high") {
      // In production, you might want to return 429 or implement CAPTCHA
      // For now, we'll add significant delay and log
      return new NextResponse("Too Many Requests - Anomaly Detected", {
        status: 429,
        headers: {
          "Content-Type": "text/plain",
          "X-Anomaly-Detected": "true",
          "X-Anomaly-Severity": severity,
          "Retry-After": String(60 * delayMultiplier)
        }
      });
    }
    
    return response;
  }
  
  return NextResponse.next();
}

// Configuration for the matcher
export const config = {
  matcher: [
    "/api/dex/order/:path*",
    "/api/dex/swap/:path*",
    "/api/dex/transfer/:path*",
    "/api/dex/cancel/:path*",
    "/api/dex/bridge/:path*",
    "/api/dex/onramp/:path*",
    "/api/dex/settle/:path*",
    "/api/dex/portfolio/:path*"
  ]
};