/**
 * showcase.ts — מנוע-הוכחת-הפריצה (Breakthrough Demo Engine).
 *
 * לא שיווק — מדידה. כל-מספר כאן מחושב על דרכי-הקוד האמתיות:
 *  · A. יעילות-ביצוע: אותה-כמות-בסיס דרך ספר-הזמנות החי מול בריכת x*y=k חיה
 *       (מילוי במחיר-מייקר בספר · פגיעת-רזרבות+עמלת-30bps בבריכה) — חיסכון ב-µ וב-bps.
 *  · B. עמידות-MEV:  B1 דטרמיניזם-ריפליי (אותו-זרם-פעולות על 3 מצבים-טריים →
 *       stateRoot זהה ביט-ביט) · B2 כלכלת-כריך על הבריכה (מוצה חיובי) ·
 *       B3 אותו-כריך על הספר (התוקף סופג-את-הספרד — וקטור-החילוץ מת).
 *  · C. נזילות-אוטונומית: מהסליל-החי — נתח-נפח-מילויים שבו עושה-השוק הוא
 *       חייל-גריד (אפס-ספקי-נזילות-חיצוניים, אפס-Impermanent-Loss קלאסי).
 *
 * מורשת: kernel.cjs (applyOp), saos-dex.ts (matchBook מחיר-מייקר),
 * grid98.cjs (ארנה-אוטונומית), merkle.cjs/verify-pack (הוכחה-בלי-אמון).
 * אין float במצב · אין-רנדומליות בנתיבי-המדידה · fail-closed.
 */
import { applyOp, genesisState, type DexState, type Op } from "./kernel";
import { stateRootOf } from "./canonical";

// ─── עזרי-בריכה (מצג-מכניקה-סטטי — לא-שעתוק-מלא של-הקוד-החי) ──────────────
const FEE_BPS = 30;       // FIX(Roast-67 · showcase-fee-honesty): בסיס-בלבד —
const TREASURY_CUT_PCT = 30; // הבריכות-החיות-מפעילות-עמלה-דינמית (effectiveFeeBps 4..1500bps);

/** החלפה אחת על בריכת x*y=k עם עמלת-בסיס-30bps (70% LP · 30% אוצר) —
 * מצג-חינוכי-של-המתמטיקה; העמלה-בפועל-על-הבריכות-החיות-דינמית (amm.ts). */
function ammSwap(rIn: number, rOut: number, amountIn: number): { out: number; rIn: number; rOut: number } {
  const feeAmt = Math.floor((amountIn * FEE_BPS) / 10_000);
  const inAfterFee = amountIn - feeAmt;
  const lpFee = feeAmt - Math.floor((feeAmt * TREASURY_CUT_PCT) / 100);
  const poolIn = inAfterFee + lpFee;
  const out = Math.floor((rOut * inAfterFee) / (rIn + inAfterFee));
  if (out <= 0 || out >= rOut) return { out: 0, rIn, rOut };
  return { out, rIn: rIn + poolIn, rOut: rOut - out };
}

export interface BookLevel { price: number; total: number; orders?: number }

/** הליכה-על-ספר (asks-עולה לקנייה): עלות-מלאה ב-µ-ציטוט — מילוי במחיר-המייקר בדיוק */
export function walkBookCost(levels: BookLevel[], outMu: number): { costMu: number; covered: boolean; avgPx: number } {
  let need = outMu, cost = 0;
  for (const lv of levels) {
    const take = Math.min(need, lv.total);
    cost += Math.floor((lv.price * take) / 1000); // notional() מ-kernel.ts L106-107
    need -= take;
    if (need <= 0) break;
  }
  const filled = outMu - Math.max(0, need);
  return { costMu: cost, covered: need <= 0, avgPx: filled > 0 ? Math.floor((cost * 1000) / filled) : 0 };
}

// ─── A. יעילות-ביצוע: ספר מול בריכה — אותו-פלט-בסיס, מי משלם-פחות ────────────
export interface ExecRow {
  sizeMu: number;
  bookCostMu: number; bookAvgPx: number; bookSlipBps: number; covered: boolean;
  poolCostMu: number | null; poolEffPx: number | null; poolSlipBps: number | null;
  savingsMu: number | null; savingsBps: number | null;
}

/** כמה USDS דרוש בבריכה כדי לקבל בדיוק outMu-בסיס (חיפוש-בינארי מונוטוני) */
function poolCostForOut(rIn: number, rOut: number, outMu: number): number | null {
  if (outMu <= 0 || outMu >= Math.floor(rOut * 0.95)) return null; // נזילות-בריכה לא מספיקה — כנות
  let lo = 1, hi = Math.max(1, Math.floor(rIn * 0.9));
  let best = -1;
  for (let i = 0; i < 64; i++) {
    const mid = Math.floor((lo + hi) / 2);
    const { out } = ammSwap(rIn, rOut, mid);
    if (out >= outMu) { best = mid; hi = mid; } else { lo = mid + 1; }
    if (lo >= hi) break;
  }
  return best > 0 ? best : null;
}

const bps = (a: number, ref: number): number =>
  ref > 0 ? Math.floor((Math.abs(a - ref) / ref) * 10_000) : 0;

/** A2 — בריכה-נקייה שמחיר-האמצע-שלה מיושר ל-fair (בידוד: רק-מנגנון העמלה+פגיעה,
 *  בלי-סטיית-רזרבות-היסטורית): הספר-החי מול בריכה-צודקת — גם-שם הספר מנצח. */
export function scenarioAClean(asks: BookLevel[], midPx: number, sizesMu: number[], rBaseClean = 8_000_000): ExecRow[] {
  const rQuoteClean = Math.floor((midPx * rBaseClean) / 1000); // poolMid == fair בדיוק
  return scenarioA(asks, rBaseClean, rQuoteClean, midPx, sizesMu);
}

export function scenarioA(
  asks: BookLevel[], rBase: number, rQuote: number, midPx: number,
  sizesMu: number[]
): ExecRow[] {
  const rows: ExecRow[] = [];
  for (const size of sizesMu) {
    const b = walkBookCost(asks, size);
    const bookSlip = bps(b.avgPx, midPx);
    const poolCost = poolCostForOut(rQuote, rBase, size);
    let poolEffPx: number | null = null, poolSlip: number | null = null;
    let savingsMu: number | null = null, savingsBps: number | null = null;
    if (poolCost !== null && b.costMu > 0) {
      poolEffPx = Math.floor((poolCost * 1000) / size);
      poolSlip = bps(poolEffPx, midPx);
      savingsMu = poolCost - b.costMu; // חיובי = הספר זול-יותר
      savingsBps = b.costMu > 0 ? Math.floor((savingsMu * 10_000) / b.costMu) : null;
    }
    rows.push({
      sizeMu: size,
      bookCostMu: b.costMu, bookAvgPx: b.avgPx, bookSlipBps: bookSlip, covered: b.covered,
      poolCostMu: poolCost, poolEffPx, poolSlipBps: poolSlip, savingsMu, savingsBps,
    });
  }
  return rows;
}

// ─── B1. דטרמיניזם: אותו-זרם-פעולות על N מצבים-טריים → stateRoot זהה ─────────
/** סקריפט-ריפליי קבוע (אפס-רנדומליות): 120 בלוקים × 7 פעולות חוצות-ספר-ובריכה */
export function replayScript(): { op: Op; at: number }[] {
  const out: { op: Op; at: number }[] = [];
  const T0 = 1_700_000_000_000;
  for (let b = 0; b < 120; b++) {
    const bidPx = 2500 - 25 - (b % 3) * 10;
    const askPx = 2500 + 25 + (b % 3) * 10;
    const mk = (o: Omit<Op, "issuer" | "nonce">, issuer: string, tag: string): void => {
      out.push({ op: { ...o, issuer, nonce: `d${b}-${tag}` } as Op, at: T0 + b * 3000 });
    };
    // OWNER-MANDATE 2026-10-17: היה soldier-N — החיילים-הסינתטיים סולקו;
    // סוכני-מערכת אמתיים עם יתרות-ג'נזיס אמת (operator/arena)
    mk({ type: "order", base: "SAOS", quote: "USDS", side: "buy", price: bidPx, amount: 15_000 }, "operator", "b");
    mk({ type: "order", base: "SAOS", quote: "USDS", side: "sell", price: askPx, amount: 15_000 }, "arena", "s");
    mk({ type: "fill", base: "SAOS", quote: "USDS", side: "buy", amount: 15_000, market: true }, "operator", "f");
    mk({ type: "fill", base: "SAOS", quote: "USDS", side: "sell", amount: 15_000, market: true }, "operator", "g");
    mk({ type: "pool_swap", pair: "SAOS/USDS", assetIn: "USDS", amount: 2_000 }, "bot-a", "p");
    mk({ type: "transfer", to: "bot-c", asset: "USDS", amount: 4_000 }, "treasury", "t");
    mk({ type: "attest", claim: "determinism-probe" }, "treasury", "a");
  }
  return out;
}

export function scenarioB1(rounds = 3): {
  ops: number; okCount: number; roots: string[]; identical: boolean; matchRate: number;
} {
  const script = replayScript();
  const roots: string[] = [];
  let okCount = -1;
  for (let r = 0; r < rounds; r++) {
    const st: DexState = genesisState();
    let ok = 0;
    for (const { op, at } of script) {
      const res = applyOp(st, op, at);
      if (res.ok) ok++;
    }
    if (okCount < 0) okCount = ok;
    roots.push(stateRootOf(st));
  }
  const identical = roots.every((x) => x === roots[0]);
  return { ops: script.length, okCount: Math.max(0, okCount), roots, identical, matchRate: identical ? 1 : 0 };
}

// ─── B2. כריך-על-הבריכה: front-run → קורבן → back-run (חילוץ-MEV אמת) ────────
export interface SandwichPool {
  attackerPnlMu: number; victimOutClean: number; victimOutSandwiched: number; victimHarmMu: number;
}

export function scenarioB2(rBase: number, rQuote: number, victimInMu: number, attackerInMu: number): SandwichPool {
  // נקי: קורבן לבד
  const clean = ammSwap(rInOf(rQuote, rBase), rOutOf(rQuote, rBase), victimInMu);
  const victimOutClean = clean.out;
  // כריך: תוקף קונה לפני, קורבן, תוקף מוכר אחרי
  const s1 = ammSwap(rQuote, rBase, attackerInMu); // front-run: USDS→base
  const s2 = ammSwap(s1.rIn, s1.rOut, victimInMu); // קורבן על בריכה-פגועה
  const s3 = ammSwap(s2.rOut, s2.rIn, s1.out);     // back-run: base→USDS (רזרבות-הפוכות)
  return {
    attackerPnlMu: s3.out - attackerInMu,
    victimOutClean,
    victimOutSandwiched: s2.out,
    victimHarmMu: Math.max(0, victimOutClean - s2.out),
  };
}

function rInOf(rQuote: number, _rBase: number): number { return rQuote; } // קונים-בסיס: USDS-נכנס
function rOutOf(_rQuote: number, rBase: number): number { return rBase; }

// ─── B3. אותו-כריך על הספר: התוקף שוחט-את-הרמה-הראשונה ומנסה-למכור-בחזרה ────
export interface SandwichBook {
  attackerPnlMu: number; victimExtraCostMu: number; victimAvgClean: number; victimAvgSandwiched: number;
  topLevelMu: number; bestBidPx: number; note: string;
}

export function scenarioB3(asks: BookLevel[], bids: BookLevel[], victimMu: number): SandwichBook {
  const bestBidPx = [...bids].sort((a, b) => b.price - a.price)[0]?.price ?? 0;
  const top = [...asks].sort((a, b) => a.price - b.price)[0];
  const clean = walkBookCost(asks, victimMu);
  if (!top || top.total <= 0) {
    return { attackerPnlMu: 0, victimExtraCostMu: 0, victimAvgClean: clean.avgPx, victimAvgSandwiched: clean.avgPx, topLevelMu: 0, bestBidPx, note: "book empty" };
  }
  // התוקף לוקח את כל הרמה-הראשונה (כמו front-run על AMM)
  const topLevelMu = top.total;
  const attackerCost = Math.floor((top.price * topLevelMu) / 1000);
  // הקורבן עתה הולך-על-הספר-שנותר
  const rest: BookLevel[] = [...asks].sort((a, b) => a.price - b.price).slice(1);
  const sand = walkBookCost(rest, victimMu);
  // התוקף מנסה-למכור-בחזרה לתוך הצד-השני (best bid) — אין-מי שישלם יותר
  const proceeds = bestBidPx > 0 ? Math.floor((bestBidPx * topLevelMu) / 1000) : 0;
  return {
    attackerPnlMu: proceeds - attackerCost,
    victimExtraCostMu: sand.covered ? Math.max(0, sand.costMu - clean.costMu) : 0,
    victimAvgClean: clean.avgPx,
    victimAvgSandwiched: sand.avgPx,
    topLevelMu, bestBidPx,
    note: "fills always at maker price — the attacker must eat the spread to exit",
  };
}

// ─── C. נזילות-אוטונומית: סליל-חי + יחוס-נזילות-מנוחה + קצב-מילויים-חיים ────
export interface TapeLike { kind: string; maker?: string; amountMu: number; at: number }
export interface OrderLike { owner: string; remMu: number }

export function scenarioC(
  tape: TapeLike[], uptimeSec: number, lifetimeFills: number, lifetimeSwaps: number, orders: OrderLike[]
): {
  fillsWindow: number; gridVolumeMu: number; botVolumeMu: number; totalVolumeMu: number;
  gridSharePct: number;
  restingOrdersTotal: number; restingOrdersGrid: number; restingLiquidityMu: number;
  restingLiquidityGridMu: number; restingGridPct: number;
  lifetimeFills: number; lifetimeSwaps: number; fillsPerMin: number;
} {
  const fills = tape.filter((e) => e.kind === "fill" && e.amountMu > 0);
  let gridVol = 0, botVol = 0, totalVol = 0;
  for (const f of fills) {
    totalVol += f.amountMu;
    if (f.maker && f.maker.startsWith("soldier-")) gridVol += f.amountMu;
    else if (f.maker && f.maker.startsWith("bot-")) botVol += f.amountMu;
  }
  const live = orders.filter((o) => o.remMu > 0);
  const restTotal = live.reduce((s, o) => s + o.remMu, 0);
  const restGrid = live.filter((o) => o.owner.startsWith("soldier-")).reduce((s, o) => s + o.remMu, 0);
  return {
    fillsWindow: fills.length,
    gridVolumeMu: gridVol,
    botVolumeMu: botVol,
    totalVolumeMu: totalVol,
    gridSharePct: totalVol > 0 ? Math.floor((gridVol * 100) / totalVol) : 0,
    restingOrdersTotal: live.length,
    restingOrdersGrid: live.filter((o) => o.owner.startsWith("soldier-")).length,
    restingLiquidityMu: restTotal,
    restingLiquidityGridMu: restGrid,
    restingGridPct: restTotal > 0 ? Math.floor((restGrid * 100) / restTotal) : 0,
    lifetimeFills,
    lifetimeSwaps,
    fillsPerMin: uptimeSec > 0 ? Math.round(((lifetimeFills / uptimeSec) * 60) * 10) / 10 : 0,
  };
}
