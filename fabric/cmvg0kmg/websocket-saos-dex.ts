import { Server } from 'ws';
import jwt from 'jsonwebtoken';
import { createLogger, format, transports } from 'winston';

const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp(),
    format.json()
  ),
  transports: [new transports.Console()]
});

const JWT_SECRET = process.env.WS_JWT_SECRET || 'fallback-secret-for-dev';

interface AlertMessage {
  timestamp: string;
  event_type: string;
  severity: 'info' | 'warning' | 'error';
  source: {
    ip?: string;
    user_agent?: string;
  };
  description: string;
}

class WebSocketAlertServer {
  private wss: Server;

  constructor(server: any) {
    this.wss = new Server({ server });
    this.setupConnectionHandling();
    this.setupLoggerIntegration();
  }

  private setupConnectionHandling() {
    this.wss.on('connection', (ws, req) => {
      const token = req.headers['sec-websocket-protocol'];
      if (!token) {
        ws.close(4001, 'Missing token');
        return;
      }

      try {
        jwt.verify(token, JWT_SECRET);
        logger.info('WebSocket client authenticated', { ip: req.socket.remoteAddress });

        ws.on('message', (message) => {
          try {
            const data = JSON.parse(message.toString());
            if (data.type === 'ping') {
              ws.send(JSON.stringify({ type: 'pong' }));
            }
          } catch (e) {
            logger.warn('Invalid WebSocket message', { error: e.message });
          }
        });

        ws.on('close', () => {
          logger.info('WebSocket client disconnected');
        });

        ws.on('error', (error) => {
          logger.error('WebSocket error', { error: error.message });
        });
      } catch (err) {
        ws.close(4002, 'Invalid token');
      }
    });

    this.wss.on('error', (error) => {
      logger.error('WebSocket server error', { error: error.message });
    });
  }

  private setupLoggerIntegration() {
    const originalLog = logger.log.bind(logger);
    logger.log = (level, message, meta) => {
      if (level === 'warn' || level === 'error') {
        const alert: AlertMessage = {
          timestamp: new Date().toISOString(),
          event_type: meta?.event_type || 'system_alert',
          severity: level as 'warning' | 'error',
          source: {
            ip: meta?.ip,
            user_agent: meta?.user_agent
          },
          description: typeof message === 'string' ? message : JSON.stringify(message)
        };

        this.wss.clients.forEach((client) => {
          if (client.readyState === 1) {
            client.send(JSON.stringify({ type: 'alert', data: alert }));
          }
        });
      }
      return originalLog(level, message, meta);
    };
  }

  public sendAlert(alert: Omit<AlertMessage, 'timestamp'>) {
    const fullAlert: AlertMessage = {
      ...alert,
      timestamp: new Date().toISOString()
    };

    this.wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        client.send(JSON.stringify({ type: 'alert', data: fullAlert }));
      }
    });
  }
}

// Middleware to extract client info for logging
function clientInfoMiddleware(req: any, res: any, next: any) {
  req.clientInfo = {
    ip: req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress,
    user_agent: req.headers['user-agent']
  };
  next();
}

// Example usage in route handlers
function exampleRateLimitHandler(req: any, res: any) {
  // Simulate rate limit exceeded
  if (Math.random() > 0.9) {
    logger.warn('Rate limit exceeded', {
      event_type: 'rate_limit_exceeded',
      ...req.clientInfo,
      description: 'Client exceeded 240 requests/minute threshold'
    });
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }
  return res.status(200).json({ message: 'OK' });
}

// Export for use in Next.js or Express server
module.exports = { WebSocketAlertServer, clientInfoMiddleware, exampleRateLimitHandler };