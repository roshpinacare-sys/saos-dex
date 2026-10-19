import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';

const prisma = new PrismaClient();

// Security event types
enum SecurityEventType {
  AUTHENTICATION_FAILED = 'AUTHENTICATION_FAILED',
  AUTHENTICATION_SUCCESS = 'AUTHENTICATION_SUCCESS',
  AUTHORIZATION_FAILED = 'AUTHORIZATION_FAILED',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  SUSPICIOUS_REQUEST = 'SUSPICIOUS_REQUEST',
  MALFORMED_REQUEST = 'MALFORMED_REQUEST',
  API_ABUSE = 'API_ABUSE',
  DATA_BREACH_ATTEMPT = 'DATA_BREACH_ATTEMPT',
}

// Security event severity levels
enum SecuritySeverity {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

// Configuration interface
interface SecurityLoggerConfig {
  enabled: boolean;
  formats: ('cef' | 'json')[];
  targets: {
    syslog?: {
      host: string;
      port: number;
      facility: number;
    };
    webhook?: {
      url: string;
      timeout: number;
      headers: Record<string, string>;
    };
  };
}

// Default configuration
const DEFAULT_CONFIG: SecurityLoggerConfig = {
  enabled: true,
  formats: ['json'],
  targets: {
    webhook: {
      url: '',
      timeout: 5000,
      headers: {
        'Content-Type': 'application/json',
      },
    },
  },
};

// Security log entry interface
interface SecurityLogEntry {
  id: string;
  timestamp: Date;
  eventType: SecurityEventType;
  severity: SecuritySeverity;
  sourceIp: string;
  userAgent: string;
  sessionId?: string;
  userId?: string;
  resourceId?: string;
  description: string;
  details: Record<string, unknown>;
}

// Security logger service
class SecurityLogger {
  private config: SecurityLoggerConfig;

  constructor(config: Partial<SecurityLoggerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // Create a security log entry
  async logSecurityEvent(
    eventType: SecurityEventType,
    severity: SecuritySeverity,
    request: NextRequest,
    description: string,
    details: Record<string, unknown> = {},
    userId?: string,
    resourceId?: string
  ): Promise<void> {
    if (!this.config.enabled) return;

    const sessionId = request.headers.get('x-session-id') || undefined;
    const sourceIp = this.getClientIp(request);
    const userAgent = request.headers.get('user-agent') || '';

    const logEntry: SecurityLogEntry = {
      id: createHash('sha256').update(`${Date.now()}-${eventType}-${sourceIp}`).digest('hex'),
      timestamp: new Date(),
      eventType,
      severity,
      sourceIp,
      userAgent,
      sessionId,
      userId,
      resourceId,
      description,
      details,
    };

    // Save to database
    await prisma.securityLog.create({
      data: {
        id: logEntry.id,
        timestamp: logEntry.timestamp,
        eventType: logEntry.eventType,
        severity: logEntry.severity,
        sourceIp: logEntry.sourceIp,
        userAgent: logEntry.userAgent,
        sessionId: logEntry.sessionId,
        userId: logEntry.userId,
        resourceId: logEntry.resourceId,
        description: logEntry.description,
        details: logEntry.details,
      },
    });

    // Export to external targets
    for (const format of this.config.formats) {
      if (format === 'json') {
        await this.exportToTargets(logEntry);
      } else if (format === 'cef') {
        const cefMessage = this.formatAsCEF(logEntry);
        await this.exportToTargets(cefMessage, 'text/plain');
      }
    }
  }

  // Get client IP from request
  private getClientIp(request: NextRequest): string {
    return (
      request.headers.get('x-forwarded-for') ||
      request.headers.get('x-real-ip') ||
      request.ip ||
      'unknown'
    );
  }

  // Format log entry as CEF
  private formatAsCEF(logEntry: SecurityLoggerEntry): string {
    const cefVersion = '0';
    const deviceVendor = 'SAOS-DEX';
    const deviceProduct = 'SecurityLogger';
    const deviceVersion = '1.0';
    const signatureId = logEntry.eventType;
    const name = logEntry.description;
    const severity = this.mapSeverityToCEF(logEntry.severity);

    const details = Object.entries(logEntry.details)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');

    return `CEF:${cefVersion}|${deviceVendor}|${deviceProduct}|${deviceVersion}|${signatureId}|${name}|${severity}|${details}`;
  }

  // Map severity to CEF severity
  private mapSeverityToCEF(severity: SecuritySeverity): number {
    switch (severity) {
      case SecuritySeverity.LOW:
        return 0;
      case SecuritySeverity.MEDIUM:
        return 4;
      case SecuritySeverity.HIGH:
        return 7;
      case SecuritySeverity.CRITICAL:
        return 10;
      default:
        return 0;
    }
  }

  // Export to configured targets
  private async exportToTargets(
    data: SecurityLogEntry | string,
    contentType: string = 'application/json'
  ): Promise<void> {
    // Export to webhook if configured
    if (this.config.targets.webhook?.url) {
      try {
        await fetch(this.config.targets.webhook.url, {
          method: 'POST',
          headers: {
            ...this.config.targets.webhook.headers,
            'Content-Type': contentType,
          },
          body: typeof data === 'string' ? data : JSON.stringify(data),
          signal: AbortSignal.timeout(this.config.targets.webhook.timeout),
        });
      } catch (error) {
        console.error('Failed to export security log to webhook:', error);
      }
    }

    // Export to syslog if configured
    if (this.config.targets.syslog) {
      try {
        // Implementation would use a syslog client library
        // For this example, we'll just log to console
        console.log(`Syslog export not implemented in this example`);
      } catch (error) {
        console.error('Failed to export security log to syslog:', error);
      }
    }
  }
}

// Create singleton instance
const securityLogger = new SecurityLogger();

// Middleware to intercept requests
export async function middleware(request: NextRequest): Promise<NextResponse | void> {
  // Add security logging for all API requests
  if (request.nextUrl.pathname.startsWith('/api/')) {
    // Log the request
    await securityLogger.logSecurityEvent(
      SecurityEventType.SUSPICIOUS_REQUEST,
      SecuritySeverity.LOW,
      request,
      `API request to ${request.nextUrl.pathname}`,
      {
        method: request.method,
        path: request.nextUrl.pathname,
        headers: Object.fromEntries(request.headers.entries()),
      }
    );

    // Check for potential security issues
    const userAgent = request.headers.get('user-agent');
    if (userAgent && (userAgent.includes('bot') || userAgent.includes('crawler'))) {
      await securityLogger.logSecurityEvent(
        SecurityEventType.SUSPICIOUS_REQUEST,
        SecuritySeverity.MEDIUM,
        request,
        'Potential bot/crawler detected',
        { userAgent }
      );
    }

    // Check for malformed requests
    if (request.method === 'POST' || request.method === 'PUT') {
      try {
        const body = await request.clone().text();
        try {
          JSON.parse(body);
        } catch {
          await securityLogger.logSecurityEvent(
            SecurityEventType.MALFORMED_REQUEST,
            SecuritySeverity.MEDIUM,
            request,
            'Malformed JSON request body',
            { bodyPreview: body.substring(0, 100) }
          );
        }
      } catch (error) {
        await securityLogger.logSecurityEvent(
          SecurityEventType.MALFORMED_REQUEST,
          SecuritySeverity.MEDIUM,
          request,
          'Error reading request body',
          { error: (error as Error).message }
        );
      }
    }
  }

  // Continue with the request
  return NextResponse.next();
}

// API routes for security logging
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const eventId = searchParams.get('id');

  if (eventId) {
    // Get a specific security log entry
    const logEntry = await prisma.securityLog.findUnique({
      where: { id: eventId },
    });

    if (!logEntry) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    return NextResponse.json(logEntry);
  }

  // Get all security log entries with pagination
  const page = parseInt(searchParams.get('page') || '1', 10);
  const limit = parseInt(searchParams.get('limit') || '10', 10);
  const offset = (page - 1) * limit;

  const [events, total] = await Promise.all([
    prisma.securityLog.findMany({
      orderBy: { timestamp: 'desc' },
      skip: offset,
      take: limit,
    }),
    prisma.securityLog.count(),
  ]);

  return NextResponse.json({
    events,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const { eventType, severity, description, details, userId, resourceId } = body;

    // Validate required fields
    if (!eventType || !severity || !description) {
      return NextResponse.json(
        { error: 'Missing required fields: eventType, severity, description' },
        { status: 400 }
      );
    }

    // Log the security event
    await securityLogger.logSecurityEvent(
      eventType as SecurityEventType,
      severity as SecuritySeverity,
      request,
      description,
      details || {},
      userId,
      resourceId
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: 'Invalid request body', details: (error as Error).message },
      { status: 400 }
    );
  }
}

// Prisma schema for security logs
// Add this to your schema.prisma file:
// model SecurityLog {
//   id          String   @id @default(cuid())
//   timestamp   DateTime
//   eventType   String
//   severity    String
//   sourceIp    String
//   userAgent   String?
//   sessionId   String?
//   userId      String?
//   resourceId  String?
//   description String
//   details     Json
//   createdAt   DateTime @default(now())
//   updatedAt   DateTime @updatedAt
// }
