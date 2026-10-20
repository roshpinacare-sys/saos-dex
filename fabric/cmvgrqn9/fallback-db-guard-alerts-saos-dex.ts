import { createHash } from "node:crypto";
import { mkdirSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Payload structure for alert fallback logging.
 * Includes all critical context for post-mortem analysis.
 */
export interface AlertPayload {
  timestamp: string;
  correlationId: string;
  errorType: string;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
}

/**
 * Resolves the absolute path to the fallback log file.
 * Uses import.meta.url to anchor relative to this module.
 */
function getFallbackLogPath(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // Project root is two levels up from src/lib/
  const projectRoot = resolve(__dirname, "../..");
  return resolve(projectRoot, "logs/alerts-fallback.jsonl");
}

/**
 * Ensures the logs directory exists.
 * Called lazily on first write to avoid boot-time I/O.
 */
function ensureLogsDir(): void {
  const logPath = getFallbackLogPath();
  const logDir = dirname(logPath);
  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    // Directory may already exist; ignore EEXIST
  }
}

/**
 * Writes an alert payload to the local JSONL fallback file.
 * Never throws — errors are swallowed with console.error only.
 * @param alert - The alert payload to persist
 */
export async function writeAlertToLocalFallback(alert: AlertPayload): Promise<void> {
  try {
    ensureLogsDir();
    const logPath = getFallbackLogPath();
    const line = JSON.stringify(alert) + "\n";
    appendFileSync(logPath, line, { encoding: "utf8" });
  } catch (err) {
    // Swallow errors to never break the primary flow
    console.error(
      `[${new Date().toISOString()}] ALERT_FALLBACK_WRITE_FAILED: ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
  }
}
