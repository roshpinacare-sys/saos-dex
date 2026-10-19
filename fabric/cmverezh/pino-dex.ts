import { createWriteStream } from 'fs';
import { join } from 'path';
import pino from 'pino';
import pinoPretty from 'pino-pretty';

// הגדרת סטרים ללוגים
const logStream = createWriteStream(join('/var/log/saos/dex/app.log'), { flags: 'a' });
const prettyStream = pinoPretty({
  destination: logStream,
  colorize: false,
  ignore: 'pid,module',
  translateTime: 'yyyy-mm-dd HH:MM:ss',
  singleLine: true,
});

// יצירת logger עם פורמט JSON ומאפיינים מובנים
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.iso,
  formatters: {
    level: (label) => ({ level: label }),
    bindings: (bindings) => ({
      pid: bindings.pid,
      module: bindings.module || 'unknown',
    }),
  },
}, prettyStream);

// תוסף לזיהוי אוטומטי של שם קובץ
const getFileAndLine = () => {
  const stack = new Error().stack?.split('\n') || [];
  const caller = stack[3] || stack[2] || '';
  const match = caller.match(/\(([^)]+)\)/);
  const fileAndLine = match ? match[1] : 'unknown:0';
  const [file, line] = fileAndLine.split(':');
  return {
    file: file.split('/').pop() || 'unknown',
    line: line || '0',
  };
};

// יצירת פונקציות לוג מותאמות
const createLogger = (module?: string) => {
  const { file } = getFileAndLine();
  return {
    debug: (message: string, obj?: any) => {
      logger.debug({ message, module: module || file, ...obj });
    },
    info: (message: string, obj?: any) => {
      logger.info({ message, module: module || file, ...obj });
    },
    warn: (message: string, obj?: any) => {
      logger.warn({ message, module: module || file, ...obj });
    },
    error: (message: string, obj?: any) => {
      logger.error({ message, module: module || file, ...obj });
    },
  };
};

// החלפת console.log/error בלוגים
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

console.log = (...args: any[]) => {
  const message = args.map(arg => 
    typeof arg === 'object' ? JSON.stringify(arg) : arg
  ).join(' ');
  createLogger().info(message);
};

console.error = (...args: any[]) => {
  const message = args.map(arg => 
    typeof arg === 'object' ? JSON.stringify(arg) : arg
  ).join(' ');
  createLogger().error(message);
};

// ייצור logger גלובלי
export const log = createLogger();

// ייצור logger ספציפי למודולים
export const dbLogger = createLogger('db');
export const railLogger = createLogger('hive-rail');
export const middlewareLogger = createLogger('middleware');

// טיפול בלוגים מסוג RPC errors מ-hive-rail.ts
export const logRpcError = (error: Error, account?: string) => {
  railLogger.error('RPC error', {
    error: error.message,
    stack: error.stack,
    account,
    timestamp: new Date().toISOString(),
  });
};

// טיפול בלוגים מסוג rate limiting מ-middleware.ts
export const logRateLimit = (ip: string, path: string, limit: number) => {
  middlewareLogger.warn('Rate limit exceeded', {
    ip,
    path,
    limit,
    timestamp: new Date().toISOString(),
  });
};

// טיפול בלוגים מסוג connection errors מ-db.ts
export const logDbConnectionError = (error: Error, urlHint?: string) => {
  dbLogger.error('Database connection error', {
    error: error.message,
    stack: error.stack,
    urlHint,
    timestamp: new Date().toISOString(),
  });
};

// ייצור logger עבור כל קובץ
export default createLogger;