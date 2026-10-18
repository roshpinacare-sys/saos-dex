import { PrismaClient } from '@prisma/client';

// רשימת משתני הסביבה המותרים
const ALLOWED_ENV_VARS = [
  'NEXT_PUBLIC_APP_NAME',
  'NEXT_PUBLIC_APP_VERSION',
  'DATABASE_URL',
  'NODE_ENV',
  'NEXT_RUNTIME',
  'SAOS_DEX_STATE_DIR'
];

// רשימת משתני הסביבה האסורים (רגישים)
const FORBIDDEN_ENV_VARS = [
  'API_KEY',
  'SECRET_KEY',
  'PRIVATE_KEY',
  'PASSWORD',
  'TOKEN',
  'WIF',
  'HIVE_ACTIVE_WIF',
  'HIVE_ANCHOR_ACCOUNT'
];

// בדיקת גישה למשתני סביבה
export function validateEnvironmentAccess(): void {
  const errors: string[] = [];
  
  // בדיקת משתנים אסורים
  FORBIDDEN_ENV_VARS.forEach(varName => {
    if (process.env[varName]) {
      errors.push(`Forbidden environment variable accessed: ${varName}`);
    }
  });
  
  // בדיקת גישה למשתנים שאינם ברשימה המותרת
  Object.keys(process.env).forEach(varName => {
    if (!ALLOWED_ENV_VARS.includes(varName) && !FORBIDDEN_ENV_VARS.includes(varName)) {
      errors.push(`Unauthorized environment variable accessed: ${varName}`);
    }
  });
  
  if (errors.length > 0) {
    throw new Error(`Environment validation failed:\n${errors.join('\n')}`);
  }
}

// גרסה מאובטחת של PrismaClient עם אימות סביבה
export function createSecurePrismaClient(): PrismaClient {
  validateEnvironmentAccess();
  
  const RAW_URL = process.env.DATABASE_URL ?? '';
  const isDexOwnDb = /dex\.db(\?|$)/.test(RAW_URL) && !/custom\.db/.test(RAW_URL);
  
  if (!isDexOwnDb) {
    const desc = RAW_URL === '' 
      ? '(חסר — הגדר DATABASE_URL ב-.env של saos-dex)' 
      : /dex\.db/.test(RAW_URL) 
        ? '(dex.db-קיים-אך-לא-עבר-את-הסינון)' 
        : /custom\.db/.test(RAW_URL) 
          ? '(מצביע-על-האם-אסור)' 
          : '(כתובת-לא-ידועה — לא-מוצגת)';
    
    throw new Error(
      `[saos-dex] DATABASE_URL נדחה (fail-closed): המנוע רשאי לגעת רק ב-dex.db שלו — ` +
      `קיבל: ${desc}`
    );
  }
  
  const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
  
  return globalForPrisma.prisma ?? new PrismaClient({
    log: ['warn', 'error'],
  });
}

// הגנה על גישה למשתני סביבה ברגע הגישה
export function secureEnvAccess(varName: string): string | undefined {
  if (FORBIDDEN_ENV_VARS.includes(varName)) {
    throw new Error(`Access to forbidden environment variable: ${varName}`);
  }
  
  if (!ALLOWED_ENV_VARS.includes(varName)) {
    throw new Error(`Unauthorized environment variable access: ${varName}`);
  }
  
  return process.env[varName];
}

// פונקציית האימות לשימוש בקובץ db.ts המקורי
export function validateDatabaseUrl(): void {
  validateEnvironmentAccess();
  
  const RAW_URL = process.env.DATABASE_URL ?? '';
  const isDexOwnDb = /dex\.db(\?|$)/.test(RAW_URL) && !/custom\.db/.test(RAW_URL);
  
  if (!isDexOwnDb) {
    const desc = RAW_URL === '' 
      ? '(חסר — הגדר DATABASE_URL ב-.env של saos-dex)' 
      : /dex\.db/.test(RAW_URL) 
        ? '(dex.db-קיים-אך-לא-עבר-את-הסינון)' 
        : /custom\.db/.test(RAW_URL) 
          ? '(מצביע-על-האם-אסור)' 
          : '(כתובת-לא-ידועה — לא-מוצגת)';
    
    throw new Error(
      `[saos-dex] DATABASE_URL נדחה (fail-closed): המנוע רשאי לגעת רק ב-dex.db שלו — ` +
      `קיבל: ${desc}`
    );
  }
}
