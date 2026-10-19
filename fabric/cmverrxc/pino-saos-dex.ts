import pino from 'pino';

// --- ייצור מופע Pino מרכזי עם קונפיגורציה ברירת מחדל ---
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    // הוספת מטא-דאטה סטנדרטי לכל לוג
    level: (label) => ({
      level: label,
    }),
    bindings: (bindings) => ({
      pid: bindings.pid,
      hostname: bindings.hostname,
      // ניתן להוסיף קונטקסט גלובלי כאן, למשל מ-ID טרנזקציה
      // transactionId: getActiveTransactionId(),
    }),
  },
  // הגדרת פורמט JSON סטנדרטי
  messageKey: 'msg',
});

// --- פונקציית עזר ללוגים מובנים (סטרקצוריזד) ---
/**
 * יוצר לוג מובנה עם מבנה קבוע לפי סוג האירוע.
 * @param level רמת הלוג ('info', 'error', 'warn', 'debug')
 * @param event סוג האירוע (למשל 'TRADE_EXECUTED', 'DB_CONNECTION_FAILED')
 * @param data אובייקט עם נתונים ספציפיים לאירוע
 * @param meta אובייקט עם מטא-דאטה נוסף (כמו קובץ, שורה)
 */
export function logStructured(
  level: 'info' | 'error' | 'warn' | 'debug',
  event: string,
  data: Record<string, unknown> = {},
  meta: Record<string, unknown> = {}
) {
  const logData = {
    event,
    ...data,
    // הוספת מיקום מקור (קובץ ושורה) אם זמין
    ...(meta.file && meta.line && { source: `${meta.file}:${meta.line}` }),
  };

  logger[level](logData, meta);
}

// --- ייצוא ה-logger המרכזי ופונקציית העזר ---
export { logger };

// --- דוגמאות לאינטגרציה בקבצים קיימים (להחלפת console.log/error) ---

// דוגמה להחלפת לוגים ב src/middleware.ts
// במקום:
// console.warn(JSON.stringify({ ... }));
// יש להשתמש ב:
// logStructured('warn', 'TRAFFIC_ALERT', { ip, path }, { file: 'src/middleware.ts', line: 123 });

// דוגמה להחלפת לוגים ב src/lib/db.ts
// במקום:
// console.warn(`[${timestamp}] ALERT_SYSTEM_FAILURE: ...`);
// יש להשתמש ב:
// logStructured('error', 'ALERT_SYSTEM_FAILURE', { message: '...', timestamp }, { file: 'src/lib/db.ts', line: 45 });

// דוגמה להחלפת לוגים ב src/lib/hive-rail.ts
// במקום:
// throw new Error(json.error.message ?? "rpc error");
// יש להשתמש ב:
// logStructured('error', 'RPC_ERROR', { method, params: JSON.stringify(params), error: json.error?.message }, { file: 'src/lib/hive-rail.ts', line: 78 });
// ואז לזרוק את השגיאה