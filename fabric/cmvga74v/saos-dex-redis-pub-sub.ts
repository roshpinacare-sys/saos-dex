// src/alerts/redisAlertPublisher.ts
import Redis from 'ioredis';

let redisPublisher: Redis | null = null;

function getRedisPublisher(): Redis {
  if (!redisPublisher) {
    const host = process.env.REDIS_HOST ?? 'localhost';
    const port = parseInt(process.env.REDIS_PORT ?? '6379', 10);
    const password = process.env.REDIS_PASSWORD ?? undefined;
    
    redisPublisher = new Redis({
      host,
      port,
      password,
      lazyConnect: true,
      retryStrategy: (times) => Math.min(times * 50, 2000),
      connectTimeout: 1000,
    });
    
    redisPublisher.on('error', (err) => {
      console.warn('[Redis Publisher] Connection error:', err.message);
    });
    
    redisPublisher.connect().catch(console.error);
  }
  return redisPublisher;
}

export async function publishAlert(channel: string, message: unknown): Promise<void> {
  try {
    const publisher = getRedisPublisher();
    await publisher.publish(channel, JSON.stringify(message));
  } catch (err) {
    console.warn('[Redis Publisher] Failed to publish alert:', err);
    // Fire-and-forget: לא נפיל את התהליך אם Redis לא זמין
  }
}

// src/alerts/centralAlertSubscriber.ts
import Redis from 'ioredis';

let redisSubscriber: Redis | null = null;

function getRedisSubscriber(): Redis {
  if (!redisSubscriber) {
    const host = process.env.REDIS_HOST ?? 'localhost';
    const port = parseInt(process.env.REDIS_PORT ?? '6379', 10);
    const password = process.env.REDIS_PASSWORD ?? undefined;
    
    redisSubscriber = new Redis({
      host,
      port,
      password,
      lazyConnect: true,
      retryStrategy: (times) => Math.min(times * 50, 2000),
      connectTimeout: 1000,
    });
    
    redisSubscriber.on('error', (err) => {
      console.warn('[Redis Subscriber] Connection error:', err.message);
    });
    
    redisSubscriber.connect().catch(console.error);
  }
  return redisSubscriber;
}

export function subscribeToAlerts(channel: string, callback: (message: unknown) => void): void {
  const subscriber = getRedisSubscriber();
  subscriber.subscribe(channel, (err, count) => {
    if (err) {
      console.error('[Redis Subscriber] Failed to subscribe:', err);
      return;
    }
    console.log(`[Redis Subscriber] Subscribed to channel: ${channel}`);
  });
  
  subscriber.on('message', (receivedChannel, message) => {
    if (receivedChannel === channel) {
      try {
        const parsed = JSON.parse(message);
        callback(parsed);
      } catch (err) {
        console.error('[Redis Subscriber] Failed to parse message:', err, message);
      }
    }
  });
}

// src/lib/dex/alert.ts (עדכון)
export async function alertDatabaseConnectionFailure(params: {
  timestamp: string;
  errorType: string;
  description: string;
  severity: string;
}): Promise<void> {
  // שמירה על התנהגות מקומית קיימת (לוג + ledger)
  console.error(`[ALERT] Database connection failure:`, params);
  
  // פרסום ל-Redis לגיבוי מרכזי
  try {
    const { publishAlert } = await import('../../alerts/redisAlertPublisher');
    await publishAlert('saos-dext-alerts', {
      ...params,
      source: 'alertDatabaseConnectionFailure',
      service: 'saos-dex',
    });
  } catch (err) {
    console.warn('[Alert] Failed to publish to Redis:', err);
    // לא נפיל את הפונקציה המקומית אם Redis לא זמין
  }
}

// דוגמה לשימוש ב-mock בבדיקה (לדוגמה ב-test/alert.test.ts)
// import { alertDatabaseConnectionFailure } from '@/lib/dex/alert';
// import { publishAlert } from '@/alerts/redisAlertPublisher';
// 
// jest.mock('@/alerts/redisAlertPublisher');
// 
// describe('alertDatabaseConnectionFailure', () => {
//   it('should publish to Redis even if local logging fails', async () => {
//     const mockParams = {
//       timestamp: new Date().toISOString(),
//       errorType: 'TEST_ERROR',
//       description: 'Test description',
//       severity: 'WARNING',
//     };
//     
//     await alertDatabaseConnectionFailure(mockParams);
//     
//     expect(publishAlert).toHaveBeenCalledWith(
//       'saos-dext-alerts',
//       expect.objectContaining({
//         ...mockParams,
//         source: 'alertDatabaseConnectionFailure',
//         service: 'saos-dex',
//       })
//     );
//   });
// });
