import { createHash } from 'node:crypto';

interface SecurityEvent {
  timestamp: string;
  event_type: string;
  severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
  description: string;
  source_ip?: string;
  user_agent?: string;
  path?: string;
  method?: string;
  details?: Record<string, unknown>;
}

export class SecurityLogger {
  private static instance: SecurityLogger;
  private syslogHost: string | null;
  private webhookUrl: string | null;
  private readonly maxRetries = 3;
  private readonly retryDelay = 1000;

  private constructor() {
    this.syslogHost = process.env.SECURITY_LOG_SYSLOG_HOST ?? null;
    this.webhookUrl = process.env.SECURITY_LOG_WEBHOOK_URL ?? null;
  }

  public static getInstance(): SecurityLogger {
    if (!SecurityLogger.instance) {
      SecurityLogger.instance = new SecurityLogger();
    }
    return SecurityLogger.instance;
  }

  public async log(event: SecurityEvent): Promise<void> {
    const payload = this.formatPayload(event);
    const promises: Promise<void>[] = [];

    if (this.syslogHost) {
      promises.push(this.sendToSyslog(payload));
    }
    if (this.webhookUrl) {
      promises.push(this.sendToWebhook(payload));
    }

    if (promises.length === 0) {
      return;
    }

    try {
      await Promise.allSettled(promises);
    } catch (error) {
      console.error('[SecurityLogger] Failed to send security event:', error);
      await this.fallbackToLocalLog(event);
    }
  }

  private formatPayload(event: SecurityEvent): Record<string, unknown> {
    return {
      ...event,
      service: 'saos-dex',
      hostname: require('node:os').hostname(),
      pid: process.pid,
    };
  }

  private async sendToSyslog(payload: Record<string, unknown>): Promise<void> {
    const message = `<134>1 ${new Date().toISOString()} ${require('node:os').hostname()} saos-dex - - - ${JSON.stringify(payload)}`;
    const encoder = new TextEncoder();
    const data = encoder.encode(message + '\n');

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const socket = await import('node:dns').then(dns => dns.lookup(this.syslogHost.split(':')[0]));
        const { createConnection } = await import('node:net');
        const port = parseInt(this.syslogHost.split(':')[1] || '514', 10);
        const conn = createConnection({ host: this.syslogHost.split(':')[0], port });
        conn.write(data);
        conn.end();
        await new Promise<void>((resolve, reject) => {
          conn.on('end', resolve);
          conn.on('error', reject);
        });
        return;
      } catch (error) {
        if (attempt === this.maxRetries - 1) throw error;
        await new Promise(res => setTimeout(res, this.retryDelay * Math.pow(2, attempt)));
      }
    }
  }

  private async sendToWebhook(payload: Record<string, unknown>): Promise<void> {
    if (!this.webhookUrl) return;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await fetch(this.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(5000),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return;
      } catch (error) {
        if (attempt === this.maxRetries - 1) throw error;
        await new Promise(res => setTimeout(res, this.retryDelay * Math.pow(2, attempt)));
      }
    }
  }

  private async fallbackToLocalLog(event: SecurityEvent): Promise<void> {
    try {
      const { appendFile } = await import('node:fs/promises');
      const logEntry = `${new Date().toISOString()} [SECURITY_FALLBACK] ${JSON.stringify(event)}\n`;
      await appendFile('./security-fallback.log', logEntry);
    } catch (error) {
      console.error('[SecurityLogger] Failed to write to fallback log:', error);
    }
  }
}

// Integration with existing code in db.ts and middleware.ts
// In db.ts, after throwing the error:
// void (async () => {
//   try {
//     const { alertDatabaseConnectionFailure } = await import('./dex/alert');
//     await alertDatabaseConnectionFailure({
//       timestamp,
//       errorType: 'INVALID_DATABASE_URL',
//       description: errorMessage,
//       severity: 'WARNING',
//     });
//     // NEW: Export to external systems
//     const logger = SecurityLogger.getInstance();
//     await logger.log({
//       timestamp,
//       event_type: 'unauthorized_database_connection_attempt',
//       severity: 'WARNING',
//       description: errorMessage,
//     });
//   } catch (alertError) {
//     // ... existing fallback
//   }
// })();

// In middleware.ts, when rate limiting:
// if (isRateLimited) {
//   const logger = SecurityLogger.getInstance();
//   await logger.log({
//     timestamp: new Date(now).toISOString(),
//     event_type: 'rate_limit_exceeded',
//     severity: 'WARNING',
//     description: `Rate limit exceeded for IP ${ip}`,
//     source_ip: ip,
//     path: pathname,
//     method: req.method,
//   });
// }
