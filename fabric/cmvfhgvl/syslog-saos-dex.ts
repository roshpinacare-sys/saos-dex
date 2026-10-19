import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import pinoPretty from 'pino-pretty';
import { NextRequest, NextResponse } from 'next/server';

// ── קונפיגורציה של מערכת הלוגים ────────────────────────────────────────────────
const LOG_DIR = process.env.LOG_DIR || './logs';
const SYSLOG_ENABLED = process.env.SYSLOG_ENABLED === 'true';
const SYSLOG_HOST = process.env.SYSLOG_HOST || 'localhost';
const SYSLOG_PORT = parseInt(process.env.SYSLOG_PORT || '514', 10);

// ── הגדרת Pino עם פורמט JSON ותמיכה ב-Syslog ────────────────────────────────────────
const transport = pino.transport({
  target: 'pino-pretty',
  options: {
    colorize: false,
    translateTime: 'yyyy-mm-dd HH:MM:ss.l',
    ignore: 'pid,hostname',
  },
});

const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    formatters: {
      level: (label) => ({
        level: label,
      }),
      bindings: (bindings) => ({
        pid: bindings.pid,
        hostname: bindings.hostname,
        service: 'saos-dex',
      }),
    },
    timestamp: () => `"time":"${new Date().toISOString()}"`,
  },
  transport
);

// ── ייצוא הלוגר לשימוש בכל האפליקציה ────────────────────────────────────────────────
export default logger;

// ── פונקציות עזר ללוגים ברמות שונו׀ות ────────────────────────────────────────────────
export const logError = (err: Error, context?: Record<string, unknown>) => {
  logger.error({ err: err.message, stack: err.stack, context }, 'Error occurred');
};

export const logWarn = (message: string, context?: Record<string, unknown>) => {
  logger.warn({ context }, message);
};

export const logInfo = (message: string, context?: Record<string, unknown>) => {
  logger.info({ context }, message);
};

export const logDebug = (message: string, context?: Record<string, unknown>) => {
  logger.debug({ context }, message);
};

export const logSecurity = (event: string, details: Record<string, unknown>) => {
  logger.info({ 
    level: 'security', 
    event, 
    timestamp: new Date().toISOString(),
    ...details 
  }, 'Security event');
};

// ── מידלוור לרישום בקשות ותגובות ────────────────────────────────────────────────────────
export async function loggingMiddleware(request: NextRequest): Promise<NextResponse | null> {
  const start = Date.now();
  const { method, url, headers } = request;
  const ip = headers.get('x-forwarded-for') || headers.get('x-real-ip') || 'unknown';
  
  // זיהוי ניסיונות תקיפה ברוט-פורס וסקנינג
  const suspiciousPatterns = [
    /\.(php|asp|jsp|exe|sh|bat|cmd)$/i,
    /union\s+select|select\s+from|insert\s+into|delete\s+from|drop\s+table/i,
    /<\s*script|javascript:|onload=|onerror=/i,
    /wp-admin|wp-login\.php|\.php\?/i,
  ];
  
  const userAgent = headers.get('user-agent') || '';
  const isSuspicious = suspiciousPatterns.some(pattern => pattern.test(url) || pattern.test(userAgent));
  
  if (isSuspicious) {
    logSecurity('suspicious_request', {
      ip,
      method,
      url,
      userAgent,
    });
  }
  
  // רישום בקשה ל-API רגיש
  const sensitiveApis = ['/api/dex/security', '/api/dex/wallets', '/api/dex/operator'];
  const isSensitiveApi = sensitiveApis.some(api => url.includes(api));
  
  if (isSensitiveApi) {
    logSecurity('sensitive_api_access', {
      ip,
      method,
      url,
    });
  }
  
  try {
    const response = await NextResponse.next();
    
    // רישום תגובות של 401/403
    if (response.status === 401 || response.status === 403) {
      logSecurity('failed_authentication', {
        ip,
        method,
        url,
        status: response.status,
      });
    }
    
    const duration = Date.now() - start;
    
    // רישום כל בקשות ה-API
    logger.info({
      type: 'request',
      method,
      url,
      ip,
      status: response.status,
      duration,
      userAgent,
    }, 'API Request');
    
    return response;
  } catch (error) {
    logError(error as Error, { url, method, ip });
    return null;
  }
}

// ── אינטגרציה עם נקודות הכניסה הקיימות ────────────────────────────────────────────────
// דוגמה לאינטגרציה ב-API route
export async function apiHandler(request: Request) {
  const logger = require('./logger').default;
  
  // רישום כניסה ל-API
  logger.info({
    path: new URL(request.url).pathname,
    method: request.method,
  }, 'API Access');
  
  try {
    // ... עיבוד הבקשה ...
    
    // דוגמא ללוג של שינוי הרשאות
    if (new URL(request.url).pathname === '/api/dex/permissions') {
      logSecurity('permission_change', {
        user: 'example-user',
        action: 'updated_permissions',
      });
    }
    
    return new Response('Success');
  } catch (error) {
    logError(error as Error);
    return new Response('Error', { status: 500 });
  }
}

// ── דוגמאות לשימוש בלוגים ────────────────────────────────────────────────────────
// דוגמא 1: לוג שגיאה
try {
  // ... קוד שעלול לגרום לשגיאה ...
} catch (error) {
  logError(error as Error, { module: 'payment_processing', transactionId: 'tx123' });
}

// דוגמא 2: לוג מידע על פעולת משתמש
logInfo('User performed action', { 
  userId: 'user123', 
  action: 'trade_execution',
  pair: 'HIVE/USDT',
  amount: 100
});

// דוגמא 3: לוג אבטחה - גישה מ-IP לא מוכר
logSecurity('unknown_ip_access', {
  ip: '192.168.1.100',
  endpoint: '/api/dex/wallets',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
});

// דוגמא 4: לוג ניפוי באגים
logDebug('Cache miss for key', { 
  key: 'user:123:balance', 
  duration: '120ms',
  fallback: 'database_query'
});

// ── תיעוד פעולות שנרשמות ────────────────────────────────────────────────────────
const LOGGED_OPERATIONS = {
  authentication: [
    'login_success',
    'login_failure',
    'logout',
    'token_refresh',
    'permission_denied'
  ],
  trades: [
    'order_placement',
    'order_cancellation',
    'trade_execution',
    'partial_fill',
    'order_expiry'
  ],
  security: [
    'suspicious_request',
    'brute_force_attempt',
    'permission_change',
    'sensitive_api_access',
    'unknown_ip_access',
    'failed_authentication'
  ],
  system: [
    'api_request',
    'database_connection',
    'cache_operation',
    'backup_operation',
    'system_health_check'
  ]
};

// ── הגדרת מנגנון אחסון ארוך טווח ────────────────────────────────────────────────────────
// פונקציה להגדרת אחסון לוגים בקבצים לפי תאריך
export function setupLongTermLogging() {
  const fs = require('node:fs');
  const path = require('node:path');
  
  // יצירת תיקיית לוגים אם לא קיימת
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
  
  // הגדרת סטרים ללוגים לפי רמת חשיבות
  const infoStream = createWriteStream(join(LOG_DIR, 'info.log'), { flags: 'a' });
  const errorStream = createWriteStream(join(LOG_DIR, 'error.log'), { flags: 'a' });
  const securityStream = createWriteStream(join(LOG_DIR, 'security.log'), { flags: 'a' });
  
  // הגדרת טרנספורטים מותאמים
  const infoTransport = pino.transport({
    target: 'pino/file',
    options: { destination: infoStream }
  });
  
  const errorTransport = pino.transport({
    target: 'pino/file',
    options: { destination: errorStream }
  });
  
  const securityTransport = pino.transport({
    target: 'pino/file',
    options: { destination: securityStream }
  });
  
  // יצירת לוגרים נפרדים עבור כל רמת חשיבות
  const infoLogger = pino({}, infoTransport);
  const errorLogger = pino({}, errorTransport);
  const securityLogger = pino({}, securityTransport);
  
  // ייצוא הלוגרים
  module.exports = {
    infoLogger,
    errorLogger,
    securityLogger
  };
}

// ── אתחול מערכת הלוגים באפליקציה ────────────────────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  setupLongTermLogging();
}

// ── ייצוא המידלוור לשימוש ב-next.config.js ────────────────────────────────────────────
export { loggingMiddleware };
