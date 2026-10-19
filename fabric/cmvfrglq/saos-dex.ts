import { NextRequest, NextResponse } from 'next/server';

// ── מודול ניתוח התנהגות מתקדם ───────────────────────────────────────────
interface BehavioralMetrics {
  ip: string;
  requestCount: number;
  lastRequestTime: number;
  sensitivePathHits: number;
  repeatedNonces: Map<string, number>;
  suspiciousHeaders: Map<string, number>;
  blockLevel: number;
  blockStart: number | null;
}

const WINDOW_MS = 60_000;
const REQUEST_THRESHOLD = 150;
const SENSITIVE_PATH_THRESHOLD = 5;
const NONCE_REPEAT_THRESHOLD = 3;
const SUSPICIOUS_HEADER_THRESHOLD = 2;
const BLOCK_DURATION = 300_000; // 5 דקות
const BLOCK_LEVELS = 3;

const sensitivePaths = [
  '/api/dex/settle',
  '/api/dex/transfer',
  '/api/dex/order',
  '/api/dex/cancel',
  '/api/dex/swap',
  '/api/dex/wrap',
  '/api/dex/unwrap'
];

const suspiciousHeaders = [
  'x-forwarded-for',
  'cf-connecting-ip',
  'x-real-ip',
  'via',
  'x-proxy-user'
];

const behavioralMetrics = new Map<string, BehavioralMetrics>();

// ── פונקציות עזר לניתוח התנהגות ────────────────────────────────────────
function updateMetrics(ip: string, request: NextRequest, pathname: string) {
  const now = Date.now();
  let metrics = behavioralMetrics.get(ip);
  
  if (!metrics) {
    metrics = {
      ip,
      requestCount: 0,
      lastRequestTime: now,
      sensitivePathHits: 0,
      repeatedNonces: new Map(),
      suspiciousHeaders: new Map(),
      blockLevel: 0,
      blockStart: null
    };
    behavioralMetrics.set(ip, metrics);
  }
  
  metrics.requestCount++;
  metrics.lastRequestTime = now;
  
  // בדיקת נתיבים רגישים
  if (sensitivePaths.some(path => pathname.includes(path))) {
    metrics.sensitivePathHits++;
  }
  
  // בדיקת nonce חוזר
  const nonce = request.nextUrl.searchParams.get('nonce');
  if (nonce) {
    const count = metrics.repeatedNonces.get(nonce) || 0;
    metrics.repeatedNonces.set(nonce, count + 1);
  }
  
  // בדיקת כותרות חשודות
  suspiciousHeaders.forEach(header => {
    if (request.headers.get(header)) {
      const count = metrics.suspiciousHeaders.get(header) || 0;
      metrics.suspiciousHeaders.set(header, count + 1);
    }
  });
}

function analyzeBehavior(ip: string): { shouldBlock: boolean; reason: string } {
  const metrics = behavioralMetrics.get(ip);
  if (!metrics) return { shouldBlock: false, reason: '' };
  
  // בדיקת חסימה קיימת
  if (metrics.blockLevel > 0 && metrics.blockStart) {
    if (Date.now() - metrics.blockStart < BLOCK_DURATION * metrics.blockLevel) {
      return { shouldBlock: true, reason: 'blocked' };
    } else {
      // סיום תקופת החסימה
      metrics.blockLevel = 0;
      metrics.blockStart = null;
    }
  }
  
  // בדיקת קצב בקשות גבוה
  if (metrics.requestCount > REQUEST_THRESHOLD) {
    return { shouldBlock: true, reason: 'high_request_rate' };
  }
  
  // בדיקת גישה חוזרת לנתיבים רגישים
  if (metrics.sensitivePathHits > SENSITIVE_PATH_THRESHOLD) {
    return { shouldBlock: true, reason: 'sensitive_path_access' };
  }
  
  // בדיקת nonce חוזר
  for (const [nonce, count] of metrics.repeatedNonces) {
    if (count > NONCE_REPEAT_THRESHOLD) {
      return { shouldBlock: true, reason: 'repeated_nonce' };
    }
  }
  
  // בדיקת כותרות חשודות
  for (const [header, count] of metrics.suspiciousHeaders) {
    if (count > SUSPICIOUS_HEADER_THRESHOLD) {
      return { shouldBlock: true, reason: 'suspicious_headers' };
    }
  }
  
  return { shouldBlock: false, reason: '' };
}

function blockIp(ip: string, reason: string) {
  const metrics = behavioralMetrics.get(ip);
  if (metrics) {
    metrics.blockLevel = Math.min(metrics.blockLevel + 1, BLOCK_LEVELS);
    metrics.blockStart = Date.now();
    
    // תיעוד החסימה
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      action: 'behavioral_block',
      ip,
      reason,
      blockLevel: metrics.blockLevel,
      blockDuration: BLOCK_DURATION * metrics.blockLevel
    }));
  }
}

function cleanupOldMetrics() {
  const now = Date.now();
  for (const [ip, metrics] of behavioralMetrics.entries()) {
    if (now - metrics.lastRequestTime > WINDOW_MS * 2) {
      behavioralMetrics.delete(ip);
    }
  }
}

// ── המידלוור הראשי ──────────────────────────────────────────────────────
export async function middleware(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for') || 'unknown';
  const pathname = request.nextUrl.pathname;
  
  // ניקוי מטריצות ישנות
  cleanupOldMetrics();
  
  // עדכון מטריצות ההתנהגות
  updateMetrics(ip, request, pathname);
  
  // ניתוח התנהגות
  const analysis = analyzeBehavior(ip);
  
  if (analysis.shouldBlock) {
    blockIp(ip, analysis.reason);
    return new NextResponse('Access denied due to suspicious behavior', {
      status: 429,
      headers: {
        'Retry-After': BLOCK_DURATION.toString(),
        'X-Reason': analysis.reason
      }
    });
  }
  
  // המשך עם הבקשה הרגילה
  return NextResponse.next();
}

// ── הגדרת נתיבים ───────────────────────────────────────────────────────
export const config = {
  matcher: [
    '/api/dex/:path*',
    '/api/revive/:path*'
  ]
};