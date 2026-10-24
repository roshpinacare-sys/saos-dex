/**
 * htlc-receipts.ts — hash-chained receipts for the §7.2 HTLC bridge (W49-b)
 * ==========================================================================
 * Every SUCCESSFUL htlc transition (create/claim/refund) seals one receipt
 * into canonical state (st.htlcReceipts → flows into stateRoot/merkle via
 * applyOp, exactly like the contracts themselves):
 *
 *     hash = sha256(prevHash + canon(body))     (canonical.ts primitives —
 *                                               sorted-keys JSON, integers-only,
 *                                               no new crypto)
 *     prevHash(row₀) = HTLC_RECEIPT_GENESIS     (64×"0" — deterministic anchor)
 *     seq       = 1..n, strictly contiguous
 *
 * Properties (proved by harness/htlc-test.ts):
 *   · tamper-evident: any flipped unit in a body field breaks the row hash at
 *     the EXACT index (verifyHtlcReceipts → {ok:false, brokenAt:i})
 *   · chain-break-evident: splicing/reordering rows breaks prevHash linkage
 *   · canonical: the hash is independent of key insertion order (canon sorts)
 *   · deterministic: zero Date.now/random — `at` is the engine block height
 *   · atomic with batches: sub-ops run on the kernel's trial clone, so
 *     receipts of a denied batch are discarded with it (nothing applied,
 *     nothing sealed)
 *
 * Zero runtime deps beyond canonical.ts (type-only kernel import — no cycle;
 * kernel.ts calls INTO this module after a successful htlc transition).
 */
import { canon, sha256 } from "./canonical";
import type { DexState } from "./kernel"; // type-only — אפס-מעגל-ריצה

/** The deterministic anchor every receipt chain starts from. */
export const HTLC_RECEIPT_GENESIS = "0".repeat(64);

/** The hash-bound transition payload — built FROM STATE (the settled contract
 * record), never from the op, so a receipt always reflects post-transition
 * truth. */
export interface HtlcReceiptBody {
  op: "htlc_create" | "htlc_claim" | "htlc_refund";
  contractId: string;
  from: string;
  to: string;
  asset: string;
  amount: number; // µ
  state: "locked" | "claimed" | "refunded"; // post-transition state
  height: number; // engine block height at the transition (state clock)
  preimage?: string; // claim only — THE on-chain witness
}

export interface HtlcReceipt {
  seq: number;
  at: number; // engine height at the transition (mirror of body.height)
  op: HtlcReceiptBody["op"]; // fast-scan mirror of body.op
  contractId: string; // fast-scan mirror of body.contractId
  prevHash: string;
  hash: string; // sha256(prevHash + canon(body))
  body: HtlcReceiptBody;
}

/** The live receipt chain — old snapshots tolerated (undefined → []). */
export function htlcReceiptsOf(st: DexState): HtlcReceipt[] {
  if (!Array.isArray(st.htlcReceipts)) st.htlcReceipts = [];
  return st.htlcReceipts;
}

/** Seal one transition onto the chain. */
export function appendHtlcReceipt(st: DexState, body: HtlcReceiptBody): HtlcReceipt {
  const chain = htlcReceiptsOf(st);
  const prev = chain.length > 0 ? chain[chain.length - 1] : null;
  const prevHash = prev ? prev.hash : HTLC_RECEIPT_GENESIS;
  const seq = prev ? prev.seq + 1 : 1;
  const rec: HtlcReceipt = {
    seq,
    at: body.height,
    op: body.op,
    contractId: body.contractId,
    prevHash,
    hash: sha256(prevHash + canon(body)),
    body,
  };
  chain.push(rec);
  return rec;
}

/** Kernel door: after a SUCCESSFUL htlc transition, seal its receipt. The
 * body is derived from the settled contract record in state. Returns null
 * only if the record is absent (cannot follow an ok transition) — fail-honest:
 * no record, no fabricated receipt. */
export function recordHtlcReceipt(
  st: DexState,
  op: HtlcReceiptBody["op"],
  contractId: string,
): HtlcReceipt | null {
  const rec = st.htlcs?.[contractId];
  if (!rec) return null;
  const body: HtlcReceiptBody = {
    op,
    contractId,
    from: rec.from,
    to: rec.to,
    asset: rec.asset,
    amount: rec.amount,
    state: rec.state,
    height: st.height,
    ...(rec.preimage !== undefined ? { preimage: rec.preimage } : {}),
  };
  return appendHtlcReceipt(st, body);
}

/** Zero-trust verification: per-row hash recomputation + prevHash linkage +
 * seq continuity; tamper/chain-break located at the exact index. */
export function verifyHtlcReceipts(chain: readonly HtlcReceipt[]): {
  ok: boolean;
  brokenAt: number | null;
  count: number;
} {
  let prev: HtlcReceipt | null = null;
  for (let i = 0; i < chain.length; i++) {
    const r = chain[i];
    if (typeof r?.hash !== "string" || r.hash !== sha256(r.prevHash + canon(r.body)))
      return { ok: false, brokenAt: i, count: chain.length };
    if (r.prevHash !== (prev ? prev.hash : HTLC_RECEIPT_GENESIS))
      return { ok: false, brokenAt: i, count: chain.length };
    if (r.seq !== i + 1) return { ok: false, brokenAt: i, count: chain.length };
    prev = r;
  }
  return { ok: true, brokenAt: null, count: chain.length };
}
