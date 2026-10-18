import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

type AnomalyEvent = {
  id: string;
  timestamp: Date;
  eventType: 'HIGH_REQUEST_RATE' | 'REPEATED_IP_ACCESS' | 'PROTECTED_API_ACCESS';
  details: Record<string, unknown>;
  severity: 'low' | 'medium' | 'high' | 'critical';
  acknowledged: boolean;
};

type AlertThreshold = {
  eventType: AnomalyEvent['eventType'];
  threshold: number;
  windowMs: number;
  severity: AnomalyEvent['severity'];
};

const DEFAULT_THRESHOLDS: AlertThreshold[] = [
  { eventType: 'HIGH_REQUEST_RATE', threshold: 100, windowMs: 60000, severity: 'medium' },
  { eventType: 'REPEATED_IP_ACCESS', threshold: 20, windowMs: 300000, severity: 'high' },
  { eventType: 'PROTECTED_API_ACCESS', threshold: 5, windowMs: 60000, severity: 'critical' },
];

const ANOMALY_CLEANUP_INTERVAL = 3600000; // 1 hour

// In-memory store for anomaly tracking
const anomalyStore = new Map<string, {
  events: Map<string, AnomalyEvent>;
  thresholds: AlertThreshold[];
}>();

// Initialize anomaly detection for each IP
function initAnomalyDetection(ip: string) {
  if (!anomalyStore.has(ip)) {
    anomalyStore.set(ip, {
      events: new Map(),
      thresholds: DEFAULT_THRESHOLDS,
    });
  }
}

// Record an anomaly event
function recordAnomaly(ip: string, eventType: AnomalyEvent['eventType'], details: Record<string, unknown>) {
  const store = anomalyStore.get(ip);
  if (!store) return;

  const timestamp = new Date();
  const threshold = store.thresholds.find(t => t.eventType === eventType);
  
  if (!threshold) return;

  const event: AnomalyEvent = {
    id: `${ip}-${eventType}-${timestamp.getTime()}`,
    timestamp,
    eventType,
    details,
    severity: threshold.severity,
    acknowledged: false,
  };

  store.events.set(event.id, event);
  
  // Check if threshold is exceeded
  const recentEvents = Array.from(store.events.values())
    .filter(e => e.eventType === eventType && 
      timestamp.getTime() - e.timestamp.getTime() < threshold.windowMs);
    
  if (recentEvents.length >= threshold.threshold) {
    sendAlert(event);
  }

  // Clean up old events
  const oldEvents = Array.from(store.events.values())
    .filter(e => timestamp.getTime() - e.timestamp.getTime() > ANOMALY_CLEANUP_INTERVAL);
    
  oldEvents.forEach(e => store.events.delete(e.id));
}

// Send alert to system administrators
async function sendAlert(event: AnomalyEvent) {
  try {
    // In a real implementation, this would send to a notification service
    // For now, we'll log to the database
    await db.anomalyEvent.create({
      data: {
        id: event.id,
        timestamp: event.timestamp,
        eventType: event.eventType,
        details: event.details,
        severity: event.severity,
        acknowledged: false,
      },
    });
    
    console.warn(`ANOMALY ALERT: ${event.eventType} from IP ${event.details.ip} - Severity: ${event.severity}`);
    
    // TODO: Implement actual alert mechanism (email, Slack, etc.)
    // This would typically be handled by a dedicated notification service
  } catch (error) {
    console.error('Failed to send anomaly alert:', error);
  }
}

// API endpoint to get anomaly events
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const ip = searchParams.get('ip');
  
  try {
    if (ip) {
      // Get events for a specific IP
      const store = anomalyStore.get(ip);
      if (!store) {
        return NextResponse.json({ events: [] });
      }
      
      return NextResponse.json({ 
        events: Array.from(store.events.values()),
        thresholds: store.thresholds,
      });
    } else {
      // Get all events
      const allEvents = Array.from(anomalyStore.values())
        .flatMap(store => Array.from(store.events.values()));
      
      return NextResponse.json({ events: allEvents });
    }
  } catch (error) {
    return NextResponse.json({ error: 'Failed to retrieve anomaly events' }, { status: 500 });
  }
}

// API endpoint to acknowledge an anomaly event
export async function POST(request: NextRequest) {
  try {
    const { eventId, acknowledged } = await request.json();
    
    // Find the event in the store
    for (const store of anomalyStore.values()) {
      const event = store.events.get(eventId);
      if (event) {
        event.acknowledged = acknowledged;
        
        // Also update the database
        await db.anomalyEvent.update({
          where: { id: eventId },
          data: { acknowledged },
        });
        
        return NextResponse.json({ success: true });
      }
    }
    
    return NextResponse.json({ error: 'Event not found' }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to acknowledge anomaly event' }, { status: 500 });
  }
}

// Middleware function to detect anomalies
export function detectAnomaly(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for') || 
             request.headers.get('x-real-ip') || 
             'unknown';
  
  const pathname = request.nextUrl.pathname;
  
  // Initialize anomaly detection for this IP if not already
  initAnomalyDetection(ip);
  
  // Record high request rate
  recordAnomaly(ip, 'HIGH_REQUEST_RATE', { 
    ip, 
    path: pathname,
    method: request.method,
    timestamp: new Date().toISOString(),
  });
  
  // Check for access to protected API endpoints
  const protectedPaths = ['/api/dex/state', '/api/dex/order', '/api/dex/security'];
  if (protectedPaths.some(path => pathname.startsWith(path))) {
    recordAnomaly(ip, 'PROTECTED_API_ACCESS', { 
      ip, 
      path: pathname,
      method: request.method,
      timestamp: new Date().toISOString(),
    });
  }
  
  // Check for repeated access from the same IP
  const store = anomalyStore.get(ip);
  if (store) {
    const recentEvents = Array.from(store.events.values())
      .filter(e => e.timestamp.getTime() > Date.now() - 300000); // Last 5 minutes
    
    if (recentEvents.length > 10) {
      recordAnomaly(ip, 'REPEATED_IP_ACCESS', { 
        ip, 
        eventCount: recentEvents.length,
        timestamp: new Date().toISOString(),
      });
    }
  }
  
  return NextResponse.next();
}

// Initialize the database schema (run once on deployment)
export async function initDb() {
  try {
    await db.$executeRaw`
      CREATE TABLE IF NOT EXISTS "AnomalyEvent" (
        "id" TEXT PRIMARY KEY,
        "timestamp" TIMESTAMPTZ NOT NULL,
        "eventType" TEXT NOT NULL,
        "details" JSONB NOT NULL,
        "severity" TEXT NOT NULL,
        "acknowledged" BOOLEAN NOT NULL DEFAULT false
      );
    `;
    
    console.log('Anomaly detection database schema initialized');
  } catch (error) {
    console.error('Failed to initialize anomaly detection database:', error);
  }
}

// Cleanup old events periodically
setInterval(() => {
  const now = Date.now();
  
  for (const [ip, store] of anomalyStore.entries()) {
    const oldEvents = Array.from(store.events.values())
      .filter(e => now - e.timestamp.getTime() > ANOMALY_CLEANUP_INTERVAL);
    
    oldEvents.forEach(e => store.events.delete(e.id));
  }
}, ANOMALY_CLEANUP_INTERVAL);
