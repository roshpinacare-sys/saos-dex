import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { Prometheus } from '@prometheus/client';

// Prometheus metrics
const prometheus = new Prometheus();
const anomalyCounter = prometheus.counter({
  name: 'dex_api_anomalies_total',
  help: 'Total number of detected API anomalies',
  labelNames: ['endpoint', 'anomaly_type']
});

const requestCounter = prometheus.counter({
  name: 'dex_api_requests_total',
  help: 'Total number of API requests',
  labelNames: ['endpoint']
});

const latencyHistogram = prometheus.histogram({
  name: 'dex_api_request_duration_seconds',
  help: 'API request latency in seconds',
  labelNames: ['endpoint']
});

// Behavioral detection thresholds
const THRESHOLDS = {
  rapid_requests: 10, // requests per second
  order_size_deviation: 5, // standard deviations
  price_impact_threshold: 0.05, // 5% price impact
  sandwich_window_ms: 5000, // 5 seconds
  reentrancy_attempts: 3,
  front_running_window_ms: 10000 // 10 seconds
};

// In-memory state for behavioral tracking
const behavioralState = new Map<string, {
  requestCount: number;
  lastRequestTime: number;
  orderSizes: number[];
  recentOrders: Array<{ id: string; price: number; timestamp: number }>;
  recentSwaps: Array<{ id: string; timestamp: number }>;
  reentrancyCount: number;
}>();

// Helper function to calculate standard deviation
function calculateStdDev(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const squareDiffs = values.map(value => Math.pow(value - mean, 2));
  const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(avgSquareDiff);
}

// Helper function to detect sandwich attacks
function detectSandwichAttack(orders: Array<{ id: string; price: number; timestamp: number }>, 
                            currentPrice: number): boolean {
  if (orders.length < 2) return false;
  
  // Sort by timestamp
  const sortedOrders = [...orders].sort((a, b) => a.timestamp - b.timestamp);
  
  // Check for orders surrounding current price
  const surroundingOrders = sortedOrders.filter(
    order => Math.abs(order.price - currentPrice) / currentPrice < THRESHOLDS.price_impact_threshold
  );
  
  if (surroundingOrders.length < 2) return false;
  
  // Check if they're within the time window
  const timeDiff = surroundingOrders[surroundingOrders.length - 1].timestamp - 
                   surroundingOrders[0].timestamp;
  
  return timeDiff < THRESHOLDS.sandwich_window_ms;
}

// Helper function to detect front-running
function detectFrontRunning(orders: Array<{ id: string; price: number; timestamp: number }>, 
                          currentPrice: number, 
                          userIp: string): boolean {
  if (orders.length < 2) return false;
  
  // Sort by timestamp
  const sortedOrders = [...orders].sort((a, b) => a.timestamp - b.timestamp);
  
  // Get most recent order
  const recentOrder = sortedOrders[sortedOrders.length - 1];
  
  // Check if it's significantly different from current price
  const priceDiff = Math.abs(recentOrder.price - currentPrice) / currentPrice;
  if (priceDiff < THRESHOLDS.price_impact_threshold) return false;
  
  // Check if it's within the time window
  const timeDiff = Date.now() - recentOrder.timestamp;
  if (timeDiff > THRESHOLDS.front_running_window_ms) return false;
  
  return true;
}

// Main middleware function
export async function middleware(req: NextRequest): Promise<NextResponse> {
  const start = Date.now();
  const { pathname } = req.nextUrl;
  
  // Only protect specific endpoints
  const protectedEndpoints = ['/api/dex/agent', '/api/dex/order', '/api/dex/swap'];
  const isProtected = protectedEndpoints.some(endpoint => pathname.startsWith(endpoint));
  
  if (!isProtected) {
    return NextResponse.next();
  }
  
  const ip = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
  const userAgent = req.headers.get('user-agent') || 'unknown';
  
  // Initialize behavioral state for this IP if not exists
  if (!behavioralState.has(ip)) {
    behavioralState.set(ip, {
      requestCount: 0,
      lastRequestTime: Date.now(),
      orderSizes: [],
      recentOrders: [],
      recentSwaps: [],
      reentrancyCount: 0
    });
  }
  
  const state = behavioralState.get(ip)!;
  const now = Date.now();
  
  // Update request metrics
  requestCounter.inc({ endpoint: pathname });
  
  // Rapid request detection
  if (now - state.lastRequestTime < 1000) {
    state.requestCount++;
    if (state.requestCount > THRESHOLDS.rapid_requests) {
      anomalyCounter.inc({ endpoint: pathname, anomaly_type: 'rapid_requests' });
      
      // Log the anomaly
      console.error(`[ANOMALY] Rapid requests detected from IP: ${ip}, Count: ${state.requestCount}`);
      
      // Return 429 Too Many Requests
      return new NextResponse(JSON.stringify({ 
        error: 'Too many requests detected', 
        anomaly_type: 'rapid_requests' 
      }), { 
        status: 429,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  } else {
    state.requestCount = 1;
  }
  
  state.lastRequestTime = now;
  
  // Process the request
  const res = NextResponse.next();
  
  // Record latency
  const latency = (Date.now() - start) / 1000;
  latencyHistogram.observe({ endpoint: pathname }, latency);
  
  // After processing, check for anomalies
  try {
    // For order endpoint
    if (pathname.startsWith('/api/dex/order')) {
      const body = await req.json();
      
      // Record order size for statistical analysis
      if (body && typeof body.size === 'number') {
        state.orderSizes.push(body.size);
        
        // Keep only recent sizes (last 100)
        if (state.orderSizes.length > 100) {
          state.orderSizes.shift();
        }
        
        // Check for abnormal order sizes
        if (state.orderSizes.length > 10) {
          const stdDev = calculateStdDev(state.orderSizes);
          const mean = state.orderSizes.reduce((a, b) => a + b, 0) / state.orderSizes.length;
          
          if (Math.abs(body.size - mean) > THRESHOLDS.order_size_deviation * stdDev) {
            anomalyCounter.inc({ endpoint: pathname, anomaly_type: 'abnormal_order_size' });
            console.error(`[ANOMALY] Abnormal order size detected: ${body.size}, mean: ${mean}, stdDev: ${stdDev}`);
          }
        }
        
        // Store recent order for sandwich/front-running detection
        state.recentOrders.push({
          id: body.id || `order-${Date.now()}`,
          price: body.price || 0,
          timestamp: Date.now()
        });
        
        // Keep only recent orders (last 50)
        if (state.recentOrders.length > 50) {
          state.recentOrders.shift();
        }
        
        // Get current price from DEX state
        const currentPrice = await getCurrentPrice();
        
        // Detect sandwich attacks
        if (detectSandwichAttack(state.recentOrders, currentPrice)) {
          anomalyCounter.inc({ endpoint: pathname, anomaly_type: 'sandwich_attack' });
          console.error(`[ANOMALY] Sandwich attack detected from IP: ${ip}`);
        }
        
        // Detect front-running
        if (detectFrontRunning(state.recentOrders, currentPrice, ip)) {
          anomalyCounter.inc({ endpoint: pathname, anomaly_type: 'front_running' });
          console.error(`[ANOMALY] Front-running detected from IP: ${ip}`);
        }
      }
    }
    
    // For swap endpoint
    if (pathname.startsWith('/api/dex/swap')) {
      const body = await req.json();
      
      // Record swap for reentrancy detection
      state.recentSwaps.push({
        id: body.id || `swap-${Date.now()}`,
        timestamp: Date.now()
      });
      
      // Keep only recent swaps (last 20)
      if (state.recentSwaps.length > 20) {
        state.recentSwaps.shift();
      }
      
      // Detect reentrancy attacks
      if (state.recentSwaps.length > 1) {
        const lastSwap = state.recentSwaps[state.recentSwaps.length - 1];
        const prevSwap = state.recentSwaps[state.recentSwaps.length - 2];
        
        if (lastSwap.timestamp - prevSwap.timestamp < 100) { // Very quick consecutive swaps
          state.reentrancyCount++;
          
          if (state.reentrancyCount > THRESHOLDS.reentrancy_attempts) {
            anomalyCounter.inc({ endpoint: pathname, anomaly_type: 'reentrancy_attack' });
            console.error(`[ANOMALY] Reentrancy attack detected from IP: ${ip}`);
          }
        } else {
          state.reentrancyCount = 0; // Reset counter if not rapid
        }
      }
    }
  } catch (error) {
    console.error(`[ERROR] Behavioral analysis failed: ${error}`);
  }
  
  return res;
}

// Helper function to get current price from DEX
async function getCurrentPrice(): Promise<number> {
  try {
    // This would typically query the DEX state or database
    // For this example, we'll return a placeholder
    return 1.0; // Placeholder price
  } catch (error) {
    console.error(`[ERROR] Failed to get current price: ${error}`);
    return 1.0; // Fallback
  }
}

// Export Prometheus metrics endpoint
export async function GET(req: Request) {
  if (req.url.includes('/metrics')) {
    return new Response(prometheus.metrics(), {
      headers: {
        'Content-Type': prometheus.contentType,
      },
    });
  }
  
  return new Response('Not Found', { status: 404 });
}
