// src/security/logExport.ts
import { createHash } from 'node:crypto'; import dgram from 'dgram'; import net from 'net';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface SecurityEvent {
  timestamp: string;
  level: LogLevel;
  eventType: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export class LogExport {
  private destinations: Set<string>;
  private webhookUrl: string | undefined;
  private syslogHost: string | undefined;
  private syslogPort: number | undefined;
  private format: 'json' | 'cef' | 'raw';
  private filePath: string | undefined;

  constructor() {
    const enabled = process.env.LOG_EXPORT_ENABLED === 'true';
    if (!enabled) {
      this.destinations = new Set();
      return;
    }

    const dests = process.env.LOG_EXPORT_DESTINATIONS ?? 'console';
    this.destinations = new Set(dests.split(',').map(d => d.trim()));
    this.webhookUrl = process.env.LOG_EXPORT_WEBHOOK_URL;
    this.syslogHost = process.env.LOG_EXPORT_SYSLOG_HOST;
    const port = process.env.LOG_EXPORT_SYSLOG_PORT;
    this.syslogPort = port ? parseInt(port, 10) : undefined;
    this.format = (process.env.LOG_EXPORT_FORMAT ?? 'json') as 'json' | 'cef' | 'raw';
    this.filePath = process.env.LOG_EXPORT_FILE_PATH;
  }

  async export(event: SecurityEvent): Promise<void> {
    if (this.destinations.size === 0) return;

    const formatted = this.formatEvent(event);
    const promises: Promise<void>[] = [];

    if (this.destinations.has('console')) {
      promises.push(this.exportToConsole(formatted));
    }
    if (this.destinations.has('file') && this.filePath) {
      promises.push(this.exportToFile(formatted, this.filePath));
    }
    if (this.destinations.has('syslog') && this.syslogHost && this.syslogPort) {
      promises.push(this.exportToSyslog(formatted, this.syslogHost, this.syslogPort));
    }
    if (this.destinations.has('webhook') && this.webhookUrl) {
      promises.push(this.exportToWebhook(event, this.webhookUrl));
    }

    await Promise.allSettled(promises);
  }

  private formatEvent(event: SecurityEvent): string {
    switch (this.format) {
      case 'json':
        return JSON.stringify(event);
      case 'cef':
        return this.formatCEF(event);
      case 'raw':
        return event.message;
      default:
        return JSON.stringify(event);
    }
  }

  private formatCEF(event: SecurityEvent): string {
    const header = 'CEF:0|saos-dex|security|1.0|'; 
    const extension = `msg=${this.escapeCEF(event.message)}`;
    if (event.metadata) {
      for (const [key, value] of Object.entries(event.metadata)) {
        extension += ` ${key}=${this.escapeCEF(String(value))}`;
      }
    }
    return header + event.eventType + '|' + extension;
  }

  private escapeCEF(text: string): string {
    return text.replace(/[\\=:]/g, '\\$&');
  }

  private async exportToConsole(message: string): Promise<void> {
    console.log(`[SECURITY-EXPORT] ${message}`);
  }

  private async exportToFile(message: string, filePath: string): Promise<void> {
    const fs = await import('node:fs');
    await fs.promises.appendFile(filePath, message + '\n');
  }

  private async exportToSyslog(message: string, host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const client = dgram.createSocket('udp4');
      const buf = Buffer.from(message);
      client.send(buf, 0, buf.length, port, host, (err) => {
        client.close();
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private async exportToWebhook(event: SecurityEvent, url: string): Promise<void> {
    const maxRetries = 3;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(event),
          signal: AbortSignal.timeout(5000)
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return;
      } catch (err) {
        lastError = err as Error;
        if (attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
        }
      }
    }

    console.error(`[SECURITY-EXPORT] Failed to send webhook after ${maxRetries} attempts:`, lastError);
  }
}

// Singleton instance
export const logExport = new LogExport();
