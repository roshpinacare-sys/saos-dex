// COUNTER-GRID — סולמות-נגדיים-מתמטיקה עם חלוקת-הון-פר-צד (Z-87a · plan-only · audit-Z86c פער-b)
// ═══════════════════════════════════════════════════════════════════════════════
// הפער-שנסגר: peg.mjs כבר מייצר שני-צדדים, אבל הגדלים באים מהליכה אחת על
// היתרות — אין חלוקת-הון פר-צד, אין הטיית-מלאי-נגדי, אין אינוואריאנטת-שימור.
// המודול הזה הוא המתכנן הטהור: שני סולמות-מתנגדים (אסקים מול בידים) עם
// תקציבים-פר-צד שנגזרים מיתרות-אמת, הטיית-מלאי-נגדי אופציונלית, וחוקי-ברזל.
//
// חוקי-ברזל:
//   1. PLAN-ONLY — אפס-חתימה, אפס-שידור; קבלה-בלבד. נתיב-הביצוע של peg.mjs/
//      mover.mjs נשאר-כפי-שהוא (כנסיון-לא-נגענו בו — זהירות-ריבונית).
//   2. שימור-הון (האינוואריאנטה): סכום-האסקים ≤ תקציב-המכירה ≤ מלאי-ה-STEEM;
//      סכום-הבידים ≤ תקציב-הקנייה ≤ יתרת-ה-SBD. שני-הצדדים אף-פעם לא חולקים
//      תקציב — חלוקה-פר-צד מלאה, ללא-גלגול-הדדי.
//   3. חוק-הספר (Z-80): הסולמות נבנים עם makerLadder — אסק ≥ bestAsk, ביד ≤ bestBid,
//      והוכחה-מבנית שהסולם נשאר סולם (מונוטוני-ממש).
//   4. הטיית-מלאי-נגדי (אופציונלית): bias ∈ [−1,+1] מטה את חלוקת-התקציבים.
//      מדידה-חיה מוצעת מהמילויים-האמת (bought/sold): מכרנו-יותר → bias-חיובי
//      (הצד-הקונה מקבל יותר תקציב להשלמת-מלאי). הבעלים יכול לעקוף.
//   5. דטרמיניזם מלא: אותן-קלטות → אותה-תוכנית; הזמן מוזרק.

import { makerLadder, normBook } from "./book-law.mjs";
import { r6, num } from "./arb-scan.mjs";

export const COUNTER_POLICY = {
  commitPct: 0.9,        // אחוז-התחייבות מהיתרות (כמו peg.mjs — אחידות-דוקטרינה)
  reserveSteem: 0.5,     // דלק-שמור — לא נמכר לעולם
  askLevels: 5,
  bidLevels: 5,
  askStepBps: 50,        // ריחוק-אסקים כלפי-מעלה
  bidStepBps: 200,       // ריחוק-בידים כלפי-מטה
  askGrowth: 1.5,
  bidGrowth: 1.5,
  minLevelSteem: 1.0,    // סף-אבק פר-רמה
  minLevelSbd: 0.05,
  biasFloor: 0.1,        // תקרת-הטיה: אף-צד לא יורד מתחת ל-10% מהתקציב
  biasCeil: 0.9,
};

/** גורם-נרמול — כך שסכום-הרמות הגיאומטרי שווה בדיוק לתקציב (זהה ל-peg.mjs). */
export function normFactor(levels, growth) {
  let s = 0;
  for (let i = 0; i < levels; i++) s += Math.pow(growth, i);
  return s > 0 ? levels / s : 1;
}

/** הטיה-מוצעת ממילויים-אמת: מכרנו-יותר משקנינו → חיובי (השלמת-מלאי-STEEM). */
export function suggestedBias({ boughtSteem = 0, soldSteem = 0 } = {}) {
  const total = Math.abs(num(boughtSteem)) + Math.abs(num(soldSteem));
  if (!(total > 0)) return 0;
  const bias = (num(soldSteem) - num(boughtSteem)) / total;
  return Math.max(-1, Math.min(1, r6(bias)));
}

export function clampBias(b, policy = COUNTER_POLICY) {
  if (!Number.isFinite(b)) return 0;
  return Math.max(-1, Math.min(1, b));
}

/**
 * התוכנית הטהורה. אפס-IO: הכל מתקבל-מבחוץ, הכל נבדק כאן.
 * anchor: עוגן-רוחב (פאריטי-חוץ או mid-ספר) — המחירים סביבו; Z-80 מנצח תמיד.
 */
export function planCounterGrid({
  balances = { steem: 0, sbd: 0 },
  book = null,
  anchor = null,
  fills = { boughtSteem: 0, soldSteem: 0 },
  biasOverride = null,
  policy = COUNTER_POLICY,
  nowIso = null,
} = {}) {
  const blockers = [];
  const nb = normBook(book);
  const steemBal = num(balances?.steem);
  const sbdBal = num(balances?.sbd);

  if (nb.bestAsk == null || nb.bestBid == null) blockers.push("live two-sided book absent — no counter-grid without the book (Z-80 fail-closed)");
  if (!(anchor > 0)) blockers.push("no anchor (external parity or measured mid) — no honest ladder center");
  if (steemBal <= policy.reserveSteem) blockers.push(`STEEM balance ${steemBal} ≤ reserve ${policy.reserveSteem} — sell side has no real inventory`);
  if (sbdBal <= 0) blockers.push("SBD balance empty — buy side has no real capital");

  const bias = biasOverride != null ? clampBias(biasOverride, policy) : suggestedBias(fills);

  // חלוקת-הון פר-צד — האינוואריאנטה: שני-הצדדים לעולם לא חולקים מטבע
  const sellCapitalSteem = Math.max(0, Math.floor((steemBal - policy.reserveSteem) * policy.commitPct * 1000) / 1000);
  const buyCapitalSbdTotal = Math.max(0, Math.floor(sbdBal * policy.commitPct * 1000) / 1000);
  const bidShare = Math.min(policy.biasCeil, Math.max(policy.biasFloor, 0.5 * (1 + bias)));
  const askShare = Math.min(policy.biasCeil, Math.max(policy.biasFloor, 0.5 * (1 - bias)));
  const askCapitalSteem = Math.floor(sellCapitalSteem * askShare * 1000) / 1000;
  const bidCapitalSbd = Math.floor(buyCapitalSbdTotal * bidShare * 1000) / 1000;

  if (blockers.length > 0) {
    return {
      ok: false, verdict: "COUNTER-GRID-BLOCKED", blockers, bias,
      partitions: { sellCapitalSteem, buyCapitalSbdTotal, askShare, bidShare, askCapitalSteem, bidCapitalSbd },
      plan: null, nowIso: nowIso ?? null,
      execution: "none — plan-only (Z-87a): peg/mover execution paths untouched",
    };
  }

  // סולם-אסקים: מעל-המגע תמיד (makerLadder), גדלים גיאומטריים עם הליכת-תקציב
  const asks = [];
  let askRemaining = askCapitalSteem;
  const askPx = makerLadder({ anchor, book: nb, levels: policy.askLevels, stepBps: policy.askStepBps, side: "ask" });
  for (let i = 1; i <= policy.askLevels; i++) {
    const price = askPx[i - 1] ?? r6(anchor * (1 + (policy.askStepBps * i) / 1e4));
    const want = Math.floor((askCapitalSteem / policy.askLevels) * Math.pow(policy.askGrowth, i - 1) * normFactor(policy.askLevels, policy.askGrowth) * 1000) / 1000;
    const sizeSteem = Math.min(want, Math.floor(askRemaining * 1000) / 1000);
    if (sizeSteem < policy.minLevelSteem) break; // אבק — לא-חוצים, כנה
    askRemaining = r6(askRemaining - sizeSteem);
    asks.push({ side: "ask", level: i, priceSbdPerSteem: price, sizeSteem });
  }

  // סולם-בידים: מתחת-למגע תמיד; תקציב-SBD פר-רמה
  const bids = [];
  let bidRemaining = bidCapitalSbd;
  const bidPx = makerLadder({ anchor, book: nb, levels: policy.bidLevels, stepBps: policy.bidStepBps, side: "bid" });
  for (let i = 1; i <= policy.bidLevels; i++) {
    const price = bidPx[i - 1] ?? r6(anchor * (1 - (policy.bidStepBps * i) / 1e4));
    const want = Math.floor((bidCapitalSbd / policy.bidLevels) * Math.pow(policy.bidGrowth, i - 1) * normFactor(policy.bidLevels, policy.bidGrowth) * 1000) / 1000;
    const spendSbd = Math.min(want, Math.floor(bidRemaining * 1000) / 1000);
    if (spendSbd < policy.minLevelSbd) break;
    bidRemaining = r6(bidRemaining - spendSbd);
    bids.push({ side: "bid", level: i, priceSbdPerSteem: price, spendSbd, sizeSteem: price > 0 ? Math.floor((spendSbd / price) * 1000) / 1000 : 0 });
  }

  const askSteem = r6(asks.reduce((s, a) => s + a.sizeSteem, 0));
  const bidSbd = r6(bids.reduce((s, b) => s + b.spendSbd, 0));

  /* Z-87a כנות-דלק (אותו-דוקטרינה של peg.mjs): תוכנית-ריקה אינה תוכנית —
   * צד-שכל-רמותיו אבק = חוסם-כן "ממתין-לדלק", לא הבטחה ריקה. */
  if (asks.length === 0) blockers.push(`sell side below dust: ladder sum ${askSteem} STEEM < minLevel ${policy.minLevelSteem} — waiting for fuel (honest)`);
  if (bids.length === 0) blockers.push(`buy side below dust: ladder sum ${bidSbd} SBD < minLevel ${policy.minLevelSbd} — waiting for fuel (honest)`);

  // אינוואריאנטת-שימור — הוכחה בכל-תוכנית (הפרה = fail-closed, לא קבלה)
  const invariants = {
    asksWithinSellCapital: askSteem <= askCapitalSteem + 1e-9,
    sellCapitalWithinInventory: askCapitalSteem <= steemBal - policy.reserveSteem + 1e-9,
    bidsWithinBuyCapital: bidSbd <= bidCapitalSbd + 1e-9,
    buyCapitalWithinBalance: bidCapitalSbd <= sbdBal + 1e-9,
    asksMonotonicUp: asks.every((a, i) => i === 0 || a.priceSbdPerSteem > asks[i - 1].priceSbdPerSteem),
    bidsMonotonicDown: bids.every((b, i) => i === 0 || b.priceSbdPerSteem < bids[i - 1].priceSbdPerSteem),
    asksAboveTouch: nb.bestAsk != null && asks.every((a) => a.priceSbdPerSteem >= nb.bestAsk),
    bidsBelowTouch: nb.bestBid != null && bids.every((b) => b.priceSbdPerSteem <= nb.bestBid),
    /* Z-87a הפרדת-צדדים מובנית: שני-הצדדים שואבים-מבריכות-נפרדות (אסקים=STEEM-מלאי,
     * בידים=SBD-מזומן) — שרשרת-החלוקה-המלאה-פר-צד, אף-צד לא מממן את רעהו:
     *   מלאי → תקציב-צד → חלק-הצד → סכום-הסולם (ארבע-החוליות בשרשרת-אחת כנה). */
    sideSeparation:
      askSteem <= askCapitalSteem + 1e-9 && askCapitalSteem <= sellCapitalSteem + 1e-9 && sellCapitalSteem <= Math.max(0, steemBal - policy.reserveSteem) + 1e-9 &&
      bidSbd <= bidCapitalSbd + 1e-9 && bidCapitalSbd <= buyCapitalSbdTotal + 1e-9 && buyCapitalSbdTotal <= sbdBal + 1e-9,
  };
  const allPass = Object.values(invariants).every(Boolean);
  if (!allPass) blockers.push("invariant violation in plan math — refusing to publish (fail-closed)");
  const ok = allPass && blockers.length === 0;

  return {
    ok,
    verdict: ok ? "COUNTER-GRID-PLAN" : "COUNTER-GRID-BLOCKED",
    blockers: ok ? null : blockers,
    nowIso: nowIso ?? null,
    bias: { value: bias, source: biasOverride != null ? "owner-override" : "measured-from-real-fills", bidShare: r6(bidShare), askShare: r6(askShare) },
    partitions: { sellCapitalSteem, buyCapitalSbdTotal, askCapitalSteem, bidCapitalSbd, buyReserveSbd: r6(buyCapitalSbdTotal - bidCapitalSbd), sellReserveSteem: r6(sellCapitalSteem - askCapitalSteem) },
    book: nb,
    anchor,
    plan: { asks, bids, totals: { askSteem, bidSbd } },
    invariants,
    execution: "none — plan-only (Z-87a): peg/mover execution paths untouched",
    law: "opposing ladders with side-scoped capital partition; capital conservation proven per plan; book-law clamps by construction",
  };
}

/* ══ ריצה-חיה keyless: מדידה → תוכנית → קבלת-תוכנית (לא יותר) ═══════════════ */

export async function runCounterGrid({ receipt = true, nowIso = null } = {}) {
  const { measureSnapshot, measureMarks } = await import("./peg.mjs");
  const { loadState } = await import("./engine.mjs");
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const here = dirname(fileURLToPath(import.meta.url));
  const at = nowIso ?? new Date().toISOString();
  const [snap, marks] = await Promise.all([measureSnapshot("headcorner"), measureMarks()]);
  let fills = { boughtSteem: 0, soldSteem: 0 };
  try {
    const rp = loadState()?.feeMeter?.realPnl;
    if (rp) fills = { boughtSteem: num(rp.boughtSteem), soldSteem: num(rp.soldSteem) };
  } catch { /* בלי-מדיניות-מדידה — bias 0 כנה */ }
  const book = snap?.book ?? null;
  const anchor = marks?.parity ?? book?.mid ?? null;
  const doc = planCounterGrid({ balances: snap?.balances ?? { steem: 0, sbd: 0 }, book, anchor, fills, nowIso: at });
  if (receipt) {
    const path = join(here, "state", "counter-grid-plan.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(doc, null, 1) + "\n");
  }
  return doc;
}

/* ── CLI: node grids/counter-grid.mjs [--no-receipt] ──────────────────────── */
if (process.argv[1] && process.argv[1].endsWith("counter-grid.mjs") && !process.argv.includes("--selftest")) {
  try {
    const doc = await runCounterGrid({ receipt: !process.argv.includes("--no-receipt") });
    console.log(`[counter-grid] ${doc.verdict} · bias ${doc.bias?.value ?? "?"} · asks ${doc.plan?.asks?.length ?? 0} (${doc.plan?.totals?.askSteem ?? 0} STEEM) · bids ${doc.plan?.bids?.length ?? 0} (${doc.plan?.totals?.bidSbd ?? 0} SBD)`);
    console.log(`[counter-grid] execution: ${doc.execution}`);
    if (doc.blockers) console.log(`[counter-grid] honest blockers: ${doc.blockers.join(" | ")}`);
  } catch (e) {
    console.error(`[counter-grid] honest failure (plan-only, no side effects beyond receipt): ${String(e?.message ?? e).slice(0, 140)}`);
    process.exit(2);
  }
}
