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
import { addBal, addLock, avail, notional } from "./kernel";
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
      // FIX(R17-b·H1 · איסור-מילוי-עצמי): ה-CoW התאים-נפחית בלי-בדיקת-בעלים — אזרח-אחד
      // עם-שתי-פקודות-מנוגדות-זעירות-במחירים-קיצוניים היה ממלא-את-עצמו **באפס-עמלה**
      // (עלות-הכל: ~120µ גז) ומזרים fill-events לפייד-האורקל → TWAP → סולם-ה-keel
      // (refPrice זז עד 0.5%/בלוק) = מניפולציה-כמעט-חינמית על-מחיר-האמת — בניגוד
      // לכלל-הברזל-של-הספר (book.ts:130 "איסור-מילוי-עצמי"). עתה: נטרול-חפיפה-פר-בעלים —
      // החלק-העצמי-של-כל-אזרח מושמט-מההתאמה (שני-הצדדים) וזורם-ל-fallback (שם הוא
      // יסוחר-מול-אחרים בעמלה-מלאה, או יוחזר כנה) — אין-מילוי-עצמי, אין-אורקל-מזויף.
      const buyByOwner = new Map<string, number>();
      const sellByOwner = new Map<string, number>();
      for (const o of qBuys) buyByOwner.set(o.owner, (buyByOwner.get(o.owner) ?? 0) + qtyOf(o));
      for (const o of qSells) sellByOwner.set(o.owner, (sellByOwner.get(o.owner) ?? 0) + qtyOf(o));
      const selfOverlap = new Map<string, number>();
      for (const [owner, bv] of buyByOwner) {
        const sv = sellByOwner.get(owner) ?? 0;
        const ov = Math.min(bv, sv);
        if (ov > 0) selfOverlap.set(owner, ov);
      }
      // כמות-אפקטיבית-פר-פקודה: חלק-החפיפה-העצמית מופחת-יחסית-מהפקודות-של-אותו-בעלים
      const effOf = (o: CowOrder): number => {
        const ov = selfOverlap.get(o.owner);
        if (!ov || ov <= 0) return qtyOf(o);
        const mine = (o.side === "buy" ? buyByOwner : sellByOwner).get(o.owner) ?? 0;
        if (mine <= 0) return qtyOf(o);
        return Math.max(0, qtyOf(o) - Math.floor((qtyOf(o) * ov) / mine));
      };
      const buyVol = qBuys.reduce((s, o) => s + effOf(o), 0);
      const sellVol = qSells.reduce((s, o) => s + effOf(o), 0);
      const matched = Math.min(buyVol, sellVol);
      // FIX(Roast-64 · remainder-ghost): מפת-ההקצאה-האמתית — floor+שארית-לאחרון,
      // והשאריות-ל-fallback נגזרות-ממנה-בלבד (הזמנה-שלא-עברה-p* = 0-ממולא → הכל-fallback;
      // בעבר floor-מחושב-מחדש נתן-שארית-כפולה-לאחרון → ביצוע-מעבר-לגודל-הפקודה).
      // מוצהרת-ברמת-ההצטלבות — זמינה-גם-כשאין-התאמה (matched=0 → כל-הקבוצה-fallback).
      const filledBy = new Map<number, number>();

      if (matched > 0) {
        // חלוקה-יחסית-קנונית: floor + השארית לאחרון-בסדר-הקנוני
        // FIX(R16-a·M2): האחרון קיבל matched−assigned **בלי-תקרה** — 5-קניות-של-1µ
        // עם matched=3 היו ממלאות-את-האחרונה 3µ (3×-גודלה) → תשלום-מעבר-ל-escrow
        // = invariant-HALT על-רצף-חוקי (DoS), ואצל-מוכרים חיוב-יתר מהיתרה-החופשית.
        // עתה: כל-הקצאה מקורררת ב-qtyOf(o), והשארית מוצבת-מחדש לפקודות-עם-מקום
        // (תמיד-אפשרי: Σroom = vol ≥ matched) — מה שלא-ניתן-לחלק זורם-ל-fallback
        // באופן-טבעי דרך rem = qtyOf − got.
        const alloc = (orders: CowOrder[], vol: number): { o: CowOrder; mu: number }[] => {
          const out: { o: CowOrder; mu: number }[] = orders.map((o) => ({ o, mu: Math.floor((matched * effOf(o)) / vol) }));
          let residual = matched - out.reduce((s, x) => s + x.mu, 0);
          let guard = orders.length + 1;
          while (residual > 0 && guard-- > 0) {
            let moved = 0;
            for (const e of out) {
              if (residual <= 0) break;
              const room = effOf(e.o) - e.mu;
              if (room > 0) { const add = Math.min(room, residual); e.mu += add; residual -= add; moved += add; }
            }
            if (moved === 0) break;
          }
          // residual>0 כאן = בלתי-אפשרי מתמטית (Σroom≥matched) — מוזרם-ל-fallback בכנות
          // FIX(R17-b·L4): הענף-המת-הזה קיבל-שקט — עתה עדות-כנה ביומן גם-עבורו.
          if (residual > 0) {
            filledBy.set(-1, (filledBy.get(-1) ?? 0) + residual);
            st.journal.push({ h, t: nowMs, soldier: "cow", action: "cow_residual_unallocatable", profitMu: 0, note: `${key}: residual ${residual}µ unallocatable (Σroom<matched — mathematically impossible; streamed to fallback honestly, R17-b·L4)` });
          }
          return out;
        };
        const buyAllocs = alloc(qBuys, buyVol).filter((x) => x.mu > 0);
        const sellAllocs = alloc(qSells, sellVol).filter((x) => x.mu > 0);
        for (const x of buyAllocs) filledBy.set(x.o.seq, (filledBy.get(x.o.seq) ?? 0) + x.mu);
        for (const x of sellAllocs) filledBy.set(x.o.seq, (filledBy.get(x.o.seq) ?? 0) + x.mu);


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
        // FIX(Roast-64 · avail-not-bal): הבדיקה הייתה מול bal (כולל-נעילות-אחרות)
        // — תשלום מתוך-כסף-נעול = avail-שלילי שהמבקר תופס רק-אחר-כך. avail-כנה.
        for (const { o, mu } of buyAllocs) {
          const pay = notional(clearPx, mu);
          invariant(avail(st, o.owner, o.quote) >= pay, "cow-insufficient:buyer");
          addBal(st, o.owner, o.quote, -pay);
          addBal(st, o.owner, o.base, mu);
          // FIX(Task 58 units): העודף בµ-ציטוט-אמת — notional כולל-/1000 (היה-×1000-שקרי)
          surplus += Math.max(0, notional(o.price, mu) - pay);
        }
        // מוכרים: מוסרים-base, מקבלים-מהקרן-המשולמת (מעל-הגבול — העודף שלהם)
        for (let i = 0; i < sellAllocs.length; i++) {
          const { o, mu } = sellAllocs[i];
          const pay = sellQuotes[i];
          invariant(avail(st, o.owner, o.base) >= mu, "cow-insufficient:seller");
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
          h, t: nowMs, soldier: "cow", action: "cow_match",
          profitMu: surplus,
          note: `${key}: matched ${matched}µ @ p*=${clearPx} (buys ${buyAllocs.length} · sells ${sellAllocs.length}) · surplus ${surplus}µ לסוחרים`,
        });
      }

      // שאריות-קבוצה-חוצות — FIX(Roast-64): מהמפת-האמתית (לא-floor-מחושב-מחדש);
      // הזמנה-שלא-עברה-את-p* = 0-ממולא (הכל-ל-fallback).
      for (const o of grp.buys) {
        const got = filledBy.get(o.seq) ?? 0;
        const rem = qtyOf(o) - got;
        if (rem > 0) fallback(st, exec, o, rem, h, stats, events, nowMs);
      }
      for (const o of grp.sells) {
        const got = filledBy.get(o.seq) ?? 0;
        const rem = qtyOf(o) - got;
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

/** ברירת-המחדל-הדטרמיניסטית לשארית: בריכות (batch אטומי, מגן-minOut) → ספר → החזר-כנה.
 * FIX(Roast-64 · cow-fallback-units+limit):
 *  · יחידות: rem הוא µ-בסיס-תמיד. לקנייה הכנסת-הראוטר הייתה rem (בסיס!) ככמות-
 *    ציטוט → קניית-×price-עודף (רוקן-יתרות-קונים עד-2.5x). עכשיו: הקצאת-
 *    ציטוט = notional(limit, rem), ה-minOut = rem (הבסיס-שהקונה-דורש).
 *  · גבול-מחיר: ה-fallback דילג על-הגבול של-ההזמנה — הגן-2%-על-ציטוט-הבריכה
 *    הנוכחי אינו-גבול-מחיר. עכשיו: נבדק-מראש שהציטוט-האפקטיבי של-המסלול מכבד
 *    את הגבול (קנייה: מחיר ≤ limit · מכירה: מחיר ≥ limit) — אחרת-ספר בלבד. */
function fallback(st: DexState, exec: Exec, o: CowOrder, rem: number, h: number, stats: NonNullable<DexState["cowStats"]>, events: TradeEvent[], nowMs: number): void {
  if (!(rem > 0)) return;
  const assetIn = o.side === "sell" ? o.base : o.quote;
  const assetOut = o.side === "sell" ? o.quote : o.base;
  // כמות-הכניסה-אמת: מכירה = rem בסיס · קנייה = תקציב-הציטוט-עד-הגבול
  const inMu = o.side === "sell" ? rem : notional(o.price, rem);
  const minOutMu = o.side === "sell" ? notional(o.price, rem) : rem; // הצד-השני-לפי-הגבול
  const routes = walkRoutes(assetIn, assetOut, inMu);
  if (routes.length > 0) {
    routes.sort((a, b) => b.inMu - a.inMu);
    const best = routes[0];
    // כיבוד-הגבול: out האפקטיבי של המסלול חייב לעמוד בגבול הפקודה (fail-closed)
    if (!(best.inMu >= minOutMu)) {
      st.journal.push({ h, t: nowMs, soldier: "cow", action: "cow_fallback_limit", note: `cow-${o.seq}: מסלול-בריכות ${best.inMu}µ < גבול-${minOutMu}µ — עובר-לספר` });
    } else {
      const subs = best.legs
        .map((l, li) => legToOp(l, 200, `cow-fb-${o.seq}-${h}-${li}`))
        .filter((x): x is Op => x !== null);
      if (subs.length > 0) {
        const r = exec({ type: "batch", issuer: o.owner, nonce: `cow-fb-${o.seq}-${h}`, ops: subs });
        if (r.ok) {
          stats.fallbackPool += rem;
          if (r.events) events.push(...r.events);
          st.journal.push({ h, t: nowMs, soldier: "cow", action: "cow_fallback_pool", note: `cow-${o.seq}: ${rem}µ ${assetIn}→${assetOut} דרך-הבריכות (${inMu}µ-כניסה, גבול-${minOutMu}µ)` });
          return;
        }
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
  // FIX(Roast-63): כשל-קשה (גז/ספר-סגור) — אין-צורך-בהחזרה-בכלל.
  // cow_order לא-מחייב-יתרה-בעת-ההצבה (רק-נועל ערבות), והנעילה כבר-שוחררה
  // בראש-הסליקה → הכסף-כבר-פנוי-במלואו. addBal כאן היה **הדפסת-כסף**
  // (אינפלציה-של-Σיתרות → אודיט-שימור-נכשל → HALT). השאר-רק-רישום-כנה.
  // FIX(Roast-65-a · LOW-13): t:0 היה-זמן-מזויף — nowMs (זמן-הבלוק) מוזרק-כמו-כל-נתיבי-הסליקה.
  st.journal.push({ h, t: nowMs, soldier: "cow", action: "cow_refund", note: `cow-${o.seq}: שארית ${rem}µ ${assetIn} נשארת-פנויה-אצל-${o.owner} (${r2.err ?? "no-route"}) — לא-הוחזרה-כפול` });
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
