// BOOK-LAW — חוק-הספר (Z-80 · "הספר-הוא-החוק"): אף-פקודה שלנו לא חוצה את הספר-החי
// ═══════════════════════════════════════════════════════════════════════════════
// המדידה-האמיתית (28 מילויי-אמת, אוקטובר 2026) חשפה את מנגנון-הדימום:
//   · קנייה כ-taker ב-0.1029–0.1036 (פאריטי-Coingecko עלה על השוק-הפנימי)
//   · מכירה כ-maker ב-0.0999–0.1007 (פאריטי צנח מתחת לשוק)
//   · realizedSbd אמת: −1.54 SBD על ~2600 STEEM שנסחרו — בית-חרושת להפסד.
// השורש: עיגון-סולם-המחירים לפאריטי-חוץ (יחס מחירי-Coingecko, מקור-רועש:
// SBD דק-מסחר) במקום לספר-הפנימי — המקום-היחיד שבו המילויים באמת קורים.
//
// החוק החדש (מורכב, לא מחליף, את דוקטרינת-הפאריטי):
//   1. אסק חייב לנוח מעל המגע:  px_ask ≥ bestAsk   (ההיפוך-הדווקאי אסור)
//   2. ביד חייבת לנוח מתחת למגע: px_bid ≤ bestBid
//   3. ההידוק לעולם לא מפר את הפאריטי: הידוק-אסק מזיז רק כלפי-מעלה (עדיין
//      מעל-רצפת-הפאריטי), הידוק-ביד רק כלפי-מטה (עדיין מתחת-תקרתו).
//   4. סולם שנשאר סולם: אחרי-הידוק למגע, הרמות נפרשות מחדש מהבסיס-המהודק
//      בריווח-המדורג שלהן — לא חמישה-תאומים על המגע.
//   5. אין-ספר → אין-הידוק אבל גם אין-הצלבה-אפשרית; ריצות-חתימה במוביל
//      מחייבות ספר-חי (fail-closed) — הן יודעות לבקש אותו בעצמן.
//   6. דטרמיניזם מלא: אותן-קלטות → אותה-תוכנית. אפס-שעון, אפס-אקראי.

export const r6 = (v) => Math.round(v * 1e6) / 1e6;
export const r3 = (v) => Math.floor(v * 1000) / 1000;

/* ── חילוץ-ספר נורמלized: bestAsk/bestBid כמספרים או null ─────────────────── */
export function normBook(book) {
  if (book == null || typeof book !== "object") return { bestAsk: null, bestBid: null, mid: null };
  const ask = Number(book.bestAsk ?? NaN);
  const bid = Number(book.bestBid ?? NaN);
  const bestAsk = Number.isFinite(ask) && ask > 0 ? ask : null;
  const bestBid = Number.isFinite(bid) && bid > 0 ? bid : null;
  const mid = bestAsk != null && bestBid != null && bestAsk > bestBid ? r6((bestAsk + bestBid) / 2) : null;
  return { bestAsk, bestBid, mid };
}

/* ── ביקורת-חצייה: האם פקודה-בודדת חוצה את הספר ──────────────────────────── */
/* side="ask": חוצה אם px < bestAsk (תור-מכירה מתחת-למגע-מתבצעת-מיד כ-taker)
   side="bid": חוצה אם px > bestBid */
export function crossAudit({ side, price }, book) {
  const b = normBook(book);
  if (b.bestAsk == null || b.bestBid == null) return { ok: false, why: "book-absent: signing without a live book is forbidden (fail-closed)" };
  if (!(price > 0)) return { ok: false, why: "price-nonpositive" };
  if (side === "ask" && price < b.bestAsk) return { ok: false, why: `ask ${price} < bestAsk ${b.bestAsk} — would cross (taker bleed)`, bestAsk: b.bestAsk };
  if (side === "bid" && price > b.bestBid) return { ok: false, why: `bid ${price} > bestBid ${b.bestBid} — would cross (taker bleed)`, bestBid: b.bestBid };
  return { ok: true };
}

/* ── סולם-מייקר: מרכז-הסולם נהדק אל המגע והרמות נפרשות החוצה ─────────────── */
/* anchor = עוגן-רוחב (פאריטי או ref פנימי) — קובע את מרחק-הרמה-הראשונה מהערך,
   אך לעולם לא יכול לחצות. bestAsk/bestBid מנצחים אם-העוגן-חוצה. */
export function makerLadder({ anchor, book, levels, stepBps, side }) {
  const b = normBook(book);
  const out = [];
  if (!(anchor > 0) || !Number.isFinite(anchor)) return out;
  const s = stepBps / 10_000;
  if (side === "ask") {
    // רמה-1: מקסימום(עוגן×(1+s), bestAsk) — מעל-המגע תמיד; רמות-המשך נפרשות כלפי-מעלה
    let base = anchor * (1 + s);
    if (b.bestAsk != null && base < b.bestAsk) base = b.bestAsk;
    for (let i = 1; i <= levels; i++) out.push(r6(base * (1 + s * (i - 1))));
  } else if (side === "bid") {
    // רמה-1: מינימום(עוגן×(1−s), bestBid) — מתחת-למגע תמיד; נפרשות כלפי-מטה
    let base = anchor * (1 - s);
    if (b.bestBid != null && base > b.bestBid) base = b.bestBid;
    for (let i = 1; i <= levels; i++) out.push(r6(base * (1 - s * (i - 1))));
  }
  return out;
}

/* ── אכיפה על תוכנית-מלאה (asks/bids מ-peg): מחיר מהודק, גודל נשמר ────────── */
/* מחזיר את התוכנית-המהודקת + ראיות (כמה רמות הודקו, אף-אחת לא נזרקה). */
export function enforceMakerPlan(plan, book) {
  const b = normBook(book);
  const ev = { clampedAsks: 0, clampedBids: 0, dropped: 0, book: b };
  const asks = [];
  for (const a of plan?.asks ?? []) {
    if (b.bestAsk != null && a.priceSbdPerSteem < b.bestAsk) {
      asks.push({ ...a, priceSbdPerSteem: b.bestAsk, clampedTo: "bestAsk" });
      ev.clampedAsks++;
    } else asks.push(a);
  }
  const bids = [];
  for (const bi of plan?.bids ?? []) {
    if (b.bestBid != null && bi.priceSbdPerSteem > b.bestBid) {
      bids.push({ ...bi, priceSbdPerSteem: b.bestBid, clampedTo: "bestBid" });
      ev.clampedBids++;
    } else bids.push(bi);
  }
  return { asks, bids, evidence: ev };
}

/* ── מבחן-רווח-המגע: סבב-מלא דרך-המגע-שלנו מרוויח את הספרד, לא משלם אותו ──── */
/* קנייה ב-bestBid ומכירה ב-bestAsk של אותו-ספר → רווח ≥ 0 תמיד (זהות-מבנית). */
export function touchSpreadBps(book) {
  const b = normBook(book);
  if (b.bestAsk == null || b.bestBid == null) return null;
  return Math.floor(((b.bestAsk - b.bestBid) / b.bestBid) * 10_000);
}
