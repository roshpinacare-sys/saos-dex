/**
 * src/lib/dex/risk.ts — pre-trade risk cabinet gate (directive §7C)
 * ===================================================================
 * The ENFORCEMENT half of the desk→dex risk wiring: every order payload is
 * evaluated here BEFORE state execution (submitOp), fail-closed.
 *
 * POLICY SOURCE: saos-desk mandate@4 via saos-desk src/cabinet.mjs
 * (PR feat/dex-risk-cabinet-policy). This module mirrors that contract so the
 * gate works before the cross-repo merge; swap `RISK_LIMITS`/`MANDATE_SIG`
 * derivation to a direct desk import post-merge (SWARM_STATE §10 decoupling).
 * Parity is pinned by tests: MANDATE_SIG === desk sig8 value, limits ===
 * desk derivation, verdict shape === boardroom.riskGate records.
 *
 * LAWS:
 *   · law 13 (desk units law / CHAIN_SPEC): integers-only crossing the gate.
 *   · SETTLE-9: minOut slippage protection enforced at depth (defense-in-depth
 *     beyond the route-level check).
 *   · directive §3: every verdict — allow AND deny — lands on a sha256
 *     hash-chained receipt trail (canonical.ts primitives, no new crypto).
 *   · Clock-free module: `at` comes from the caller; no random; no network.
 */

import { sha256, canon } from "./canonical";
import type { Op } from "./kernel";

export const CABINET_SCHEMA = "saos-desk/dex-cabinet@1";

/** The v1 intercepted op set — the immediate funds-movers (mirrors desk DEX_TRADE_OPS). */
export const DEX_TRADE_OPS = ["order", "fill", "pool_swap"] as const;

export function isTradeOp(type: string | undefined): boolean {
  return typeof type === "string" && (DEX_TRADE_OPS as readonly string[]).includes(type);
}

/**
 * Capital-index base in µ (desk law 13: capital is a 10000bps index — every
 * limit below is a mandate PERCENTAGE of this base, no invented absolutes).
 */
export const CABINET_BASE_CAPITAL_MU = 10_000_000;

/** Slippage-guard tier: 10% of the per-order notional cap. */
export const SLIPPAGE_GUARD_FRACTION = 0.1;

/**
 * 8-hex signature of the sourced mandate@4 fields, byte-parity with the desk
 * cabinet's sig8({maxPositionPct, kellyCap, maxOpenPositions, tieLaw}).
 * saos-desk mandate.json@4: maxPositionPct=15, kellyCap=0.5,
 * maxOpenPositions=5, tieLaw="stop-wins" → canonical sorted-key JSON:
 * {"kellyCap":0.5,"maxOpenPositions":5,"maxPositionPct":15,"tieLaw":"stop-wins"}
 * (dex canon() rejects the 0.5 float — the parity string is constructed
 * literally; the test pins the value against the live desk output).
 */
export const MANDATE_SIG = sha256(
  '{"kellyCap":0.5,"maxOpenPositions":5,"maxPositionPct":15,"tieLaw":"stop-wins"}',
).slice(0, 8);

/** Mirrored limits — the desk derivation, pinned by tests (law 3: mandate is hard law). */
export const RISK_LIMITS = {
  schema: CABINET_SCHEMA,
  maxNotionalMu: Math.floor((CABINET_BASE_CAPITAL_MU * 15) / 100), // 1_500_000µ-quote
  maxTradesPerIssuerInFlight: 5, // mandate.positions.maxOpenPositions
  minOutRequiredAboveMu: Math.floor((CABINET_BASE_CAPITAL_MU * 15 * SLIPPAGE_GUARD_FRACTION) / 100), // 150_000µ-base
  mandateSig: MANDATE_SIG,
} as const;

export interface RiskVerdict {
  id: string;
  label: string;
  passed: boolean;
  measured: string | number;
  limit: string | number;
}

export interface RiskDecision {
  allowed: boolean;
  verdicts: RiskVerdict[];
  fails: string[];
}

/** Trade-shaped fields — an op carrying them is a trade intent, whatever its claimed type. */
const TRADE_SHAPE_FIELDS = ["base", "quote", "side", "pair", "assetIn"] as const;

function isTradeShaped(op: Op): boolean {
  return TRADE_SHAPE_FIELDS.some((f) => (op as unknown as Record<string, unknown>)[f] !== undefined);
}

/** Notional in µ-quote — MIRRORS the dex kernel: floor(price×amountMu/1000). */
function notionalMu(op: Op): number {
  const amount = typeof op.amount === "number" ? op.amount : 0;
  const price = typeof op.price === "number" && op.price > 0 ? op.price : 0;
  return price > 0 ? Math.floor((price * amount) / 1000) : amount;
}

/**
 * The pure pre-trade evaluation. Non-trade ops without trade fields pass as
 * C0 (kernel + route guards own them); trade-shaped ops of ANY type enter the
 * cabinet and fail closed on anything unverified (directive §3).
 */
export function evaluatePreTrade(op: Op, ctx: { inFlight: number }): RiskDecision {
  const verdicts: RiskVerdict[] = [];

  const knownType = isTradeOp(op.type);
  if (!knownType && !isTradeShaped(op)) {
    return {
      allowed: true,
      verdicts: [{ id: "C0", label: "מחוץ-לתחום-הקבינט — נבדק בשכבות-אחרות", passed: true, measured: String(op.type ?? "?"), limit: DEX_TRADE_OPS.join("|") }],
      fails: [],
    };
  }

  // C1 — units law: non-negative integers only; amount present and positive;
  // unknown types in trade shape are unclassifiable intents → fail closed.
  const numericFields = ["amount", "price", "minOut", "amountB"] as const;
  const opRec = op as unknown as Record<string, unknown>;
  const badFields = numericFields.filter((f) => {
    const v = opRec[f];
    if (v === undefined) return false;
    return typeof v !== "number" || !Number.isInteger(v) || v < 0;
  });
  const amountOk = typeof op.amount === "number" && Number.isInteger(op.amount) && op.amount > 0;
  verdicts.push({
    id: "C1",
    label: "חוק-יחידות: שלמים-בלבד חוצים-את-החתימה (law 13)",
    passed: knownType && badFields.length === 0 && amountOk,
    measured: !knownType
      ? `unknown-type:${String(op.type)}`
      : badFields.length > 0
        ? badFields.join(",")
        : String(op.amount ?? "missing"),
    limit: knownType ? "integers-only, amount>0" : DEX_TRADE_OPS.join("|"),
  });

  // C2 — per-order notional cap (mandate.limits.maxPositionPct over the base index).
  const nMu = notionalMu(op);
  verdicts.push({
    id: "C2",
    label: "תקרת-גודל-פקודה ≤ אחוז-המנדט מבסיס-ההון",
    passed: nMu <= RISK_LIMITS.maxNotionalMu,
    measured: nMu,
    limit: RISK_LIMITS.maxNotionalMu,
  });

  // C3 — per-issuer in-flight velocity (mandate.positions.maxOpenPositions).
  const inFlight =
    typeof ctx?.inFlight === "number" && Number.isInteger(ctx.inFlight) && ctx.inFlight >= 0
      ? ctx.inFlight
      : 0;
  verdicts.push({
    id: "C3",
    label: "תחום-מהירות: פקודות-פתוחות-למנפיק ≤ מרבי-המנדט",
    passed: inFlight < RISK_LIMITS.maxTradesPerIssuerInFlight,
    measured: inFlight,
    limit: RISK_LIMITS.maxTradesPerIssuerInFlight,
  });

  // C4 — slippage guard on pool_swap (SETTLE-9 defense-in-depth).
  if (op.type === "pool_swap") {
    const amt = op.amount;
    const needsGuard = typeof amt === "number" && Number.isInteger(amt) && amt > 0 && amt >= RISK_LIMITS.minOutRequiredAboveMu;
    const hasGuard = typeof op.minOut === "number" && op.minOut >= 1;
    verdicts.push({
      id: "C4",
      label: "מגן-החלקה: swap מעל-סף חייב minOut (SETTLE-9 בעומק-הגרעין)",
      passed: !needsGuard || hasGuard,
      measured: needsGuard ? (op.minOut ?? "absent") : `below-${RISK_LIMITS.minOutRequiredAboveMu}`,
      limit: `minOut≥1 when amount≥${RISK_LIMITS.minOutRequiredAboveMu}`,
    });
  }

  const fails = verdicts.filter((v) => !v.passed).map((v) => v.id);
  return { allowed: fails.length === 0, verdicts, fails };
}

/**
 * Batch evaluation (SETTLE-12: every sub-op shares the batch issuer). Each
 * sub-op is evaluated with the issuer's in-flight count plus the sub-ops
 * already accepted within this batch; the FIRST denied sub-op fails the whole
 * batch (batch atomicity). Returns null when every sub-op passes.
 */
export function evaluateBatch(
  subOps: Op[],
  baseInFlight: number,
): { index: number; verdict: RiskDecision } | null {
  let accepted = 0;
  for (let i = 0; i < subOps.length; i++) {
    const verdict = evaluatePreTrade(subOps[i], { inFlight: baseInFlight + accepted });
    if (!verdict.allowed) return { index: i, verdict };
    // Only accepted TRADE sub-ops consume velocity budget.
    if (isTradeOp(subOps[i].type)) accepted++;
  }
  return null;
}

/* ── Receipts: hash-chained immutable audit trail (directive §3) ─────────── */

export interface RiskReceipt {
  seq: number;
  at: number;
  opDigest: string;
  allowed: boolean;
  reason: string | null;
  prevHash: string | null;
  hash: string;
}

const receipts: RiskReceipt[] = [];
let seqCounter = 0;

/** Stable digest of an op — canonical form when the op is chain-legal, honest raw JSON otherwise (garbage ops the cabinet DENIES must still digest; NaN→null deterministically). */
function opDigest(op: Op): string {
  try {
    return sha256(canon(op));
  } catch {
    return sha256("RAW:" + JSON.stringify(op));
  }
}

export function nextRiskSeq(): number {
  seqCounter += 1;
  return seqCounter;
}

export function recordRiskReceipt(
  op: Op,
  verdict: RiskDecision,
  ctx: { seq?: number; at: number },
): RiskReceipt {
  const body = {
    seq: ctx.seq ?? nextRiskSeq(),
    at: ctx.at,
    opDigest: opDigest(op),
    allowed: verdict.allowed,
    reason: verdict.fails.length > 0 ? verdict.fails.join(",") : null,
    prevHash: receipts.length > 0 ? receipts[receipts.length - 1].hash : null,
  };
  const rec: RiskReceipt = { ...body, hash: sha256(JSON.stringify(body)) };
  receipts.push(rec);
  return rec;
}

/** The live chain (defensive copy — callers can't mutate the audit trail). */
export function riskReceipts(): RiskReceipt[] {
  return receipts.map((r) => ({ ...r }));
}

/** Zero-trust verification: prevHash linkage + per-row recomputation; tamper located at the exact index. */
export function verifyRiskChain(chain: RiskReceipt[] = riskReceipts()): {
  ok: boolean;
  brokenAt: number | null;
} {
  let prev: RiskReceipt | null = null;
  for (let i = 0; i < chain.length; i++) {
    const r = chain[i];
    const { hash, ...body } = r;
    if (typeof hash !== "string" || hash !== sha256(JSON.stringify(body))) return { ok: false, brokenAt: i };
    if (body.prevHash !== (prev ? prev.hash : null)) return { ok: false, brokenAt: i };
    if (prev && !(body.seq > prev.seq)) return { ok: false, brokenAt: i };
    prev = r;
  }
  return { ok: true, brokenAt: null };
}

/** Trade ops already queued for an issuer (mempool scope) — the C3 budget source. */
export function tradeOpsInFlight(rt: { mempool: Op[] }, issuer: string): number {
  let n = 0;
  for (const o of rt.mempool) {
    if (o.issuer !== issuer) continue;
    if (isTradeOp(o.type)) n++;
    else if (o.type === "batch" && Array.isArray(o.ops)) n += o.ops.filter((s) => isTradeOp(s.type)).length;
  }
  return n;
}
