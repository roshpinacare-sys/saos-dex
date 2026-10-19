import { createHash } from 'node:crypto';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';
type LogFormat = 'json' | 'cef';
type LogDestination = 'syslog' | 'webhook' | 'file';

interface SecurityEvent {
  timestamp: string;
  level: LogLevel;
  category: 'auth' | 'rate_limit' | 'anomaly' | 'integrity' | 'compliance';
  message: string;
  details?: Record<string, unknown>;
  sourceIp?: string;
  userAgent?: string;
  userId?: string;
  severity?: number;
}

interface CEFEvent {
  deviceVersion: string;
  deviceEventClassId: string;
  name: string;
  severity: number;
}

interface SecurityLoggerConfig {
  enabled: boolean;
  format: LogFormat;
  destinations: LogDestination[];
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
  file?: {
    path: string;
    maxFiles: number;
    maxSize: string;
  };
  cefTemplate?: CEFEvent;
}

const DEFAULT_CONFIG: SecurityLoggerConfig = {
  enabled: true,
  format: 'json',
  destinations: ['file'],
  syslog: {
    host: 'localhost',
    port: 514,
    facility: 16, // local use
  },
  webhook: {
    url: '',
    timeout: 5000,
  },
  file: {
    path: './logs/security',
    maxFiles: 5,
    maxSize: '10M',
  },
  cefTemplate: {
    deviceVersion: 'SAOS-DEX',
    deviceEventClassId: 'security',
    name: 'Security Event',
    severity: 3, // Medium
  },
};

export class SecurityLogger {
  private config: SecurityLoggerConfig;
  private logBuffer: SecurityEvent[] = [];
  private flushInterval: NodeJS.Timeout | null = null;

  constructor(config: Partial<SecurityLoggerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    if (this.config.enabled) {
      // Ensure log directory exists
      if (this.config.file && !existsSync(this.config.file.path)) {
        mkdirSync(this.config.file.path, { recursive: true });
      }
      
      // Start periodic flush
      this.flushInterval = setInterval(() => this.flush(), 30000);
    }
  }

  public logSecurityEvent(event: Omit<SecurityEvent, 'timestamp'>): void {
    if (!this.config.enabled) return;
    
    const fullEvent: SecurityEvent = {
      ...event,
      timestamp: new Date().toISOString(),
    };
    
    this.logBuffer.push(fullEvent);
    
    // Flush immediately for high severity events
    if (event.severity && event.severity >= 8) {
      this.flush();
    }
  }

  private flush(): void {
    if (this.logBuffer.length === 0) return;
    
    const eventsToFlush = [...this.logBuffer];
    this.logBuffer = [];
    
    for (const destination of this.config.destinations) {
      switch (destination) {
        case 'file':
          this.writeToFile(eventsToFlush);
          break;
        case 'syslog':
          this.sendToSyslog(eventsToFlush);
          break;
        case 'webhook':
          this.sendToWebhook(eventsToFlush);
          break;
      }
    }
  }

  private writeToFile(events: SecurityEvent[]): void {
    if (!this.config.file) return;
    
    const date = new Date().toISOString().split('T')[0];
    const filePath = join(this.config.file.path, `security-${date}.log`);
    
    const logLines = events.map(event => {
      if (this.config.format === 'json') {
        return JSON.stringify(event);
      } else {
        return this.formatAsCEF(event);
      }
    });
    
    try {
      writeFileSync(filePath, logLines.join('\n') + '\n', { flag: 'a' });
    } catch (error) {
      console.error('Failed to write security log:', error);
    }
  }

  private async sendToSyslog(events: SecurityEvent[]): Promise<void> {
    if (!this.config.syslog) return;
    
    // Implementation would use a syslog client library
    // For this example, we'll simulate the format
    const syslogMessages = events.map(event => {
      const priority = (this.config.syslog!.facility * 8) + this.getSeverityLevel(event.level);
      const timestamp = new Date().toISOString();
      const hostname = 'saos-dex';
      const tag = 'security';
      
      if (this.config.format === 'json') {
        return `<${priority}>1 ${timestamp} ${hostname} ${tag} - - ${JSON.stringify(event)}`;
      } else {
        return `<${priority}>1 ${timestamp} ${hostname} ${tag} - - ${this.formatAsCEF(event)}`;
      }
    });
    
    // In a real implementation, send these messages to syslog server
    console.log('Syslog messages (simulated):', syslogMessages.join('\n'));
  }

  private async sendToWebhook(events: SecurityEvent[]): Promise<void> {
    if (!this.config.webhook?.url) return;
    
    const payload = this.config.format === 'json' 
      ? events 
      : events.map(event => this.formatAsCEF(event));
    
    try {
      const response = await fetch(this.config.webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.config.webhook.headers,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.config.webhook.timeout),
      });
      
      if (!response.ok) {
        console.error(`Webhook failed with status ${response.status}`);
      }
    } catch (error) {
      console.error('Webhook error:', error);
    }
  }

  private formatAsCEF(event: SecurityEvent): string {
    if (!this.config.cefTemplate) return '';
    
    const cefHeader = `CEF:${this.config.cefTemplate.deviceVersion}|${this.config.cefTemplate.deviceEventClassId}|${this.config.cefTemplate.name}|${this.config.cefTemplate.severity}|${event.message}|`;
    
    const extensions = [
      `src=${event.sourceIp || '-'}`,
      `msg=${event.message}`,
      `severity=${event.severity || 3}`,
      `category=${event.category}`,
      `user=${event.userId || '-'}`,
      `deviceEventClassId=${this.config.cefTemplate.deviceEventClassId}`,
      `deviceVersion=${this.config.cefTemplate.deviceVersion}`,
      ...Object.entries(event.details || {}).map(([key, value]) => `${key}=${value}`)
    ];
    
    return `${cefHeader} ${extensions.join(' ')}`;
  }

  private getSeverityLevel(level: LogLevel): number {
    switch (level) {
      case 'info': return 6;
      case 'warn': return 4;
      case 'error': return 3;
      case 'debug': return 7;
      default: return 6;
    }
  }

  // Helper methods for common security events
  public logFailedLogin(ip: string, userAgent?: string, userId?: string): void {
    this.logSecurityEvent({
      level: 'warn',
      category: 'auth',
      message: 'Failed login attempt',
      sourceIp: ip,
      userAgent,
      userId,
      details: {
        eventType: 'login_failure',
        attempts: 1,
      },
      severity: 5,
    });
  }

  public logRateLimitExceeded(ip: string, path: string, limit: number, window: number): void {
    this.logSecurityEvent({
      level: 'warn',
      category: 'rate_limit',
      message: 'Rate limit exceeded',
      sourceIp: ip,
      details: {
        eventType: 'rate_limit_exceeded',
        path,
        limit,
        window,
      },
      severity: 4,
    });
  }

  public logAnomalyDetection(type: string, ip: string, details: Record<string, unknown>): void {
    this.logSecurityEvent({
      level: 'warn',
      category: 'anomaly',
      message: `Anomaly detected: ${type}`,
      sourceIp: ip,
      details: {
        eventType: 'anomaly_detection',
        anomalyType: type,
        ...details,
      },
      severity: 6,
    });
  }

  public logIntegrityCheck(passed: boolean, details: Record<string, unknown>): void {
    this.logSecurityEvent({
      level: passed ? 'info' : 'error',
      category: 'integrity',
      message: passed ? 'Integrity check passed' : 'Integrity check failed',
      details: {
        eventType: 'integrity_check',
        passed,
        ...details,
      },
      severity: passed ? 2 : 8,
    });
  }

  public shutdown(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    
    // Flush any remaining logs
    this.flush();
  }
}

// Example usage and integration
const securityLogger = new SecurityLogger({
  destinations: ['file', 'webhook'],
  webhook: {
    url: process.env.SECURITY_WEBHOOK_URL || '',
    timeout: 3000,
    headers: {
      'Authorization': `Bearer ${process.env.SECURITY_WEBHOOK_TOKEN}`,
    },
  },
  format: 'json',
});

// Export for use in other modules
export default securityLogger;

// Example integration in middleware.ts
// import securityLogger from '@/lib/security-logger';

// In rate limiting section:
// if (isRateLimited) {
//   securityLogger.logRateLimitExceeded(ip, pathname, limit, windowMs);
// }

// In authentication section:
// if (authFailed) {
//   securityLogger.logFailedLogin(ip, req.headers.get('user-agent'), userId);
// }
