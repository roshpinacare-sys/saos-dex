import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import winston from 'winston';

// הגדרת logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'db_errors.log' })
  ]
});

const RAW_URL = process.env.DATABASE_URL ?? '';
const isDexOwnDb = /dex\.db(\?|$)/.test(RAW_URL) && !/custom\.db/.test(RAW_URL);

if (!isDexOwnDb) {
  const desc = RAW_URL === '' ? '(חסר — הגדר DATABASE_URL ב-.env של saos-dex)' : 
    /dex\.db/.test(RAW_URL) ? '(dex.db-קיים-אך-לא-עבר-את-הסינון)' : 
    /custom\.db/.test(RAW_URL) ? '(מצביע-על-האם-אסור)' : '(כתובת-לא-ידועה — לא-מוצגת)';
  
  const errorMessage = `[saos-dex] DATABASE_URL נדחה (fail-closed): המנוע רשאי לגעת רק ב-dex.db שלו — קיבל: ${desc}`;
  const timestamp = new Date().toISOString();

  // רישום השגיאה בלוג
  logger.error({
    timestamp,
    errorType: 'INVALID_DATABASE_URL',
    description: errorMessage,
    severity: 'CRITICAL',
    rawUrl: RAW_URL
  });

  // שליחת התראה למערכת ניטור חיצונית
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
          severity: 'CRITICAL'
        }),
        signal: AbortSignal.timeout(3000)
      });
    } catch (error) {
      logger.warn(`Failed to send external alert: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  })();

  throw new Error(errorMessage);
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const db = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db;
