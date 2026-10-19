import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

type LogLevel = 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
type LogEvent = {
  id: string;
  timestamp: Date;
  level: LogLevel;
  category: 'SECURITY' | 'AUTH' | 'API' | 'SYSTEM' | 'AUDIT';
  message: string;
  details?: Record<string, unknown>;
  sourceIp?: string;
  userAgent?: string;
  userId?: string;
};

type ExportTarget = {
  id: string;
  type: 'SYSLOG' | 'WEBHOOK';
  endpoint: string;
  format: 'JSON' | 'CEF';
  filters: {
    categories?: string[];
    levels?: LogLevel[];
  };
  headers?: Record<string, string>;
  retryAttempts: number;
  retryDelayMs: number;
  active: boolean;
};

type LogExportServiceConfig = {
  targets: ExportTarget[];
  batchSize: number;
  flushIntervalMs: number;
  maxRetries: number;
};

export class LogExportService {
  private prisma: PrismaClient;
  private config: LogExportServiceConfig;
  private pendingLogs: LogEvent[] = [];
  private flushTimer?: NodeJS.Timeout;
  private serviceLogger: (message: string, level?: LogLevel) => void;

  constructor(prisma: PrismaClient, configPath: string, serviceLogger?: (message: string, level?: LogLevel) => void) {
    this.prisma = prisma;
    this.serviceLogger = serviceLogger || ((message, level = 'INFO') => {
      console.log(`[${level}] LogExportService: ${message}`);
    });
    
    this.loadConfig(configPath).catch(err => {
      this.serviceLogger(`Failed to load config: ${err.message}`, 'ERROR');
      throw err;
    });
    
    this.startFlushTimer();
  }

  private async loadConfig(configPath: string): Promise<void> {
    try {
      const configData = await fs.readFile(configPath, 'utf-8');
      this.config = JSON.parse(configData) as LogExportServiceConfig;
      
      // Validate config
      if (!this.config.targets || this.config.targets.length === 0) {
        throw new Error('No export targets configured');
      }
      
      if (this.config.batchSize < 1 || this.config.batchSize > 1000) {
        throw new Error('batchSize must be between 1 and 1000');
      }
      
      if (this.config.flushIntervalMs < 1000 || this.config.flushIntervalMs > 300000) {
        throw new Error('flushIntervalMs must be between 1000 and 300000');
      }
    } catch (error) {
      this.serviceLogger(`Error loading config: ${error instanceof Error ? error.message : 'Unknown error'}`, 'ERROR');
      throw error;
    }
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flushLogs().catch(err => {
        this.serviceLogger(`Error during scheduled flush: ${err.message}`, 'ERROR');
      });
    }, this.config.flushIntervalMs);
  }

  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  public async addLog(log: Omit<LogEvent, 'id'>): Promise<void> {
    const logWithId: LogEvent = {
      ...log,
      id: createHash('sha256').update(`${log.timestamp.getTime()}-${log.message}-${Math.random().toString()}`).digest('hex').slice(0, 16),
    };
    
    this.pendingLogs.push(logWithId);
    
    if (this.pendingLogs.length >= this.config.batchSize) {
      await this.flushLogs();
    }
  }

  public async flushLogs(): Promise<void> {
    if (this.pendingLogs.length === 0) return;
    
    const logsToExport = [...this.pendingLogs];
    this.pendingLogs = [];
    
    this.serviceLogger(`Flushing ${logsToExport.length} logs`, 'INFO');
    
    const exportPromises = this.config.targets
      .filter(target => target.active)
      .map(target => this.exportToTarget(target, logsToExport));
    
    try {
      await Promise.allSettled(exportPromises);
    } catch (error) {
      this.serviceLogger(`Error during bulk export: ${error instanceof Error ? error.message : 'Unknown error'}`, 'ERROR');
    }
  }

  private async exportToTarget(target: ExportTarget, logs: LogEvent[]): Promise<void> {
    // Filter logs based on target configuration
    const filteredLogs = logs.filter(log => {
      if (target.filters.categories && !target.filters.categories.includes(log.category)) {
        return false;
      }
      
      if (target.filters.levels && !target.filters.levels.includes(log.level)) {
        return false;
      }
      
      return true;
    });
    
    if (filteredLogs.length === 0) {
      this.serviceLogger(`No logs match filters for target ${target.id}`, 'INFO');
      return;
    }
    
    const formattedLogs = target.format === 'JSON' 
      ? filteredLogs.map(log => JSON.stringify(log))
      : filteredLogs.map(log => this.formatAsCEF(log));
    
    const payload = formattedLogs.join('\n');
    
    let lastError: Error | undefined;
    
    for (let attempt = 0; attempt <= target.retryAttempts; attempt++) {
      try {
        if (target.type === 'SYSLOG') {
          await this.sendToSyslog(target.endpoint, payload, target.headers);
        } else {
          await this.sendToWebhook(target.endpoint, payload, target.headers);
        }
        
        this.serviceLogger(`Successfully exported ${filteredLogs.length} logs to target ${target.id}`, 'INFO');
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.serviceLogger(`Attempt ${attempt + 1} failed for target ${target.id}: ${lastError.message}`, 'WARNING');
        
        if (attempt < target.retryAttempts) {
          await new Promise(resolve => setTimeout(resolve, target.retryDelayMs));
        }
      }
    }
    
    this.serviceLogger(`Failed to export logs to target ${target.id} after ${target.retryAttempts + 1} attempts: ${lastError?.message}`, 'ERROR');
    
    // Log failed exports to database for later review
    await this.prisma.failedLogExport.create({
      data: {
        targetId: target.id,
        payload,
        error: lastError?.message || 'Unknown error',
        attempts: target.retryAttempts + 1,
      },
    });
  }

  private async sendToSyslog(endpoint: string, payload: string, headers?: Record<string, string>): Promise<void> {
    // Implementation for syslog protocol
    // This would typically use a library like syslog-client
    // For this example, we'll simulate with HTTP
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        ...headers,
      },
      body: payload,
    });
    
    if (!response.ok) {
      throw new Error(`Syslog server returned ${response.status}: ${response.statusText}`);
    }
  }

  private async sendToWebhook(endpoint: string, payload: string, headers?: Record<string, string>): Promise<void> {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({ logs: payload }),
    });
    
    if (!response.ok) {
      throw new Error(`Webhook returned ${response.status}: ${response.statusText}`);
    }
  }

  private formatAsCEF(log: LogEvent): string {
    // CEF format: CEF:Version|Device Vendor|Device Product|Device Version|Signature ID|Name|Severity|Extension
    const severityMap = {
      'INFO': 0,
      'WARNING': 4,
      'ERROR': 7,
      'CRITICAL': 10,
    };
    
    const extensions = [
      `src=${log.sourceIp || '-'}`,
      `msg=${log.message}`,
      `cat=${log.category}`,
      `usr=${log.userId || '-'}`,
      `time=${log.timestamp.toISOString()}`,
    ];
    
    if (log.details) {
      Object.entries(log.details).forEach(([key, value]) => {
        extensions.push(`${key}=${value}`);
      });
    }
    
    return `CEF:0|SAOS-DEX|Log-Export|1.0|${log.category}|${log.message}|${severityMap[log.level]}|${extensions.join(' ')}`;
  }

  public async getSecurityLogs(filters?: {
    category?: string;
    level?: LogLevel;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
  }): Promise<LogEvent[]> {
    const whereClause: any = {};
    
    if (filters?.category) {
      whereClause.category = filters.category;
    }
    
    if (filters?.level) {
      whereClause.level = filters.level;
    }
    
    if (filters?.startDate || filters?.endDate) {
      whereClause.timestamp = {};
      if (filters.startDate) {
        whereClause.timestamp.gte = filters.startDate;
      }
      if (filters.endDate) {
        whereClause.timestamp.lte = filters.endDate;
      }
    }
    
    const logs = await this.prisma.securityLog.findMany({
      where: whereClause,
      orderBy: { timestamp: 'desc' },
      take: filters?.limit || 100,
    });
    
    return logs.map(log => ({
      id: log.id,
      timestamp: log.timestamp,
      level: log.level as LogLevel,
      category: log.category as 'SECURITY' | 'AUTH' | 'API' | 'SYSTEM' | 'AUDIT',
      message: log.message,
      details: log.details as Record<string, unknown> || undefined,
      sourceIp: log.sourceIp || undefined,
      userAgent: log.userAgent || undefined,
      userId: log.userId || undefined,
    }));
  }

  public async shutdown(): Promise<void> {
    this.serviceLogger('Shutting down LogExportService', 'INFO');
    this.stopFlushTimer();
    
    if (this.pendingLogs.length > 0) {
      this.serviceLogger(`Flushing remaining ${this.pendingLogs.length} logs before shutdown`, 'INFO');
      await this.flushLogs();
    }
    
    this.serviceLogger('LogExportService shutdown complete', 'INFO');
  }
}

// Initialize the service
const prisma = new PrismaClient();
const configPath = path.join(process.cwd(), 'log-export-config.json');

export const logExportService = new LogExportService(prisma, configPath);

// Example usage
// logExportService.addLog({
//   timestamp: new Date(),
//   level: 'WARNING',
//   category: 'SECURITY',
//   message: 'Multiple failed login attempts detected',
//   details: {
//     ip: '192.168.1.100',
//     attempts: 5,
//   },
//   sourceIp: '192.168.1.100',
// });

// Graceful shutdown
process.on('SIGTERM', async () => {
  await logExportService.shutdown();
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await logExportService.shutdown();
  await prisma.$disconnect();
  process.exit(0);
});