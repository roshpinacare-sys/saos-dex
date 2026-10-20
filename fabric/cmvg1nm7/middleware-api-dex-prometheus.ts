// src/metrics.ts — פותח ניטור התנהגותי ל-DEX
import { createInstrumentation } from '@opentelemetry/instrumentation'
import type { NextRequest } from 'next/server'

// מדדים גלובליים — מותאם על ידי middleware
const metricCounters: Map<string, number> = new Map();
const metricLastValues: Map<string, number> = new Map();

// מונה התראות התנהגותיות
function incr(key: string): void {
  const v = (metricCounters.get(key) ?? 0) + 1;
  metricCounters.set(key, v);
  return v;
}

// Z-score נייד על פני חלון זמן
function zScore(current: number, window: number[]): number {
  if (window.length < 2) return 0;
  const mean = window.reduce((a, b) => a + b, 0) / window.length;
  const variance = window.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / window.length;
  const std = Math.sqrt(variance || 0);
  return std > 0 ? (current - mean) / std : 0;
}

export interface DexMetrics {
  requestVolume: number;
  requestFrequency: number;
  swapAnomalyCount: number;
  frontrunRisk: number;
}

export function getMetrics(): DexMetrics {
  const now = Date.now();
  const requestVolume = metricCounters.get('dex_api_request_volume') ?? 0;
  const requestFrequency = metricCounters.get('dex_api_request_frequency') ?? 0;
  const swapAnomalyCount = metricCounters.get('dex_api_swap_anomaly') ?? 0;
  const frontrunRisk = metricCounters.get('dex_api_frontrun_risk') ?? 0;
  return { requestVolume, requestFrequency, swapAnomalyCount, frontrunRisk };
}

export function recordRequest(pathname: string, ip: string, userId?: string): void {
  const key = `volume:${pathname}:${ip}:${userId || 'anon'}`;
  incr(key);
  const total = metricCounters.get('dex_api_request_volume') ?? 0;
  metricCounters.set('dex_api_request_volume', total + 1);
}

export function recordSwap(pathname: string, ip: string, userId?: string, amount?: number, priceImpact?: number): void {
  const key = `swap:${pathname}:${ip}:${userId || 'anon'}`;
  incr(key);
  // נרשם נפח לסלילת Z-score
  const volKey = `swap_volume:${pathname}`;
  const prev = metricCounters.get(volKey) ?? 0;
  metricCounters.set(volKey, prev + (amount ?? 0));
  // ניטור השפעת החלקה קיצונית
  if (priceImpact && Math.abs(priceImpact) > 0.15) {
    incr('dex_api_swap_anomaly');
  }
}

export function checkAnomaly(pathname: string, ip: string, userId?: string): boolean {
  const freqKey = `freq:${pathname}:${ip}:${userId || 'anon'}`;
  const count = metricCounters.get(freqKey) ?? 0;
  const windowKey = `window:${pathname}:${ip}`;
  let window = metricLastValues.get(windowKey) ?? [];
  // שמרו את 60 הערכים האחרונים (דקה)
  window = window.slice(-60);
  window.push(count);
  if (window.length > 60) window.shift();
  metricLastValues.set(windowKey, window);
  const z = zScore(count, window);
  return Math.abs(z) > 3; // חריגה מעל 3 סטיות תקן
}

export function checkFrontrun(pathname: string, ip: string, userId?: string, priceImpact?: number): boolean {
  // כלל פשוט: swap מהיר ברצף באותו טוקן עם השפעת חלקה גבוהה
  const recentKey = `recent:${pathname}:${ip}`;
  const lastTs = metricCounters.get(recentKey) ?? 0;
  const now = Date.now();
  if (now - lastTs < 2000) {
    // swap בתוך 2 שניות זהים
    if (priceImpact && Math.abs(priceImpact) > 0.2) {
      incr('dex_api_frontrun_risk');
      return true;
    }
  }
  metricCounters.set(recentKey, now);
  return false;
}
// חשיפה ל-Prometheus (פשוטה — export לקונסולה)
export function exposeMetrics(): string {
  const m = getMetrics();
  return `# HELP dex_api_request_volume_total מספר כולל של בקשות API DEX\n# TYPE dex_api_request_volume_total counter\ndex_api_request_volume_total ${m.requestVolume}\n# HELP dex_api_swap_anomalies_total מספר התראותSwap חריג\n# TYPE dex_api_swap_anomalies_total counter\ndex_api_swap_anomalies_total ${m.swapAnomalyCount}\n# HELP dex_api_frontrun_risk_total סימני front-running\n# TYPE dex_api_frontrun_risk_total counter\ndex_api_frontrun_risk_total ${m.frontrunRisk}\n`;
}
// פותח פונקציה נוחה ל-middleware
export function initBehavioralMiddleware() {
  return async (req: Request, next: Function) => {
    const pathname = new URL(req.url).pathname;
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0] || req.headers.get('x-real-ip') || 'unknown';
    const userId = req.headers.get('x-user-id');
    // נרשם כל בקשה
    recordRequest(pathname, ip, userId);
    // בדיקת חריגה רק בנקודות הקצה הרלוונטיות
    if (pathname.startsWith('/api/dex/agent') || pathname.startsWith('/api/dex/order') || pathname.startsWith('/api/dex/swap')) {
      const anomaly = checkAnomaly(pathname, ip, userId);
      if (anomaly) {
        incr('dex_api_behavioral_anomalies_total');
        console.warn(`[behavioral-anomaly] path=${pathname} ip=${ip} user=${userId || 'anon'} z-score exceeded threshold`);
      }
      const frontrun = checkFrontrun(pathname, ip, userId);
      if (frontrun) {
        incr('dex_api_frontrun_detected_total');
        console.warn(`[frontrun-detect] path=${pathname} ip=${ip} user=${userId || 'anon'}`);
      }
    }
    return next(req);
  };
}
