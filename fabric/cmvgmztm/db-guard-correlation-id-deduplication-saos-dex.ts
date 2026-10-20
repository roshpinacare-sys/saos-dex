import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";

// FIX(Roast-68 · db-scope-guard): נזק-חי-מתועד — תהליך-שירש-את-DATABASE_URL-של-הפלטפורמה-האם
// פתח-את-השרשרת-בתוך-db/custom.db-של-האם (בעקיפין-את-.env-של-האם) והשמיד-את-טבלאות-הכספת.
// מעתה: המנוע-מסרב-לעלות-אם-כתובת-ה-DB-אינה-dex.db-שלו-עצמו (fail-closed ב-boot).
// W10 · אשרור-הבעלים ("מאשר"): שתי-התראות-fail-open נוספו-על-ה-guard —
//   (1) cmvdww18: מודול-ההתראה-המקומי (src/lib/dex/alert.ts) — לוג-מבני + ledger-JSONL.
//   (2) cmvdxs6w (הגרסה-המתוקנת מ-REVIEW-W7): POST-חד-פעמי למקלט-הקונסולה /api/alerts —
//       env-gated (SAOS_CONTROL_CENTER_URL), sha256-12hex-במקום-כתובת, AbortSignal.timeout.
//   שתיהן-מאובטחות-מדידה-וללא-סודות. ה-throw-הבלתי-מותנה-בסוף-הוא-החוק: ההגנה-fail-closed,
//   ההתראות-fail-open — כישלון-התראה-אינו-מרכך-את-ההגנה-ולא-מפיל-boot.
const RAW_URL = process.env.DATABASE_URL ?? "";
const isDexOwnDb = /dex\.db(\?|$)/.test(RAW_URL) && !/custom\.db/.test(RAW_URL);
if (!isDexOwnDb) {
  // FIX(R16-a·m7): השגיאה הדפיסה את RAW_URL-הגולמי — URL-שגוי שמצביע-על-DB-אחר
  // (עם-credentials-מוטבעים user:pass@host) היה נשפך ללוגים/קריסת-בוט. עתה:
  // תיאור-מסנן-בלבד (חסר/לא-דקס/לא-ידוע) — בלי-גוף-הכתובת.
  const desc = RAW_URL === "" ? "(חסר — הגדר DATABASE_URL ב-.env של saos-dex)" : /dex\.db/.test(RAW_URL) ? "(dex.db-קיים-אך-לא-עבר-את-הסינון)" : /custom\.db/.test(RAW_URL) ? "(מצביע-על-האם-אסור)" : "(כתובת-לא-ידועה — לא-מוצגת)";
  const errorMessage =
    `[saos-dex] DATABASE_URL נדחה (fail-closed): המנוע רשאי לגעת רק ב-dex.db שלו — ` +
    `קיבל: ${desc}`;
  const timestamp = new Date().toISOString();

  // קריאה יחידה לפונקציה המאוחדת עם correlation ID
  void sendDBGuardAlert({
    correlationId: randomUUID(),
    timestamp,
    errorType: "INVALID_DATABASE_URL",
    description: errorMessage,
    severity: "WARNING",
    urlHint: RAW_URL,
  });

  throw new Error(errorMessage);
}

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };
export const prisma = globalForPrisma.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

// ============================================================================
// DB Guard Alert Unification — Correlation ID + Deduplication + Fallback
// ============================================================================

interface DBGuardAlertPayload {
  correlationId: string;
  timestamp: string;
  errorType: string;
  description: string;
  severity: "WARNING" | "CRITICAL";
  urlHint?: string;
}

// LRU cache for deduplication (max 100 items, 60s TTL)
interface DedupEntry {
  hash: string;
  expiresAt: number;
}

const dedupCache = new Map<string, DedupEntry>();
const DEDUP_MAX_SIZE = 100;
const DEDUP_TTL_MS = 60_000;

function computeFailureHash(payload: DBGuardAlertPayload): string {
  // Hash of errorType + description (without correlationId/timestamp)
  return createHash("sha256")
    .update(`${payload.errorType}|${payload.description}`)
    .digest("hex")
    .slice(0, 16);
}

function isDuplicate(hash: string): boolean {
  const now = Date.now();
  const entry = dedupCache.get(hash);
  if (!entry) return false;
  if (now > entry.expiresAt) {
    dedupCache.delete(hash);
    return false;
  }
  return true;
}

function addToDedup(hash: string): void {
  const now = Date.now();
  // Evict oldest if at capacity
  if (dedupCache.size >= DEDUP_MAX_SIZE) {
    const oldestKey = dedupCache.keys().next().value;
    if (oldestKey !== undefined) dedupCache.delete(oldestKey);
  }
  dedupCache.set(hash, { hash, expiresAt: now + DEDUP_TTL_MS });
}

async function sendToControlCenter(payload: DBGuardAlertPayload): Promise<boolean> {
  const base = process.env.SAOS_CONTROL_CENTER_URL;
  if (!base) return false;

  try {
    const res = await fetch(`${base}/api/alerts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: "db_guard_failure",
        correlation_id: payload.correlationId,
        at: payload.timestamp,
        service_id: "saos-dex",
        error_type: payload.errorType,
        description: payload.description,
        severity: payload.severity,
        url_hint: payload.urlHint
          ? createHash("sha256").update(payload.urlHint).digest("hex").slice(0, 12)
          : undefined,
      }),
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) {
      console.warn(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          correlation_id: payload.correlationId,
          action: "db_guard_alert_control_center_failed",
          status: res.status,
          note: "fallback to local alert",
        })
      );
      return false;
    }

    console.info(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        correlation_id: payload.correlationId,
        action: "db_guard_alert_sent",
        channel: "control_center",
        status: "success",
      })
    );
    return true;
  } catch (err) {
    console.warn(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        correlation_id: payload.correlationId,
        action: "db_guard_alert_control_center_error",
        error: err instanceof Error ? err.message : "unknown",
        note: "fallback to local alert",
      })
    );
    return false;
  }
}

async function sendToLocalAlert(payload: DBGuardAlertPayload): Promise<void> {
  try {
    const { alertDatabaseConnectionFailure } = await import("./dex/alert");
    await alertDatabaseConnectionFailure({
      timestamp: payload.timestamp,
      errorType: payload.errorType,
      description: payload.description,
      severity: payload.severity,
    });
    console.info(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        correlation_id: payload.correlationId,
        action: "db_guard_alert_sent",
        channel: "local",
        status: "success",
      })
    );
  } catch (alertError) {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        correlation_id: payload.correlationId,
        action: "db_guard_alert_local_failed",
        error: alertError instanceof Error ? alertError.message : "unknown",
        note: "both channels exhausted",
      })
    );
  }
}

export async function sendDBGuardAlert(payload: DBGuardAlertPayload): Promise<void> {
  const hash = computeFailureHash(payload);

  // Deduplication check
  if (isDuplicate(hash)) {
    console.info(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        correlation_id: payload.correlationId,
        action: "db_guard_alert_deduplicated",
        hash,
        note: "suppressed duplicate within 60s window",
      })
    );
    return;
  }

  addToDedup(hash);

  // Try control center first (if configured)
  const sentToControlCenter = await sendToControlCenter(payload);

  // Fallback to local alert if control center failed or not configured
  if (!sentToControlCenter) {
    console.info(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        correlation_id: payload.correlationId,
        action: "db_guard_alert_fallback",
        channel: "local",
        reason: sentToControlCenter === false ? "control_center_failed" : "control_center_not_configured",
      })
    );
    await sendToLocalAlert(payload);
  }
}