import { PrismaClient } from '@prisma/client';

// הגדרת תבנית URL מותרת למסד הנתונים
const DEX_DB_URL_REGEX = /^file:\/\/.*\/dex\.db(\?.*)?$/;

// פונקציית סניטציה לניקוי ואימות כתובת מסד הנתונים
function sanitizeAndValidateDbUrl(url: string): boolean {
  // הסרת פרטים רגישים כמו סיסמאות אם קיימים
  const cleanUrl = url.replace(/\/[^/]*:[^/]*@/, '/user:pass@');
  
  // בדיקה אם ה-URL תואם לתבנית המותרת
  if (!DEX_DB_URL_REGEX.test(cleanUrl)) {
    throw new Error(`כתובת מסד הנתונים לא חוקית: ${cleanUrl}`);
  }
  
  return true;
}

// פונקציה לבדיקת הרשאות מסד הנתונים
function checkDbPermissions(url: string): boolean {
  // בדיקה אם ה-URL מצביע על מסד הנתונים המותר בלבד
  if (!url.includes('dex.db')) {
    return false;
  }
  
  // בדיקה נוספת כדי למנוע גישה למסדי נתונים אחרים
  if (url.includes('custom.db') || url.includes('parent.db')) {
    return false;
  }
  
  return true;
}

// פונקציה להגדרת גישה מוגבלת למסד הנתונים
function createSecurePrismaClient(url: string): PrismaClient {
  // אימות וסניטציה של כתובת מסד הנתונים
  if (!sanitizeAndValidateDbUrl(url)) {
    throw new Error('כתובת מסד הנתונים עברה אימות כושל');
  }
  
  // בדיקת הרשאות
  if (!checkDbPermissions(url)) {
    throw new Error('הרשאות מסד הנתונים נדחו - גישה לא מורשת למסד נתונים זה');
  }
  
  // יצירת לקוח Prisma עם גישה מוגבלת
  return new PrismaClient({
    datasources: {
      db: {
        url,
      },
    },
    // הגבלת לוגים לשגיאות ואזהרות בלבד
    log: ['warn', 'error'],
  });
}

// קבלת כתובת מסד הנתונים מסביבה
const databaseUrl = process.env.DATABASE_URL ?? '';

// בדיקת קיום כתובת
if (!databaseUrl) {
  throw new Error('DATABASE_URL לא הוגדר בסביבה');
}

// ניסיון ליצור לקוח מאובטח
let db;
try {
  db = createSecurePrismaClient(databaseUrl);
} catch (error) {
  // טיפול בשגיאות אבטחה
  if (error instanceof Error) {
    throw new Error(`[saos-dex] גישה למסד הנתונים נדחתה: ${error.message}`);
  }
  throw error;
}

// ייצוא הלקוח המאובטח
export { db };

// פונקציית עזר לבדיקת התחברות מאובטחת
export async function testSecureConnection() {
  try {
    await db.$connect();
    return true;
  } catch (error) {
    console.error('שגיאה בהתחברות למסד הנתונים:', error);
    return false;
  }
}