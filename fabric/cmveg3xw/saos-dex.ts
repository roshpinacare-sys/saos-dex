import { db } from '@/lib/db';

// Define types for security events and export configurations
interface SecurityEvent {
  id: string;
  timestamp: Date;
  eventType: 'FAILED_LOGIN' | 'RATE_LIMIT_EXCEEDED' | 'SUSPICIOUS_ACTIVITY' | 'VIOLATION_DETECTED';
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  sourceIp: string;
  userId?: string;
  details: Record<string, any>;
}

interface ExportTarget {
  id: string;
  name: string;
  type: 'SYSLOG' | 'WEBHOOK' | 'CEF';
  endpoint: string;
  isActive: boolean;
  format: 'JSON' | 'CEF';
  headers?: Record<string, string>;
}

interface ExportConfig {
  targets: ExportTarget[];
  eventTypes: SecurityEvent['eventType'][];
  severities: SecurityEvent['severity'][];
}

// Security events exporter module
export class SecurityEventExporter {
  private config: ExportConfig;
  private eventQueue: SecurityEvent[] = [];
  private processingInterval: NodeJS.Timeout;

  constructor(config: ExportConfig) {
    this.config = config;
    // Start processing queue every 5 seconds
    this.processingInterval = setInterval(() => this.processQueue(), 5000);
  }

  // Add a security event to the queue
  async logEvent(event: Omit<SecurityEvent, 'id' | 'timestamp'>) {
    const fullEvent: SecurityEvent = {
      ...event,
      id: crypto.randomUUID(),
      timestamp: new Date(),
    };
    
    // Store in database
    try {
      await db.securityEvent.create({
        data: {
          id: fullEvent.id,
          timestamp: fullEvent.timestamp,
          eventType: fullEvent.eventType,
          severity: fullEvent.severity,
          sourceIp: fullEvent.sourceIp,
          userId: fullEvent.userId,
          details: fullEvent.details,
        },
      });
    } catch (error) {
      console.error('Failed to store security event:', error);
    }
    
    // Add to processing queue
    this.eventQueue.push(fullEvent);
  }

  // Process the event queue and export to configured targets
  private async processQueue() {
    if (this.eventQueue.length === 0) return;
    
    const eventsToProcess = [...this.eventQueue];
    this.eventQueue = [];
    
    for (const event of eventsToProcess) {
      // Filter by configured event types and severities
      if (
        !this.config.eventTypes.includes(event.eventType) ||
        !this.config.severities.includes(event.severity)
      ) {
        continue;
      }
      
      // Export to each active target
      for (const target of this.config.targets.filter(t => t.isActive)) {
        try {
          await this.exportToTarget(event, target);
        } catch (error) {
          console.error(`Failed to export event ${event.id} to target ${target.id}:`, error);
        }
      }
    }
  }

  // Export a single event to a specific target
  private async exportToTarget(event: SecurityEvent, target: ExportTarget) {
    switch (target.type) {
      case 'SYSLOG':
        await this.exportToSyslog(event, target);
        break;
      case 'WEBHOOK':
        await this.exportToWebhook(event, target);
        break;
      case 'CEF':
        await this.exportToCEF(event, target);
        break;
    }
  }

  // Export to Syslog target
  private async exportToSyslog(event: SecurityEvent, target: ExportTarget) {
    // Format event as Syslog message
    const syslogMessage = `<${this.calculateFacilityPriority()}>1 ${new Date().toISOString()} saos-dex security ${target.endpoint} - ${JSON.stringify(event)}`;
    
    // In a real implementation, you would send this to a syslog server
    // For now, we'll just log it to demonstrate
    console.log('Syslog export:', syslogMessage);
  }

  // Export to Webhook target
  private async exportToWebhook(event: SecurityEvent, target: ExportTarget) {
    const payload = target.format === 'JSON' 
      ? JSON.stringify(event) 
      : this.formatAsCEF(event);
    
    const response = await fetch(target.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...target.headers,
      },
      body: payload,
    });
    
    if (!response.ok) {
      throw new Error(`Webhook failed with status ${response.status}`);
    }
  }

  // Export to CEF target
  private async exportToCEF(event: SecurityEvent, target: ExportTarget) {
    const cefMessage = this.formatAsCEF(event);
    
    // In a real implementation, you would send this to a CEF-enabled system
    // For now, we'll just log it to demonstrate
    console.log('CEF export:', cefMessage);
  }

  // Format event as CEF message
  private formatAsCEF(event: SecurityEvent): string {
    const severityMap = {
      'LOW': 0,
      'MEDIUM': 5,
      'HIGH': 8,
      'CRITICAL': 10,
    };
    
    return `CEF:0|SAOS-DEX|Security|1.0|${event.eventType}|${event.eventType}|${severityMap[event.severity]}|${JSON.stringify(event.details)}`;
  }

  // Calculate Syslog facility and priority
  private calculateFacilityPriority(): number {
    // Facility 16 (local0) + severity 6 (informational)
    return (16 << 3) + 6;
  }

  // Update export configuration
  updateConfig(newConfig: Partial<ExportConfig>) {
    this.config = { ...this.config, ...newConfig };
  }

  // Stop the exporter
  stop() {
    clearInterval(this.processingInterval);
  }
}

// Create default configuration
const defaultConfig: ExportConfig = {
  targets: [
    {
      id: 'webhook-main',
      name: 'Main Security Webhook',
      type: 'WEBHOOK',
      endpoint: process.env.SECURITY_WEBHOOK_URL || 'https://example.com/security-events',
      isActive: !!process.env.SECURITY_WEBHOOK_URL,
      format: 'JSON',
      headers: {
        'Authorization': `Bearer ${process.env.SECURITY_WEBHOOK_TOKEN}`,
      },
    },
    {
      id: 'syslog-main',
      name: 'Main Syslog Server',
      type: 'SYSLOG',
      endpoint: 'syslog.example.com',
      isActive: false, // Disabled by default
      format: 'JSON',
    },
    {
      id: 'cef-main',
      name: 'CEF Security System',
      type: 'CEF',
      endpoint: 'cef.example.com',
      isActive: false, // Disabled by default
      format: 'CEF',
    },
  ],
  eventTypes: ['FAILED_LOGIN', 'RATE_LIMIT_EXCEEDED', 'SUSPICIOUS_ACTIVITY', 'VIOLATION_DETECTED'],
  severities: ['MEDIUM', 'HIGH', 'CRITICAL'],
};

// Initialize the exporter
const securityExporter = new SecurityEventExporter(defaultConfig);

// Example usage - integrate with existing middleware
export async function securityMiddleware(req: any, res: any, next: any) {
  // Extract IP address
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
  
  // Example: Log failed login attempts
  if (req.body && req.body.action === 'login' && !req.body.success) {
    await securityExporter.logEvent({
      eventType: 'FAILED_LOGIN',
      severity: 'MEDIUM',
      sourceIp: ip as string,
      details: {
        username: req.body.username,
        userAgent: req.headers['user-agent'],
      },
    });
  }
  
  // Example: Log rate limit violations
  if (res.statusCode === 429) {
    await securityExporter.logEvent({
      eventType: 'RATE_LIMIT_EXCEEDED',
      severity: 'LOW',
      sourceIp: ip as string,
      details: {
        path: req.path,
        method: req.method,
        userAgent: req.headers['user-agent'],
      },
    });
  }
  
  next();
}

// Example usage - integrate with authentication system
export async function logSecurityEvent(eventType: SecurityEvent['eventType'], severity: SecurityEvent['severity'], sourceIp: string, details: Record<string, any>) {
  await securityExporter.logEvent({
    eventType,
    severity,
    sourceIp,
    details,
  });
}

// Export for use in other modules
export { securityExporter, SecurityEvent, ExportTarget };
