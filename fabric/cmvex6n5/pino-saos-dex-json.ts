import pino from 'pino';
import { multistream } from 'pino-multi-stream';
import { once } from 'events';
import { createWriteStream } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, basename } from 'path';

// Get the directory name for the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Create a write stream for the log file
const logFileStream = createWriteStream('./logs/saos-dex.log', { flags: 'a' });

// Create a logger with JSON format and streams to both file and stdout
const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({
        level: label,
      }),
      log: (object) => ({
        ...object,
        source: {
          file: object?.meta?.filePath || 'unknown',
          line: object?.meta?.lineNumber || 'unknown',
          function: object?.meta?.functionName || 'unknown',
        },
      }),
    },
    hooks: {
      log: (args, level, timestamp) => {
        const [first, ...rest] = args;
        const meta = {
          filePath: first?.meta?.filePath || 'unknown',
          lineNumber: first?.meta?.lineNumber || 'unknown',
          functionName: first?.meta?.functionName || 'unknown',
        };
        
        return [
          {
            ...first,
            meta,
          },
          ...rest,
        ];
      },
    },
  },
  multistream([
    { stream: logFileStream },
    { stream: process.stdout },
  ])
);

// Function to get the caller's file path and line number
function getCallerInfo(): { filePath: string; lineNumber: number; functionName: string } {
  const stack = new Error().stack;
  if (!stack) return { filePath: 'unknown', lineNumber: 0, functionName: 'unknown' };
  
  // Skip the first two lines (Error and this function)
  const lines = stack.split('\n').slice(2);
  if (lines.length === 0) return { filePath: 'unknown', lineNumber: 0, functionName: 'unknown' };
  
  const match = lines[0].match(/at (?:([^\/\s]+)\s*\(|)([^\/\s]+):([^:]+):([^:]+)/);
  if (!match) return { filePath: 'unknown', lineNumber: 0, functionName: 'unknown' };
  
  const [, functionName, filePath, lineNumber] = match;
  return {
    filePath: basename(filePath),
    lineNumber: parseInt(lineNumber, 10),
    functionName: functionName || 'anonymous',
  };
}

// Create a wrapped logger with source tracking
export const log = {
  debug: (message: string, ...args: any[]) => {
    const source = getCallerInfo();
    logger.debug({ meta: source }, message, ...args);
  },
  info: (message: string, ...args: any[]) => {
    const source = getCallerInfo();
    logger.info({ meta: source }, message, ...args);
  },
  warn: (message: string, ...args: any[]) => {
    const source = getCallerInfo();
    logger.warn({ meta: source }, message, ...args);
  },
  error: (message: string, ...args: any[]) => {
    const source = getCallerInfo();
    logger.error({ meta: source }, message, ...args);
  },
  resourceError: (message: string, ...args: any[]) => {
    const source = getCallerInfo();
    logger.error({ meta: source, category: 'resource' }, message, ...args);
  },
  securityEvent: (message: string, ...args: any[]) => {
    const source = getCallerInfo();
    logger.error({ meta: source, category: 'security' }, message, ...args);
  },
};

// Helper to replace console methods
export const replaceConsole = () => {
  console.log = (...args: any[]) => log.info(args.join(' '));
  console.error = (...args: any[]) => log.error(args.join(' '));
  console.warn = (...args: any[]) => log.warn(args.join(' '));
  console.debug = (...args: any[]) => log.debug(args.join(' '));
};

// Ensure log directory exists
import { mkdir } from 'fs/promises';
import { join } from 'path';

const logDir = join(__dirname, '..', '..', 'logs');
mkdir(logDir, { recursive: true }).catch((err) => {
  if (err.code !== 'EEXIST') {
    console.error('Failed to create log directory:', err);
  }
});

// Graceful shutdown
process.on('SIGINT', async () => {
  log.info('Shutting down logger gracefully');
  await once(logFileStream, 'finish');
  process.exit(0);
});

export default log;