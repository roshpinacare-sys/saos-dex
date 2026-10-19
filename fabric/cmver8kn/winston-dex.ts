import winston from 'winston';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { NextRequest, NextResponse } from 'next/server';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure logs directory exists
const logDir = path.join(__dirname, '../../../logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// Define log format
const logFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'YYYY-MM-DD HH:mm:ss'
  }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    const logEntry = {
      timestamp,
      level,
      message,
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
      ...(stack ? { stack } : {})
    };
    return JSON.stringify(logEntry);
  })
);

// Create logger instance
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  transports: [
    // Console transport
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    // File transport for all logs
    new winston.transports.File({
      filename: path.join(logDir, 'combined.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
      tailable: true
    }),
    // Separate file for errors
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
      tailable: true
    })
  ]
});

// Override console methods to use winston
console.log = (...args: any[]) => {
  logger.info(args.join(' '));
};

console.error = (...args: any[]) => {
  logger.error(args.join(' '));
};

console.warn = (...args: any[]) => {
  logger.warn(args.join(' '));
};

console.debug = (...args: any[]) => {
  logger.debug(args.join(' '));
};

// Middleware for API request logging
export function apiLoggingMiddleware(req: NextRequest): NextResponse | void {
  const start = Date.now();
  
  // Log incoming request
  logger.info('API Request', {
    method: req.method,
    url: req.url,
    userAgent: req.headers.get('user-agent'),
    ip: req.ip || req.headers.get('x-forwarded-for') || 'unknown',
    timestamp: new Date().toISOString()
  });
  
  // Create a response observer
  const originalRes = NextResponse.next();
  
  // We can't directly modify the response here, so we'll log in a finally block
  // This is a limitation of the current middleware approach
  
  return originalRes;
}

// Helper function to log database connection errors
export function logDatabaseError(error: Error, context?: any): void {
  logger.error('Database Connection Error', {
    error: error.message,
    stack: error.stack,
    context,
    timestamp: new Date().toISOString()
  });
}

// Helper function to log RPC errors from hive-rail
export function logRpcError(error: Error, method: string, params?: any): void {
  logger.error('RPC Error', {
    method,
    params,
    error: error.message,
    stack: error.stack,
    timestamp: new Date().toISOString()
  });
}

// Initialize logging system
export function initializeLogging(): void {
  logger.info('Logging system initialized', {
    level: logger.level,
    logDir,
    timestamp: new Date().toISOString()
  });
}

// Call initialization on module load
initializeLogging();
