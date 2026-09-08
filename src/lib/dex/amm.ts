/**
 * amm.ts — בריכות-זרימה ריבוניות (x*y=k, שלמים, floor):
 *  · עמלי-30bps (dex-facts: "עמלי-30bps כמו-הבריכה-הילידית")
 *  · פיצול-עמלה: 70% ל-LP (ברזרבות) · 30% לאוצר — רווח-מונוטוני (grid98)
 *  · שימור-ערך נבדק בכל swap (CHAIN_SPEC) · minOut fail-closed
 */
import type { DexState, Op, OpResult, TradeEvent, Pool } from "./kernel";
import { FEE_BPS, TREASURY_CUT_PCT, addBal, avail, poolKey } from "./kernel";

export const LP_ASSET_PREFIX = "LP|";

export function getPool(st: DexState, key: string): Pool | null {
  return st.pools[key] ?? null;
}

/** מחיר-אמצע מהבריכה: µ-ציטוט ל-1 יחידת-בסיס (ra/bra ב-µ) */
export function poolMid(p: Pool): number {
  if (p.ra <= 0) return 0;
  return Math.floor((p.rb * 1000) / p.ra);
}

/** ציטוט-קריאה-בלבד: פלט צפוי + מחיר-אפקטיבי (µ-ציטוט ל-1 יחידת-בסיס) */
export function quoteOut(p: Pool, assetIn: string, amountIn: number): { out: number; price: number; minOut0: number } | null {
  const inA = assetIn === p.a;
  const rIn = inA ? p.ra : p.rb, rOut = inA ? p.rb : p.ra;
  if (rIn <= 0 || rOut <= 0 || amountIn <= 0) return null;
  const feeAmt = Math.floor((amountIn * FEE_BPS) / 10_000);
  const inAfterFee = amountIn - feeAmt;
  const out = Math.floor((rOut * inAfterFee) / (rIn + inAfterFee));
  if (out <= 0 || out >= rOut) return null;
  // inA = מוכר-בסיס-תמורת-ציטוט: מחיר = µ-ציטוט ל-1 יחידת-בסיס = out*1000/amountIn
  // !inA = קונה-בסיס-בציטוט: מחיר = amountIn*1000/out
  const price = inA ? Math.floor((out * 1000) / amountIn) : Math.floor((amountIn * 1000) / out);
  return { out, price, minOut0: Math.floor((out * 99) / 100) }; // סבילות-ברירת-מחדל 1%
}

export function poolAdd(
  st: DexState, op: Op, _nowMs: number,
  consume: () => OpResult | null
): OpResult {
  const key = op.pair;
  if (!key) return { ok: false, err: "pair-required", gas: 0 };
  const p = getPool(st, key);
  if (!p) return { ok: false, err: "pool-not-found", gas: 0 };
  const amountA = op.amount ?? 0;
  if (!(amountA > 0)) return { ok: false, err: "bad-amount", gas: 0 };
  const amountB = p.ra > 0 ? Math.floor((p.rb * amountA) / p.ra) : 0;
  if (avail(st, op.issuer, p.a) < amountA) return { ok: false, err: "insufficient-a", gas: 0 };
  if (avail(st, op.issuer, p.b) < amountB) return { ok: false, err: "insufficient-b", gas: 0 };
  const lpMint = p.ra > 0 ? Math.max(1, Math.floor((p.lp * amountA) / p.ra)) : Math.floor(Math.sqrt(amountA * amountB));
  const c = consume(); if (c) return c;

  addBal(st, op.issuer, p.a, -amountA);
  addBal(st, op.issuer, p.b, -amountB);
  p.ra += amountA; p.rb += amountB; p.lp += lpMint;
  addBal(st, op.issuer, LP_ASSET_PREFIX + key, lpMint);
  return { ok: true, gas: 0 };
}

export function poolSwap(
  st: DexState, op: Op, nowMs: number,
  consume: () => OpResult | null
): OpResult {
  const key = op.pair;
  const p = key ? getPool(st, key) : null;
  const assetIn = op.assetIn;
  const amountIn = op.amount ?? 0;
  if (!p || !assetIn || (assetIn !== p.a && assetIn !== p.b)) return { ok: false, err: "bad-pair", gas: 0 };
  if (!(amountIn > 0)) return { ok: false, err: "bad-amount", gas: 0 };
  if (avail(st, op.issuer, assetIn) < amountIn) return { ok: false, err: "insufficient", gas: 0 };

  const inA = assetIn === p.a;
  const rIn = inA ? p.ra : p.rb, rOut = inA ? p.rb : p.ra;
  const feeAmt = Math.floor((amountIn * FEE_BPS) / 10_000);
  const inAfterFee = amountIn - feeAmt;
  const lpFee = feeAmt - Math.floor((feeAmt * TREASURY_CUT_PCT) / 100);
  const treasuryFee = feeAmt - lpFee;
  const poolIn = inAfterFee + lpFee;
  const out = Math.floor((rOut * inAfterFee) / (rIn + inAfterFee));
  if (out <= 0 || out >= rOut) return { ok: false, err: "bad-quote", gas: 0 };
  // FIX(SETTLE-9 fail-closed): `out < op.minOut` עם minOut=NaN הוא תמיד-false —\n  // קלט-זבל היה עוקף את מגן-ההחלקה בשכבת-הגרעין גם-כן. כעת: לא-סופי או קטן-מהיציאה = דחייה.
  if (op.minOut !== undefined && !(Number.isFinite(op.minOut) && out >= op.minOut)) return { ok: false, err: "min-out", gas: 0 };
  // שימור-ערך: k לא יורד (ברזרבות-אחרי-החלפה כולל עמלת-LP)
  const kBefore = rIn * rOut;
  const kAfter = (rIn + poolIn) * (rOut - out);
  if (kAfter < kBefore) return { ok: false, err: "value-preservation", gas: 0 };

  const c = consume(); if (c) return c;

  addBal(st, op.issuer, assetIn, -amountIn);
  const assetOut = inA ? p.b : p.a;
  addBal(st, op.issuer, assetOut, out);
  if (inA) { p.ra += poolIn; p.rb -= out; } else { p.rb += poolIn; p.ra -= out; }
  p.swaps++; p.feeAccruedTreasury += treasuryFee;
  st.stats.swaps++;
  addBal(st, "treasury", assetIn, treasuryFee);
  st.feeMeter += treasuryFee; // מד-העמלות הכנה — סולם-הערך יקצור מכאן-בלבד

  const price = Math.floor((out * 1000) / amountIn); // µ-פלט ל-1µ-כניסה ×1000 = סקאלה
  const ev: TradeEvent = {
    kind: "swap", base: (inA ? p.a : p.b) as never, quote: (inA ? p.b : p.a) as never,
    price, amountMu: amountIn, taker: op.issuer, at: nowMs,
  };
  return { ok: true, gas: 0, events: [ev] };
}

export function poolRm(st: DexState, op: Op, _consume: () => OpResult | null): OpResult {
  const key = op.pair;
  const p = key ? getPool(st, key) : null;
  const lp = op.lp ?? 0;
  if (!p) return { ok: false, err: "pool-not-found", gas: 0 };
  if (!(lp > 0)) return { ok: false, err: "bad-lp", gas: 0 };
  const lpAsset = LP_ASSET_PREFIX + key;
  if (avail(st, op.issuer, lpAsset as never) < lp) return { ok: false, err: "insufficient-lp", gas: 0 };
  const outA = Math.floor((lp * p.ra) / p.lp);
  const outB = Math.floor((lp * p.rb) / p.lp);
  if (outA <= 0 || outB <= 0) return { ok: false, err: "dust", gas: 0 };
  const c = _consume(); if (c) return c;

  addBal(st, op.issuer, lpAsset, -lp);
  addBal(st, op.issuer, p.a, outA);
  addBal(st, op.issuer, p.b, outB);
  p.ra -= outA; p.rb -= outB; p.lp -= lp;
  return { ok: true, gas: 0 };
}

export { poolKey };
