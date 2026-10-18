import { PrismaClient } from '@prisma/client';
import { Counter, register } from 'prom-client';
import winston from 'winston';

// Initialize Prometheus counter for database connection errors
const dbConnectionErrorCounter = new Counter({
  name: 'saos_dex_db_connection_errors_total',
  help: 'Total number of database connection errors',
  labelNames: ['reason'],
});

// Configure Winston logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'db-errors.log' })
  ],
});

// FIX(Roast-68 · db-scope-guard): נזק-חי-מתועד — תהליך-שירש-את-DATABASE_URL-של-הפלטפורמה-האם
// פתח-את-השרשרת-בתוך-db/custom.db-של-האם (בעקיפין-את-.env-של-האם) והשמיד-את-טבלאות-הכספת.
// מעתה: המנוע-מסרב-לעלות-אם-כתובת-ה-DB-אינה-dex.db-שלו-עצמו (fail-closed ב-boot).
const RAW_URL = process.env.DATABASE_URL ?? '';
const isDexOwnDb = /dex\.db(\?|$)/.test(RAW_URL) && !/custom\.db/.test(RAW_URL);

if (!isDexOwnDb) {
  // FIX(R16-a·m7): השגיאה הדפיסה את RAW_URL-הגולמי — URL-שגוי שמצביע-על-DB-אחר
  // (עם-credentials-מוטבעים user:pass@host) היה נשפך ללוגים/קריסת-בוט. עתה:
  // תיאור-מסנן-בלבד (חסר/לא-דקס/לא-ידוע) — בלי-גוף-הכתובת.
  let reason = '';
  let desc = '';
  
  if (RAW_URL === '') {
    reason = 'missing-url';
    desc = '(חסר — הגדר DATABASE_URL ב-.env של saos-dex)';
  } else if (/dex\.db/.test(RAW_URL)) {
    reason = 'dex-db-but-failed-filter';
    desc = '(dex.db-קיים-אך-לא-עבר-את-הסינון)';
  } else if (/custom\.db/.test(RAW_URL)) {
    reason = 'pointing-to-parent';
    desc = '(מצביע-על-האם-אסור)';
  } else {
    reason = 'unknown-url';
    desc = '(כתובת-לא-ידועה — לא-מוצגת)';
  }
  
  // Increment Prometheus counter
  dbConnectionErrorCounter.inc({ reason });
  
  // Log the error with structured logging
  logger.error({
    message: 'DATABASE_URL נדחה (fail-closed)',
    reason,
    description: desc,
    timestamp: new Date().toISOString(),
  });
  
  throw new Error(
    `[saos-dex] DATABASE_URL נדחה (fail-closed): המנוע רשאי לגעת רק ב-dex.db שלו — ` +
      `קיבל: ${desc}`
  );
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db;

// Register Prometheus metrics
register.registerMetric(dbConnectionErrorCounter);

// Export Prometheus metrics endpoint for scraping
export async function getDbMetrics() {
  return register.metrics();
}