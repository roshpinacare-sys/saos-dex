import { createHash } from 'node:crypto';

// סוגים עבור ייצוא לוגים
export type SecurityLogLevel = 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
export type SecurityLogProtocol = 'SYSLOG' | 'WEBHOOK' | 'JSON' | 'CEF';

export interface SecurityLogEvent {
  timestamp: string;
  level: SecurityLogLevel;
  category: 'AUTH_FAILURE' | 'RATE_LIMIT_EXCEEDED' | 'SUSPICIOUS_ACTIVITY' | 'VIOLATION' | 'ANOMALY';
  source: string;
  details: Record<string, unknown>;
  userId?: string;
  ip?: string;
  userAgent?: string;
}

export interface SecurityLoggerConfig {
  enabled: boolean;
  protocols: SecurityLogProtocol[];
  syslog?: {
    host: string;
    port: number;
    facility: number;
  };
  webhook?: {
    url: string;
    timeout: number;
    headers?: Record<string, string>;
  };
  cef?: {
    deviceVendor: string;
    deviceProduct: string;
    deviceVersion: string;
  };
}

export class SecurityLogger {
  private config: SecurityLoggerConfig;

  constructor(config: SecurityLoggerConfig) {
    this.config = config;
  }

  /**
   * רישום אירוע אבטחה
   */
  async logEvent(event: SecurityLogEvent): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    // תוספת מטא-נתונים לאירוע
    const enrichedEvent = {
      ...event,
      id: this.generateEventId(event),
      receivedAt: new Date().toISOString(),
    };

    // ייצור לפי פרוטוקולים מוגדרים
    const promises: Promise<void>[] = [];
    
    if (this.config.protocols.includes('SYSLOG') && this.config.syslog) {
      promises.push(this.sendSyslog(enrichedEvent));
    }
    
    if (this.config.protocols.includes('WEBHOOK') && this.config.webhook) {
      promises.push(this.sendWebhook(enrichedEvent));
    }
    
    if (this.config.protocols.includes('JSON')) {
      promises.push(this.sendJsonLog(enrichedEvent));
    }
    
    if (this.config.protocols.includes('CEF') && this.config.cef) {
      promises.push(this.sendCef(enrichedEvent));
    }

    // ביצוע כל הייצואים במקביל
    await Promise.allSettled(promises);
  }

  /**
   * ייצור מזהה ייחודי לאירוע
   */
  private generateEventId(event: SecurityLogEvent): string {
    const data = `${event.timestamp}-${event.category}-${event.source}-${JSON.stringify(event.details)}`;
    return createHash('sha256').update(data).digest('hex').substring(0, 16);
  }

  /**
   * שליחה ל-Syslog
   */
  private async sendSyslog(event: SecurityLogEvent): Promise<void> {
    // יישום ממשי יכלול שימוש בספריית syslog כמו syslog5
    // להלן מימוש מופשט להדגמה
    const severity = this.mapSeverityToSyslogLevel(event.level);
    
    const syslogMessage = `<${severity}>1 ${event.timestamp} saos-dex security - ${JSON.stringify(event)}`;
    
    console.log(`[SYSLOG] ${syslogMessage}`);
    // ביישום מלא: הידור UDP לכתובת ה-Syslog
  }

  /**
   * שליחה ל-Webhook
   */
  private async sendWebhook(event: SecurityLogEvent): Promise<void> {
    if (!this.config.webhook) return;
    
    try {
      const response = await fetch(this.config.webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.config.webhook.headers,
        },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(this.config.webhook.timeout),
      });
      
      if (!response.ok) {
        console.error(`[WEBHOOK] Failed to send security event: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      console.error(`[WEBHOOK] Error sending security event:`, error);
    }
  }

  /**
   * ייצור לוג מקומי בפורמט JSON
   */
  private async sendJsonLog(event: SecurityLogEvent): Promise<void> {
    // ביישום מלא: כתיבה לקובץ לוג עם פורמט JSON
    console.log(`[JSON LOG] ${JSON.stringify(event)}`);
  }

  /**
   * ייצוא בפורמט CEF (Common Event Format)
   */
  private async sendCef(event: SecurityLogEvent): Promise<void> {
    if (!this.config.cef) return;
    
    const severity = this.mapSeverityToCefLevel(event.level);
    const name = event.category.replace(/_/g, ' ');
    const extension = `src=${event.source} msg=${JSON.stringify(event.details)}`;
    
    const cefMessage = `CEF:0|${this.config.cef.deviceVendor}|${this.config.cef.deviceProduct}|${this.config.cef.deviceVersion}|${name}|${event.id}|${severity}|${extension}`;
    
    console.log(`[CEF] ${cefMessage}`);
    // ביישום מלא: שליחה למערכת ניטור תואמת CEF
  }

  /**
   * מיפוי רמת חומרה לרמת Syslog
   */
  private mapSeverityToSyslogLevel(level: SecurityLogLevel): number {
    switch (level) {
      case 'INFO': return 6; // Informational
      case 'WARNING': return 4; // Warning
      case 'ERROR': return 3; // Error
      case 'CRITICAL': return 2; // Critical
      default: return 5; // Notice
    }
  }

  /**
   * מיפוי רמת חומרה לרמת CEF
   */
  private mapSeverityToCefLevel(level: SecurityLogLevel): number {
    switch (level) {
      case 'INFO': return 0;
      case 'WARNING': return 4;
      case 'ERROR': return 7;
      case 'CRITICAL': return 10;
      default: return 3;
    }
  }
}

// יצירת אינסטנס גלובלי של הלוגר
let securityLoggerInstance: SecurityLogger | null = null;

/**
 * יצירה/קבלת אינסטנס גלובלי של הלוגר
 */
export function getSecurityLogger(): SecurityLogger {
  if (!securityLoggerInstance) {
    // קריאת הקונפיגורציה מסביבה
    const config: SecurityLoggerConfig = {
      enabled: process.env.SECURITY_LOGGER_ENABLED === 'true',
      protocols: (process.env.SECURITY_LOGGER_PROTOCOLS?.split(',') as SecurityLogProtocol[]) || [],
      syslog: process.env.SECURITY_LOGGER_SYSLOG_HOST ? {
        host: process.env.SECURITY_LOGGER_SYSLOG_HOST,
        port: parseInt(process.env.SECURITY_LOGGER_SYSLOG_PORT || '514', 10),
        facility: parseInt(process.env.SECURITY_LOGGER_SYSLOG_FACILITY || '16', 10),
      } : undefined,
      webhook: process.env.SECURITY_LOGGER_WEBHOOK_URL ? {
        url: process.env.SECURITY_LOGGER_WEBHOOK_URL,
        timeout: parseInt(process.env.SECURITY_LOGGER_WEBHOOK_TIMEOUT || '5000', 10),
        headers: process.env.SECURITY_LOGGER_WEBHOOK_HEADERS 
          ? JSON.parse(process.env.SECURITY_LOGGER_WEBHOOK_HEADERS)
          : undefined,
      } : undefined,
      cef: {
        deviceVendor: 'SAOS-DEX',
        deviceProduct: 'Security Monitor',
        deviceVersion: '1.0',
      },
    };
    
    securityLoggerInstance = new SecurityLogger(config);
  }
  
  return securityLoggerInstance;
}
