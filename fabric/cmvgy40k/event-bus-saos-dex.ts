import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';

// Define the standard event schema
interface StandardEvent {
  timestamp: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  event_type: string;
  correlation_id: string;
  source_component: string;
  payload: Record<string, unknown>;
}

// Event Bus class with centralized event handling
class EventBus extends EventEmitter {
  private eventHistory: Map<string, StandardEvent> = new Map();
  private deadLetterQueue: StandardEvent[] = [];
  private maxHistorySize = 1000;

  /**
   * Publish a standard event to the event bus
   * @param event The event to publish
   * @param idempotencyKey Optional key to ensure idempotency
   */
  public publish(event: Omit<StandardEvent, 'timestamp' | 'correlation_id'>, idempotencyKey?: string): void {
    const correlationId = idempotencyKey || uuidv4();
    const timestamp = new Date().toISOString();
    
    const standardEvent: StandardEvent = {
      ...event,
      timestamp,
      correlation_id: correlationId,
    };

    // Check for duplicates using idempotency key or event fingerprint
    const eventKey = idempotencyKey || this.generateEventFingerprint(standardEvent);
    if (this.eventHistory.has(eventKey)) {
      console.warn(`Duplicate event detected: ${eventKey}`);
      return;
    }

    // Store in history
    this.eventHistory.set(eventKey, standardEvent);
    if (this.eventHistory.size > this.maxHistorySize) {
      const oldestKey = this.eventHistory.keys().next().value;
      this.eventHistory.delete(oldestKey);
    }

    // Emit the event
    this.emit('event', standardEvent);
  }

  /**
   * Subscribe to events with retry/backoff mechanism
   * @param eventType Type of event to subscribe to
   * @param callback Function to execute when event is emitted
   * @param options Subscription options
   */
  public subscribe(
    eventType: string,
    callback: (event: StandardEvent) => Promise<void> | void,
    options: {
      maxRetries?: number;
      initialDelay?: number;
      maxDelay?: number;
    } = {}
  ): () => void {
    const { maxRetries = 3, initialDelay = 1000, maxDelay = 30000 } = options;
    
    const wrappedCallback = async (event: StandardEvent) => {
      let attempt = 0;
      let delay = initialDelay;
      
      while (attempt <= maxRetries) {
        try {
          await callback(event);
          return;
        } catch (error) {
          attempt++;
          if (attempt > maxRetries) {
            console.error(`Event processing failed after ${maxRetries} attempts:`, error);
            this.deadLetterQueue.push(event);
            return;
          }
          
          // Exponential backoff with jitter
          jitter = Math.random() * delay * 0.2;
          await new Promise(resolve => setTimeout(resolve, delay + jitter));
          delay = Math.min(delay * 2, maxDelay);
        }
      }
    };

    this.on('event', (event) => {
      if (event.event_type === eventType) {
        wrappedCallback(event);
      }
    });

    // Return unsubscribe function
    return () => this.removeAllListeners('event');
  }

  /**
   * Get events from dead letter queue for processing
   */
  public getDeadLetterQueue(): StandardEvent[] {
    return [...this.deadLetterQueue];
  }

  /**
   * Clear the dead letter queue
   */
  public clearDeadLetterQueue(): void {
    this.deadLetterQueue = [];
  }

  /**
   * Generate a fingerprint for event deduplication
   */
  private generateEventFingerprint(event: Omit<StandardEvent, 'timestamp' | 'correlation_id'>): string {
    const { severity, event_type, source_component, payload } = event;
    const payloadString = JSON.stringify(payload, Object.keys(payload).sort());
    return `${severity}:${event_type}:${source_component}:${payloadString}`;
  }
}

// Create a singleton instance
const eventBus = new EventBus();

export { eventBus, StandardEvent };

// Example usage in existing components:
// src/lib/alert.ts
import { eventBus, StandardEvent } from './event-bus';

export async function alertDatabaseConnectionFailure(alertData: {
  timestamp: string;
  errorType: string;
  description: string;
  severity: 'WARNING' | 'ERROR' | 'CRITICAL';
}) {
  eventBus.publish({
    severity: alertData.severity.toLowerCase() as StandardEvent['severity'],
    event_type: 'database_connection_failure',
    source_component: 'database',
    payload: {
      errorType: alertData.errorType,
      description: alertData.description,
    },
  });
}

// src/middleware.ts
import { eventBus, StandardEvent } from '../lib/event-bus';

// In the rate limiting section
if (shouldLog) {
  eventBus.publish({
    severity: 'medium',
    event_type: 'rate_limit_exceeded',
    source_component: 'middleware',
    payload: {
      ip,
      path: pathname,
      timestamp: new Date().toISOString(),
    },
  });
}

// src/lib/db.ts
import { eventBus, StandardEvent } from './event-bus';

// In the database connection check
if (!isDexOwnDb) {
  eventBus.publish({
    severity: 'critical',
    event_type: 'unauthorized_database_connection_attempt',
    source_component: 'database',
    payload: {
      url_hint: createHash('sha256').update(RAW_URL).digest('hex').slice(0, 12),
      timestamp: new Date().toISOString(),
    },
  });
}

// Example of subscribing to events
// In your application initialization
eventBus.subscribe('database_connection_failure', async (event) => {
  console.log('Database connection failure:', event);
  // Handle the event (e.g., notify admins, log to external service)
}, {
  maxRetries: 5,
  initialDelay: 2000,
});
