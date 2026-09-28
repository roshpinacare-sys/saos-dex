// PEG-SELFTEST — וקטורים דטרמיניסטיים למנוע-הצמדה (B-1)
//
// אפס רשת ואפס זמן-אמת: כל קלט מוזרק, כל זמן קבוע. אותן-קלטות → אותו-מסמך.
// הווקטורים מוכיחים את חוקת-הכנות של המנוע:
//   1. בלי פידי-USD        → סירוב-כנה (אין מחיר-אמת, אין הצעה)
//   2. ref פנימי פג/חסר   → סירוב-כנה (ידיים-בכיס)
//   3. סטיית-פאריטי > רצועה → סירוב (שוק שבור לא נסחר)
//   4. הצעה טהורה          → asks ≥ פאריטי (אף-מכירה מתחת לערך-חוץ),
//                            bids ≤ פאריטי (אף-קנייה מעל ערך-חוץ)
//   5. אין-מכירת-עירום     → Σ asks ≤ תקרת-STEEM · Σ bids ≤ תקרת-SBD
//   6. SBD חסר            → חסם-כנה (אותו-סף של grid-pulse)
//   7. דטרמיניזם           → שתי ריצות על-אותן-קלטות = מסמך זהה בייט
//   8. גשר פנים→חוץ        → הצורה מגיעה מהגרידים, ההון מהשרשרת
//   9. צריכת-טריגרים       → T-PARITY-MOVE מדווח במסמך
//  10. נרמול-גיאומטרי      → סכום-הרמות שווה בדיוק לתקציב

import { computeOffer, DEFAULT_POLICY } from "./peg.mjs";

const t = (name, ok) => {
  console.log(`${ok ? " ✓" : " ✗"} ${name}`);
  if (!ok) process.exitCode = 1;
};

const NOW = "2026-09-28T12:00:00.000Z";
const r6 = (v) => Math.round(v * 1e6) / 1e6;

/* קלטות-עוגן: ref פנימי 0.104111 (מדידת-אמת של feed), פאריטי חוץ 0.104111 */
const MARKS = { steemUsd: 0.15, sbdUsd: 1.44, parity: 0.104167, sources: { steem: "selftest:binance", sbd: "selftest:coingecko" } };
const SNAPSHOT = {
  balances: { steem: 468.605, sbd: 3.2 },
  book: { bestBid: 0.1041, bestAsk: 0.1044, mid: 0.10425, spreadBps: 28 },
  openOrders: 0,
};
const GRID_STATE = {
  market: { refPrice: 0.104111, source: "steem-feed", stale: false },
  feeMeter: { simMu: 13.07, simFills: 33 },
  grids: [
    { id: "mm-core", strategy: "mm-grid", active: true, inventoryMu: 206.54, params: { levels: 3, widthBps: 60, levelMu: 100, growth: 1.5, capMu: 10000 } },
    { id: "anchor-q", strategy: "anchor-quote", active: true, inventoryMu: 45.3, params: { widthBps: 45, levelMu: 120, capMu: 5000 } },
  ],
};
const TRIGGER_BOOK = { publishedAt: NOW, fired: [{ id: "T-PARITY-MOVE", why: "selftest" }] };

const base = { gridState: GRID_STATE, snapshot: SNAPSHOT, marks: MARKS, triggerBook: TRIGGER_BOOK, nowIso: NOW };

/* 1. בלי פידי-USD → סירוב-כנה */
{
  const d = computeOffer({ ...base, marks: { ...MARKS, parity: null, steemUsd: null } });
  t("no USD marks → honest refusal", d.ok === false && d.blocker.some((b) => b.includes("USD marks")));
}

/* 2. ref פנימי פג → ידיים-בכיס */
{
  const d = computeOffer({ ...base, gridState: { ...GRID_STATE, market: { refPrice: 0.1, stale: true } } });
  t("stale internal ref → hands in pockets", d.ok === false && d.blocker.some((b) => b.includes("stale")));
}
{
  const d = computeOffer({ ...base, gridState: { ...GRID_STATE, market: null } });
  t("missing internal ref → honest refusal", d.ok === false && d.blocker.some((b) => b.includes("stale")));
}

/* 3. סטיית-פאריטי מעבר לרצועה → שוק שבור, סירוב */
{
  const d = computeOffer({ ...base, marks: { ...MARKS, parity: 0.05 } });
  t("parity band breach → refuse broken market", d.ok === false && d.blocker.some((b) => b.includes("broken market")));
}

/* 4+5. הצעה טהורה: גבולות-פאריטי + אין-מכירת-עירום */
const good = computeOffer(base);
{
  const parity = MARKS.parity;
  t("offer ready on clean inputs", good.ok === true && good.verdict === "OFFER-READY");
  t("every ask ≥ parity floor (never sell below external value)", good.plan.asks.every((a) => a.priceSbdPerSteem >= parity));
  t("every bid ≤ parity ceiling (never pay above external value)", good.plan.bids.every((b) => b.priceSbdPerSteem <= parity));
  t("bids strictly below asks (clamped book)", Math.max(...good.plan.bids.map((b) => b.priceSbdPerSteem)) < Math.min(...good.plan.asks.map((a) => a.priceSbdPerSteem)));
  t("no naked short: Σ asks ≤ commitable STEEM", good.plan.totals.askSteem <= good.plan.totals.steemCommit + 1e-9);
  t("no overcommit: Σ bids ≤ commitable SBD", good.plan.totals.bidSbd <= good.plan.totals.sbdCommit + 1e-9);
  t("commit math matches grid-pulse formula", good.plan.totals.steemCommit === Math.floor((SNAPSHOT.balances.steem - 0.5) * 0.9 * 1000) / 1000);
}

/* 6. SBD חסר → חסם-כנה (אותו-סף של grid-pulse: 0.05×3) */
{
  const d = computeOffer({ ...base, snapshot: { ...SNAPSHOT, balances: { steem: 468.605, sbd: 0.166 } } });
  t("insufficient SBD → honest blocker", d.ok === false && d.blocker.some((b) => b.includes("SBD inventory")));
}

/* 7. דטרמיניזם: שתי ריצות = מסמך זהה בייט */
{
  const a = computeOffer(base);
  const b = computeOffer(base);
  t("determinism: same inputs → byte-identical doc", JSON.stringify(a) === JSON.stringify(b));
}

/* 8. גשר פנים→חוץ: צורה מהגרידים, הון מהשרשרת */
{
  t("bridge lists active internal grids", good.bridge.activeGrids.includes("mm-core") && good.bridge.strategies.includes("mm-grid"));
  t("bridge utilization measured", good.bridge.utilizationPct > 0 && good.bridge.utilizationPct < 100);
  t("bridge does not inflate real sizes", good.plan.totals.steemCommit === Math.floor((468.605 - 0.5) * 0.9 * 1000) / 1000);
  t("bridge records internal sim fees", good.bridge.simFeesMu === 13.07);
}

/* 9. צריכת-טריגרים: T-PARITY-MOVE מדווח */
{
  t("trigger consumption reported (T-PARITY-MOVE)", good.triggers.consumed.includes("T-PARITY-MOVE"));
  const d = computeOffer({ ...base, triggerBook: null });
  t("missing trigger book → honest note, no crash", d.triggers.consumed.length === 0 && d.triggers.note.includes("not available"));
}

/* 10. נרמול-גיאומטרי: סכום-הרמות שווה בדיוק לתקציב (r3) */
{
  const sumSteem = good.plan.asks.reduce((s, a) => Math.round((s + a.sizeSteem) * 1000) / 1000, 0);
  const sumSbd = good.plan.bids.reduce((s, b) => Math.round((s + b.spendSbd) * 1000) / 1000, 0);
  t("geometric levels normalized to budget (STEEM)", Math.abs(sumSteem - good.plan.totals.steemCommit) < 0.01);
  t("geometric levels normalized to budget (SBD)", Math.abs(sumSbd - good.plan.totals.sbdCommit) < 0.01);
}

/* 11. מדיניות מוזרקת נשמרת (בלי-קסם-מובלע) */
{
  const p = { ...DEFAULT_POLICY, askLevels: 2, bidLevels: 2 };
  const d = computeOffer({ ...base, policy: p });
  t("injected policy respected (2 levels)", d.plan.asks.length === 2 && d.plan.bids.length === 2);
}

/* ═══ B-3: סולם-5-רמות + גרירה דינמית ═══════════════════════════════════ */

/* 12. ברירת-המחדל עלתה ל-5 רמות-לצד */
{
  t("B-3: default ladder is 5 levels per side", good.plan.asks.length === 5 && good.plan.bids.length === 5);
}

/* 13. גרירה ניטרלית: אין-ספר (spreadBps חסר) → k=1 והרמה-1 במרחק-הבסיס */
{
  const d = computeOffer({ ...base, snapshot: { ...SNAPSHOT, book: { ...SNAPSHOT.book, spreadBps: null } } });
  const l1Ask = r6(MARKS.parity * (1 + DEFAULT_POLICY.askStepBps / 10000));
  const l1Bid = r6(MARKS.parity * (1 - DEFAULT_POLICY.bidStepBps / 10000));
  t("B-3: no book → neutral drag k=1", d.drag.k === 1 && d.drag.spreadBps === null);
  t("B-3: neutral drag keeps base spacing", d.plan.asks[0].priceSbdPerSteem === l1Ask && d.plan.bids[0].priceSbdPerSteem === l1Bid);
}

/* 14. גרירה דינמית: פיזור-2000bps → k=2, ריחוק-הרמות כפול */
{
  const d = computeOffer({ ...base, snapshot: { ...SNAPSHOT, book: { ...SNAPSHOT.book, spreadBps: 2000 } } });
  const l1BidWide = r6(MARKS.parity * (1 - (DEFAULT_POLICY.bidStepBps * 2) / 10000));
  t("B-3: wide book drags ladder (k=2)", d.drag.k === 2 && d.drag.effBidStepBps === DEFAULT_POLICY.bidStepBps * 2);
  t("B-3: dragged level-1 bid priced wider", d.plan.bids[0].priceSbdPerSteem === l1BidWide);
}

/* 15. תקרת-גרירה: פיזור-קיצוני → k נעצר ב-dragMax */
{
  const d = computeOffer({ ...base, snapshot: { ...SNAPSHOT, book: { ...SNAPSHOT.book, spreadBps: 100000 } } });
  t("B-3: drag capped at dragMax", d.drag.k === DEFAULT_POLICY.dragMax);
}

/* 16. משמעת-הפאריטי שרדה את הגרירה המקסימלית */
{
  const d = computeOffer({ ...base, snapshot: { ...SNAPSHOT, book: { ...SNAPSHOT.book, spreadBps: 100000 } } });
  t("B-3: parity discipline survives max drag", d.plan.asks.every((a) => a.priceSbdPerSteem >= MARKS.parity) && d.plan.bids.every((b) => b.priceSbdPerSteem <= MARKS.parity));
  const sumSteem = d.plan.asks.reduce((s, a) => Math.round((s + a.sizeSteem) * 1000) / 1000, 0);
  const sumSbd = d.plan.bids.reduce((s, b) => Math.round((s + b.spendSbd) * 1000) / 1000, 0);
  t("B-3: budgets hold under max drag", Math.abs(sumSteem - d.plan.totals.steemCommit) < 0.01 && Math.abs(sumSbd - d.plan.totals.sbdCommit) < 0.01);
}

/* 17. דטרמיניזם עם גרירה: שתי ריצות על-אותו-ספר → מסמך זהה */
{
  const inputs = { ...base, snapshot: { ...SNAPSHOT, book: { ...SNAPSHOT.book, spreadBps: 640 } } };
  t("B-3: determinism holds with drag", JSON.stringify(computeOffer(inputs)) === JSON.stringify(computeOffer(inputs)));
}

console.log(process.exitCode === 1 ? "PEG-SELFTEST: FAIL" : "PEG-SELFTEST: PASS");
