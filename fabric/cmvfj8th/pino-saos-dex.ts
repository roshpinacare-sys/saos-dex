import { createWriteStream } from 'fs';
import { createLogger, transport, transportSync } from 'pino';
import { pinoPretty } from 'pino-pretty';
import { env } from 'process';

// ייצוא ה-logger המרכזי עם תצורה ברירת מחדל
export const logger = createLogger({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  timestamp: () => `"time":"${new Date().toISOString()}"`,
  base: {
    pid: process.pid,
    hostname: process.env.HOSTNAME || 'unknown-host',
  },
  formatters: {
    level: (label) => ({
      level: label,
    }),
    log: (object) => ({
      ...object,
      src: object.stack ? undefined : {
        file: object.file,
        line: object.line,
      },
    }),
  },
});

// הוספת תמיכה ל-Syslog בסביבת הייצור
if (env.NODE_ENV === 'production' && env.SYSLOG_URL) {
  const { default: pinoSyslog } = await import('pino-syslog');
  logger.add(
    pinoSyslog({
      host: env.SYSLOG_URL,
      port: parseInt(env.SYSLOG_PORT || '514', 10),
      type: 'RFC5424',
      app_name: 'saos-dex',
      eol: '\n',
      format: pinoStdSerializers,
    })
  );
}

// הוספת תמיכה לפורמט JSON עם pretty-print בסביבת פיתוח
if (env.NODE_ENV === 'development') {
  const pretty = pinoPretty({
    colorize: true,
    levelFirst: true,
    translateTime: 'HH:MM:ss',
    ignore: 'pid,hostname',
  });
  logger.add(transport({
    target: 'pino-pretty',
    options: pretty,
    stream: pretty,
  }));
}

// ייצוא פונקציות עזר לשימוש בכל הקוד
export const log = {
  debug: (msg: string, obj?: object) => logger.debug({ msg, ...obj }),
  info: (msg: string, obj?: object) => logger.info({ msg, ...obj }),
  warn: (msg: string, obj?: object) => logger.warn({ msg, ...obj }),
  error: (msg: string, err?: Error | string, obj?: object) => {
    if (err instanceof Error) {
      logger.error({ msg, stack: err.stack, ...obj });
    } else if (err) {
      logger.error({ msg, error: err, ...obj });
    } else {
      logger.error({ msg, ...obj });
    }
  },
};

// ייצוא סריאלייזרים סטנדרטיים
export const pinoStdSerializers = {
  err: (err: Error) => ({
    message: err.message,
    stack: err.stack,
  }),
  req: (req: any) => ({
    method: req.method,
    url: req.url,
    headers: req.headers,
    remoteAddress: req.remoteAddress,
    remotePort: req.remotePort,
  }),
  res: (res: any) => ({
    statusCode: res.statusCode,
  }),
};
