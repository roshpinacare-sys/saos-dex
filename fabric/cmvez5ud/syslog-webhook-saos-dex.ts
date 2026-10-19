import { createLogger, format, transports } from 'winston';
import syslog from 'winston-syslog'; import { Syslog } from 'modern-syslog';

const logger = createLogger({
  level: process.env.SECURITY_LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp({ format: 'ISO8601' }),
    format.errors({ stack: true }),
    format.splat(),
    format.json()
  ),
  transports: [
    new transports.Console(),
    ...(process.env.SECURITY_LOG_SYSLOG_HOST ? [
      new syslog({
        host: process.env.SECURITY_LOG_SYSLOG_HOST,
        port: parseInt(process.env.SECURITY_LOG_SYSLOG_PORT || '514', 10),
        protocol: process.env.SECURITY_LOG_SYSLOG_PROTOCOL || 'udp4',
        facility: process.env.SECURITY_LOG_SYSLOG_FACILITY || 'local0',
        app_name: 'saos-dex-security'
      })
    ] : []),
    ...(process.env.SECURITY_LOG_WEBHOOK_URL ? [
      new transports.Http({
        host: new URL(process.env.SECURITY_LOG_WEBHOOK_URL).host,
        path: new URL(process.env.SECURITY_LOG_WEBHOOK_URL).pathname,
        ssl: new URL(process.env.SECURITY_LOG_WEBHOOK_URL).protocol === 'https:',
        contentType: 'application/json',
        format: format.combine(format.timestamp(), format.json())
      })
    ] : [])
  ]
});

export function exportSecurityEvent(event: {
  eventType: string;
  sourceIP?: string;
  userId?: string;
  outcome?: 'success' | 'failure';
  details?: Record<string, unknown>;
}) {
  logger.info('security_event', {
    timestamp: new Date().toISOString(),
    ...event
  });
}