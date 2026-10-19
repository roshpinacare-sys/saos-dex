import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';

// פונקציית עזר לרישום לוג עם פרטים מסוננים
function logDatabaseAccessAttempt(
  timestamp: string,
  errorType: string,
  description: string,
  severity: 'INFO' | 'WARNING' | 'ERROR' = 'WARNING'
) {
  console.log(`[${timestamp}] DATABASE_ACCESS_${severity}: ${errorType} - ${description}`);
}

// פונקציית עזר לשליחת התראה למערכת הניטור הפנימית
async function sendInternalAlert(
  timestamp: string,
  errorType: string,
  description: string,
  severity: 'WARNING' | 'ERROR'
) {
  try {
    const { alertDatabaseConnectionFailure } = await import('./dex/alert');
    await alertDatabaseConnectionFailure({
      timestamp,
      errorType,
      description,
      severity,
    });
  } catch (alertError) {
    console.warn(`[${timestamp}] ALERT_SYSTEM_FAILURE: Failed to trigger database connection alert - ${alertError instanceof Error ? alertError.message : 'Unknown error'}`);
  }
}

// פונקציית עזר לשליחת התראה למערכת saos-control-center
async function sendControlCenterAlert(
  timestamp: string,
  errorType: string,
  urlHint: string
) {
  try {
    const base = process.env.SAOS_CONTROL_CENTER_URL;
    if (!base) return; // בלי-יעד-מוגדר — התראה-שקטה-כנה (אפס-ניחושים)
    
    await fetch(`${base}/api/alerts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_type: 'unauthorized_database_connection_attempt',
        at: timestamp,
        service_id: 'saos-dex',
        url_hint,
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // אל-תשבור את ה-boot בגלל התראה
  }
}

const RAW_URL = process.env.DATABASE_URL ?? '';
const isDexOwnDb = /dex\.db(\?|$)/.test(RAW_URL) && !/custom\.db/.test(RAW_URL);
const timestamp = new Date().toISOString();

if (!isDexOwnDb) {
  // תיאור-מסנן-בלבד (חסר/לא-דקס/לא-ידוע) — בלי-גוף-הכתובת
  const desc = RAW_URL === '' ? '(חסר — הגדר DATABASE_URL ב-.env של saos-dex)' : /dex\.db/.test(RAW_URL) ? '(dex.db-קיים-אך-לא-עבר-את-הסינון)' : /custom\.db/.test(RAW_URL) ? '(מצביע-על-האם-אסור)' : '(כתובת-לא-ידועה — לא-מוצגת)';
  const errorMessage = `[saos-dex] DATABASE_URL נדחה (fail-closed): המנוע רשאי לגעת רק ב-dex.db שלו — קיבל: ${desc}`;
  
  // רישום לוג
  logDatabaseAccessAttempt(timestamp, 'INVALID_DATABASE_URL', errorMessage);
  
  // התראה פנימית
  await sendInternalAlert(timestamp, 'INVALID_DATABASE_URL', errorMessage, 'WARNING');
  
  // התראה למערכת saos-control-center
  const urlHint = createHash('sha256').update(RAW_URL).digest('hex').slice(0, 12);
  await sendControlCenterAlert(timestamp, 'INVALID_DATABASE_URL', urlHint);
  
  throw new Error(errorMessage);
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['query', 'info', 'warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db;