import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";

// FIX(Roast-68 · db-scope-guard): נזק-חי-מתועד — תהליך-שירש-את-DATABASE_URL-של-הפלטפורמה-האם
// פתח-את-השרשרת-בתוך-db/custom.db-של-האם (בעקיפין-את-.env-של-האם) והשמיד-את-טבלאות-הכספת.
// מעתה: המנוע-מסרב-לעלות-אם-כתובת-ה-DB-אינה-dex.db-שלו-עצמו (fail-closed ב-boot).
// W10 · אשרור-הבעלים ("מאשר"): שתי-התראות-fail-open נוספו-על-ה-guard —
//   (1) cmvdww18: מודול-ההתראה-המקומי (src/lib/dex/alert.ts) — לוג-מבני + ledger-JSONL.
//   (2) cmvdxs6w (הגרסה-המתוקנת מ-REVIEW-W7): POST-חד-פעמי למקלט-הקונסולה /api/alerts —
//       env-gated (SAOS_CONTROL_CENTER_URL), sha256-12hex-במקום-כתובת, AbortSignal.timeout.
//   שתיהן-מאובטחות-מדידה-וללא-סודות. ה-throw-הבלתי-מותנה-בסוף-הוא-החוק: ההגנה-fail-closed,
//   ההתראות-fail-open — כישלון-התראה-אינו-מרכך-את-ההגנה-ולא-מפיל-boot.
const RAW_URL = process.env.DATABASE_URL ?? "";
const isDexOwnDb = /dex\.db(\?|$)/.test(RAW_URL) && !/custom\.db/.test(RAW_URL);
if (!isDexOwnDb) {
  // FIX(R16-a·m7): השגיאה הדפיסה את RAW_URL-הגולמי — URL-שגוי שמצביע-על-DB-אחר
  // (עם-credentials-מוטבעים user:pass@host) היה נשפך ללוגים/קריסת-בוט. עתה:
  // תיאור-מסנן-בלבד (חסר/לא-דקס/לא-ידוע) — בלי-גוף-הכתובת.
  const desc = RAW_URL === "" ? "(חסר — הגדר DATABASE_URL ב-.env של saos-dex)" : /dex\.db/.test(RAW_URL) ? "(dex.db-קיים-אך-לא-עבר-את-הסינון)" : /custom\.db/.test(RAW_URL) ? "(מצביע-על-האם-אסור)" : "(כתובת-לא-ידועה — לא-מוצגת)";
  const errorMessage =
    `[saos-dex] DATABASE_URL נדחה (fail-closed): המנוע רשאי לגעת רק ב-dex.db שלו — ` +
    `קיבל: ${desc}`;
  const timestamp = new Date().toISOString();

  // התראה-1 (cmvdww18 · מאושר): המודול-המקומי — fail-open, מדודה-בפנים
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
      // אם מערכת ההתראה לא זמינה, לא נפיל את האפליקציה - רק נלוג את הכשלון בהתראה
      console.warn(`[${timestamp}] ALERT_SYSTEM_FAILURE: Failed to trigger database connection alert - ${alertError instanceof Error ? alertError.message : "Unknown error"}`);
    }
  })();

  // התראה-2 (cmvdxs6w · הגרסה-המתוקנת מ-REVIEW-W7 · מאושר): POST-למקלט-הקונסולה — fail-open
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
          // digest אמיתי — אינו-הפיך (תיקון-מדוד של-base64-ההפיך-מההצעה-המקורית)
          url_hint: createHash("sha256").update(RAW_URL).digest("hex").slice(0, 12),
        }),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // אל-תשבור את ה-boot בגלל התראה
    }
  })();

  // התראה-3 (חדשה): Webhook חיצוני דרך ALERT_WEBHOOK_URL — fail-open, מודולרי
  void (async () => {
    try {
      const webhookUrl = process.env.ALERT_WEBHOOK_URL;
      if (!webhookUrl) return; // לא מוגדר — התראה שקטה
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: "unauthorized_database_connection_attempt",
          at: timestamp,
          service_id: "saos-dex",
          error_type: "INVALID_DATABASE_URL",
          description: errorMessage,
          severity: "WARNING",
          url_hint: createHash("sha256").update(RAW_URL).digest("hex").slice(0, 12),
        }),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // אל-תשבור את ה-boot בגלל התראה
    }
  })();

  // רישום לוג מאובטח (ללא פרטי חיבור רגישים)
  console.warn(`[${timestamp}] DATABASE_ACCESS_DENIED: ${errorMessage}`);

  throw new Error(errorMessage);
}

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  log: [
    { level: "query", emit: "event" },
    { level: "error", emit: "event" },
    { level: "warn", emit: "event" },
  ],
});

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

// רישום אירועי שגיאה של Prisma ללוג מאובטח
prisma.$on("error", (e) => {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] PRISMA_ERROR: ${e.message}`);
  
  // שליחת התראה על שגיאת Prisma למערכת ניטור
  void (async () => {
    try {
      const webhookUrl = process.env.ALERT_WEBHOOK_URL;
      if (!webhookUrl) return;
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: "prisma_database_error",
          at: timestamp,
          service_id: "saos-dex",
          error_message: e.message,
          severity: "ERROR",
        }),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // אל-תשבור את הפעילות בגלל התראה
    }
  })();
});

// רישום אזהרות של Prisma
prisma.$on("warn", (e) => {
  const timestamp = new Date().toISOString();
  console.warn(`[${timestamp}] PRISMA_WARN: ${e.message}`);
});