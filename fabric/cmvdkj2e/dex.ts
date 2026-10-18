import { NextRequest, NextResponse } from 'next/server';

// Types for our monitoring system
interface AccessAttempt {
  timestamp: number;
  endpoint: string;
}

interface IpData {
  attempts: AccessAttempt[];
  lastWarning: number | null;
}

// Configuration
const THRESHOLD = 100; // Number of attempts to trigger an alert
const WINDOW_MS = 60_000; // 1 minute sliding window
const CLEANUP_INTERVAL_MS = 5 * 60_000; // Cleanup old entries every 5 minutes
const MAX_IPS = 10_000; // Maximum number of IPs to track

// In-memory storage (in production, this would be a distributed cache)
const accessMap = new Map<string, IpData>();

// Cleanup function to remove old entries
function cleanupOldData() {
  const now = Date.now();
  for (const [ip, data] of accessMap.entries()) {
    // Remove attempts older than the window
    data.attempts = data.attempts.filter(
      attempt => now - attempt.timestamp < WINDOW_MS
    );
    
    // Remove IPs with no recent attempts and no active warnings
    if (data.attempts.length === 0 && (data.lastWarning === null || now - data.lastWarning > WINDOW_MS)) {
      accessMap.delete(ip);
    }
  }
}

// Set up periodic cleanup
setInterval(cleanupOldData, CLEANUP_INTERVAL_MS);

// Function to check for suspicious activity and trigger alerts
function checkAndAlert(ip: string, endpoint: string, currentCount: number) {
  const now = Date.now();
  const ipData = accessMap.get(ip);
  
  // Check if we should alert (threshold exceeded and not recently alerted for this IP)
  if (currentCount >= THRESHOLD && (!ipData || now - (ipData.lastWarning || 0) > WINDOW_MS)) {
    // Log warning (in production, this would go to your logging system)
    console.warn(`[SECURITY ALERT] Suspicious activity detected from IP: ${ip}`);
    console.warn(`Endpoint: ${endpoint}`);
    console.warn(`Attempt count in last minute: ${currentCount}`);
    
    // Update last warning time
    if (!ipData) {
      accessMap.set(ip, { attempts: [], lastWarning: now });
    } else {
      ipData.lastWarning = now;
    }
    
    // In a real implementation, you would send this to your monitoring system
    // For example:
    // monitoringService.alert('suspicious_ip_activity', { ip, endpoint, count: currentCount });
    
    return true;
  }
  
  return false;
}

// Middleware function
export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  
  // Skip monitoring for certain paths (like health checks)
  if (pathname.startsWith('/api/health') || pathname === '/favicon.ico') {
    return NextResponse.next();
  }
  
  // Get client IP
  const xff = req.headers.get('x-forwarded-for');
  const ip = xff ? xff.split(',')[0].trim() : req.headers.get('x-real-ip') || 'unknown';
  
  // Get current endpoint
  const endpoint = pathname;
  
  // Get current time
  const now = Date.now();
  
  // Get or create IP data
  let ipData = accessMap.get(ip);
  if (!ipData) {
    ipData = { attempts: [], lastWarning: null };
    accessMap.set(ip, ipData);
  }
  
  // Add current attempt
  ipData.attempts.push({ timestamp: now, endpoint });
  
  // Clean up old attempts for this IP
  ipData.attempts = ipData.attempts.filter(
    attempt => now - attempt.timestamp < WINDOW_MS
  );
  
  // Check for suspicious activity
  const currentCount = ipData.attempts.length;
  const alertTriggered = checkAndAlert(ip, endpoint, currentCount);
  
  // If we have too many IPs, clean up oldest entries
  if (accessMap.size > MAX_IPS) {
    const sortedEntries = Array.from(accessMap.entries()).sort(
      (a, b) => a[1].attempts[0].timestamp - b[1].attempts[0].timestamp
    );
    
    // Remove oldest 25% of entries
    const removeCount = Math.floor(sortedEntries.length * 0.25);
    for (let i = 0; i < removeCount; i++) {
      accessMap.delete(sortedEntries[i][0]);
    }
  }
  
  // Continue with the request
  return NextResponse.next();
}

// Configure which paths the middleware should run on
export const config = {
  matcher: [
    '/api/:path*',
    '/dashboard/:path*',
    '/trade/:path*',
  ],
};
