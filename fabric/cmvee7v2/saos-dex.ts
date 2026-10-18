import { db } from '@/lib/db';

type ExportProtocol = 'syslog' | 'webhook' | 'cef';
type SecurityEventType = 'login_failed' | 'rate_limit_exceeded' | 'injection_attempt' | 'suspicious_activity';

interface ExportTarget {
  id: string;
  protocol: ExportProtocol;
  endpoint: string;
  format: 'json' | 'cef' | 'syslog';
  enabled: boolean;
  auth?: {
    type: 'bearer' | 'basic' | 'api_key';
    value: string;
    header?: string;
  };
  retryPolicy: {
    maxRetries: number;
    delayMs: number;
    backoffMultiplier: number;
  };
}

interface SecurityEvent {
  id: string;
  timestamp: Date;
  type: SecurityEventType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  sourceIp: string;
  userAgent?: string;
  details: Record<string, any>;
  userId?: string;
}

interface ExportHistory {
  id: string;
  eventId: string;
  targetId: string;
  status: 'pending' | 'success' | 'failed' | 'retrying';
  attempts: number;
  lastAttempt?: Date;
  nextRetry?: Date;
  errorMessage?: string;
}

export class SecurityEventExporter {
  private targets: Map<string, ExportTarget> = new Map();
  private pendingExports: Map<string, Promise<void>> = new Map();
  
  constructor() {
    this.loadTargets();
  }

  /** Load export targets from database */
  private async loadTargets(): Promise<void> {
    try {
      const targets = await db.securityExportTarget.findMany();
      this.targets = new Map(targets.map(t => [t.id, {
        id: t.id,
        protocol: t.protocol as ExportProtocol,
        endpoint: t.endpoint,
        format: t.format as 'json' | 'cef' | 'syslog',
        enabled: t.enabled,
        auth: t.auth ? JSON.parse(t.auth) : undefined,
        retryPolicy: JSON.parse(t.retryPolicy)
      }]));
    } catch (error) {
      console.error('Failed to load export targets:', error);
    }
  }

  /** Add or update an export target */
  async upsertTarget(target: Omit<ExportTarget, 'id'>): Promise<string> {
    const id = `target_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const newTarget: ExportTarget = { ...target, id };
    
    this.targets.set(id, newTarget);
    
    try {
      await db.securityExportTarget.create({
        data: {
          id,
          protocol: newTarget.protocol,
          endpoint: newTarget.endpoint,
          format: newTarget.format,
          enabled: newTarget.enabled,
          auth: newTarget.auth ? JSON.stringify(newTarget.auth) : null,
          retryPolicy: JSON.stringify(newTarget.retryPolicy)
        }
      });
      return id;
    } catch (error) {
      this.targets.delete(id);
      throw error;
    }
  }

  /** Remove an export target */
  async removeTarget(id: string): Promise<void> {
    this.targets.delete(id);
    await db.securityExportTarget.delete({ where: { id } });
  }

  /** Enable or disable an export target */
  async toggleTarget(id: string, enabled: boolean): Promise<void> {
    const target = this.targets.get(id);
    if (!target) throw new Error('Target not found');
    
    target.enabled = enabled;
    await db.securityExportTarget.update({
      where: { id },
      data: { enabled }
    });
  }

  /** Export a security event to all enabled targets */
  async exportEvent(event: SecurityEvent): Promise<void> {
    if (this.pendingExports.has(event.id)) {
      return this.pendingExports.get(event.id)!;
    }

    const exportPromise = this.processEvent(event);
    this.pendingExports.set(event.id, exportPromise);
    
    try {
      await exportPromise;
    } finally {
      this.pendingExports.delete(event.id);
    }
  }

  private async processEvent(event: SecurityEvent): Promise<void> {
    const enabledTargets = Array.from(this.targets.values()).filter(t => t.enabled);
    
    if (enabledTargets.length === 0) return;

    const exportPromises = enabledTargets.map(target => 
      this.sendToTarget(event, target)
    );

    await Promise.allSettled(exportPromises);
  }

  private async sendToTarget(event: SecurityEvent, target: ExportTarget): Promise<void> {
    const historyId = `hist_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      let payload: string;
      
      switch (target.format) {
        case 'json':
          payload = JSON.stringify({
            event,
            timestamp: event.timestamp.toISOString(),
            source: 'saos-dex',
            version: '1.0'
          });
          break;
          
        case 'cef':
          payload = this.formatCef(event);
          break;
          
        case 'syslog':
          payload = this.formatSyslog(event);
          break;
          
        default:
          throw new Error(`Unsupported format: ${target.format}`);
      }

      const headers: Record<string, string> = {
        'Content-Type': target.format === 'json' ? 'application/json' : 'text/plain',
        'User-Agent': 'SAOS-DEX-Security-Exporter/1.0'
      };

      if (target.auth) {
        switch (target.auth.type) {
          case 'bearer':
            headers['Authorization'] = `Bearer ${target.auth.value}`;
            break;
          case 'basic':
            headers['Authorization'] = `Basic ${Buffer.from(`${target.auth.value}`).toString('base64')}`;
            break;
          case 'api_key':
            const headerName = target.auth.header || 'X-API-Key';
            headers[headerName] = target.auth.value;
            break;
        }
      }

      const response = await fetch(target.endpoint, {
        method: 'POST',
        headers,
        body: payload
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      await this.recordExportSuccess(historyId, event.id, target.id);
    } catch (error) {
      await this.handleExportFailure(historyId, event.id, target.id, error);
      throw error;
    }
  }

  private formatCef(event: SecurityEvent): string {
    const severityMap = {
      low: '0',
      medium: '5',
      high: '8',
      critical: '10'
    };

    const typeMap = {
      login_failed: 'Login attempt failed',
      rate_limit_exceeded: 'Rate limit exceeded',
      injection_attempt: 'Potential injection attack',
      suspicious_activity: 'Suspicious activity detected'
    };

    return `CEF:0|SAOS-DEX|Security|1.0|${event.type}|${typeMap[event.type]}|${severityMap[event.severity]}|src=${event.sourceIp} ${Object.entries(event.details).map(([k, v]) => `${k}=${v}`).join(' ')}`;
  }

  private formatSyslog(event: SecurityEvent): string {
    const severityMap = {
      low: '6', // Informational
      medium: '4', // Warning
      high: '3', // Error
      critical: '2' // Critical
    };

    const timestamp = event.timestamp.toISOString();
    return `<${severityMap[event.severity]}>1 ${timestamp} SAOS-DEX security ${event.type} ${event.sourceIp} ${JSON.stringify(event.details)}`;
  }

  private async recordExportSuccess(historyId: string, eventId: string, targetId: string): Promise<void> {
    await db.securityExportHistory.create({
      data: {
        id: historyId,
        eventId,
        targetId,
        status: 'success',
        attempts: 1
      }
    });
  }

  private async handleExportFailure(historyId: string, eventId: string, targetId: string, error: any): Promise<void> {
    const target = this.targets.get(targetId);
    if (!target) return;

    const history = await db.securityExportHistory.findUnique({
      where: { id: historyId }
    });

    const attempts = (history?.attempts || 0) + 1;
    const retryPolicy = target.retryPolicy;
    
    let status: 'failed' | 'retrying' = 'failed';
    let nextRetry: Date | undefined;
    
    if (attempts <= retryPolicy.maxRetries) {
      status = 'retrying';
      const delayMs = retryPolicy.delayMs * Math.pow(retryPolicy.backoffMultiplier, attempts - 1);
      nextRetry = new Date(Date.now() + delayMs);
      
      // Schedule retry
      setTimeout(() => {
        this.retryExport(historyId, eventId, targetId);
      }, delayMs);
    }

    await db.securityExportHistory.upsert({
      where: { id: historyId },
      update: {
        status,
        attempts,
        lastAttempt: new Date(),
        nextRetry,
        errorMessage: error.message
      },
      create: {
        id: historyId,
        eventId,
        targetId,
        status,
        attempts,
        lastAttempt: new Date(),
        nextRetry,
        errorMessage: error.message
      }
    });
  }

  private async retryExport(historyId: string, eventId: string, targetId: string): Promise<void> {
    try {
      const event = await db.securityEvent.findUnique({
        where: { id: eventId }
      });
      
      if (!event) throw new Error('Event not found');
      
      const securityEvent: SecurityEvent = {
        id: event.id,
        timestamp: event.timestamp,
        type: event.type as SecurityEventType,
        severity: event.severity,
        sourceIp: event.sourceIp,
        userAgent: event.userAgent,
        details: event.details,
        userId: event.userId
      };
      
      const target = this.targets.get(targetId);
      if (!target || !target.enabled) return;
      
      await this.sendToTarget(securityEvent, target);
    } catch (error) {
      await this.handleExportFailure(historyId, eventId, targetId, error);
    }
  }

  /** Record a security event in the database */
  async recordEvent(event: Omit<SecurityEvent, 'id' | 'timestamp'>): Promise<string> {
    const id = `event_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const timestamp = new Date();
    
    await db.securityEvent.create({
      data: {
        id,
        timestamp,
        type: event.type,
        severity: event.severity,
        sourceIp: event.sourceIp,
        userAgent: event.userAgent,
        details: event.details,
        userId: event.userId
      }
    });
    
    // Export to external systems
    await this.exportEvent({
      id,
      timestamp,
      ...event
    });
    
    return id;
  }

  /** Get export history for an event or target */
  async getExportHistory(options: {
    eventId?: string;
    targetId?: string;
    limit?: number;
    offset?: number;
  }): Promise<ExportHistory[]> {
    const where: any = {};
    
    if (options.eventId) where.eventId = options.eventId;
    if (options.targetId) where.targetId = options.targetId;
    
    const history = await db.securityExportHistory.findMany({
      where,
      orderBy: { lastAttempt: 'desc' },
      take: options.limit || 100,
      skip: options.offset || 0
    });
    
    return history.map(h => ({
      id: h.id,
      eventId: h.eventId,
      targetId: h.targetId,
      status: h.status,
      attempts: h.attempts,
      lastAttempt: h.lastAttempt,
      nextRetry: h.nextRetry,
      errorMessage: h.errorMessage
    }));
  }
}

// Global instance
export const securityExporter = new SecurityEventExporter();

// Helper functions for common security events
export async function recordLoginFailed(ip: string, userAgent?: string, userId?: string): Promise<string> {
  return securityExporter.recordEvent({
    type: 'login_failed',
    severity: 'medium',
    sourceIp: ip,
    userAgent,
    details: { userId },
    userId
  });
}

export async function recordRateLimitExceeded(ip: string, endpoint: string, userId?: string): Promise<string> {
  return securityExporter.recordEvent({
    type: 'rate_limit_exceeded',
    severity: 'low',
    sourceIp: ip,
    details: { endpoint, userId },
    userId
  });
}

export async function recordInjectionAttempt(ip: string, userAgent: string, payload: string, userId?: string): Promise<string> {
  return securityExporter.recordEvent({
    type: 'injection_attempt',
    severity: 'high',
    sourceIp: ip,
    userAgent,
    details: { payload, userId },
    userId
  });
}

export async function recordSuspiciousActivity(ip: string, action: string, details: Record<string, any>, userId?: string): Promise<string> {
  return securityExporter.recordEvent({
    type: 'suspicious_activity',
    severity: 'medium',
    sourceIp: ip,
    details: { action, ...details, userId },
    userId
  });
}