import { PrismaClient } from "@prisma/client";

// FIX(Roast-68 · db-scope-guard): נזק-חי-מתועד — תהליך-שירש-את-DATABASE_URL-של-הפלטפורמה-האם
// פתח-את-השרשרת-בתוך-db/custom.db-של-האם (בעקיפין-את-.env-של-האם) והשמיד-את-טבלאות-הכספת.
// מעתה: המנוע-מסרב-לעלות-אם-כתובת-ה-DB-אינה-dex.db-שלו-עצמו (fail-closed ב-boot).
const RAW_URL = process.env.DATABASE_URL ?? "";
const isDexOwnDb = /dex\.db(\?|$)/.test(RAW_URL) && !/custom\.db/.test(RAW_URL);
if (!isDexOwnDb) {
  // FIX(R16-a·m7): השגיאה הדפיסה את RAW_URL-הגולמי — URL-שגוי שמצביע-על-DB-אחר
  // (עם-credentials-מוטבעים user:pass@host) היה נשפך ללוגים/קריסת-בוט. עתה:
  // תיאור-מסנן-בלבד (חסר/לא-דקס/לא-ידוע) — בלי-גוף-הכתובת.
  const desc = RAW_URL === "" ? "(חסר — הגדר DATABASE_URL ב-.env של saos-dex)" : /dex\.db/.test(RAW_URL) ? "(dex.db-קיים-אך-לא-עבר-את-הסינון)" : /custom\.db/.test(RAW_URL) ? "(מצביע-על-האם-אסור)" : "(כתובת-לא-ידועה — לא-מוצגת)";
  const errorMessage = `[saos-dex] DATABASE_URL נדחה (fail-closed): המנוע רשאי לגעת רק ב-dex.db שלו — ` +
    `קיבל: ${desc}`;
  
  // מאובטח: לוג התראה עם חותמת זמן וסוג שגיאה, ללא חשיפת פרטי חיבור
  const timestamp = new Date().toISOString();
  console.warn(`[${timestamp}] DATABASE_CONNECTION_FAILURE: Invalid DATABASE_URL configuration - ${errorMessage}`);
  
  // הפעלת אירוע התראה למערכת הניטור הקיימת דרך פונקציה מרכזית
  try {
    const { alertDatabaseConnectionFailure } = await import("./dex/alert");
    alertDatabaseConnectionFailure({
      timestamp,
      errorType: "INVALID_DATABASE_URL",
      description: errorMessage,
      severity: "WARNING"
    });
  } catch (alertError) {
    // אם מערכת ההתראה לא זמינה, לא נפיל את האפליקציה - רק נלוג את הכשלון בהתראה
    console.warn(`[${timestamp}] ALERT_SYSTEM_FAILURE: Failed to trigger database connection alert - ${alertError instanceof Error ? alertError.message : "Unknown error"}`);
  }
  
  throw new Error(errorMessage);
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;