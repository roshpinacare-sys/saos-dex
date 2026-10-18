import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'audit';
type LogEntry = {
  id: string;
  timestamp: Date;
  level: LogLevel;
  sessionId?: string;
  userId?: string;
  ip: string;
  userAgent?: string;
  method: string;
  url: string;
  statusCode?: number;
  duration?: number;
  headers?: Record<string, string>;
  body?: string;
  transaction?: {
    type: string;
    amount?: number;
    currency?: string;
    fromAddress?: string;
    toAddress?: string;
    txHash?: string;
  };
  message: string;
  metadata?: Record<string, unknown>;
};

// Configuration for logging levels
const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  audit: 4,
};

// Current logging level (can be changed at runtime)
let currentLogLevel: LogLevel = 'info';

// Configuration for transaction thresholds
const TRANSACTION_THRESHOLD = 10000; // $10,000

// Function to hash sensitive data
function hashData(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

// Function to check if a request should be logged based on criteria
function shouldLogRequest(req: NextRequest, level: LogLevel): boolean {
  // Always audit transactions above threshold
  if (level === 'audit') return true;
  
  // Log errors and warnings
  if (level === 'error' || level === 'warn') return true;
  
  // Log info requests (can be filtered further)
  if (level === 'info') {
    // Example: Log all API requests
    return req.nextUrl.pathname.startsWith('/api/dex');
  }
  
  // Debug level can be more selective
  if (level === 'debug') {
    // Example: Log specific paths
    return req.nextUrl.pathname.includes('/debug');
  }
  
  return false;
}

// Function to extract transaction details from request
function extractTransactionDetails(req: NextRequest): LogEntry['transaction'] | undefined {
  try {
    const body = req.clone().body;
    if (!body) return undefined;
    
    const text = body.toString();
    const json = JSON.parse(text);
    
    // Check if this is a transaction request
    if (json.type === 'transaction' || json.action === 'swap' || json.action === 'transfer') {
      return {
        type: json.type || json.action,
        amount: json.amount || json.value,
        currency: json.currency || json.token,
        fromAddress: json.from || json.sender,
        toAddress: json.to || json.recipient,
        txHash: json.txHash || json.hash,
      };
    }
    
    return undefined;
  } catch (e) {
    return undefined;
  }
}

// Function to log an entry
async function logEntry(entry: Omit<LogEntry, 'id' | 'timestamp'>): Promise<void> {
  const logEntry: LogEntry = {
    ...entry,
    id: uuidv4(),
    timestamp: new Date(),
  };
  
  try {
    // In a real implementation, we would save this to the database
    // For now, we'll just log to console
    console.log(`[${logEntry.timestamp.toISOString()}] [${logEntry.level.toUpperCase()}]`, logEntry);
    
    // Save to database
    await db.auditLog.create({
      data: {
        id: logEntry.id,
        timestamp: logEntry.timestamp,
        level: logEntry.level,
        sessionId: logEntry.sessionId,
        userId: logEntry.userId,
        ip: logEntry.ip,
        userAgent: logEntry.userAgent,
        method: logEntry.method,
        url: logEntry.url,
        statusCode: logEntry.statusCode,
        duration: logEntry.duration,
        headers: logEntry.headers ? JSON.stringify(logEntry.headers) : null,
        body: logEntry.body,
        transaction: logEntry.transaction ? JSON.stringify(logEntry.transaction) : null,
        message: logEntry.message,
        metadata: logEntry.metadata ? JSON.stringify(logEntry.metadata) : null,
      },
    });
  } catch (error) {
    console.error('Failed to save log entry:', error);
  }
}

// Middleware function for enhanced logging
export async function enhancedLoggingMiddleware(req: NextRequest): Promise<NextResponse | null> {
  const startTime = Date.now();
  const ip = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
  const userAgent = req.headers.get('user-agent');
  
  // Extract session ID if available
  const sessionId = req.cookies.get('sessionId')?.value || uuidv4();
  
  // Extract user ID if available
  const userId = req.headers.get('x-user-id') || 'anonymous';
  
  // Clone request to read body
  const clonedReq = req.clone();
  
  try {
    // Read request body
    const body = await clonedReq.text();
    
    // Extract transaction details
    const transaction = extractTransactionDetails(clonedReq);
    
    // Determine log level based on content
    let logLevel: LogLevel = 'info';
    
    if (transaction && transaction.amount && transaction.amount >= TRANSACTION_THRESHOLD) {
      logLevel = 'audit';
    } else if (clonedReq.nextUrl.pathname.includes('/api/dex/security') || 
               clonedReq.nextUrl.pathname.includes('/api/dex/auth')) {
      logLevel = 'warn';
    }
    
    // Check if we should log this request
    if (shouldLogRequest(clonedReq, logLevel)) {
      // Create log entry
      const logEntry: Omit<LogEntry, 'id' | 'timestamp'> = {
        level: logLevel,
        sessionId,
        userId,
        ip,
        userAgent,
        method: clonedReq.method,
        url: clonedReq.nextUrl.toString(),
        headers: Object.fromEntries(clonedReq.headers.entries()),
        body,
        transaction,
        message: `Request processed: ${clonedReq.method} ${clonedReq.nextUrl.pathname}`,
        metadata: {
          userAgent,
          referer: clonedReq.headers.get('referer'),
        },
      };
      
      // Log the request
      await logEntry(logEntry);
    }
    
    // Continue with the request
    const response = NextResponse.next();
    
    // Log the response
    const endTime = Date.now();
    const duration = endTime - startTime;
    
    if (shouldLogResponse(response, logLevel)) {
      const responseLogEntry: Omit<LogEntry, 'id' | 'timestamp'> = {
        level: logLevel,
        sessionId,
        userId,
        ip,
        userAgent,
        method: clonedReq.method,
        url: clonedReq.nextUrl.toString(),
        statusCode: response.status,
        duration,
        message: `Response: ${response.status} ${clonedReq.method} ${clonedReq.nextUrl.pathname}`,
        metadata: {
          responseTime: duration,
          contentLength: response.headers.get('content-length'),
        },
      };
      
      // Log the response
      await logEntry(responseLogEntry);
    }
    
    return response;
  } catch (error) {
    // Log error
    await logEntry({
      level: 'error',
      sessionId,
      userId,
      ip,
      userAgent,
      method: clonedReq.method,
      url: clonedReq.nextUrl.toString(),
      message: `Error processing request: ${error instanceof Error ? error.message : 'Unknown error'}`,
      metadata: { error },
    });
    
    // Return error response
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}

// Function to check if a response should be logged
function shouldLogResponse(response: NextResponse, level: LogLevel): boolean {
  // Always log errors
  if (response.status >= 400) return true;
  
  // Log based on level
  if (LOG_LEVELS[level] >= LOG_LEVELS['info']) return true;
  
  return false;
}

// Function to set logging level at runtime
export function setLogLevel(level: LogLevel): void {
  if (LOG_LEVELS[level] !== undefined) {
    currentLogLevel = level;
    console.log(`Logging level set to: ${level}`);
  }
}

// Function to get current logging level
export function getLogLevel(): LogLevel {
  return currentLogLevel;
}

// Function to query audit logs
export async function getAuditLogs(filters: {
  level?: LogLevel;
  startDate?: Date;
  endDate?: Date;
  userId?: string;
  ip?: string;
  sessionId?: string;
  url?: string;
}): Promise<LogEntry[]> {
  try {
    const whereClause: any = {};
    
    if (filters.level) whereClause.level = filters.level;
    if (filters.userId) whereClause.userId = filters.userId;
    if (filters.ip) whereClause.ip = filters.ip;
    if (filters.sessionId) whereClause.sessionId = filters.sessionId;
    if (filters.url) whereClause.url = { contains: filters.url };
    if (filters.startDate || filters.endDate) {
      whereClause.timestamp = {};
      if (filters.startDate) whereClause.timestamp.gte = filters.startDate;
      if (filters.endDate) whereClause.timestamp.lte = filters.endDate;
    }
    
    const logs = await db.auditLog.findMany({
      where: whereClause,
      orderBy: { timestamp: 'desc' },
      take: 1000, // Limit to prevent excessive data retrieval
    });
    
    return logs.map(log => ({
      id: log.id,
      timestamp: log.timestamp,
      level: log.level,
      sessionId: log.sessionId,
      userId: log.userId,
      ip: log.ip,
      userAgent: log.userAgent,
      method: log.method,
      url: log.url,
      statusCode: log.statusCode,
      duration: log.duration,
      headers: log.headers ? JSON.parse(log.headers) : undefined,
      body: log.body,
      transaction: log.transaction ? JSON.parse(log.transaction) : undefined,
      message: log.message,
      metadata: log.metadata ? JSON.parse(log.metadata) : undefined,
    }));
  } catch (error) {
    console.error('Failed to retrieve audit logs:', error);
    return [];
  }
}

// Prisma model for audit logs (add to schema.prisma)
/*
model AuditLog {
  id          String   @id @default(cuid())
  timestamp   DateTime
  level       LogLevel
  sessionId   String?
  userId      String?
  ip          String
  userAgent   String?
  method      String
  url         String
  statusCode  Int?
  duration    Int?
  headers     String?
  body        String?
  transaction String?
  message     String
  metadata    String?
}

enum LogLevel {
  DEBUG
  INFO
  WARN
  ERROR
  AUDIT
}
*/