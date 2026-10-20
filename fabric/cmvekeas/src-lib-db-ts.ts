import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import winston from 'winston';
import * as Sentry from '@sentry/node';

// ── תצורת הלוגר winston ───────────────────────────────────────────────
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.simple(),
    }),
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
  ],
});

// ── תצורת Sentry (אם מופעל) ───────────────────────────────────────────
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
  });
}

// ── פונקציית עזר לטיפול בשגיאות מסד נתונים ────────────────────────────────
interface DatabaseErrorConfig {
  severity?: 'info' | 'warn' | 'error';
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  metric?: boolean;
}

function handleDatabaseError(
  error: Error,
  context: string,
  config: DatabaseErrorConfig = {}
): void {
  const {
    severity = 'error',
    tags = {},
    extra = {},
    metric = true,
  } = config;

  // רישום השגיאה בלוג
  logger.log(severity, `Database error in ${context}`, {
    error: error.message,
    stack: error.stack,
    ...tags,
    ...extra,
  });

  // שליחת התראה ל-Sentry (אם מופעל)
  if (process.env.SENTRY_DSN) {
    Sentry.captureException(error, {
      tags: {
        module: 'database',
        context,
        ...tags,
      },
      extra: {
        ...extra,
      },
    });
  }

  // הפעלת מטריקה (אם מוגדר)
  if (metric && process.env.METRICS_ENDPOINT) {
    fetch(`${process.env.METRICS_ENDPOINT}/database_errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error_type: error.name,
        message: error.message,
        context,
        severity,
        timestamp: new Date().toISOString(),
        ...tags,
      }),
    }).catch((metricError) => {
      logger.warn('Failed to send database error metric', {
        error: metricError.message,
      });
    });
  }
}

// ── פונקציית עזר להתראות חיבור למסד נתונים ────────────────────────────────
async function alertDatabaseConnectionFailure(params: {
  timestamp: string;
  errorType: string;
  description: string;
  severity: 'INFO' | 'WARNING' | 'ERROR';
}): Promise<void> {
  try {
    // התראה מקומית דרך הלוגר
    logger.log(params.severity.toLowerCase() as 'info' | 'warn' | 'error', 'Database connection failure', params);

    // התראה למקלט הקונסולה (אם מוגדר)
    const controlCenterUrl = process.env.SAOS_CONTROL_CENTER_URL;
    if (controlCenterUrl) {
      await fetch(`${controlCenterUrl}/api/alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_type: 'database_connection_failure',
          ...params,
          service_id: 'saos-dex',
        }),
        signal: AbortSignal.timeout(3000),
      });
    }

    // שליחה ל-Sentry
    if (process.env.SENTRY_DSN) {
      Sentry.captureMessage('Database connection failure', {
        level: params.severity.toLowerCase() as 'info' | 'warn' | 'error',
        tags: {
          module: 'database',
          event_type: 'connection_failure',
        },
        extra: params,
      });
    }
  } catch (error) {
    logger.error('Failed to send database connection alert', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

// ── ייצור ובדיקות ה-Prisma Client ──────────────────────────────────────
const RAW_URL = process.env.DATABASE_URL ?? '';
const isDexOwnDb = /dex\.db(\?|$)/.test(RAW_URL) && !/custom\.db/.test(RAW_URL);

if (!isDexOwnDb) {
  const desc = RAW_URL === '' 
    ? '(חסר — הגדר DATABASE_URL ב-.env של saos-dex)' 
    : /dex\.db/.test(RAW_URL) 
      ? '(dex.db-קיים-אך-לא-עבר-את-הסינון)' 
      : /custom\.db/.test(RAW_URL) 
        ? '(מצביע-על-האם-אסור)' 
        : '(כתובת-לא-ידועה — לא-מוצגת)';
  
  const errorMessage = `[saos-dex] DATABASE_URL נדחה (fail-closed): המנוע רשאי לגעת רק ב-dex.db שלו — קיבל: ${desc}`;
  const timestamp = new Date().toISOString();

  // התראה 1: המודול המקומי
  void alertDatabaseConnectionFailure({
    timestamp,
    errorType: 'INVALID_DATABASE_URL',
    description: errorMessage,
    severity: 'WARNING',
  });

  // התראה 2: POST למקלט הקונסולה
  void (async () => {
    try {
      const base = process.env.SAOS_CONTROL_CENTER_URL;
      if (!base) return;
      
      await fetch(`${base}/api/alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_type: 'unauthorized_database_connection_attempt',
          at: timestamp,
          service_id: 'saos-dex',
          url_hint: createHash('sha256').update(RAW_URL).digest('hex').slice(0, 12),
        }),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // אל-תשבור את ה-boot בגלל התראה
    }
  })();

  throw new Error(errorMessage);
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// ── יצירת ה-Prisma Client עם טיפול בשגיאות ──────────────────────────────
const prisma = globalForPrisma.prisma ?? new PrismaClient({
  log: [
    {
      emit: 'event',
      level: 'query',
    },
    {
      emit: 'event',
      level: 'error',
    },
    {
      emit: 'event',
      level: 'info',
    },
    {
      emit: 'event',
      level: 'warn',
    },
  ],
});

// הוספת מאזינים לאירועי שגיאות של Prisma
prisma.$on('error', (event) => {
  handleDatabaseError(
    new Error(event.message),
    'PrismaClient',
    {
      severity: 'error',
      tags: {
        target: event.target,
        code: event.code,
      },
      extra: {
        meta: event.meta,
      },
    }
  );
});

// הוספת מאזינים לאירועי שאילתות של Prisma
prisma.$on('query', (event) => {
  if (event.duration > process.env.SLOW_QUERY_THRESHOLD ? parseInt(process.env.SLOW_QUERY_THRESHOLD) : 1000) {
    handleDatabaseError(
      new Error(`Slow query detected: ${event.query}`),
      'PrismaQuery',
      {
        severity: 'warn',
        tags: {
          duration: event.duration,
          target: event.target,
        },
      }
    );
  }
});

// ── ייצור גרסה גלובלית של ה-Prisma Client ───────────────────────────────
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export default prisma;

// ── ייצוא הפונקציות לשימוש במקומות אחרים באפליקציה ───────────────────────
export { handleDatabaseError, alertDatabaseConnectionFailure, logger };