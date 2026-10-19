import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { NextRequest, NextResponse } from 'next/server';

// טיפוסים עבור אירועי אבטחה
type SecurityEventType = 'LOGIN_FAILED' | 'RATE_LIMIT_EXCEEDED' | 'INTRUSION_ATTEMPT' | 'SUSPICIOUS_ACTIVITY';

interface SecurityEvent {
  id: string;
  timestamp: Date;
  eventType: SecurityEventType;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  sourceIp: string;
  userAgent?: string;
  requestPath?: string;
  requestBody?: string;
  details?: Record<string, unknown>;
}

interface SecurityLoggerConfig {
  id: string;
  name: string;
  type: 'webhook' | 'syslog' | 'https';
  endpoint: string;
  format: 'json' | 'cef' | 'syslog';
  headers?: Record<string, string>;
  retryCount: number;
  retryDelayMs: number;
}

export class SecurityLoggerService {
  private prisma: PrismaClient;
  private config: SecurityLoggerConfig[];
  private eventQueue: SecurityEvent[] = [];
  private processing = false;

  constructor(prisma: PrismaClient, config: SecurityLoggerConfig[]) {
    this.prisma = prisma;
    this.config = config;
    this.startProcessing();
  }

  // רישום אירוע אבטחה
  async logEvent(event: Omit<SecurityEvent, 'id'>): Promise<void> {
    const securityEvent: SecurityEvent = {
      ...event,
      id: createHash('sha256').update(`${event.timestamp.toISOString()}-${event.sourceIp}-${event.eventType}`).digest('hex').slice(0, 16),
    };
    
    // שמירה למסד הנתונים
    await this.prisma.securityEvent.create({
      data: {
        id: securityEvent.id,
        timestamp: securityEvent.timestamp,
        eventType: securityEvent.eventType,
        severity: securityEvent.severity,
        sourceIp: securityEvent.sourceIp,
        userAgent: securityEvent.userAgent,
        requestPath: securityEvent.requestPath,
        requestBody: securityEvent.requestBody,
        details: securityEvent.details,
      },
    });
    
    // הוספה לתור לעיבוד
    this.eventQueue.push(securityEvent);
  }

  // עיבוץ התור ברקע
  private startProcessing(): void {
    if (this.processing) return;
    this.processing = true;
    
    setInterval(async () => {
      if (this.eventQueue.length === 0) return;
      
      const event = this.eventQueue.shift();
      if (!event) return;
      
      // שליחה לכל היעדים המוגדרים
      const promises = this.config.map(config => this.sendToDestination(event, config));
      await Promise.allSettled(promises);
    }, 1000); // בדיקה כל שנייה
  }

  // שליחת אירוע ליעד ספציפי
  private async sendToDestination(event: SecurityEvent, config: SecurityLoggerConfig): Promise<void> {
    let payload: string;
    
    // יצירת הפיילוד לפי פורמט
    switch (config.format) {
      case 'json':
        payload = JSON.stringify(event);
        break;
      case 'cef':
        payload = this.formatAsCEF(event);
        break;
      case 'syslog':
        payload = this.formatAsSyslog(event);
        break;
      default:
        throw new Error(`Unsupported format: ${config.format}`);
    }
    
    // ניסיונות חוזרים במקרה של כשל
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < config.retryCount; attempt++) {
      try {
        if (config.type === 'webhook' || config.type === 'https') {
          await fetch(config.endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...config.headers,
            },
            body: payload,
          });
        } else if (config.type === 'syslog') {
          // בפועל, היינו משתמשים בספריית syslog
          // לדוגמה: syslogClient.info(payload);
          console.log(`Syslog: ${payload}`);
        }
        return; // הצליח
      } catch (error) {
        lastError = error as Error;
        if (attempt < config.retryCount - 1) {
          await new Promise(resolve => setTimeout(resolve, config.retryDelayMs));
        }
      }
    }
    
    // אם נכשל לאחר כל הניסיונות
    throw new Error(`Failed to send event after ${config.retryCount} attempts. Last error: ${lastError?.message}`);
  }

  // פורמט CEF
  private formatAsCEF(event: SecurityEvent): string {
    const cefHeader = 'CEF:0|SAOS-DEX|SecurityLogger|1.0|';
    const cefExtensions = `
    src=${event.sourceIp}
    spt=${event.eventType}
    severity=${this.mapSeverityToCEF(event.severity)}
    msg=${event.eventType}
    dvc=${event.requestPath || 'unknown'}
    `;
    return `${cefHeader}${event.id}|${cefExtensions}`;
  }

  // פורמט Syslog
  private formatAsSyslog(event: SecurityEvent): string {
    const severityMap = {
      'LOW': 6, // Informational
      'MEDIUM': 4, // Warning
      'HIGH': 3, // Error
      'CRITICAL': 2, // Critical
    };
    
    const facility = 1; // User-level messages
    const severity = severityMap[event.severity];
    const priority = facility * 8 + severity;
    
    const timestamp = event.timestamp.toISOString();
    const hostname = 'saos-dex';
    
    return `<${priority}>1 ${timestamp} ${hostname} SecurityLogger - - ${event.eventType}: ${event.sourceIp} - ${event.details}`;
  }

  // מיפוי רמת חומרה ל-CEF
  private mapSeverityToCEF(severity: string): number {
    switch (severity) {
      case 'LOW': return 0;
      case 'MEDIUM': return 5;
      case 'HIGH': return 8;
      case 'CRITICAL': return 10;
      default: return 3;
    }
  }

  // סנכרון היסטורי של אירועים
  async syncHistoricalEvents(): Promise<void> {
    const events = await this.prisma.securityEvent.findMany({
      where: {
        exported: false,
      },
    });
    
    for (const event of events) {
      const securityEvent: SecurityEvent = {
        id: event.id,
        timestamp: event.timestamp,
        eventType: event.eventType as SecurityEventType,
        severity: event.severity,
        sourceIp: event.sourceIp,
        userAgent: event.userAgent,
        requestPath: event.requestPath,
        requestBody: event.requestBody,
        details: event.details,
      };
      
      // שליחה לכל היעדים
      const promises = this.config.map(config => this.sendToDestination(securityEvent, config));
      await Promise.allSettled(promises);
      
      // סימון כי יוצא
      await this.prisma.securityEvent.update({
        where: { id: event.id },
        data: { exported: true },
      });
    }
  }
}

// יצירת מופע שירות גלובלי
let securityLoggerService: SecurityLoggerService | null = null;

export function getSecurityLoggerService(): SecurityLoggerService {
  if (!securityLoggerService) {
    throw new Error('SecurityLoggerService not initialized');
  }
  return securityLoggerService;
}

// התחלת השירות
export function initializeSecurityLoggerService(prisma: PrismaClient, config: SecurityLoggerConfig[]): void {
  securityLoggerService = new SecurityLoggerService(prisma, config);
}

// API Route לקבלת אירועי אבטחה (למערכות חיצוניות)
export async function GET(request: NextRequest) {
  try {
    const prisma = new PrismaClient();
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '100', 10);
    const offset = parseInt(searchParams.get('offset') || '0', 10);
    
    const events = await prisma.securityEvent.findMany({
      orderBy: { timestamp: 'desc' },
      take: limit,
      skip: offset,
    });
    
    return NextResponse.json({
      success: true,
      events,
      total: await prisma.securityEvent.count(),
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Failed to retrieve security events' },
      { status: 500 }
    );
  }
}

// API Route להוספת אירוע אבטחה (למערכות חיצוניות)
export async function POST(request: NextRequest) {
  try {
    const prisma = new PrismaClient();
    const event = await request.json();
    
    // אימות האירוע
    if (!event.eventType || !event.severity || !event.sourceIp) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields' },
        { status: 400 }
      );
    }
    
    const securityEvent: SecurityEvent = {
      id: createHash('sha256').update(`${new Date().toISOString()}-${event.sourceIp}-${event.eventType}`).digest('hex').slice(0, 16),
      timestamp: new Date(),
      eventType: event.eventType as SecurityEventType,
      severity: event.severity,
      sourceIp: event.sourceIp,
      userAgent: event.userAgent,
      requestPath: event.requestPath,
      requestBody: event.requestBody,
      details: event.details,
    };
    
    await prisma.securityEvent.create({
      data: {
        id: securityEvent.id,
        timestamp: securityEvent.timestamp,
        eventType: securityEvent.eventType,
        severity: securityEvent.severity,
        sourceIp: securityEvent.sourceIp,
        userAgent: securityEvent.userAgent,
        requestPath: securityEvent.requestPath,
        requestBody: securityEvent.requestBody,
        details: securityEvent.details,
      },
    });
    
    // אם השירות מוגדר, שלח גם ליעדים החיצוניים
    if (securityLoggerService) {
      await securityLoggerService.logEvent(securityEvent);
    }
    
    return NextResponse.json({ success: true, id: securityEvent.id });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Failed to create security event' },
      { status: 500 }
    );
  }
}
