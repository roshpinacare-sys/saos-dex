// alert.ts — מודול-ההתראות-המקומי-של-המנוע (W10 · cmvdww18 — מאושר-על-ידי-הבעלים)
// ═══════════════════════════════════════════════════════════════════════════════
// אמת-ולא-מוק: כל-התראה = שורת-console מבנית + שורה-ב-ledger-מקומי (logs/alerts.jsonl).
// אין-רשת, אין-סודות, אין-תלות-חיצונית. fail-open תמיד: כישלון-התראה
// לעולם-לא-מרכך-הגנה-ולא-מפיל-boot (הזורקים-האמיתיים-חיים-בקריאה-שמפעילה-אותנו).
import { appendFile, mkdir, stat, truncate, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type DexAlert = {
  timestamp: string;
  errorType: string;
  description: string;
  severity: "INFO" | "WARNING" | "ERROR" | "CRITICAL";
};

const LEDGER = resolve(process.cwd(), "logs", "alerts.jsonl");
const LEDGER_MAX_BYTES = 1_000_000; // תקרת-ledger — מעבר: קיצוץ-ל-100-האחרונות
const DEDUPE_MS = 60_000; // אותו-אירוע-בדיוק: לא-יותר-מפעם-בדקה
const lastSeen = new Map<string, number>();

export async function alertDatabaseConnectionFailure(alert: DexAlert): Promise<void> {
  // מדודה: אותו-errorType+description בתוך-דקה — דילוג (הלוג-הראשון-כבר-שם)
  const key = `${alert.errorType}|${alert.description}`;
  const now = Date.now();
  const prev = lastSeen.get(key);
  if (prev !== undefined && now - prev < DEDUPE_MS) return;
  lastSeen.set(key, now);
  // אנטי-נפיחה: מפת-הדדופיקציה-לא-תגדל-ללא-תקרה
  if (lastSeen.size > 1_000) {
    const oldest = lastSeen.keys().next().value;
    if (oldest !== undefined) lastSeen.delete(oldest);
  }

  // ערוץ-1 (תמיד): לוג-מבני — נראה-בכל-צפיית-לוגים
  console.warn(JSON.stringify({ channel: "dex-alert", ...alert }));

  // ערוץ-2 (מיטבי): ledger-מקומי — קובץ-אמיתי-שניתן-ל-tail/לסריקה
  try {
    await mkdir(dirname(LEDGER), { recursive: true });
    try {
      const st = await stat(LEDGER);
      if (st.size > LEDGER_MAX_BYTES) {
        // קיצוץ-כנה: שומר-100-שורות-אחרונות, ממשיך
        const tail = await readFile(LEDGER, "utf8");
        const lines = tail.trim().split("\n").slice(-100);
        await truncate(LEDGER, 0);
        if (lines.length > 0) await appendFile(LEDGER, lines.join("\n") + "\n", "utf8");
      }
    } catch {
      // הקובץ-כנראה-טרם-קיים — ה-append-למטה-ייצור-אותו
    }
    await appendFile(LEDGER, JSON.stringify(alert) + "\n", "utf8");
  } catch {
    // fail-open: כישלון-ledger-אינו-כישלון-הגנה
  }
}
