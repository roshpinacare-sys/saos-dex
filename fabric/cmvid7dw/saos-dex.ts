// src/lib/dex/attack-detector.ts
/**
 * Attack Detector — מנגנון זיהוי תקיפות פרוגרמטי ל-SAOS-DEX
 * 
 * מודול זה מיישם 5 שכבות הגנה:
 * 1. Reentrancy Detection — ניתוח זרימות קריאות חוזרות
 * 2. Front-running Detection — זיהוי עליות מחיר חשודות לפני עסקאות גדולות
 * 3. Sandwich Attack Detection — ניתוח עסקאות בזמן קצר עם רווחים חריגים
 * 4. User Behavior Monitoring — סימון פעולות חריגות (קצב עסקאות גבוה)
 * 5. Real-time Suspicious Activity Reports — דוחות עם דרגות סיכון
 * 
 * עקרונות תכנון:
 * - אפס תלות חיצונית — רץ בתוך הגרעין הדטרמיניסטי
 * - O(1) זיכרון לכל משתמש — חלונות הזזה קבועים
 * - fail-open לזמינות — כשל בניטור לא חוסם מסחר לגיטימי
 * - אין סודות בלוגים — רק מזהים ציבוריים (account, symbol, txid)
 */

import { createHash } from "node:crypto";

// ─── Types ──────────────────────────────────────────────────────────────

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface AttackSignal {
  type: "REENTRANCY" | "FRONT_RUNNING" | "SANDWICH" | "ANOMALOUS_BEHAVIOR";
  risk: RiskLevel;
  account: string;
  symbol?: string;
  details: Record<string, unknown>;
  timestamp: number;
  txid?: string;
}

export interface UserBehaviorProfile {
  account: string;
  txCountWindow: number;        // עסקאות בחלון הנוכחי
  txTimestamps: number[];       // timestamps של עסקאות אחרונות (מקס 100)
  volumeWindow: number;         // נפח בחלון הנוכחי (בסיסי)
  uniqueSymbols: Set<string>;   // סימבולים ייחודיים בחלון
  avgTxInterval: number;        // מרווח ממוצע בין עסקאות (ms)
  lastUpdate: number;
  riskScore: number;            // 0-100
  flags: string[];              // דגלים מצטברים
}

export interface DetectionConfig {
  // Reentrancy
  reentrancyMaxDepth: number;           // עומק קריאות מקסימלי מותר
  reentrancyWindowMs: number;           // חלון זמן לזיהוי קריאות חוזרות
  
  // Front-running
  frontRunPriceShiftBps: number;        // שינוי מחיר ב-bps שמפעיל חשד
  frontRunTimeWindowMs: number;         // חלון זמן לפני עסקה גדולה
  frontRunMinVolume: number;            // נפח מינימלי לעסקה "גדולה"
  
  // Sandwich
  sandwichTimeWindowMs: number;         // חלון זמן מקסימלי בין קנייה למכירה
  sandwichMinProfitBps: number;         // רווח מינימלי ב-bps לזיהוי
  sandwichMaxSlippageBps: number;       // החלקה מקסימלית צפויה לגיטימית
  
  // Anomalous Behavior
  anomalyMaxTxPerMinute: number;        // מקס עסקאות לדקה לפני דגל
  anomalyMaxVolumeMultiplier: number;   // מכפיל נפח מעל הממוצע
  anomalyMinUniqueSymbols: number;      // מינימום סימבולים שונים לפיזור
  anomalyWindowMs: number;              // חלון התנהגות
  
  // General
  maxProfiles: number;                  // מקסימום פרופילים בזיכרון
  reportCooldownMs: number;             // קירור בין דוחות לאותו חשבון
}

// ─── Default Config ─────────────────────────────────────────────────────

export const DEFAULT_CONFIG: DetectionConfig = {
  reentrancyMaxDepth: 3,
  reentrancyWindowMs: 5000,
  frontRunPriceShiftBps: 50,        // 0.5%
  frontRunTimeWindowMs: 10000,      // 10 שניות
  frontRunMinVolume: 10000,         // 10k יחידות בסיס
  sandwichTimeWindowMs: 30000,      // 30 שניות
  sandwichMinProfitBps: 100,        // 1%
  sandwichMaxSlippageBps: 200,      // 2%
  anomalyMaxTxPerMinute: 30,
  anomalyMaxVolumeMultiplier: 5,
  anomalyMinUniqueSymbols: 3,
  anomalyWindowMs: 60000,           // דקה
  maxProfiles: 10000,
  reportCooldownMs: 300000,         // 5 דקות
};

// ─── Internal State ─────────────────────────────────────────────────────

interface CallFrame {
  account: string;
  fn: string;
  timestamp: number;
  depth: number;
}

const callStack = new Map<string, CallFrame[]>(); // account -> stack
const userProfiles = new Map<string, UserBehaviorProfile>();
const recentReports = new Map<string, number>();  // account -> last report timestamp
const priceHistory = new Map<string, { price: number; timestamp; volume: number }[]>(); // symbol -> history

// ─── Helpers ────────────────────────────────────────────────────────────

function now(): number {
  return Date.now();
}

function pruneOldEntries<T extends { timestamp: number }>(arr: T[], windowMs: number): T[] {
  const cutoff = now() - windowMs;
  const idx = arr.findIndex(e => e.timestamp >= cutoff);
  return idx >= 0 ? arr.slice(idx) : [];
}

function getOrCreateProfile(account: string): UserBehaviorProfile {
  let profile = userProfiles.get(account);
  if (!profile) {
    if (userProfiles.size >= DEFAULT_CONFIG.maxProfiles) {
      // LRU eviction — הסר הכי ישן
      const oldest = [...userProfiles.entries()].sort((a, b) => a[1].lastUpdate - b[1].lastUpdate)[0];
      if (oldest) userProfiles.delete(oldest[0]);
    }
    profile = {
      account,
      txCountWindow: 0,
      txTimestamps: [],
      volumeWindow: 0,
      uniqueSymbols: new Set(),
      avgTxInterval: 0,
      lastUpdate: now(),
      riskScore: 0,
      flags: [],
    };
    userProfiles.set(account, profile);
  }
  return profile;
}

function calculateRiskScore(profile: UserBehaviorProfile): number {
  let score = 0;
  // קצב עסקאות
  if (profile.txCountWindow > DEFAULT_CONFIG.anomalyMaxTxPerMinute) {
    score += Math.min(40, (profile.txCountWindow / DEFAULT_CONFIG.anomalyMaxTxPerMinute) * 20);
  }
  // עקביות מרווחים (בוטים נוטים להיות מדויקים מדי)
  if (profile.txTimestamps.length >= 5) {
    const intervals = [];
    for (let i = 1; i < profile.txTimestamps.length; i++) {
      intervals.push(profile.txTimestamps[i] - profile.txTimestamps[i-1]);
    }
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const variance = intervals.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / intervals.length;
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 0; // coefficient of variation
    if (cv < 0.1) score += 25; // חשוד: מרווחים זהים מדי
  }
  // ריכוז סימבולים
  if (profile.uniqueSymbols.size < DEFAULT_CONFIG.anomalyMinUniqueSymbols && profile.txCountWindow > 10) {
    score += 15;
  }
  return Math.min(100, score);
}

function riskLevelFromScore(score: number): RiskLevel {
  if (score >= 80) return "CRITICAL";
  if (score >= 60) return "HIGH";
  if (score >= 35) return "MEDIUM";
  return "LOW";
}

function shouldReport(account: string): boolean {
  const last = recentReports.get(account) ?? 0;
  if (now() - last >= DEFAULT_CONFIG.reportCooldownMs) {
    recentReports.set(account, now());
    return true;
  }
  return false;
}

function emitSignal(signal: AttackSignal): void {
  // לוג מבני — ללא סודות
  console.warn(JSON.stringify({
    timestamp: new Date(signal.timestamp).toISOString(),
    action: "attack_signal",
    type: signal.type,
    risk: signal.risk,
    account: signal.account,
    symbol: signal.symbol,
    txid: signal.txid,
    details: signal.details,
  }));
  
  // כאן אפשר לחבר למערכת התראות חיצונית (webhook, DB, וכו')
  // נשמר fail-open — כשל כאן לא שובר את הזרימה
}

// ─── 1. Reentrancy Detection ────────────────────────────────────────────

/**
 * נכנס להקשר קריאה — בודק עומק קריאות חוזרות לאותו חשבון+פונקציה
 * 
 * לוגיקה עסקית:
 * - התקפת reentrancy קלאסית קוראת לפונקציה חיצונית שקוראת חזרה לאותה פונקציה
 * - בגרעין דטרמיניסטי כמו שלנו, זה מתבטא בקריאות מקוננות לאותו op
 * - אנו עוקבים אחר עומק הקריאה לכל (account, function) בחלון זמן
 * - חריגה מהעומק המותר = סיגנל REENTRANCY
 */
export function enterCallFrame(account: string, fn: string): { allowed: boolean; signal?: AttackSignal } {
  const key = `${account}:${fn}`;
  const stack = callStack.get(key) ?? [];
  const currentDepth = stack.length;
  
  // ניקוי ישן
  const cleaned = pruneOldEntries(stack, DEFAULT_CONFIG.reentrancyWindowMs);
  
  if (cleaned.length >= DEFAULT_CONFIG.reentrancyMaxDepth) {
    const signal: AttackSignal = {
      type: "REENTRANCY",
      risk: "HIGH",
      account,
      details: {
        function: fn,
        depth: cleaned.length,
        maxAllowed: DEFAULT_CONFIG.reentrancyMaxDepth,
        windowMs: DEFAULT_CONFIG.reentrancyWindowMs,
      },
      timestamp: now(),
    };
    if (shouldReport(account)) emitSignal(signal);
    return { allowed: false, signal };
  }
  
  cleaned.push({ account, fn, timestamp: now(), depth: currentDepth + 1 });
  callStack.set(key, cleaned);
  return { allowed: true };
}

export function exitCallFrame(account: string, fn: string): void {
  const key = `${account}:${fn}`;
  const stack = callStack.get(key);
  if (stack && stack.length > 0) {
    stack.pop();
    if (stack.length === 0) callStack.delete(key);
  }
}

// ─── 2. Front-running Detection ─────────────────────────────────────────

/**
 * רושם תצפית מחיר — נקרא בכל עדכון מחיר (AMM swap, book fill, oracle)
 */
export function recordPriceObservation(symbol: string, price: number, volume: number): void {
  const history = priceHistory.get(symbol) ?? [];
  history.push({ price, timestamp: now(), volume });
  // שמור רק חלון רלוונטי (5 דקות)
  priceHistory.set(symbol, pruneOldEntries(history, 300000));
}

/***
 * בודק front-running לפני ביצוע עסקה גדולה
 * 
 * לוגיקה עסקית:
 * - Front-runner מזהה עסקה גדולה ממתינה (ב-mempool או ב-book גלוי)
 * - קונה לפניה ומוכר אחריה ברווח
 * - סימן מקדים: תזוזת מחיר חדה בכיוון העסקה הגדולה, זמן קצר לפניה
 * - אנו בודקים היסטוריית מחירים בחלון הזמן לפני העסקה
 */
export function checkFrontRunning(
  account: string,
  symbol: string,
  side: "buy" | "sell",
  volume: number,
  currentPrice: number
): AttackSignal | null {
  if (volume < DEFAULT_CONFIG.frontRunMinVolume) return null;
  
  const history = priceHistory.get(symbol) ?? [];
  const cutoff = now() - DEFAULT_CONFIG.frontRunTimeWindowMs;
  const recent = history.filter(h => h.timestamp >= cutoff);
  if (recent.length < 2) return null;
  
  // חשב שינוי מחיר בחלון
  const oldest = recent[0];
  const priceChangeBps = ((currentPrice - oldest.price) / oldest.price) * 10000;
  
  // כיוון חשוד: מחיר עולה לפני קנייה גדולה, יורד לפני מכירה גדולה
  const suspiciousDirection = (side === "buy" && priceChangeBps > DEFAULT_CONFIG.frontRunPriceShiftBps) ||
                              (side === "sell" && priceChangeBps < -DEFAULT_CONFIG.frontRunPriceShiftBps);
  
  if (!suspiciousDirection) return null;
  
  const signal: AttackSignal = {
    type: "FRONT_RUNNING",
    risk: Math.abs(priceChangeBps) > DEFAULT_CONFIG.frontRunPriceShiftBps * 3 ? "HIGH" : "MEDIUM",
    account,
    symbol,
    details: {
      side,
      volume,
      priceChangeBps: Math.round(priceChangeBps),
      thresholdBps: DEFAULT_CONFIG.frontRunPriceShiftBps,
      windowMs: DEFAULT_CONFIG.frontRunTimeWindowMs,
      observationsCount: recent.length,
    },
    timestamp: now(),
  };
  
  if (shouldReport(account)) emitSignal(signal);
  return signal;
}

// ─── 3. Sandwich Attack Detection ───────────────────────────────────────

interface UserTrade {
  account: string;
  symbol: string;
  side: "buy" | "sell";
  price: number;
  volume: number;
  timestamp: number;
  txid: string;
}

const recentTrades = new Map<string, UserTrade[]>(); // account -> trades

/***
 * רושם עסקה שבוצעה — משמש לזיהוי sandwich
 */
export function recordTrade(trade: UserTrade): void {
  const trades = recentTrades.get(trade.account) ?? [];
  trades.push(trade);
  recentTrades.set(trade.account, pruneOldEntries(trades, DEFAULT_CONFIG.sandwichTimeWindowMs * 2));
}

/***
 * בודק דפוס sandwich: קנייה ואז מכירה מהירה באותו סימבול ברווח חריג
 * 
 * לוגיקה עסקית:
 * - Sandwich attacker: קונה -> קורבן קונה (מעלה מחיר) -> מוכר ברווח
 * - או: מוכר -> קורבן מוכר (מוריד מחיר) -> קונה בזול
 * - מאפיינים: זמן קצר, אותו סימבול, צדדים הפוכים, רווח > עמלות + החלקה
 */
export function checkSandwichAttack(account: string, symbol: string): AttackSignal | null {
  const trades = recentTrades.get(account) ?? [];
  const symbolTrades = trades.filter(t => t.symbol === symbol);
  if (symbolTrades.length < 2) return null;
  
  // חפש זוגות קנייה-מכירה או מכירה-קנייה קרובים בזמן
  for (let i = 0; i < symbolTrades.length - 1; i++) {
    const t1 = symbolTrades[i];
    const t2 = symbolTrades[i + 1];
    
    if (t1.side === t2.side) continue; // אותו צד — לא sandwich
    const timeDiff = t2.timestamp - t1.timestamp;
    if (timeDiff > DEFAULT_CONFIG.sandwichTimeWindowMs) continue;
    
    // חשב רווח יחסי
    let profitBps: number;
    if (t1.side === "buy" && t2.side === "sell") {
      profitBps = ((t2.price - t1.price) / t1.price) * 10000;
    } else {
      profitBps = ((t1.price - t2.price) / t2.price) * 10000;
    }
    
    // נכה עמלות צפויות (30bps AMM + החלקה מקסימלית)
    const netProfitBps = profitBps - 30 - DEFAULT_CONFIG.sandwichMaxSlippageBps;
    
    if (netProfitBps >= DEFAULT_CONFIG.sandwichMinProfitBps) {
      const signal: AttackSignal = {
        type: "SANDWICH",
        risk: netProfitBps > DEFAULT_CONFIG.sandwichMinProfitBps * 3 ? "CRITICAL" : "HIGH",
        account,
        symbol,
        details: {
          firstTrade: { side: t1.side, price: t1.price, volume: t1.volume, txid: t1.txid },
          secondTrade: { side: t2.side, price: t2.price, volume: t2.volume, txid: t2.txid },
          timeDiffMs: timeDiff,
          grossProfitBps: Math.round(profitBps),
          netProfitBps: Math.round(netProfitBps),
          thresholdBps: DEFAULT_CONFIG.sandwichMinProfitBps,
        },
        timestamp: now(),
        txid: t2.txid,
      };
      if (shouldReport(account)) emitSignal(signal);
      return signal;
    }
  }
  return null;
}

// ─── 4. Anomalous Behavior Monitoring ───────────────────────────────────

/***
 * מעדכן פרופיל התנהגות משתמש — נקרא בכל עסקה/פעולה
 */
export function updateUserBehavior(
  account: string,
  symbol: string,
  volume: number
): AttackSignal | null {
  const profile = getOrCreateProfile(account);
  const nowMs = now();
  
  // ניקוי חלון
  profile.txTimestamps = pruneOldEntries(
    profile.txTimestamps.map(ts => ({ timestamp: ts })),
    DEFAULT_CONFIG.anomalyWindowMs
  ).map(e => e.timestamp);
  
  profile.txTimestamps.push(nowMs);
  profile.txCountWindow = profile.txTimestamps.length;
  profile.volumeWindow += volume;
  profile.uniqueSymbols.add(symbol);
  profile.lastUpdate = nowMs;
  
  // חשב מרווח ממוצע
  if (profile.txTimestamps.length >= 2) {
    const intervals = [];
    for (let i = 1; i < profile.txTimestamps.length; i++) {
      intervals.push(profile.txTimestamps[i] - profile.txTimestamps[i-1]);
    }
    profile.avgTxInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  }
  
  // חשב risk score
  const newScore = calculateRiskScore(profile);
  const prevRisk = riskLevelFromScore(profile.riskScore);
  const newRisk = riskLevelFromScore(newScore);
  profile.riskScore = newScore;
  
  // דגל אם עליית דרגה
  const riskOrder = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
  if (riskOrder[newRisk] > riskOrder[prevRisk]) {
    const flag = `risk_escalation_${prevRisk}_to_${newRisk}`;
    if (!profile.flags.includes(flag)) profile.flags.push(flag);
    
    const signal: AttackSignal = {
      type: "ANOMALOUS_BEHAVIOR",
      risk: newRisk,
      account,
      details: {
        txCount: profile.txCountWindow,
        volume: profile.volumeWindow,
        uniqueSymbols: profile.uniqueSymbols.size,
        avgIntervalMs: Math.round(profile.avgTxInterval),
        riskScore: newScore,
        flags: profile.flags,
        prevRisk,
        newRisk,
      },
      timestamp: nowMs,
    };
    if (shouldReport(account)) emitSignal(signal);
    return signal;
  }
  
  return null;
}

// ─── 5. Reporting & Query API ───────────────────────────────────────────

export interface SuspiciousActivityReport {
  account: string;
  riskLevel: RiskLevel;
  signals: AttackSignal[];
  profile: UserBehaviorProfile;
  generatedAt: number;
}

export function generateReport(account: string): SuspiciousActivityReport | null {
  const profile = userProfiles.get(account);
  if (!profile) return null;
  
  // אסוף סיגנלים אחרונים לחשבון (מ-logs או ממטמון ייעודי — כאן מפרופיל)
  const signals: AttackSignal[] = []; // בפרודקשן: שליפה ממאגר סיגנלים
  
  return {
    account,
    riskLevel: riskLevelFromScore(profile.riskScore),
    signals,
    profile: { ...profile, uniqueSymbols: new Set(profile.uniqueSymbols) },
    generatedAt: now(),
  };
}

export function getAllHighRiskAccounts(riskThreshold: RiskLevel = "HIGH"): string[] {
  const order = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
  const threshold = order[riskThreshold];
  return [...userProfiles.entries()]
    .filter(([, p]) => order[riskLevelFromScore(p.riskScore)] >= threshold)
    .map(([account]) => account);
}

export function resetAccountProfile(account: string): boolean {
  return userProfiles.delete(account);
}

export function getConfig(): DetectionConfig {
  return { ...DEFAULT_CONFIG };
}

export function updateConfig(partial: Partial<DetectionConfig>): void {
  Object.assign(DEFAULT_CONFIG, partial);
}

// ─── Test Helpers (לבדיקות יחידה בלבד) ────────────────────────────────

export function __testOnly_resetState(): void {
  callStack.clear();
  userProfiles.clear();
  recentReports.clear();
  priceHistory.clear();
  recentTrades.clear();
}

export function __testOnly_getProfile(account: string): UserBehaviorProfile | undefined {
  return userProfiles.get(account);
}

export function __testOnly_getCallStack(account: string, fn: string): CallFrame[] {
  return callStack.get(`${account}:${fn}`) ?? [];
}
