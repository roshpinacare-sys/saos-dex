/**
 * BATCH-RUN · ריצה-אחת-פעמית עצמאית-סביבה (agent-9 wave-3, 2026-10-17)
 * ─────────────────────────────────────────────────────────────────────────
 * מטרה: להוכיח שהקרנל רץ headless — בלי dev-server, בלי Next, בלי GitHub
 * Actions. כל מארח עם bun (cron / VPS / מכונה-ביתית / CI) יכול להריץ:
 *
 *   DATABASE_URL=file:$PWD/db/dex.db SAOS_DEX_STATE_DIR=$PWD/db \
 *   DEX_OPERATOR_TOKEN=<32+ chars> bun run scripts/batch-run.ts ops-queue.json
 *
 * פורמט ops-queue.json: מערך ops בפורמט-הקרנל (order/cancel/transfer/pool_swap...).
 * הקבלה: JSON אחד ל-stdout — boot.height, כל-op (queued/reason), done.height,
 * done.stateRoot. אפס-סודות: הטוקן נשאר ב-env של המארח בלבד (fail-closed של
 * operatorAuth לא נוגע כאן — submitOp ישירות; מי-שמריץ על המארח הוא ה-operator).
 */
import { readFileSync } from "node:fs";
import { ensureChain, submitOp, nextNonce } from "../src/lib/dex/chain";

const queuePath = process.argv[2];
if (!queuePath) { console.error("usage: batch-run.ts <ops-queue.json>"); process.exit(2); }

let ops: unknown[];
try { ops = JSON.parse(readFileSync(queuePath, "utf8")); }
catch (e) { console.error("bad queue json:", (e as Error).message); process.exit(2); }
if (!Array.isArray(ops) || ops.length === 0) { console.error("queue must be a non-empty array of kernel ops"); process.exit(2); }
if (ops.length > 100) { console.error("queue cap is 100 ops per batch"); process.exit(2); }

const rt = ensureChain();
// קריאה-דינמית בלבד: טעינת-הסנאפשוט האסינכרונית מחליפה את אובייקט-ה-state אחרי-האתחול
const S = () => (rt as unknown as { st: { height: number; stateRoot: string } }).st;
const bootAt = Date.now();
const boot = { height: S().height, stateRoot: String(S().stateRoot).slice(0, 16) };

const submitted = ops.map((raw) => {
  const op = { ...(raw as Record<string, unknown>) };
  if (!op.issuer) op.issuer = "operator";
  if (!op.nonce) op.nonce = nextNonce("batch");
  const r = submitOp(op as never);
  return { nonce: op.nonce, type: op.type ?? "?", queued: r.queued, reason: r.reason ?? null };
});

console.log(JSON.stringify({ schema: "batch.run/1", at: new Date().toISOString(), boot, submitted }, null, 2));

// המתנה לחתימות-בלוק אמת (טיק = 3s) + דגימה עד שהסנאפשוט נטען והגובה מתקדם, ואז יציאה נקייה.
const deadline = Date.now() + 45_000;
const wait = setInterval(() => {
  const s = S();
  const loaded = s.height > 0;
  if (!loaded && Date.now() < deadline) return;
  clearInterval(wait);
  console.log(JSON.stringify({
    schema: "batch.done/1",
    waitedMs: Date.now() - bootAt,
    done: { height: s.height, stateRoot: String(s.stateRoot ?? "").slice(0, 16), advanced: s.height > boot.height },
  }, null, 2));
  process.exit(0);
}, 3_000);
