import { NextRequest, NextResponse } from 'next/server';

// מפתחות סודיים שהוסרו לגמרי מהקוד
const SECRET_KEYS = [
  'STEEM_ACTIVE_WIF',
  'HIVE_ACTIVE_WIF',
  'TRON_ACTIVE_PRIVATE_KEY',
  'ETH_ACTIVE_PRIVATE_KEY',
  'SOL_ACTIVE_PRIVATE_KEY',
  'DEX_MASTER_KEY'
];

// ממשק API מאובטח לטעינת מפתחות
async function fetchSecureKeys(): Promise<Record<string, string>> {
  try {
    // במקום מפתחות קשיחים, נטען מממשק API מאובטח
    const response = await fetch(`${process.env.INTERNAL_API_BASE}/api/security/keys`, {
      headers: {
        'Authorization': `Bearer ${process.env.INTERNAL_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      method: 'GET'
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch secure keys: ${response.statusText}`);
    }
    
    const data = await response.json();
    return data.keys || {};
  } catch (error) {
    console.error('Error fetching secure keys:', error);
    // במקרה של כשל, נחזיר אובייקט ריק כדי לא לחשוף מידע
    return {};
  }
}

// פונקציית עזר לאימות גישה למפתחות
function hasAccessToKey(keyName: string): boolean {
  // כאן יכול להיות לוגיקה מורכבת לבדיקת הרשאות
  // לדוגמה: בדיקת תפקיד המשתמש, IP, זמן גישה וכו'
  return process.env.USER_ROLE === 'admin';
}

// פונקציה להצפנת מפתחות לפני אחסון
function encryptKey(key: string): string {
  // במערכת ממשית, כאן יהיה מנגנון הצפנה חזק
  // לדוגמה: AES-256 עם מפתח מנהל מערכת
  return Buffer.from(key).toString('base64');
}

// פונקציה לפענוח מפתחות
function decryptKey(encryptedKey: string): string {
  // במערכת ממשית, כאן יהיה מנגנון פענוח מתאים
  return Buffer.from(encryptedKey, 'base64').toString('utf-8');
}

// מטפל לניהול מפתחות בזמן ריצה
export class SecureKeyManager {
  private static instance: SecureKeyManager;
  private keys: Record<string, string> = {};
  
  private constructor() {}
  
  public static getInstance(): SecureKeyManager {
    if (!SecureKeyManager.instance) {
      SecureKeyManager.instance = new SecureKeyManager();
    }
    return SecureKeyManager.instance;
  }
  
  public async initialize(): Promise<void> {
    // טעינת מפתחות באופן מאובטח בעת אתחול האפליקציה
    this.keys = await fetchSecureKeys();
  }
  
  public getKey(keyName: string): string | null {
    // בדיקת הרשאות לפני מתן גישה למפתח
    if (!hasAccessToKey(keyName)) {
      console.error(`Access denied to key: ${keyName}`);
      return null;
    }
    
    const encryptedKey = this.keys[keyName];
    if (!encryptedKey) {
      console.error(`Key not found: ${keyName}`);
      return null;
    }
    
    return decryptKey(encryptedKey);
  }
  
  public setKey(keyName: string, keyValue: string): void {
    if (!hasAccessToKey(keyName)) {
      throw new Error(`Access denied to set key: ${keyName}`);
    }
    
    this.keys[keyName] = encryptKey(keyValue);
  }
}

// פונקציית עזר לבדיקת נוכחות מפתחות סודיים
function containsSecretKeys(obj: Record<string, any>): boolean {
  return Object.keys(obj).some(key => 
    SECRET_KEYS.includes(key) || 
    (typeof obj[key] === 'string' && obj[key].includes('PRIVATE_KEY'))
  );
}

// מגני גישה למשתני סביבה
export function secureEnvironmentVariables(): Record<string, string> {
  const env = { ...process.env };
  
  // הסרת כל המפתחות הסודיים
  SECRET_KEYS.forEach(key => {
    delete env[key];
  });
  
  return env;
}

// API route לניהול מפתחות (למשתמשים מורשים בלבד)
export async function POST(request: NextRequest) {
  try {
    // בדיקת הרשאות
    const authHeader = request.headers.get('authorization');
    if (!authHeader || authHeader !== `Bearer ${process.env.INTERNAL_API_TOKEN}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    
    const { action, keyName, keyValue } = await request.json();
    
    const keyManager = SecureKeyManager.getInstance();
    
    switch (action) {
      case 'get':
        const key = keyManager.getKey(keyName);
        return NextResponse.json({ key });
        
      case 'set':
        if (!keyName || !keyValue) {
          return NextResponse.json({ error: 'Missing key name or value' }, { status: 400 });
        }
        keyManager.setKey(keyName, keyValue);
        return NextResponse.json({ success: true });
        
      case 'initialize':
        await keyManager.initialize();
        return NextResponse.json({ success: true });
        
      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (error) {
    console.error('Key management error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ייצוא של מנהל המפתחות לשימוש במערכת
export const keyManager = SecureKeyManager.getInstance();

// הסרה מלאה של מפתחות מהקובץ instrumentation.ts
// במקום זאת, נשתמש במנהל המפתחות המאובטח
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { ensureChain } = await import("@/lib/dex/chain");
    ensureChain();
    const { startMilestoneWatchdog } = await import("@/lib/dex/milestone");
    startMilestoneWatchdog();
    
    // אתחול מנהל המפתחות המאובטח
    await keyManager.initialize();
  }
}

// בדיקה שלא נשארו מפתחות סודיים בקוד
if (containsSecretKeys(process.env)) {
  console.error('WARNING: Secret keys found in environment variables!');
  // במערכת ממשית, כאן יהיה טיפול חמור יותר
  // כגון כיבוי השרת או דיווח חריגה
}
