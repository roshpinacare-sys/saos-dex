import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LOG_DIR = process.env.SAOS_SECURITY_LOG_DIR ?? `${__dirname}/../../../logs/security`;
const LOG_FILE = `${LOG_DIR}/security-events.jsonl`;

if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}

export interface SecurityEvent {
  key_id: string;
  operation: 'sign' | 'verify' | 'derive' | 'import_wif' | 'check_permission' | 'rotate' | 'get_master';
  chain: string;
  result: 'success' | 'failure';
  error_code?: string;
  duration_ms: number;
  timestamp: string;
  request_id?: string;
  metadata?: Record<string, unknown>;
}

function generateKeyId(material: string | Uint8Array): string {
  const hash = createHash('sha256');
  hash.update(material instanceof Uint8Array ? material : Buffer.from(material));
  return `key_${hash.digest('hex').slice(0, 16)}`;
}

function generateRequestId(): string {
  return `req_${randomBytes(8).toString('hex')}`;
}

let requestIdContext: string | undefined;

export function setRequestId(id: string): void {
  requestIdContext = id;
}

export function clearRequestId(): void {
  requestIdContext = undefined;
}

export function getRequestId(): string | undefined {
  return requestIdContext;
}

export async function logSecurityEvent(
  event: Omit<SecurityEvent, 'timestamp' | 'request_id'> & { request_id?: string }
): Promise<void> {
  const fullEvent: SecurityEvent = {
    ...event,
    timestamp: new Date().toISOString(),
    request_id: event.request_id ?? requestIdContext,
  };

  const line = JSON.stringify(fullEvent) + '\n';
  
  try {
    appendFileSync(LOG_FILE, line);
  } catch (err) {
    console.error('[security-logger] Failed to write security event:', err);
  }
}

export function withSecurityLogging<T>(
  keyId: string,
  operation: SecurityEvent['operation'],
  chain: string,
  fn: () => Promise<T>,
  metadata?: Record<string, unknown>
): Promise<T> {
  const start = process.hrtime.bigint();
  const requestId = generateRequestId();
  
  return fn()
    .then((result) => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      logSecurityEvent({
        key_id: keyId,
        operation,
        chain,
        result: 'success',
        duration_ms: durationMs,
        request_id: requestId,
        metadata,
      });
      return result;
    })
    .catch((error) => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      logSecurityEvent({
        key_id: keyId,
        operation,
        chain,
        result: 'failure',
        error_code: error?.code ?? 'UNKNOWN_ERROR',
        duration_ms: durationMs,
        request_id: requestId,
        metadata: { ...metadata, error_message: error?.message },
      });
      throw error;
    });
}

export function withSecurityLoggingSync<T>(
  keyId: string,
  operation: SecurityEvent['operation'],
  chain: string,
  fn: () => T,
  metadata?: Record<string, unknown>
): T {
  const start = process.hrtime.bigint();
  const requestId = generateRequestId();
  
  try {
    const result = fn();
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    logSecurityEvent({
      key_id: keyId,
      operation,
      chain,
      result: 'success',
      duration_ms: durationMs,
      request_id: requestId,
      metadata,
    });
    return result;
  } catch (error) {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    logSecurityEvent({
      key_id: keyId,
      operation,
      chain,
      result: 'failure',
      error_code: error?.code ?? 'UNKNOWN_ERROR',
      duration_ms: durationMs,
      request_id: requestId,
      metadata: { ...metadata, error_message: error?.message },
    });
    throw error;
  }
}
