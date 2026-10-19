import { createHash } from 'node:crypto';

// רמות לוג מוגדרות
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3
}

// סוגי אירועי אבטחה
export enum SecurityEventType {
  AUTH_FAILURE = 'auth_failure',
  UNAUTHORIZED_ACCESS = 'unauthorized_access',
  PERMISSION_CHANGE = 'permission_change',
  SUSPICIOUS_IP = 'suspicious_ip',
  API_VIOLATION = 'api_violation',
  RATE_LIMIT_EXCEEDED = 'rate_limit_exceeded'
}

// מבנה אירוע אבטחה
export interface SecurityEvent {
  id: string;
  timestamp: string;
  eventType: SecurityEventType;
  level: LogLevel;
  userId?: string;
  ip: string;
  userAgent?: string;
  endpoint: string;
  method: string;
  details: Record<string, unknown>;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

// תצורת המערכת
export interface SecurityLoggerConfig {
  enabled: boolean;
  minLevel: LogLevel;
  logToFile: boolean;
  logFilePath: string;
  alertOnCritical: boolean;
  alertEndpoint?: string;
  maxEvents: number;
}

// ברירת מחדל לתצורה
const defaultConfig: SecurityLoggerConfig = {
  enabled: true,
  minLevel: LogLevel.INFO,
  logToFile: true,
  logFilePath: './logs/security-events.log',
  alertOnCritical: true,
  maxEvents: 10000
};

// מחלקת הרישום המרכזית
class SecurityLogger {
  private config: SecurityLoggerConfig;
  private events: SecurityEvent[] = [];
  private fileStream: NodeJS.WritableStream | null = null;

  constructor(config: Partial<SecurityLoggerConfig> = {}) {
    this.config = { ...defaultConfig, ...config };
    this.initializeFileLogging();
  }

  // איניטיאליזציה של רישום לקובץ
  private initializeFileLogging(): void {
    if (this.config.logToFile) {
      const fs = require('node:fs');
      const path = require('node:path');
      
      // ודא שתיקיית הלוגים קיימת
      const logDir = path.dirname(this.config.logFilePath);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      
      // פתח סטרים לכתיבה
      this.fileStream = fs.createWriteStream(this.config.logFilePath, { flags: 'a' });
    }
  }

  // יצירת ID ייחודי לאירוע
  private generateEventId(): string {
    return createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').substring(0, 16);
  }

  // רישום אירוע
  public logEvent(event: Omit<SecurityEvent, 'id' | 'timestamp'>): void {
    if (!this.config.enabled) return;
    
    if (event.level < this.config.minLevel) return;
    
    const fullEvent: SecurityEvent = {
      ...event,
      id: this.generateEventId(),
      timestamp: new Date().toISOString()
    };
    
    // שמור בזיכרון
    this.events.push(fullEvent);
    
    // ודא שלא חורגים מהמגבלה
    if (this.events.length > this.config.maxEvents) {
      this.events = this.events.slice(-this.config.maxEvents);
    }
    
    // רישום לקובץ
    if (this.config.logToFile && this.fileStream) {
      this.fileStream.write(JSON.stringify(fullEvent) + '\n');
    }
    
    // התראה לאירועים קריטיים
    if (event.severity === 'critical' && this.config.alertOnCritical && this.config.alertEndpoint) {
      this.sendAlert(fullEvent);
    }
    
    // הדפסה לקונסולה בפיתוח
    if (process.env.NODE_ENV === 'development') {
      console.log(`[SECURITY EVENT] ${fullEvent.eventType}:`, fullEvent);
    }
  }

  // שליחת התראה למערכת חיצונית
  private async sendAlert(event: SecurityEvent): Promise<void> {
    try {
      const fetch = require('node:fetch');
      
      await fetch(this.config.alertEndpoint!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_type: 'security_alert',
          severity: event.severity,
          event: event
        }),
        signal: AbortSignal.timeout(5000)
      });
    } catch (error) {
      console.error('Failed to send security alert:', error);
    }
  }

  // סינון אירועים לפי קריטריונים
  public filterEvents(options: {
    eventType?: SecurityEventType;
    level?: LogLevel;
    severity?: 'low' | 'medium' | 'high' | 'critical';
    ip?: string;
    userId?: string;
    since?: Date;
    until?: Date;
  }): SecurityEvent[] {
    return this.events.filter(event => {
      if (options.eventType && event.eventType !== options.eventType) return false;
      if (options.level && event.level < options.level) return false;
      if (options.severity && event.severity !== options.severity) return false;
      if (options.ip && event.ip !== options.ip) return false;
      if (options.userId && event.userId !== options.userId) return false;
      if (options.since && new Date(event.timestamp) < options.since) return false;
      if (options.until && new Date(event.timestamp) > options.until) return false;
      return true;
    });
  }

  // קבלת כל האירועים
  public getAllEvents(): SecurityEvent[] {
    return [...this.events];
  }

  // ניקוי זיכרון ישן
  public clear(): void {
    this.events = [];
  }
}

// יצירת אינסטנס גלובלי
const securityLogger = new SecurityLogger();

// פונקציות עזר לרישום אירועים
export const logSecurityEvent = (event: Omit<SecurityEvent, 'id' | 'timestamp'>) => {
  securityLogger.logEvent(event);
};

export const getSecurityEvents = (options?: Parameters<typeof securityLogger.filterEvents>[0]) => {
  return options ? securityLogger.filterEvents(options) : securityLogger.getAllEvents();
};

export const clearSecurityEvents = () => {
  securityLogger.clear();
};

// אינטגרציה עם ה-middleware הקיים
export function integrateWithMiddleware(req: any, res: any, next: any): void {
  // תפוס אירועי שגיאת אימות
  if (res.statusCode === 401 || res.statusCode === 403) {
    logSecurityEvent({
      level: LogLevel.ERROR,
      eventType: SecurityEventType.AUTH_FAILURE,
      ip: req.ip || req.connection.remoteAddress || 'unknown',
      userAgent: req.headers['user-agent'],
      endpoint: req.path,
      method: req.method,
      details: {
        statusCode: res.statusCode,
        message: res.get('X-Error-Message') || 'Authentication failed'
      },
      severity: 'high'
    });
  }
  
  // תפוס גישה ל-APIים רגישים
  const sensitiveEndpoints = ['/api/dex/security', '/api/dex/wallets', '/api/dex/master-key'];
  if (sensitiveEndpoints.includes(req.path)) {
    logSecurityEvent({
      level: LogLevel.INFO,
      eventType: SecurityEventType.UNAUTHORIZED_ACCESS,
      ip: req.ip || req.connection.remoteAddress || 'unknown',
      userAgent: req.headers['user-agent'],
      endpoint: req.path,
      method: req.method,
      details: {
        user: req.user ? req.user.id : 'anonymous',
        headers: req.headers
      },
      severity: 'medium'
    });
  }
  
  next();
}

// אינטגרציה עם מערכת ה-rate-limit
export function logRateLimitExceeded(ip: string, endpoint: string, limit: number): void {
  logSecurityEvent({
    level: LogLevel.WARN,
    eventType: SecurityEventType.RATE_LIMIT_EXCEEDED,
    ip,
    endpoint,
    method: 'N/A',
    details: {
      limit,
      timestamp: new Date().toISOString()
    },
    severity: 'medium'
  });
}

// יצוא המחלקה לשימוש מתקדם
export { SecurityLogger, SecurityLoggerConfig, LogLevel, SecurityEventType };
