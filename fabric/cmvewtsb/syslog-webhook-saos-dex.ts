import { createHash } from 'node:crypto';

// טיפוסים עבור אירועי אבטחה
type SecurityEventType = 'AUTH_FAILURE' | 'RATE_LIMIT_EXCEEDED' | 'SUSPICIOUS_ACTIVITY' | 'VIOLATION_DETECTED';

interface SecurityEvent {
  id: string;
  timestamp: string;
  type: SecurityEventType;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  source: string;
  details: Record<string, unknown>;
  userId?: string;
  ip?: string;
  userAgent?: string;
}

interface SyslogConfig {
  enabled: boolean;
  host: string;
  port: number;
  facility: number;
  protocol: 'tcp' | 'udp';
}

interface WebhookConfig {
  enabled: boolean;
  url: string;
  timeout: number;
  retries: number;
}

interface SecurityLoggerConfig {
  syslog: SyslogConfig;
  webhook: WebhookConfig;
}

// קונפיגורציה ברירת מחדל מתוך .env
const DEFAULT_CONFIG: SecurityLoggerConfig = {
  syslog: {
    enabled: process.env.SECURITY_LOGGER_SYSLOG_ENABLED === 'true',
    host: process.env.SECURITY_LOGGER_SYSLOG_HOST || 'localhost',
    port: parseInt(process.env.SECURITY_LOGGER_SYSLOG_PORT || '514', 10),
    facility: parseInt(process.env.SECURITY_LOGGER_SYSLOG_FACILITY || '16', 10),
    protocol: (process.env.SECURITY_LOGGER_SYSLOG_PROTOCOL as 'tcp' | 'udp') || 'udp'
  },
  webhook: {
    enabled: process.env.SECURITY_LOGGER_WEBHOOK_ENABLED === 'true',
    url: process.env.SECURITY_LOGGER_WEBHOOK_URL || '',
    timeout: parseInt(process.env.SECURITY_LOGGER_WEBHOOK_TIMEOUT || '5000', 10),
    retries: parseInt(process.env.SECURITY_LOGGER_WEBHOOK_RETRIES || '3', 10)
  }
};

export class SecurityEventLogger {
  private config: SecurityLoggerConfig;
  private eventQueue: SecurityEvent[] = [];
  private processing = false;

  constructor(config: SecurityLoggerConfig = DEFAULT_CONFIG) {
    this.config = config;
    // התחל עיבוד אסינכרוני של התור
    this.processQueue();
  }

  // יצירת אירוע אבטחה חדש
  public logEvent(event: Omit<SecurityEvent, 'id' | 'timestamp'>): void {
    const securityEvent: SecurityEvent = {
      ...event,
      id: this.generateEventId(),
      timestamp: new Date().toISOString()
    };

    // הוסף לתור לעיבוד אסינכרוני
    this.eventQueue.push(securityEvent);
    
    // עיבוד מיידי אם התור ריק
    if (!this.processing) {
      this.processQueue();
    }
  }

  // עיבוד אסינכרוני של התור
  private async processQueue(): Promise<void> {
    if (this.processing || this.eventQueue.length === 0) {
      this.processing = false;
      return;
    }

    this.processing = true;
    
    // עיבוד באצווה לשיפור ביצועים
    const batch = [...this.eventQueue];
    this.eventQueue = [];

    try {
      // עיבוד Syslog
      if (this.config.syslog.enabled) {
        await this.sendToSyslog(batch);
      }

      // עיבוד Webhook
      if (this.config.webhook.enabled) {
        await this.sendToWebhook(batch);
      }
    } catch (error) {
      console.error('SecurityEventLogger processing error:', error);
      // במקרה של כשל, נוסיף חזרה לתור
      this.eventQueue.unshift(...batch);
    } finally {
      this.processing = false;
      
      // בדוק אם יש עוד אירועים לעיבוד
      if (this.eventQueue.length > 0) {
        setImmediate(() => this.processQueue());
      }
    }
  }

  // שליחה ל-Syslog
  private async sendToSyslog(events: SecurityEvent[]): Promise<void> {
    const { host, port, facility, protocol } = this.config.syslog;
    
    // ייבוא דינמי כדי לא לטעון את המודול אם לא מופעל
    const { Syslog } = await import('syslog-client');
    
    const client = new Syslog({
      host,
      port,
      facility,
      protocol
    });

    try {
      for (const event of events) {
        const syslogMessage = this.formatForSyslog(event);
        await client.log(syslogMessage, event.severity);
      }
    } finally {
      client.close();
    }
  }

  // שליחה ל-Webhook
  private async sendToWebhook(events: SecurityEvent[]): Promise<void> {
    const { url, timeout, retries } = this.config.webhook;
    
    // ייבוא דינמי כדי לא לטעון את המודול אם לא מופעל
    const { default: fetch } = await import('node-fetch');

    const payload = JSON.stringify({
      timestamp: new Date().toISOString(),
      events
    });

    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt < retries) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Security-Event-ID': this.generateEventId(),
            'X-Security-Event-Timestamp': new Date().toISOString()
          },
          body: payload,
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`Webhook responded with status ${response.status}`);
        }

        return; // הצליח
      } catch (error) {
        lastError = error as Error;
        attempt++;
        
        // המתנה מעריכית בין ניסיונות
        await new Promise(resolve => 
          setTimeout(resolve, Math.pow(2, attempt) * 1000)
        );
      }
    }

    throw lastError || new Error('Unknown webhook error');
  }

  // עיצוב האירוע לפורמט Syslog
  private formatForSyslog(event: SecurityEvent): string> {
    // RFC 3164/5424 עיצוב
    const priority = (this.config.syslog.facility * 8) + this.getSyslogSeverity(event.severity);
    
    return `<${priority}>${event.timestamp} ${event.source} ${event.type} ${JSON.stringify(event.details)}`;
  }

  // קביעת רמת חומרה ל-Syslog
  private getSyslogSeverity(severity: string): number {
    switch (severity) {
      case 'EMERGENCY': return 0;
      case 'ALERT': return 1;
      case 'CRITICAL': return 2;
      case 'ERROR': return 3;
      case 'WARNING': return 4;
      case 'NOTICE': return 5;
      case 'INFO': return 6;
      case 'DEBUG': return 7;
      default: return 6; // INFO ברירת מחדל
    }
  }

  // יצירת ID ייחודי לאירוע
  private generateEventId(): string {
    return createHash('sha256')
      .update(`${Date.now()}-${Math.random().toString(36)}`)
      .digest('hex')
      .substring(0, 16);
  }
}

// יצירת אינסטנס גלובלי של הלוגר
const securityLogger = new SecurityEventLogger();

// פונקציות עזר לרישום אירועים ספציפיים
export const logSecurityEvent = {
  authFailure: (details: { userId?: string; ip?: string; reason: string }) => {
    securityLogger.logEvent({
      type: 'AUTH_FAILURE',
      severity: 'MEDIUM',
      source: 'AUTH_SYSTEM',
      details,
      userId: details.userId,
      ip: details.ip
    });
  },
  
  rateLimitExceeded: (details: { ip?: string; path: string; limit: number; window: string }) => {
    securityLogger.logEvent({
      type: 'RATE_LIMIT_EXCEEDED',
      severity: 'LOW',
      source: 'RATE_LIMIT',
      details,
      ip: details.ip
    });
  },
  
  suspiciousActivity: (details: { userId?: string; ip?: string; pattern: string; description: string }) => {
    securityLogger.logEvent({
      type: 'SUSPICIOUS_ACTIVITY',
      severity: 'HIGH',
      source: 'DETECTION_SYSTEM',
      details,
      userId: details.userId,
      ip: details.ip
    });
  },
  
  violationDetected: (details: { userId?: string; ip?: string; violation: string; impact: string }) => {
    securityLogger.logEvent({
      type: 'VIOLATION_DETECTED',
      severity: 'CRITICAL',
      source: 'POLICY_ENGINE',
      details,
      userId: details.userId,
      ip: details.ip
    });
  }
};

// הגדרת הלוגר בתוך המערכת הקיימת
export function setupSecurityLogging() {
  // התראות כניסה כושלות
  // במקום לוג רגיל, נשלח למערכת האבטחה
  const originalAuth = {
    logFailure: (userId: string | undefined, ip: string, reason: string) => {
      logSecurityEvent.authFailure({ userId, ip, reason });
    }
  };
  
  // התראות חריגות בקצב בקשות
  // במקום לוג רגיל, נשלח למערכת האבטחה
  const originalRateLimit = {
    logExceeded: (ip: string, path: string, limit: number, window: string) => {
      logSecurityEvent.rateLimitExceeded({ ip, path, limit, window });
    }
  };
  
  // התראות ניסיונות אינדוקציה
  // במקום לוג רגיל, נשלח למערכת האבטחה
  const originalDetection = {
    logSuspicious: (userId: string | undefined, ip: string, pattern: string, description: string) => {
      logSecurityEvent.suspiciousActivity({ userId, ip, pattern, description });
    }
  };
  
  // החזרת הפונקציות המקוריות עם תוספת רישום למערכת האבטחה
  return {
    originalAuth,
    originalRateLimit,
    originalDetection
  };
}
