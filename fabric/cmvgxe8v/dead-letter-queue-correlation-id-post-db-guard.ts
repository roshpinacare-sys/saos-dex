import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';

const RAW_URL = process.env.DATABASE_URL ?? '';
const isDexOwnDb = /dex\.db(\?|$)/.test(RAW_URL) && !/custom\.db/.test(RAW_URL);

// Initialize Prisma client
const prisma = new PrismaClient();

// Function to create DLQ table if it doesn't exist
async function ensureDLQTableExists() {
  try {
    await prisma.$executeRaw`
      CREATE TABLE IF NOT EXISTS dlq_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        correlation_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        retry_count INTEGER DEFAULT 0,
        last_attempt_time DATETIME,
        next_retry_time DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        error_message TEXT
      );
    `;
    console.log('DLQ table ensured');
  } catch (error) {
    console.error('Failed to create DLQ table:', error);
    throw error;
  }
}

// Function to add an alert to DLQ
async function addToDLQ(correlationId: string, eventType: string, payload: string, errorMessage?: string) {
  try {
    await prisma.dlqAlert.create({
      data: {
        correlation_id: correlationId,
        event_type: eventType,
        payload,
        error_message: errorMessage,
        next_retry_time: new Date(Date.now() + 5 * 60 * 1000), // 5 minutes from now
      },
    });
    console.log(`Alert added to DLQ with correlation ID: ${correlationId}`);
  } catch (error) {
    console.error('Failed to add alert to DLQ:', error);
    throw error;
  }
}

// Function to retry sending alerts from DLQ
async function retryDLQAlerts() {
  try {
    const pendingAlerts = await prisma.dlqAlert.findMany({
      where: {
        status: 'pending',
        next_retry_time: {
          lte: new Date(),
        },
      },
    });

    for (const alert of pendingAlerts) {
      try {
        const base = process.env.SAOS_CONTROL_CENTER_URL;
        if (!base) {
          console.warn('Control Center URL not configured, skipping retry');
          continue;
        }

        await fetch(`${base}/api/alerts`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Correlation-ID': alert.correlation_id,
          },
          body: alert.payload,
          signal: AbortSignal.timeout(3000),
        });

        // Mark as completed
        await prisma.dlqAlert.update({
          where: { id: alert.id },
          data: { status: 'completed' },
        });

        console.log(`Successfully retried alert with correlation ID: ${alert.correlation_id}`);
      } catch (retryError) {
        const retryCount = alert.retry_count + 1;
        const newErrorMessage = retryError instanceof Error ? retryError.message : 'Unknown error';
        
        // Update retry status
        await prisma.dlqAlert.update({
          where: { id: alert.id },
          data: {
            retry_count: retryCount,
            last_attempt_time: new Date(),
            error_message: newErrorMessage,
            status: retryCount >= 3 ? 'failed' : 'pending',
            next_retry_time: retryCount < 3 
              ? new Date(Date.now() + Math.pow(2, retryCount) * 60 * 1000) // Exponential backoff
              : null,
          },
        });

        console.error(`Retry failed for alert ${alert.correlation_id}:`, retryError);
      }
    }
  } catch (error) {
    console.error('Error in retryDLQAlerts:', error);
  }
}

// Function to get DLQ statistics
async function getDLQStats() {
  try {
    const stats = await prisma.dlqAlert.groupBy({
      by: ['status'],
      _count: { status: true },
    });
    
    const statsObject = stats.reduce((acc, stat) => {
      acc[stat.status] = stat._count.status;
      return acc;
    }, {} as Record<string, number>);
    
    console.log('DLQ Statistics:', statsObject);
    return statsObject;
  } catch (error) {
    console.error('Error getting DLQ stats:', error);
    return {};
  }
}

// Initialize DLQ on startup
ensureDLQTableExists().catch(console.error);

// Set up periodic retry
setInterval(retryDLQAlerts, 60 * 1000); // Check every minute

if (!isDexOwnDb) {
  const desc = RAW_URL === '' 
    ? '(חסר — הגדר DATABASE_URL ב-.env של saos-dex)' 
    : /dex\.db/.test(RAW_URL) 
      ? '(dex.db-קיים-אך-לא-עבר-את-הסינון)' 
      : /custom\.db/.test(RAW_URL) 
        ? '(מצביע-על-האם-אסור)' 
        : '(כתובת-לא-ידועה — לא-מוצגת)';
  
  const errorMessage = `[saos-dex] DATABASE_URL נדחה (fail-closed): המנוע רשאי לגעת רק ב-dex.db שלו — ` +
    `קיבל: ${desc}`;
  
  const timestamp = new Date().toISOString();
  const correlationId = uuidv4();
  
  // Alert 1: Local module (cmvdww18 · מאושר)
  void (async () => {
    try {
      const { alertDatabaseConnectionFailure } = await import('./dex/alert');
      await alertDatabaseConnectionFailure({
        timestamp,
        errorType: 'INVALID_DATABASE_URL',
        description: errorMessage,
        severity: 'WARNING',
      });
    } catch (alertError) {
      console.warn(`[${timestamp}] ALERT_SYSTEM_FAILURE: Failed to trigger database connection alert - ${alertError instanceof Error ? alertError.message : 'Unknown error'}`);
    }
  })();
  
  // Alert 2: POST to Control Center (cmvdxs6w · הגרסה-המתוקנת מ-REVIEW-W7 · מאושר)
  void (async () => {
    try {
      const base = process.env.SAOS_CONTROL_CENTER_URL;
      if (!base) return;
      
      const payload = JSON.stringify({
        event_type: 'unauthorized_database_connection_attempt',
        at: timestamp,
        service_id: 'saos-dex',
        url_hint: createHash('sha256').update(RAW_URL).digest('hex').slice(0, 12),
      });
      
      // First attempt to send directly
      const response = await fetch(`${base}/api/alerts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Correlation-ID': correlationId,
        },
        body: payload,
        signal: AbortSignal.timeout(3000),
      });
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      console.log(`Alert successfully sent to Control Center with correlation ID: ${correlationId}`);
    } catch (error) {
      console.error(`Failed to send alert to Control Center: ${error instanceof Error ? error.message : 'Unknown error'}`);
      
      // If direct POST fails, add to DLQ
      try {
        const eventType = 'unauthorized_database_connection_attempt';
        const payloadPayload = JSON.stringify({
          event_type,
          at: timestamp,
          service_id: 'saos-dex',
          url_hint: createHash('sha256').update(RAW_URL).digest('hex').slice(0, 12),
        });
        
        await addToDLQ(correlationId, eventType, payloadPayload, error instanceof Error ? error.message : 'Unknown error');
      } catch (dlqError) {
        console.error('Failed to add alert to DLQ:', dlqError);
      }
    }
  })();
  
  throw new Error(errorMessage);
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const db = globalForPrisma.prisma ?? prisma;

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db;
