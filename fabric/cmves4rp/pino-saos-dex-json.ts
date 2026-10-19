import pino from 'pino';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';

// ייצוא אובייקט הלוגר המרכזי
export const logger = pino({
  level: process.env.NODE_ENV === 'development' ? 'info' : 'warn',
  transport: {
    target: 'pino-pretty',
    options: {
      translateTime: 'HH:MM:ss Z',
      ignore: 'pid,hostname',
    },
  },
}, pino.multistream([
  { level: 'debug', stream: process.stdout },
  { level: 'error', stream: createWriteStream(join(process.cwd(), 'logs', 'errors.log')) },
]));

// פונקציית עזר ליצירת לוגר עם מידע על מקור הלוג
export function createLogger(source: string) {
  return {
    debug: (message: string, ...args: any[]) => logger.debug({ source }, message, ...args),
    info: (message: string, ...args: any[]) => logger.info({ source }, message, ...args),
    warn: (message: string, ...args: any[]) => logger.warn({ source }, message, ...args),
    error: (message: string, ...args: any[]) => logger.error({ source }, message, ...args),
    fatal: (message: string, ...args: any[]) => logger.fatal({ source }, message, ...args),
  };
}

// ייצוא פונקציית הלוגר כדי שניתן יהיה לייבא אותה בקלות
export const log = createLogger('global');

// פונקציית עזר להחלפת console.log/error בלוגר
export function replaceConsole() {
  console.log = (...args: any[]) => {
    const stack = new Error().stack?.split('\n')[2] || '';
    const match = stack.match(/\(([^)]+)\)/);
    const source = match ? match[1] : 'unknown';
    logger.info({ source }, args.join(' '));
  };

  console.error = (...args: any[]) => {
    const stack = new Error().stack?.split('\n')[2] || '';
    const match = stack.match(/\(([^)]+)\)/);
    const source = match ? match[1] : 'unknown';
    logger.error({ source }, args.join(' '));
  };
}

// קריאה לפונקציה באתחול האפליקציה
replaceConsole();
