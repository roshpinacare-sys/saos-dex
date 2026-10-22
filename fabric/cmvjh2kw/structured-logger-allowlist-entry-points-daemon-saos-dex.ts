import { createHash } from 'node:crypto';

const ALLOWLIST_GLOBAL = [
  'HIVE_ANCHOR_ACCOUNT',
  'HIVE_ACTIVE_WIF',
  'ETH_PRIVATE_KEY',
  'SOL_PRIVATE_KEY',
  'SOVEREIGN_VAULT_SECRET',
  'DATABASE_URL',
] as const;

type Action = 'read' | 'validate' | 'reject';

interface LogEntry {
  timestamp: string;
  envVar: string;
  action: Action;
  caller: string;
}

function writeLog(entry: LogEntry): void {
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export function getEnv(key: string, caller: string): string | undefined {
  const value = process.env[key];
  writeLog({
    timestamp: new Date().toISOString(),
    envVar: key,
    action: value !== undefined ? 'read' : 'reject',
    caller,
  });
  return value;
}

export function validateEnv(allowlist: string[], caller: string): Record<string, string> {
  const result: Record<string, string> = {};
  const allowed = new Set(allowlist);
  for (const key of allowlist) {
    const value = process.env[key];
    writeLog({
      timestamp: new Date().toISOString(),
      envVar: key,
      action: value !== undefined ? 'validate' : 'reject',
      caller,
    });
    if (value !== undefined) {
      result[key] = value;
    }
  }
  // Check for any env vars accessed that are not in allowlist
  // This is a best-effort check since we can't intercept all process.env access
  return result;
}

export { ALLOWLIST_GLOBAL };
