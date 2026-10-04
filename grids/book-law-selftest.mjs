// BOOK-LAW-SELFTEST — שער-העצמי של חוק-הספר (Z-80)
// ═══════════════════════════════════════════════════════════════════
// כל-חוק כאן = מנגנון-הדימום-המדוד שנשלל. אם-חוק-נופל — אסור לדחוף.
// רגרסיה-היסטורית: מילויי-האמת של 2026-10-04 (קניית-taker 0.10365, מכירת-taker
// 0.0999) חייבים להיחסם מתחת-החוק-החדש — לנצח, כמבחן-מוכח.
import { crossAudit, makerLadder, enforceMakerPlan, normBook, touchSpreadBps } from "./book-law.mjs";

let pass = 0; const fails = [];
function rule(name, cond) { if (cond) pass++; else fails.push(name); }
const r6 = (v) => Math.round(v * 1e6) / 1e6;
function mulberry32(a) { return function () { let t = (a += 0x6d2b79f5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/* 1) אין-אסק-חוצה: 600 ספרים-אקראיים × עוגנים-קיצוניים → כל-סולם-אסק מעל המגע */
{
  const rnd = mulberry32(20261004);
  let worst = true;
  for (let t = 0; t < 600; t++) {
    const bid = 0.05 + rnd() * 0.2;
    const spread = 1e-6 + rnd() * 0.02;
    const book = { bestBid: r6(bid), bestAsk: r6(bid + spread) };
    const anchor = 0.03 + rnd() * 0.25; // עוגן-חוץ בטווח-רחב — כולל-חוצים
    const pxs = makerLadder({ anchor, book, levels: 5, stepBps: 50, side: "ask" });
    if (pxs.length !== 5 || pxs.some((p) => p < book.bestAsk - 1e-9)) { worst = false; break; }
    if (pxs[0] !== r6(Math.max(anchor * 1.005, book.bestAsk))) { worst = false; break; }
    if (pxs[1] <= pxs[0]) { worst = false; break; } // הסולם נשאר סולם
  }
  rule("no-ask-cross-600-random-books", worst);
}
/* 2) אין-ביד-חוצה: זהה בהיפוך */
{
  const rnd = mulberry32(777001);
  let worst = true;
  for (let t = 0; t < 600; t++) {
    const ask = 0.05 + rnd() * 0.2;
    const spread = 1e-6 + rnd() * 0.02;
    const book = { bestBid: r6(ask - spread), bestAsk: r6(ask) };
    const anchor = 0.03 + rnd() * 0.25;
    const pxs = makerLadder({ anchor, book, levels: 5, stepBps: 200, side: "bid" });
    if (pxs.length !== 5 || pxs.some((p) => p > book.bestBid + 1e-9)) { worst = false; break; }
    if (pxs[0] !== r6(Math.min(anchor * 0.98, book.bestBid))) { worst = false; break; }
    if (pxs[1] >= pxs[0]) { worst = false; break; }
  }
  rule("no-bid-cross-600-random-books", worst);
}
/* 3) הידוק-שמר-פאריטי: אסק-מהודק ≥ רצפת-העוגן כאשר-העוגן-עצמו מעל המגע;
      וביד-מהודקת ≤ תקרת-העוגן כאשר-העוגן-מתחת למגע (החוקים-מתחברים, לא-מתנגשים) */
{
  const book = { bestBid: 0.1010, bestAsk: 0.1021 };
  const asks = makerLadder({ anchor: 0.0966, book, levels: 5, stepBps: 50, side: "ask" });
  rule("clamp-ask-lands-on-touch", asks[0] === 0.1021);
  rule("clamp-ask-ladder-spreads-up", asks[3] === r6(0.1021 * (1 + 0.005 * 3)) && asks[4] === r6(0.1021 * (1 + 0.005 * 4))); // סולם-ליניארי, רמה-i = +(i−1)·s
  const bids = makerLadder({ anchor: 0.107, book, levels: 5, stepBps: 200, side: "bid" });
  rule("clamp-bid-lands-on-touch", bids[0] === 0.1010);
  rule("clamp-bid-never-pays-above-anchor", bids.every((p) => p <= 0.107));
}
/* 4) רגרסיה-הדימום-המדוד: פקודות-האמת-של-ה-28-מילויים נחסמות */
{
  const bookThen = { bestBid: 0.1007, bestAsk: 0.1021 }; // הספר-המשוער-בעת-המילויים
  rule("regression-taker-buy-0.10365-blocked", crossAudit({ side: "bid", price: 0.10365 }, bookThen).ok === false);
  rule("regression-taker-sell-0.0999-blocked", crossAudit({ side: "ask", price: 0.0999 }, bookThen).ok === false);
  // והחוק-החדש-היה-מציב במקומן פקודות-מייקר:
  const bids = makerLadder({ anchor: 0.107, book: bookThen, levels: 3, stepBps: 200, side: "bid" });
  const asks = makerLadder({ anchor: 0.0966, book: bookThen, levels: 3, stepBps: 50, side: "ask" });
  rule("regression-replacement-maker-only", bids.every((p) => p <= bookThen.bestBid) && asks.every((p) => p >= bookThen.bestAsk));
}
/* 5) ספר-חסר = fail-closed: אין-חתימה בלי-ספר-חי */
{
  rule("book-absent-audit-fails", crossAudit({ side: "ask", price: 0.1021 }, null).ok === false);
  rule("book-empty-audit-fails", crossAudit({ side: "bid", price: 0.1 }, {}).ok === false);
  rule("book-absent-ladder-no-throw", makerLadder({ anchor: 0.1, book: null, levels: 3, stepBps: 50, side: "ask" }).length === 3);
}
/* 6) enforceMakerPlan: מהדק-מחירים, לא-זורק-רמות, לא-נוגע-בגדלים */
{
  const book = { bestBid: 0.1010, bestAsk: 0.1021 };
  const plan = {
    asks: [{ level: 1, priceSbdPerSteem: 0.0971, sizeSteem: 2 }, { level: 2, priceSbdPerSteem: 0.1026, sizeSteem: 1 }],
    bids: [{ level: 1, priceSbdPerSteem: 0.1049, spendSbd: 0.5 }, { level: 2, priceSbdPerSteem: 0.0964, spendSbd: 0.5 }],
  };
  const out = enforceMakerPlan(plan, book);
  rule("plan-ask-clamped-to-touch", out.asks[0].priceSbdPerSteem === 0.1021 && out.asks[0].clampedTo === "bestAsk");
  rule("plan-ask-fine-untouched", out.asks[1].priceSbdPerSteem === 0.1026 && !out.asks[1].clampedTo);
  rule("plan-bid-clamped-to-touch", out.bids[0].priceSbdPerSteem === 0.1010 && out.bids[0].clampedTo === "bestBid");
  rule("plan-bid-fine-untouched", out.bids[1].priceSbdPerSteem === 0.0964 && !out.bids[1].clampedTo);
  rule("plan-sizes-preserved", out.asks[0].sizeSteem === 2 && out.bids[0].spendSbd === 0.5);
  rule("plan-evidence-counts", out.evidence.clampedAsks === 1 && out.evidence.clampedBids === 1 && out.evidence.dropped === 0);
}
/* 7) זהות-רווח-המגע: spread מדוד חיובי-ודיוק */
{
  const book = { bestBid: 0.1010, bestAsk: 0.1021 };
  rule("touch-spread-bps-exact", touchSpreadBps(book) === 108); // (0.1021−0.1010)/0.1010 = 108.91 → floor 108
  rule("touch-spread-null-without-book", touchSpreadBps(null) === null);
}
/* 8) דטרמיניזם: אותן-קלטות → אותו-סולם בדיוק */
{
  const book = { bestBid: 0.1010, bestAsk: 0.1021 };
  const a = makerLadder({ anchor: 0.0966, book, levels: 5, stepBps: 50, side: "ask" });
  const b = makerLadder({ anchor: 0.0966, book, levels: 5, stepBps: 50, side: "ask" });
  rule("determinism-same-ladder", JSON.stringify(a) === JSON.stringify(b));
  const c = makerLadder({ anchor: 0.11, book, levels: 5, stepBps: 50, side: "ask" }); // עוגן-מעל-המגע → לא-מהודק
  rule("determinism-different-anchor-differs", JSON.stringify(a) !== JSON.stringify(c));
  const d = makerLadder({ anchor: 0.0967, book, levels: 5, stepBps: 50, side: "ask" });
  rule("clamp-absorbs-anchor-noise", JSON.stringify(a) === JSON.stringify(d)); // החוק בולע רעש-פאריטי מתחת-למגע
}
/* 9) normBook: ערכים-לא-חוקיים → null, לא-NaN-דלף */
{
  rule("norm-book-garbage-nulls", normBook({ bestAsk: "x", bestBid: -1 }).bestAsk === null && normBook({ bestAsk: "x", bestBid: -1 }).bestBid === null);
  rule("norm-book-mid-exact", normBook({ bestBid: 0.1010, bestAsk: 0.1021 }).mid === 0.10155);
  rule("norm-book-crossed-book-mid-null", normBook({ bestBid: 0.103, bestAsk: 0.1021 }).mid === null);
}
/* 10) אפס-NaN בכל-פלט */
{
  const rnd = mulberry32(424242);
  let clean = true;
  for (let t = 0; t < 200; t++) {
    const bid = 0.05 + rnd() * 0.2, spread = 1e-6 + rnd() * 0.02;
    const book = { bestBid: r6(bid), bestAsk: r6(bid + spread) };
    for (const anchor of [0.02 + rnd() * 0.3, null, 0, -1]) {
      for (const side of ["ask", "bid"]) {
        const pxs = makerLadder({ anchor, book, levels: 4, stepBps: 100, side });
        if (pxs.some((p) => !Number.isFinite(p))) { clean = false; }
      }
    }
  }
  rule("no-nan-in-any-output", clean);
}

console.log(`book-law-selftest: ${pass} passed, ${fails.length} failed`);
if (fails.length > 0) { console.error("FAILED RULES:", fails); process.exit(1); }
