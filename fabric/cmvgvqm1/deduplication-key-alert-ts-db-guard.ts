import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

interface AlertInput {
  timestamp: string;
  errorType: string;
  description: string;
  severity: "WARNING" | "CRITICAL";
  resourceName?: string;
  checkName?: string;
}

const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 דקות

function computeDedupKey(input: AlertInput): string {
  const dateOnly = input.timestamp.split('T')[0]; // YYYY-MM-DD
  const raw = `${input.resourceName ?? "unknown"}|${input.checkName ?? "unknown"}|${input.errorType}|${dateOnly}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

async function isDuplicate(alertId: string, dedupKey: string, timestamp: string): Promise<boolean> {
  const alertTime = new Date(timestamp).getTime();
  const windowStart = new Date(alertTime - DEDUP_WINDOW_MS).toISOString();
  
  const existing = await prisma.alert.findFirst({
    where: {
      dedup_key: dedupKey,
      timestamp: {
        gte: windowStart,
        lt: timestamp
      },
      id: { not: alertId }
    },
    select: { id: true }
  });
  
  return existing !== null;
}

export async function alertDatabaseConnectionFailure(input: AlertInput): Promise<void> {
  const dedupKey = computeDedupKey(input);
  
  // בדיקת כפילות לפני יצירה
  const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  if (await isDuplicate(tempId, dedupKey, input.timestamp)) {
    console.warn(`[${input.timestamp}] ALERT_DEDUP: Suppressed duplicate alert for dedup_key=${dedupKey}`);
    return;
  }

  await prisma.alert.create({
    data: {
      timestamp: input.timestamp,
      error_type: input.errorType,
      description: input.description,
      severity: input.severity,
      resource_name: input.resourceName ?? "database",
      check_name: input.checkName ?? "connection_guard",
      dedup_key: dedupKey
    }
  });

  // שליחה למקלט חיצוני (fail-open)
  const base = process.env.SAOS_CONTROL_CENTER_URL;
  if (base) {
    try {
      await fetch(`${base}/api/alerts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: "database_connection_failure",
          at: input.timestamp,
          service_id: "saos-dex",
          error_type: input.errorType,
          description: input.description,
          severity: input.severity,
          dedup_key: dedupKey
        }),
        signal: AbortSignal.timeout(3000)
      });
    } catch {
      // fail-open: לא שוברים את הזרימה
    }
  }
}

export async function getRecentAlerts(limit = 100) {
  return prisma.alert.findMany({
    orderBy: { timestamp: "desc" },
    take: limit,
    select: {
      id: true,
      timestamp: true,
      error_type: true,
      description: true,
      severity: true,
      resource_name: true,
      check_name: true,
      dedup_key: true
    }
  });
}