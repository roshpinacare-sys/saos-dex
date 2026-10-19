import { NextRequest, NextResponse } from 'next/server';

/**
 * AnomalyDetector — מנגנון ניטור וזיהוי חריגות בזמן-אמת
 * תומך בניתוח קצב בקשות, זיהוי דפוסי תקיפה, בניית פרופילי התנהגות ותגובה דינמית
 */
class AnomalyDetector {
  private ipProfiles = new Map<string, {
    requestCount: number;
    lastRequest: number;
    suspiciousPaths: Set<string>;
    suspiciousParams: Map<string, number>;
    repeatedNonces: Set<string>;
    blockedUntil?: number;
  }>();
  private anomalyLog: Array<{
    timestamp: number;
    ip: string;
    path: string;
    params: Record<string, string>;
    anomalyType: string;
    actionTaken: string;
  }> = [];
  private readonly BLOCK_DURATION = 60 * 60 * 1000; // 1 hour
  private readonly MAX_REQUESTS_PER_MINUTE = 240;
  private readonly MAX_INTERNAL_REQUESTS_PER_MINUTE = 2000;
  private readonly SUSPICIOUS_PATHS = [
    '/api/dex/settle',
    '/api/dex/transfer',
    '/api/dex/order',
    '/api/dex/cancel',
    '/api/dex/swap'
  ];

  /**
   * בדיקת חריגות לפני עיבוד בקשה
   */
  public checkRequest(req: NextRequest, isInternal: boolean): {
    allowed: boolean;
    reason?: string;
    logData?: {
      anomalyType: string;
      severity: 'low' | 'medium' | 'high' | 'critical';
    };
  } {
    const ip = this.getClientIp(req);
    const path = req.nextUrl.pathname;
    const now = Date.now();
    
    // בדיקת חסימה קיימת
    if (this.ipProfiles.get(ip)?.blockedUntil && now < this.ipProfiles.get(ip)!.blockedUntil!) {
      this.logAnomaly(ip, path, {}, 'BLOCKED_IP', 'BLOCKED_IP');
      return {
        allowed: false,
        reason: 'IP temporarily blocked due to suspicious activity',
        logData: { anomalyType: 'BLOCKED_IP', severity: 'high' }
      };
    }

    // קבלת פרופיל IP או יצירת חדש
    let profile = this.ipProfiles.get(ip);
    if (!profile) {
      profile = {
        requestCount: 0,
        lastRequest: now,
        suspiciousPaths: new Set(),
        suspiciousParams: new Map(),
        repeatedNonces: new Set()
      };
      this.ipProfiles.set(ip, profile);
    }

    // עדכון ספירת בקשות
    profile.requestCount++;
    profile.lastRequest = now;

    // בדיקת קצב בקשות
    const rateLimit = isInternal ? this.MAX_INTERNAL_REQUESTS_PER_MINUTE : this.MAX_REQUESTS_PER_MINUTE;
    if (profile.requestCount > rateLimit) {
      this.blockIp(ip, 'RATE_LIMIT_EXCEEDED');
      this.logAnomaly(ip, path, {}, 'RATE_LIMIT_EXCEEDED', 'BLOCKED_IP');
      return {
        allowed: false,
        reason: 'Rate limit exceeded',
        logData: { anomalyType: 'RATE_LIMIT_EXCEEDED', severity: 'medium' }
      };
    }

    // בדיקת נתיבים חשודים
    if (this.SUSPICIOUS_PATHS.includes(path)) {
      profile.suspiciousPaths.add(path);
      
      // אם גישה חוזרת לנתיב חשוד
      if (profile.suspiciousPaths.size > 3) {
        this.logAnomaly(ip, path, {}, 'SUSPICIOUS_PATH_ACCESS', 'LOGGED');
        return {
          allowed: true,
          logData: { anomalyType: 'SUSPICIOUS_PATH_ACCESS', severity: 'medium' }
        };
      }
    }

    // בדיקת פרמטרים חשודים
    const params = Object.fromEntries(req.nextUrl.searchParams.entries());
    const suspiciousParams = this.detectSuspiciousParams(params);
    if (suspiciousParams.length > 0) {
      suspiciousParams.forEach(param => {
        const count = profile!.suspiciousParams.get(param) || 0;
        profile!.suspiciousParams.set(param, count + 1);
      });
      
      this.logAnomaly(ip, path, params, 'SUSPICIOUS_PARAMS', 'LOGGED');
      return {
        allowed: true,
        logData: { anomalyType: 'SUSPICIOUS_PARAMS', severity: 'low' }
      };
    }

    // בדיקת nonce חוזר
    const nonce = params.nonce;
    if (nonce && profile.repeatedNonces.has(nonce)) {
      this.logAnomaly(ip, path, params, 'REPEATED_NONCE', 'LOGGED');
      return {
        allowed: true,
        logData: { anomalyType: 'REPEATED_NONCE', severity: 'medium' }
      };
    }
    
    if (nonce) {
      profile.repeatedNonces.add(nonce);
    }

    return { allowed: true };
  }

  /**
   * זיהוי פרמטרים חשודים בבקשה
   */
  private detectSuspiciousParams(params: Record<string, string>): string[] {
    const suspicious: string[] = [];
    
    // בדיקת פרמטרים ריקים או חסרי טעם
    Object.entries(params).forEach(([key, value]) => {
      if (!value || value.length === 0 || value === 'undefined' || value === 'null') {
        suspicious.push(key);
      }
      
      // בדיקת פרמטרים עם תווים מוזרים
      if (/[<>{}\[\]\'"`]/.test(value)) {
        suspicious.push(key);
      }
      
      // בדיקת פרמטרים ארוכים מדי
      if (value.length > 1000) {
        suspicious.push(key);
      }
    });
    
    return suspicious;
  }

  /**
   * חסימת IP חשוד
   */
  private blockIp(ip: string, reason: string): void {
    const profile = this.ipProfiles.get(ip);
    if (profile) {
      profile.blockedUntil = Date.now() + this.BLOCK_DURATION;
      this.logAnomaly(ip, '', {}, 'IP_BLOCKED', `BLOCKED_${reason}`);
    }
  }

  /**
   * רישום חריגה
   */
  private logAnomaly(ip: string, path: string, params: Record<string, string>, anomalyType: string, actionTaken: string): void {
    const logEntry = {
      timestamp: Date.now(),
      ip,
      path,
      params,
      anomalyType,
      actionTaken
    };
    
    this.anomalyLog.push(logEntry);
    
    // שמירת הלוג באורך מוגבל (1000 רשומות)
    if (this.anomalyLog.length > 1000) {
      this.anomalyLog = this.anomalyLog.slice(-1000);
    }
    
    // הדפסת הרשומה ללוג (בסביבת פיתוח)
    if (process.env.NODE_ENV === 'development') {
      console.log('[ANOMALY_DETECTOR]', JSON.stringify(logEntry));
    }
    
    // שליחת התראה למערכת רישום מרכזית אם מוגדרת
    this.sendAlertToCentralSystem(logEntry);
  }

  /**
   * שליחת התראה למערכת רישום מרכזית
   */
  private async sendAlertToCentralSystem(logEntry: any): Promise<void> {
    const centralSystemUrl = process.env.CENTRAL_ALERT_SYSTEM_URL;
    if (!centralSystemUrl) return;
    
    try {
      await fetch(`${centralSystemUrl}/api/security-alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service: 'saos-dex',
          timestamp: logEntry.timestamp,
          anomaly: logEntry
        })
      });
    } catch (error) {
      console.error('Failed to send alert to central system:', error);
    }
  }

  /**
   * קבלת IP של הלקוח
   */
  private getClientIp(req: NextRequest): string {
    return (
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      req.headers.get('x-real-ip') ||
      req.ip ||
      'unknown'
    );
  }

  /**
   * קבלת דוח חריגות
   */
  public getAnomalyReport(): any[] {
    return [...this.anomalyLog];
  }

  /**
   * ניקוי פרופילים ישנים
   */
  public cleanup(): void {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    
    // ניקוי פרופילים שלא קיבלו בקשות במשך שעה
    this.ipProfiles.forEach((profile, ip) => {
      if (profile.lastRequest < oneHourAgo) {
        this.ipProfiles.delete(ip);
      }
    });
    
    // ניקוי חריגות ישנות (יותר מ-24 שעות)
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    this.anomalyLog = this.anomalyLog.filter(entry => entry.timestamp > oneDayAgo);
  }
}

// יצירת מופע גלובלי של המגלה
const anomalyDetector = new AnomalyDetector();

// פונקציית עזר לבדיקת בקשות פנימיות
function isInternalRequest(req: NextRequest): boolean {
  const forwardedFor = req.headers.get('x-forwarded-for');
  return !forwardedFor || forwardedFor === '127.0.0.1';
}

// הטמעת המידלוור
export function middleware(req: NextRequest): NextResponse {
  // פטורים מניטור
  const exemptPaths = ['/api/dex/stream', '/api/revive'];
  if (exemptPaths.some(path => req.nextUrl.pathname.startsWith(path))) {
    return NextResponse.next();
  }

  // בדיקת חריגות
  const isInternal = isInternalRequest(req);
  const checkResult = anomalyDetector.checkRequest(req, isInternal);

  // אם נמצאה חריגה והבקשה נחסמה
  if (!checkResult.allowed) {
    return new NextResponse(JSON.stringify({ 
      error: checkResult.reason,
      timestamp: new Date().toISOString()
    }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // המשך לבקשה הרגילה
  const response = NextResponse.next();

  // הוספת כותרת עם מידע על הניטור
  response.headers.set('X-Anomaly-Check', 'completed');
  
  // בדיקת חריגות נוספות לאחר אימות (אם קיים)
  if (req.headers.get('x-authenticated') === 'true') {
    // ניתוח נוסף עבור בקשות מאומתות
    const authResult = anomalyDetector.checkRequest(req, isInternal);
    if (authResult.logData) {
      response.headers.set('X-Auth-Anomaly', authResult.logData.anomalyType);
    }
  }

  // בדיקת חריגות לפני ביצוע פעולות קריטיות
  const criticalPaths = ['/api/dex/transfer', '/api/dex/settle', '/api/dex/order'];
  if (criticalPaths.some(path => req.nextUrl.pathname.startsWith(path))) {
    const criticalResult = anomalyDetector.checkRequest(req, isInternal);
    if (criticalResult.logData) {
      response.headers.set('X-Critical-Operation-Anomaly', criticalResult.logData.anomalyType);
    }
  }

  return response;
}

// פונקציית ניקוי תזמון
setInterval(() => {
  anomalyDetector.cleanup();
}, 60 * 60 * 1000); // כל שעה

// ייצוא פונקציית הדו"ח לצורך בדיקות (למשל בסביבת פיתוח)
if (process.env.NODE_ENV === 'development') {
  (global as any).getAnomalyReport = () => anomalyDetector.getAnomalyReport();
}