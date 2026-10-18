import { NextRequest, NextResponse } from 'next/server';

// סוגים וממשקים
interface FailedAttempt {
  ip: string;
  timestamp: number;
  endpoint: string;
  userAgent?: string;
}

interface AttackPattern {
  name: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  detectionFn: (req: NextRequest) => boolean;
}

// תצורת IDS
const IDS_CONFIG = {
  maxFailedAttempts: 5,
  timeWindow: 15 * 60 * 1000, // 15 דקות
  blockedDuration: 30 * 60 * 1000, // 30 דקות
  suspiciousPatterns: [
    {
      name: 'SQL Injection',
      severity: 'high' as const,
      description: 'ניסיונות הזרקת SQL',
      detectionFn: (req: NextRequest) => {
        const url = req.nextUrl.toString();
        const sqlKeywords = ['union', 'select', 'insert', 'delete', 'update', 'drop', 'script'];
        return sqlKeywords.some(keyword => url.toLowerCase().includes(keyword));
      }
    },
    {
      name: 'XSS',
      severity: 'high' as const,
      description: 'ניסיונות XSS',
      detectionFn: (req: NextRequest) => {
        const url = req.nextUrl.toString();
        const xssPatterns = ['<script', 'javascript:', 'onerror=', 'onload='];
        return xssPatterns.some(pattern => url.toLowerCase().includes(pattern));
      }
    },
    {
      name: 'Brute Force',
      severity: 'medium' as const,
      description: 'ניסיונות כוח גס',
      detectionFn: (req: NextRequest) => {
        const url = req.nextUrl.toString();
        return url.includes('login') || url.includes('auth') || url.includes('password');
      }
    }
  ]
};

// אחסון זיכרוני לניסיונות כושלים (ביישום מציאי יש להחליף ב-Redis או בסיס נתונים)
const failedAttempts = new Map<string, FailedAttempt[]>();
const blockedIPs = new Map<string, number>();

// פונקציות עזר
function getClientIP(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  );
}

function isIPBlocked(ip: string): boolean {
  const unblockTime = blockedIPs.get(ip);
  if (unblockTime && Date.now() < unblockTime) {
    return true;
  }
  blockedIPs.delete(ip);
  return false;
}

function addFailedAttempt(ip: string, req: NextRequest): void {
  const now = Date.now();
  const attempts = failedAttempts.get(ip) || [];
  
  // נקה ניסיונות ישנים מחלון הזמן
  const recentAttempts = attempts.filter(
    attempt => now - attempt.timestamp < IDS_CONFIG.timeWindow
  );
  
  recentAttempts.push({
    ip,
    timestamp: now,
    endpoint: req.nextUrl.pathname,
    userAgent: req.headers.get('user-agent')
  });
  
  failedAttempts.set(ip, recentAttempts);
  
  // בדוק אם יש יותר מדי ניסיונות כושלים
  if (recentAttempts.length >= IDS_CONFIG.maxFailedAttempts) {
    blockIP(ip);
    logSuspiciousActivity(ip, 'Brute Force', 'Multiple failed attempts');
  }
}

function blockIP(ip: string): void {
  const unblockTime = Date.now() + IDS_CONFIG.blockedDuration;
  blockedIPs.set(ip, unblockTime);
  
  // ניקוי ניסיונות כושלים עבור IP זה
  failedAttempts.delete(ip);
}

function detectAttackPatterns(req: NextRequest): AttackPattern | null {
  for (const pattern of IDS_CONFIG.suspiciousPatterns) {
    if (pattern.detectionFn(req)) {
      return pattern;
    }
  }
  return null;
}

function logSuspiciousActivity(ip: string, pattern: string, details: string): void {
  // ביישום מציאי, כאן יש לשלוח למערכת התראות כמו ELK, Splunk, או פלטפורמת ניטור
  console.log(`[IDS] פעילות חשודה זוהתה: IP=${ip}, Pattern=${pattern}, Details=${details}`);
  
  // שליחת התראה בזמן אמת (ביישום מציאי)
  // sendAlertToMonitoringSystem({ ip, pattern, details });
}

// מידלוור IDS
export function idsMiddleware(req: NextRequest): NextResponse | null {
  const ip = getClientIP(req);
  
  // בדוק אם ה-IP חסום
  if (isIPBlocked(ip)) {
    logSuspiciousActivity(ip, 'Access Attempt', 'Attempted access from blocked IP');
    return NextResponse.json(
      { error: 'Access denied. Your IP has been blocked due to suspicious activity.' },
      { status: 403 }
    );
  }
  
  // בדוק דפוסי תקיפה
  const detectedPattern = detectAttackPatterns(req);
  if (detectedPattern) {
    logSuspiciousActivity(ip, detectedPattern.name, `Detected in endpoint: ${req.nextUrl.pathname}`);
    
    // במקרים קריטיים, חסום מיד
    if (detectedPattern.severity === 'critical') {
      blockIP(ip);
      return NextResponse.json(
        { error: 'Access denied. Malicious activity detected.' },
        { status: 403 }
      );
    }
    
    // במקרים אחרים, רשום ואפשר גישה (אבל צופה בקפידה)
    return null;
  }
  
  // רשום בקשות מסוימות לניטור
  if (req.nextUrl.pathname.startsWith('/api/dex/')) {
    // ביישום מציאי, כאן יש לשמור את הבקשה לניתוח
    // logRequest(req);
  }
  
  return null; // המשך ברירת מחדל
}

// נקודת קצה לדוחות שבועיים
export async function GET() {
  // ביישום מציאי, כאן יש לשלוף נתונים מסד הנתונים
  const reportData = {
    timestamp: new Date().toISOString(),
    totalBlockedIPs: blockedIPs.size,
    suspiciousActivities: [], // נתונים מסד הנתונים
    recommendations: []
  };
  
  return NextResponse.json(reportData);
}

// פונקציית עזר להפעלה אוטומטית של מידלוור
export function withIDS(handler: (req: NextRequest) => Promise<NextResponse>) {
  return async (req: NextRequest): Promise<NextResponse> => {
    const idsResult = idsMiddleware(req);
    if (idsResult) return idsResult;
    
    return await handler(req);
  };
}

// פונקציית ניקוי תזמון לניקוי נתונים ישנים
setInterval(() => {
  const now = Date.now();
  
  // נקה IP חסומים שפג תוקפם
  for (const [ip, unblockTime] of blockedIPs.entries()) {
    if (now >= unblockTime) {
      blockedIPs.delete(ip);
    }
  }
  
  // נקה ניסיונות כושלים ישנים
  for (const [ip, attempts] of failedAttempts.entries()) {
    const recentAttempts = attempts.filter(
      attempt => now - attempt.timestamp < IDS_CONFIG.timeWindow
    );
    
    if (recentAttempts.length === 0) {
      failedAttempts.delete(ip);
    } else {
      failedAttempts.set(ip, recentAttempts);
    }
  }
}, 5 * 60 * 1000); // כל 5 דקות