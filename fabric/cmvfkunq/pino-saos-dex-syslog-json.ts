import pino from 'pino';
import { multistream } from 'pino-multi-stream';
import { createWriteStream } from 'fs';
import { createServer } from 'net';

// טיפוסים מותאמים ל-DEX
interface DEXLog {
  level: 'debug' | 'info' | 'warn' | 'error';
  time: string;
  pid: number;
  hostname: string;
  src: {
    file: string;
    line: number;
    function?: string;
  };
  msg: string;
  [key: string]: any;
}

// סטרימר לייצוא JSON לקובץ
const jsonStream = createWriteStream('./logs/dex.log', { flags: 'a' });

// סטרימר ל-Syslog (מדמה חיבור לשרת Syslog)
const syslogStream = createServer((socket) => {
  socket.on('data', (data) => {
    // כאן ניתן להוסיף לוגיקה לשליחת הלוגים ל-Syslog
    console.log('Syslog data:', data.toString());
  });
}).listen(514);

// יצירת לוגר עם רישום מקור (file, line)
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({
      level: label,
    }),
    log: (object) => ({
      ...object,
      src: {
        file: object.file,
        line: object.line,
      },
    }),
  },
  timestamp: () => `"time":"${new Date().toISOString()}"`,
}, multistream([
  { stream: jsonStream },
  { stream: syslogStream },
  { stream: process.stdout },
]));

// עטיפת הלוגר עם פונקציות מותאמות ל-DEX
const dexLogger = {
  debug: (msg: string, obj?: any, src?: { file: string; line: number }) => {
    logger.debug({ ...obj, src }, msg);
  },
  info: (msg: string, obj?: any, src?: { file: string; line: number }) => {
    logger.info({ ...obj, src }, msg);
  },
  warn: (msg: string, obj?: any, src?: { file: string; line: number }) => {
    logger.warn({ ...obj, src }, msg);
  },
  error: (msg: string, obj?: any, src?: { file: string; line: number }) => {
    logger.error({ ...obj, src }, msg);
  },
  security: (action: string, details: { ip?: string; user?: string; result: 'success' | 'failure' }) => {
    logger.info({
      event: 'security',
      action,
      ip: details.ip,
      user: details.user,
      result: details.result,
      timestamp: new Date().toISOString(),
    }, `Security event: ${action}`);
  },
};

// פונקציית עזר לקביעת מקור הלוג (file, line)
function getSrc(): { file: string; line: number } {
  const stack = new Error().stack?.split('\n');
  if (!stack || stack.length < 4) return { file: 'unknown', line: 0 };
  
  // השורה הרלוונטית בסטאק (תלוי עומק הקריאות)
  const callerLine = stack[3];
  const match = callerLine.match(/\(([^)]+):(\d+):\d+\)/);
  
  if (match) {
    const [, file, line] = match;
    return { file, line: parseInt(line, 10) };
  }
  
  return { file: 'unknown', line: 0 };
}

// פונקציית עזר להחלפת console.log/error
function replaceConsole() {
  console.log = (...args: any[]) => {
    const src = getSrc();
    dexLogger.info(args.join(' '), undefined, src);
  };
  
  console.error = (...args: any[]) => {
    const src = getSrc();
    dexLogger.error(args.join(' '), undefined, src);
  };
}

// הגדרת רמת לוג מינימלית לפי סביבה
function setLogLevel() {
  switch (process.env.NODE_ENV) {
    case 'development':
      logger.level = 'debug';
      break;
    case 'staging':
      logger.level = 'info';
      break;
    case 'production':
      logger.level = 'warn';
      break;
    default:
      logger.level = 'info';
  }
}

// הטמעה במערכת
export function initLogging() {
  setLogLevel();
  replaceConsole();
  
  // דוגמאות לשימוש בלוגר ברכיבים קיימים
  // middleware.ts
  dexLogger.info('Rate limiting initialized', { 
    internalLimit: 2000, 
    publicLimit: 240,
    windowMs: 60000
  }, { file: 'src/middleware.ts', line: 1 });
  
  // db.ts
  dexLogger.debug('Database connection attempt', { 
    url: process.env.DATABASE_URL 
  }, { file: 'src/lib/db.ts', line: 1 });
  
  // hive-rail.ts
  dexLogger.warn('Rail configuration check', { 
    configured: false 
  }, { file: 'src/lib/hive-rail.ts', line: 1 });
  
  // דוגמה ללוג אבטחה
  dexLogger.security('rate_limit_exceeded', {
    ip: '192.168.1.100',
    user: 'anonymous',
    result: 'failure'
  });
  
  return dexLogger;
}

// ייצוא הלוגר לשימוש במערכת
export default dexLogger;