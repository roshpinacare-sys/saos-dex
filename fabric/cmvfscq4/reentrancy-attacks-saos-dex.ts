import { NextRequest, NextResponse } from 'next/server';

// טיפוסים עבור המערכת
type CallPattern = {
  contract: string;
  method: string;
  timestamp: number;
  depth: number;
};

type SuspiciousCall = {
  contract: string;
  method: string;
  timestamp: number;
  depth: number;
  reason: string;
};

// תצורת המערכת
const CONFIG = {
  maxDepth: 3,
  maxReentrancyAttempts: 5,
  timeWindowMs: 60000,
  alertThreshold: 3,
};

// מאחסן מידע על קריאות מתמשכות
const activeCalls = new Map<string, CallPattern[]>();
// מאחסן מידע על קריאות חשודות
const suspiciousCalls = new Map<string, SuspiciousCall[]>();

/**
 * מזהה קריאות חוזרות לחוזים חכמים
 * @param contract כתובת החוזה
 * @param method שם המתודה
 * @param timestamp חותמת זמן
 * @param depth עומק הקריאה
 * @returns אם הקריאה חשודה
 */
function detectReentrancy(
  contract: string,
  method: string,
  timestamp: number,
  depth: number
): boolean {
  if (depth > CONFIG.maxDepth) {
    return true; // עומק קריאה חריג
  }

  const callKey = `${contract}-${method}`;
  const patterns = activeCalls.get(callKey) || [];

  // מחפש קריאות דומות בחלון זמן
  const recentCalls = patterns.filter(
    (p) => timestamp - p.timestamp < CONFIG.timeWindowMs
  );

  if (recentCalls.length >= CONFIG.alertThreshold) {
    return true; // יותר מדי קריאות דומות
  }

  return false;
}

/**
 * רושם קריאה חדשה למערכת
 * @param contract כתובת החוזה
 * @param method שם המתודה
 * @param timestamp חותמת זמן
 * @param depth עומק הקריאה
 */
function logCall(
  contract: string,
  method: string,
  timestamp: number,
  depth: number
) {
  const callKey = `${contract}-${method}`;
  const patterns = activeCalls.get(callKey) || [];

  // הוסף קריאה חדשה
  patterns.push({
    contract,
    method,
    timestamp,
    depth,
  });

  // שמור רק קריאות מהתקופה האחרונה
  const recentCalls = patterns.filter(
    (p) => timestamp - p.timestamp < CONFIG.timeWindowMs
  );

  activeCalls.set(callKey, recentCalls);
}

/**
 * רושם קריאה חשודה
 * @param contract כתובת החוזה
 * @param method שם המתודה
 * @param timestamp חותמת זמן
 * @param depth עומק הקריאה
 * @param reason סיבת החשד
 */
function logSuspiciousCall(
  contract: string,
  method: string,
  timestamp: number,
  depth: number,
  reason: string
) {
  const callKey = `${contract}-${method}`;
  const suspicious = suspiciousCalls.get(callKey) || [];

  suspicious.push({
    contract,
    method,
    timestamp,
    depth,
    reason,
  });

  // שמור רק קריאות מהתקופה האחרונה
  const recentSuspicious = suspicious.filter(
    (s) => timestamp - s.timestamp < CONFIG.timeWindowMs
  );

  suspiciousCalls.set(callKey, recentSuspicious);
}

/**
 * בודק אם יש לחסום קריאה לפי דפוס הקריאות
 * @param contract כתובת החוזה
 * @param method שם המתודה
 * @returns אם לחסום את הקריאה
 */
function shouldBlockCall(contract: string, method: string): boolean {
  const callKey = `${contract}-${method}`;
  const suspicious = suspiciousCalls.get(callKey) || [];

  if (suspicious.length >= CONFIG.maxReentrancyAttempts) {
    return true;
  }

  return false;
}

/**
 * מטפל בקריאות API ומיישם את מנגנון הניטור
 */
export function middleware(request: NextRequest) {
  const url = request.nextUrl;
  
  // בדיקת נתיבים רלוונטיים ל-DEX
  if (!url.pathname.startsWith('/api/dex/')) {
    return NextResponse.next();
  }

  // קבלת נתונים מהקריאה (בפועל יש לקבל מהקריאה המקורית)
  const contract = url.searchParams.get('contract') || '';
  const method = url.searchParams.get('method') || '';
  const depth = parseInt(url.searchParams.get('depth') || '0', 10);
  
  const timestamp = Date.now();
  
  // רישום הקריאה
  logCall(contract, method, timestamp, depth);
  
  // בדיקת חשד ל-reentrancy
  const isSuspicious = detectReentrancy(contract, method, timestamp, depth);
  
  if (isSuspicious) {
    const reason = `חשד ל-reentrancy attack - עומק: ${depth}, קריאות דומות: ${activeCalls.get(`${contract}-${method}`)?.length || 0}`;
    logSuspiciousCall(contract, method, timestamp, depth, reason);
    
    // בדיקה אם יש לחסום
    if (shouldBlockCall(contract, method)) {
      return new NextResponse(
        JSON.stringify({ 
          error: 'Reentrancy attack detected - call blocked',
          reason,
          timestamp
        }),
        { 
          status: 403,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }
    
    // אם לא חסום, רק רישום והמשך
    console.warn(`[REENTRANCY WARNING] ${reason}`);
  }
  
  return NextResponse.next();
}

// ניתן להוסיף נקודות קצה לצפייה בנתוני הניטור
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type');
  
  if (type === 'active') {
    return NextResponse.json(Object.fromEntries(activeCalls));
  }
  
  if (type === 'suspicious') {
    return NextResponse.json(Object.fromEntries(suspiciousCalls));
  }
  
  return NextResponse.json({ 
    message: 'Specify type parameter: active or suspicious'
  });
}
