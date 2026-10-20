import { v4 as uuidv4 } from 'uuid';
import { alertDatabaseConnectionFailure } from './alert';
import { createHash } from 'node:crypto';

/**
 * Unified DB boot failure notification with correlation ID.
 * Policy: try control-center POST first (if configured), then always persist locally via alert.ts.
 * Both channels receive the same correlation_id for traceability.
 * Fail-open: any channel failure is logged but never throws.
 */
export async function notifyDbBootFailure(
  error: Error | string,
  context: {
    timestamp: string;
    errorType: string;
    description: string;
    severity: 'WARNING' | 'CRITICAL';
    rawUrl?: string;
  }
): Promise<{ correlationId: string; channels: { controlCenter: boolean; local: boolean } }> {
  const correlationId = uuidv4();
  const payload = {
    correlation_id: correlationId,
    event_type: 'unauthorized_database_connection_attempt',
    at: context.timestamp,
    service_id: 'saos-dex',
    error_type: context.errorType,
    description: context.description,
    severity: context.severity,
    url_hint: context.rawUrl
      ? createHash('sha256').update(context.rawUrl).digest('hex').slice(0, 12)
      : undefined,
  };

  let controlCenterOk = false;
  let localOk = false;

  // Channel 1: Control Center POST (if configured)
  const base = process.env.SAOS_CONTROL_CENTER_URL;
  if (base) {
    try {
      const res = await fetch(`${base}/api/alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(3000),
      });
      controlCenterOk = res.ok;
      if (!res.ok) {
        console.warn(`[${context.timestamp}] CONTROL_CENTER_ALERT_FAILED: ${res.status} ${res.statusText} (correlation_id: ${correlationId})`);
      }
    } catch (e) {
      console.warn(`[${context.timestamp}] CONTROL_CENTER_ALERT_ERROR: ${e instanceof Error ? e.message : 'unknown'} (correlation_id: ${correlationId})`);
    }
  }

  // Channel 2: Local persistence (always attempted)
  try {
    await alertDatabaseConnectionFailure({
      timestamp: context.timestamp,
      errorType: context.errorType,
      description: context.description,
      severity: context.severity,
      correlationId, // pass through to alert.ts for JSONL/DB logging
    });
    localOk = true;
  } catch (e) {
    console.warn(`[${context.timestamp}] LOCAL_ALERT_FAILED: ${e instanceof Error ? e.message : 'unknown'} (correlation_id: ${correlationId})`);
  }

  return { correlationId, channels: { controlCenter: controlCenterOk, local: localOk } };
}
