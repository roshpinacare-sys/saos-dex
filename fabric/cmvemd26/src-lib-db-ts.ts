import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";

// פונקציית ניתוח והתראה על ניסיונות גישה סורר למסד נתונים
interface DatabaseAccessAttempt {
  timestamp: string;
  url: string;
  error: string;
  ip?: string;
  userAgent?: string;
}

interface DatabaseAccessStats {
  totalAttempts: number;
  failedAttempts: number;
  suspiciousPatterns: {
    ip: string;
    count: number;
    lastAttempt: string;
  }[];
}

const accessAttempts: DatabaseAccessAttempt[] = [];
const accessStats: DatabaseAccessStats = {
  totalAttempts: 0,
  failedAttempts: 0,
  suspiciousPatterns: [],
};

const MAX_LOG_ENTRIES = 1000;
const ALERT_THRESHOLD = 5; // מספר ניסיונות כושלים מאותו IP כדי להפעיל התראה
const SUSPICIOUS_THRESHOLD = 3; // מספר ניסיונות כושלים בזמן קצר

/**
 * רושם ניסיון גישה למסד נתונים ומעדכן סטטיסטיקה
 * @param attempt פרטי ניסיון הגישה
 */
function logDatabaseAccess(attempt: DatabaseAccessAttempt): void {
  accessAttempts.push(attempt);
  accessStats.totalAttempts++;
  
  // שמירה על גודל לוג מוגבל
  if (accessAttempts.length > MAX_LOG_ENTRIES) {
    accessAttempts.shift();
  }
  
  // עדכון סטטיסטיקת ניסיונות כושלים
  if (attempt.error.includes("INVALID_DATABASE_URL")) {
    accessStats.failedAttempts++;
    
    // ניתוח דפוסים חשודים
    analyzeSuspiciousPatterns(attempt);
    
    // בדיקה אם יש צורך בהתראה חיצונית
    checkForAlert(attempt);
  }
}

/**
 * מנתח דפוסים חשודים בניסיונות גישה כושלים
 * @param attempt ניסיון גישה חדש
 */
function analyzeSuspiciousPatterns(attempt: DatabaseAccessAttempt): void {
  const now = new Date().getTime();
  const timeWindow = 5 * 60 * 1000; // 5 דקות
  
  // מציאת ניסיונות קודמים מאותו IP בחלון הזמן
  const recentAttempts = accessAttempts.filter(a => 
    a.ip === attempt.ip && 
    (new Date(a.timestamp).getTime() > now - timeWindow)
  );
  
  // אם יש דפוס חשוד, נוסיף לרשימה
  if (recentAttempts.length >= SUSPICIOUS_THRESHOLD) {
    const existingPattern = accessStats.suspiciousPatterns.find(p => p.ip === attempt.ip);
    
    if (existingPattern) {
      existingPattern.count = recentAttempts.length;
      existingPattern.lastAttempt = attempt.timestamp;
    } else {
      accessStats.suspiciousPatterns.push({
        ip: attempt.ip || "unknown",
        count: recentAttempts.length,
        lastAttempt: attempt.timestamp,
      });
    }
  }
}

/**
 * בודק אם יש צורך בהפעלת התראה חיצונית
 * @param attempt ניסיון גישה חדש
 */
async function checkForAlert(attempt: DatabaseAccessAttempt): Promise<void> {
  // בדיקה אם ה-IP חורג מסף ההתראה
  const suspiciousPattern = accessStats.suspiciousPatterns.find(p => p.ip === attempt.ip);
  
  if (suspiciousPattern && suspiciousPattern.count >= ALERT_THRESHOLD) {
    await triggerExternalAlert({
      ...suspiciousPattern,
      errorType: "SUSPICIOUS_DATABASE_ACCESS",
      description: `Multiple failed database access attempts detected from IP: ${attempt.ip}`,
    });
  }
}

/**
 * מפעיל התראה חיצונית
 * @param alertData נתוני ההתראה
 */
async function triggerExternalAlert(alertData: {
  ip: string;
  count: number;
  lastAttempt: string;
  errorType: string;
  description: string;
}): Promise<void> {
  try {
    const base = process.env.SAOS_CONTROL_CENTER_URL;
    if (!base) return; // בלי יעד מוגדר - התראה שקטה
    
    await fetch(`${base}/api/alerts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: alertData.errorType,
        at: new Date().toISOString(),
        service_id: "saos-dex",
        ip: alertData.ip,
        attempts_count: alertData.count,
        last_attempt: alertData.lastAttempt,
        description: alertData.description,
        severity: "HIGH",
      }),
      signal: AbortSignal.timeout(3000),
    });
    
    console.log(`[${new Date().toISOString()}] External alert triggered for suspicious database access from IP: ${alertData.ip}`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Failed to trigger external alert:`, error);
  }
}

/**
 * מחזיר סטטיסטיקה של ניסיונות הגישה למסד הנתונים
 */
function getDatabaseAccessStats(): DatabaseAccessStats {
  return { ...accessStats };
}

// הקוד הקיים בקובץ
const RAW_URL = process.env.DATABASE_URL ?? "";
const isDexOwnDb = /dex\.db(\?|$)/.test(RAW_URL) && !/custom\.db/.test(RAW_URL);

if (!isDexOwnDb) {
  // תיאור מסנן בלבד (חס/לא-דקס/לא-ידוע) - בלי גוף הכתובת
  const desc = RAW_URL === "" ? "(חסר — הגדר DATABASE_URL ב-.env של saos-dex)" : /dex\.db/.test(RAW_URL) ? "(dex.db-קיים-אך-לא-עבר-את-הסינון)" : /custom\.db/.test(RAW_URL) ? "(מצביע-על-האם-אסור)" : "(כתובת-לא-ידועה — לא-מוצגת)";
  const errorMessage = `[saos-dex] DATABASE_URL נדחה (fail-closed): המנוע רשאי לגעת רק ב-dex.db שלו — קיבל: ${desc}`;
  const timestamp = new Date().toISOString();

  // רישום ניסיון הגישה הכושל
  logDatabaseAccess({
    timestamp,
    url: "DATABASE_URL",
    error: "INVALID_DATABASE_URL",
    ip: process.env.REMOTE_ADDR || "unknown",
    userAgent: process.env.HTTP_USER_AGENT || "unknown",
  });

  // התראה-1 (cmvdww18 · מאושר): המודול-המקומי
  void (async () => {
    try {
      const { alertDatabaseConnectionFailure } = await import("./dex/alert");
      await alertDatabaseConnectionFailure({
        timestamp,
        errorType: "INVALID_DATABASE_URL",
        description: errorMessage,
        severity: "WARNING",
      });
    } catch (alertError) {
      console.warn(`[${timestamp}] ALERT_SYSTEM_FAILURE: Failed to trigger database connection alert - ${alertError instanceof Error ? alertError.message : "Unknown error"}`);
    }
  })();

  // התראה-2 (cmvdxs6w · הגרסה-המתוקנת מ-REVIEW-W7 · מאושר): POST-למקלט-הקונסולה
  void (async () => {
    try {
      const base = process.env.SAOS_CONTROL_CENTER_URL;
      if (!base) return; // בלי-יעד-מוגדר — התראה-שקטה-כנה (אפס-ניחושים)
      await fetch(`${base}/api/alerts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: "unauthorized_database_connection_attempt",
          at: timestamp,
          service_id: "saos-dex",
          url_hint: createHash("sha256").update(RAW_URL).digest("hex").slice(0, 12),
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

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

// ייצור פונקציית ניתוח לשימוח חיצוני
export { logDatabaseAccess, getDatabaseAccessStats, analyzeSuspiciousPatterns };
