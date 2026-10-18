import { NextRequest, NextResponse } from 'next/server';

// סוגים לטיפוס מפתחות סודיים
interface SecureKey {
  name: string;
  value: string;
  loaded: boolean;
  timestamp: number;
}

// חנות זיכרון זמנית למפתחות (בפועל תהיה במקום מוגן כמו encrypted disk/memory)
const secureKeyStore = new Map<string, SecureKey>();

// זמן חיים מרבי למפתח בזיכרון (5 שניות)
const KEY_LIFETIME_MS = 5000;

// רשימת מפתחות מותרים (בפועל תישלף מקונפיגורציה מוגנת)
const ALLOWED_KEYS = [
  'STEEM_ACTIVE_WIF',
  'HIVE_ACTIVE_WIF',
  'TRON_ACTIVE_PRIVATE_KEY',
  'ETH_ACTIVE_PRIVATE_KEY',
  'SOL_ACTIVE_PRIVATE_KEY'
];

// פונקציה לטעינת מפתח מהמאגר המוגן
function loadSecureKey(keyName: string): string | null {
  // בפועל, פה יהיה קריאה למנגנון אחסון מוגן (כמו Vault, KMS, או encrypted file)
  // לדוגמה, קריאה ממאגר מוגן:
  // const secureValue = secureStorage.get(keyName);
  
  // לצורך הדגמה - מדמים טעינה ממקור מוגן
  const envValue = process.env[keyName];
  if (!envValue) return null;
  
  // יצירת רשומת מפתח בחנות הזיכרון
  secureKeyStore.set(keyName, {
    name: keyName,
    value: envValue,
    loaded: true,
    timestamp: Date.now()
  });
  
  return envValue;
}

// פונקציה לניקוי מפתחות ישנים מהזיכרון
function cleanupExpiredKeys() {
  const now = Date.now();
  for (const [keyName, keyData] of secureKeyStore.entries()) {
    if (now - keyData.timestamp > KEY_LIFETIME_MS) {
      secureKeyStore.delete(keyName);
    }
  }
}

// פונקציה לקבלת מפתח בטוחה (טעינה + ניקוי אוטומטי)
export function getSecureKey(keyName: string): string | null {
  // בדיקת הרשאה
  if (!ALLOWED_KEYS.includes(keyName)) {
    console.error(`[${keyName}] Access denied - key not in allowlist`);
    return null;
  }
  
  // ניקוי מפתחות ישנים
  cleanupExpiredKeys();
  
  // ניסיון לקבל מהחנות הזמנית
  let keyData = secureKeyStore.get(keyName);
  
  // אם לא קיים או פג תוקף - טעינה מחדש
  if (!keyData || Date.now() - keyData.timestamp > KEY_LIFETIME_MS) {
    const value = loadSecureKey(keyName);
    return value;
  }
  
  return keyData.value;
}

// פונקציה לניקוי כל המפתחות מהזיכרון (לשימוש בסיום פעולה קריטית)
export function purgeAllKeys() {
  secureKeyStore.clear();
}

// מתווסף לקונפיגורציה של Next.js
export function middleware(req: NextRequest): NextResponse {
  // ניקוי רקעי של מפתחות ישנים
  cleanupExpiredKeys();
  
  // המשך לביצוע הרגיל של המידלוור
  return NextResponse.next();
}

// ייצוא לשימוש בקוד אחר
export { getSecureKey, purgeAllKeys, ALLOWED_KEYS };

// דוגמה לשימוש ב-instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // טעינת מפתחות סודיים בצורה מוגנת
    const steemWif = getSecureKey('STEEM_ACTIVE_WIF');
    const hiveWif = getSecureKey('HIVE_ACTIVE_WIF');
    
    if (!steemWif || !hiveWif) {
      console.error('Critical: Failed to load secure keys');
      // בפועל, כאן יהיה טיפול שגיאה קריטית
      return;
    }
    
    // שימוש במפתחות לפעולות רצויות
    try {
      const { ensureChain } = await import("@/lib/dex/chain");
      ensureChain();
      
      const { startMilestoneWatchdog } = await import("@/lib/dex/milestone");
      startMilestoneWatchdog();
      
      // לאחר השימוש, ניקוי הזיכרון
      purgeAllKeys();
    } catch (error) {
      console.error('Failed to initialize with secure keys:', error);
      purgeAllKeys();
    }
  }
}