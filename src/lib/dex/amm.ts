/**
 * amm.ts — בריכות-זרימה ריבוניות (x*y=k, שלמים, floor):
 *  · עמלי-30bps (dex-facts: "עמלי-30bps כמו-הבריכה-הילידית")
 *  · פיצול-עמלה: 70% ל-LP (ברזרבות) · 30% לאוצר — רווח-מונוטוני (grid98)
 *  · שימור-ערך נבדק בכל swap (CHAIN_SPEC) · minOut fail-closed
 */
import type { DexState, Op, OpResult, TradeEvent, Pool } from "./kernel";
import { FEE_BPS, TREASURY_CUT_PCT, DYN_FEE_MIN_BPS, DYN_FEE_MAX_BPS, DYN_FEE_K, addBal, avail, poolKey } from "./kernel";

export const LP_ASSET_PREFIX = "LP|";

export function getPool(st: DexState, key: string): Pool | null {
  return st.pools[key] ?? null;
}

/** Task 54 · עמלה-דינמית: clamp(base + vol/K, MIN, MAX) — V4-hooks/Bunni am-AMM:
 * ככל-שהבריכה-תנודתית-יותר, ספקי-הנזילות מפוצים-יותר (מגן-LVR). */
export function effectiveFeeBps(p: Pool): number {
  const base = p.dynFeeBps ?? FEE_BPS;
  return Math.min(DYN_FEE_MAX_BPS, Math.max(DYN_FEE_MIN_BPS, base));
}

/** מחיר-אמצע מהבריכה: µ-ציטוט ל-1 יחידת-בסיס (ra/bra ב-µ) */
export function poolMid(p: Pool): number {
  if (p.ra <= 0) return 0;
  return Math.floor((p.rb * 1000) / p.ra);
}

/** FIX(SETTLE-14 price-truth): מחיר-אמצע בכיוון-הזוג-המבוקש.
 * poolMid הגולמי מניח p.a=base — אבל poolKey ממיין-אלפביתית וב-USDS/WSTEEM
 * p.a=USDS: ה-mid היה יחס-הפוך (0.42 "WSTEEM-ל-USDS" במקום 2.36 USDS-ל-WSTEEM)
 * והבריכה הייתה מנותקת מהספר ב-6x בלי-שאף-אחד-יראה. עכשיו: אוריינטציה-נכונה-תמיד. */
export function poolMidFor(p: Pool, base: string, quote: string): number {
  if (p.a === base) return p.ra > 0 ? Math.floor((p.rb * 1000) / p.ra) : 0;
  if (p.b === base) return p.rb > 0 ? Math.floor((p.ra * 1000) / p.rb) : 0;
  return 0;
}

/** ציטוט-קריאה-בלבד: פלט צפוי + מחיר-אפקטיבי (µ-ציטוט ל-1 יחידת-בסיס) */
export function quoteOut(p: Pool, assetIn: string, amountIn: number): { out: number; price: number; minOut0: number } | null {
  const inA = assetIn === p.a;
  const rIn = inA ? p.ra : p.rb, rOut = inA ? p.rb : p.ra;
  if (rIn <= 0 || rOut <= 0 || amountIn <= 0) return null;
  const feeAmt = Math.floor((amountIn * effectiveFeeBps(p)) / 10_000); // ציטוט = עמלה-דינמית-אמת (עקביות-ביצוע)
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
  // FIX(Roast-64 · one-sided-donate): ratio-floor ל-0 היה מאפשר pool_add-חד-צדדי
  // — מפקיד-נכס-אחד ומקבל LP (max(1,…)) בשווי-שלילי-למשקים. fail-closed כמו-dust ב-poolRm.
  if (!(amountB > 0)) return { ok: false, err: "dust-add", gas: 0 };
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
  // Task 54 · העמלה-בפועל = עמלה-הדינמית-הנוכחית של-הבריכה (במקום-30bps-קבוע)
  const feeBps = effectiveFeeBps(p);
  const feeAmt = Math.floor((amountIn * feeBps) / 10_000);
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

  const midBefore = Math.floor((rOut * 1000) / rIn);
  addBal(st, op.issuer, assetIn, -amountIn);
  const assetOut = inA ? p.b : p.a;
  addBal(st, op.issuer, assetOut, out);
  if (inA) { p.ra += poolIn; p.rb -= out; } else { p.rb += poolIn; p.ra -= out; }
  p.swaps++; p.feeAccruedTreasury += treasuryFee;
  st.stats.swaps++;
  addBal(st, "treasury", assetIn, treasuryFee);
  st.feeMeter += treasuryFee; // מד-העמלות הכנה — סולם-הערך יקצור מכאן-בלבד

  // Task 54 · עדכון-ה-EWMA + העמלה-הדינמית (אחרי-המסחר — מבוסס-על-הפגיעה-שנמדדה):
  // impactBps = |Δmid|/mid ב-bps → vol = 0.9·EWMA + 0.1·impact → fee = base + vol/K
  {
    const rInAfter = inA ? p.ra : p.rb, rOutAfter = inA ? p.rb : p.ra;
    const midAfter = Math.floor((rOutAfter * 1000) / rInAfter);
    const impactBps = midBefore > 0 ? Math.min(10_000, (Math.abs(midAfter - midBefore) * 10_000) / midBefore) : 0;
    const prev = p.volBpsEwma ?? 0;
    p.volBpsEwma = Math.floor((prev * 9) / 10 + impactBps / 10);
    p.dynFeeBps = Math.min(DYN_FEE_MAX_BPS, Math.max(DYN_FEE_MIN_BPS, FEE_BPS + Math.floor(p.volBpsEwma / DYN_FEE_K)));
  }

  // FIX(Roast-64 · inverted-buy-price): המחיר-היה חושב בלי-כיוון — לקנייה (assetIn=
  // ציטוט) האירוע נשא "כמה-בסיס-ל-1-ציטוט" (ההפך!) והזין את עדות-המחיר (priceSamples
  // → TWAP → חותם-מחיר → סולם) בערך-הפוך. אותו-עניין ש-SETTLE-14 תיקן ב-quoteOut.
  const price = inA ? Math.floor((out * 1000) / amountIn) : Math.floor((amountIn * 1000) / out);
  const ev: TradeEvent = {
    kind: "swap", base: (inA ? p.a : p.b) as never, quote: (inA ? p.b : p.a) as never,
    price, amountMu: amountIn, taker: op.issuer, at: nowMs,
    // FIX(R15-a · twap-buy-weight): amountMu הוא quote-µ בקנייה (assetIn=quote) —
    // muQ=amountMu×price/1000 היה מכפיל את המשקל ×price/1000 בשוגג. עתה: quoteMu =
    // הציטוט-שזרם-בפועל (קנייה: amountIn; מכירה: notional) — משקל-TWAP דימנסיונלי-נכון.
    quoteMu: inA ? amountIn : Math.floor((amountIn * price) / 1000),
  };
  return { ok: true, gas: 0, events: [ev] };
}

export function poolRm(st: DexState, op: Op, _consume: () => OpResult | null): OpResult {
  const key = op.pair;
  const p = key ? getPool(st, key) : null;
  const lp = op.lp ?? 0;
  if (!p) return { ok: false, err: "pool-not-found", gas: 0 };
  if (!(lp > 0)) return { ok: false, err: "bad-lp", gas: 0 };
  // FIX(3-a · D6 · genesis-LP-lock): מדיניות-הג'נזיס "LP-נעול-לצמיתות" (kernel.ts
  // st.locked["treasury"] — "LP נעול-לצמיתות (מורשת pool_lock)") לא הייתה נאכפת.
  // ה-LP-הריבוני כולו (זריעת-ג'נזיס ו-pool_open כאחד) נולד-לאוצר — מימושו היה
  // מוריד-נזילות-ריבונית מאחורי-הגב. הבחירה-המינימלית: דחיית-pool_rmw שמנפיקו
  // האוצר (במקום-נעילה-ב-st.locked — הייתה משברת את זהות-הערבות של-המבקר,
  // locked===Σפקודות-חיות). מימוש-המפקידים-הרגילים אינו-נפגע.
  if (op.issuer === "treasury") return { ok: false, err: "treasury-lp-locked", gas: 0 };
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
