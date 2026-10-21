// src/lib/dex/behavioral-monitor.ts
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";

// In-memory stores (replace with Redis in production)
const requestHistory = new Map<string, RequestRecord[]>();
const accountActivity = new Map<string, AccountActivity>();
const suspiciousPatterns = new Map<string, SuspiciousPattern[]>();

interface RequestRecord {
  timestamp: number;
  endpoint: string;
  account: string;
  params: Record<string, unknown>;
  ip: string;
  userAgent: string;
}

interface AccountActivity {
  lastRequestTime: number;
  requestCount: number;
  endpoints: Set<string>;
  paramsHashes: string[];
  volumes: number[];
}

interface SuspiciousPattern {
  type: "reentrancy" | "front-running" | "sandwich" | "volume-anomaly";
  account: string;
  ip: string;
  timestamp: number;
  details: Record<string, unknown>;
  severity: "low" | "medium" | "high" | "critical";
}

const WINDOW_MS = 60_000; // 1 minute sliding window
const MAX_HISTORY_PER_ACCOUNT = 100;
const REENTRANCY_THRESHOLD = 10; // requests per minute from same account
const FRONT_RUNNING_SIMILARITY_THRESHOLD = 0.8;
const SANDWICH_TIME_WINDOW = 5_000; // 5 seconds
const VOLUME_ANOMALY_MULTIPLIER = 10; // 10x average volume

function getClientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || "unknown";
}

function hashParams(params: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(params)).digest("hex").slice(0, 16);
}

function calculateSimilarity(params1: Record<string, unknown>, params2: Record<string, unknown>): number {
  const keys1 = new Set(Object.keys(params1));
  const keys2 = new Set(Object.keys(params2));
  const intersection = new Set([...keys1].filter(x => keys2.has(x)));
  const union = new Set([...keys1, ...keys2]);
  return intersection.size / union.size;
}

function extractVolume(params: Record<string, unknown>): number {
  // Extract volume from common parameter names
  const volumeKeys = ["amount", "quantity", "volume", "size", "baseAmount", "quoteAmount"];
  for (const key of volumeKeys) {
    if (typeof params[key] === "number") return params[key];
    if (typeof params[key] === "string") {
      const parsed = parseFloat(params[key]);
      if (!isNaN(parsed)) return parsed;
    }
  }
  return 0;
}

export function recordRequest(req: NextRequest, account: string, params: Record<string, unknown>): void {
  const now = Date.now();
  const ip = getClientIp(req);
  const endpoint = req.nextUrl.pathname;
  const userAgent = req.headers.get("user-agent") || "unknown";
  
  const record: RequestRecord = {
    timestamp: now,
    endpoint,
    account,
    params,
    ip,
    userAgent
  };

  // Clean old records
  const cutoff = now - WINDOW_MS;
  
  // Update account activity
  let activity = accountActivity.get(account);
  if (!activity) {
    activity = {
      lastRequestTime: now,
      requestCount: 0,
      endpoints: new Set(),
      paramsHashes: [],
      volumes: []
    };
    accountActivity.set(account, activity);
  }

  // Check for reentrancy
  activity.requestCount++;
  if (activity.requestCount > REENTRANCY_THRESHOLD) {
    reportSuspiciousPattern({
      type: "reentrancy",
      account,
      ip,
      timestamp: now,
      details: { requestCount: activity.requestCount, windowMs: WINDOW_MS },
      severity: "high"
    });
  }

  // Check for front-running (similar params from same IP)
  const recentRecords = (requestHistory.get(ip) || []).filter(r => r.timestamp > cutoff);
  for (const recent of recentRecords) {
    if (recent.endpoint === endpoint && recent.account !== account) {
      const similarity = calculateSimilarity(recent.params, params);
      if (similarity > FRONT_RUNNING_SIMILARITY_THRESHOLD) {
        reportSuspiciousPattern({
          type: "front-running",
          account,
          ip,
          timestamp: now,
          details: { similarity, otherAccount: recent.account, endpoint },
          severity: "medium"
        });
      }
    }
  }

  // Check for sandwich attacks (three operations on same asset)
  const assetKey = extractAssetKey(params);
  if (assetKey) {
    const assetRecords = recentRecords.filter(r => extractAssetKey(r.params) === assetKey);
    if (assetRecords.length >= 2) {
      const timeSpan = now - assetRecords[0].timestamp;
      if (timeSpan < SANDWICH_TIME_WINDOW) {
        reportSuspiciousPattern({
          type: "sandwich",
          account,
          ip,
          timestamp: now,
          details: { asset: assetKey, operationCount: assetRecords.length + 1, timeSpan },
          severity: "critical"
        });
      }
    }
  }

  // Check for volume anomalies
  const volume = extractVolume(params);
  if (volume > 0) {
    activity.volumes.push(volume);
    if (activity.volumes.length > 10) {
      const avgVolume = activity.volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (activity.volumes.length - 1);
      if (volume > avgVolume * VOLUME_ANOMALY_MULTIPLIER) {
        reportSuspiciousPattern({
          type: "volume-anomaly",
          account,
          ip,
          timestamp: now,
          details: { volume, avgVolume, multiplier: volume / avgVolume },
          severity: "high"
        });
      }
    }
  }

  // Store record
  activity.lastRequestTime = now;
  activity.endpoints.add(endpoint);
  activity.paramsHashes.push(hashParams(params));
  if (activity.paramsHashes.length > MAX_HISTORY_PER_ACCOUNT) {
    activity.paramsHashes.shift();
  }

  const ipRecords = requestHistory.get(ip) || [];
  ipRecords.push(record);
  requestHistory.set(ip, ipRecords.slice(-MAX_HISTORY_PER_ACCOUNT));

  // Cleanup old entries periodically
  if (Math.random() < 0.01) { // 1% chance per request
    cleanupOldEntries(now);
  }
}

function extractAssetKey(params: Record<string, unknown>): string | null {
  const assetKeys = ["symbol", "asset", "token", "pair", "base", "quote"];
  for (const key of assetKeys) {
    if (typeof params[key] === "string") return params[key];
  }
  return null;
}

function reportSuspiciousPattern(pattern: SuspiciousPattern): void {
  // Log with full request details
  console.warn(JSON.stringify({
    timestamp: new Date(pattern.timestamp).toISOString(),
    action: "behavioral_alert",
    pattern_type: pattern.type,
    severity: pattern.severity,
    account: pattern.account,
    ip: pattern.ip,
    details: pattern.details
  }));

  // Store for metrics
  const key = `${pattern.type}:${pattern.account}:${pattern.ip}`;
  const patterns = suspiciousPatterns.get(key) || [];
  patterns.push(pattern);
  suspiciousPatterns.set(key, patterns.slice(-50));

  // Emit Prometheus metrics (would integrate with prom-client in production)
  emitMetric("dex_behavioral_alerts_total", 1, {
    type: pattern.type,
    severity: pattern.severity,
    endpoint: pattern.details.endpoint as string || "unknown"
  });
}

function emitMetric(name: string, value: number, labels: Record<string, string>): void {
  // In production, integrate with prom-client:
  // registry.getSingleMetric(name)?.inc(labels);
  // For now, structured log for scraping
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    metric: name,
    value,
    labels
  }));
}

function cleanupOldEntries(now: number): void {
  const cutoff = now - WINDOW_MS * 2;
  
  for (const [ip, records] of requestHistory.entries()) {
    const filtered = records.filter(r => r.timestamp > cutoff);
    if (filtered.length === 0) {
      requestHistory.delete(ip);
    } else {
      requestHistory.set(ip, filtered);
    }
  }

  for (const [account, activity] of accountActivity.entries()) {
    if (activity.lastRequestTime < cutoff) {
      accountActivity.delete(account);
    }
  }

  for (const [key, patterns] of suspiciousPatterns.entries()) {
    const filtered = patterns.filter(p => p.timestamp > cutoff);
    if (filtered.length === 0) {
      suspiciousPatterns.delete(key);
    } else {
      suspiciousPatterns.set(key, filtered);
    }
  }

  // Prevent memory leaks
  if (requestHistory.size > 10_000) {
    const oldestIp = requestHistory.keys().next().value;
    if (oldestIp) requestHistory.delete(oldestIp);
  }
  if (accountActivity.size > 10_000) {
    const oldestAccount = accountActivity.keys().next().value;
    if (oldestAccount) accountActivity.delete(oldestAccount);
  }
}

export function getSuspiciousPatterns(account?: string): SuspiciousPattern[] {
  const all: SuspiciousPattern[] = [];
  for (const patterns of suspiciousPatterns.values()) {
    all.push(...patterns);
  }
  if (account) {
    return all.filter(p => p.account === account);
  }
  return all.sort((a, b) => b.timestamp - a.timestamp);
}

export function getAccountRiskScore(account: string): number {
  const patterns = getSuspiciousPatterns(account);
  const now = Date.now();
  const recentPatterns = patterns.filter(p => now - p.timestamp < 300_000); // 5 minutes
  
  let score = 0;
  for (const p of recentPatterns) {
    switch (p.severity) {
      case "critical": score += 40; break;
      case "high": score += 25; break;
      case "medium": score += 10; break;
      case "low": score += 5; break;
    }
  }
  return Math.min(score, 100);
}

export function isAccountBlocked(account: string): boolean {
  return getAccountRiskScore(account) >= 80;
}

// Middleware integration helper
export function createBehavioralMiddleware() {
  return async (req: NextRequest, account: string, params: Record<string, unknown>) => {
    recordRequest(req, account, params);
    
    if (isAccountBlocked(account)) {
      return {
        blocked: true,
        reason: "behavioral_anomaly",
        riskScore: getAccountRiskScore(account)
      };
    }
    return { blocked: false };
  };
}

// Prometheus metrics endpoint data
export function getMetricsData(): string {
  const lines: string[] = [
    "# HELP dex_behavioral_alerts_total Total number of behavioral alerts",
    "# TYPE dex_behavioral_alerts_total counter"
  ];
  
  const metricCounts = new Map<string, number>();
  for (const patterns of suspiciousPatterns.values()) {
    for (const p of patterns) {
      const key = `dex_behavioral_alerts_total{type="${p.type}",severity="${p.severity}"}`;
      metricCounts.set(key, (metricCounts.get(key) || 0) + 1);
    }
  }
  
  for (const [metric, count] of metricCounts.entries()) {
    lines.push(`${metric} ${count}`);
  }
  
  lines.push("# HELP dex_account_risk_score Current risk score for accounts",
    "# TYPE dex_account_risk_score gauge");
  
  for (const account of accountActivity.keys()) {
    const score = getAccountRiskScore(account);
    lines.push(`dex_account_risk_score{account="${account}"} ${score}`);
  }
  
  return lines.join("\n");
}
