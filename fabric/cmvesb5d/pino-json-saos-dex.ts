import { createLogger, transport } from 'pino';
import { multistream } from 'pino-multi-stream';
import { once } from 'node:events';
import { Writable } from 'node:stream';

// Define log levels
export const logLevels = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
} as const;

type LogLevel = keyof typeof logLevels;

// Define log message structure
export interface LogMessage {
  level: LogLevel;
  time: string;
  pid: number;
  hostname: string;
  msg: string;
  file?: string;
  line?: number;
  col?: number;
  stack?: string;
  [key: string]: unknown;
}

// Custom transport for JSON logging with file/line info
const jsonTransport = transport({
  target: 'pino-pretty',
  options: {
    colorize: false,
    translateTime: 'yyyy-mm-dd HH:MM:ss.l',
    ignore: 'pid,hostname,level',
    messageFormat: '{msg} {file}:{line}:{col}',
  },
});

// Create logger instance
export const logger = createLogger({
  level: process.env.NODE_ENV === 'production' ? 'error' : 'info',
  timestamp: () => `"time":"${new Date().toISOString()}"`,
  base: {
    pid: process.pid,
    hostname: require('node:os').hostname(),
  },
});

// Add console transport for development
if (process.env.NODE_ENV !== 'production') {
  logger.add(transport({
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'yyyy-mm-dd HH:MM:ss.l',
      ignore: 'pid,hostname',
    },
  }));
}

// Add JSON transport for all environments
logger.add(jsonTransport);

// Helper to capture file/line info
export function log(level: LogLevel, msg: string, ...args: unknown[]) {
  const err = new Error();
  const stack = err.stack?.split('\n');
  const caller = stack?.[3]; // 3rd line up is our caller
  
  const fileMatch = caller?.match(/\(([^)]+)\)/);
  const file = fileMatch ? fileMatch[1] : undefined;
  
  const lineMatch = caller?.match(/:(\d+):/);
  const line = lineMatch ? parseInt(lineMatch[1]) : undefined;
  
  const colMatch = caller?.match(/:(\d+)\)/);
  const col = colMatch ? parseInt(colMatch[1]) : undefined;
  
  logger[level]({ msg, file, line, col }, ...args);
}

// Wrapper functions for each log level
export const debug = (msg: string, ...args: unknown[]) => log('debug', msg, ...args);
export const info = (msg: string, ...args: unknown[]) => log('info', msg, ...args);
export const warn = (msg: string, ...args: unknown[]) => log('warn', msg, ...args);
export const error = (msg: string, ...args: unknown[]) => log('error', msg, ...args);

// Middleware for logging HTTP requests
export function loggingMiddleware(req: Request, res: Response, next: () => void) {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    const logData = {
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      userAgent: req.headers.get('user-agent'),
      ip: req.headers.get('x-forwarded-for') || req.socket.remoteAddress,
    };
    
    if (res.statusCode >= 500) {
      error('HTTP request error', logData);
    } else if (res.statusCode >= 400) {
      warn('HTTP request warning', logData);
    } else {
      info('HTTP request', logData);
    }
  });
  
  next();
}

// Validator for log messages
export function validateLogMessage(logMessage: LogMessage): boolean {
  const requiredFields = ['level', 'time', 'pid', 'hostname', 'msg'];
  
  for (const field of requiredFields) {
    if (!(field in logMessage)) {
      return false;
    }
  }
  
  if (!logLevels[logMessage.level as LogLevel]) {
    return false;
  }
  
  return true;
}

// Example usage in middleware.ts
// Replace console.warn with logger
// Original: console.warn(JSON.stringify({
// New: warn('Traffic alert', { timestamp: new Date(now).toISOString(), action: 'traffic_alert', ip, path: pathname, note: `crossed ${EARLY_WARN_THRESHOLD} requests/minute for public gateway` }))

// Example usage in db.ts
// Replace console.warn with logger
// Original: console.warn(`[${timestamp}] ALERT_SYSTEM_FAILURE: Failed to trigger database connection alert - ${alertError instanceof Error ? alertError.message : "Unknown error"}`);
// New: warn('Failed to trigger database connection alert', { timestamp, error: alertError instanceof Error ? alertError.message : 'Unknown error' })

// Example usage in hive-rail.ts
// Replace console.error with logger
// Original: console.error(`[${timestamp}] ALERT_SYSTEM_FAILURE: Failed to trigger database connection alert - ${alertError instanceof Error ? alertError.message : "Unknown error"}`);
// New: error('Failed to trigger database connection alert', { timestamp, error: alertError instanceof Error ? alertError.message : 'Unknown error' })