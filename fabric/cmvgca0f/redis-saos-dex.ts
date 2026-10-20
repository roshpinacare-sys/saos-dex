import { createClient, RedisClientType } from 'redis';

interface AlertEvent {
  timestamp: string;
  errorType: string;
  description: string;
  severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
}

class CentralAlertService {
  private client: RedisClientType | null = null;
  private isConnected = false;
  private retryTimeout: NodeJS.Timeout | null = null;
  private readonly MAX_RETRIES = 5;
  private retryCount = 0;
  private readonly QUEUE: AlertEvent[] = [];
  private readonly QUEUE_MAX_SIZE = 1000;

  constructor(private readonly redisUrl: string = process.env.REDIS_URL || 'redis://localhost:6379') {}

  async connect(): Promise<void> {
    if (this.isConnected) return;

    try {
      this.client = createClient({ url: this.redisUrl });
      this.client.on('error', (err) => this.handleConnectionError(err));
      await this.client.connect();
      this.isConnected = true;
      this.retryCount = 0;
      await this.flushQueue();
    } catch (err) {
      this.handleConnectionError(err as Error);
    }
  }

  private handleConnectionError(err: Error): void {
    console.warn(`[CentralAlertService] Redis connection failed: ${err.message}`);
    this.isConnected = false;
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retryTimeout) clearTimeout(this.retryTimeout);
    if (this.retryCount >= this.MAX_RETRIES) {
      console.error('[CentralAlertService] Max retries exceeded. Giving up.');
      return;
    }
    const delay = Math.min(1000 * 2 ** this.retryCount, 30000);
    this.retryTimeout = setTimeout(() => {
      this.retryCount++;
      this.connect();
    }, delay);
  }

  async publishAlert(event: AlertEvent): Promise<void> {
    if (!this.isConnected || !this.client) {
      this.queueEvent(event);
      this.scheduleRetry();
      return;
    }

    try {
      await this.client.publish('saos_dex_alerts', JSON.stringify(event));
    } catch (err) {
      console.warn(`[CentralAlertService] Failed to publish alert: ${err instanceof Error ? err.message : 'Unknown error'}`);
      this.isConnected = false;
      this.queueEvent(event);
      this.scheduleRetry();
    }
  }

  private queueEvent(event: AlertEvent): void {
    if (this.QUEUE.length >= this.QUEUE_MAX_SIZE) {
      this.QUEUE.shift();
    }
    this.QUEUE.push(event);
  }

  private async flushQueue(): Promise<void> {
    if (!this.isConnected || !this.client || this.QUEUE.length === 0) return;

    const events = [...this.QUEUE];
    this.QUEUE.length = 0;

    for (const event of events) {
      try {
        await this.client.publish('saos_dex_alerts', JSON.stringify(event));
      } catch (err) {
        console.warn(`[CentralAlertService] Failed to flush queued event: ${err instanceof Error ? err.message : 'Unknown error'}`);
        this.queueEvent(event);
        break;
      }
    }
  }

  async subscribe(onMessage: (event: AlertEvent) => Promise<void> | void): Promise<void> {
    if (!this.isConnected || !this.client) {
      await this.connect();
    }

    if (!this.isConnected || !this.client) {
      throw new Error('Cannot subscribe: Redis not connected');
    }

    const subscriber = this.client.duplicate();
    await subscriber.connect();
    await subscriber.subscribe('saos_dex_alerts', (message) => {
      try {
        const event = JSON.parse(message) as AlertEvent;
        onMessage(event);
      } catch (err) {
        console.error(`[CentralAlertService] Failed to parse alert message: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    });

    return () => subscriber.unsubscribe && subscriber.unsubscribe('saos_dex_alerts');
  }

  async disconnect(): Promise<void> {
    if (this.retryTimeout) clearTimeout(this.retryTimeout);
    if (this.client) {
      await this.client.quit();
      this.client = null;
    }
    this.isConnected = false;
  }
}

// Singleton instance for use across the application
const centralAlertService = new CentralAlertService();

export { centralAlertService, CentralAlertService };
