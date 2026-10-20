import { createHash } from "node:crypto";
import { alertDatabaseConnectionFailure } from "./alert";

interface AlertRecord {
  count: number;
  firstSeen: number;
  lastSeen: number;
  correlationId: string;
}

class AlertRouter {
  private readonly dedupMap = new Map<string, AlertRecord>();
  private readonly cleanupInterval: NodeJS.Timeout;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(ttlMinutes = 5, maxEntries = 1000) {
    this.ttlMs = ttlMinutes * 60 * 1000;
    this.maxEntries = maxEntries;
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    this.cleanupInterval.unref();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, record] of this.dedupMap.entries()) {
      if (now - record.lastSeen > this.ttlMs) {
        this.dedupMap.delete(key);
      }
    }
    if (this.dedupMap.size > this.maxEntries) {
      const entries = Array.from(this.dedupMap.entries());
      entries.sort((a, b) => a[1].lastSeen - b[1].lastSeen);
      const toDelete = entries.slice(0, this.dedupMap.size - this.maxEntries);
      for (const [key] of toDelete) this.dedupMap.delete(key);
    }
  }

  async routeDatabaseAlert(failureContext: {
    timestamp: string;
    errorType: string;
    description: string;
    severity: "WARNING" | "CRITICAL";
    rawUrl: string;
  }): Promise<string> {
    const urlHint = createHash("sha256").update(failureContext.rawUrl).digest("hex").slice(0, 12);
    const now = Date.now();
    const existing = this.dedupMap.get(urlHint);

    if (existing && now - existing.lastSeen < this.ttlMs) {
      existing.count++;
      existing.lastSeen = now;
      return existing.correlationId;
    }

    const correlationId = crypto.randomUUID();
    this.dedupMap.set(urlHint, {
      count: 1,
      firstSeen: now,
      lastSeen: now,
      correlationId,
    });

    const alertPayload = {
      ...failureContext,
      correlationId,
      url_hint: urlHint,
    };

    await Promise.allSettled([
      alertDatabaseConnectionFailure(alertPayload),
      this.postToControlCenter(alertPayload),
    ]);

    return correlationId;
  }

  private async postToControlCenter(payload: Record<string, unknown>): Promise<void> {
    const base = process.env.SAOS_CONTROL_CENTER_URL;
    if (!base) return;
    try {
      await fetch(`${base}/api/alerts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // fail-open: never throw
    }
  }

  shutdown(): void {
    clearInterval(this.cleanupInterval);
    this.dedupMap.clear();
  }
}

export const alertRouter = new AlertRouter();
export type { AlertRecord };
