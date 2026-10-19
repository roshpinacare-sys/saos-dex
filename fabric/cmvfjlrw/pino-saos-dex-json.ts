import { createLogger, format, transports } from 'pino';
import { multistream } from 'pino-multi-stream';
import { once } from 'events';
import { createWriteStream } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// יצירת סטרימים לקבצי לוג נפרדים לפי רמות
const logStreams = [
  { level: 'error', stream: createWriteStream(join(__dirname, '../../logs/error.log')) },
  { level: 'warn', stream: createWriteStream(join(__dirname, '../../logs/warn.log')) },
  { level: 'info', stream: createWriteStream(join(__dirname, '../../logs/info.log')) },
  { level: 'debug', stream: createWriteStream(join(__dirname, '../../logs/debug.log')) },
];

// יצירת הלוגר הראשי עם Pino
const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  transport: multistream({
    streams: [
      ...logStreams,
      { stream: process.stdout } // גם לקונסול בפיתוח
    ]
  }),
  timestamp: format(),
  base: {
    pid: process.pid,
    hostname: require('os').hostname(),
    service: 'saos-dex'
  },
  mixin() {
    // הוספת מידע על מקור הלוג (קובץ ושורה)
    const stack = new Error().stack;
    const line = stack?.split('\n')[3]; // שורה עם המיקום של הלוג
    const fileMatch = line?.match(/at (?:.*\()?([^\/:]+):(\d+):\d+\)?/);
    
    return {
      source: fileMatch ? `${fileMatch[1]}:${fileMatch[2]}` : 'unknown'
    };
  },
  serializers: {
    err: (err) => ({
      type: err.type,
      message: err.message,
      stack: err.stack
    })
  }
});

// החלפת console.log ו-console.error עם Pino
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

console.log = (...args) => {
  logger.info(args.map(arg => 
    typeof arg === 'object' ? JSON.stringify(arg) : arg
  ).join(' '));
};

console.error = (...args) => {
  logger.error(args.map(arg => 
    typeof arg === 'object' ? JSON.stringify(arg) : arg
  ).join(' '));
};

// ייצוא הלוגר לשימוש בכל האפליקציה
export default logger;

// ייצוא פונקציות עזר לשימוש נוח
export const logDebug = (msg: string, ...args: any[]) => logger.debug(msg, ...args);
export const logInfo = (msg: string, ...args: any[]) => logger.info(msg, ...args);
export const logWarn = (msg: string, ...args: any[]) => logger.warn(msg, ...args);
export const logError = (msg: string, ...args: any[]) => logger.error(msg, ...args);

// פונקציית עזר ללוג שגיאות עם טרייסינג
export const logErrorWithTrace = (err: Error, context?: any) => {
  logger.error({
    message: err.message,
    stack: err.stack,
    context
  }, 'Error occurred');
};

// יצירת תיקיית לוגים אם לא קיימת
import { mkdirSync, existsSync } from 'fs';
const logsDir = join(__dirname, '../../logs');
if (!existsSync(logsDir)) {
  mkdirSync(logsDir, { recursive: true });
}
