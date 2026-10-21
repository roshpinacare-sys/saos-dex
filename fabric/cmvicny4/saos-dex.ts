import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';

type SecurityEvent = {
  id: string;
  timestamp: Date;
  eventType: 'AUTH_FAILURE' | 'RATE_LIMIT' | 'PERMISSION_CHANGE' | 'SENSITIVE_API_ACCESS' | 'SUSPICIOUS_PATTERN';
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  userId?: string;
  ip: string;
  userAgent?: string;
  endpoint: string;
  details: Record<string, unknown>;
};

// Initialize Prisma client for security logs
const prisma = new PrismaClient({
  errorFormat: 'minimal',
});

// Security logging middleware
export function securityLoggingMiddleware(req: NextRequest): NextResponse | null {
  const ip = req.ip || req.headers.get('x-forwarded-for') || 'unknown';
  const userAgent = req.headers.get('user-agent');
  const endpoint = req.nextUrl.pathname;
  
  // Check if this is a security-relevant event
  if (isSecurityEvent(req)) {
    logSecurityEvent({
      ip,
      userAgent,
      endpoint,
      eventType: determineEventType(req),
      severity: determineSeverity(req),
      details: extractEventDetails(req),
    });
  }
  
  return null; // Continue with normal request processing
}

// Determine if the request represents a security event
function isSecurityEvent(req: NextRequest): boolean {
  const status = req.nextUrl.searchParams.get('status');
  return (
    status === '401' ||
    status === '403' ||
    req.nextUrl.pathname.startsWith('/api/dex/') ||
    req.nextUrl.pathname.startsWith('/api/revive')
  );
}

// Determine the type of security event
function determineEventType(req: NextRequest): SecurityEvent['eventType'] {
  const status = req.nextUrl.searchParams.get('status');
  
  if (status === '401') return 'AUTH_FAILURE';
  if (status === '403') return 'PERMISSION_CHANGE';
  if (req.nextUrl.pathname.startsWith('/api/dex/')) return 'SENSITIVE_API_ACCESS';
  if (req.nextUrl.pathname.startsWith('/api/revive')) return 'SUSPICIOUS_PATTERN';
  
  return 'RATE_LIMIT';
}

// Determine the severity of the security event
function determineSeverity(req: NextRequest): SecurityEvent['severity'] {
  const status = req.nextUrl.searchParams.get('status');
  const endpoint = req.nextUrl.pathname;
  
  if (status === '401') return 'MEDIUM';
  if (status === '403') return 'HIGH';
  if (endpoint.includes('/operator-auth')) return 'CRITICAL';
  if (endpoint.includes('/dex/agent')) return 'HIGH';
  
  return 'LOW';
}

// Extract relevant details from the request
function extractEventDetails(req: NextRequest): Record<string, unknown> {
  const details: Record<string, unknown> = {
    method: req.method,
    headers: Object.fromEntries(req.headers.entries()),
    query: Object.fromEntries(req.nextUrl.searchParams.entries()),
  };
  
  // Attempt to parse and sanitize body if present
  if (req.method !== 'GET' && req.body) {
    try {
      const body = req.clone().body;
      if (body) {
        const text = body.toString();
        // Sanitize sensitive information
        const sanitizedText = text
          .replace(/\"password\":\s*\"[^\"]*\"/g, '"password":"REDACTED"')
          .replace(/\"api_key\":\s*\"[^\"]*\"/g, '"api_key":"REDACTED"');
        details.body = JSON.parse(sanitizedText);
      }
    } catch (e) {
      details.body = 'UNPARSABLE';
    }
  }
  
  return details;
}

// Log a security event to the database
async function logSecurityEvent(event: Omit<SecurityEvent, 'id' | 'timestamp'>): Promise<void> {
  try {
    await prisma.securityEvent.create({
      data: {
        id: generateEventId(event),
        timestamp: new Date(),
        ...event,
      },
    });
  } catch (error) {
    console.error('Failed to log security event:', error);
    // In a production system, we might have a fallback logging mechanism
  }
}

// Generate a unique ID for security events
function generateEventId(event: Omit<SecurityEvent, 'id' | 'timestamp'>): string {
  const hashable = `${event.ip}-${event.endpoint}-${event.eventType}-${Date.now()}`;
  return createHash('sha256').update(hashable).digest('hex').substring(0, 16);
}

// API endpoint to retrieve security logs
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url);
  const page = parseInt(searchParams.get('page') || '1', 10);
  const limit = parseInt(searchParams.get('limit') || '50', 10);
  const eventType = searchParams.get('eventType') as SecurityEvent['eventType'] | null;
  const severity = searchParams.get('severity') as SecurityEvent['severity'] | null;
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  
  try {
    // Build the query
    const where: any = {};
    if (eventType) where.eventType = eventType;
    if (severity) where.severity = severity;
    if (startDate || endDate) {
      where.timestamp = {};
      if (startDate) where.timestamp.gte = new Date(startDate);
      if (endDate) where.timestamp.lte = new Date(endDate);
    }
    
    // Execute the query with pagination
    const [events, total] = await Promise.all([
      prisma.securityEvent.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.securityEvent.count({ where }),
    ]);
    
    return NextResponse.json({
      events,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to retrieve security logs' },
      { status: 500 }
    );
  }
}

// API endpoint to generate security reports
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json();
    const { reportType, startDate, endDate, filters } = body;
    
    // Validate inputs
    if (!reportType || !['SUMMARY', 'TRENDS', 'TOP_OFFENDERS'].includes(reportType)) {
      return NextResponse.json(
        { error: 'Invalid report type' },
        { status: 400 }
      );
    }
    
    // Build the query
    const where: any = {};
    if (startDate || endDate) {
      where.timestamp = {};
      if (startDate) where.timestamp.gte = new Date(startDate);
      if (endDate) where.timestamp.lte = new Date(endDate);
    }
    if (filters) {
      Object.assign(where, filters);
    }
    
    // Generate the report based on type
    let report;
    switch (reportType) {
      case 'SUMMARY':
        report = await generateSummaryReport(where);
        break;
      case 'TRENDS':
        report = await generateTrendsReport(where);
        break;
      case 'TOP_OFFENDERS':
        report = await generateTopOffendersReport(where);
        break;
    }
    
    return NextResponse.json({ report });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to generate security report' },
      { status: 500 }
    );
  }
}

// Generate a summary security report
async function generateSummaryReport(where: any): Promise<Record<string, unknown>> {
  const [totalEvents, eventTypeCounts, severityCounts] = await Promise.all([
    prisma.securityEvent.count({ where }),
    prisma.securityEvent.groupBy({
      by: ['eventType'],
      where,
      _count: { eventType: true },
    }),
    prisma.securityEvent.groupBy({
      by: ['severity'],
      where,
      _count: { severity: true },
    }),
  ]);
  
  return {
    totalEvents,
    eventTypeCounts: eventTypeCounts.map(item => ({
      type: item.eventType,
      count: item._count.eventType,
    })),
    severityCounts: severityCounts.map(item => ({
      severity: item.severity,
      count: item._count.severity,
    })),
  };
}

// Generate a trends security report
async function generateTrendsReport(where: any): Promise<Record<string, unknown>> {
  // Group events by day for the last 30 days
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  
  const events = await prisma.securityEvent.findMany({
    where: {
      ...where,
      timestamp: { gte: thirtyDaysAgo },
    },
    select: {
      timestamp: true,
      eventType: true,
      severity: true,
    },
  });
  
  // Group by day
  const dailyCounts = events.reduce((acc, event) => {
    const date = event.timestamp.toISOString().split('T')[0];
    if (!acc[date]) {
      acc[date] = {
        date,
        total: 0,
        byType: {},
        bySeverity: {},
      };
    }
    
    acc[date].total++;
    acc[date].byType[event.eventType] = (acc[date].byType[event.eventType] || 0) + 1;
    acc[date].bySeverity[event.severity] = (acc[date].bySeverity[event.severity] || 0) + 1;
    
    return acc;
  }, {} as Record<string, any>);
  
  return {
    period: '30 days',
    dailyCounts: Object.values(dailyCounts),
  };
}

// Generate a top offenders report
async function generateTopOffendersReport(where: any): Promise<Record<string, unknown>> {
  const topOffenders = await prisma.securityEvent.groupBy({
    by: ['ip'],
    where,
    _count: { ip: true },
    orderBy: { _count: { ip: 'desc' } },
    take: 10,
  });
  
  // Get detailed info for each top offender
  const offenderDetails = await Promise.all(
    topOffenders.map(async (offender) => {
      const events = await prisma.securityEvent.findMany({
        where: { ip: offender.ip },
        select: {
          eventType: true,
          severity: true,
          endpoint: true,
          timestamp: true,
        },
        orderBy: { timestamp: 'desc' },
        take: 5,
      });
      
      return {
        ip: offender.ip,
        eventCount: offender._count.ip,
        recentEvents: events,
      };
    })
  );
  
  return {
    topOffenders: offenderDetails,
  };
}
