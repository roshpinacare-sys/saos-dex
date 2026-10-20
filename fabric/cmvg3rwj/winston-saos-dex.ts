import winston from 'winston';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const createLogger = (options: { label?: string; level?: string } = {}) => {
  const { label = 'saos-dex', level = process.env.NODE_ENV === 'production' ? 'info' : 'debug' } = options;

  const transports = [];

  if (process.env.NODE_ENV === 'production') {
    transports.push(
      new winston.transports.File({
        filename: path.join(__dirname, '../../logs/error.log'),
        level: 'error',
      }),
      new winston.transports.File({
        filename: path.join(__dirname, '../../logs/combined.log'),
      })
    );
  } else {
    transports.push(new winston.transports.Console());
  }

  return winston.createLogger({
    level,
    format: winston.format.combine(
      winston.format.label({ label }),
      winston.format.timestamp(),
      winston.format.json()
    ),
    transports,
    exitOnError: false,
  });
};

export { createLogger };