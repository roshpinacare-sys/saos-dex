import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

type AccessAttempt = {
  id: string;
  timestamp: Date;
  ip: string;
  userAgent: string;
  endpoint: string;
  method: string;
  statusCode: number;
  isAllowed: boolean;
  userId?: string;
  reason?: string;
};

type AccessPattern = {
  ip: string;
  endpoint: string;
  attemptCount: number;
  lastAttempt: Date;
  isSuspicious: boolean;
};

/**
 * רכיב ניטור גישה למשאבים מוגנים
 * רושם ניסיונות גישה, מזהה דפוסים חריגים ומפעיל התראות
 */
export class AccessMonitor {
  private static instance: AccessMonitor;
  private recentAttempts = new Map<string, AccessAttempt[]>();
  private suspiciousPatterns = new Map<string, AccessPattern>();
  private readonly MAX_ATTEMPTS_PER_IP_PER_MINUTE = 50;
  private readonly SUSPICIOUS_ENDPOINTS = [
    '/api/dex/agent',
    '/api/dex/order',
    '/api/dex/portfolio',
    '/api/dex/security'
  ];

  private constructor() {}

  public static getInstance(): AccessMonitor {
    if (!AccessMonitor.instance) {
      AccessMonitor.instance = new AccessMonitor();
    }
    return AccessMonitor.instance;
  }

  /**
   * רישום ניסיון גישה
   */
  public async logAccessAttempt(
    req: NextRequest,
    statusCode: number,
    isAllowed: boolean,
    reason?: string,
    userId?: string
  ): Promise<void> {
    const attempt: AccessAttempt = {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      ip: this.getClientIp(req),
      userAgent: req.headers.get('user-agent') || 'unknown',
      endpoint: req.nextUrl.pathname,
      method: req.method,
      statusCode,
      isAllowed,
      userId,
      reason
    };

    // שמירה בזיכרון לזמן קצר (לניתור ריאל-טיים)
    const ipKey = this.getClientIp(req);
    if (!this.recentAttempts.has(ipKey)) {
      this.recentAttempts.set(ipKey, []);
    }
    this.recentAttempts.get(ipKey)!.push(attempt);

    // ניקוי ניסיונות ישנים (מעל דקה)
    this.cleanupOldAttempts();

    // שמירה במסד נתונים לטווח ארוך
    try {
      await db.accessAttempt.create({
        data: {
          id: attempt.id,
          timestamp: attempt.timestamp,
          ip: attempt.ip,
          userAgent: attempt.userAgent,
          endpoint: attempt.endpoint,
          method: attempt.method,
          statusCode: attempt.statusCode,
          isAllowed: attempt.isAllowed,
          userId: attempt.userId,
          reason: attempt.reason
        }
      });
    } catch (error) {
      console.error('Failed to log access attempt:', error);
    }

    // בדיקת דפוסים חשודים
    this.checkForSuspiciousPatterns(attempt);

    // התראה במקרה של ניסיון חדירה
    if (!isAllowed && this.isHighRiskEndpoint(attempt.endpoint)) {
      this.triggerAlert(attempt);
    }
  }

  /**
   * קבלת IP של הלקוח
   */
  private getClientIp(req: NextRequest): string {
    const xff = req.headers.get('x-forwarded-for');
    if (xff) {
      const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length > 0) return parts[parts.length - 1] ?? 'proxied';
      return 'proxied';
    }
    return req.headers.get('x-real-ip') ?? 'local';
  }

  /**
   * ניקוי ניסיונות ישנים מהזיכרון
   */
  private cleanupOldAttempts(): void {
    const now = Date.now();
    const ONE_MINUTE = 60 * 1000;

    for (const [ip, attempts] of this.recentAttempts.entries()) {
      const recent = attempts.filter(
        attempt => now - attempt.timestamp.getTime() < ONE_MINUTE
      );
      
      if (recent.length === 0) {
        this.recentAttempts.delete(ip);
      } else {
        this.recentAttempts.set(ip, recent);
      }
    }
  }

  /**
   * בדיקת דפוסי גישה חשודים
   */
  private checkForSuspiciousPatterns(attempt: AccessAttempt): void {
    const ipKey = attempt.ip;
    const endpointKey = `${ipKey}:${attempt.endpoint}`;
    
    // קביעת האם ה-endpoint נחשב רגיש
    const isSensitiveEndpoint = this.isHighRiskEndpoint(attempt.endpoint);
    
    // חישוב כמות הניסיונות מה-IP הזה ל-endpoint הזה
    const attemptCount = this.recentAttempts.get(ipKey)?.filter(
      a => a.endpoint === attempt.endpoint && a.timestamp.getTime() > Date.now() - 60000
    ).length || 0;
    
    // זיהוי דפוס חשוד
    const isSuspicious = 
      isSensitiveEndpoint && attemptCount > this.MAX_ATTEMPTS_PER_IP_PER_MINUTE ||
      !attempt.isAllowed && attemptCount > 5;
    
    if (isSuspicious) {
      const pattern: AccessPattern = {
        ip: ipKey,
        endpoint: attempt.endpoint,
        attemptCount,
        lastAttempt: attempt.timestamp,
        isSuspicious: true
      };
      
      this.suspiciousPatterns.set(endpointKey, pattern);
      
      // התראה על דפוס חשוד
      this.triggerPatternAlert(pattern);
    }
  }

  /**
   * האם ה-endpoint נחשב רגיש
   */
  private isHighRiskEndpoint(endpoint: string): boolean {
    return this.SUSPICIOUS_ENDPOINTS.some(sensitive => 
      endpoint.includes(sensitive)
    );
  }

  /**
   * הפעלת התראה על ניסיון חדירה
   */
  private triggerAlert(attempt: AccessAttempt): void {
    console.warn(`🚨 SECURITY ALERT: Unauthorized access attempt`, {
      ip: attempt.ip,
      endpoint: attempt.endpoint,
      method: attempt.method,
      statusCode: attempt.statusCode,
      timestamp: attempt.timestamp,
      userAgent: attempt.userAgent,
      reason: attempt.reason
    });
    
    // כאן ניתן להוסיף שליחת התראה למערכת חיצונית
    // או לשלוח הודעה למנהלי המערכת
  }

  /**
   * הפעלת התראה על דפוס חשוד
   */
  private triggerPatternAlert(pattern: AccessPattern): void {
    console.warn(`🚨 SUSPICIOUS PATTERN DETECTED:`, {
      ip: pattern.ip,
      endpoint: pattern.endpoint,
      attemptCount: pattern.attemptCount,
      lastAttempt: pattern.lastAttempt
    });
    
    // כאן ניתן להוסיף שליחת התראה למערכת חיצונית
    // או לשלוח הודעה למנהלי המערכת
  }

  /**
   * קבלת דוח ניטור
   */
  public async generateReport(
    startDate: Date,
    endDate: Date,
    ip?: string,
    endpoint?: string
  ): Promise<any> {
    try {
      const where: any = {
        timestamp: {
          gte: startDate,
          lte: endDate
        }
      };
      
      if (ip) where.ip = ip;
      if (endpoint) where.endpoint = endpoint;
      
      const attempts = await db.accessAttempt.findMany({
        where,
        orderBy: { timestamp: 'desc' }
      });
      
      // ניתוח נתונים
      const totalAttempts = attempts.length;
      const allowedAttempts = attempts.filter(a => a.isAllowed).length;
      const blockedAttempts = totalAttempts - allowedAttempts;
      
      // זיהוי IPs פעילים
      const ipCounts = new Map<string, number>();
      attempts.forEach(attempt => {
        const count = ipCounts.get(attempt.ip) || 0;
        ipCounts.set(attempt.ip, count + 1);
      });
      
      const topIps = Array.from(ipCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
      
      // זיהוי endpoints פעילים
      const endpointCounts = new Map<string, number>();
      attempts.forEach(attempt => {
        const count = endpointCounts.get(attempt.endpoint) || 0;
        endpointCounts.set(attempt.endpoint, count + 1);
      });
      
      const topEndpoints = Array.from(endpointCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
      
      return {
        period: { start: startDate, end: endDate },
        summary: {
          totalAttempts,
          allowedAttempts,
          blockedAttempts,
          successRate: (allowedAttempts / totalAttempts) * 100
        },
        topIps,
        topEndpoints,
        suspiciousPatterns: Array.from(this.suspiciousPatterns.values())
      };
    } catch (error) {
      console.error('Failed to generate access report:', error);
      throw new Error('Failed to generate access report');
    }
  }
}

/**
 * פונקציית עזר לאינטגרציה עם middleware.ts
 */
export async function monitorAccess(
  req: NextRequest,
  statusCode: number,
  isAllowed: boolean,
  reason?: string,
  userId?: string
): Promise<void> {
  const monitor = AccessMonitor.getInstance();
  await monitor.logAccessAttempt(req, statusCode, isAllowed, reason, userId);
}
