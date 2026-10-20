// src/middleware/behavioral-security/index.ts
import { NextRequest, NextResponse } from 'next/server';
import { analyzeBehavioralThreats } from './analyzer';

const CRITICAL_PATHS = [
  '/api/dex/swap',
  '/api/dex/pool',
  '/api/dex/liquidity',
  '/api/dex/add-liquidity',
  '/api/dex/remove-liquidity'
];

const THREAT_CACHE = new Map<string, { timestamp: number; threats: string[] }>();
const CACHE_TTL_MS = 30_000; // 30 seconds

function getClientIp(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
         req.headers.get('x-real-ip') ||
         req.ip ||
         'unknown';
}

function isCriticalPath(pathname: string): boolean {
  return CRITICAL_PATHS.some(path => pathname.startsWith(path));
}

function getFromCache(address: string): string[] | null {
  const cached = THREAT_CACHE.get(address);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
    THREAT_CACHE.delete(address);
    return null;
  }
  return cached.threats;
}

function setToCache(address: string, threats: string[]): void {
  if (THREAT_CACHE.size > 1000) {
    const oldestKey = THREAT_CACHE.keys().next().value;
    if (oldestKey) THREAT_CACHE.delete(oldestKey);
  }
  THREAT_CACHE.set(address, { timestamp: Date.now(), threats });
}

export async function middleware(req: NextRequest) {
  const pathname = req.nextUrl.pathname;
  
  if (!isCriticalPath(pathname)) {
    return NextResponse.next();
  }

  const ip = getClientIp(req);
  const cachedThreats = getFromCache(ip);

  if (cachedThreats) {
    for (const threat of cachedThreats) {
      console.warn(JSON.stringify({
        type: 'behavioral_threat_detected',
        threat,
        ip,
        path: pathname,
        timestamp: new Date().toISOString(),
        source: 'cache'
      }));
    }
    return NextResponse.next();
  }

  try {
    const threats = await analyzeBehavioralThreats(req);
    
    if (threats.length > 0) {
      setToCache(ip, threats);
      
      for (const threat of threats) {
        console.warn(JSON.stringify({
          type: 'behavioral_threat_detected',
          threat,
          ip,
          path: pathname,
          timestamp: new Date().toISOString(),
          source: 'live_analysis'
        }));
      }
    }
  } catch (error) {
    console.error(JSON.stringify({
      type: 'behavioral_analysis_error',
      error: error instanceof Error ? error.message : 'Unknown error',
      ip,
      path: pathname,
      timestamp: new Date().toISOString()
    }));
  }

  return NextResponse.next();
}

// src/middleware/behavioral-security/analyzer.ts
import { ethers } from 'ethers';

// Mock blockchain provider - in production, use actual RPC endpoint
const provider = new ethers.JsonRpcProvider(process.env.BLOCKCHAIN_RPC_URL || 'http://localhost:8545');

// Track recent transactions per address for reentrancy detection
const recentTxMap = new Map<string, Array<{ txHash: string; timestamp: number; methodSig: string; paramsHash: string }>>();
const TX_WINDOW_MS = 12_000; // ~2 blocks at 6s/block

// Known DeFi method signatures
const METHOD_SIGNATURES = {
  swap: '0x38ed1739', // swap(address,uint256,uint256,address,uint256,uint256)
  addLiquidity: '0xe8e33700', // addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)
  removeLiquidity: '0xbaa2abde', // removeLiquidity(address,uint256,uint256,uint256,address,uint256)
};

function getMethodSig(data: string): string {
  return data.slice(0, 10); // First 4 bytes + 0x
}

function getParamsHash(data: string): string {
  // Simple hash of parameters (first 100 chars after method sig)
  const params = data.slice(10, Math.min(110, data.length));
  return ethers.keccak256(ethers.toUtf8Bytes(params)).slice(0, 10);
}

async function getMempoolTransactions(address: string): Promise<Array<{ txHash: string; timestamp: number; data: string; gasPrice: bigint }>> {
  try {
    // In real implementation, fetch pending transactions from mempool
    // This is a simplified mock - replace with actual mempool query
    const block = await provider.getBlock('pending');
    if (!block || !block.transactions) return [];
    
    return block.transactions
      .filter((tx: any) => tx.from?.toLowerCase() === address.toLowerCase())
      .map((tx: any) => ({
        txHash: tx.hash,
        timestamp: Date.now(),
        data: tx.data || '0x',
        gasPrice: tx.gasPrice ?? 0n
      }));
  } catch (error) {
    console.warn('Failed to fetch mempool transactions:', error);
    return [];
  }
}

export async function analyzeBehavioralThreats(req: Request): Promise<string[]> {
  const threats: string[] = [];
  const url = new URL(req.url);
  const pathname = url.pathname;
  
  // Extract user address from request (header, body, or query)
  let userAddress = req.headers.get('x-user-address') ||
                   url.searchParams.get('user') ||
                   'unknown';
  
  if (userAddress === 'unknown' || !ethers.isAddress(userAddress)) {
    return threats;
  }
  
  userAddress = userAddress.toLowerCase();
  
  try {
    const pendingTxes = await getMempoolTransactions(userAddress);
    
    // 1. Reentrancy detection
    const reentrancyThreats = detectReentrancy(userAddress, pendingTxes);
    threats.push(...reentrancyThreats);
    
    // 2. Front-running detection
    const frontRunThreats = detectFrontRunning(userAddress, pendingTxes, pathname);
    threats.push(...frontRunThreats);
    
    // 3. Sandwich detection
    const sandwichThreats = detectSandwich(userAddress, pendingTxes, pathname);
    threats.push(...sandwichThreats);
    
    // Update recent transaction map
    updateRecentTxMap(userAddress, pendingTxes);
    
  } catch (error) {
    console.error('Behavioral analysis failed:', error);
  }
  
  return threats;
}

function detectReentrancy(address: string, pendingTxes: Array<{ txHash: string; timestamp: number; data: string; gasPrice: bigint }>): string[] {
  const threats: string[] = [];
  const now = Date.now();
  
  // Get recent transactions from our tracking map
  const recentTxes = recentTxMap.get(address) || [];
  
  // Check for duplicate method calls with similar params in short time
  for (const tx of pendingTxes) {
    const methodSig = getMethodSig(tx.data);
    const paramsHash = getParamsHash(tx.data);
    const key = `${methodSig}:${paramsHash}`;
    
    // Look for similar recent transactions
    for (const recent of recentTxes) {
      if (now - recent.timestamp > TX_WINDOW_MS) continue;
      
      if (recent.methodSig === methodSig && 
          recent.paramsHash === paramsHash && 
          recent.txHash !== tx.txHash) {
        
        threats.push(`REENTRANCY_SUSPECT: Similar tx ${tx.txHash} within ${TX_WINDOW_MS}ms of ${recent.txHash}`);
        break; // Avoid duplicate alerts for same tx
      }
    }
  }
  
  return threats;
}

function detectFrontRunning(address: string, pendingTxes: Array<{ txHash: string; timestamp: number; data: string; gasPrice: bigint }>, pathname: string): string[] {
  const threats: string[] = [];
  
  // Only check for known DeFi paths
  const isDeFiPath = Object.values(METHOD_SIGNATURES).some(sig => 
    pathname.includes(sig.slice(2)) || 
    ['swap', 'liquidity'].some(k => pathname.includes(k))
  );
  
  if (!isDeFiPath || pendingTxes.length === 0) return threats;
  
  // Sort by gas price (descending) - higher gas price = more likely to be frontrunner
  const sortedByGas = [...pendingTxes].sort((a, b) => 
    BigInt(b.gasPrice) - BigInt(a.gasPrice)
  );
  
  const userTx = pendingTxes[0]; // Assume first is user transaction
  if (!userTx) return threats;
  
  // Check if any transaction has significantly higher gas price
  for (const tx of sortedByGas.slice(0, 3)) { // Check top 3 gas guzzlers
    if (tx.txHash === userTx.txHash) continue;
    
    const gasDiff = BigInt(tx.gasPrice) - BigInt(userTx.gasPrice);
    const gasDiffPercent = Number(gasDiff) / Number(BigInt(userTx.gasPrice) || 1n) * 100;
    
    if (gasDiffPercent > 50) { // 50% higher gas price
      threats.push(`FRONT_RUN_SUSPECT: Tx ${tx.txHash} paying ${gasDiffPercent.toFixed(0)}% more gas than user tx ${userTx.txHash}`);
    }
  }
  
  return threats;
}

function detectSandwich(address: string, pendingTxes: Array<{ txHash: string; timestamp: number; data: string; gasPrice: bigint }>, pathname: string): string[] {
  const threats: string[] = [];
  
  // Only for swap-like operations
  if (!pathname.includes('swap')) return threats;
  
  if (pendingTxes.length < 3) return threats;
  
  // Sort by timestamp
  const sortedByTime = [...pendingTxes].sort((a, b) => a.timestamp - b.timestamp);
  
  // Look for pattern: [attacker_before, user, attacker_after]
  for (let i = 1; i < sortedByTime.length - 1; i++) {
    const potentialUserTx = sortedByTime[i];
    
    if (potentialUserTx.from?.toLowerCase() !== address.toLowerCase()) continue;
    
    const beforeTx = sortedByTime[i - 1];
    const afterTx = sortedByTime[i + 1];
    
    // Check if before and after txs are from same address (potential sandwich attacker)
    if (beforeTx.from?.toLowerCase() === afterTx.from?.toLowerCase() &&
        beforeTx.from?.toLowerCase() !== address.toLowerCase()) {
      
      const timeWindow = afterTx.timestamp - beforeTx.timestamp;
      if (timeWindow < 15_000) { // Within 15 seconds
        threats.push(`SANDWICH_SUSPECT: Address ${beforeTx.from} surrounding user tx ${potentialUserTx.txHash} with ${timeWindow}ms window`);
      }
    }
  }
  
  return threats;
}

function updateRecentTxMap(address: string, pendingTxes: Array<{ txHash: string; timestamp: number; data: string; gasPrice: bigint }>): void {
  const now = Date.now();
  
  const txes: Array<{ txHash: string; timestamp: number; methodSig: string; paramsHash: string }> = pendingTxes.map(tx => ({
    txHash: tx.txHash,
    timestamp: tx.timestamp,
    methodSig: getMethodSig(tx.data),
    paramsHash: getParamsHash(tx.data)
  }));
  
  // Clean old entries and add new ones
  const existing = recentTxMap.get(address) || [];
  const combined = [...existing, ...txes]
    .filter(tx => now - tx.timestamp < TX_WINDOW_MS * 2); // Keep 2x window for safety
  
  recentTxMap.set(address, combined);
  
  // Periodic cleanup of map
  if (recentTxMap.size > 500) {
    for (const [addr] of recentTxMap.entries()) {
      const addrTxes = recentTxMap.get(addr) || [];
      const freshTxes = addrTxes.filter(tx => now - tx.timestamp < TX_WINDOW_MS);
      if (freshTxes.length === 0) {
        recentTxMap.delete(addr);
      } else {
        recentTxMap.set(addr, freshTxes);
      }
    }
  }
}

// src/middleware/behavioral-security/README.md
# Behavioral Security Middleware

This middleware detects advanced attack patterns in the saos-dex API:

## Detection Capabilities

1. **Reentrancy Detection**
   - Identifies repeated calls to the same contract method with similar parameters
   - Time window: ~2 blocks (12 seconds)
   - Uses transaction data hashing to detect parameter similarity

2. **Front-Running Detection**
   - Analyzes gas prices in mempool transactions
   - Flags transactions paying significantly (>50%) more gas than user transactions
   - Focused on DeFi critical paths (swap, liquidity)

3. **Sandwich Attack Detection**
   - Identifies patterns where a user transaction is surrounded by two transactions from the same address
   - Time window: <15 seconds
   - Specific to swap operations

## Implementation Details

- **Non-blocking**: Only logs threats, does not interrupt requests
- **Caching**: Uses LRU cache to avoid re-analyzing same address frequently
- **Performance**: Limited to critical API paths
- **Mempool Integration**: Uses ethers.js to query pending transactions
- **Structured Logging**: All threats logged as JSON for easy consumption

## Installation

1. Place files in `src/middleware/behavioral-security/`
2. Ensure middleware is registered in `src/middleware.ts`
3. Set `BLOCKCHAIN_RPC_URL` environment variable

## Example Log Output

```json
{
  "type": "behavioral_threat_detected",
  "threat": "REENTRANCY_SUSPECT: Similar tx 0xabc... within 12000ms of 0xdef...",
  "ip": "192.168.1.100",
  "path": "/api/dex/swap",
  "timestamp": "2026-09-15T10:30:00.000Z",
  "source": "live_analysis"
}
```

## Testing

Unit tests are available in `__tests__` directory covering:
- Reentrancy attack patterns
- Front-running via gas price analysis
- Sandwich attack detection
- Cache behavior
- Non-critical path bypass

## Configuration

Adjust these constants in the analyzer:
- `TX_WINDOW_MS`: Time window for reentrancy detection (default: 12000ms)
- Gas price threshold for front-running (default: 50%)
- Sandwich time window (default: 15000ms)
- Cache size and TTL
