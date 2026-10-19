import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

// ייצור הפניה ל-Prisma
const prisma = new PrismaClient();

// טיפוסים לאירועי אבטחה
export enum SecurityEventType {
  LOGIN_FAILED = 'login-failed',
  RATE_LIMIT_EXCEEDED = 'rate-limit-exceeded',
  UNAUTHORIZED_ACCESS = 'unauthorized-access',
  USER_MANAGEMENT_ANOMALY = 'user-management-anomaly',
}

export enum SecurityEventSeverity {
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
}

export interface SecurityEvent {
  timestamp: Date;
  event_type: SecurityEventType;
  source_ip: string;
  user_id?: string;
  severity: SecurityEventSeverity;
  details: Record<string, unknown>;
}

// הגדרות קונפיגורציה מסביבה
const config = {
  syslog: {
    enabled: process.env.SYSLOG_ENABLED === 'true',
    host: process.env.SYSLOG_HOST,
    port: parseInt(process.env.SYSLOG_PORT || '514', 10),
  },
  webhook: {
    enabled: process.env.WEBHOOK_ENABLED === 'true',
    url: process.env.WEBHOOK_URL,
    timeout: parseInt(process.env.WEBHOOK_TIMEOUT || '5000', 10),
  },
  logLevel: (process.env.LOG_LEVEL || 'info') as SecurityEventSeverity,
};

// פונקציה ליצירת אירוע אבטחה
export function createSecurityEvent(
  eventType: SecurityEventType,
  sourceIp: string,
  severity: SecurityEventSeverity,
  details: Record<string, unknown>,
  userId?: string
): SecurityEvent {
  return {
    timestamp: new Date(),
    event_type: eventType,
    source_ip: sourceIp,
    user_id: userId,
    severity,
    details,
  };
}

// פונקציה לרישום אירוע ב-SQLite
export async function logSecurityEvent(event: SecurityEvent): Promise<void> {
  try {
    await prisma.securityEvent.create({
      data: {
        timestamp: event.timestamp,
        eventType: event.event_type,
        sourceIp: event.source_ip,
        userId: event.user_id || null,
        severity: event.severity,
        details: event.details,
      },
    });
  } catch (error) {
    console.error('Failed to log security event to database:', error);
    throw error;
  }
}

// פונקציה לשליחת אירוע ל-Syslog
export async function sendToSyslog(event: SecurityEvent): Promise<void> {
  if (!config.syslog.enabled || !config.syslog.host) {
    return;
  }

  try {
    // יצירת מסר Syslog לפי RFC 3164
    const timestamp = event.timestamp.toISOString().replace('T', ' ').replace('Z', '');
    const priority = 13 * 8 + (event.severity === 'error' ? 3 : event.severity === 'warn' ? 2 : 1); // 13=local use, 1-7=severity
    const messageId = `<${priority}>1 ${timestamp} saos-dex security-events ${process.env.HOSTNAME || 'unknown'} ${event.event_type} -`;
    
    const message = `${messageId} ${JSON.stringify(event)}`;
    
    // כאן יהיה קוד לשליחת המסר לשרת Syslog
    // בפועל, היינו משתמשים בספרייה כמו syslog-client
    console.log('Syslog message:', message);
  } catch (error) {
    console.error('Failed to send event to syslog:', error);
    throw error;
  }
}

// פונקציה לשליחת אירוע ל-webhook
export async function sendToWebhook(event: SecurityEvent): Promise<void> {
  if (!config.webhook.enabled || !config.webhook.url) {
    return;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.webhook.timeout);
    
    const response = await fetch(config.webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(event),
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`Webhook responded with status ${response.status}`);
    }
    
    console.log('Event successfully sent to webhook');
  } catch (error) {
    console.error('Failed to send event to webhook:', error);
    throw error;
  }
}

// פונקציה מרכזית לטיפול באירוע אבטחה
export async function handleSecurityEvent(event: SecurityEvent): Promise<void> {
  // בדיקת רמת חומרה
  if (event.severity < config.logLevel) {
    return;
  }

  try {
    // רישום ל-SQLite
    await logSecurityEvent(event);
    
    // שליחה ל-Syslog
    if (config.syslog.enabled) {
      await sendToSyslog(event);
    }
    
    // שליחה ל-webhook
    if (config.webhook.enabled) {
      await sendToWebhook(event);
    }
  } catch (error) {
    console.error('Error handling security event:', error);
    // אל תשבור את זרימת העבודה בגלאי כשלון בייצוא
  }
}

// פונקציות עזר לרישום אירועים ספציפיים
export async function logLoginFailed(ip: string, userId?: string, reason?: string): Promise<void> {
  const event = createSecurityEvent(
    SecurityEventType.LOGIN_FAILED,
    ip,
    SecurityEventSeverity.WARN,
    { reason: reason || 'Unknown reason' },
    userId
  );
  await handleSecurityEvent(event);
}

export async function logRateLimitExceeded(ip: string, path: string, limit: number, window: number): Promise<void> {
  const event = createSecurityEvent(
    SecurityEventType.RATE_LIMIT_EXCEEDED,
    ip,
    SecurityEventSeverity.INFO,
    { path, limit, window }
  );
  await handleSecurityEvent(event);
}

export async function logUnauthorizedAccess(ip: string, path: string, userId?: string): Promise<void> {
  const event = createSecurityEvent(
    SecurityEventType.UNAUTHORIZED_ACCESS,
    ip,
    SecurityEventSeverity.ERROR,
    { path },
    userId
  );
  await handleSecurityEvent(event);
}

export async function logUserManagementAnomaly(ip: string, userId?: string, action?: string): Promise<void> {
  const event = createSecurityEvent(
    SecurityEventType.USER_MANAGEMENT_ANOMALY,
    ip,
    SecurityEventSeverity.ERROR,
    { action: action || 'Unknown action' },
    userId
  );
  await handleSecurityEvent(event);
}

// ייצור הטבלה ב-Prisma (יש להוסיף בקובץ schema.prisma)
// model SecurityEvent {
//   id        Int      @id @default(autoincrement())
//   timestamp DateTime
//   eventType String
//   sourceIp  String
//   userId    String?
//   severity  String
//   details   Json
//   createdAt DateTime @default(now())
// }
