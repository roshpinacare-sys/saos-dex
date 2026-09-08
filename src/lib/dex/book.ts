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
  /** FIX(escrow-dust): מד-הנעילה-הפרטי של-הפקודה (µ, יחידות-נעילה).
   * notional-floor אינו-אדיטיבי → שחרור-פר-רגל השאיר אבק-נעול-פנטום
   * (נתפס-ע"י ביקורת-הסליקה: locked > Σפקודות). מעכשיו: רגל-אחרונה/ביטול
   * משחררים את-מלוא-המד — Σ lockMu של-פקודות-חיות === locked, בדיוק. */
  lockMu: number;
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
    lockMu, // מד-הנעילה-הפרטי — מדויק מהרגע-הראשון
  });
  return { ok: true, gas: 0 };
}

export function cancelOrder(st: DexState, op: Op, consume: () => OpResult | null): OpResult {
  const o = st.orders.find((x) => x.id === op.orderId);
  if (!o || !o.live) return { ok: false, err: "order-not-found", gas: 0 };
  if (o.owner !== op.issuer) return { ok: false, err: "not-owner", gas: 0 };
  const c = consume(); if (c) return c;
  // FIX(escrow-dust): משחררים את-מד-הנעילה-הפרטי של-הפקודה — לא נגזרת-מחודשת
  // (הנגזרת notional(px,rem) השאירה-אבק כשהפקודה מילאה-רגליים במחירים-שונים)
  const rem = remaining(o);
  const held = typeof o.lockMu === "number" && o.lockMu >= 0 ? o.lockMu : (o.side === "sell" ? rem : notional(o.price, rem));
  o.lockMu = 0;
  addLock(st, o.owner, o.side === "sell" ? o.base : o.quote, -held);
  // Formal Assertion: ביטול משחרר רק-נעילה שקיימת — נעילה שלילית = שחיתות-מצב
  invariant(lockedOf(st, o.owner, o.side === "sell" ? o.base : o.quote) >= 0, "escrow-underflow:cancel");
  o.live = false;
  return { ok: true, gas: 0 };
}

/** matchBook — טייקר חוצה את הספר; מילוי במחיר-מייקר; שארית של limit נחה בספר.
 * SECURITY INTENT: כל-הכספים בספר זזים רק-דרך פונקציה זו, ולכן אינווריאנטות-הנעילה
 * קריטיות-כאן ברמת-הברזל:
 *  · נעילת-מראה על מלוא-הערבות (limit) או בדיקת-יתרה לפני-כל-מילוי (market) —
 *    אין-שלב שבו-taker יכול לחייב יותר-ממה שנעול/זמין אצלו (fail-closed).
 *  · gas לפני-מוטציה: consume() נקרא אך-ורק אחרי-אימות-חפיפה-אמת ולפני-כל-שינוי-מצב —
 *    כשל-gas = דחייה-נקייה לחלוטין (סוגר-חור-ריפליי שבו-מילויים-בוצעו בלי-חיוב-nonce).
 *  · מילוי תמיד במחיר-המייקר המדויק: אין-משטח-ריצה-קדימה, אין-סליפ' מלאכותי —
 *    הסליפ' של הספר הוא העלות-האמת, והמערכת אינה רשאית להשמיט אותו.
 *  · איסור-מילוי-עצמי (maker.owner === op.issuer) — מניעת-מניפולציה של ספר-עצמי.
 *  · חוסר-חפיפה → no-cross ולא-שקר: אפס-חיוב, אפס-תנועת-ספר.
 *  · Formal Assertions: מילוי-לעולם לא-גרוע-מה-limit · maker לא-נחפש-מעבר-לגודלו ·
 *    אף-יתרה/נעילה לא יורדת מתחת-לאפס — הפרה = InvariantViolation = HALT (fail-fast).
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

  // שער-כנות לפני-חיוב: קיימת חפיפה-אמת (לא-עצמית, לא-אבק) שתמומש?
  const firstCross = opp.find((m) =>
    crosses(m.price) && m.owner !== op.issuer && remaining(m) > 0 &&
    notional(m.price, Math.min(amount, remaining(m))) > 0
  );
  if (!firstCross) return { ok: false, err: "no-cross", gas: 0 };
  // gas לפני-כל-מוטציה — כשל כאן = דחייה-נקייה, אפס-שינוי-מצב, ה-nonce נשרף (אנטי-ריפליי)
  const c = consume(); if (c) return c;

  const events: TradeEvent[] = [];
  let takerRem = amount;

  // FIX(escrow-dust): שחרור-נעילת-מייקר במדויק — רגל-אחרונה משחררת את-מלוא-מד-הנעילה
  // (כולל-אבק-floor שנצבר ברגליים-קודמות) — Σ lockMu חי === locked נשמר-בדיוק.
  const releaseMakerLock = (maker: BookOrder, qty: number, legMu: number): void => {
    const isFinal = remaining(maker) - qty <= 0;
    const rel = isFinal ? maker.lockMu : Math.min(legMu, maker.lockMu);
    maker.lockMu = Math.max(0, maker.lockMu - rel);
    addLock(st, maker.owner, maker.side === "sell" ? maker.base : maker.quote, -rel);
  };

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
        // FIX(escrow-dust): שחרור-טייקר-לימיט בשיטה-טלסקופית —
        // notional(px,cum+qty) − notional(px,cum) מצטמצם-בדיוק ל-notional(px, filled_total)
        const cumFilled = amount - takerRem;
        addLock(st, op.issuer, quote, -(notional(limitPx!, cumFilled + qty) - notional(limitPx!, cumFilled)));
        addBal(st, op.issuer, quote, -qMu);
      } else {
        if (avail(st, op.issuer, quote) < qMu) break; // נגמר-הציטוט
        addBal(st, op.issuer, quote, -qMu);
      }
      addBal(st, op.issuer, base, qty);
      // מייקר-מוכר: בסיס-נעול יוצא, ציטוט נכנס
      addBal(st, maker.owner, base, -qty);
      releaseMakerLock(maker, qty, qty); // נעילת-מכירה = בסיס-µ — מדויק
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
      releaseMakerLock(maker, qty, qMu); // FIX(escrow-dust): רגל-אחרונה משחררת-אבק-floor
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

  // שארית-לימיט נחה בספר — הנעילה-כבר-מדויקת (לא-נוגעים; ה-gas כבר-נחייב למעלה)
  if (isLimit && takerRem > 0) {
    const seq = st.nextSeq++;
    st.orders.push({
      seq, id: seq, owner: op.issuer, base, quote, side,
      price: limitPx!, amount: takerRem, filled: 0, live: true,
      nonce: op.nonce + ":r", at: nowMs,
      lockMu: side === "sell" ? takerRem : notional(limitPx!, takerRem), // מד-הנעילה-של-השארית
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
