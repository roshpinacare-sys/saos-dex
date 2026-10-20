// src/lib/dex/behavioral-monitor.ts
import { createHash } from "node:crypto";

// In-memory stores (bounded) for behavioral tracking
const REENTRANCY_WINDOW_MS = 5_000; // 5 seconds
const FRONTRUN_WINDOW_MS = 2_000;   // 2 seconds
const SANDWICH_WINDOW_MS = 10_000;  // 10 seconds
const MAX_KEYS = 10_000;

interface RequestRecord {
  timestamp: number;
  account: string;
  endpoint: string;
  paramsHash: string;
  amount?: string;
  assetIn?: string;
  assetOut?: string;
  price?: string;
}

const reentrancyStore = new Map<string, RequestRecord[]>(); // key: account
const frontrunStore = new Map<string, RequestRecord[]>();   // key: paramsHash
const sandwichStore = new Map<string, RequestRecord[]>();   // key: assetIn:assetOut

function pruneStore<T extends RequestRecord>(store: Map<string, T[]>, windowMs: number, now: number): void {
  for (const [key, records] of store.entries()) {
    const filtered = records.filter(r => now - r.timestamp < windowMs);
    if (filtered.length === 0) store.delete(key);
    else store[key] = filtered;
  }
  if (store.size > MAX_KEYS) {
    const keys = Array.from(store.keys());
    for (let i = 0; i < keys.length - MAX_KEYS; i++) store.delete(keys[i]);
  }
}

function hashParams(params: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(params)).digest("hex").slice(0, 16);
}

export interface BehavioralAlert {
  type: "reentrancy" | "frontrun" | "sandwich" | "business_logic";
  severity: "low" | "medium" | "high" | "critical";
  account: string;
  endpoint: string;
  details: Record<string, unknown>;
  timestamp: string;
  requestId: string;
}

const alertCallbacks: ((alert: BehavioralAlert) => void)[] = [];
export function onBehavioralAlert(cb: (alert: BehavioralAlert) => void): () => void {
  alertCallbacks.push(cb);
  return () => { const idx = alertCallbacks.indexOf(cb); if (idx >= 0) alertCallbacks.splice(idx, 1); };
}

function emitAlert(alert: BehavioralAlert): void {
  console.warn(JSON.stringify({ ...alert, channel: "behavioral_monitor" }));
  for (const cb of alertCallbacks) {
    try { cb(alert); } catch { /* fail-open */ }
  }
}

export function recordRequest(
  requestId: string,
  account: string,
  endpoint: string,
  params: Record<string, unknown>
): { allowed: boolean; reason?: string; alerts: BehavioralAlert[] } {
  const now = Date.now();
  const alerts: BehavioralAlert[] = [];
  
  // Normalize account
  const acc = account.toLowerCase();
  
  // Extract common fields
  const amount = params.amount as string | undefined;
  const assetIn = (params.assetIn ?? params.from ?? params.tokenIn) as string | undefined;
  const assetOut = (params.assetOut ?? params.to ?? params.tokenOut) as string | undefined;
  const price = (params.price ?? params.minOut ?? params.maxIn) as string | undefined;
  const paramsHash = hashParams(params);
  
  const record: RequestRecord = { timestamp: now, account: acc, endpoint, paramsHash, amount, assetIn, assetOut, price };
  
  // 1. Reentrancy detection: same account, same endpoint, rapid calls
  const reentrancyKey = `${acc}:${endpoint}`;
  const reentrancyRecords = reentrancyStore.get(reentrancyKey) ?? [];
  const recentReentrancy = reentrancyRecords.filter(r => now - r.timestamp < REENTRANCY_WINDOW_MS);
  if (recentReentrancy.length >= 3) {
    alerts.push({
      type: "reentrancy",
      severity: "high",
      account: acc,
      endpoint,
      details: { count: recentReentrancy.length + 1, windowMs: REENTRANCY_WINDOW_MS, paramsHash },
      timestamp: new Date(now).toISOString(),
      requestId
    });
  }
  recentReentrancy.push(record);
  reentrancyStore.set(reentrancyKey, recentReentrancy);
  
  // 2. Front-running detection: similar params across different accounts
  const frontrunRecords = frontrunStore.get(paramsHash) ?? [];
  const recentFrontrun = frontrunRecords.filter(r => now - r.timestamp < FRONTRUN_WINDOW_MS);
  if (recentFrontrun.length >= 2) {
    const otherAccounts = new Set(recentFrontrun.map(r => r.account)).size;
    if (otherAccounts >= 2 || !recentFrontrun.some(r => r.account === acc)) {
      alerts.push({
        type: "frontrun",
        severity: "medium",
        account: acc,
        endpoint,
        details: { similarRequests: recentFrontrun.length + 1, windowMs: FRONTRUN_WINDOW_MS, paramsHash, accounts: Array.from(new Set([...recentFrontrun.map(r => r.account), acc])) },
        timestamp: new Date(now).toISOString(),
        requestId
      });
    }
  }
  recentFrontrun.push(record);
  frontrunStore.set(paramsHash, recentFrontrun);
  
  // 3. Sandwich detection: three rapid ops on same asset pair with suspicious pricing
  if (assetIn && assetOut) {
    const pairKey = `${assetIn}:${assetOut}`;
    const sandwichRecords = sandwichStore.get(pairKey) ?? [];
    const recentSandwich = sandwichRecords.filter(r => now - r.timestamp < SANDWICH_WINDOW_MS);
    if (recentSandwich.length >= 2) {
      // Check for price anomaly: middle request has worse price for user
      const prices = recentSandwich.map(r => r.price).filter(Boolean).map(Number);
      const currentPrice = price ? Number(price) : NaN;
      if (prices.length >= 2 && !isNaN(currentPrice)) {
        const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
        const deviation = Math.abs(currentPrice - avgPrice) / avgPrice;
        if (deviation > 0.05) { // 5% deviation
          alerts.push({
            type: "sandwich",
            severity: "high",
            account: acc,
            endpoint,
            details: { pair: pairKey, requestCount: recentSandwich.length + 1, windowMs: SANDWICH_WINDOW_MS, priceDeviationPct: deviation * 100, currentPrice, avgPrice },
            timestamp: new Date(now).toISOString(),
            requestId
          });
        }
      }
    }
    recentSandwich.push(record);
    sandwichStore.set(pairKey, recentSandwich);
  }
  
  // 4. Business logic anomalies
  if (amount) {
    const amt = Number(amount);
    if (!isNaN(amt)) {
      // Excessive amount (configurable threshold per asset, here generic)
      if (amt > 1_000_000) { // 1M base units
        alerts.push({
          type: "business_logic",
          severity: "medium",
          account: acc,
          endpoint,
          details: { amount: amt, threshold: 1_000_000, reason: "excessive_amount" },
          timestamp: new Date(now).toISOString(),
          requestId
        });
      }
      // Zero or negative
      if (amt <= 0) {
        alerts.push({
          type: "business_logic",
          severity: "low",
          account: acc,
          endpoint,
          details: { amount: amt, reason: "non_positive_amount" },
          timestamp: new Date(now).toISOString(),
          requestId
        });
      }
    }
  }
  
  // Swap value sanity
  if (assetIn && assetOut && amount && price) {
    const amt = Number(amount);
    const prc = Number(price);
    if (!isNaN(amt) && !isNaN(prc) && prc > 0) {
      const impliedValue = amt * prc;
      if (impliedValue > 10_000_000) { // 10M quote units
        alerts.push({
          type: "business_logic",
          severity: "medium",
          account: acc,
          endpoint,
          details: { assetIn, assetOut, amount: amt, price: prc, impliedValue, threshold: 10_000_000, reason: "excessive_swap_value" },
          timestamp: new Date(now).toISOString(),
          requestId
        });
      }
    }
  }
  
  // Prune stores periodically
  if (Math.random() < 0.01) { // ~1% of calls
    pruneStore(reentrancyStore, REENTRANCY_WINDOW_MS, now);
    pruneStore(frontrunStore, FRONTRUN_WINDOW_MS, now);
    pruneStore(sandwichStore, SANDWICH_WINDOW_MS, now);
  }
  
  // Emit alerts
  for (const alert of alerts) emitAlert(alert);
  
  // For now, allow all requests (monitoring mode). Can be flipped to block via config.
  const blockMode = process.env.BEHAVIORAL_BLOCK_MODE === "true";
  if (blockMode && alerts.some(a => a.severity === "high" || a.severity === "critical")) {
    return { allowed: false, reason: `behavioral_block: ${alerts.map(a => a.type).join(",")}`, alerts };
  }
  return { allowed: true, alerts };
}

// Prometheus metrics exposition (text format)
export function getMetrics(): string {
  const now = Date.now();
  let output = "";
  output += `# HELP behavioral_monitor_reentrancy_tracked_accounts Number of accounts tracked for reentrancy\n`;
  output += `# TYPE behavioral_monitor_reentrancy_tracked_accounts gauge\n`;
  output += `behavioral_monitor_reentrancy_tracked_accounts ${reentrancyStore.size}\n`;
  output += `# HELP behavioral_monitor_frontrun_tracked_patterns Number of param patterns tracked for front-running\n`;
  output += `# TYPE behavioral_monitor_frontrun_tracked_patterns gauge\n`;
  output += `behavioral_monitor_frontrun_tracked_patterns ${frontrunStore.size}\n`;
  output += `# HELP behavioral_monitor_sandwich_tracked_pairs Number of asset pairs tracked for sandwich attacks\n`;
  output += `# TYPE behavioral_monitor_sandwich_tracked_pairs gauge\n`;
  output += `behavioral_monitor_sandwich_tracked_pairs ${sandwichStore.size}\n`;
  // Alert counters (would be incremented in emitAlert in production)
  output += `# HELP behavioral_monitor_alerts_total Total behavioral alerts by type and severity\n`;
  output += `# TYPE behavioral_monitor_alerts_total counter\n`;
  output += `behavioral_monitor_alerts_total{type="reentrancy",severity="high"} 0\n`;
  output += `behavioral_monitor_alerts_total{type="frontrun",severity="medium"} 0\n`;
  output += `behavioral_monitor_alerts_total{type="sandwich",severity="high"} 0\n`;
  output += `behavioral_monitor_alerts_total{type="business_logic",severity="medium"} 0\n`;
  output += `behavioral_monitor_alerts_total{type="business_logic",severity="low"} 0\n`;
  return output;
}

// Self-test
export async function selftest(): Promise<void> {
  const monitor = { recordRequest };
  const reqId = "test-" + Date.now();
  
  // Test reentrancy
  for (let i = 0; i < 4; i++) {
    const res = monitor.recordRequest(`${reqId}-reentrancy-${i}`, "alice", "/api/dex/order", { action: "buy", amount: "100", price: "1.5" });
    if (i === 3 && !res.alerts.some(a => a.type === "reentrancy")) throw new Error("Reentrancy detection failed");
  }
  
  // Test frontrun
  for (let i = 0; i < 3; i++) {
    const account = i === 1 ? "bob" : "charlie";
    const res = monitor.recordRequest(`${reqId}-frontrun-${i}`, account, "/api/dex/swap", { from: "HIVE", to: "SWA.HIVE", amount: "1000" });
    if (i === 2 && !res.alerts.some(a => a.type === "frontrun")) throw new Error("Frontrun detection failed");
  }
  
  // Test sandwich
  monitor.recordRequest(`${reqId}-sandwich-0`, "victim", "/api/dex/swap", { from: "HIVE", to: "SWA.HIVE", amount: "1000", price: "1.0" });
  monitor.recordRequest(`${reqId}-sandwich-1`, "attacker", "/api/dex/swap", { from: "HIVE", to: "SWA.HIVE", amount: "1000", price: "1.0" });
  const sandwichRes = monitor.recordRequest(`${reqId}-sandwich-2`, "attacker", "/api/dex/swap", { from: "HIVE", to: "SWA.HIVE", amount: "1000", price: "1.1" }); // 10% deviation
  if (!sandwichRes.alerts.some(a => a.type === "sandwich")) throw new Error("Sandwich detection failed");
  
  // Test business logic
  const blRes = monitor.recordRequest(`${reqId}-bl`, "eve", "/api/dex/order", { amount: "2000000" });
  if (!blRes.alerts.some(a => a.type === "business_logic" && a.details.reason === "excessive_amount")) throw new Error("Business logic detection failed");
  
  console.log("[behavioral-monitor] selftest passed");
}

// Integration helper for API routes
export async function monitorApiRequest(
  request: Request,
  account: string,
  endpoint: string
): Promise<{ allowed: boolean; reason?: string; alerts: BehavioralAlert[] }> {
  let params: Record<string, unknown> = {};
  try {
    const clone = request.clone();
    params = await clone.json();
  } catch {}
  return recordRequest(crypto.randomUUID(), account, endpoint, params);
}
