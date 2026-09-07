/**
 * book.ts — ספר-הזמנות הריבוני (מורשת saos-dex.ts Task 31):
 *  · sell → נועל amount מהיתרה (escrow) · buy → נועל amount*price ציטוט
 *  · fill תמיד במחיר-המייקר המדויק (אין משטח-ריצה-קדימה)
 *  · הוגנות-זמן: seq עולה · ביטול = בעלים-בלבד · שלמים-בלבד
 *
 * סכמת-נעילות (escrow) מדויקת:
 *  · הצבה: נעילה אחת על מלוא-הכמות (בסיס ל-sell, ציטוט-גבול ל-buy)
 *  · מילוי: שחרור-נעילה + תשלום בפועל בכל-רגל (הנעילה-תמיד מדויקת-בסוף)
 *  · limit-טייקר: נעילה מראש על מלוא-הכמות; שארית נשארת נעולה ונחה בספר
 *  · market-טייקר: אין-נעילה מראש; בדיקת-היתרה לפני-כל-מילוי
 */
import type { DexState, Op, OpResult, TradeEvent } from "./kernel";
import { addBal, addLock, avail, bal, lockedOf, notional } from "./kernel";
import { invariant } from "./invariant";

export interface BookOrder {
  seq: number; id: number; owner: string;
  base: string; quote: string;
  side: "buy" | "sell";
  price: number; // µ-ציטוט ל-1 יחידת-בסיס
  amount: number; // µ בסיס (סה"כ)
  filled: number; // µ בסיס שמולא
  live: boolean;
  nonce: string;
  at: number;
}

const remaining = (o: BookOrder): number => o.amount - o.filled;

export function sortBook(st: DexState, base: string, quote: string, side: "buy" | "sell"): BookOrder[] {
  const same = st.orders.filter((o) => o.live && o.base === base && o.quote === quote && o.side === side);
  same.sort((a, b) => (side === "buy" ? b.price - a.price : a.price - b.price) || a.seq - b.seq);
  return same;
}

export function placeOrder(
  st: DexState, op: Op, nowMs: number,
  consume: () => OpResult | null
): OpResult {
  const base = op.base, quote = op.quote, side = op.side;
  const price = op.price ?? 0, amount = op.amount ?? 0;
  if (!base || !quote || base === quote || (side !== "buy" && side !== "sell"))
    return { ok: false, err: "bad-order", gas: 0 };
  if (op.market) return { ok: false, err: "market-use-fill", gas: 0 };
  if (!(price > 0) || !(amount > 0)) return { ok: false, err: "bad-price-amount", gas: 0 };
  if (st.orders.filter((o) => o.live && o.owner === op.issuer).length >= 24)
    return { ok: false, err: "order-cap", gas: 0 };

  const lockAsset = side === "sell" ? base : quote;
  const lockMu = side === "sell" ? amount : notional(price, amount);
  if (!(lockMu > 0)) return { ok: false, err: "bad-notional", gas: 0 };
  if (avail(st, op.issuer, lockAsset) < lockMu)
    return { ok: false, err: "insufficient-escrow", gas: 0 };

  const c = consume(); if (c) return c;

  addLock(st, op.issuer, lockAsset, lockMu);
  const seq = st.nextSeq++;
  st.orders.push({
    seq, id: seq, owner: op.issuer, base, quote, side,
    price, amount, filled: 0, live: true, nonce: op.nonce, at: nowMs,
  });
  return { ok: true, gas: 0 };
}

export function cancelOrder(st: DexState, op: Op, consume: () => OpResult | null): OpResult {
  const o = st.orders.find((x) => x.id === op.orderId);
  if (!o || !o.live) return { ok: false, err: "order-not-found", gas: 0 };
  if (o.owner !== op.issuer) return { ok: false, err: "not-owner", gas: 0 };
  const c = consume(); if (c) return c;
  const remBase = remaining(o);
  const remQuote = notional(o.price, remBase);
  if (o.side === "sell") addLock(st, o.owner, o.base, -remBase);
  else addLock(st, o.owner, o.quote, -remQuote);
  o.live = false;
  return { ok: true, gas: 0 };
}

/** matchBook — טייקר חוצה את הספר; מילוי במחיר-מייקר; שארית של limit נחה בספר.
 * SECURITY INTENT: כל-הכספים בספר זזים רק-דרך פונקציה זו, ולכן אינווריאנטות-הנעילה
 * קריטיות-כאן ברמת-הברזל:
 *  · נעילת-מראה על מלוא-הערבות (limit) או בדיקת-יתרה לפני-כל-מילוי (market) —
 *    אין-שלב שבו-taker יכול לחייב יותר-ממה שנעול/זמין אצלו (fail-closed).
 *  · מילוי תמיד במחיר-המייקר המדויק: אין-משטח-ריצה-קדימה, אין-סליפ' מלאכותי —
 *    הסליפ' של הספר הוא העלות-האמת, והמערכת אינה רשאית להשמיט אותו.
 *  · איסור-מילוי-עצמי (maker.owner === op.issuer) — מניעת-מניפולציה של ספר-עצמי.
 *  · חוסר-חפיפה → no-cross ולא-שקר: ה-op נכשל לפני-כל-תנועת-ספר (consume אחרי-הבדיקות).
 *  · שארית-limit נחה עם-הנעילה-המדויקת שכבר-נחשבה — אפס-רווח בין נעול למחויב.
 *  · דטרמיניזם: applyOp מריץ את matchBook באופן-דטרמיניסטי — ריפליי מייצר את אותו-הספר בדיוק.
 */
export function matchBook(
  st: DexState, op: Op, nowMs: number,
  consume: () => OpResult | null
): OpResult {
  const base = op.base, quote = op.quote, side = op.side;
  if (!base || !quote || (side !== "buy" && side !== "sell")) return { ok: false, err: "bad-fill", gas: 0 };
  const amount = op.amount ?? 0;
  const limitPx = op.market ? null : (op.price ?? 0);
  if (!(amount > 0)) return { ok: false, err: "bad-amount", gas: 0 };
  if (!op.market && !(limitPx && limitPx > 0)) return { ok: false, err: "bad-price", gas: 0 };

  // ערבות-טייקר: limit → נעילה מראש על מלוא-הכמות; market → בדיקה פר-מילוי
  const isLimit = !op.market;
  const lockAsset = side === "buy" ? quote : base;
  const lockMu = isLimit
    ? (side === "buy" ? notional(limitPx!, amount) : amount)
    : 0;
  if (isLimit && avail(st, op.issuer, lockAsset) < lockMu)
    return { ok: false, err: "insufficient-taker", gas: 0 };

  const opp = sortBook(st, base, quote, side === "buy" ? "sell" : "buy");
  const crosses = (makerPx: number): boolean =>
    op.market ? true : (side === "buy" ? makerPx <= limitPx! : makerPx >= limitPx!);

  const events: TradeEvent[] = [];
  let takerRem = amount;

  for (const maker of opp) {
    if (takerRem <= 0) break;
    if (!crosses(maker.price)) break;
    if (maker.owner === op.issuer) continue; // אסור-מילוי-עצמי
    const qty = Math.min(takerRem, remaining(maker));
    if (qty <= 0) continue;
    const qMu = notional(maker.price, qty);
    if (qMu <= 0) continue;

    /* ── Formal Assertions (Fail-Fast) — חוקי-הברזל לפני-כל-רגל-מילוי ──
     * הפרה כאן = עדות לשחיתות-היגיון-הספר — המערכת זורקת ומתה, לא ממשיכה. */
    // (1) מילוי לעולם לא מתבצע במחיר-גרוע מה-limit של ה-taker (מניעת-בזבוז-כספים)
    invariant(crosses(maker.price), "fill-worse-than-limit");
    // (2) maker לעולם לא ממולא מעבר-לגודלו (אין-הנפקת-נזילות מאוויר)
    invariant(remaining(maker) >= qty, "maker-overfill");
    if (side === "buy") {
      if (isLimit) {
        // שחרור-הערבות של הכמות-הזאת (במחיר-הגבול) + תשלום-בפועל במחיר-המייקר
        addLock(st, op.issuer, quote, -notional(limitPx!, qty));
        addBal(st, op.issuer, quote, -qMu);
      } else {
        if (avail(st, op.issuer, quote) < qMu) break; // נגמר-הציטוט
        addBal(st, op.issuer, quote, -qMu);
      }
      addBal(st, op.issuer, base, qty);
      // מייקר-מוכר: בסיס-נעול יוצא, ציטוט נכנס
      addBal(st, maker.owner, base, -qty);
      addLock(st, maker.owner, base, -qty);
      addBal(st, maker.owner, quote, qMu);
      // (3) חוקי-אי-התחייבות-חריגה: אף-חיוב לא יורד מתחת-לאפס — לא יתרה ולא נעילה
      invariant(lockedOf(st, op.issuer, quote) >= 0, "escrow-underflow:taker-quote");
      invariant(bal(st, op.issuer, quote) >= 0, "negative-balance:taker-quote");
      invariant(lockedOf(st, maker.owner, base) >= 0, "escrow-underflow:maker-base");
      invariant(bal(st, maker.owner, base) >= 0, "negative-balance:maker-base");
    } else {
      if (isLimit) {
        addLock(st, op.issuer, base, -qty);
        addBal(st, op.issuer, base, -qty);
      } else {
        if (avail(st, op.issuer, base) < qty) break;
        addBal(st, op.issuer, base, -qty);
      }
      addBal(st, op.issuer, quote, qMu);
      // מייקר-קונה: ציטוט-נעול יוצא, בסיס נכנס
      addBal(st, maker.owner, quote, -qMu);
      addLock(st, maker.owner, quote, -qMu);
      addBal(st, maker.owner, base, qty);
      // (3) סימטריית-מכירה: אותם-חוקי אי-התחייבות-חריגה
      invariant(lockedOf(st, op.issuer, base) >= 0, "escrow-underflow:taker-base");
      invariant(bal(st, op.issuer, base) >= 0, "negative-balance:taker-base");
      invariant(lockedOf(st, maker.owner, quote) >= 0, "escrow-underflow:maker-quote");
      invariant(bal(st, maker.owner, quote) >= 0, "negative-balance:maker-quote");
    }

    maker.filled += qty;
    if (remaining(maker) <= 0) maker.live = false;
    takerRem -= qty;
    st.stats.fills++;
    events.push({
      kind: "fill", base: base as never, quote: quote as never,
      price: maker.price, amountMu: qty, taker: op.issuer, maker: maker.owner, at: nowMs,
    });
  }

  if (events.length === 0) return { ok: false, err: "no-cross", gas: 0 };
  const c = consume(); if (c) return c;

  // שארית-לימיט נחה בספר — הנעילה-כבר-מדויקת (לא-נוגעים)
  if (isLimit && takerRem > 0) {
    const seq = st.nextSeq++;
    st.orders.push({
      seq, id: seq, owner: op.issuer, base, quote, side,
      price: limitPx!, amount: takerRem, filled: 0, live: true,
      nonce: op.nonce + ":r", at: nowMs,
    });
  }
  st.orders = st.orders.filter((o) => o.live);
  return { ok: true, gas: 0, events };
}

/** order_gc — אוסף-גרוטאות פרוטוקולי (grid98): מונע נפיחת-מצב */
export function gcOrders(st: DexState): number {
  const before = st.orders.length;
  st.orders = st.orders.filter((o) => o.live);
  return before - st.orders.length;
}
