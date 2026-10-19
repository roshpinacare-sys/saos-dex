import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';

// טיפוסים עבור ניתוח התנהגות
interface BehavioralMetrics {
  requestCount: number;
  uniqueIPs: Set<string>;
  averageLatency: number;
  suspiciousPatterns: {
    reentrancyAttempts: number;
    frontRunningCandidates: number;
    sandwichAttacks: number;
    unusualSwaps: number;
    excessiveOrders: number;
  };
}

// חסימות למניעת תקיפות
const RATE_LIMITS = {
  requestsPerMinute: 60,
  uniqueIPsPerHour: 100,
  maxOrderSize: 1000000, // גודל מקסימלי להזמנה
  minSwapValue: 0.01, // ערך מינימלי ל-swap
};

// סף לזיהוי חריגות
const THRESHOLDS = {
  reentrancyThreshold: 3, // הרצות חוזרות של אותו IP
  frontRunningThreshold: 5, // הזמנות דומות לפני טרנזקציה
  sandwichThreshold: 2, // הזמנות מהירות לפני/אחרי טרנזקציה
  unusualSwapRatio: 0.5, // יחס חשוד ל-swap
};

// מחסנית למדידות
const metrics = new Map<string, BehavioralMetrics>();
const ipTracking = new Map<string, { count: number; lastRequest: number }>();

/**
 * מזהה דפוסי תקיפה פוטנציאליים
 */
function detectSuspiciousPatterns(ip: string, path: string, method: string, body: any): {
  type: string;
  severity: 'low' | 'medium' | 'high';
  message: string;
}[] {
  const threats: { type: string; severity: 'low' | 'medium' | 'high'; message: string }[] = [];
  
  // זיהוי reentrancy
  const ipMetrics = ipTracking.get(ip);
  if (ipMetrics && ipMetrics.count > THRESHOLDS.reentrancyThreshold) {
    threats.push({
      type: 'reentrancy',
      severity: 'medium',
      message: 'חשד לניסיון reentrancy attack - הרבה בקשות מאותו IP'
    });
  }
  
  // זיהוי front-running
  if (path.includes('/api/dex/order') && method === 'POST') {
    const orderData = JSON.parse(body);
    const recentOrders = Array.from(metrics.values())
      .filter(m => m.suspiciousPatterns.frontRunningCandidates > 0)
      .length;
    
    if (recentOrders > THRESHOLDS.frontRunningThreshold) {
      threats.push({
        type: 'front-running',
        severity: 'high',
        message: 'חשד ל-front-running attack - הזמנות דומות זו אחר זו'
      });
    }
  }
  
  // זיהוי sandwich attack
  if (path.includes('/api/dex/swap') && method === 'POST') {
    const swapData = JSON.parse(body);
    if (swapData.inputAmount > RATE_LIMITS.maxOrderSize * 0.9) {
      threats.push({
        type: 'sandwich-attack',
        severity: 'high',
        message: 'חשד ל-sandwich attack - הזמנה גדולה מאוד'
      });
    }
  }
  
  // זיהוי swaps לא סבירים
  if (path.includes('/api/dex/swap') && method === 'POST') {
    const swapData = JSON.parse(body);
    const ratio = swapData.inputAmount / swapData.outputAmount;
    
    if (ratio < THRESHOLDS.unusualSwapRatio || ratio > 1 / THRESHOLDS.unusualSwapRatio) {
      threats.push({
        type: 'unusual-swap',
        severity: 'medium',
        message: `חשד ל-swap לא סביר - יחס ${ratio.toFixed(2)}`
      });
    }
  }
  
  return threats;
}

/**
 * עדכון מדדים ל-Prometheus
 */
function updateMetrics(ip: string, path: string, latency: number, threats: any[]) {
  if (!metrics.has(path)) {
    metrics.set(path, {
      requestCount: 0,
      uniqueIPs: new Set(),
      averageLatency: 0,
      suspiciousPatterns: {
        reentrancyAttempts: 0,
        frontRunningCandidates: 0,
        sandwichAttacks: 0,
        unusualSwaps: 0,
        excessiveOrders: 0,
      }
    });
  }
  
  const pathMetrics = metrics.get(path)!;
  pathMetrics.requestCount++;
  pathMetrics.uniqueIPs.add(ip);
  
  // עדכון ממוצע הלטנסי
  const totalRequests = pathMetrics.requestCount;
  pathMetrics.averageLatency = (pathMetrics.averageLatency * (totalRequests - 1) + latency) / totalRequests;
  
  // עדכון דפוסים חשודים
  threats.forEach(threat => {
    switch (threat.type) {
      case 'reentrancy':
        pathMetrics.suspiciousPatterns.reentrancyAttempts++;
        break;
      case 'front-running':
        pathMetrics.suspiciousPatterns.frontRunningCandidates++;
        break;
      case 'sandwich-attack':
        pathMetrics.suspiciousPatterns.sandwichAttacks++;
        break;
      case 'unusual-swap':
        pathMetrics.suspiciousPatterns.unusualSwaps++;
        break;
      case 'excessive-orders':
        pathMetrics.suspiciousPatterns.excessiveOrders++;
        break;
    }
  });
  
  // בדיקת חריגות בהתנהגות
  if (pathMetrics.suspiciousPatterns.reentrancyAttempts > THRESHOLDS.reentrancyThreshold) {
    triggerAlert('high', 'reentrancy', `רמת reentrancy גבוהה בנתיב ${path}`);
  }
  
  if (pathMetrics.suspiciousPatterns.frontRunningCandidates > THRESHOLDS.frontRunningThreshold) {
    triggerAlert('high', 'front-running', `חשד ל-front-running בנתיב ${path}`);
  }
}

/**
 * מערכת התראות
 */
function triggerAlert(severity: 'low' | 'medium' | 'high', type: string, message: string) {
  // התראה למערכת הפנימית
  console.log(`[${severity.toUpperCase()}] ${type}: ${message}`);
  
  // התראה למערכת חיצונית (אם מוגדרת)
  if (process.env.SECURITY_ALERTS_WEBHOOK) {
    fetch(process.env.SECURITY_ALERTS_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        severity,
        type,
        message,
        service: 'saos-dex',
      }),
    }).catch(err => console.error('Failed to send security alert:', err));
  }
  
  // רישום למערכת הרישום הקיימת
  void (async () => {
    try {
      const { logSecurityEvent } = await import('@/lib/dex/alert');
      await logSecurityEvent({
        type,
        severity,
        message,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.error('Failed to log security event:', err);
    }
  })();
}

/**
 * מידול למידת בסיס (פשוט לדוגמה)
 */
function updateModel(threatType: string, isThreat: boolean) {
  // ביישום מלא, כאן היינו מעדכנים מודל מכונה
  // כדי לשפר את הדיוק של זיהוי התקיפות
  console.log(`[MODEL_UPDATE] Threat type: ${threatType}, Is threat: ${isThreat}`);
}

/**
 * המידלוור הראשי לניטור התנהגות
 */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const startTime = Date.now();
  const ip = request.headers.get('x-forwarded-for') || 'unknown';
  const path = request.nextUrl.pathname;
  const method = request.method;
  
  // עדכון עוקב IP
  if (!ipTracking.has(ip)) {
    ipTracking.set(ip, { count: 0, lastRequest: Date.now() });
  }
  
  const ipData = ipTracking.get(ip)!;
  ipData.count++;
  ipData.lastRequest = Date.now();
  
  // ניטור קצב בקשות
  if (ipData.count > RATE_LIMITS.requestsPerMinute) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429 }
    );
  }
  
  // ניתוח בקשות ל-API של DEX
  if (path.startsWith('/api/dex/')) {
    let body = '';
    if (method === 'POST' || method === 'PUT') {
      try {
        body = await request.text();
      } catch (err) {
        console.error('Failed to read request body:', err);
      }
    }
    
    // זיהוי דפוסים חשודים
    const threats = detectSuspiciousPatterns(ip, path, method, body);
    
    // עדכון מדדים
    const latency = Date.now() - startTime;
    updateMetrics(ip, path, latency, threats);
    
    // טיפול באיומים
    if (threats.length > 0) {
      threats.forEach(threat => {
        triggerAlert(threat.severity, threat.type, threat.message);
        updateModel(threat.type, true);
      });
      
      // חסימת בקשות מסוכנות
      if (threats.some(t => t.severity === 'high')) {
        return NextResponse.json(
          { error: 'Suspicious activity detected' },
          { status: 403 }
        );
      }
    }
  }
  
  // המשך לבקשה הרגילה
  const response = NextResponse.next();
  
  // הוספת כותרת עם חתימת הבקשה לניטור
  const bodyHash = createHash('sha256').update(
    await request.clone().text()
  ).digest('hex');
  
  response.headers.set('x-request-hash', bodyHash);
  
  return response;
}

/**
 * נקודת קצה לחשיפת מדדים (לניטור פנימי)
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const path = searchParams.get('path');
  
  if (path && metrics.has(path)) {
    return NextResponse.json({
      metrics: metrics.get(path),
      timestamp: new Date().toISOString(),
    });
  }
  
  return NextResponse.json({
    metrics: Object.fromEntries(metrics),
    timestamp: new Date().toISOString(),
  });
}
