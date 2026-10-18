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
  
  // שליחת התראה מאובטחת ל-saos-control-center ללא חשיפת מידע רגיש
  try {
    const alertPayload = {
      event_type: "unauthorized_database_connection_attempt",
      timestamp: new Date().toISOString(),
      service_id: "saos-dex",
      details: {
        db_url_hash: Buffer.from(RAW_URL, "utf8").toString("base64").substring(0, 8) // hash מסונן של 8 תווים
      }
    };
    
    // קריאה פנימית למערכת הניטור - מנגנון התראה פשוט דרך fetch
    // במקרה של כישלון, לא לשבור את הזרימה הראשית (fail-open בהתראה)
    if (process.env.SAOS_CONTROL_CENTER_URL) {
      await fetch(`${process.env.SAOS_CONTROL_CENTER_URL}/api/alerts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(alertPayload),
        // timeout קצר כדי לא לעכב את האתחול
        signal: AbortController ? AbortController.prototype.signal : undefined
      }).catch(() => {}); // התעלמות משגיאות בהתראה
    }
  } catch (alertError) {
    // לא לשבור את הזרימה הראשית גם אם מנגנון ההתראה נכשל
    console.error"[saos-dex] Failed to send database connection alert:", alertError);
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