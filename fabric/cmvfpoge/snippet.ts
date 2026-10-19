import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

interface SecurityEvent {
  timestamp: string;
  event_type: string;
  severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
  source_ip?: string;
  user_agent?: string;
  path?: string;
  method?: string;
  details?: Record<string, unknown>;
}

class SecurityEventExporter {
  private syslogEnabled: boolean;
  private webhookEnabled: boolean;
  private syslogHost: string;
  private syslogPort: number;
  private webhookUrl: string;
  private webhookHeaders: Record<string, string>;
  private maxRetries: number;
  private retryDelayMs: number;

  constructor() {
    this.syslogEnabled = process.env.SECURITY_EXPORT_SYSLOG_ENABLED === 'true';
    this.webhookEnabled = process.env.SECURITY_EXPORT_WEBHOOK_ENABLED === 'true';
    this.syslogHost = process.env.SECURITY_EXPORT_SYSLOG_HOST || 'localhost';
    this.syslogPort = parseInt(process.env.SECURITY_EXPORT_SYSLOG_PORT || '514', 10);
    this.webhookUrl = process.env.SECURITY_EXPORT_WEBHOOK_URL || '';
    const headersStr = process.env.SECURITY_EXPORT_WEBHOOK_HEADERS || '{}';
    try {
      this.webhookHeaders = JSON.parse(headersStr);
    } catch {
      this.webhookHeaders = {};
    }
    this.maxRetries = parseInt(process.env.SECURITY_EXPORT_MAX_RETRIES || '3', 10);
    this.retryDelayMs = parseInt(process.env.SECURITY_EXPORT_RETRY_DELAY_MS || '1000', 10);
  }

  async export(event: SecurityEvent): Promise<void> {
    const exportPromises: Promise<void>[] = [];
    
    if (this.syslogEnabled) {
      exportPromises.push(this.exportToSyslog(event));
    }
    
    if (this.webhookEnabled && this.webhookUrl) {
      exportPromises.push(this.exportToWebhook(event));
    }
    
    if (exportPromises.length === 0) {
      // Fallback to console if no external export configured
      console.log(JSON.stringify({ ...event, exported: false, reason: 'no_export_configured' }));
      return;
    }
    
    // Wait for all exports to complete, but don't fail the main operation if one fails
    await Promise.allSettled(exportPromises);
  }

  private async exportToSyslog(event: SecurityEvent): Promise<void> {
    try {
      const message = this.formatSyslogMessage(event);
      // In a real implementation, this would send to a syslog server via UDP/TCP
      // For now, we log to console as a placeholder
      console.log(`[SYSLOG] ${message}`);
    } catch (error) {
      console.error('Failed to export security event to syslog:', error);
      // In a production system, we might want to retry or store locally
    }
  }

  private async exportToWebhook(event: SecurityEvent): Promise<void> {
    let lastError: unknown;
    
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await fetch(this.webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...this.webhookHeaders,
          },
          body: JSON.stringify(event),
          signal: AbortSignal.timeout(5000),
        });
        
        if (!response.ok) {
          throw new Error(`Webhook returned ${response.status}`);
        }
        
        // Success
        return;
      } catch (error) {
        lastError = error;
        if (attempt < this.maxRetries) {
          await new Promise(resolve => setTimeout(resolve, this.retryDelayMs * Math.pow(2, attempt)));
        }
      }
    }
    
    console.error('Failed to export security event to webhook after retries:', lastError);
  }

  private formatSyslogMessage(event: SecurityEvent): string {
    const pri = 13; // user.level
    const timestamp = new Date(event.timestamp).toISOString();
    const hostname = process.env.HOSTNAME || 'saos-dex';
    const appName = 'security-exporter';
    const procid = process.pid.toString();
    const msgid = '-'; 
    
    const structuredData = `[eventID@${process.env.NODE_ENV || 'unknown'} event_type="${event.event_type}" severity="${event.severity}"]`;
    
    const message = JSON.stringify(event);
    
    return `<${pri}>1 ${timestamp} ${hostname} ${appName} ${procid} ${msgid} ${structuredData} ${message}`;
  }
}

// Singleton instance
const securityExporter = new SecurityEventExporter();

export async function exportSecurityEvent(event: Omit<SecurityEvent, 'timestamp'>): Promise<void> {
  const enrichedEvent: SecurityEvent = {
    ...event,
    timestamp: new Date().toISOString(),
  };
  
  await securityExporter.export(enrichedEvent);
}

export async function logFailedLoginAttempt(
  ip: string,
  userAgent: string,
  path: string,
  details?: Record<string, unknown>
): Promise<void> {
  await exportSecurityEvent({
    event_type: 'failed_login_attempt',
    severity: 'WARNING',
    source_ip: ip,
    user_agent: userAgent,
    path,
    details,
  });
}

export async function logRateLimitExceeded(
  ip: string,
  path: string,
  method: string,
  limit: number,
  window: string
): Promise<void> {
  await exportSecurityEvent({
    event_type: 'rate_limit_exceeded',
    severity: 'INFO',
    source_ip: ip,
    path,
    method,
    details: { limit, window },
  });
}

export async function logInjectionAttempt(
  ip: string,
  userAgent: string,
  path: string,
  method: string,
  injectionType: string,
  payload: string
): Promise<void> {
  await exportSecurityEvent({
    event_type: 'injection_attempt',
    severity: 'ERROR',
    source_ip: ip,
    user_agent: userAgent,
    path,
    method,
    details: { injection_type: injectionType, payload },
  });
}

// Middleware integration example
export async function securityMiddleware(request: NextRequest): Promise<NextResponse | undefined> {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 
             request.headers.get('x-real-ip') || 
             request.ip || 
             'unknown';
  const userAgent = request.headers.get('user-agent') || 'unknown';
  const path = request.nextUrl.pathname;
  const method = request.method;

  // Example: Detect potential SQL injection
  const sqlInjectionPatterns = [/union\s+select/i, /drop\s+table/i, /'\s*or\s*'1'='1/i];
  const queryParams = request.nextUrl.searchParams;
  for (const [key, value] of queryParams.entries()) {
    const combined = `${key}=${value}`;
    if (sqlInjectionPatterns.some(pattern => pattern.test(combined))) {
      await logInjectionAttempt(ip, userAgent, path, method, 'sql_injection', combined);
      // In a real implementation, you might want to block the request here
      // return NextResponse.json({ error: 'Blocked' }, { status: 403 });
    }
  }

  // Continue with request
  return undefined;
}