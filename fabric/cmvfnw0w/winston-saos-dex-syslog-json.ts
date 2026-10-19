import winston from 'winston';
import { Syslog } from 'winston-syslog';
import { inspect } from 'util';

// טיפוסים מותאמים לצרכי ה-DEX
interface LogMetadata {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  source: string;
  category: 'security' | 'operational' | 'database' | 'api' | 'default';
  tags?: string[];
  [key: string]: unknown;
}

interface LogContext {
  [key: string]: unknown;
}

// פונקציית פורמט לוגים בפורמט JSON
const jsonFormat = winston.format.printf(({ level, message, source, category, tags, timestamp, ...meta }) => {
  const logData: LogMetadata = {
    timestamp,
    level,
    source: source || 'unknown',
    category: category || 'default',
    tags: tags || [],
    ...meta,
    message
  };
  return JSON.stringify(logData);
});

// פונקציית פורמט לוגים לקונסול (קריא לבני אדם)
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, source, category, tags, ...meta }) => {
    const tagStr = tags && tags.length > 0 ? `[${tags.join(', ')}]` : '';
    const categoryStr = category ? `[${category}]` : '';
    const metaStr = Object.keys(meta).length > 0 ? inspect(meta, { colors: true, depth: 2 }) : '';
    return `${timestamp} [${level}] ${source || 'unknown'} ${categoryStr} ${tagStr}: ${message} ${metaStr}`;
  })
);

// יצירת הלוגר הראשי
const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.metadata()
  ),
  transports: [
    // טרנספורט לקונסול עם פורמט קריא לבני אדם (לפיתוח)
    new winston.transports.Console({
      format: consoleFormat,
      level: 'debug',
      silent: process.env.NODE_ENV === 'production'
    }),
    // טרנספורט לקובץ JSON (לייצוא וניתוח)
    new winston.transports.File({
      filename: 'logs/dex.log',
      format: jsonFormat,
      maxsize: 5242880, // 5MB
      maxFiles: 5,
      tailable: true
    }),
    // טרנספורט ל-Syslog (לאחסון ארוך טווח)
    process.env.SYSLOG_HOST && process.env.SYSLOG_PORT ? new Syslog({
      host: process.env.SYSLOG_HOST,
      port: parseInt(process.env.SYSLOG_PORT, 10),
      protocol: 'tcp',
      path: '/dev/log',
      app_name: 'saos-dex',
      format: 'plain',
      localhost: 'saos-dex'
    }) : undefined
  ].filter(Boolean)
});

// פונקציות לוג עם קטגוריות
export const log = {
  debug: (message: string, context?: LogContext, source?: string, category?: string, tags?: string[]) => {
    logger.debug(message, { ...context, source, category, tags });
  },
  info: (message: string, context?: LogContext, source?: string, category?: string, tags?: string[]) => {
    logger.info(message, { ...context, source, category, tags });
  },
  warn: (message: string, context?: LogContext, source?: string, category?: string, tags?: string[]) => {
    logger.warn(message, { ...context, source, category, tags });
  },
  error: (message: string, context?: LogContext, source?: string, category?: string, tags?: string[]) => {
    logger.error(message, { ...context, source, category, tags });
  }
};

// פונקציית עזר ללוג שגיאות עם stack trace
export const logError = (error: Error | unknown, context?: LogContext, source?: string, category?: string, tags?: string[]) => {
  if (error instanceof Error) {
    log.error(error.message, { ...context, stack: error.stack, source, category, tags });
  } else {
    log.error(String(error), { ...context, source, category, tags });
  }
};

// פונקציית עזר ללוג ביצוע API
export const logApi = (method: string, path: string, statusCode: number, duration: number, context?: LogContext) => {
  const category = statusCode >= 400 ? 'error' : 'info';
  log[category](`API ${method} ${path}`, {
    ...context,
    method,
    path,
    statusCode,
    duration
  }, 'api-request', 'api');
};

// פונקציית עזר ללוג פעולות אבטחה
export const logSecurity = (action: string, result: 'success' | 'failure', details?: LogContext, source?: string) => {
  log(result === 'success' ? 'info' : 'error', 
    { action, result, ...details }, 
    source, 
    'security',
    result === 'failure' ? ['security-alert'] : undefined
  );
};

// פונקציית עזר ללוג פעולות מסד נתונים
export const logDatabase = (operation: string, table?: string, result: 'success' | 'failure' | 'partial' = 'success', details?: LogContext) => {
  log(result === 'success' ? 'info' : 'warn',
    { operation, table, result, ...details },
    'database',
    'database',
    result !== 'success' ? ['db-warning'] : undefined
  );
};

// פונקציית עזר ללוג פעולות מערכת
export const logOperational = (system: string, action: string, status: 'started' | 'completed' | 'failed', details?: LogContext) => {
  log(status === 'failed' ? 'error' : status === 'started' ? 'info' : 'debug',
    { system, action, status, ...details },
    'system-operations',
    'operational'
  );
};

// חלופה ל-console.log
export const console = {
  log: (...args: unknown[]) => {
    log.info(args.map(arg => typeof arg === 'object' ? inspect(arg, { depth: 2 }) : String(arg)).join(' '), {}, 'console');
  },
  error: (...args: unknown[]) => {
    log.error(args.map(arg => typeof arg === 'object' ? inspect(arg, { depth: 2 }) : String(arg)).join(' '), {}, 'console');
  },
  warn: (...args: unknown[]) => {
    log.warn(args.map(arg => typeof arg === 'object' ? inspect(arg, { depth: 2 }) : String(arg)).join(' '), {}, 'console');
  },
  debug: (...args: unknown[]) => {
    log.debug(args.map(arg => typeof arg === 'object' ? inspect(arg, { depth: 2 }) : String(arg)).join(' '), {}, 'console');
  }
};

// ייצוא הלוגר לשימוש בכל המערכת
export default logger;
