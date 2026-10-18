import { PrismaClient } from '@prisma/client';

// Define roles and permissions
const ROLES = {
  SYSTEM: 'system',
  OPERATOR: 'operator',
  READONLY: 'readonly'
} as const;

type Role = keyof typeof ROLES;

interface Permission {
  action: 'create' | 'read' | 'update' | 'delete';
  model: string;
}

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  SYSTEM: [
    { action: 'create', model: 'any' },
    { action: 'read', model: 'any' },
    { action: 'update', model: 'any' },
    { action: 'delete', model: 'any' }
  ],
  OPERATOR: [
    { action: 'create', model: 'Order' },
    { action: 'create', model: 'Trade' },
    { action: 'create', model: 'Pool' },
    { action: 'read', model: 'any' },
    { action: 'update', model: 'Order' },
    { action: 'update', model: 'Trade' },
    { action: 'update', model: 'Pool' },
    { action: 'delete', model: 'Order' },
    { action: 'delete', model: 'Trade' }
  ],
  READONLY: [
    { action: 'read', model: 'any' }
  ]
};

interface AccessLog {
  timestamp: Date;
  role: Role;
  model: string;
  action: 'create' | 'read' | 'update' | 'delete';
  success: boolean;
  details?: string;
}

const accessLogs: AccessLog[] = [];

function logAccess(role: Role, model: string, action: 'create' | 'read' | 'update' | 'delete', success: boolean, details?: string): void {
  accessLogs.push({
    timestamp: new Date(),
    role,
    model,
    action,
    success,
    details
  });
}

function hasPermission(role: Role, action: 'create' | 'read' | 'update' | 'delete', model: string): boolean {
  const permissions = ROLE_PERMISSIONS[role];
  return permissions.some(perm => 
    perm.action === action && (perm.model === 'any' || perm.model === model)
  );
}

// FIX(Roast-68 · db-scope-guard): נזק-חי-מתועד — תהליך-שירש-את-DATABASE_URL-של-הפלטפורמה-האם
// פתח-את-השרשרא בתוך-db/custom.db-של-האם (בעקיפין-את-.env-של-האם) והשמיד-את-טבלאות-הכספת.
// מעתה: המנוע-מסרב-לעלות-אם-כתובת-ה-DB-אינה-dex.db-שלו-עצמו (fail-closed ב-boot).
const RAW_URL = process.env.DATABASE_URL ?? '';
const isDexOwnDb = /dex\.db(\?|$)/.test(RAW_URL) && !/custom\.db/.test(RAW_URL);
if (!isDexOwnDb) {
  // FIX(R16-a·m7): השגיאה הדפיסה את RAW_URL-הגולמי — URL-שגוי שמצביע-על-DB-אחר
  // (עם-credentials-מוטבעים user:pass@host) היה נשפך ללוגים/קריסת-בוט. עתה:
  // תיאור-מסנן-בלבד (חסר/לא-דקס/לא-ידוע) — בלי-גוף-הכתובת.
  const desc = RAW_URL === '' ? '(חסר — הגדר DATABASE_URL ב-.env של saos-dex)' : /dex\.db/.test(RAW_URL) ? '(dex.db-קיים-אך-לא-עבר-את-הסינון)' : /custom\.db/.test(RAW_URL) ? '(מצביע-על-האם-אסור)' : '(כתובת-לא-ידועה — לא-מוצגת)';
  throw new Error(
    `[saos-dex] DATABASE_URL נדחה (fail-closed): המנוע רשאי לגעת רק ב-dex.db שלו — ` +
      `קיבל: ${desc}`
  );
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// Create a wrapper with role-based access control
const createDbClient = (role: Role = 'OPERATOR') => {
  const prisma = globalForPrisma.prisma ?? new PrismaClient({
    log: ['warn', 'error'],
  });

  // Create a proxy to intercept all Prisma operations
  return new Proxy(prisma, {
    get(target, prop) {
      // Get the original method
      const originalMethod = target[prop as keyof typeof target];

      // If it's not a function, return it as is
      if (typeof originalMethod !== 'function') {
        return originalMethod;
      }

      // Return a wrapped function with permission checks
      return async (...args: any[]) => {
        // Extract model and action from the method call
        const model = prop.toString().charAt(0).toUpperCase() + prop.toString().slice(1);
        let action: 'create' | 'read' | 'update' | 'delete' = 'read';

        if (model.includes('create') || model.includes('Create')) {
          action = 'create';
        } else if (model.includes('update') || model.includes('Update')) {
          action = 'update';
        } else if (model.includes('delete') || model.includes('Delete')) {
          action = 'delete';
        }

        // Check permissions
        if (!hasPermission(role, action, model)) {
          logAccess(role, model, action, false, 'Permission denied');
          throw new Error(`Access denied: ${role} role cannot ${action} ${model}`);
        }

        // Log the attempt
        logAccess(role, model, action, true);

        // Execute the original method
        return originalMethod.apply(target, args);
      };
    }
  });
};

// Default role for the DEX process
export const db = createDbClient('OPERATOR');

// Export function to change role if needed
export function setDbRole(role: Role): void {
  if (globalForPrisma.prisma) {
    const newDb = createDbClient(role);
    Object.assign(db, newDb);
  }
}

// Export function to get access logs
export function getAccessLogs(): AccessLog[] {
  return [...accessLogs];
}

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = db;
}
