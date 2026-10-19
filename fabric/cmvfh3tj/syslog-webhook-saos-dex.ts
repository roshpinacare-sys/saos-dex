import { NextRequest, NextResponse } from 'next/server';

// ── סוגי אירועי אבטחה ──
type SecurityEventType = 
  | 'AUTH_FAILURE'
  | 'RATE_LIMIT_EXCEEDED'
  | 'SUSPICIOUS_REQUEST'
  | 'UNAUTHORIZED_ACCESS'
  | 'POLICY_VIOLATION';

// ── ממשק תצורה ──
interface SecurityLogTarget {
  id: string;
  type: 'syslog' | 'webhook';
  endpoint: string;
  format: 'cef' | 'json' | 'rfc5424';
  enabled: boolean;
  headers?: Record<string, string>;
}

interface SecurityLogConfig {
  targets: SecurityLogTarget[];
  thresholds: {
    rateLimit: number;
    suspiciousPattern: number;
  };
}

// ── נתוני אירוע אבטחה ──
interface SecurityEvent {
  timestamp: string;
  type: SecurityEventType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  sourceIp: string;
  userAgent?: string;
  resourceId?: string;
  description: string;
  details?: Record<string, unknown>;
}

// ── מחלקת שירות לוגיקת אבטחה ──
class SecurityLogService {
  private config: SecurityLogConfig;
  private eventBuffer: SecurityEvent[] = [];
  private flushInterval: NodeJS.Timeout;

  constructor(config: SecurityLogConfig) {
    this.config = config;
    // ניקוי מחסנית כל 30 שניות
    this.flushInterval = setInterval(() => this.flushEvents(), 30000);
  }

  // ── רישום אירוע אבטחה ──
  public logEvent(event: Omit<SecurityEvent, 'timestamp'>) {
    const fullEvent: SecurityEvent = {
      ...event,
      timestamp: new Date().toISOString(),
    };
    
    this.eventBuffer.push(fullEvent);
    
    // אם המחסנית מלאה, נקה אותה
    if (this.eventBuffer.length >= 100) {
      this.flushEvents();
    }
  }

  // ── ניתוב אירועים ליעדים ──
  private flushEvents() {
    if (this.eventBuffer.length === 0) return;
    
    const events = [...this.eventBuffer];
    this.eventBuffer = [];
    
    this.config.targets.forEach(target => {
      if (!target.enabled) return;
      
      events.forEach(event => {
        try {
          switch (target.type) {
            case 'syslog':
              this.sendToSyslog(event, target);
              break;
            case 'webhook':
              this.sendToWebhook(event, target);
              break;
          }
        } catch (error) {
          console.error(`Failed to send event to target ${target.id}:`, error);
        }
      });
    });
  }

  // ── שליחה ל-Syslog ──
  private sendToSyslog(event: SecurityEvent, target: SecurityLogTarget) {
    const severityMap: Record<string, number> = {
      low: 6, // Informational
      medium: 4, // Warning
      high: 3, // Error
      critical: 2, // Critical
    };
    
    const message = {
      severity: severityMap[event.severity],
      facility: 1, // User-level messages
      timestamp: new Date().toISOString(),
      hostname: 'saos-dex',
      appname: 'security-service',
      procid: process.pid,
      msgid: 'security-event',
      structuredData: '',
      message: JSON.stringify(event),
    };
    
    // ביישום אמיתי, נשתמש בספריית syslog
    console.log(`Syslog [${target.endpoint}]:`, message);
  }

  // ── שליחה ל-Webhook ──
  private async sendToWebhook(event: SecurityEvent, target: SecurityLogTarget) {
    const formattedEvent = this.formatEvent(event, target.format);
    
    const response = await fetch(target.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...target.headers,
      },
      body: JSON.stringify(formattedEvent),
    });
    
    if (!response.ok) {
      throw new Error(`Webhook failed: ${response.status} ${response.statusText}`);
    }
  }

  // ── עיצוב אירוע לפי פורמט ──
  private formatEvent(event: SecurityEvent, format: 'cef' | 'json' | 'rfc5424'): any {
    switch (format) {
      case 'cef':
        return this.formatAsCef(event);
      case 'json':
        return event;
      case 'rfc5424':
        return this.formatAsRfc5424(event);
      default:
        return event;
    }
  }

  // ── עיצוב בפורמט CEF ──
  private formatAsCef(event: SecurityEvent): any {
    const severityMap: Record<string, number> = {
      low: 0,
      medium: 5,
      high: 8,
      critical: 10,
    };
    
    return {
      CEF: '0',
      DeviceVendor: 'SAOS-DEX',
      DeviceProduct: 'Security-Service',
      DeviceVersion: '1.0',
      SignatureId: event.type,
      Name: event.description,
      Severity: severityMap[event.severity],
      Extensions: {
        src: event.sourceIp,
        suser: event.resourceId,
        msg: event.description,
        dvc: 'saos-dex',
        proto: 'http',
        request: JSON.stringify(event.details),
      },
    };
  }

  // ── עיצוב בפורמט RFC 5424 ──
  private formatAsRfc5424(event: SecurityEvent): any {
    const severityMap: Record<string, number> = {
      low: 6, // Informational
      medium: 4, // Warning
      high: 3, // Error
      critical: 2, // Critical
    };
    
    return {
      severity: severityMap[event.severity],
      facility: 1, // User-level messages
      timestamp: new Date().toISOString(),
      hostname: 'saos-dex',
      appname: 'security-service',
      procid: process.pid,
      msgid: 'security-event',
      structuredData: '',
      message: JSON.stringify(event),
    };
  }

  // ── ניקוי משאבים ──
  public destroy() {
    clearInterval(this.flushInterval);
    this.flushEvents();
  }
}

// ── יצירת מופע שירות ──
const securityService = new SecurityLogService({
  targets: [
    {
      id: 'syslog-main',
      type: 'syslog',
      endpoint: 'udp://logs.example.com:514',
      format: 'rfc5424',
      enabled: true,
    },
    {
      id: 'webhook-security',
      type: 'webhook',
      endpoint: 'https://security.example.com/events',
      format: 'json',
      enabled: true,
      headers: {
        'Authorization': 'Bearer token123',
      },
    },
  ],
  thresholds: {
    rateLimit: 100, // בקשות לדקה
    suspiciousPattern: 5, // דפוסים חשודים
  },
});

// ── API Routes ──
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action');

  switch (action) {
    case 'config':
      return NextResponse.json({
        targets: securityService['config'].targets,
        thresholds: securityService['config'].thresholds,
      });
      
    case 'events':
      // ביישום אמיתי, נחזיר אירועים מהמסד נתונים
      return NextResponse.json({
        events: [],
        count: 0,
      });
      
    default:
      return NextResponse.json(
        { error: 'Invalid action' },
        { status: 400 }
      );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, ...data } = body;

    switch (action) {
      case 'log':
        securityService.logEvent(data);
        return NextResponse.json({ success: true });
        
      case 'add-target':
        // ביישום אמיתי, נוסיף יעד לתצורה
        return NextResponse.json({ success: true });
        
      case 'update-target':
        // ביישום אמיתי, נעדכן יעד בתצורה
        return NextResponse.json({ success: true });
        
      default:
        return NextResponse.json(
          { error: 'Invalid action' },
          { status: 400 }
        );
    }
  } catch (error) {
    return NextResponse.json(
      { error: 'Invalid request body' },
      { status: 400 }
    );
  }
}

// ── ייצוא לצורך בדיקות ──
export { securityService, SecurityEvent, SecurityEventType };
