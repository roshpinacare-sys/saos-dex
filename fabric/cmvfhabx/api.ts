import { NextRequest, NextResponse } from 'next/server';

// ── סוגי אירועי אבטחה ──
type SecurityEventType = 'AUTH_FAILURE' | 'SENSITIVE_API_ACCESS' | 'PERMISSION_CHANGE' | 'SUSPICIOUS_IP';

// ── רמות חומרה ──
type SeverityLevel = 'INFO' | 'WARN' | 'ERROR';

// ── ממשק לוג אירוע אבטחה ──
interface SecurityEvent {
  timestamp: string;
  eventType: SecurityEventType;
  severity: SeverityLevel;
  source: {
    ip: string;
    userAgent: string;
    method: string;
    path: string;
  };
  details: {
    userId?: string;
    token?: string;
    permission?: string;
    reason?: string;
  };
}

// ── רישום אירוע אבטחה למערכת הלוגים המרכזית ──
async function logSecurityEvent(event: SecurityEvent): Promise<void> {
  try {
    const centralLoggingUrl = process.env.CENTRAL_LOGGING_URL;
    if (!centralLoggingUrl) {
      console.warn('CENTRAL_LOGGING_URL not configured, skipping security event logging');
      return;
    }

    await fetch(`${centralLoggingUrl}/api/security-events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    console.error('Failed to log security event:', error);
    // לא נפיל את הבקשה בגלאל כשיש כשל בלוגים
  }
}

// ── פונקציית המידלוור הגלובלית ──
export async function securityMiddleware(request: NextRequest): Promise<NextResponse | null> {
  const response = NextResponse.next();
  const { pathname } = request.nextUrl;
  const ip = request.ip || 'unknown';
  const userAgent = request.headers.get('user-agent') || 'unknown';
  const method = request.method;
  
  // ── קביעת רמת חומרה ברירת מחדל ──
  let severity: SeverityLevel = 'INFO';
  
  // ── זיהוי אירועי אבטחה ──
  let eventType: SecurityEventType | null = null;
  let eventDetails: SecurityEvent['details'] = {};
  
  // ── 1. ניסיונות כניסה כושלים (401/403) ──
  if (response.status === 401 || response.status === 403) {
    eventType = 'AUTH_FAILURE';
    severity = 'WARN';
    
    // ניסיון לחלץ מידע מהבקשה
    const authHeader = request.headers.get('authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
      eventDetails.token = authHeader.substring(7, 15) + '...'; // מציגים רק חלק מהטוקן
    }
  }
  
  // ── 2. גישה ל-APIs רגישים ──
  const sensitivePaths = ['/api/dex/security', '/api/dex/wallets'];
  if (sensitivePaths.some(path => pathname.startsWith(path))) {
    eventType = 'SENSITIVE_API_ACCESS';
    severity = pathname.includes('/api/dex/security') ? 'ERROR' : 'WARN';
    
    // בדיקת הרשאות נוספות ל-APIs רגישים
    if (pathname.includes('/api/dex/security')) {
      eventDetails.reason = 'Access to security endpoint detected';
    } else if (pathname.includes('/api/dex/wallets')) {
      eventDetails.reason = 'Access to wallets endpoint detected';
    }
  }
  
  // ── 3. שינויי הרשאות (ניחוש מבוסס נתיב) ──
  if (pathname.includes('/api/dex/permissions') || pathname.includes('/api/dex/roles')) {
    eventType = 'PERMISSION_CHANGE';
    severity = 'INFO';
    
    // ניסיון לזהות את סוג השינוי
    if (pathname.includes('/grant') || pathname.includes('/revoke')) {
      eventDetails.permission = pathname.split('/').pop() || 'unknown';
    }
  }
  
  // ── 4. גישה חריגה מ-IPים לא מוכרים ──
  const knownIps = process.env.KNOWN_IPS?.split(',') || [];
  if (!knownIps.includes(ip)) {
    eventType = 'SUSPICIOUS_IP';
    severity = 'WARN';
    eventDetails.reason = 'Request from unknown IP address';
  }
  
  // ── אם זוהה אירוע אבטחה, רישומו ──
  if (eventType) {
    const securityEvent: SecurityEvent = {
      timestamp: new Date().toISOString(),
      eventType,
      severity,
      source: {
        ip,
        userAgent,
        method,
        path: pathname,
      },
      details: eventDetails,
    };
    
    // לוג למערכת הלוגים המרכזית
    await logSecurityEvent(securityEvent);
    
    // לוג מקומי לפיתוח (ניתן להסיר בסביבת הפרודקשן)
    if (process.env.NODE_ENV === 'development') {
      console.log('Security Event Logged:', JSON.stringify(securityEvent, null, 2));
    }
  }
  
  return response;
}

// ── החלת המידלוור על כל הבקשות ──
export function middleware(request: NextRequest): NextResponse | Promise<NextResponse> {
  return securityMiddleware(request);
}