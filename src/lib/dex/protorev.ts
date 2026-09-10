/**
 * protorev.ts — ProtoRev · ארביטראז'-פנימי-דטרמיניסטי (Task 57, נבנה-מחדש-ב-58)
 * ═════════════════════════════════════════════════════════════════════════════
 * מקור: Osmosis ProtoRev — הפרוטוקול עצמו צד את הסטיות ומרוויח מהן, בלי-keepers
 * חוץ ובלי-MEV-חוץ. אצלנו **בונה-הבלוקים הוא ה-ProtoRev**: סריקת-שלמים-טהורה
 * בתוך buildBlock — אפס-float · אפס-random · אפס-Date.now · ריפליי-אמת.
 *
 * מה נסרק:
 *  1. סטיות-ספר↔בריכה (שני-הכיוונים): הבריכה מוכרת זול-מדי מול הצעד-הטוב-בספר
 *     → קנייה-מהבריכה + מכירה-מיידית-כ-taker-לספר (fill-שוק).
 *  2. מחזורי-בריכות USDS→a→b→USDS (עד-3-רגליים) — נדלקים-אוטומטית כשנולדות
 *     בריכות-חדשות (השקות-מוגרות, למשל).
 *
 * הון-שורשי: **שולחן-הארב הוא האוצר-עצמו** — סוחר-מעל-רצפת-שולחן בלבד
 * (PROTREV_DESK_FLOOR); הרווח-נשאר-באוצר-מיד. אפס-מלאי-תקוע: כל-הרצה היא
 * batch-אטומי-אחד (הכל-או-כלום) שמסתיים-ב-USDS.
 *
 * חשבונאות-הכנסה-נקייה: הרווח אינו עמלת-סוואפ → נרשם-ב-revAux.protorevMu
 * (מחוץ-לאינווריאנטה-d של עמלות-בריכות) ו-revenueCycle צורך-אותו-ראשון:
 * 40%-שריפה · 40%-קרן-ve · 20%-אוצר. ארב-מרוויח → ראוטר-שורף. הפלאיהול-מושלם.
 */
import type { DexState, Op, TradeEvent } from "./kernel";
import { bal, notional } from "./kernel";
import { getPool, quoteOut } from "./amm";
import { sortBook } from "./book";
import { poolMidFor } from "./amm";

/* קבועי-מדיניות (קבועי-קוד — דטרמיניסטיים בין-ריצות) */
export const PROTREV_MAX_RUNS_PER_BLOCK = 3; // תקרת-הרצות-פר-בלוק
export const PROTREV_MIN_PROFIT_MU = 150;    // מתחת-לזה — אבק, לא-שווה-גז
export const PROTREV_MAX_BASE_MU = 200_000;  // בסיס-פר-הרצה (גבול-נזק)
export const PROTREV_IMPACT_DIV = 19;        // swapIn ≤ rIn/19 → פגיעה ≤ ~5%
export const PROTREV_EDGE_BPS = 20;          // רווח-מזערי-יחסי (2bps של פאת)
export const PROTREV_MIN_OUT_BPS = 200;      // מגן-minOut-2% לכל-רגל
export const PROTREV_DESK_FLOOR_MU = 100_000; // רצפת-שולחן-הארב (USDS-אוצר)

type Exec = (op: Op) => { ok: boolean; err?: string; events?: TradeEvent[] };

/** עדכון-רשומות-revAux — מקום-אחד (object-identity-safe: אובייקט-חדש תמיד) */
function revAuxPatch(st: DexState, patch: Partial<NonNullable<DexState["revAux"]>>): void {
  st.revAux = {
    protorevMu: st.revAux?.protorevMu ?? 0,
    launchpadMu: st.revAux?.launchpadMu ?? 0,
    runs: st.revAux?.runs ?? 0,
    cycles: st.revAux?.cycles ?? 0,
    rejections: st.revAux?.rejections ?? 0,
    lastH: st.revAux?.lastH ?? 0,
    ...patch,
  };
}

interface Cand {
  kind: "book-pool" | "cycle";
  legs: { venue: string; from: string; to: string; inMu: number; outMu: number }[];
  inMu: number;
  outMu: number;
  profitMu: number;
  edgeBps: number;
  order: number; // סדר-קנוני-לשוויון
}

/** סימולציית-הליכה-על-הספר — FIX(Roast-64 · wrong-side-scan):
 * הסריקה (A) "מכרת-בסיס-לספר" הדמתה מכירה מול ה-ASKS (side "sell") — אבל מכירת-
 * taker מתמלאת-מול-ה-BIDS (matchBook: fill side:"sell" צולב את קוני-הספר).
 * asks ≥ bids → רווח-מדומה-שיטתי → הבאץ' מבצע מכירה-אמת מתחת לסימולציה = הפסד
 * אוצר-אמיתי (לספר-ה-fill אין-מגן-minOut). עכשיו: שני-כיוונים מדויקים:
 *  · bookSellSim — מכירת-base כ-taker → עובר-על ה-BIDS (side "buy").
 *  · bookBuySim — קניית-base כ-taker → עובר-על ה-ASKS (side "sell"), סוכם-עלות.
 * שניהם מדלגים על מייקרים-עצמיים (owner === treasury — איסור-מילוי-עצמי). */
function bookSellSim(st: DexState, base: string, quote: string, baseMu: number): { quoteMu: number; full: boolean } {
  let quoteMu = 0;
  let rem = baseMu;
  for (const m of sortBook(st, base, quote, "buy")) { // הקונים — הצד שמוכרים-אליו
    if (rem <= 0) break;
    const q = m.amount - m.filled;
    if (q <= 0 || m.owner === "treasury") continue;
    const qty = Math.min(rem, q);
    const leg = notional(m.price, qty);
    if (leg <= 0) continue;
    quoteMu += leg;
    rem -= qty;
  }
  return { quoteMu, full: rem <= 0 };
}

/** קניית-base מהספר (taker-buy מול המוכרים): מחזיר עלות-ציטוט-כוללת-שתשולם. */
function bookBuySim(st: DexState, base: string, quote: string, baseMu: number): { quoteMu: number; full: boolean } {
  let quoteMu = 0;
  let rem = baseMu;
  for (const m of sortBook(st, base, quote, "sell")) { // המוכרים — הצד שקונים-ממנו
    if (rem <= 0) break;
    const q = m.amount - m.filled;
    if (q <= 0 || m.owner === "treasury") continue;
    const qty = Math.min(rem, q);
    const leg = notional(m.price, qty);
    if (leg <= 0) continue;
    quoteMu += leg;
    rem -= qty;
  }
  return { quoteMu, full: rem <= 0 };
}

/** כל-המועמדים-הרווחיים-עכשיו — קריאה-טהורה על המצב (סימולציית-שלמים בדיוק
 * כמו-הביצוע: quoteOut === poolSwap מתמטיקה; sims === matchBook-שוק).
 * שני-הכיוונים (Task 58): (A) קנייה-מהבריכה → מכירה-לספר · (B) קנייה-מהספר →
 * מכירה-לבריכה — אותו-באג'ט-גבולות, אותם-מגנים. */
export function protoRevScan(st: DexState): { cands: Cand[]; spreads: ReturnType<typeof protoRevSpreads> } {
  const cands: Cand[] = [];
  let order = 0;

  for (const key of Object.keys(st.pools).sort()) {
    const p = st.pools[key];
    if (!(p.ra > 0) || !(p.rb > 0)) continue;
    // (A) בריכה→ספר: משלמים-quote-לבריכה, מוכרים-base-לספר
    {
      const inMu = Math.min(PROTREV_MAX_BASE_MU, Math.floor(p.rb / PROTREV_IMPACT_DIV));
      if (inMu > 0) {
        const qq = quoteOut(p, p.b, inMu);
        if (qq && qq.out > 0) {
          const baseMu = qq.out;
          const book = bookSellSim(st, p.a, p.b, baseMu);
          if (book.full && book.quoteMu > 0) {
            const profit = book.quoteMu - inMu;
            const edge = Math.floor((profit * 10_000) / inMu);
            if (profit >= PROTREV_MIN_PROFIT_MU && edge >= PROTREV_EDGE_BPS) {
              cands.push({
                kind: "book-pool",
                legs: [
                  { venue: `POOL:${key}`, from: p.b, to: p.a, inMu, outMu: baseMu },
                  { venue: `BOOK:${p.a}/${p.b}`, from: p.a, to: p.b, inMu: baseMu, outMu: book.quoteMu },
                ],
                inMu, outMu: book.quoteMu, profitMu: profit, edgeBps: edge, order: order++,
              });
            }
          }
        }
      }
    }
    // (B) ספר→בריכה: קונים-base-מהספר, מוכרים-לבריכה
    {
      const baseMu = Math.min(PROTREV_MAX_BASE_MU, Math.floor(p.ra / PROTREV_IMPACT_DIV));
      if (baseMu > 0) {
        const book = bookBuySim(st, p.a, p.b, baseMu);
        if (book.full && book.quoteMu > 0) {
          const q = quoteOut(p, p.a, baseMu);
          if (q && q.out > 0) {
            const profit = q.out - book.quoteMu;
            const edge = Math.floor((profit * 10_000) / book.quoteMu);
            if (profit >= PROTREV_MIN_PROFIT_MU && edge >= PROTREV_EDGE_BPS) {
              cands.push({
                kind: "book-pool",
                legs: [
                  { venue: `BOOK:${p.a}/${p.b}`, from: p.b, to: p.a, inMu: book.quoteMu, outMu: baseMu },
                  { venue: `POOL:${key}`, from: p.a, to: p.b, inMu: baseMu, outMu: q.out },
                ],
                inMu: book.quoteMu, outMu: q.out, profitMu: profit, edgeBps: edge, order: order++,
              });
            }
          }
        }
      }
    }
  }

  // (2) מחזורי-בריכות USDS→a→b→USDS (עד-3-רגליים, בריכות-נבדלות)
  const poolList = Object.entries(st.pools).map(([key, p]) => ({ key, p }));
  const neighbors = (a: string): { to: string; key: string }[] => {
    const out: { to: string; key: string }[] = [];
    for (const { key, p } of poolList) {
      if (p.a === a) out.push({ to: p.b, key });
      if (p.b === a) out.push({ to: p.a, key });
    }
    return out;
  };
  const start = "USDS";
  // FIX(Roast-64 · dead-cycle-walk): `visited` הכיל את התחלה והסינון חסם כל-כניסה
  // מחדש-אליה — עומק>0 && cur===start היה-בלתי-אפשרי → אף-מחזור-מועמד-מעולם לא
  // נוצל (revAux.cycles ≡ 0 תיאטרון-פנקס). עכשיו: ניסיון-סגירה מפורש בכל-צומת
  // (רגל-חזרה-ל-USDS) בטרם-הסינון, והסינון חוסם-רק-חזרה-לצומת-לא-סגירה.
  const walk = (cur: string, mu: number, legs: Cand["legs"], visited: Set<string>, usedPools: Set<string>, depth: number): void => {
    if (depth > 0) {
      // סגירת-מחזור: רגל-אחרונה-חוזרת-אל-ההתחלה
      for (const nx of neighbors(cur).sort((x, y) => (x.key < y.key ? -1 : 1))) {
        if (nx.to !== start || usedPools.has(nx.key)) continue;
        const p = getPool(st, nx.key);
        if (!p) continue;
        const q = quoteOut(p, cur, mu);
        if (!q || !(q.out > 0)) continue;
        const closeLegs = [...legs, { venue: `POOL:${nx.key}`, from: cur, to: nx.to, inMu: mu, outMu: q.out }];
        const profit = q.out - closeLegs[0].inMu;
        if (profit >= PROTREV_MIN_PROFIT_MU) {
          const edge = Math.floor((profit * 10_000) / closeLegs[0].inMu);
          if (edge >= PROTREV_EDGE_BPS) {
            cands.push({ kind: "cycle", legs: closeLegs, inMu: closeLegs[0].inMu, outMu: q.out, profitMu: profit, edgeBps: edge, order: order++ });
          }
        }
      }
    }
    if (depth >= 3) return;
    for (const nx of neighbors(cur).sort((x, y) => (x.key < y.key ? -1 : 1))) {
      if (usedPools.has(nx.key)) continue;
      if (nx.to === start) continue; // הסגירה-כבר-נבדקה-מעלה — אין-מעבר-מקרי
      if (visited.has(nx.to)) continue;
      const p = getPool(st, nx.key);
      if (!p) continue;
      const rIn = p.a === cur ? p.ra : p.rb;
      const inLeg = depth === 0 ? Math.min(PROTREV_MAX_BASE_MU, Math.floor(rIn / PROTREV_IMPACT_DIV)) : mu;
      if (!(inLeg > 0)) continue;
      const q = quoteOut(p, cur, inLeg);
      if (!q || !(q.out > 0)) continue;
      const v2 = new Set(visited); v2.add(nx.to);
      const u2 = new Set(usedPools); u2.add(nx.key);
      walk(nx.to, q.out, [...legs, { venue: `POOL:${nx.key}`, from: cur, to: nx.to, inMu: inLeg, outMu: q.out }], v2, u2, depth + 1);
    }
  };
  walk(start, 0, [], new Set([start]), new Set(), 0);

  cands.sort((x, y) => (y.profitMu - x.profitMu) || (x.order - y.order));
  return { cands, spreads: protoRevSpreads(st) };
}

/** טבלת-הסטיות-החיה לתצוגה — אדג'-בר-ביצוע-אמת (אותם-באג'טים כמו-הסריקה):
 * edgeBidBps = רווח-יחסי-אם-קונים-מהבריכה-ומוכרים-לספר · edgeAskBps = ההפך. */
export function protoRevSpreads(st: DexState) {
  const out: {
    key: string; base: string; quote: string; midMu: number;
    bidMu: number | null; askMu: number | null;
    edgeBidBps: number | null; edgeAskBps: number | null; actionable: boolean;
  }[] = [];
  for (const key of Object.keys(st.pools).sort()) {
    const p = st.pools[key];
    const mid = poolMidFor(p, p.a, p.b);
    const buys = sortBook(st, p.a, p.b, "buy").filter((o) => o.owner !== "treasury" && o.amount - o.filled > 0);
    const sells = sortBook(st, p.a, p.b, "sell").filter((o) => o.owner !== "treasury" && o.amount - o.filled > 0);
    const bookBid = buys[0]?.price ?? null;
    const bookAsk = sells[0]?.price ?? null;
    let edgeBid: number | null = null;
    let edgeAsk: number | null = null;
    // (A) בריכה→ספר
    {
      const inMu = Math.min(PROTREV_MAX_BASE_MU, Math.floor(p.rb / PROTREV_IMPACT_DIV));
      if (inMu > 0) {
        const q = quoteOut(p, p.b, inMu);
        if (q && q.out > 0) {
          const book = bookSellSim(st, p.a, p.b, q.out);
          if (book.full) edgeBid = Math.floor(((book.quoteMu - inMu) * 10_000) / inMu);
        }
      }
    }
    // (B) ספר→בריכה
    {
      const baseMu = Math.min(PROTREV_MAX_BASE_MU, Math.floor(p.ra / PROTREV_IMPACT_DIV));
      if (baseMu > 0) {
        const book = bookBuySim(st, p.a, p.b, baseMu);
        if (book.full && book.quoteMu > 0) {
          const q = quoteOut(p, p.a, baseMu);
          if (q && q.out > 0) edgeAsk = Math.floor(((q.out - book.quoteMu) * 10_000) / book.quoteMu);
        }
      }
    }
    out.push({
      key, base: p.a, quote: p.b, midMu: mid,
      bidMu: bookBid, askMu: bookAsk,
      edgeBidBps: edgeBid, edgeAskBps: edgeAsk,
      actionable: (edgeBid !== null && edgeBid >= PROTREV_EDGE_BPS) || (edgeAsk !== null && edgeAsk >= PROTREV_EDGE_BPS),
    });
  }
  return out;
}

/** הרצת-הארב — נקרא-מ-buildBlock (אחרי-ה-ops, לפני-העלאת-הגובה).
 * עד-PROTREV_MAX_RUNS_PER_BLOCK הרצות: הטובה-ביותר → batch אטומי (הכל-או-כלום)
 * שמסתיים-ב-USDS; הרווח-נמדד-מהיתרה-בפועל → revAux. */
export function protoRevTick(st: DexState, exec: Exec): TradeEvent[] {
  const h = st.height;
  if (h <= 0) return [];
  const events: TradeEvent[] = [];
  for (let run = 0; run < PROTREV_MAX_RUNS_PER_BLOCK; run++) {
    const usds = bal(st, "treasury", "USDS");
    if (usds - PROTREV_DESK_FLOOR_MU < PROTREV_MIN_PROFIT_MU) break; // שולחן-הארב-מתחת-לרצפה — כנות
    const { cands } = protoRevScan(st);
    const best = cands[0];
    if (!best) break;
    // תתי-ops: כל-רגל עם מגן-minOut (2% מתחת-לסימולציה — fail-closed נקי)
    const subs: Op[] = [];
    for (const leg of best.legs) {
      if (leg.venue.startsWith("POOL:")) {
        const pair = leg.venue.slice("POOL:".length);
        subs.push({
          type: "pool_swap", issuer: "", nonce: `prv-${h}-${run}-${subs.length}`,
          pair, assetIn: leg.from as never, amount: leg.inMu,
          minOut: Math.floor((leg.outMu * (10_000 - PROTREV_MIN_OUT_BPS)) / 10_000),
        });
      } else {
        // BOOK: רגל-ספר — מוכרים (taker-שוק) או קונים? שני-הנתיבים: מזוהה-לפי-הכיוון
        // from=base → מכירת-base-לספר (fill-מכירה) · from=quote → קניית-base-מהספר (fill-קנייה)
        const [b, q] = leg.venue.slice("BOOK:".length).split("/");
        if (leg.from === b) {
          subs.push({ type: "fill", issuer: "", nonce: `prv-${h}-${run}-${subs.length}`, base: b as never, quote: q as never, side: "sell", market: true, amount: leg.inMu });
        } else {
          // קניית-base-מהספר: fill-שוק בצד-קנייה — amount=baseMu, משלמים-עד-inMu
          // matchBook-שוק קונה במחיר-המייקר; הבאג'ט-הוא-inMu (מובטח-בסימולציה)
          subs.push({ type: "fill", issuer: "", nonce: `prv-${h}-${run}-${subs.length}`, base: b as never, quote: q as never, side: "buy", market: true, amount: leg.outMu });
        }
      }
    }
    const before = bal(st, "treasury", "USDS");
    const r = exec({ type: "batch", issuer: "treasury", nonce: `protorev-${h}-${run}`, ops: subs });
    if (!r.ok) {
      revAuxPatch(st, { rejections: (st.revAux?.rejections ?? 0) + 1 });
      st.journal.push({ h, t: 0, soldier: "protorev", action: "prv_reject", note: `${best.kind}: ${r.err}` });
      break; // אותה-סטייה תידחה שוב — אין-טעם-לנסות-את-השאר בבלוק-הזה
    }
    if (r.events) events.push(...r.events);
    const profit = bal(st, "treasury", "USDS") - before; // מדידה-אמת-מהיתרה
    if (profit > 0) {
      revAuxPatch(st, {
        protorevMu: (st.revAux?.protorevMu ?? 0) + profit,
        runs: (st.revAux?.runs ?? 0) + 1,
        cycles: best.kind === "cycle" ? (st.revAux?.cycles ?? 0) + 1 : (st.revAux?.cycles ?? 0),
        lastH: h,
      });
      st.journal.push({ h, t: 0, soldier: "protorev", action: "prv_run", profitMu: profit, note: `${best.kind} ${best.legs.map((l) => l.venue).join(">")} +${profit}µ (${best.edgeBps}bps)` });
    } else {
      revAuxPatch(st, { rejections: (st.revAux?.rejections ?? 0) + 1 });
      st.journal.push({ h, t: 0, soldier: "protorev", action: "prv_reject", note: `no-profit ${r.err ?? ""}` });
      break;
    }
  }
  return events;
}

/** הדוח-החי ל-UI — הכל-מהמצב-האמת */
export function protoRevState(st: DexState) {
  const { spreads } = protoRevScan(st);
  const inv: { asset: string; mu: number }[] = [];
  for (const [a, v] of Object.entries(st.balances["treasury"] ?? {})) {
    if (a === "USDS" || a.startsWith("LP|") || !(v > 0)) continue;
    inv.push({ asset: a, mu: v });
  }
  inv.sort((x, y) => (x.asset < y.asset ? -1 : 1));
  return {
    ok: true,
    height: st.height,
    state: {
      runs: st.revAux?.runs ?? 0,
      profitMu: st.revAux?.protorevMu ?? 0,
      cycles: st.revAux?.cycles ?? 0,
      rejections: st.revAux?.rejections ?? 0,
      lastH: st.revAux?.lastH ?? 0,
    },
    revAux: {
      protorevMu: st.revAux?.protorevMu ?? 0,
      launchpadMu: st.revAux?.launchpadMu ?? 0,
    },
    desk: {
      account: "treasury",
      credits: st.credits["treasury"] ?? 0,
      usdsMu: bal(st, "treasury", "USDS"),
      deskFloorMu: PROTREV_DESK_FLOOR_MU,
      inventory: inv,
    },
    policy: {
      maxRunsPerBlock: PROTREV_MAX_RUNS_PER_BLOCK,
      minProfitMu: PROTREV_MIN_PROFIT_MU,
      maxBaseMu: PROTREV_MAX_BASE_MU,
      impactPct: Math.floor((10_000 / (PROTREV_IMPACT_DIV + 1)) / 100),
      edgeBps: PROTREV_EDGE_BPS,
    },
    spreads,
    recent: st.journal
      .filter((j) => String(j.soldier) === "protorev")
      .slice(-12)
      .reverse(),
    honesty: "שולחן-הארב הוא האוצר-עצמו: סוחר-מעל-רצפת-בלבד, batch אטומי שמסתיים-ב-USDS, הרווח נמדד-מהיתרה-בפועל → revAux → 40%-שריפה/40%-ve/20%-אוצר — אפס-keepers-חוץ",
  };
}
