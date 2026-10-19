import { NextRequest, NextResponse } from 'next/server';

// ── סכימות ניטור וזיהוי חריגות ──
interface RequestMetrics {
  ip: string;
  path: string;
  method: string;
  timestamp: number;
  statusCode: number;
  userAgent?: string;
  suspiciousPatterns?: string[];
}

interface BehavioralPattern {
  ip: string;
  requestCount: number;
  burstThreshold: number;
  lastRequestTime: number;
}

interface AttackSignature {
  pattern: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
}

// ── תצורת ELK ──
const ELK_CONFIG = {
  node: process.env.ELK_NODE || 'http://localhost:9200',
  index: 'saos-dex-logs',
  auth: {
    username: process.env.ELK_USERNAME || '',
    password: process.env.ELK_PASSWORD || '',
  },
};

// ── חתימות התקפות ──
const ATTACK_SIGNATURES: AttackSignature[] = [
  {
    pattern: '(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|EXEC|SCRIPT)',
    severity: 'high',
    description: 'SQL Injection attempt',
  },
  {
    pattern: '(\.\./|\\\\)',
    severity: 'high',
    description: 'Path Traversal attempt',
  },
  {
    pattern: '(<script|javascript:|data:)',
    severity: 'medium',
    description: 'XSS attempt',
  },
  {
    pattern: '(admin|root|password|login)',
    severity: 'medium',
    description: 'Brute force attempt',
  },
];

// ── נתיבים רגישים ──
const SENSITIVE_PATHS = [
  '/api/dex/agent',
  '/api/dex/order',
  '/api/dex/transfer',
  '/api/dex/wallets',
  '/api/dex/security',
];

// ── ניטור התנהגותי ──
const behavioralMetrics = new Map<string, BehavioralPattern>();
const requestMetrics: RequestMetrics[] = [];
const MAX_METRICS = 10000;
const BURST_THRESHOLD = 50; // בקשות בפרק זמן קצר
const TIME_WINDOW_MS = 60000; // דקה אחת

// ── פונקציות עזר ──
function detectSuspiciousPatterns(request: NextRequest): string[] {
  const patterns: string[] = [];
  const url = request.nextUrl.pathname;
  const userAgent = request.headers.get('user-agent') || '';
  
  // בדיקת חתימות התקפות
  for (const signature of ATTACK_SIGNATURES) {
    if (signature.pattern && (
      url.toLowerCase().includes(signature.pattern.toLowerCase()) ||
      userAgent.toLowerCase().includes(signature.pattern.toLowerCase())
    )) {
      patterns.push(signature.description);
    }
  }
  
  // בדיקת נתיבים רגישים
  if (SENSITIVE_PATHS.some(path => url.includes(path))) {
    patterns.push('Sensitive API access');
  }
  
  return patterns;
}

function updateBehavioralMetrics(ip: string, path: string) {
  const now = Date.now();
  
  if (!behavioralMetrics.has(ip)) {
    behavioralMetrics.set(ip, {
      ip,
      requestCount: 0,
      burstThreshold: BURST_THRESHOLD,
      lastRequestTime: now,
    });
  }
  
  const metrics = behavioralMetrics.get(ip)!;
  metrics.requestCount++;
  
  // איפוס ספירה אם חלף פרק זמן מספיק
  if (now - metrics.lastRequestTime > TIME_WINDOW_MS) {
    metrics.requestCount = 1;
    metrics.lastRequestTime = now;
  }
  
  // זיהוי burst
  if (metrics.requestCount > metrics.burstThreshold) {
    metrics.burstThreshold = Math.min(metrics.burstThreshold * 1.5, 200);
    return true; // חריגה זוהתה
  }
  
  return false;
}

async function sendToELK(metrics: RequestMetrics) {
  try {
    const { node, index, auth } = ELK_CONFIG;
    
    const response = await fetch(`${node}/${index}/_doc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(auth.username && auth.password && {
          'Authorization': `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`,
        }),
      },
      body: JSON.stringify({
        '@timestamp': new Date(metrics.timestamp).toISOString(),
        ...metrics,
      }),
    });
    
    if (!response.ok) {
      console.error('Failed to send metrics to ELK:', await response.text());
    }
  } catch (error) {
    console.error('ELK connection error:', error);
  }
}

async function sendAlert(metrics: RequestMetrics, severity: 'low' | 'medium' | 'high' | 'critical') {
  // שליחת התראה למערכת התראות חיצונית
  try {
    const alertSystemUrl = process.env.ALERT_SYSTEM_URL;
    if (!alertSystemUrl) return;
    
    await fetch(`${alertSystemUrl}/api/security-alerts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.ALERT_SYSTEM_TOKEN}`,
      },
      body: JSON.stringify({
        timestamp: new Date(metrics.timestamp).toISOString(),
        source: 'saos-dex',
        severity,
        ip: metrics.ip,
        path: metrics.path,
        method: metrics.method,
        suspiciousPatterns: metrics.suspiciousPatterns,
        statusCode: metrics.statusCode,
      }),
    });
  } catch (error) {
    console.error('Failed to send alert:', error);
  }
}

// ── Middleware ראשי ──
export async function middleware(request: NextRequest) {
  const url = request.nextUrl;
  const ip = request.ip || request.headers.get('x-forwarded-for') || 'unknown';
  const userAgent = request.headers.get('user-agent');
  const startTime = Date.now();
  
  // זיהוי דפוסים חשודים
  const suspiciousPatterns = detectSuspiciousPatterns(request);
  
  // עדכון מדדים התנהגותיים
  const isBurst = updateBehavioralMetrics(ip, url.pathname);
  
  // יצירת אובייקט מדדים
  const metrics: RequestMetrics = {
    ip,
    path: url.pathname,
    method: request.method,
    timestamp: startTime,
    userAgent,
    suspiciousPatterns,
  };
  
  // בדיקת הרשאות וזיהוי גישה לא מורשית
  if (url.pathname.startsWith('/api/dex/') && !isAuthenticated(request)) {
    metrics.statusCode = 401;
    
    // שליחה ל-ELK
    await sendToELK({ ...metrics, statusCode: 401 });
    
    // שליחת התראה
    await sendAlert(metrics, 'medium');
    
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  
  // המשך לטיפול הבא
  const response = NextResponse.next();
  
  // טיפול בתגובה
  const originalResponse = response.clone();
  
  // עדכון מדדים עם קוד סטטוס
  response.headers.forEach((value, key) => {
    if (key === 'x-nextjs-response-status') {
      const status = parseInt(value, 10);
      if (status >= 400) {
        metrics.statusCode = status;
        
        // זיהוי חריגות
        if (isBurst || suspiciousPatterns.length > 0) {
          const severity = status >= 500 ? 'high' : 'medium';
          
          // שליחה ל-ELK
          await sendToELK({ ...metrics, statusCode: status });
          
          // שליחת התראה
          await sendAlert(metrics, severity);
        }
      }
    }
  });
  
  // שמירת מדדים
  requestMetrics.push(metrics);
  if (requestMetrics.length > MAX_METRICS) {
    requestMetrics.shift();
  }
  
  // שליחה ל-ELK עבור בקשות חשודות
  if (suspiciousPatterns.length > 0 || isBurst) {
    await sendToELK(metrics);
    
    const severity = suspiciousPatterns.some(p => 
      p.includes('SQL') || p.includes('Path') ? 'high' : 'medium'
    ) ? 'high' : 'medium';
    
    await sendAlert(metrics, severity);
  }
  
  return originalResponse;
}

// ── פונקציית עזר לאימות ──
function isAuthenticated(request: NextRequest): boolean {
  // לוגיקת אימות - להחליף בפועל
  const authHeader = request.headers.get('authorization');
  return authHeader === 'Bearer valid-token'; // לדוגמה בלבד
}

// ── סקריפט לאיסוף מדדים (להפעלה תזומנית) ──
export async function collectMetrics() {
  const metrics = {
    timestamp: Date.now(),
    totalRequests: requestMetrics.length,
    errorRates: {
      '4xx': requestMetrics.filter(m => m.statusCode >= 400 && m.statusCode < 500).length,
      '5xx': requestMetrics.filter(m => m.statusCode >= 500).length,
    },
    suspiciousPatterns: requestMetrics.filter(m => m.suspiciousPatterns && m.suspiciousPatterns.length > 0).length,
    burstActivity: Array.from(behavioralMetrics.values()).filter(m => m.requestCount > BURST_THRESHOLD).length,
  };
  
  // שליחה ל-ELK
  await sendToELK({
    ...metrics,
    ip: 'system',
    path: '/system/metrics',
    method: 'POST',
    statusCode: 200,
  });
  
  // איפוס מדדים תקופתי
  behavioralMetrics.clear();
  requestMetrics.length = 0;
  
  return metrics;
}