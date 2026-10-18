import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

type SecurityEvent = {
  id: string;
  timestamp: Date;
  ip: string;
  userAgent: string;
  endpoint: string;
  method: string;
  status: number;
  suspicious: boolean;
  pattern?: string;
  userId?: string;
};

type AlertRule = {
  id: string;
  name: string;
  description: string;
  condition: (events: SecurityEvent[], context: any) => boolean;
  severity: 'low' | 'medium' | 'high' | 'critical';
  enabled: boolean;
};

// כללי זיהוי חדירות
class IntrusionDetectionSystem {
  private rules: AlertRule[] = [
    {
      id: 'brute-force',
      name: 'Brute Force Attack',
      description: 'Multiple failed login attempts from same IP',
      condition: (events, context) => {
        const failedLogins = events.filter(
          e => e.endpoint.includes('/auth') && e.status === 401 && e.ip === context.ip
        );
        return failedLogins.length >= 5;
      },
      severity: 'high',
      enabled: true
    },
    {
      id: 'sql-injection',
      name: 'SQL Injection Attempt',
      description: 'Potential SQL injection in request parameters',
      condition: (events, context) => {
        const sqlPatterns = ['SELECT', 'INSERT', 'DELETE', 'UNION', 'DROP'];
        return events.some(e => 
          sqlPatterns.some(pattern => 
            e.endpoint.toUpperCase().includes(pattern) || 
            (e.userAgent && e.userAgent.toUpperCase().includes(pattern))
          )
        );
      },
      severity: 'critical',
      enabled: true
    },
    {
      id: 'path-traversal',
      name: 'Path Traversal Attempt',
      description: 'Potential path traversal attack',
      condition: (events, context) => {
        const traversalPatterns = ['../', '..\\', 'etc/passwd', 'windows\\'];
        return events.some(e => 
          traversalPatterns.some(pattern => 
            e.endpoint.includes(pattern)
          )
        );
      },
      severity: 'high',
      enabled: true
    },
    {
      id: 'scan-detection',
      name: 'Port/Service Scan',
      description: 'Multiple rapid requests to different endpoints',
      condition: (events, context) => {
        const uniqueEndpoints = new Set(events.map(e => e.endpoint));
        const timeWindow = 60000; // 1 minute
        const now = Date.now();
        
        const recentEvents = events.filter(e => now - e.timestamp.getTime() < timeWindow);
        return recentEvents.length >= 20 && uniqueEndpoints.size >= 10;
      },
      severity: 'medium',
      enabled: true
    },
    {
      id: 'rate-limit-bypass',
      name: 'Rate Limit Bypass Attempt',
      description: 'Multiple requests with different user agents from same IP',
      condition: (events, context) => {
        const ipEvents = events.filter(e => e.ip === context.ip);
        const uniqueUserAgents = new Set(ipEvents.map(e => e.userAgent));
        return ipEvents.length >= 50 && uniqueUserAgents.size >= 5;
      },
      severity: 'medium',
      enabled: true
    }
  ];

  private eventBuffer: SecurityEvent[] = [];
  private maxBufferSize = 1000;

  async logEvent(event: Omit<SecurityEvent, 'id'>) {
    const fullEvent: SecurityEvent = {
      ...event,
      id: `sec-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date()
    };

    this.eventBuffer.push(fullEvent);
    
    if (this.eventBuffer.length > this.maxBufferSize) {
      this.eventBuffer = this.eventBuffer.slice(-this.maxBufferSize);
    }

    // Save to database
    try {
      await db.securityEvent.create({
        data: {
          id: fullEvent.id,
          timestamp: fullEvent.timestamp,
          ip: fullEvent.ip,
          userAgent: fullEvent.userAgent,
          endpoint: fullEvent.endpoint,
          method: fullEvent.method,
          status: fullEvent.status,
          suspicious: fullEvent.suspicious,
          pattern: fullEvent.pattern,
          userId: fullEvent.userId
        }
      });
    } catch (error) {
      console.error('Failed to save security event:', error);
    }

    // Check for alert triggers
    await this.checkAlerts(fullEvent);
  }

  private async checkAlerts(newEvent: SecurityEvent) {
    for (const rule of this.rules) {
      if (!rule.enabled) continue;

      try {
        const context = {
          ip: newEvent.ip,
          userAgent: newEvent.userAgent,
          endpoint: newEvent.endpoint
        };

        if (rule.condition([...this.eventBuffer, newEvent], context)) {
          await this.triggerAlert(rule, newEvent, context);
        }
      } catch (error) {
        console.error(`Error executing rule ${rule.id}:`, error);
      }
    }
  }

  private async triggerAlert(rule: AlertRule, event: SecurityEvent, context: any) {
    const alert = {
      id: `alert-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      ruleId: rule.id,
      ruleName: rule.name,
      severity: rule.severity,
      timestamp: new Date(),
      event,
      context
    };

    // Save alert to database
    try {
      await db.securityAlert.create({
        data: {
          id: alert.id,
          ruleId: alert.ruleId,
          ruleName: alert.ruleName,
          severity: alert.severity,
          timestamp: alert.timestamp,
          eventId: alert.event.id,
          eventData: JSON.stringify(alert.event),
          contextData: JSON.stringify(alert.context)
        }
      });
    } catch (error) {
      console.error('Failed to save security alert:', error);
    }

    // In a real implementation, you would send notifications here
    // This could be email, Slack, PagerDuty, etc.
    console.log(`SECURITY ALERT [${rule.severity.toUpperCase()}]: ${rule.name}`);
    console.log('Event:', event);
    console.log('Context:', context);

    // For critical alerts, you might want to take automatic action
    if (rule.severity === 'critical') {
      await this.handleCriticalAlert(alert);
    }
  }

  private async handleCriticalAlert(alert: any) {
    // Example: Block the IP address
    // In a real implementation, you would integrate with your WAF or firewall
    console.log(`CRITICAL ALERT: Taking action against IP ${alert.event.ip}`);
    
    // Add to block list
    try {
      await db.blockedIp.create({
        data: {
          ip: alert.event.ip,
          reason: `Triggered critical alert: ${alert.ruleName}`,
          timestamp: new Date(),
          expires: new Date(Date.now() + 24 * 60 * 60 * 1000) // Block for 24 hours
        }
      });
    } catch (error) {
      console.error('Failed to block IP:', error);
    }
  }

  getRules() {
    return this.rules;
  }

  enableRule(ruleId: string) {
    const rule = this.rules.find(r => r.id === ruleId);
    if (rule) {
      rule.enabled = true;
    }
  }

  disableRule(ruleId: string) {
    const rule = this.rules.find(r => r.id === ruleId);
    if (rule) {
      rule.enabled = false;
    }
  }
}

// Initialize the IDS
const ids = new IntrusionDetectionSystem();

// Enhanced middleware with security monitoring
export async function securityMiddleware(req: NextRequest): Promise<NextResponse | null> {
  const { pathname } = req.nextUrl;
  
  // Skip certain endpoints
  if (pathname.startsWith('/_next') || pathname.startsWith('/api/health')) {
    return null;
  }

  const ip = req.headers.get('x-forwarded-for') || 
             req.headers.get('x-real-ip') || 
             'unknown';
  
  const userAgent = req.headers.get('user-agent') || 'unknown';
  const method = req.method;
  
  // Check if IP is blocked
  try {
    const blockedIp = await db.blockedIp.findFirst({
      where: {
        ip,
        expires: {
          gte: new Date()
        }
      }
    });
    
    if (blockedIp) {
      await ids.logEvent({
        ip,
        userAgent,
        endpoint: pathname,
        method,
        status: 403,
        suspicious: true,
        pattern: 'blocked-ip'
      });
      
      return NextResponse.json(
        { error: 'Access denied. IP has been blocked due to suspicious activity.' },
        { status: 403 }
      );
    }
  } catch (error) {
    console.error('Error checking blocked IPs:', error);
  }

  // Log the request for security monitoring
  await ids.logEvent({
    ip,
    userAgent,
    endpoint: pathname,
    method,
    status: 200, // We'll update this after the actual response
    suspicious: false
  });

  return null; // Continue with normal processing
}

// API route for security dashboard
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type');

  try {
    switch (type) {
      case 'events':
        const events = await db.securityEvent.findMany({
          orderBy: { timestamp: 'desc' },
          take: 100
        });
        return NextResponse.json(events);
        
      case 'alerts':
        const alerts = await db.securityAlert.findMany({
          orderBy: { timestamp: 'desc' },
          take: 50,
          include: {
            event: true
          }
        });
        return NextResponse.json(alerts);
        
      case 'rules':
        return NextResponse.json(ids.getRules());
        
      case 'stats':
        const [totalEvents, totalAlerts, blockedIps] = await Promise.all([
          db.securityEvent.count(),
          db.securityAlert.count(),
          db.blockedIp.count({
            where: {
              expires: {
                gte: new Date()
              }
            }
          })
        ]);
        
        const recentEvents = await db.securityEvent.count({
          where: {
            timestamp: {
              gte: new Date(Date.now() - 24 * 60 * 60 * 1000)
            }
          }
        });
        
        const recentAlerts = await db.securityAlert.count({
          where: {
            timestamp: {
              gte: new Date(Date.now() - 24 * 60 * 60 * 1000)
            }
          }
        });
        
        return NextResponse.json({
          totalEvents,
          totalAlerts,
          blockedIps,
          recentEvents,
          recentAlerts
        });
        
      default:
        return NextResponse.json({ error: 'Invalid type parameter' }, { status: 400 });
    }
  } catch (error) {
    console.error('Security API error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// API route to manage security rules
export async function POST(request: Request) {
  try {
    const { action, ruleId } = await request.json();
    
    if (action === 'enable' && ruleId) {
      ids.enableRule(ruleId);
      return NextResponse.json({ success: true });
    }
    
    if (action === 'disable' && ruleId) {
      ids.disableRule(ruleId);
      return NextResponse.json({ success: true });
    }
    
    return NextResponse.json({ error: 'Invalid action or ruleId' }, { status: 400 });
  } catch (error) {
    console.error('Security rule management error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
