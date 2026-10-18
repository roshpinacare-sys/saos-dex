import { PrismaClient } from '@prisma/client';

// Define user roles with minimal required permissions
export enum UserRole {
  OPERATOR = 'operator',
  MAKER = 'maker',
  TAKER = 'taker',
  SYSTEM = 'system'
}

// Interface for database access requests
export interface DBAccessRequest {
  role: UserRole;
  operation: 'read' | 'write' | 'delete';
  table: string;
  recordId?: string;
  reason: string;
}

// Database access control middleware
export class DatabaseAccessControl {
  private prisma: PrismaClient;
  private accessLog: any[] = [];

  constructor() {
    this.prisma = new PrismaClient({
      log: ['warn', 'error'],
    });
  }

  /**
   * Check if a role has permission for a specific operation
   */
  private hasPermission(role: UserRole, operation: 'read' | 'write' | 'delete', table: string): boolean {
    const permissions: Record<UserRole, { read: string[]; write: string[]; delete: string[] }> = {
      [UserRole.OPERATOR]: {
        read: ['*'],
        write: ['*'],
        delete: ['*'],
      },
      [UserRole.MAKER]: {
        read: ['orders', 'pools', 'markets'],
        write: ['orders'],
        delete: ['orders'],
      },
      [UserRole.TAKER]: {
        read: ['orders', 'markets'],
        write: ['fills'],
        delete: [],
      },
      [UserRole.SYSTEM]: {
        read: ['state', 'logs'],
        write: ['state'],
        delete: ['logs'],
      },
    };

    const rolePermissions = permissions[role];
    
    if (rolePermissions.read.includes('*') && operation === 'read') return true;
    if (rolePermissions.write.includes('*') && operation === 'write') return true;
    if (rolePermissions.delete.includes('*') && operation === 'delete') return true;
    
    switch (operation) {
      case 'read':
        return rolePermissions.read.includes(table);
      case 'write':
        return rolePermissions.write.includes(table);
      case 'delete':
        return rolePermissions.delete.includes(table);
      default:
        return false;
    }
  }

  /**
   * Log database access attempts
   */
  private logAccess(request: DBAccessRequest, granted: boolean, details?: any) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      role: request.role,
      operation: request.operation,
      table: request.table,
      recordId: request.recordId,
      reason: request.reason,
      granted,
      details,
    };
    
    this.accessLog.push(logEntry);
    
    // In a real implementation, this would be stored in a dedicated audit table
    if (process.env.NODE_ENV !== 'production') {
      console.log('DB Access Log:', logEntry);
    }
  }

  /**
   * Secure database access method
   */
  async secureAccess<T>(
    request: DBAccessRequest,
    query: () => Promise<T>,
    fallback?: () => Promise<T>
  ): Promise<T | null> {
    // Check permissions
    const hasPermission = this.hasPermission(request.role, request.operation, request.table);
    
    if (!hasPermission) {
      this.logAccess(request, false, 'Permission denied');
      throw new Error(`Access denied: ${request.role} cannot ${request.operation} ${request.table}`);
    }

    // Execute query with error handling
    try {
      const result = await query();
      this.logAccess(request, true, 'Success');
      return result;
    } catch (error) {
      this.logAccess(request, false, `Query failed: ${error.message}`);
      
      if (fallback) {
        try {
          const fallbackResult = await fallback();
          this.logAccess(request, true, 'Fallback success');
          return fallbackResult;
        } catch (fallbackError) {
          this.logAccess(request, false, `Fallback failed: ${fallbackError.message}`);
          throw fallbackError;
        }
      }
      
      throw error;
    }
  }

  /**
   * Get access logs for auditing
   */
  getAccessLogs() {
    return [...this.accessLog];
  }
}

// Create singleton instance
export const dbAccessControl = new DatabaseAccessControl();

// Enhanced Prisma client with access control
export const securePrisma = {
  ...dbAccessControl.prisma,
  secureRead: async <T, P extends any>(
    role: UserRole,
    table: string,
    findUnique: (args: { where: P }) => Promise<T | null>,
    args: { where: P },
    reason: string,
    fallback?: () => Promise<T>
  ) => {
    return dbAccessControl.secureAccess<T>(
      { role, operation: 'read', table, recordId: String(args.where), reason },
      () => findUnique(args),
      fallback
    );
  },
  
  secureFindMany: async <T, P extends any>(
    role: UserRole,
    table: string,
    findMany: (args: P) => Promise<T[]>,
    args: P,
    reason: string
  ) => {
    return dbAccessControl.secureAccess<T[]>(
      { role, operation: 'read', table, reason },
      () => findMany(args)
    );
  },
  
  secureCreate: async <T, P extends any>(
    role: UserRole,
    table: string,
    create: (args: P) => Promise<T>,
    args: P,
    reason: string
  ) => {
    return dbAccessControl.secureAccess<T>(
      { role, operation: 'write', table, reason },
      () => create(args)
    );
  },
  
  secureUpdate: async <T, P extends any>(
    role: UserRole,
    table: string,
    update: (args: P) => Promise<T>,
    args: P,
    reason: string
  ) => {
    return dbAccessControl.secureAccess<T>(
      { role, operation: 'write', table, reason },
      () => update(args)
    );
  },
  
  secureDelete: async <T, P extends any>(
    role: UserRole,
    table: string,
    delete: (args: P) => Promise<T>,
    args: P,
    reason: string
  ) => {
    return dbAccessControl.secureAccess<T>(
      { role, operation: 'delete', table, reason },
      () => delete(args)
    );
  },
};

// Example usage in the existing db.ts file
const RAW_URL = process.env.DATABASE_URL ?? "";
const isDexOwnDb = /dex\.db(\?|$)/.test(RAW_URL) && !/custom\.db/.test(RAW_URL);

if (!isDexOwnDb) {
  const desc = RAW_URL === "" ? "(חסר — הגדר DATABASE_URL ב-.env של saos-dex)" : /dex\.db/.test(RAW_URL) ? "(dex.db-קיים-אך-לא-עבר-את-הסינון)" : /custom\.db/.test(RAW_URL) ? "(מצביע-על-האם-אסור)" : "(כתובת-לא-ידועה — לא-מוצגת)";
  throw new Error(
    `[saos-dex] DATABASE_URL נדחה (fail-closed): המנוע רשאי לגעת רק ב-dex.db שלו — ` +
      `קיבל: ${desc}`
  );
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;

// Middleware to ensure all DB access goes through the secure layer
export function secureDatabaseAccess() {
  // This would intercept all Prisma client calls
  // and route them through the access control layer
  // Implementation depends on Prisma's middleware capabilities
}
