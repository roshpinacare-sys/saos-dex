// src/security/auditExporter.ts
import { createHash } from 'node:crypto';
import dgram from 'node:dgram';
import https from 'node:https';
import http from 'node:http';

interface AuditEvent {
  timestamp: string;
  event_type: string;
  severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
  source_ip?: string;
  user_agent?: string;
  path?: string;
  method?: string;
  details?: Record<string, unknown>;
}

interface AuditExporterConfig {
  endpoint: string; // syslog://host:port or https://host/webhook
  format: 'JSON' | 'CEF';
  minSeverity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
  enabled: boolean;
}

class AuditExporter {
  private config: AuditExporterConfig;
  private udpSocket: dgram.Socket | null = null;

  constructor(config: AuditExporterConfig) {
    this.config = config;
    if (config.endpoint.startsWith('syslog://') && config.enabled) {
      this.setupSyslogSocket();
    }
  }

  private setupSyslogSocket() {
    try {
      const match = this.config.endpoint.match(/^syslog://([^:]+):(\d+)$/);
      if (!match) throw new Error('Invalid syslog endpoint format');
      const [, host, portStr] = match;
      const port = parseInt(portStr, 10);
      if (isNaN(port)) throw new Error('Invalid syslog port');
      this.udpSocket = dgram.createSocket('udp4');
      this.udpSocket.on('error', (err) => {
        console.error('[AuditExporter] UDP socket error:', err.message);
      });
    } catch (err) {
      console.error('[AuditExporter] Failed to setup syslog socket:', err instanceof Error ? err.message : String(err));
      this.udpSocket = null;
    }
  }

  private formatAsCEF(event: AuditEvent): string {
    const base = 'CEF:0|SAOS-DEX|AuditExporter|1.0|';;
    const extension = Object.entries({
      ...(event.source_ip && { src: event.source_ip }),
      ...(event.user_agent && { suser: event.user_agent }),
      ...(event.path && { request: `${event.method || ''} ${event.path}` }),
      ...(Object.keys(event.details || {}).length && { cn1: JSON.stringify(event.details), cn1Label: 'details' })
    })
      .filter(([_, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    return `${base}${event.event_type}|${this.severityToNumber(event.severity)}|${extension}`;
  }

  private severityToNumber(severity: AuditEvent['severity']): number {
    switch (severity) {
      case 'CRITICAL': return 10;
      case 'ERROR': return 8;
      case 'WARNING': return 4;
      case 'INFO': return 2;
      default: return 1;
    }
  }

  private shouldExport(event: AuditEvent): boolean {
    if (!this.config.enabled) return false;
    const severityLevels: Record<AuditEvent['severity'], number> = {
      INFO: 1, WARNING: 2, ERROR: 3, CRITICAL: 4
    };
    const minLevel = severityLevels[this.config.minSeverity];
    const eventLevel = severityLevels[event.severity];
    return eventLevel >= minLevel;
  }

  async export(event: AuditEvent): Promise<void> {
    if (!this.shouldExport(event)) return;

    try {
      if (this.config.endpoint.startsWith('syslog://') && this.udpSocket) {
        const message = this.config.format === 'CEF'
          ? this.formatAsCEF(event)
          : `<14>${JSON.stringify(event)}`;
        const buf = Buffer.from(message);
        const match = this.config.endpoint.match(/^syslog://([^:]+):(\d+)$/);
        if (match) {
          const [, host, portStr] = match;
          const port = parseInt(portStr, 10);
          this.udpSocket.send(buf, 0, buf.length, port, host, (err) => {
            if (err) {
              console.error('[AuditExporter] Failed to send syslog message:', err.message);
            }
          });
        }
      } else if (this.config.endpoint.startsWith('http://') || this.config.endpoint.startsWith('https://')) {
        const payload = this.config.format === 'CEF'
          ? { cef: this.formatAsCEF(event) }
          : event;
        const body = JSON.stringify(payload);
        const url = new URL(this.config.endpoint);
        const options: https.RequestOptions = {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
          },
          timeout: 5000
        };
        const client = url.protocol === 'https:' ? https : http;
        const req = client.request(url, options, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 400) {
              console.error(`[AuditExporter] Webhook failed with status ${res.statusCode}: ${data}`);
            }
          });
        });
        req.on('error', (err) => {
          console.error('[AuditExporter] Webhook request error:', err.message);
        });
        req.write(body);
        req.end();
      }
    } catch (err) {
      console.error('[AuditExporter] Export failed:', err instanceof Error ? err.message : String(err));
    }
  }

  shutdown() {
    if (this.udpSocket) {
      this.udpSocket.close();
      this.udpSocket = null;
    }
  }
}

export { AuditExporter, AuditEvent, AuditExporterConfig };
