import { NextRequest, NextResponse } from 'next/server';
import { Counter, Gauge, Histogram } from 'prom-client';

// Prometheus metrics
const requestCounter = new Counter({
  name: 'dex_api_requests_total',
  help: 'Total number of DEX API requests',
  labelNames: ['endpoint', 'ip', 'status'] as const,
});

const requestDuration = new Histogram({
  name: 'dex_api_request_duration_seconds',
  help: 'Duration of DEX API requests in seconds',
  labelNames: ['endpoint', 'ip'] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10],
});

const volumeGauge = new Gauge({
  name: 'dex_api_swap_volume',
  help: 'Current swap volume',
  labelNames: ['token'] as const,
});

const anomalyCounter = new Counter({
  name: 'dex_api_behavioral_anomalies_total',
  help: 'Total number of detected behavioral anomalies',
  labelNames: ['type', 'ip', 'endpoint'] as const,
});

const requestVolumeZscore = new Gauge({
  name: 'dex_api_request_volume_zscore',
  help: 'Z-score for request volume',
  labelNames: ['ip'] as const,
});

// In-memory storage for tracking behavior
const requestHistory = new Map<string, {
  timestamps: number[];
  volumes: number[];
  lastSwapPrice: number;
  swapCount: number;
}>();

const ANOMALY_THRESHOLDS = {
  requestFrequency: 3, // Z-score threshold for request frequency
  volumeDeviation: 3, // Z-score threshold for volume deviation
  priceChange: 0.1, // 10% price change threshold
  rapidSwaps: 5, // Number of rapid swaps in a short time
};

const MONITORED_ENDPOINTS = ['/api/dex/agent', '/api/dex/order', '/api/dex/swap'];
const MAX_HISTORY_SIZE = 100;
const HISTORY_CLEANUP_INTERVAL = 60_000; // 1 minute

// Cleanup old history periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of requestHistory.entries()) {
    // Remove data older than 5 minutes
    data.timestamps = data.timestamps.filter(t => now - t < 300_000);
    data.volumes = data.volumes.slice(-data.timestamps.length);
    
    // Remove empty entries
    if (data.timestamps.length === 0) {
      requestHistory.delete(key);
    }
  }
}, HISTORY_CLEANUP_INTERVAL);

function calculateZScore(values: number[], mean: number, stdDev: number): number {
  if (values.length === 0 || stdDev === 0) return 0;
  const latest = values[values.length - 1];
  return (latest - mean) / stdDev;
}

function calculateMean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, val) => sum + val, 0) / values.length;
}

function calculateStdDev(values: number[], mean: number): number {
  if (values.length === 0) return 0;
  const squareDiffs = values.map(value => Math.pow(value - mean, 2));
  const avgSquareDiff = squareDiffs.reduce((sum, val) => sum + val, 0) / values.length;
  return Math.sqrt(avgSquareDiff);
}

function detectAnomalies(ip: string, endpoint: string, requestData: any): boolean {
  const key = `${ip}-${endpoint}`;
  let history = requestHistory.get(key);
  
  if (!history) {
    history = {
      timestamps: [],
      volumes: [],
      lastSwapPrice: 0,
      swapCount: 0,
    };
    requestHistory.set(key, history);
  }
  
  const now = Date.now();
  history.timestamps.push(now);
  
  // Limit history size
  if (history.timestamps.length > MAX_HISTORY_SIZE) {
    history.timestamps.shift();
    history.volumes.shift();
  }
  
  let anomalyDetected = false;
  
  // Request frequency anomaly
  if (endpoint === '/api/dex/agent') {
    const recentRequests = history.timestamps.filter(
      t => now - t < 60_000 // Last minute
    ).length;
    
    const requestValues = history.timestamps
      .filter((_, i) => i % 5 === 0) // Sample every 5th request
      .map((_, i, arr) => {
        const windowStart = Math.max(0, i - 4);
        return arr.slice(windowStart, i + 1).length;
      });
    
    if (requestValues.length > 1) {
      const mean = calculateMean(requestValues);
      const stdDev = calculateStdDev(requestValues, mean);
      const zScore = calculateZScore([...requestValues, recentRequests], mean, stdDev);
      
      requestVolumeZscore.set({ ip }, zScore);
      
      if (Math.abs(zScore) > ANOMALY_THRESHOLDS.requestFrequency) {
        anomalyCounter.inc({
          type: 'high_request_frequency',
          ip,
          endpoint,
        });
        anomalyDetected = true;
      }
    }
  }
  
  // Swap volume anomaly
  if (endpoint === '/api/dex/swap') {
    const volume = parseFloat(requestData.volume || 0);
    history.volumes.push(volume);
    
    // Update volume gauge
    const token = requestData.token || 'unknown';
    volumeGauge.set({ token }, volume);
    
    // Check for volume deviation
    if (history.volumes.length > 10) {
      const recentVolumes = history.volumes.slice(-10);
      const mean = calculateMean(recentVolumes);
      const stdDev = calculateStdDev(recentVolumes, mean);
      const zScore = calculateZScore([...recentVolumes, volume], mean, stdDev);
      
      if (Math.abs(zScore) > ANOMALY_THRESHOLDS.volumeDeviation) {
        anomalyCounter.inc({
          type: 'unusual_volume',
          ip,
          endpoint,
        });
        anomalyDetected = true;
      }
    }
    
    // Check for rapid swaps with price changes
    const currentPrice = parseFloat(requestData.price || 0);
    if (history.lastSwapPrice > 0) {
      const priceChange = Math.abs(currentPrice - history.lastSwapPrice) / history.lastSwapPrice;
      
      if (priceChange > ANOMALY_THRESHOLDS.priceChange) {
        // Price changed significantly, check for rapid swaps
        const recentSwaps = history.timestamps.filter(
          t => now - t < 30_000 // Last 30 seconds
        ).length;
        
        if (recentSwaps > ANOMALY_THRESHOLDS.rapidSwaps) {
          anomalyCounter.inc({
            type: 'possible_sandwich_attack',
            ip,
            endpoint,
          });
          anomalyDetected = true;
        }
      }
    }
    
    history.lastSwapPrice = currentPrice;
    history.swapCount++;
  }
  
  // Check for potential reentrancy
  if (endpoint === '/api/dex/order') {
    const functionName = requestData.function || 'unknown';
    const recentSameFunctionCalls = history.timestamps.filter(
      t => now - t < 5_000 // Last 5 seconds
    ).length;
    
    if (recentSameFunctionCalls > 3) {
      anomalyCounter.inc({
        type: 'possible_reentrancy',
        ip,
        endpoint,
      });
      anomalyDetected = true;
    }
  }
  
  return anomalyDetected;
}

export function behavioralAnalysisMiddleware(req: NextRequest): boolean {
  const ip = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
  const endpoint = new URL(req.url).pathname;
  
  if (!MONITORED_ENDPOINTS.includes(endpoint)) {
    return false; // Skip non-monitored endpoints
  }
  
  try {
    // For POST requests, try to parse the body to get request data
    let requestData: any = {};
    if (req.method === 'POST' && req.body) {
      // In a real implementation, you'd need to handle the stream properly
      // This is a simplified version for demonstration
      try {
        // Clone the body to read it
        const clonedBody = req.body.clone();
        clonedBody.text().then(text => {
          try {
            requestData = JSON.parse(text);
            detectAnomalies(ip, endpoint, requestData);
          } catch (e) {
            // If parsing fails, we can't analyze the data
          }
        }).catch(() => {});
      } catch (e) {
        // If cloning fails, we can't analyze the data
      }
    }
    
    // For GET requests, use query parameters
    if (req.method === 'GET') {
      const searchParams = new URL(req.url).searchParams;
      requestData = {
        token: searchParams.get('token'),
        volume: searchParams.get('volume'),
        price: searchParams.get('price'),
        function: searchParams.get('function'),
      };
      detectAnomalies(ip, endpoint, requestData);
    }
    
    return false; // Middleware continues processing
  } catch (error) {
    console.error('Behavioral analysis error:', error);
    return false; // Continue processing even if analysis fails
  }
}

// Export metrics for Prometheus to collect
export { requestCounter, requestDuration, volumeGauge, anomalyCounter, requestVolumeZscore };
