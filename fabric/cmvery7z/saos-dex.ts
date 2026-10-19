import { createLogger, format, transports } from 'winston';
import { join } from 'path';

// קונפיגורציה לפי סביבה
const isProduction = process.env.NODE_ENV === 'production';
const logLevel = isProduction ? 'info' : 'debug';

// פורמט JSON סטרוקטורלי
const jsonFormat = format.combine(
  format.timestamp({
    format: 'YYYY-MM-DD HH:mm:ss'
  }),
  format.errors({ stack: true }),
  format.json({
    replacer: (key, value) => {
      // הסרת פונקציות מהלוגים
      if (typeof value === 'function') return undefined;
      return value;
    }
  })
);

// פורמט לקונסול בפיתוח
const consoleFormat = format.combine(
  format.colorize(),
  format.simple(),
  format.printf(({ timestamp, level, message, ...meta }) => {
    return `${timestamp} [${level}]: ${message} ${Object.keys(meta).length ? JSON.stringify(meta, null, 2) : ''}`;
  })
);

// יצירת לוגר מרכזי
export const logger = createLogger({
  level: logLevel,
  format: jsonFormat,
  defaultMeta: {
    service: 'saos-dex',
    pid: process.pid,
    hostname: require('os').hostname()
  },
  transports: [
    // טרנספורט לקונסול (פיתוח בלבד)
    ...(isProduction ? [] : [new transports.Console({ format: consoleFormat })]),
    // טרנספורט לקובץ לוגים
    new transports.File({
      filename: join(process.cwd(), 'logs', 'combined.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
      tailable: true
    }),
    // טרנספורט לוגים של שגיאות בלבד
    new transports.File({
      filename: join(process.cwd(), 'logs', 'error.log'),
      level: 'error',
      maxsize: 5242880,
      maxFiles: 5,
      tailable: true
    })
  ]
});

// יצירת לוגר ספציפי לחיבורי מסד נתונים
export const dbLogger = logger.child({ module: 'database' });

// יצירת לוגר ספציפי לקריאות RPC
export const rpcLogger = logger.child({ module: 'rpc' });

// יצירת לוגר ספציפי ל-rate limiting
export const rateLimitLogger = logger.child({ module: 'rate-limit' });

// פונקציות עזר להחלפת console.log/error
export const log = {
  debug: (message: string, meta?: any) => logger.debug(message, { ...meta, file: getCallerFile(), line: getCallerLine() }),
  info: (message: string, meta?: any) => logger.info(message, { ...meta, file: getCallerFile(), line: getCallerLine() }),
  warn: (message: string, meta?: any) => logger.warn(message, { ...meta, file: getCallerFile(), line: getCallerLine() }),
  error: (message: string, meta?: any) => logger.error(message, { ...meta, file: getCallerFile(), line: getCallerLine() })
};

// פונקציה לקבלת שם הקובץ הקורא (להצגה בלוג)
function getCallerFile(): string {
  const originalPrepareStackTrace = Error.prepareStackTrace;
  let callerFile: string | undefined;
  
  Error.prepareStackTrace = (_, stack) => {
    // הפונקציה הנוכחית (getCallerFile)
    // הפונקציה הקוראת (log.debug/info/warn/error)
    // הפונקציה שהפעילה את פונקציית הלוג (המקור)
    return stack[2];
  };
  
  const err = new Error();
  const stack = err.stack as unknown as NodeJS.CallSite[];
  
  if (stack && stack[2]) {
    callerFile = stack[2].getFileName() || '';
  }
  
  Error.prepareStackTrace = originalPrepareStackTrace;
  return callerFile ? callerFile.split('/').pop() || '' : '';
}

// פונקציה לקבלת מספר השורה הקוראת
function getCallerLine(): number {
  const originalPrepareStackTrace = Error.prepareStackTrace;
  let callerLine: number | undefined;
  
  Error.prepareStackTrace = (_, stack) => {
    return stack[2];
  };
  
  const err = new Error();
  const stack = err.stack as unknown as NodeJS.CallSite[];
  
  if (stack && stack[2]) {
    callerLine = stack[2].getLineNumber();
  }
  
  Error.prepareStackTrace = originalPrepareStackTrace;
  return callerLine || 0;
}

// ייצוא לשימוש בכל הפרויקט
export default logger;
