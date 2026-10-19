import { NextRequest, NextResponse } from 'next/server';

// סוגי אירועי אבטחה
export type SecurityEventType = 'login_failed' | 'rate_limit_exceeded' | 'suspicious_activity' | 'access_denied' | 'policy_violation';

// מבנה אירוע אבטחה
type SecurityEvent = {
  timestamp: string;
  eventType: SecurityEventType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  sourceIp: string;
  userAgent?: string;
  endpoint: string;
  details: Record<string, unknown>;
  userId?: string;
};

// תצורת ייצוא לוגים
type ExportConfig = {
  syslog: {
    enabled: boolean;
    host: string;
    port: number;
    facility: number;
  };
  webhook: {
    enabled: boolean;
    url: string;
    headers?: Record<string, string>;
  };
  cef: {
    enabled: boolean;
    deviceId: string;
    deviceVersion: string;
  };
};

// מצב גלובלי לתצורה (במקום משתני סביבה לפשטות)
const exportConfig: ExportConfig = {
  syslog: {
    enabled: process.env.SYSLOG_ENABLED === 'true',
    host: process.env.SYSLOG_HOST || 'localhost',
    port: parseInt(process.env.SYSLOG_PORT || '514', 10),
    facility: parseInt(process.env.SYSLOG_FACILITY || '16', 10), // local 0
  },
  webhook: {
    enabled: process.env.WEBHOOK_ENABLED === 'true',
    url: process.env.WEBHOOK_URL || '',
    headers: process.env.WEBHOOK_HEADERS ? JSON.parse(process.env.WEBHOOK_HEADERS) : undefined,
  },
  cef: {
    enabled: process.env.CEF_ENABLED === 'true',
    deviceId: 'SAOS-DEX',
    deviceVersion: '1.0',
  },
};

/**
 * ייצור אירוע אבטחה ושליחתו למערכות חיצוני�
 * @param event אירוע האבטחה
 * @param config תצורת הייצוא
 */
export async function exportSecurityEvent(event: SecurityEvent, config: ExportConfig = exportConfig): Promise<void> {
  // הוספת חותמת זמן אם לא קיימת
  if (!event.timestamp) {
    event.timestamp = new Date().toISOString();
  }

  // ייצוא ל-Syslog
  if (config.syslog.enabled) {
    await exportToSyslog(event, config.syslog);
  }

  // ייצוא ל-HTTP Webhook
  if (config.webhook.enabled) {
    await exportToWebhook(event, config.webhook);
  }

  // ייצוא בפורמט CEF
  if (config.cef.enabled) {
    await exportToCEF(event, config.cef);
  }
}

/**
 * ייצוא ל-Syslog
 * @param event אירוע האבטחה
 * @param syslogConfig תצורת Syslog
 */
async function exportToSyslog(event: SecurityEvent, syslogConfig: ExportConfig['syslog']): Promise<void> {
  try {
    // יצירת הודעת Syslog
    const priority = (syslogConfig.facility * 8) + 6; // 6 = Informational
    const version = 1;
    const timestamp = new Date().toISOString();
    const hostname = 'saos-dex';
    
    // יצירת גוף ההודעה בפורמט JSON
    const message = JSON.stringify({
      event,
      source: 'saos-dex-security',
    });
    
    // בניית הודעת Syslog לפי RFC 3164
    const syslogMessage = `<${priority}>${version} ${timestamp} ${hostname} saos-dex-security: ${message}`;
    
    // שליחה ל-Syslog (פשטות - ביישום מלא ישתמש בספרייה מתאימה)
    const response = await fetch(`http://${syslogConfig.host}:${syslogConfig.port}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
      },
      body: syslogMessage,
    });
    
    if (!response.ok) {
      console.error('Syslog export failed:', await response.text());
    }
  } catch (error) {
    console.error('Syslog export error:', error);
  }
}

/**
 * ייצוא ל-HTTP Webhook
 * @param event אירוע האבטחה
 * @param webhookConfig תצורת Webhook
 */
async function exportToWebhook(event: SecurityEvent, webhookConfig: ExportConfig['webhook']): Promise<void> {
  try {
    const response = await fetch(webhookConfig.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(webhookConfig.headers || {}),
      },
      body: JSON.stringify(event),
    });
    
    if (!response.ok) {
      console.error('Webhook export failed:', await response.text());
    }
  } catch (error) {
    console.error('Webhook export error:', error);
  }
}

/**
 * ייצוא בפורמט CEF (Common Event Format)
 * @param event אירוע האבטחה
 * @param cefConfig תצורת CEF
 */
async function exportToCEF(event: SecurityEvent, cefConfig: ExportConfig['cef']): Promise<void> {
  try {
    // מיפוי סוגי אירועים ל-CEF
    const cefExtensions: Record<SecurityEventType, Record<string, string>> = {
      login_failed: {
        msg: 'Failed login attempt',
        src: event.sourceIp,
        dvc: event.endpoint,
      },
      rate_limit_exceeded: {
        msg: 'Rate limit exceeded',
        src: event.sourceIp,
        dvc: event.endpoint,
        count: event.details.count?.toString() || 'unknown',
      },
      suspicious_activity: {
        msg: 'Suspicious activity detected',
        src: event.sourceIp,
        dvc: event.endpoint,
        reason: event.details.reason?.toString() || 'unknown',
      },
      access_denied: {
        msg: 'Access denied',
        src: event.sourceIp,
        dvc: event.endpoint,
        resource: event.details.resource?.toString() || 'unknown',
      },
      policy_violation: {
        msg: 'Policy violation',
        src: event.sourceIp,
        dvc: event.endpoint,
        policy: event.details.policy?.toString() || 'unknown',
      },
    };
    
    // קביעת רמת חומרה ל-CEF
    const severityMap: Record<string, number> = {
      low: 0,
      medium: 5,
      high: 8,
      critical: 10,
    };
    
    // יצירת פורמט CEF
    const cefMessage = `CEF:0|${cefConfig.deviceId}|${cefConfig.deviceVersion}|SAOS-DEX|security|${event.eventType}|${severityMap[event.severity] || 5}|${JSON.stringify(cefExtensions[event.eventType])}`;
    
    // שליחה ל-Webhook עם פורמט CEF
    const response = await fetch(webhookConfig.url || '', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
      },
      body: cefMessage,
    });
    
    if (!response.ok) {
      console.error('CEF export failed:', await response.text());
    }
  } catch (error) {
    console.error('CEF export error:', error);
  }
}

/**
 * API Route לניהול ייצור לוגי אבטחה
 * GET /api/security/logs - קבלת רשימת אירועים
 * POST /api/security/logs - יצור אירוע חדש
 * POST /api/security/logs/export - ייצוא אירועים למערכות חיצוניות
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    // קבלת פרמטרי שאילתה
    const { searchParams } = new URL(request.url);
    const eventType = searchParams.get('eventType') as SecurityEventType | null;
    const severity = searchParams.get('severity') as 'low' | 'medium' | 'high' | 'critical' | null;
    const limit = parseInt(searchParams.get('limit') || '100', 10);
    
    // כאן יהיה שאילתת מסד הנתונים (SQLite)
    // לדוגמה: SELECT * FROM security_events WHERE eventType = ? AND severity = ? LIMIT ?
    const events: SecurityEvent[] = [];
    
    return NextResponse.json({
      success: true,
      events,
      count: events.length,
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Failed to retrieve security logs' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json() as SecurityEvent;
    
    // אימות האירוע
    if (!body.eventType || !body.severity || !body.sourceIp || !body.endpoint) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields in security event' },
        { status: 400 }
      );
    }
    
    // שמירה למסד הנתונים (SQLite)
    // לדוגמה: INSERT INTO security_events (...) VALUES (...)
    
    // ייצור האירוע למערכות חיצוניות
    await exportSecurityEvent(body);
    
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Failed to process security event' },
      { status: 500 }
    );
  }
}

// דוגמה לשימוש מתוך המערכת
export function logSecurityEvent(eventType: SecurityEventType, severity: 'low' | 'medium' | 'high' | 'critical', sourceIp: string, endpoint: string, details: Record<string, unknown>, userId?: string): void {
  const event: SecurityEvent = {
    timestamp: new Date().toISOString(),
    eventType,
    severity,
    sourceIp,
    endpoint,
    details,
    userId,
  };
  
  // שמירה למסד הנתונים
  // לדוגמה: await db.securityEvent.create({ data: event })
  
  // ייצור למערכות חיצוניות
  exportSecurityEvent(event).catch(console.error);
}

// דוגמה לשימות ב-middleware.ts
// logSecurityEvent('rate_limit_exceeded', 'medium', req.ip || 'unknown', req.nextUrl.pathname, { count: currentCount });
