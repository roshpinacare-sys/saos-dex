import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomBytes } from 'crypto';

type UserActivity = {
  userId: string;
  ip: string;
  lastAction: number;
  actionCount: number;
  suspiciousFlags: {
    reentrancy: boolean;
    frontRunning: boolean;
    sandwichAttack: boolean;
    highFrequency: boolean;
  };
  transactions: {
    timestamp: number;
    amount: number;
    price: number;
    type: 'buy' | 'sell';
  }[];
};

// In-memory store for user activities (in production, use Redis or similar)
const userActivities = new Map<string, UserActivity>();
const recentTransactions = new Map<string, { timestamp: number; amount: number; price: number; type: 'buy' | 'sell' }[]>();

// Constants for detection thresholds
const REENTRANCY_THRESHOLD = 3; // Number of recursive calls in short time
const FRONT_RUNNING_TIME_WINDOW = 5000; // ms before a large trade
const FRONT_RUNNING_PRICE_THRESHOLD = 0.01; // 1% price increase
const SANDWICH_TIME_WINDOW = 10000; // ms between buy/sell pairs
const SANDWICH_PROFIT_THRESHOLD = 0.005; // 0.5% profit minimum
const HIGH_FREQUENCY_THRESHOLD = 10; // Actions per minute
const MONITORING_WINDOW = 60000; // ms to monitor user activity

/**
 * Detects potential reentrancy attacks by tracking recursive function calls
 * @param userId - Unique identifier for the user
 * @param functionName - Name of the function being called
 * @returns Whether a reentrancy attack is suspected
 */
function detectReentrancy(userId: string, functionName: string): boolean {
  const activity = userActivities.get(userId);
  if (!activity) return false;

  // In a real implementation, track call stack depth and recursive calls
  // For this example, we'll simulate detection by tracking rapid repeated calls
  const now = Date.now();
  if (now - activity.lastAction < 1000) { // Within 1 second
    activity.actionCount++;
    if (activity.actionCount > REENTRANCY_THRESHOLD) {
      activity.suspiciousFlags.reentrancy = true;
      return true;
    }
  } else {
    activity.actionCount = 1;
  }

  activity.lastAction = now;
  return false;
}

/**
 * Detects potential front-running by monitoring price movements before large trades
 * @param userId - Unique identifier for the user
 * @param transactionDetails - Details of the transaction being processed
 * @returns Whether front-running is suspected
 */
function detectFrontRunning(userId: string, transactionDetails: { amount: number; type: 'buy' | 'sell' }): boolean {
  const activity = userActivities.get(userId);
  if (!activity) return false;

  // Check for price movements before this transaction
  const now = Date.now();
  const recentTxs = recentTransactions.get(userId) || [];
  
  // Look for price movements in the time window before this transaction
  const relevantTxs = recentTxs.filter(tx => 
    now - tx.timestamp < FRONT_RUNNING_TIME_WINDOW && 
    tx.type !== transactionDetails.type
  );

  if (relevantTxs.length > 0) {
    // Calculate average price movement
    const priceChanges = relevantTxs.map(tx => {
      const prevTxs = recentTxs.filter(t => 
        tx.timestamp - t.timestamp < 5000 && t.type !== tx.type
      );
      
      if (prevTxs.length === 0) return 0;
      
      const avgPrevPrice = prevTxs.reduce((sum, t) => sum + t.price, 0) / prevTxs.length;
      return tx.price - avgPrevPrice;
    });
    
    const avgPriceChange = priceChanges.reduce((sum, change) => sum + change, 0) / priceChanges.length;
    
    if (Math.abs(avgPriceChange) / avgPriceChange > FRONT_RUNNING_PRICE_THRESHOLD) {
      activity.suspiciousFlags.frontRunning = true;
      return true;
    }
  }

  return false;
}

/**
 * Detects potential sandwich attacks by analyzing rapid buy/sell pairs
 * @param userId - Unique identifier for the user
 * @param transactionDetails - Details of the transaction being processed
 * @returns Whether a sandwich attack is suspected
 */
function detectSandwichAttack(userId: string, transactionDetails: { amount: number; price: number; type: 'buy' | 'sell' }): boolean {
  const activity = userActivities.get(userId);
  if (!activity) return false;

  const now = Date.now();
  const userTxs = recentTransactions.get(userId) || [];
  
  // Find transactions in the time window
  const recentTxs = userTxs.filter(tx => 
    now - tx.timestamp < SANDWICH_TIME_WINDOW
  );

  // Look for alternating buy/sell patterns
  let alternatingPattern = 0;
  let lastType: 'buy' | 'sell' | null = null;
  
  for (const tx of recentTxs) {
    if (lastType && lastType !== tx.type) {
      alternatingPattern++;
    }
    lastType = tx.type;
  }

  if (alternatingPattern >= 2) {
    // Check for profit patterns
    const buyTx = recentTxs.find(tx => tx.type === 'buy');
    const sellTx = recentTxs.find(tx => tx.type === 'sell');
    
    if (buyTx && sellTx && sellTx.price > buyTx.price * (1 + SANDWICH_PROFIT_THRESHOLD)) {
      activity.suspiciousFlags.sandwichAttack = true;
      return true;
    }
  }

  return false;
}

/**
 * Detects high-frequency trading patterns
 * @param userId - Unique identifier for the user
 * @returns Whether high-frequency trading is suspected
 */
function detectHighFrequency(userId: string): boolean {
  const activity = userActivities.get(userId);
  if (!activity) return false;

  const now = Date.now();
  const userTxs = recentTransactions.get(userId) || [];
  
  // Count transactions in the last minute
  const recentTxs = userTxs.filter(tx => 
    now - tx.timestamp < MONITORING_WINDOW
  );

  if (recentTxs.length > HIGH_FREQUENCY_THRESHOLD) {
    activity.suspiciousFlags.highFrequency = true;
    return true;
  }

  return false;
}

/**
 * Updates user activity with transaction details
 * @param userId - Unique identifier for the user
 * @param transactionDetails - Details of the transaction
 */
function updateUserActivity(userId: string, transactionDetails: { amount: number; price: number; type: 'buy' | 'sell' }) {
  let activity = userActivities.get(userId);
  
  if (!activity) {
    activity = {
      userId,
      ip: '', // Would be populated from request
      lastAction: Date.now(),
      actionCount: 0,
      suspiciousFlags: {
        reentrancy: false,
        frontRunning: false,
        sandwichAttack: false,
        highFrequency: false,
      },
      transactions: [],
    };
    userActivities.set(userId, activity);
  }

  // Add transaction to recent transactions
  let userTxs = recentTransactions.get(userId) || [];
  userTxs.push({
    timestamp: Date.now(),
    amount: transactionDetails.amount,
    price: transactionDetails.price,
    type: transactionDetails.type,
  });
  
  // Keep only recent transactions (last hour)
  const now = Date.now();
  userTxs = userTxs.filter(tx => now - tx.timestamp < 3600000);
  recentTransactions.set(userId, userTxs);
  
  // Add to activity's transaction history
  activity.transactions.push({
    timestamp: Date.now(),
    amount: transactionDetails.amount,
    price: transactionDetails.price,
    type: transactionDetails.type,
  });
}

/**
 * Generates a security report for a user
 * @param userId - Unique identifier for the user
 * @returns Security report with risk assessment
 */
function generateSecurityReport(userId: string): {
  userId: string;
  timestamp: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  flags: {
    reentrancy: boolean;
    frontRunning: boolean;
    sandwichAttack: boolean;
    highFrequency: boolean;
  };
  recommendations: string[];
} {
  const activity = userActivities.get(userId);
  if (!activity) {
    return {
      userId,
      timestamp: Date.now(),
      riskLevel: 'low',
      flags: {
        reentrancy: false,
        frontRunning: false,
        sandwichAttack: false,
        highFrequency: false,
      },
      recommendations: [],
    };
  }

  let riskLevel: 'low' | 'medium' | 'high' | 'critical' = 'low';
  const flags = activity.suspiciousFlags;
  const recommendations: string[] = [];

  // Calculate risk level based on flags
  if (flags.reentrancy) {
    riskLevel = riskLevel === 'critical' ? 'critical' : 'high';
    recommendations.push('Implement reentrancy guard in smart contracts');
  }

  if (flags.frontRunning) {
    riskLevel = riskLevel === 'critical' ? 'critical' : 'high';
    recommendations.push('Consider implementing commit-reveal schemes');
  }

  if (flags.sandwichAttack) {
    riskLevel = riskLevel === 'critical' ? 'critical' : 'high';
    recommendations.push('Implement batch auctions or time-based execution');
  }

  if (flags.highFrequency) {
    riskLevel = riskLevel === 'high' ? 'high' : 'medium';
    recommendations.push('Monitor for unusual trading patterns');
  }

  return {
    userId,
    timestamp: Date.now(),
    riskLevel,
    flags,
    recommendations,
  };
}

/**
 * Middleware function to detect suspicious activity
 * @param request - Next.js request object
 * @param next - Next.js next function
 * @returns Next.js response
 */
export async function securityMiddleware(request: NextRequest, next: () => Promise<NextResponse>) {
  // Extract user identifier (could be IP, session ID, or wallet address)
  const userId = request.headers.get('x-user-id') || 
                 request.ip || 
                 'anonymous';
  
  // Extract transaction details if present
  const transactionDetails = {
    amount: parseFloat(request.nextUrl.searchParams.get('amount') || '0'),
    price: parseFloat(request.nextUrl.searchParams.get('price') || '0'),
    type: (request.nextUrl.searchParams.get('type') || 'buy') as 'buy' | 'sell',
  };

  // Initialize user activity if not exists
  if (!userActivities.has(userId)) {
    userActivities.set(userId, {
      userId,
      ip: request.ip || '',
      lastAction: Date.now(),
      actionCount: 0,
      suspiciousFlags: {
        reentrancy: false,
        frontRunning: false,
        sandwichAttack: false,
        highFrequency: false,
      },
      transactions: [],
    });
  }

  // Detect suspicious activities
  const isReentrancy = detectReentrancy(userId, request.nextUrl.pathname);
  const isFrontRunning = transactionDetails.amount > 0 && detectFrontRunning(userId, transactionDetails);
  const isSandwichAttack = transactionDetails.amount > 0 && detectSandwichAttack(userId, transactionDetails);
  const isHighFrequency = detectHighFrequency(userId);

  // Update user activity
  updateUserActivity(userId, transactionDetails);

  // If any suspicious activity detected, log it
  if (isReentrancy || isFrontRunning || isSandwichAttack || isHighFrequency) {
    const report = generateSecurityReport(userId);
    
    // In production, send this to a security monitoring system
    console.log('Suspicious activity detected:', JSON.stringify(report, null, 2));
    
    // Add security headers to response
    const response = await next();
    response.headers.set('X-Security-Status', 'monitored');
    response.headers.set('X-Risk-Level', report.riskLevel);
    
    return response;
  }

  return await next();
}

/**
 * API endpoint to generate security reports
 * @param request - Next.js request object
 * @returns Next.js response with security report
 */
export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get('userId');
  
  if (!userId) {
    return NextResponse.json(
      { error: 'User ID is required' },
      { status: 400 }
    );
  }

  const report = generateSecurityReport(userId);
  return NextResponse.json(report);
}

/**
 * Unit tests for security detection mechanisms
 */
if (process.env.NODE_ENV === 'test') {
  // Mock user activity for testing
  const testUserId = 'test-user';
  
  // Test reentrancy detection
  function testReentrancyDetection() {
    // Simulate rapid function calls
    for (let i = 0; i < 5; i++) {
      detectReentrancy(testUserId, 'test-function');
    }
    
    const activity = userActivities.get(testUserId);
    const isSuspicious = activity?.suspiciousFlags.reentrancy || false;
    
    console.log(`Reentrancy detection test: ${isSuspicious ? 'PASSED' : 'FAILED'}`);
    return isSuspicious;
  }
  
  // Test front-running detection
  function testFrontRunningDetection() {
    // Simulate price movement before a large trade
    updateUserActivity(testUserId, { amount: 1000, price: 100, type: 'buy' });
    updateUserActivity(testUserId, { amount: 1000, price: 101, type: 'sell' });
    
    const isFrontRunning = detectFrontRunning(testUserId, { amount: 10000, type: 'buy' });
    
    console.log(`Front-running detection test: ${isFrontRunning ? 'PASSED' : 'FAILED'}`);
    return isFrontRunning;
  }
  
  // Test sandwich attack detection
  function testSandwichAttackDetection() {
    // Simulate sandwich attack pattern
    updateUserActivity(testUserId, { amount: 1000, price: 100, type: 'buy' });
    updateUserActivity(testUserId, { amount: 10000, price: 101, type: 'sell' });
    updateUserActivity(testUserId, { amount: 1000, price: 100.5, type: 'buy' });
    
    const isSandwichAttack = detectSandwichAttack(testUserId, { amount: 1000, price: 100, type: 'sell' });
    
    console.log(`Sandwich attack detection test: ${isSandwichAttack ? 'PASSED' : 'FAILED'}`);
    return isSandwichAttack;
  }
  
  // Test high-frequency trading detection
  function testHighFrequencyDetection() {
    // Simulate high-frequency trading
    for (let i = 0; i < 15; i++) {
      updateUserActivity(testUserId, { amount: 10, price: 100, type: i % 2 === 0 ? 'buy' : 'sell' });
    }
    
    const isHighFrequency = detectHighFrequency(testUserId);
    
    console.log(`High-frequency trading detection test: ${isHighFrequency ? 'PASSED' : 'FAILED'}`);
    return isHighFrequency;
  }
  
  // Run tests
  testReentrancyDetection();
  testFrontRunningDetection();
  testSandwichAttackDetection();
  testHighFrequencyDetection();
}
