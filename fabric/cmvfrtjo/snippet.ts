import winston from 'winston';
import path from 'path';
import { mkdirSync, existsSync } from 'fs';

// Define log levels
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

// Define colors for log levels
const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  debug: 'blue',
};

winston.addColors(colors);

// Define log format
const format = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
  winston.format.colorize({ all: true }),
  winston.format.printf(
    (info) => `${info.timestamp} ${info.level}: ${info.message}`
  )
);

// Define transports
const transports = [
  // Console transport
  new winston.transports.Console({
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    format,
  }),
  // File transport for errors
  new winston.transports.File({
    filename: path.join(process.cwd(), 'logs', 'error.log'),
    level: 'error',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    ),
    maxsize: 5242880, // 5MB
    maxFiles: 5,
  }),
  // File transport for all logs
  new winston.transports.File({
    filename: path.join(process.cwd(), 'logs', 'combined.log'),
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    ),
    maxsize: 5242880, // 5MB
    maxFiles: 5,
  }),
];

// Create logs directory if it doesn't exist
const logDir = path.join(process.cwd(), 'logs');
if (!existsSync(logDir)) {
  mkdirSync(logDir);
}

// Create logger
const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  levels,
  format,
  transports,
});

// Add security logging transport
const securityTransport = new winston.transports.File({
  filename: path.join(process.cwd(), 'logs', 'security.log'),
  level: 'warn',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
    winston.format.printf(
      (info) => {
        if (info.securityEvent) {
          return JSON.stringify({
            timestamp: info.timestamp,
            level: info.level,
            securityEvent: info.securityEvent,
            details: info.details || {},
            source: info.source || 'unknown',
          });
        }
        return info.message;
      }
    )
  ),
  maxsize: 5242880, // 5MB
  maxFiles: 5,
});

// Add security transport only in production
if (process.env.NODE_ENV === 'production') {
  logger.add(securityTransport);
}

// Create a stream object for Morgan HTTP request logging
const stream = {
  write: (message: string) => logger.http(message.trim()),
};

export { logger, stream };
