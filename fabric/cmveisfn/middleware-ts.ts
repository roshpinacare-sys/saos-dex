import { NextRequest, NextResponse } from 'next/server';

// ── פרופילי משתמש דינמיים וזיהוי חריגות התנהגותי ──
type UserProfile = {
  ip: string;
  firstSeen: number;
  lastSeen: number;
  requestCount: number;
  typicalPaths: Set<string>;
  typicalParams: Map<string, Set<string>>;
  typicalHeaders: Map<string, Set<string>>;
  suspiciousPatterns: {
    repeatedSettle: number;
    repeatedTransfer: number;
    repeatedOrderWithSameNonce: number;
    suspiciousHeaders: number;
    suspiciousParams: number;
  };
  blockedUntil?: number;
  blockLevel: number;
};

const userProfiles = new Map<string, UserProfile>();
const MAX_PROFILES = 10_000;
const BLOCK_LEVELS = [
  { duration: 5 * 60 * 1000, maxRequests: 100 },  // 5 דקות, 100 בקשות
  { duration: 15 * 60 * 1000, maxRequests: 50 },  // 15 דקות, 50 בקשות
  { duration: 60 * 60 * 1000, maxRequests: 10 },  // שעה, 10 בקשות
];

const CRITICAL_ENDPOINTS = ['/api/dex/settle', '/api/dex/transfer', '/api/dex/order'];
const SUSPICIOUS_HEADERS = ['x-forwarded-for', 'x-real-ip', 'via', 'x-proxyclient-ip'];
const MAX_NONONCE_REUSE = 3;

// ── פונקציות עזר ──
function getIp(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0] || 
         req.headers.get('x-real-ip') || 
         'unknown';
}

function isBlocked(profile: UserProfile): boolean {
  return profile.blockedUntil && Date.now() < profile.blockedUntil;
}

function updateProfile(profile: UserProfile, req: NextRequest) {
  const now = Date.now();
  profile.lastSeen = now;
  profile.requestCount++;
  
  // עדכון נתיבים טיפוסיים
  const path = req.nextUrl.pathname;
  profile.typicalPaths.add(path);
  
  // עדכון פרמטרים טיפוסיים
  const params = new URLSearchParams(req.nextUrl.search);
  params.forEach((value, key) => {
    if (!profile.typicalParams.has(key)) {
      profile.typicalParams.set(key, new Set());
    }
    profile.typicalParams.get(key)!.add(value);
  });
  
  // עדכון כותרות טיפוסיות
  SUSPICIOUS_HEADERS.forEach(header => {
    const value = req.headers.get(header);
    if (value) {
      if (!profile.typicalHeaders.has(header)) {
        profile.typicalHeaders.set(header, new Set());
      }
      profile.typicalHeaders.get(header)!.add(value);
    }
  });
}

function detectAnomalies(profile: UserProfile, req: NextRequest): {
  anomaly: string;
  severity: 'low' | 'medium' | 'high';
} | null {
  const path = req.nextUrl.pathname;
  const now = Date.now();
  
  // זיהוי דפוסי תקיפה על נקודות קצה קריטיות
  if (CRITICAL_ENDPOINTS.includes(path)) {
    if (path === '/api/dex/settle') {
      profile.suspiciousPatterns.repeatedSettle++;
      if (profile.suspiciousPatterns.repeatedSettle > 5) {
        return {
          anomaly: 'repeated_settle_requests',
          severity: 'high'
        };
      }
    } else if (path === '/api/dex/transfer') {
      profile.suspiciousPatterns.repeatedTransfer++;
      if (profile.suspiciousPatterns.repeatedTransfer > 5) {
        return {
          anomaly: 'repeated_transfer_requests',
          severity: 'high'
        };
      }
    } else if (path === '/api/dex/order') {
      const nonce = req.nextUrl.searchParams.get('nonce');
      if (nonce) {
        const params = new URLSearchParams(req.nextUrl.search);
        const nonceCount = Array.from(profile.typicalParams.entries())
          .find(([key]) => key === 'nonce')?.[1]?.size || 0;
        
        if (nonceCount > MAX_NONONCE_REUSE) {
          profile.suspiciousPatterns.repeatedOrderWithSameNonce++;
          if (profile.suspiciousPatterns.repeatedOrderWithSameNonce > 3) {
            return {
              anomaly: 'repeated_nonce_usage',
              severity: 'medium'
            };
          }
        }
      }
    }
  }
  
  // זיהוי כותרות חשודות
  let suspiciousHeaders = 0;
  SUSPICIOUS_HEADERS.forEach(header => {
    const value = req.headers.get(header);
    if (value && !profile.typicalHeaders.has(header)) {
      suspiciousHeaders++;
    }
  });
  
  if (suspiciousHeaders > 0) {
    profile.suspiciousPatterns.suspiciousHeaders++;
    if (profile.suspiciousPatterns.suspiciousHeaders > 3) {
      return {
        anomaly: 'suspicious_headers',
        severity: 'medium'
      };
    }
  }
  
  // זיהוי פרמטרים לא טיפוסיים
  let suspiciousParams = 0;
  const params = new URLSearchParams(req.nextUrl.search);
  params.forEach((value, key) => {
    const typicalValues = profile.typicalParams.get(key);
    if (typicalValues && !typicalValues.has(value)) {
      suspiciousParams++;
    }
  });
  
  if (suspiciousParams > 0) {
    profile.suspiciousPatterns.suspiciousParams++;
    if (profile.suspiciousPatterns.suspiciousParams > 3) {
      return {
        anomaly: 'suspicious_parameters',
        severity: 'low'
      };
    }
  }
  
  return null;
}

function applyBlocking(profile: UserProfile): {
  blocked: boolean;
  duration: number;
  reason: string;
} {
  const anomalies = Object.entries(profile.suspiciousPatterns)
    .filter(([_, count]) => count > 0)
    .reduce((sum, [_, count]) => sum + count, 0);
  
  if (anomalies > 10) {
    // חסימה קשה
    const blockConfig = BLOCK_LEVELS[BLOCK_LEVELS.length - 1];
    profile.blockedUntil = Date.now() + blockConfig.duration;
    profile.blockLevel = BLOCK_LEVELS.length;
    return {
      blocked: true,
      duration: blockConfig.duration,
      reason: 'high_anomaly_score'
    };
  } else if (anomalies > 5) {
    // חסימה בינונית
    const blockConfig = BLOCK_LEVELS[1];
    profile.blockedUntil = Date.now() + blockConfig.duration;
    profile.blockLevel = 2;
    return {
      blocked: true,
      duration: blockConfig.duration,
      reason: 'medium_anomaly_score'
    };
  } else if (anomalies > 2) {
    // חסימה קלה
    const blockConfig = BLOCK_LEVELS[0];
    profile.blockedUntil = Date.now() + blockConfig.duration;
    profile.blockLevel = 1;
    return {
      blocked: true,
      duration: blockConfig.duration,
      reason: 'low_anomaly_score'
    };
  }
  
  return {
    blocked: false,
    duration: 0,
    reason: ''
  };
}

function logAnomaly(ip: string, anomaly: string, severity: 'low' | 'medium' | 'high', req: NextRequest) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    ip,
    anomaly,
    severity,
    path: req.nextUrl.pathname,
    method: req.method,
    headers: Object.fromEntries(req.headers.entries()),
    params: Object.fromEntries(new URLSearchParams(req.nextUrl.search).entries()),
    userAgent: req.headers.get('user-agent') || 'unknown'
  };
  
  // ביישום אמיתי, כאן יהיה שימוש במערכת לוגים מרוחקת או ב-SQLite
  console.log('[ANOMALY_DETECTION]', JSON.stringify(logEntry));
}

// ── המידלוור הראשי ──
export async function middleware(req: NextRequest): Promise<NextResponse> {
  const ip = getIp(req);
  
  // קבלת או יצירת פרופיל משתמש
  let profile = userProfiles.get(ip);
  
  if (!profile) {
    // ניקוי פרופילים ישנים אם המפתח מלא
    if (userProfiles.size >= MAX_PROFILES) {
      const oldestIp = Array.from(userProfiles.entries())
        .sort((a, b) => a[1].firstSeen - b[1].firstSeen)[0]?.[0];
      
      if (oldestIp) {
        userProfiles.delete(oldestIp);
      }
    }
    
    profile = {
      ip,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      requestCount: 0,
      typicalPaths: new Set(),
      typicalParams: new Map(),
      typicalHeaders: new Map(),
      suspiciousPatterns: {
        repeatedSettle: 0,
        repeatedTransfer: 0,
        repeatedOrderWithSameNonce: 0,
        suspiciousHeaders: 0,
        suspiciousParams: 0,
      },
      blockLevel: 0
    };
    
    userProfiles.set(ip, profile);
  }
  
  // בדיקת חסימה קיימת
  if (isBlocked(profile)) {
    return new NextResponse('Access temporarily blocked due to suspicious activity', {
      status: 429,
      headers: {
        'X-Block-Reason': 'suspicious_activity',
        'X-Block-Until': new Date(profile.blockedUntil!).toISOString(),
        'X-Block-Level': profile.blockLevel.toString()
      }
    });
  }
  
  // עדכון פרופיל עם הבקשה הנוכחית
  updateProfile(profile, req);
  
  // זיהוי חריגות
  const anomaly = detectAnomalies(profile, req);
  
  if (anomaly) {
    logAnomaly(ip, anomaly.anomaly, anomaly.severity, req);
    
    // החלת חסימה הדרגתית
    const blocking = applyBlocking(profile);
    
    if (blocking.blocked) {
      return new NextResponse('Access temporarily blocked due to suspicious activity', {
        status: 429,
        headers: {
          'X-Block-Reason': blocking.reason,
          'X-Block-Until': new Date(Date.now() + blocking.duration).toISOString(),
          'X-Block-Level': profile.blockLevel.toString()
        }
      });
    }
  }
  
  // המשך לבקשה הרגילה אם לא נמצאו חריגות
  return NextResponse.next();
}

// ── קונפיגורציה של המידלוור ──
export const config = {
  matcher: [
    '/api/dex/:path*',
    '/api/revive/:path*',
    '/:path*'
  ]
};