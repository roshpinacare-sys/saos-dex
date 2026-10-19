import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';

// ── קבועי ניטור והתראות ────────────────────────────────────────────────
const MONITORING_INTERVAL = 1000; // מרווח דגימה ב-ms
const REENTRANCY_THRESHOLD = 3; // נסיונות reentrancy בחלון זמן קצר
const FRONTRUN_THRESHOLD = 500; // ms בין הזמנה לביצוע
const SANDWICH_DETECT_WINDOW = 3000; // ms לזיהוי sandwich attack
const SWAP_VOLUME_THRESHOLD = 10000; // סף חריג לנפח swap
const ORDER_RATE_THRESHOLD = 30; // הזמנות/דקה
const ALERT_COOLDOWN = 60000; // מרווח התראות ב-ms

// ── מצב ניטור (בזיכרון לשימוש בין-בקשות) ────────────────────────────────
interface MonitoringState {
  ipMetrics: Map<string, {
    requestCount: number;
    lastRequestTime: number;
    orderTimes: number[];
    swapVolumes: number[];
    reentrancyAttempts: number;
    lastReentrancyTime: number;
    suspectedFrontRuns: { symbol: string; price: number; time: number }[];
    lastAlertTime: number;
  }>;
  symbolMetrics: Map<string, {
    lastOrderPrice: number;
    lastSwapTime: number;
    swapCount: number;
    totalVolume: number;
  }>;
  lastGlobalAlert: number;
}

const monitoringState: MonitoringState = {
  ipMetrics: new Map(),
  symbolMetrics: new Map(),
  lastGlobalAlert: 0
};

// ── פונקציות עזר לניטור ──────────────────────────────────────────────────
function getIpMetrics(ip: string) {
  if (!monitoringState.ipMetrics.has(ip)) {
    monitoringState.ipMetrics.set(ip, {
      requestCount: 0,
      lastRequestTime: 0,
      orderTimes: [],
      swapVolumes: [],
      reentrancyAttempts: 0,
      lastReentrancyTime: 0,
      suspectedFrontRuns: [],
      lastAlertTime: 0
    });
  }
  return monitoringState.ipMetrics.get(ip)!;
}

function getSymbolMetrics(symbol: string) {
  if (!monitoringState.symbolMetrics.has(symbol)) {
    monitoringState.symbolMetrics.set(symbol, {
      lastOrderPrice: 0,
      lastSwapTime: 0,
      swapCount: 0,
      totalVolume: 0
    });
  }
  return monitoringState.symbolMetrics.get(symbol)!;
}

function shouldSendAlert(): boolean {
  return Date.now() - monitoringState.lastGlobalAlert > ALERT_COOLDOWN;
}

// ── זיהוי דפוסי תקיפה ─────────────────────────────────────────────────────
function detectReentrancy(ipMetrics: ReturnType<typeof getIpMetrics>, now: number): boolean {
  if (now - ipMetrics.lastReentrancyTime < MONITORING_INTERVAL * 2) {
    ipMetrics.reentrancyAttempts++;
    if (ipMetrics.reentrancyAttempts >= REENTRANCY_THRESHOLD) {
      return true;
    }
  } else {
    ipMetrics.reentrancyAttempts = 1;
  }
  ipMetrics.lastReentrancyTime = now;
  return false;
}

function detectFrontRunning(ipMetrics: ReturnType<typeof getIpMetrics>, symbol: string, price: number, now: number): boolean {
  const recentOrders = ipMetrics.orderTimes.filter(time => now - time < FRONTRUN_THRESHOLD);
  if (recentOrders.length > 0) {
    const frontRun = { symbol, price, time: now };
    ipMetrics.suspectedFrontRuns.push(frontRun);
    
    // שמור רק על הפעולות האחרונות בחלון הזמן
    ipMetrics.suspectedFrontRuns = ipMetrics.suspectedFrontRuns
      .filter(run => now - run.time < SANDWICH_DETECT_WINDOW);
    
    if (ipMetrics.suspectedFrontRuns.length >= 3) {
      return true;
    }
  }
  return false;
}

function detectSandwichAttack(ipMetrics: ReturnType<typeof getIpMetrics>, symbol: string, now: number): boolean {
  const symbolSwaps = ipMetrics.swapVolumes
    .map((volume, i) => ({ volume, time: ipMetrics.orderTimes[i] }))
    .filter(swap => now - swap.time < SANDWICH_DETECT_WINDOW);
  
  if (symbolSwaps.length >= 3) {
    // בדוק אם יש דפוס של קנייה-מכירה-קנייה
    const prices = symbolSwaps.map((_, i) => i);
    if (prices.length >= 3 && prices[0] < prices[1] && prices[1] > prices[2]) {
      return true;
    }
  }
  return false;
}

function detectAnomalousBehavior(symbolMetrics: ReturnType<typeof getSymbolMetrics>, volume: number, now: number): boolean {
  if (volume > SWAP_VOLUME_THRESHOLD) {
    return true;
  }
  
  // בדוק קצב עסקאות חריג
  if (now - symbolMetrics.lastSwapTime < MONITORING_INTERVAL && symbolMetrics.swapCount > 5) {
    return true;
  }
  
  return false;
}

// ── פונקציית הניטור הראשית ───────────────────────────────────────────────
function monitorRequest(req: NextRequest, endpoint: string, data?: any) {
  const now = Date.now();
  const ip = req.headers.get('x-forwarded-for') || req.ip || 'unknown';
  const ipMetrics = getIpMetrics(ip);
  
  // עדכון מדדים בסיסיים
  ipMetrics.requestCount++;
  ipMetrics.lastRequestTime = now;
  
  // ניתוח ספציפי לכל נקודת קצה
  if (endpoint === '/api/dex/order' && data) {
    const symbol = data.symbol || 'UNKNOWN';
    const price = Number(data.price) || 0;
    
    ipMetrics.orderTimes.push(now);
    // שמור רק על הזמנות אחרונות בחלון זמן סביר
    ipMetrics.orderTimes = ipMetrics.orderTimes.filter(time => now - time < SANDWICH_DETECT_WINDOW);
    
    const symbolMetrics = getSymbolMetrics(symbol);
    symbolMetrics.lastOrderPrice = price;
    
    // בדיקות תקיפה
    const isReentrancy = detectReentrancy(ipMetrics, now);
    const isFrontRunning = detectFrontRunning(ipMetrics, symbol, price, now);
    
    if (isReentrancy || isFrontRunning) {
      if (shouldSendAlert()) {
        monitoringState.lastGlobalAlert = now;
        console.warn(JSON.stringify({
          timestamp: new Date().toISOString(),
          action: 'security_alert',
          ip,
          endpoint,
          attack_type: isReentrancy ? 'REENTRANCY' : 'FRONT_RUNNING',
          symbol,
          price,
          severity: 'HIGH'
        }));
      }
    }
  }
  
  if (endpoint === '/api/dex/swap' && data) {
    const symbol = data.symbol || 'UNKNOWN';
    const volume = Number(data.volume) || 0;
    
    const symbolMetrics = getSymbolMetrics(symbol);
    symbolMetrics.swapCount++;
    symbolMetrics.totalVolume += volume;
    symbolMetrics.lastSwapTime = now;
    
    ipMetrics.swapVolumes.push(volume);
    // שמור רק על עסקאות אחרונות בחלון זמן סביר
    ipMetrics.swapVolumes = ipMetrics.swapVolumes.filter((_, i) => 
      ipMetrics.orderTimes.length > i && now - ipMetrics.orderTimes[i] < SANDWICH_DETECT_WINDOW
    );
    
    // בדיקות תקיפה
    const isSandwich = detectSandwichAttack(ipMetrics, symbol, now);
    const isAnomalous = detectAnomalousBehavior(symbolMetrics, volume, now);
    
    if (isSandwich || isAnomalous) {
      if (shouldSendAlert()) {
        monitoringState.lastGlobalAlert = now;
        console.warn(JSON.stringify({
          timestamp: new Date().toISOString(),
          action: 'security_alert',
          ip,
          endpoint,
          attack_type: isSandwich ? 'SANDWICH' : 'ANOMALOUS_BEHAVIOR',
          symbol,
          volume,
          severity: isSandwich ? 'CRITICAL' : 'MEDIUM'
        }));
      }
    }
  }
  
  // ניתוח כללי של קצב בקשות
  const recentRequests = Array.from(monitoringState.ipMetrics.values())
    .filter(metrics => now - metrics.lastRequestTime < 60000)
    .reduce((sum, metrics) => sum + metrics.requestCount, 0);
  
  if (recentRequests > ORDER_RATE_THRESHOLD * 60) {
    if (shouldSendAlert()) {
      monitoringState.lastGlobalAlert = now;
      console.warn(JSON.stringify({
        timestamp: new Date().toISOString(),
        action: 'traffic_spike',
        total_requests_per_minute: recentRequests,
        severity: 'MEDIUM'
      }));
    }
  }
}

// ── ממשק ל-Prometheus (לדוגמה) ────────────────────────────────────────────
function getPrometheusMetrics(): string {
  const now = Math.floor(Date.now() / 1000);
  let metrics = '';
  
  // מדדים לפי IP
  monitoringState.ipMetrics.forEach((ipData, ip) => {
    metrics += `saos_dex_ip_requests_total{ip="${ip}"} ${ipData.requestCount} ${now}\n`;
    metrics += `saos_dex_ip_reentrancy_attempts_total{ip="${ip}"} ${ipData.reentrancyAttempts} ${now}\n`;
    metrics += `saos_dex_ip_suspected_front_runs_total{ip="${ip}"} ${ipData.suspectedFrontRuns.length} ${now}\n`;
  });
  
  // מדדים לפי סמל
  monitoringState.symbolMetrics.forEach((symbolData, symbol) => {
    metrics += `saos_dex_symbol_swaps_total{symbol="${symbol}"} ${symbolData.swapCount} ${now}\n`;
    metrics += `saos_dex_symbol_volume_total{symbol="${symbol}"} ${symbolData.totalVolume} ${now}\n`;
  });
  
  return metrics;
}

// ── middleware להטמעה ──────────────────────────────────────────────────────
export function apiMonitoringMiddleware(req: NextRequest): NextResponse | null {
  const startTime = Date.now();
  const url = new URL(req.url);
  const pathname = url.pathname;
  
  // ניטור רק עבור נקודות קצה קריטיות
  const criticalEndpoints = ['/api/dex/agent', '/api/dex/order', '/api/dex/swap'];
  const isCriticalEndpoint = criticalEndpoints.some(endpoint => pathname.startsWith(endpoint));
  
  if (isCriticalEndpoint) {
    try {
      // ניסיון לקרוא את גוף הבקשה לניתוח
      if (req.method === 'POST' || req.method === 'PUT') {
        const cloned = req.clone();
        cloned.text().then(body => {
          try {
            const data = JSON.parse(body);
            monitorRequest(req, pathname, data);
          } catch (e) {
            // אם נתונים לא חוקיים, עדיין ניטור בסיסי
            monitorRequest(req, pathname);
          }
        }).catch(() => {
          // אם קריאת גוף נכשלה, עדיין ניטור בסיסי
          monitorRequest(req, pathname);
        });
      } else {
        monitorRequest(req, pathname);
      }
    } catch (e) {
      console.error('Monitoring error:', e);
    }
  }
  
  // המשך בזרימה הרגילה
  return null;
}

// ── נקודת קצה למדדי Prometheus ──────────────────────────────────────────────
export async function GET() {
  return new Response(getPrometheusMetrics(), {
    headers: {
      'Content-Type': 'text/plain',
      'Cache-Control': 'no-cache'
    }
  });
}
