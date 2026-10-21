import { createLogger, format, transports } from 'winston';
import { ElasticsearchTransport } from '@elastic/transport';
import { Client } from '@elastic/elasticsearch';
import { hostname } from 'os';
import dotenv from 'dotenv';

dotenv.config();

const instanceId = process.env.INSTANCE_ID || hostname() || 'unknown';

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss'
    }),
    format.errors({ stack: true }),
    format.metadata(),
    format.json()
  ),
  defaultMeta: { service: 'saos-dex', instanceId },
  transports: [
    new ElasticsearchTransport({
      client: new Client({
        node: process.env.ELASTICSEARCH_HOST || 'http://localhost:9200',
        auth: {
          username: process.env.ELASTICSEARCH_USER || '',
          password: process.env.ELASTICSEARCH_PASSWORD || ''
        }
      }),
      index: `${process.env.ELASTICSEARCH_INDEX_PREFIX || 'dex-logs'}-${new Date().toISOString().split('T')[0]}`,
      flushInterval: 2000
    })
  ]
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new transports.Console({
    format: format.simple()
  }));
}

export const log = (level: string, message: string, metadata?: Record<string, any>) => {
  logger.log(level, message, { ...metadata });
};

export default logger;