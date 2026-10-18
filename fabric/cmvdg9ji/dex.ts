import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
import { writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const db = new PrismaClient();

interface AccessLog {
  id: string;
  timestamp: number;
  resource: string;
  action: 'read' | 'write' | 'execute' | 'delete';
  ipAddress: string;
  userAgent?: string;
  success: boolean;
  riskScore: number;
  metadata?: Record<string, unknown>;
}

class AccessMonitor {
  private logDir: string;
  private alerts: Array<{ timestamp: number; message: string; severity: 'low' | 'medium' | 'high' }>;
  
  constructor() {
    this.logDir = join(process.cwd(), 'logs', 'access');
    this.alerts = [];
    this.ensureLogDirectory();
  }

  private ensureLogDirectory(): void {
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true });
    }
  }

  private generateId(): string {
    return createHash('sha256').update(Date.now().toString() + Math.random().toString()).digest('hex').substring(0, 16);
  }

  private calculateRiskScore(resource: string, ipAddress: string, success: boolean): number {
    let score = 0;
    
    // High-risk resources
    const highRiskResources = ['.env', 'private_key', 'wallet', 'secret', 'config'];
    if (highRiskResources.some(r => resource.toLowerCase().includes(r))) {
      score += 30;
    }
    
    // Failed access attempts increase risk
    if (!success) {
      score += 25;
    }
    
    // Check for suspicious IPs (simplified - in production would use threat intel)
    const suspiciousPatterns = ['10.', '192.168.', '172.16.'];
    if (suspiciousPatterns.some(pattern => ipAddress.startsWith(pattern))) {
      score += 15;
    }
    
    // Time-based risk (off-hours access)
    const hour = new Date().getHours();
    if (hour < 6 || hour > 22) {
      score += 10;
    }
    
    return Math.min(score, 100);
  }

  async logAccess(resource: string, action: AccessLog['action'], ipAddress: string, success: boolean, metadata?: Record<string, unknown>): Promise<void> {
    const timestamp = Date.now();
    const riskScore = this.calculateRiskScore(resource, ipAddress, success);
    
    const logEntry: AccessLog = {
      id: this.generateId(),
      timestamp,
      resource,
      action,
      ipAddress,
      success,
      riskScore,
      metadata: metadata || {}
    };
    
    // Store in database
    try {
      await db.accessLog.create({
        data: logEntry
      });
    } catch (error) {
      console.error('Failed to store access log in database:', error);
    }
    
    // Also log to file for backup
    const logLine = JSON.stringify(logEntry) + '\n';
    const logFile = join(this.logDir, `access-${new Date().toISOString().split('T')[0]}.log`);
    appendFileSync(logFile, logLine);
    
    // Generate alert if risk score is high
    if (riskScore >= 70) {
      this.generateAlert(`High-risk access detected: ${action} on ${resource} from ${ipAddress}`, 'high');
    } else if (riskScore >= 40) {
      this.generateAlert(`Suspicious access: ${action} on ${resource} from ${ipAddress}`, 'medium');
    }
    
    // Check for brute force patterns
    await this.detectBruteForce(ipAddress, resource);
  }

  private generateAlert(message: string, severity: 'low' | 'medium' | 'high'): void {
    const alert = {
      timestamp: Date.now(),
      message,
      severity
    };
    
    this.alerts.push(alert);
    
    // Keep only last 1000 alerts in memory
    if (this.alerts.length > 1000) {
      this.alerts = this.alerts.slice(-1000);
    }
    
    // Log to alert file
    const alertLine = JSON.stringify(alert) + '\n';
    const alertFile = join(this.logDir, 'alerts.log');
    appendFileSync(alertFile, alertLine);
    
    // In production, this would send to external alerting system (Slack, email, etc.)
    console[severity === 'high' ? 'error' : severity === 'medium' ? 'warn' : 'log'](`[ACCESS ALERT] ${message}`);
  }

  private async detectBruteForce(ipAddress: string, resource: string): Promise<void> {
    const oneHourAgo = Date.now() - 3600000;
    
    try {
      const recentFailedAttempts = await db.accessLog.count({
        where: {
          ipAddress,
          success: false,
          timestamp: {
            gte: oneHourAgo
          }
        }
      });
      
      if (recentFailedAttempts >= 10) {
        this.generateAlert(`Potential brute force attack from ${ipAddress}: ${recentFailedAttempts} failed attempts in last hour`, 'high');
      }
    } catch (error) {
      console.error('Error checking for brute force patterns:', error);
    }
  }

  async getDailyReport(date: Date = new Date()): Promise<{
    totalAttempts: number;
    failedAttempts: number;
    uniqueIPs: number;
    highRiskEvents: number;
    topResources: Array<{ resource: string; count: number }>;
    topIPs: Array<{ ip: string; count: number }>;
  }> {
    const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const endOfDay = startOfDay + 86400000;
    
    try {
      const logs = await db.accessLog.findMany({
        where: {
          timestamp: {
            gte: startOfDay,
            lt: endOfDay
          }
        }
      });
      
      const totalAttempts = logs.length;
      const failedAttempts = logs.filter(log => !log.success).length;
      const uniqueIPs = new Set(logs.map(log => log.ipAddress)).size;
      const highRiskEvents = logs.filter(log => log.riskScore >= 70).length;
      
      // Top resources
      const resourceCounts: Record<string, number> = {};
      logs.forEach(log => {
        resourceCounts[log.resource] = (resourceCounts[log.resource] || 0) + 1;
      });
      const topResources = Object.entries(resourceCounts)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 10)
        .map(([resource, count]) => ({ resource, count }));
      
      // Top IPs
      const ipCounts: Record<string, number> = {};
      logs.forEach(log => {
        ipCounts[log.ipAddress] = (ipCounts[log.ipAddress] || 0) + 1;
      });
      const topIPs = Object.entries(ipCounts)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 10)
        .map(([ip, count]) => ({ ip, count }));
      
      return {
        totalAttempts,
        failedAttempts,
        uniqueIPs,
        highRiskEvents,
        topResources,
        topIPs
      };
    } catch (error) {
      console.error('Error generating daily report:', error);
      return {
        totalAttempts: 0,
        failedAttempts: 0,
        uniqueIPs: 0,
        highRiskEvents: 0,
        topResources: [],
        topIPs: []
      };
    }
  }

  async getRecentAlerts(limit: number = 50): Promise<Array<{ timestamp: number; message: string; severity: 'low' | 'medium' | 'high' }>> {
    return this.alerts.slice(-limit).reverse();
  }

  async cleanupOldLogs(daysToKeep: number = 30): Promise<void> {
    const cutoffDate = Date.now() - (daysToKeep * 86400000);
    
    try {
      await db.accessLog.deleteMany({
        where: {
          timestamp: {
            lt: cutoffDate
          }
        }
      });
      
      // Cleanup old log files
      const fs = await import('fs');
      const files = fs.readdirSync(this.logDir);
      const cutoff = new Date(cutoffDate);
      
      for (const file of files) {
        if (file.endsWith('.log')) {
          const filePath = join(this.logDir, file);
          const stats = fs.statSync(filePath);
          if (stats.mtime < cutoff) {
            fs.unlinkSync(filePath);
          }
        }
      }
    } catch (error) {
      console.error('Error cleaning up old logs:', error);
    }
  }
}

// Singleton instance
let accessMonitorInstance: AccessMonitor | null = null;

export function getAccessMonitor(): AccessMonitor {
  if (!accessMonitorInstance) {
    accessMonitorInstance = new AccessMonitor();
  }
  return accessMonitorInstance;
}

// Middleware function for Next.js API routes
export function accessMonitorMiddleware() {
  return async (req: Request, next: () => Promise<Response>) => {
    const monitor = getAccessMonitor();
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 
                req.headers.get('x-real-ip') || 
                'unknown';
    
    const userAgent = req.headers.get('user-agent') || undefined;
    const resource = new URL(req.url).pathname;
    const method = req.method as AccessLog['action'];
    
    // Map HTTP methods to our action types
    const actionMap: Record<string, AccessLog['action']> = {
      GET: 'read',
      POST: 'write',
      PUT: 'write',
      PATCH: 'write',
      DELETE: 'delete'
    };
    
    const action = actionMap[method] || 'execute';
    
    try {
      const response = await next();
      const success = response.status < 400;
      
      await monitor.logAccess(resource, action, ip, success, { 
        userAgent,
        statusCode: response.status,
        method
      });
      
      return response;
    } catch (error) {
      await monitor.logAccess(resource, action, ip, false, { 
        userAgent,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  };
}

// Export types for use in other modules
export type { AccessLog };
export default AccessMonitor;