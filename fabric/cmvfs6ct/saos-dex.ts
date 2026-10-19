import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';

interface BehaviorEvent {
  timestamp: number;
  address: string;
  action: string;
  gasPrice?: bigint;
  amount?: string;
  tokenIn?: string;
  tokenOut?: string;
}

class BehaviorMonitor {
  private readonly WINDOW_MS = 60_000;
  private readonly REENTRANCY_THRESHOLD_MS = 500;
  private readonly SANDWICH_WINDOW_MS = 10_000;
  private readonly HIGH_FREQ_THRESHOLD = 10;
  private readonly GAS_SPIKE_MULTIPLIER = 3;

  private addressEvents = new Map<string, BehaviorEvent[]>();
  private tokenEvents = new Map<string, BehaviorEvent[]>();
  private gasPriceHistory = new Map<string, bigint[]>();

  constructor() {
    setInterval(() => this.cleanupOldEvents(), this.WINDOW_MS);
  }

  private cleanupOldEvents() {
    const now = Date.now();
    for (const [addr, events] of this.addressEvents) {
      const filtered = events.filter(e => now - e.timestamp < this.WINDOW_MS * 2);
      if (filtered.length === 0) {
        this.addressEvents.delete(addr);
      } else {
        this.addressEvents.set(addr, filtered);
      }
    }
    for (const [token, events] of this.tokenEvents) {
      const filtered = events.filter(e => now - e.timestamp < this.WINDOW_MS * 2);
      if (filtered.length === 0) {
        this.tokenEvents.delete(token);
      } else {
        this.tokenEvents.set(token, filtered);
      }
    }
    for (const [token, prices] of this.gasPriceHistory) {
      const cutoff = Date.now() - this.WINDOW_MS * 2;
      // Assuming we store timestamps with prices - simplified for now
      if (prices.length > 100) {
        this.gasPriceHistory.set(token, prices.slice(-50));
      }
    }
  }

  async analyzeRequest(req: NextRequest): Promise<{ isSuspicious: boolean; reason?: string }> {
    const pathname = req.nextUrl.pathname;
    if (!pathname.startsWith('/api/dex/')) {
      return { isSuspicious: false };
    }

    const addr = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 
                 req.headers.get('x-real-ip') || 
                 'unknown';
    
    const now = Date.now();
    const action = pathname.split('/').pop() || 'unknown';

    // Extract relevant data from request
    let gasPrice: bigint | undefined;
    let amount: string | undefined;
    let tokenIn: string | undefined;
    let tokenOut: string | undefined;

    if (req.method === 'POST') {
      try {
        const body = await req.clone().json();
        gasPrice = BigInt(body.gasPrice || '0');
        amount = body.amount?.toString();
        tokenIn = body.tokenIn;
        tokenOut = body.tokenOut;
      } catch (e) {
        // Invalid JSON, continue with undefined values
      }
    }

    const event: BehaviorEvent = {
      timestamp: now,
      address: addr,
      action,
      gasPrice,
      amount,
      tokenIn,
      tokenOut
    };

    // Initialize arrays if needed
    if (!this.addressEvents.has(addr)) {
      this.addressEvents.set(addr, []);
    }
    const addrEvents = this.addressEvents.get(addr)!;

    if (tokenIn && !this.tokenEvents.has(tokenIn)) {
      this.tokenEvents.set(tokenIn, []);
    }
    if (tokenOut && !this.tokenEvents.has(tokenOut)) {
      this.tokenEvents.set(tokenOut, []);
    }

    // 1. Reentrancy detection
    const lastEvent = addrEvents[addrEvents.length - 1];
    if (lastEvent && now - lastEvent.timestamp < this.REENTRANCY_THRESHOLD_MS && 
        lastEvent.action === action) {
      this.logSuspicious(addr, 'REENTRANCY_DETECTED', { 
        timeBetween: now - lastEvent.timestamp,
        action
      });
      return { isSuspicious: true, reason: 'reentrancy' };
    }

    // 2. Gas price spike detection (front-running indicator)
    if (gasPrice && tokenIn) {
      if (!this.gasPriceHistory.has(tokenIn)) {
        this.gasPriceHistory.set(tokenIn, []);
      }
      const history = this.gasPriceHistory.get(tokenIn)!;
      if (history.length > 0) {
        const avgGas = history.reduce((a, b) => a + b, 0n) / BigInt(history.length);
        if (gasPrice > avgGas * BigInt(this.GAS_SPIKE_MULTIPLIER)) {
          this.logSuspicious(addr, 'GAS_SPIKE_DETECTED', {
            currentGas: gasPrice.toString(),
            avgGas: avgGas.toString(),
            token: tokenIn
          });
          return { isSuspicious: true, reason: 'front-running' };
        }
      }
      history.push(gasPrice);
      if (history.length > 100) history.shift();
    }

    // 3. High frequency trading detection
    const recentEvents = addrEvents.filter(e => now - e.timestamp < this.WINDOW_MS);
    if (recentEvents.length > this.HIGH_FREQ_THRESHOLD) {
      this.logSuspicious(addr, 'HIGH_FREQUENCY_TRADING', {
        count: recentEvents.length,
        windowMs: this.WINDOW_MS
      });
      return { isSuspicious: true, reason: 'high-frequency' };
    }

    // 4. Sandwich attack detection (simplified)
    if (tokenIn && tokenOut && action === 'swap') {
      const tokenEvents = this.tokenEvents.get(tokenIn)!;
      const relevant = tokenEvents.filter(e => 
        e.action === 'swap' && 
        e.tokenIn === tokenIn && 
        e.tokenOut === tokenOut &&
        now - e.timestamp < this.SANDWICH_WINDOW_MS
      );
      
      if (relevant.length >= 2) {
        // Check for pattern: buy, price increase, sell
        const sorted = [...relevant].sort((a, b) => a.timestamp - b.timestamp);
        if (sorted.length >= 3) {
          const first = sorted[0];
          const middle = sorted[1];
          const last = sorted[sorted.length - 1];
          
          // Simplified: if we have rapid buy-sell-buy or sell-buy-sell
          if (first.action === 'swap' && last.action === 'swap' && middle.action === 'swap') {
            this.logSuspicious(addr, 'SANDWICH_PATTERN_DETECTED', {
              tokenIn,
              tokenOut,
              events: sorted.length
            });
            return { isSuspicious: true, reason: 'sandwich' };
          }
        }
      }
    }

    // Store event
    addrEvents.push(event);
    if (addrEvents.length > 1000) addrEvents.shift();
    
    if (tokenIn) {
      const tokenInEvents = this.tokenEvents.get(tokenIn)!;
      tokenInEvents.push(event);
      if (tokenInEvents.length > 1000) tokenInEvents.shift();
    }
    if (tokenOut) {
      const tokenOutEvents = this.tokenEvents.get(tokenOut)!;
      tokenOutEvents.push(event);
      if (tokenOutEvents.length > 1000) tokenOutEvents.shift();
    }

    return { isSuspicious: false };
  }

  private logSuspicious(address: string, type: string, details: any) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      address: createHash('sha256').update(address).digest('hex').slice(0, 12),
      type,
      details
    };
    
    console.warn(JSON.stringify({
      action: 'behavior_alert',
      ...logEntry
    }));
    
    // Attempt to send to centralized logging if configured
    void (async () => {
      try {
        const base = process.env.SAOS_CONTROL_CENTER_URL;
        if (!base) return;
        await fetch(`${base}/api/alerts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event_type: 'behavioral_anomaly_detected',
            at: logEntry.timestamp,
            service_id: 'saos-dex',
            address_hash: logEntry.address,
            anomaly_type: type,
            details
          }),
          signal: AbortSignal.timeout(3000)
        });
      } catch (e) {
        console.warn(`[${logEntry.timestamp}] BEHAVIOR_ALERT_FAILURE: ${e instanceof Error ? e.message : 'Unknown error'}`);
      }
    })();
  }
}

const monitor = new BehaviorMonitor();

export async function behaviorMonitorMiddleware(req: NextRequest, res: NextResponse) {
  const result = await monitor.analyzeRequest(req);
  if (result.isSuspicious) {
    return NextResponse.json(
      { error: 'Suspicious behavior detected', reason: result.reason },
      { status: 429 }
    );
  }
  return res;
}

// Export for use in middleware chain
export { behaviorMonitorMiddleware };