import { PrismaClient } from '@prisma/client';

// Sentry integration
import * as Sentry from '@sentry/node';

// Database connection error tracking
interface DatabaseErrorEvent {
  timestamp: number;
  ip?: string;
  error: string;
  userAgent?: string;
}

// Mock function for external alert system
const alertSaosControlCenter = (event: DatabaseErrorEvent) => {
  console.log(`Alert sent to saos-control-center:`, event);
  // In a real implementation, this would send an HTTP request or use a messaging system
};

const RAW_URL = process.env.DATABASE_URL ?? '';
const isDexOwnDb = /\.db(\?|$)/.test(RAW_URL) && !/custom\.db/.test(RAW_URL);

if (!isDexOwnDb) {
  const desc = RAW_URL === '' 
    ? '(חסר — הגדר DATABASE_URL ב-.env של saos-dex)' 
    : /\.db/.test(RAW_URL) 
      ? '(dex.db-קיים-אך-לא-עבר-את-הסינון)' 
      : /custom\.db/.test(RAW_URL) 
        ? '(מצביע-על-האם-אסור)' 
        : '(כתובת-לא-ידועה — לא-מוצגת)';

  const errorEvent: DatabaseErrorEvent = {
    timestamp: Date.now(),
    error: `[saos-dex] DATABASE_URL נדחה (fail-closed): המנוע רשאי לגעת רק ב-dex.db שלו — ${desc}`,
  };

  try {
    // Log the error locally
    console.error(errorEvent.error);
    
    // Send to Sentry
    Sentry.captureException(new Error(errorEvent.error));
    
    // Alert external system
    alertSaosControlCenter(errorEvent);
  } catch (alertError) {
    // Fallback: if alerting fails, don't crash the application
    console.error('Failed to send database error alert:', alertError);
  }

  throw new Error(errorEvent.error);
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['warn', 'error'],
    // Add error handler for database connection issues
    error: ({ target, message }) => {
      const errorEvent: DatabaseErrorEvent = {
        timestamp: Date.now(),
        error: `Database connection error: ${message}`,
        target: target as unknown as string,
      };

      try {
        // Log the error locally
        console.error('Database error:', errorEvent);
        
        // Send to Sentry
        Sentry.captureException(new Error(errorEvent.error));
        
        // Alert external system
        alertSaosControlCenter(errorEvent);
      } catch (alertError) {
        // Fallback: if alerting fails, don't crash the application
        console.error('Failed to send database error alert:', alertError);
      }
    },
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db;

// Initialize Sentry when the module is loaded
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    // Set tracesSampleRate to 1.0 to capture 100%
    // of transactions for performance monitoring.
    tracesSampleRate: 1.0,
  });
}