import { NextRequest, NextResponse } from 'next/server';

// ── סיווג נקודות קצה לפי רגישות ──────────────────────────────────────────
const SENSITIVE_ENDPOINTS = new Set([
  '/api/dex/settle',
  '/api/dex/transfer',
  '/api/dex/order',
  '/api/dex/cancel',
  '/api/dex/swap',
  '/api/dex/wallets',
  '/api/dex/portfolio',
]);

// ── תצורת חסימה הדרגתית ────────────────────────────────────────────────
const BLOCK_CONFIG = {
  LOW: { windowMs: 60_000, maxRequests: 100 },
  MEDIUM: { windowMs: 60_000, maxRequests: 50 },
  HIGH: { windowMs: 60_000, maxRequests: 10 },
};

// ── מחלקת ניהול פרופיל משתמש ─────────────────────────────────────────────
class UserProfile {
  ip: string;
  endpointCounts: Map<string, number>;
  requestTimes: number[];
  lastActivity: number;
  riskScore: number;
  blockedLevel: keyof typeof BLOCK_CONFIG | null;
  blockedUntil: number | null;
  
  constructor(ip: string) {
    this.ip = ip;
    this.endpointCounts = new Map();
    this.requestTimes = [];
    this.lastActivity = Date.now();
    this.riskScore = 0;
    this.blockedLevel = null;
    this.blockedUntil = null;
  }
  
  recordRequest(endpoint: string) {
    this.lastActivity = Date.now();
    
    // עדכון ספירת בקשות לנקודת קצה
    const currentCount = this.endpointCounts.get(endpoint) || 0;
    this.endpointCounts.set(endpoint, currentCount + 1);
    
    // הוספת חותמת זמן לבקשה
    this.requestTimes.push(Date.now());
    
    // חישוב סיכון זמני
    this.calculateRisk();
  }
  
  calculateRisk() {
    const now = Date.now();
    const oneMinuteAgo = now - 60_000;
    
    // ספירת בקשות בדקה האחרונה
    const recentRequests = this.requestTimes.filter(time => time > oneMinuteAgo).length;
    
    // חישוב סיכון זמני
    let risk = 0;
    
    // ניקוד לפי קצב בקשות
    if (recentRequests > 100) risk += 30;
    else if (recentRequests > 50) risk += 20;
    else if (recentRequests > 20) risk += 10;
    
    // ניקוד לפי גישה לנקודות רגישות
    for (const [endpoint, count] of this.endpointCounts) {
      if (SENSITIVE_ENDPOINTS.has(endpoint) && count > 5) {
        risk += 15;
      }
    }
    
    // ניקוד לפי דפוס בקשות מהירות
    if (recentRequests > 80) {
      risk += 25;
    }
    
    // עדכון סך הסיכון
    this.riskScore = Math.min(100, risk);
  }
  
  shouldBlock(): keyof typeof BLOCK_CONFIG | null {
    if (this.blockedUntil && Date.now() < this.blockedUntil) {
      return this.blockedLevel;
    }
    
    if (this.riskScore > 80) return 'HIGH';
    if (this.riskScore > 50) return 'MEDIUM';
    if (this.riskScore > 20) return 'LOW';
    return null;
  }
  
  applyBlock(level: keyof typeof BLOCK_CONFIG) {
    this.blockedLevel = level;
    this.blockedUntil = Date.now() + BLOCK_CONFIG[level].windowMs;
    
    // רישום חסימה
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      action: 'user_blocked',
      ip: this.ip,
      level,
      riskScore: this.riskScore,
      reason: 'behavioral_anomaly_detection',
    }));
  }
}

// ── מחלקת מנהל פרופילים ────────────────────────────────────────────────
class ProfileManager {
  private profiles: Map<string, UserProfile> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;
  
  constructor() {
    // ניקוי פרופילים לא פעילים כל 5 דקות
    this.cleanupInterval = setInterval(() => this.cleanupInactiveProfiles(), 5 * 60 * 1000);
  }
  
  getProfile(ip: string): UserProfile {
    if (!this.profiles.has(ip)) {
      this.profiles.set(ip, new UserProfile(ip));
    }
    return this.profiles.get(ip)!;
  }
  
  cleanupInactiveProfiles() {
    const now = Date.now();
    const inactiveThreshold = 30 * 60 * 1000; // 30 דקות
    
    for (const [ip, profile] of this.profiles) {
      if (now - profile.lastActivity > inactiveThreshold) {
        this.profiles.delete(ip);
      }
    }
  }
}

const profileManager = new ProfileManager();

// ── פונקציית עזר לניתוח דפוס בקשות ─────────────────────────────────────────
function analyzeRequestPattern(request: NextRequest): {
  endpoint: string;
  method: string;
  headers: Record<string, string>;
  userAgent: string;
} {
  return {
    endpoint: request.nextUrl.pathname,
    method: request.method,
    headers: Object.fromEntries(request.headers.entries()),
    userAgent: request.headers.get('user-agent') || 'unknown',
  };
}

// ── פונקציית רישום חריגות ──────────────────────────────────────────────
function logAnomaly(
  ip: string,
  anomalyType: string,
  details: Record<string, unknown>,
  severity: 'low' | 'medium' | 'high'
) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    action: 'anomaly_detected',
    ip,
    anomalyType,
    severity,
    details,
  }));
}

// ── המידלוור הראשי ───────────────────────────────────────────────────────
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const ip = request.ip || 'unknown';
  const profile = profileManager.getProfile(ip);
  
  // רישום בקשה בפרופיל
  profile.recordRequest(request.nextUrl.pathname);
  
  // בדיקת חסימה קיימת
  const blockLevel = profile.shouldBlock();
  if (blockLevel) {
    const blockConfig = BLOCK_CONFIG[blockLevel];
    
    // רישום החריגה
    logAnomaly(
      ip,
      'blocked_request',
      {
        endpoint: request.nextUrl.pathname,
        method: request.method,
        blockedLevel: blockLevel,
        riskScore: profile.riskScore,
      },
      blockLevel === 'HIGH' ? 'high' : blockLevel === 'MEDIUM' ? 'medium' : 'low'
    );
    
    return new NextResponse(
      JSON.stringify({
        error: 'Access temporarily restricted',
        message: `Your access has been temporarily restricted due to unusual activity.`,
        retryAfter: blockConfig.windowMs / 1000,
        blockedLevel: blockLevel,
      }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': blockConfig.windowMs.toString(),
        },
      }
    );
  }
  
  // ניתוח דפוס בקשות
  const requestPattern = analyzeRequestPattern(request);
  
  // בדיקת חריגות ספציפיות
  const anomalies: Array<{ type: string; severity: 'low' | 'medium' | 'high' }> = [];
  
  // בדיקת קצב בקשות גבוה
  const now = Date.now();
  const recentRequests = profile.requestTimes.filter(time => time > now - 60_000).length;
  if (recentRequests > 100) {
    anomalies.push({ type: 'high_request_rate', severity: 'high' });
  } else if (recentRequests > 50) {
    anomalies.push({ type: 'medium_request_rate', severity: 'medium' });
  }
  
  // בדיקת גישה לנקודות רגישות
  if (SENSITIVE_ENDPOINTS.has(requestPattern.endpoint)) {
    const endpointCount = profile.endpointCounts.get(requestPattern.endpoint) || 0;
    if (endpointCount > 10) {
      anomalies.push({ type: 'sensitive_endpoint_access', severity: 'medium' });
    }
  }
  
  // בדיקת דפוסי בקשות חוזרות
  const userAgent = requestPattern.userAgent;
  if (/bot\b|\bscraper\b/i.test(userAgent)) {
    anomalies.push({ type: 'bot_like_user_agent', severity: 'medium' });
  }
  
  // טיפול בחריגות מזוהות
  for (const anomaly of anomalies) {
    // עדכון סיכון
    profile.riskScore += anomaly.severity === 'high' ? 20 : anomaly.severity === 'medium' ? 10 : 5;
    profile.riskScore = Math.min(100, profile.riskScore);
    
    // רישום החריגה
    logAnomaly(
      ip,
      anomaly.type,
      {
        endpoint: requestPattern.endpoint,
        method: requestPattern.method,
        userAgent: userAgent,
      },
      anomaly.severity
    );
    
    // החלת חסימה אם הסיכון גבוה מספיק
    if (profile.riskScore > 70) {
      profile.applyBlock('HIGH');
      return new NextResponse(
        JSON.stringify({
          error: 'Access temporarily restricted',
          message: `Your access has been temporarily restricted due to unusual activity.`,
          retryAfter: BLOCK_CONFIG.HIGH.windowMs / 1000,
          blockedLevel: 'HIGH',
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': BLOCK_CONFIG.HIGH.windowMs.toString(),
          },
        }
      );
    }
  }
  
  // אם אין חסימה, המשך עם הבקשה הרגילה
  return NextResponse.next();
}
