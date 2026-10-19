import { pino, Logger } from 'pino';
import { NextRequest, NextResponse } from 'next/server';

// ייצור מופע מרכזי של Pino עם קונפיגורציה ברירת מחדל
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({
      level: label,
    }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// ייצור פונקציית עזר ללוגים עם מידע על מקור הלוג
const createLoggerWithSource = (source: string): Logger => {
  return logger.child({ source });
};

// החלפת console.log ו-console.error קיימות
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

console.log = (...args: any[]) => {
  logger.info({ message: args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ') });
};

console.error = (...args: any[]) => {
  logger.error({ message: args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ') });
};

// Middleware לרישום בקשות/תגובות HTTP
export function loggingMiddleware(req: NextRequest, res: NextResponse) {
  const startTime = Date.now();
  
  // רישום פרטי הבקשה
  logger.info({
    type: 'request',
    method: req.method,
    url: req.url,
    headers: Object.fromEntries(req.headers.entries()),
    body: req.body,
  });
  
  // הוספת פונקציית רישום לתגובה
  const originalResJson = res.json;
  res.json = function(body) {
    const duration = Date.now() - startTime;
    
    logger.info({
      type: 'response',
      method: req.method,
      url: req.url,
      statusCode: res.status,
      duration,
      body,
    });
    
    return originalResJson.call(this, body);
  };
  
  return res;
}

// פונקציה לשינוי רמת הלוג בזמן ריצה
export function setLogLevel(level: string) {
  logger.level = level;
  logger.info({ action: 'log_level_changed', newLevel: level });
}

// ייצור סטרים לפלט לקובץ
import { transport } from 'pino-pretty';
const fileTransport = transport({
  destination: './logs/saos-dex.log',
  prettyPrint: true,
  level: 'info',
});

// הוספת הטרנספורט ללוגר
logger.stream(fileTransport);

// ייצור לוגרים ספציפיים למודולים
export const dexLogger = createLoggerWithSource('dex');
export const apiLogger = createLoggerWithSource('api');
export const dbLogger = createLoggerWithSource('database');
export const authLogger = createLoggerWithSource('auth');
export const tradingLogger = createLoggerWithSource('trading');

// ייצור לוגר כללי לשימוש בכל מקום באפליקציה
export default logger;
