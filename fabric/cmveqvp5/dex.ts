// src/lib/dex/behavior-monitor.ts
import { NextRequest } from "next/server";
import { Counter, Histogram, Gauge, Registry, collectDefaultMetrics } from "prom-client";

// Initialize Prometheus metrics
const registry = new Registry();
collectDefaultMetrics({ registry });

// Behavioral monitoring metrics
const reentrancyAttempts = new Counter({
  name: "dex_reentrancy_attempts_total",
  help: "Total number of reentrancy attack attempts detected",
  labelNames: ["endpoint", "function"],
  registers: [registry]
});

const frontRunningAttempts = new Counter({
  name: "dex_front_running_attempts_total",
  help: "Total number of front-running attack attempts detected",
  labelNames: ["endpoint", "txType"],
  registers: [registry]
});

const sandwichAttempts = new Counter({
  name: "dex_sandwich_attempts_total",
  help: "Total number of sandwich attack attempts detected",
  labelNames: ["endpoint", "tokenPair"],
  registers: [registry]
});

const businessLogicAnomalies = new Counter({
  name: "dex_business_logic_anomalies_total",
  help: "Total number of business logic anomalies detected",
  labelNames: ["endpoint", "anomalyType"],
  registers: [registry]
});

const requestDuration = new Histogram({
  name: "dex_request_duration_seconds",
  help: "Duration of DEX API requests in seconds",
  labelNames: ["endpoint", "method"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry]
});

const activeCalls = new Gauge({
  name: "dex_active_function_calls",
  help: "Number of currently active function calls for reentrancy detection",
  labelNames: ["endpoint", "function"],
  registers: [registry]
});

// Track recent transactions for sandwich/front-running detection
interface RecentTransaction {
  timestamp: number;
  blockNumber: bigint;
  amountIn: bigint;
  amountOut: bigint;
  tokenIn: string;
  tokenOut: string;
  txHash: string;
  sender: string;
}

const recentTransactions: RecentTransaction[] = [];
const MAX_RECENT_TXS = 1000;

// Reentrancy tracking
interface CallContext {
  functionName: string;
  endpoint: string;
  startTime: number;
}

const callStack: CallContext[] = [];

// Add metrics endpoint
export async function metricsHandler() {
  return new Response(await registry.metrics(), {
    headers: { "Content-Type": registry.contentType },
  });
}

// Behavioral monitoring middleware
export function createBehaviorMonitor() {
  return async (req: NextRequest, endpoint: string) => {
    const start = Date.now();
    
    try {
      // 1. Reentrancy detection
      const functionName = req.nextUrl.pathname.split("/").pop() || "unknown";
      
      // Check if we're already in this function (simple reentrancy check)
      const isReentrant = callStack.some(call => 
        call.functionName === functionName && call.endpoint === endpoint
      );
      
      if (isReentrant) {
        reentrancyAttempts.inc({ endpoint, function: functionName });
        // In a real implementation, we would throw or block here
        // For now, we log and continue (fail-open for monitoring)
        console.warn(`[BehaviorMonitor] Potential reentrancy detected: ${endpoint}.${functionName}`);
      }
      
      // Push to call stack
      callStack.push({ functionName, endpoint, startTime: start });
      
      // Limit call stack size
      if (callStack.length > 100) {
        callStack.shift();
      }
      
      // 2. Extract transaction data if available
      let txData: Partial<RecentTransaction> | null = null;
      try {
        const body = await req.clone().json();
        txData = {
          amountIn: BigInt(body.amountIn || "0"),
          amountOut: BigInt(body.amountOut || "0"),
          tokenIn: body.tokenIn || "",
          tokenOut: body.tokenOut || "",
          txHash: body.txHash || `tx_${Date.now()}`,
          sender: body.sender || body.account || "unknown",
          blockNumber: BigInt(body.blockNumber || "0"),
          timestamp: Date.now()
        };
      } catch (e) {
        // No transaction data in body, continue
      }
      
      // 3. Front-running detection
      if (txData && txData.blockNumber > 0) {
        const latestBlock = await getLatestBlockNumber();
        const blocksAhead = Number(txData.blockNumber - latestBlock);
        
        // If transaction is targeting a future block (possible front-running)
        if (blocksAhead > 0 && blocksAhead <= 2) { // Within next 2 blocks
          frontRunningAttempts.inc({ endpoint, txType: "swap" });
          console.warn(`[BehaviorMonitor] Potential front-running: tx targeting block ${txData.blockNumber}, current ${latestBlock}`);
        }
      }
      
      // 4. Sandwich detection
      if (txData && txData.tokenIn && txData.tokenOut) {
        const tokenPair = `${txData.tokenIn}-${txData.tokenOut}`;
        const reversePair = `${txData.tokenOut}-${txData.tokenIn}`;
        
        // Look for opposite transactions in recent history
        const oppositeTx = recentTransactions.find(tx => 
          (tx.tokenIn === txData.tokenOut && tx.tokenOut === txData.tokenIn) &&
          Math.abs(tx.timestamp - txData.timestamp) < 5000 // Within 5 seconds
        );
        
        if (oppositeTx) {
          // Check for price impact (simplified)
          const priceImpact = Math.abs(
            (Number(txData.amountOut) / Number(txData.amountIn)) -
            (Number(oppositeTx.amountOut) / Number(oppositeTx.amountIn))
          );
          
          if (priceImpact > 0.05) { // >5% price impact suggests sandwich
            sandwichAttempts.inc({ endpoint, tokenPair });
            console.warn(`[BehaviorMonitor] Potential sandwich attack detected on ${tokenPair}`);
          }
        }
      }
      
      // 5. Business logic anomalies
      if (txData) {
        // Check for excessive amounts
        const maxAllowed = BigInt("1000000000000000000000"); // 1000 tokens (assuming 18 decimals)
        if (txData.amountIn > maxAllowed || txData.amountOut > maxAllowed) {
          businessLogicAnomalies.inc({ endpoint, anomalyType: "excessive_amount" });
          console.warn(`[BehaviorMonitor] Excessive amount detected: ${txData.amountIn} in`);
        }
        
        // Check for zero amounts (could be dust attacks)
        if ((txData.amountIn === 0n && txData.amountOut > 0n) ||
            (txData.amountOut === 0n && txData.amountIn > 0n)) {
          businessLogicAnomalies.inc({ endpoint, anomalyType: "zero_amount" });
        }
      }
      
      // Add transaction to recent history
      if (txData && txData.timestamp > 0) {
        recentTransactions.push(txData as RecentTransaction);
        if (recentTransactions.length > MAX_RECENT_TXS) {
          recentTransactions.shift();
        }
      }
      
    } catch (error) {
      console.error(`[BehaviorMonitor] Error in monitoring:`, error);
    } finally {
      // Pop from call stack
      const index = callStack.findLastIndex(call => 
        call.functionName === (req.nextUrl.pathname.split("/").pop() || "unknown") &&
        call.endpoint === endpoint
      );
      if (index !== -1) {
        callStack.splice(index, 1);
      }
      
      // Record duration
      const duration = (Date.now() - start) / 1000;
      requestDuration.observe({ endpoint, method: req.method }, duration);
    }
  };
}

// Helper to get latest block number (simplified)
async function getLatestBlockNumber(): Promise<bigint> {
  // In a real implementation, this would query the blockchain
  // For now, return a mock value
  return BigInt(Date.now() / 1000); // Mock block number based on time
}

// Export metrics handler for route
export { metricsHandler };

// src/app/api/dex/agent/route.ts - Updated with behavior monitoring
import { NextRequest, NextResponse } from "next/server";
import { createBehaviorMonitor } from "@/lib/dex/behavior-monitor";

const behaviorMonitor = createBehaviorMonitor();

export async function POST(request: NextRequest) {
  // Apply behavioral monitoring
  await behaviorMonitor(request, "/api/dex/agent");
  
  // Original logic would go here
  // For now, return a placeholder
  return NextResponse.json({ status: "monitored" });
}

// src/app/api/dex/order/route.ts - Updated with behavior monitoring
import { NextRequest, NextResponse } from "next/server";
import { createBehaviorMonitor } from "@/lib/dex/behavior-monitor";

const behaviorMonitor = createBehaviorMonitor();

export async function POST(request: NextRequest) {
  // Apply behavioral monitoring
  await behaviorMonitor(request, "/api/dex/order");
  
  // Original logic would go here
  return NextResponse.json({ status: "monitored" });
}

// src/app/api/dex/swap/route.ts - Updated with behavior monitoring
import { NextRequest, NextResponse } from "next/server";
import { createBehaviorMonitor } from "@/lib/dex/behavior-monitor";

const behaviorMonitor = createBehaviorMonitor();

export async function POST(request: NextRequest) {
  // Apply behavioral monitoring
  await behaviorMonitor(request, "/api/dex/swap");
  
  // Original logic would go here
  return NextResponse.json({ status: "monitored" });
}

// src/app/api/dex/metrics/route.ts - New metrics endpoint
import { NextResponse } from "next/server";
import { metricsHandler } from "@/lib/dex/behavior-monitor";

export async function GET() {
  return metricsHandler();
}
