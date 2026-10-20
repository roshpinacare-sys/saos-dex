import { v4 as uuidv4 } from 'uuid';

// Define a base correlation type that can be extended
interface BaseCorrelation {
  correlation_id: string;
  parent_correlation_id?: string;
  timestamp: string;
}

// Middleware Correlation
type MiddlewareCorrelation = BaseCorrelation & {
  ip: string;
  path: string;
  method: string;
  user_agent?: string;
};

// Database Alert Correlation
type DatabaseAlertCorrelation = BaseCorrelation & {
  error_type: string;
  description: string;
  severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
  component: string;
};

// Hive Rail Correlation
type HiveRailCorrelation = BaseCorrelation & {
  action: 'EXECUTE' | 'PREVIEW' | 'CONFIG_CHECK';
  account?: string;
  status: 'SUCCESS' | 'FAILED' | 'REFUSED';
  error?: string;
};

// Alert Bus Type
type AlertEvent =
  | {
      type: 'MIDDLEWARE';
      data: MiddlewareCorrelation;
    }
  | {
      type: 'DATABASE';
      data: DatabaseAlertCorrelation;
    }
  | {
      type: 'HIVE_RAIL';
      data: HiveRailCorrelation;
    };

// Centralized Alert Bus
class AlertBus {
  private static instance: AlertBus;
  private subscribers: Map<string, (event: AlertEvent) => void> = new Map();

  private constructor() {}

  static getInstance(): AlertBus {
    if (!AlertBus.instance) {
      AlertBus.instance = new AlertBus();
    }
    return AlertBus.instance;
  }

  subscribe(eventType: string, callback: (event: AlertEvent) => void): void {
    this.subscribers.set(eventType, callback);
  }

  publish(event: AlertEvent): void {
    const callback = this.subscribers.get(event.type);
    if (callback) {
      callback(event);
    }
  }
}

// Utility function to generate correlation ID with optional parent
export function generateCorrelationId(parentCorrelationId?: string): string {
  const newId = uuidv4();
  if (parentCorrelationId) {
    return `${parentCorrelationId}:${newId}`;
  }
  return newId;
}

// Middleware correlation handler
export function handleMiddlewareRequest(req: any): MiddlewareCorrelation {
  const correlationId = generateCorrelationId();
  
  return {
    correlation_id: correlationId,
    timestamp: new Date().toISOString(),
    ip: req.ip || req.headers['x-forwarded-for'] || 'unknown',
    path: req.path,
    method: req.method,
    user_agent: req.headers['user-agent']
  };
}

// Database alert correlation handler
export function handleDatabaseAlert(
  errorType: string,
  description: string,
  severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL',
  component: string,
  parentCorrelationId?: string
): DatabaseAlertCorrelation {
  const correlationId = generateCorrelationId(parentCorrelationId);
  
  return {
    correlation_id: correlationId,
    parent_correlation_id: parentCorrelationId,
    timestamp: new Date().toISOString(),
    error_type: errorType,
    description,
    severity,
    component
  };
}

// Hive rail correlation handler
export function handleHiveRailEvent(
  action: 'EXECUTE' | 'PREVIEW' | 'CONFIG_CHECK',
  account?: string,
  status: 'SUCCESS' | 'FAILED' | 'REFUSED' = 'SUCCESS',
  error?: string,
  parentCorrelationId?: string
): HiveRailCorrelation {
  const correlationId = generateCorrelationId(parentCorrelationId);
  
  return {
    correlation_id: correlationId,
    parent_correlation_id: parentCorrelationId,
    timestamp: new Date().toISOString(),
    action,
    account,
    status,
    error
  };
}

// Initialize the alert bus
const alertBus = AlertBus.getInstance();

// Subscribe to alert events for logging
alertBus.subscribe('MIDDLEWARE', (event) => {
  console.log(`[MIDDLEWARE] ${event.data.timestamp} - ${event.data.correlation_id}: ${event.data.method} ${event.data.path}`);
});

alertBus.subscribe('DATABASE', (event) => {
  console.log(`[DATABASE] ${event.data.timestamp} - ${event.data.correlation_id}: ${event.data.severity} - ${event.data.description}`);
});

alertBus.subscribe('HIVE_RAIL', (event) => {
  console.log(`[HIVE_RAIL] ${event.data.timestamp} - ${event.data.correlation_id}: ${event.data.action} - ${event.data.status}`);
});

// Example usage in middleware
export function enhancedMiddleware(req: any, res: any, next: any) {
  const correlationData = handleMiddlewareRequest(req);
  
  // Attach correlation ID to request for downstream use
  req.correlation_id = correlationData.correlation_id;
  
  // Publish to alert bus
  alertBus.publish({
    type: 'MIDDLEWARE',
    data: correlationData
  });
  
  next();
}

// Example usage in database connection
export function enhancedDatabaseConnection() {
  try {
    // Database connection logic here
    // If successful, no need to publish
    return true;
  } catch (error) {
    const correlationData = handleDatabaseAlert(
      'CONNECTION_ERROR',
      'Failed to connect to database',
      'CRITICAL',
      'DATABASE',
      req.correlation_id // Pass from middleware
    );
    
    alertBus.publish({
      type: 'DATABASE',
      data: correlationData
    });
    
    return false;
  }
}

// Example usage in Hive rail
export function enhancedHiveRailExecute(req: any) {
  const correlationData = handleHiveRailEvent(
    'EXECUTE',
    req.account,
    'SUCCESS',
    undefined,
    req.correlation_id // Pass from middleware
  );
  
  try {
    // Hive rail execution logic here
    // If successful, publish success
    alertBus.publish({
      type: 'HIVE_RAIL',
      data: correlationData
    });
    
    return { success: true };
  } catch (error) {
    const errorData = handleHiveRailEvent(
      'EXECUTE',
      req.account,
      'FAILED',
      error.message,
      req.correlation_id
    );
    
    alertBus.publish({
      type: 'HIVE_RAIL',
      data: errorData
    });
    
    return { success: false, error: error.message };
  }
}