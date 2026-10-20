import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";

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

  // Correlation ID & Event Fingerprinting
  const eventId = randomUUID();
  const errorCode = "INVALID_DATABASE_URL";
  const dbHost = extractDbHost(RAW_URL);
  const dbPort = extractDbPort(RAW_URL);
  const fingerprint = createFingerprint(errorCode, dbHost, dbPort, "DATABASE_URL rejected: {desc}");

  // התראה-1 (cmvdww18 · מאושר): המודול-המקומי — fail-open, מדודה-בפנים
  void (async () => {
    try {
      const { alertDatabaseConnectionFailure } = await import("./dex/alert");
      await alertDatabaseConnectionFailure({
        timestamp,
        errorType: errorCode,
        description: errorMessage,
        severity: "WARNING",
        eventId,
        fingerprint,
      });
    } catch (alertError) {
      // אם מערכת ההתראה לא זמינה, לא נפיל את האפליקציה - רק נלוג את הכשלון בהתראה
      console.warn(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          eventId,
          fingerprint,
          action: "ALERT_SYSTEM_FAILURE",
          error: alertError instanceof Error ? alertError.message : "Unknown error",
        })
      );
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
          event_id: eventId,
          fingerprint,
          error_code: errorCode,
          db_host: dbHost,
          db_port: dbPort,
          // digest אמיתי — אינו-הפיך (תיקון-מדוד של-base64-ההפיך-מההצעה-המקורית)
          url_hint: createHash("sha256").update(RAW_URL).digest("hex").slice(0, 12),
        }),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // אל-תשבור את ה-boot בגלל התראה
    }
  })();

  // Structured log with correlation ID
  console.error(
    JSON.stringify({
      timestamp,
      eventId,
      fingerprint,
      level: "ERROR",
      message: errorMessage,
      errorCode,
      dbHost,
      dbPort,
    })
  );

  throw new Error(errorMessage);
}

function extractDbHost(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname || "unknown";
  } catch {
    return "unknown";
  }
}

function extractDbPort(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.port || "default";
  } catch {
    return "unknown";
  }
}

function createFingerprint(errorCode: string, dbHost: string, dbPort: string, template: string): string {
  const input = `${errorCode}|${dbHost}|${dbPort}|${template}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: [
      { emit: "event", level: "query" },
      { emit: "stdout", level: "error" },
      { emit: "stdout", level: "warn" },
    ],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export default prisma;