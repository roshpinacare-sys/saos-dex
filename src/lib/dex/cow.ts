/**
 * cow.ts — CoW-אצווה · מכירות-אצווה-פר-בלוק במחיר-שווק-אחיד (Task 58)
 * ═════════════════════════════════════════════════════════════════════════════
 * מקור: CoW-Swap (מחקר R-56 #7) — "batch auctions with uniform clearing price".
 *
 * למה זה game-changer דווקא כאן: ב-DEX-חוץ סליקת-אצווה דורשת solver חוץ
 * (מטריצה-שלמה של מניפולציות); אצלנו **בונה-הבלוקים הוא ה-solver** —
 * סליקת-שלמים-טהורה בתוך buildBlock, אפס-float · אפס-random · אפס-Date.now,
 * ריפליי-אמת. סנדוויץ'-אטק בלתי-אפשרי מבנית: אין-מסחר-בין-הצבה-לסליקה —
 * ההזמנות נסגרות באותו-הבלוק-עצמו במחיר-אחיד-אחד.
 *
 * אלגוריתם (פר-זוג, פר-בלוק):
 *  1. מחיר-שווק-אחיד p* = אמצע-בין-גבול-הקנייה-הגבוה-ביותר לגבול-המכירה-הנמוך-ביותר.
 *  2. כמות-מותאמת = min(Σקניות-הכוללות-p*, Σמכירות-הכוללות-p*) — חלוקה-יחסית
 *     קנונית (floor + שארית-לאחרון).
 *  3. עודף-המחיר נשאר-אצל-הסוחרים (קונים משלמים-p* < גבול; מוכרים מקבלים-p* > גבול)
 *     — נמדד ומדווח ב-cowStats.surplusMu. אפס-עמלה על-ההתאמה-עצמה.
 *  4. שארית-לא-מותאמת → ברירת-מחדל CoW: המסלול-הטוב-ביותר-בבריכות (batch אטומי
 *     עם מגן-minOut-2%) ואז הספר (פקודת-לימיט רגילה); כשל-קשה → החזר-כנה.
 */
import type { DexState, Op, TradeEvent, CowOrder } from "./kernel";
import { addBal, addLock, bal, notional } from "./kernel";
import { invariant } from "./invariant";
import { walkRoutes } from "./router";
import { legToOp } from "./triggers";

type Exec = (op: Op) => { ok: boolean; err?: string; events?: TradeEvent[] };

const qtyOf = (o: CowOrder): number => o.amount;

/** הסליקה — נקראת-מ-buildBlock אחרי-ה-ops והטיקים. כל-ההזמנות-הפתוחות נסגרות:
 * התאמה במחיר-אחיד, ואז שארית → בריכה → ספר → החזר. nowMs מוזרק-מ-buildBlock
 * (אפס-Date.now בנתיבי-קונצנזוס — אותו-חוק של-matchBook). */
export function cowSettle(st: DexState, exec: Exec, nowMs: number): TradeEvent[] {
  const pending = st.cow ?? [];
  if (pending.length === 0) return [];
  const h = st.height;
  const events: TradeEvent[] = [];
  const stats = st.cowStats ?? { matched: 0, batches: 0, surplusMu: 0, fallbackPool: 0, fallbackBook: 0 };

  // קבוצות לפי זוג (אותה-אוריינטציית base/quote — כנות: הצטלבות-אוריינטציות-הפוכות
  // תיפול-לברירת-המחדל של הבריכות; זה מתועד ולא מוסתר)
  const groups = new Map<string, { buys: CowOrder[]; sells: CowOrder[] }>();
  for (const o of pending) {
    const key = `${o.base}/${o.quote}`;
    const grp = groups.get(key) ?? { buys: [], sells: [] };
    (o.side === "buy" ? grp.buys : grp.sells).push(o);
    groups.set(key, grp);
  }

  for (const key of Array.from(groups.keys()).sort()) {
    const grp = groups.get(key)!;
    grp.buys.sort((a, b) => (b.price - a.price) || (a.seq - b.seq));
    grp.sells.sort((a, b) => (a.price - b.price) || (a.seq - b.seq));

    // שחרור-הערבויות של כל-ההזמנות בקבוצה — הסליקה תשלם מהיתרה-הפנויה
    for (const o of [...grp.buys, ...grp.sells]) {
      addLock(st, o.owner, o.side === "sell" ? o.base : o.quote, -o.lockMu);
    }

    const bestBuy = grp.buys[0];
    const bestSell = grp.sells[0];
    const cross = bestBuy && bestSell && bestBuy.price >= bestSell.price;

    if (cross) {
      // ── מחיר-שווק-אחיד + התאמה-יחסית ──
      const clearPx = Math.floor((bestBuy!.price + bestSell!.price) / 2);
      const qBuys = grp.buys.filter((o) => o.price >= clearPx);
      const qSells = grp.sells.filter((o) => o.price <= clearPx);
      const buyVol = qBuys.reduce((s, o) => s + qtyOf(o), 0);
      const sellVol = qSells.reduce((s, o) => s + qtyOf(o), 0);
      const matched = Math.min(buyVol, sellVol);

      if (matched > 0) {
        // חלוקה-יחסית-קנונית: floor + השארית לאחרון-בסדר-הקנוני
        const alloc = (orders: CowOrder[], vol: number): { o: CowOrder; mu: number }[] => {
          const out: { o: CowOrder; mu: number }[] = [];
          let assigned = 0;
          for (let i = 0; i < orders.length; i++) {
            const o = orders[i];
            const mu = i === orders.length - 1 ? matched - assigned : Math.floor((matched * qtyOf(o)) / vol);
            out.push({ o, mu });
            assigned += mu;
          }
          return out;
        };
        const buyAllocs = alloc(qBuys, buyVol).filter((x) => x.mu > 0);
        const sellAllocs = alloc(qSells, sellVol).filter((x) => x.mu > 0);

        // הקונים משלמים לפי p* — הסה"כ מחולק-למוכרים יחסית-לכמות (שימור-שלמים-מדויק)
        const totalBuyQuote = buyAllocs.reduce((s, x) => s + notional(clearPx, x.mu), 0);
        let sellPaid = 0;
        const sellQuotes = sellAllocs.map((x, i) => {
          if (i === sellAllocs.length - 1) return totalBuyQuote - sellPaid; // השארית-לאחרון
          const q = Math.floor((totalBuyQuote * x.mu) / matched);
          sellPaid += q;
          return q;
        });

        let surplus = 0;
        // קונים: משלמים-p* (מתחת-לגבול — העודף נשאר אצלם), מקבלים-base
        for (const { o, mu } of buyAllocs) {
          const pay = notional(clearPx, mu);
          invariant(bal(st, o.owner, o.quote) >= pay, "cow-negative-balance:buyer");
          addBal(st, o.owner, o.quote, -pay);
          addBal(st, o.owner, o.base, mu);
          // FIX(Task 58 units): העודף בµ-ציטוט-אמת — notional כולל-/1000 (היה-×1000-שקרי)
          surplus += Math.max(0, notional(o.price, mu) - pay);
        }
        // מוכרים: מוסרים-base, מקבלים-מהקרן-המשולמת (מעל-הגבול — העודף שלהם)
        for (let i = 0; i < sellAllocs.length; i++) {
          const { o, mu } = sellAllocs[i];
          const pay = sellQuotes[i];
          invariant(bal(st, o.owner, o.base) >= mu, "cow-negative-balance:seller");
          addBal(st, o.owner, o.base, -mu);
          addBal(st, o.owner, o.quote, pay);
          surplus += Math.max(0, pay - notional(o.price, mu));
        }
        stats.matched += matched;
        stats.surplusMu += surplus;

        // אירועי-מסחר-אמת (טייפ + עדות-מחיר): צמדי-קניה/מכירה לפי-סדר
        const pairs = Math.min(buyAllocs.length, sellAllocs.length);
        for (let i = 0; i < pairs; i++) {
          events.push({
            kind: "fill", base: buyAllocs[i].o.base as never, quote: buyAllocs[i].o.quote as never,
            price: clearPx, amountMu: Math.min(buyAllocs[i].mu, sellAllocs[i].mu),
            taker: buyAllocs[i].o.owner, maker: sellAllocs[i].o.owner, at: nowMs,
          });
        }
        st.journal.push({
          h, t: 0, soldier: "cow", action: "cow_match",
          profitMu: surplus,
          note: `${key}: matched ${matched}µ @ p*=${clearPx} (buys ${buyAllocs.length} · sells ${sellAllocs.length}) · surplus ${surplus}µ לסוחרים`,
        });
      }

      // שאריות-קבוצה-חוצות (מהזמנות-שהשתתפו-חלקית או לא-עברו-את-p*)
      for (const o of grp.buys) {
        const got = Math.floor(matched * qtyOf(o) / Math.max(1, buyVol));
        const rem = qtyOf(o) - (o.price >= (clearPx) ? got : 0);
        if (rem > 0) fallback(st, exec, o, rem, h, stats, events, nowMs);
      }
      for (const o of grp.sells) {
        const got = Math.floor(matched * qtyOf(o) / Math.max(1, sellVol));
        const rem = qtyOf(o) - (o.price <= (clearPx) ? got : 0);
        if (rem > 0) fallback(st, exec, o, rem, h, stats, events, nowMs);
      }
    } else {
      // אין-הצטלבות-כלל — כל-הקבוצה לברירת-המחדל (CoW→AMM→Book)
      for (const o of [...grp.buys, ...grp.sells]) fallback(st, exec, o, qtyOf(o), h, stats, events, nowMs);
    }
  }

  stats.batches += 1;
  st.cowStats = stats;
  st.cow = []; // כל-האצווה נסגרה — אין-סחיבה-בין-בלוקים (ההזמנה-הבאה = אצווה-חדשה)
  return events;
}

/** ברירת-המחדל-הדטרמיניסטית לשארית: בריכות (batch אטומי, minOut 2%) → ספר → החזר-כנה. */
function fallback(st: DexState, exec: Exec, o: CowOrder, rem: number, h: number, stats: NonNullable<DexState["cowStats"]>, events: TradeEvent[], nowMs: number): void {
  if (!(rem > 0)) return;
  const assetIn = o.side === "sell" ? o.base : o.quote;
  const assetOut = o.side === "sell" ? o.quote : o.base;
  const routes = walkRoutes(assetIn, assetOut, rem);
  if (routes.length > 0) {
    routes.sort((a, b) => b.inMu - a.inMu);
    const subs = routes[0].legs
      .map((l, li) => legToOp(l, 200, `cow-fb-${o.seq}-${h}-${li}`))
      .filter((x): x is Op => x !== null);
    if (subs.length > 0) {
      const r = exec({ type: "batch", issuer: o.owner, nonce: `cow-fb-${o.seq}-${h}`, ops: subs });
      if (r.ok) {
        stats.fallbackPool += rem;
        if (r.events) events.push(...r.events);
        st.journal.push({ h, t: 0, soldier: "cow", action: "cow_fallback_pool", note: `cow-${o.seq}: ${rem}µ ${assetIn}→${assetOut} דרך-הבריכות` });
        return;
      }
    }
  }
  // ספר: פקודת-לימיט רגילה (נועלת-מחדש-מהיתרה ששוחררה; חופפת-כ-taker, שארית-נחה)
  const r2 = exec({
    type: "order", issuer: o.owner, nonce: `cow-rest-${o.seq}-${h}`,
    base: o.base as never, quote: o.quote as never, side: o.side,
    price: o.price, amount: rem,
  });
  if (r2.ok) {
    stats.fallbackBook += rem;
    if (r2.events) events.push(...r2.events);
    st.journal.push({ h, t: nowMs, soldier: "cow", action: "cow_fallback_book", note: `cow-${o.seq}: שארית ${rem}µ נחה-על-הספר @${o.price}` });
    return;
  }
  // כשל-קשה (גז/ספר-סגור) — החזרה-כנה-ליתרה (הערבה כבר שוחררה)
  addBal(st, o.owner, assetIn, rem);
  st.journal.push({ h, t: 0, soldier: "cow", action: "cow_refund", note: `cow-${o.seq}: הוחזרו ${rem}µ ${assetIn} (${r2.err ?? "no-route"})` });
}

/** הדוח-החי ל-UI — הכל-מהמצב-האמת */
export function cowState(st: DexState) {
  const stats = st.cowStats ?? { matched: 0, batches: 0, surplusMu: 0, fallbackPool: 0, fallbackBook: 0 };
  return {
    ok: true,
    height: st.height,
    stats,
    pending: (st.cow ?? []).map((o) => ({
      id: o.id, owner: o.owner, base: o.base, quote: o.quote, side: o.side,
      price: o.price, amount: o.amount, lockMu: o.lockMu, atH: o.atH,
    })),
    recent: st.journal.filter((j) => String(j.soldier) === "cow").slice(-12).reverse(),
    honesty: "מחיר-שווק-אחיד-פר-בלוק: עודף-המחיר נשאר-אצל-הסוחרים (אפס-עמלה-על-התאמה), הסליקה בתוך-בונה-הבלוקים — סנדוויץ'-בלתי-אפשרי-מבנית · שארית → בריכות → ספר → החזר-כנה",
  };
}
