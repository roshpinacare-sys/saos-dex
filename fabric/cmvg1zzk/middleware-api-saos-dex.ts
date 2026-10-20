import { NextRequest, NextResponse } from 'next/server';

interface ApiCall {
  timestamp: number;
  path: string;
  method: string;
  ip: string;
}

class BehaviorAnalyzer {
  private callHistory: Map<string, ApiCall[]> = new Map();
  private readonly WINDOW_MS = 10_000; // 10 seconds
  private readonly MAX_CALLS_PER_WINDOW = 20;
  private readonly REENTRANCY_THRESHOLD = 5; // Same path within 100ms

  getClientIp(req: NextRequest): string {
    return req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 
           req.headers.get('x-real-ip') || 
           req.ip || 
           'unknown';
  }

  detectReentrancy(ip: string, path: string, now: number): boolean {
    const history = this.callHistory.get(ip) || [];
    const recent = history.filter(call => 
      call.path === path && 
      now - call.timestamp < 100 // 100ms window for reentrancy
    );
    return recent.length >= this.REENTRANCY_THRESHOLD;
  }

  detectAbnormalFrequency(ip: string, now: number): boolean {
    const history = this.callHistory.get(ip) || [];
    const recent = history.filter(call => now - call.timestamp < this.WINDOW_MS);
    return recent.length > this.MAX_CALLS_PER_WINDOW;
  }

  detectSandwichPattern(ip: string, path: string, now: number): boolean {
    const history = this.callHistory.get(ip) || [];
    const swapCalls = history.filter(call => 
      call.path.includes('/api/dex/swap') && 
      now - call.timestamp < this.WINDOW_MS
    );
    // Simple heuristic: more than 3 swap calls in quick succession from same IP
    return swapCalls.length > 3;
  }

  recordCall(ip: string, path: string, method: string, now: number): void {
    if (!this.callHistory.has(ip)) {
      this.callHistory.set(ip, []);
    }
    const history = this.callHistory.get(ip)!;
    history.push({ timestamp: now, path, method, ip });
    
    // Clean old entries
    const cutoff = now - this.WINDOW_MS * 2;
    const filtered = history.filter(call => call.timestamp > cutoff);
    this.callHistory.set(ip, filtered);
    
    // Limit memory usage
    if (this.callHistory.size > 1000) {
      const firstKey = this.callHistory.keys().next().value;
      if (firstKey) this.callHistory.delete(firstKey);
    }
  }

  analyzeRequest(req: NextRequest): { blocked: boolean; reason?: string } {
    const ip = this.getClientIp(req);
    const path = req.nextUrl.pathname;
    const method = req.method;
    const now = Date.now();
    
    // Check for exempt paths
    if (path === '/api/dex/stream' || path === '/api/revive') {
      return { blocked: false };
    }
    
    // Record the call first for historical analysis
    this.recordCall(ip, path, method, now);
    
    // Run detection algorithms
    if (this.detectReentrancy(ip, path, now)) {
      return { blocked: true, reason: 'potential_reentrancy_attack' };
    }
    
    if (this.detectAbnormalFrequency(ip, now)) {
      return { blocked: true, reason: 'abnormal_request_frequency' };
    }
    
    if (this.detectSandwichPattern(ip, path, now)) {
      return { blocked: true, reason: 'potential_sandwich_attack' };
    }
    
    return { blocked: false };
  }
}

const analyzer = new BehaviorAnalyzer();

export async function middleware(req: NextRequest, event: NextResponse) {
  const { blocked, reason } = analyzer.analyzeRequest(req);
  
  if (blocked) {
    console.warn(JSON.stringify({
      timestamp: new Date().toISOString(),
      action: 'security_block',
      ip: analyzer.getClientIp(req),
      path: req.nextUrl.pathname,
      method: req.method,
      reason,
      user_agent: req.headers.get('user-agent') || 'unknown'
    }));
    
    return new NextResponse(JSON.stringify({ error: 'Request blocked by security policy' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  return NextResponse.next();
}

export const config = {
  matcher: [
    '/api/dex/:path*',
    '/api/revive'
  ]
};