import { NextRequest, NextResponse } from 'next/server';

// ── Behavioral Monitoring Configuration (via environment) ──
const ENABLE_BEHAVIORAL_MONITORING = process.env.ENABLE_BEHAVIORAL_MONITORING === 'true';
const THRESHOLD_STDDEV = parseFloat(process.env.THRESHOLD_STDDEV || '3'); // 3 standard deviations
const WINDOW_SIZE_MINUTES = parseInt(process.env.WINDOW_SIZE_MINUTES || '5'); // 5-minute rolling window
const MAX_SWAPS_PER_MINUTE = parseInt(process.env.MAX_SWAPS_PER_MINUTE || '10'); // Max swaps per minute per IP
const PRICE_DEVIATION_PERCENT = parseFloat(process.env.PRICE_DEVIATION_PERCENT || '5'); // 5% price deviation threshold

// ── In-memory storage for behavioral tracking (in production, use Redis or similar) ──
interface SwapRecord {
  timestamp: number;
  pair: string;
  amount: number;
  price: number;
}

interface RequestRecord {
  timestamp: number;
  endpoint: string;
  pair?: string;
}

const swapHistory = new Map<string, SwapRecord[]>(); // ip -> records
const requestHistory = new Map<string, RequestRecord[]>(); // ip -> records

// ── Helper functions ──
function calculateStandardDeviation(values: number[]): number {
  const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
  const squareDiffs = values.map(value => Math.pow(value - mean, 2));
  const avgSquareDiff = squareDiffs.reduce((sum, val) => sum + val, 0) / values.length;
  return Math.sqrt(avgSquareDiff);
}

function isNumeric(value: unknown): value is number {
  return typeof value === 'number' && !isNaN(value);
}

function getDeviationScore(value: number, values: number[]): number {
  if (values.length < 2) return 0; // Not enough data
  
  const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
  const stdDev = calculateStandardDeviation(values);
  
  if (stdDev === 0) return 0; // No deviation
  
  return Math.abs((value - mean) / stdDev);
}

function getCurrentWindow(): number {
  return Date.now();
}

function cleanOldRecords(history: Map<string, RequestRecord[]>, windowMs: number): void {
  const now = getCurrentWindow();
  
  history.forEach((records, ip) => {
    const filtered = records.filter(record => now - record.timestamp < windowMs);
    if (filtered.length !== records.length) {
      history.set(ip, filtered);
    }
  });
}

function detectAttackType(ip: string, endpoint: string, pair?: string, amount?: number, price?: number): string | null {
  const now = getCurrentWindow();
  const windowMs = WINDOW_SIZE_MINUTES * 60 * 1000;
  
  // Check for reentrancy: multiple requests to same endpoint in quick succession
  const ipRequests = requestHistory.get(ip) || [];
  const recentRequests = ipRequests.filter(
    req => req.endpoint === endpoint && now - req.timestamp < 5000 // 5-second window
  );
  
  if (recentRequests.length > 3) {
    return 'reentrancy';
  }
  
  // Check for front-running/sandwich patterns
  if (endpoint === '/api/dex/swap' && pair) {
    const ipSwaps = swapHistory.get(ip) || [];
    const recentSwaps = ipSwaps.filter(
      swap => swap.pair === pair && now - swap.timestamp < 30000 // 30-second window
    );
    
    if (recentSwaps.length >= 3) {
      return 'sandwich';
    }
  }
  
  // Check for abnormal swap amounts
  if (endpoint === '/api/dex/swap' && isNumeric(amount) && pair) {
    const ipSwaps = swapHistory.get(ip) || [];
    const samePairSwaps = ipSwaps
      .filter(swap => swap.pair === pair && now - swap.timestamp < windowMs)
      .map(swap => swap.amount);
    
    if (samePairSwaps.length > 1) {
      const deviation = getDeviationScore(amount, samePairSwaps);
      if (deviation > THRESHOLD_STDDEV) {
        return 'abnormal_amount';
      }
    }
  }
  
  // Check for abnormal prices
  if (endpoint === '/api/dex/swap' && isNumeric(price) && pair) {
    const ipSwaps = swapHistory.get(ip) || [];
    const samePairSwaps = ipSwaps
      .filter(swap => swap.pair === pair && now - swap.timestamp < windowMs)
      .map(swap => swap.price);
    
    if (samePairSwaps.length > 1) {
      const avgPrice = samePairSwaps.reduce((sum, p) => sum + p, 0) / samePairSwaps.length;
      const deviation = Math.abs((price - avgPrice) / avgPrice) * 100;
      
      if (deviation > PRICE_DEVIATION_PERCENT) {
        return 'abnormal_price';
      }
    }
  }
  
  return null;
}

function logAttack(ip: string, endpoint: string, attackType: string, deviationScore: number): void {
  const logger = require('pino')();
  
  logger.warn({
    timestamp: new Date().toISOString(),
    ip,
    endpoint,
    attack_type: attackType,
    deviation_score: deviationScore
  }, 'Behavioral attack detected');
}

// ── Main middleware function ──
export async function middleware(request: NextRequest): Promise<NextResponse> {
  // Skip monitoring if disabled
  if (!ENABLE_BEHAVIORAL_MONITORING) {
    return NextResponse.next();
  }
  
  const ip = request.ip || 'unknown';
  const pathname = request.nextUrl.pathname;
  const now = getCurrentWindow();
  const windowMs = WINDOW_SIZE_MINUTES * 60 * 1000;
  
  // Clean old records periodically
  if (now % 60000 < 100) { // Clean roughly every minute
    cleanOldRecords(swapHistory, windowMs);
    cleanOldRecords(requestHistory, windowMs);
  }
  
  // Track all requests
  const requestRecord: RequestRecord = {
    timestamp: now,
    endpoint: pathname
  };
  
  const ipRequests = requestHistory.get(ip) || [];
  ipRequests.push(requestRecord);
  requestHistory.set(ip, ipRequests);
  
  // Only monitor specific endpoints
  if (!pathname.startsWith('/api/dex/agent') && 
      !pathname.startsWith('/api/dex/order') && 
      !pathname.startsWith('/api/dex/swap')) {
    return NextResponse.next();
  }
  
  let attackType: string | null = null;
  let deviationScore = 0;
  
  // Extract relevant data based on endpoint
  if (pathname.startsWith('/api/dex/swap')) {
    try {
      const body = await request.json();
      const pair = body.pair || '';
      const amount = isNumeric(body.amount) ? body.amount : 0;
      const price = isNumeric(body.price) ? body.price : 0;
      
      // Track swap history
      const ipSwaps = swapHistory.get(ip) || [];
      ipSwaps.push({
        timestamp: now,
        pair,
        amount,
        price
      });
      swapHistory.set(ip, ipSwaps);
      
      // Check for attacks
      attackType = detectAttackType(ip, pathname, pair, amount, price);
      
      if (attackType) {
        // Calculate deviation score for logging
        if (attackType === 'abnormal_amount' && isNumeric(amount)) {
          const samePairSwaps = ipSwaps
            .filter(swap => swap.pair === pair && now - swap.timestamp < windowMs)
            .map(swap => swap.amount);
          deviationScore = getDeviationScore(amount, samePairSwaps);
        } else if (attackType === 'abnormal_price' && isNumeric(price)) {
          const samePairSwaps = ipSwaps
            .filter(swap => swap.pair === pair && now - swap.timestamp < windowMs)
            .map(swap => swap.price);
          deviationScore = getDeviationScore(price, samePairSwaps);
        }
        
        // Log the attack
        logAttack(ip, pathname, attackType, deviationScore);
        
        // Block the request
        return new NextResponse(
          JSON.stringify({ 
            error: 'Behavioral attack detected', 
            attack_type: attackType,
            message: 'Request blocked due to suspicious activity'
          }),
          { 
            status: 429,
            headers: { 'Content-Type': 'application/json' }
          }
        );
      }
    } catch (error) {
      // If we can't parse the body, continue normally
      console.error('Error parsing request body for behavioral monitoring:', error);
    }
  }
  
  // Check for rate limiting (max swaps per minute)
  if (pathname.startsWith('/api/dex/swap')) {
    const ipRequests = requestHistory.get(ip) || [];
    const recentRequests = ipRequests.filter(
      req => req.timestamp > now - 60 * 1000 // Last minute
    );
    
    if (recentRequests.length > MAX_SWAPS_PER_MINUTE) {
      logAttack(ip, pathname, 'rate_limit', recentRequests.length);
      
      return new NextResponse(
        JSON.stringify({ 
          error: 'Rate limit exceeded', 
          message: `Maximum of ${MAX_SWAPS_PER_MINUTE} swaps per minute allowed`
        }),
        { 
          status: 429,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }
  }
  
  return NextResponse.next();
}

// ── Configuration for which routes the middleware should run on ──
export const config = {
  matcher: [
    '/api/dex/agent/:path*',
    '/api/dex/order/:path*',
    '/api/dex/swap/:path*'
  ]
};