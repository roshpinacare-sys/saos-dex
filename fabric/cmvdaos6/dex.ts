import { PrismaClient } from '@prisma/client';

// רשימת משתני הסביבה המורשים לשימוש ב-dex
const ALLOWED_ENV_VARS = [
  'DATABASE_URL',
  'SAOS_DEX_STATE_DIR',
  'HIVE_ANCHOR_ACCOUNT',
  'HIVE_ACTIVE_WIF',
  'NEXT_PUBLIC_API_BASE_URL',
  'NODE_ENV',
];

// סכימות אימות למשתני סביבה ספציפיים
const ENV_VALIDATIONS: Record<string, (value: string) => boolean> = {
  DATABASE_URL: (url) => {
    if (!url) return false;
    try {
      // בדיקה בסיסית לפורמט URL
      new URL(url);
      // ודא שה-URL מכיל 'dex.db' כדי למנוע גישה ל-DB אחר
      return /dex\.db(\?|$)/.test(url) && !/custom\.db/.test(url);
    } catch {
      return false;
    }
  },
  SAOS_DEX_STATE_DIR: (dir) => {
    if (!dir) return false;
    // ודא שהנתיב מתחיל ב '/' כדי למנוע ניסיונות גישה לנתיבים יחסיים
    return dir.startsWith('/') && !dir.includes('..');
  },
  HIVE_ACTIVE_WIF: (wif) => {
    if (!wif) return false;
    // בדיקת אורך בסיסית ל-WIF (מפתח פרטי של Hive)
    return wif.length >= 50 && wif.length <= 100;
  },
  NODE_ENV: (env) => ['development', 'production', 'test'].includes(env),
};

// פונקציית עזר לבדיקת תקינות משתנה סביבה
function validateEnvVar(name: string, value: string): boolean {
  const validator = ENV_VALIDATIONS[name];
  if (!validator) {
    // אם אין ולידטור ספציפי, נחזיר true עבור משתנים מורשים
    return ALLOWED_ENV_VARS.includes(name);
  }
  return validator(value);
}

// פונקציית עזר לבדיקת כל משתני הסביבה
function validateAllEnvVars(): void {
  const missingVars: string[] = [];
  const invalidVars: { name: string; reason: string }[] = [];

  // בדיקת משתנים נדרשים
  const requiredVars = ['DATABASE_URL', 'SAOS_DEX_STATE_DIR'];
  for (const varName of requiredVars) {
    if (!process.env[varName]) {
      missingVars.push(varName);
    }
  }

  // בדיקת תקינות כל המשתנים המורשים
  for (const varName of ALLOWED_ENV_VARS) {
    const value = process.env[varName];
    if (value && !validateEnvVar(varName, value)) {
      invalidVars.push({
        name: varName,
        reason: `ערך לא תקין: ${value}`,
      });
    }
  }

  // אם יש משתנים חסרים או לא תקינים, זרוק שגיאה
  if (missingVars.length > 0 || invalidVars.length > 0) {
    let errorMsg = 'שגיאה בהגדרות משתני הסביבה:\n';
    
    if (missingVars.length > 0) {
      errorMsg += `משתנים חסרים: ${missingVars.join(', ')}\n`;
    }
    
    if (invalidVars.length > 0) {
      errorMsg += 'משתנים לא תקינים:\n';
      for (const { name, reason } of invalidVars) {
        errorMsg += `- ${name}: ${reason}\n`;
      }
    }
    
    errorMsg += '\nאנא עדכן את קובץ ה-.env ונסה שוב.';
    
    throw new Error(errorMsg);
  }
}

// הפעלת האימות בטעינת המודול
validateAllEnvVars();

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db;