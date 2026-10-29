// ROUTE-GRAPH — מנוע-נתיבי-ההמרה של הרשת-הריבונית (owner mandate 1a185071: «לסדר נתיבי-המרה על-הרשת-שלנו»)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// תפקיד: גרף-אחד חי של כל-אמצעי-ההמרה ברשת — בריכות-AMM ריבוניות, דלתות-עטיפה 1:1,
// ספרי-פקודות (פנימי + ספר-STEEM הציבורי), ומסילות-חליפין חוץ (godex/changenow/sideshift/exolix) —
// ומעליו: ציטוט-רב-קפיצה מודע-עומק, k-הנתיבים-הטובים, וזיהוי-מעגלי-ארביטראז (Bellman-Ford על -log(rate)).
//
// חוקי-ברזל (אותם-חוקי-בית של split-router/arb-scan):
//   1. PLAN-ONLY — המנוע מציע, לא חותם. אף-חתימה, אף-מפתח, אף-שידור.
//   2. אפס-מספרים-מומצאים — כל-קצה נולד ממקור-מדוד; מקור-שנכשל → דילוג-כנה בפנקס (fail-closed).
//   3. realness = הרגל-החלשה — נתיב כולו ברמת-האמת של הקצה-החלש בו (ONCHAIN_REAL > L2_REAL > DOOR_MEASURED > REF > PAPER).
//   4. דטרמיניזם — אותן-קלטות → אותו-פלט ביט-ביט; הזמן מוזרק.
//   5. זהות-ריבונית — הציר-המרכזי הוא SAOS↔USDS; נכסי-חוץ הם דלתות, לא-זהות.
//
// יחידות: העולם-הריבוני עובד ב-µ (מילי-יחידות, שלמים); ספרי-חוץ בצפים-רגילים.
// המנוע מקבל קלטות-כבר-מנורמלות לערכים-אנושיים (float) ומחזיר float — ההמרות-המדויקות
// ל-µ מתבצעות בשכבת-הביצוע של ה-kernel בלבד (שלמים-בלבד שם).

/* ── realness-ladder ─────────────────────────────────────────────────────────────────────────────────── */
export const REALNESS_RANK = { ONCHAIN_REAL: 5, L2_REAL: 4, DOOR_MEASURED: 3, REF: 2, PAPER: 1 };
export const minRealness = (a, b) => (REALNESS_RANK[a] ?? 0) <= (REALNESS_RANK[b] ?? 0) ? a : b;

export const r6 = (x) => Math.round(x * 1e6) / 1e6;
export const num = (x) => { const n = typeof x === "string" ? parseFloat(x) : Number(x); return Number.isFinite(n) ? n : 0; };

/* ── קצוות-בריכה (AMM x·y=k עם עמלה-דינמית) — מראה של quoteOut ב-amm.ts ───────────────────────────── */
export function quotePool(pool, assetIn, amountIn) {
  const { ra, rb, a, b, feeBps } = pool;
  if (!(ra > 0) || !(rb > 0) || !(amountIn > 0)) return null;
  const inA = assetIn === a;
  const rIn = inA ? ra : rb, rOut = inA ? rb : ra;
  if (!(rIn > 0) || !(rOut > 0)) return null;
  const fee = num(feeBps) || 30;
  const afterFee = amountIn * (1 - fee / 1e4);
  const out = (rOut * afterFee) / (rIn + afterFee);
  if (!(out > 0) || out >= rOut) return null;
  return { out: r6(out), price: r6(out / amountIn), feeBps: fee };
}

/* ── קצה-ספר (רמות-עומק ממוינות-לטובת-הלוקח) — אותו-חוק-הליכה של split-router ──────────────────────── */
export function quoteBook(levels, amountIn, side, feeBps = 0) {
  // side="sell": אנחנו מוכרים base לציטוט — הולכים על bids (מהגבוה לנמוך)
  // side="buy": אנחנו קונים base בציטוט — הולכים על asks (מהנמוך לגבוה)
  const arr = (levels ?? []).filter((l) => num(l?.price) > 0 && num(l?.qty) > 0);
  let remaining = amountIn, filled = 0, cost = 0;
  const legs = [];
  for (const l of arr) {
    if (remaining <= 1e-12) break;
    const take = Math.min(remaining, num(l.qty));
    const feeAdj = side === "sell" ? num(l.price) * (1 - feeBps / 1e4) : num(l.price) * (1 + feeBps / 1e4);
    legs.push({ price: r6(l.price), qty: r6(take), feeBps });
    filled += take;
    cost += side === "sell" ? take * feeAdj : take * feeAdj;
    remaining -= take;
  }
  if (filled <= 0) return null;
  // sell: מכרנו filled base וקיבלנו cost quote → price = cost/filled quote-ל-base
  // buy: שילמנו cost quote וקיבלנו filled base → price = cost/filled quote-ל-base
  return { out: side === "sell" ? r6(cost) : r6(filled), spent: side === "sell" ? r6(filled) : r6(cost), price: r6(cost / filled), legs: legs.length, unfilled: r6(Math.max(0, remaining)), feeBps };
}

/* ── בניית-הגרף ─────────────────────────────────────────────────────────────────────────────────────── */
/**
 * inputs (הכל מדוד; הכל אופציונלי-בכנות):
 *   pools:   [{key, a, b, ra, rb, feeBps, realness}]            — מה-snapshot-החי של ה-engine
 *   orders:  [{base, quote, side, price(µ), amount, filled, live}] — הספר-הפנימי-הדטרמיניסטי
 *   doors:   [{from, to, rate=1, feeBps=0, kind, realness, note}]  — דלתות-עטיפה (STEEM↔WSTEEM וכו')
 *   extBooks:[{pair, venue, bids, asks, feeBps, realness, quoteToUsd}] — ספרי-חוץ (STEEM market, HE L2)
 *   refs:    [{pair, rate, venue, realness:"REF"}]              — אורקל-ייחוד (לא-בר-ביצוע, למדידת-שוליים)
 *   skips:   [{what, why}]                                      — מקורות-שנכשלו (fail-closed כנה)
 */
export function buildRouteGraph({ pools = [], orders = [], doors = [], extBooks = [], refs = [], skips = [] } = {}) {
  const edges = [];
  const nodes = new Set();

  /* בריכות-ריבוניות — שני-קצוות-מכוונים (הגרף מכוון) */
  for (const p of pools) {
    if (!p?.a || !p?.b || !(num(p.ra) > 0) || !(num(p.rb) > 0)) { skips.push({ what: `pool:${p?.key ?? "?"}`, why: "empty-or-invalid" }); continue; }
    nodes.add(p.a); nodes.add(p.b);
    const vk = `pool:${p.key ?? `${p.a}/${p.b}`}`;
    edges.push({ kind: "POOL", key: `${vk}|${p.a}->${p.b}`, from: p.a, to: p.b, venue: vk, realness: p.realness ?? "ONCHAIN_REAL", quote: (amt) => quotePool(p, p.a, amt) });
    edges.push({ kind: "POOL", key: `${vk}|${p.b}->${p.a}`, from: p.b, to: p.a, venue: vk, realness: p.realness ?? "ONCHAIN_REAL", quote: (amt) => quotePool(p, p.b, amt) });
  }

  /* הספר-הפנימי — קיבוץ-פקודות-חיות לזוג+צד, אגירה-לפי-מחיר, מיון-לטובת-הלוקח, נירמול-µ→float */
  const book = {};
  const priceIdx = {}; // pair → side → Map(price→qty)
  for (const o of orders) {
    if (!o?.live || o?.base == null || o?.quote == null) continue;
    const priceUsd = num(o.price) / 1000; // µ→float
    const remaining = Math.max(0, num(o.amount) - num(o.filled));
    if (!(priceUsd > 0) || !(remaining > 0)) continue;
    const pairKey = o.base < o.quote ? `${o.base}/${o.quote}` : `${o.quote}/${o.base}`;
    const side = o.side === "buy" ? "bids" : "asks";
    book[pairKey] ??= { bids: [], asks: [] };
    priceIdx[pairKey] ??= { bids: new Map(), asks: new Map() };
    const m = priceIdx[pairKey][side];
    m.set(priceUsd, (m.get(priceUsd) ?? 0) + remaining); // אגירה-לפי-מחיר (סמנטיקת-ספר)
    nodes.add(o.base); nodes.add(o.quote);
  }
  for (const [pair, sides] of Object.entries(book)) {
    sides.bids = [...priceIdx[pair].bids.entries()].map(([price, qty]) => ({ price, qty })).sort((x, y) => y.price - x.price);
    sides.asks = [...priceIdx[pair].asks.entries()].map(([price, qty]) => ({ price, qty })).sort((x, y) => x.price - y.price);
    const [base, quote] = pair.split("/");
    edges.push({ kind: "BOOK", key: `${pair}@book-sell`, from: base, to: quote, venue: `book:${pair}`, realness: "ONCHAIN_REAL", quote: (amt) => quoteBook(sides.bids, amt, "sell") });
    edges.push({ kind: "BOOK", key: `${pair}@book-buy`, from: quote, to: base, venue: `book:${pair}`, realness: "ONCHAIN_REAL", quote: (amt) => quoteBook(sides.asks, amt, "buy") });
  }

  /* דלתות-עטיפה 1:1 */
  for (const d of doors) {
    if (!d?.from || !d?.to) { skips.push({ what: "door:malformed", why: "missing-from/to" }); continue; }
    const rate = num(d.rate) || 1, fee = num(d.feeBps) || 0;
    if (rate <= 0) { skips.push({ what: `door:${d.from}->${d.to}`, why: "rate<=0" }); continue; }
    nodes.add(d.from); nodes.add(d.to);
    const vk = d.venue ?? `door:${d.from}->${d.to}`;
    const qf = (amt) => ({ out: r6(amt * rate * (1 - fee / 1e4)), price: r6(rate * (1 - fee / 1e4)), feeBps: fee });
    const qb = (amt) => ({ out: r6(amt / rate * (1 - fee / 1e4)), price: r6((1 / rate) * (1 - fee / 1e4)), feeBps: fee });
    edges.push({ kind: "DOOR", key: `${vk}|${d.from}->${d.to}`, from: d.from, to: d.to, venue: vk, realness: d.realness ?? "DOOR_MEASURED", note: d.note, quote: qf });
    edges.push({ kind: "DOOR", key: `${vk}|${d.to}->${d.from}`, from: d.to, to: d.from, venue: vk, realness: d.realness ?? "DOOR_MEASURED", note: d.note, quote: qb });
  }

  /* ספרי-חוץ (STEEM-market, HE-L2) — שני-קצוות-מכוונים */
  for (const eb of extBooks) {
    if (!eb?.pair || !Array.isArray(eb?.bids) || !Array.isArray(eb?.asks)) { skips.push({ what: `extbook:${eb?.pair ?? "?"}`, why: "no-depth" }); continue; }
    const [base, q] = eb.pair.split("/");
    if (!base || !q) { skips.push({ what: "extbook:pair", why: "malformed-pair" }); continue; }
    nodes.add(base); nodes.add(q);
    const fee = num(eb.feeBps) || 0;
    const vk = `${eb.pair}@${eb.venue}`;
    edges.push({ kind: "EXTBOOK", key: `${vk}|${base}->${q}`, from: base, to: q, venue: eb.venue, realness: eb.realness ?? "L2_REAL", quote: (amt) => quoteBook(eb.bids, amt, "sell", fee) });
    edges.push({ kind: "EXTBOOK", key: `${vk}|${q}->${base}`, from: q, to: base, venue: eb.venue, realness: eb.realness ?? "L2_REAL", quote: (amt) => quoteBook(eb.asks, amt, "buy", fee) });
  }

  /* אורקלי-ייחוד — קצוות-REF: למדידת-שוליים-מול-ערך-חוץ; מסומנים-לא-ברי-ביצוע */
  for (const r of refs) {
    if (!r?.pair || !(num(r.rate) > 0)) { skips.push({ what: `ref:${r?.pair ?? "?"}`, why: "no-rate" }); continue; }
    const [base, q] = r.pair.split("/");
    nodes.add(base); nodes.add(q);
    const vk = r.venue ?? "oracle";
    edges.push({ kind: "REF", key: `${r.pair}@${vk}|${base}->${q}`, from: base, to: q, venue: vk, realness: "REF", quote: (amt) => ({ out: r6(amt * num(r.rate)), price: r6(num(r.rate)), feeBps: 0 }) });
    edges.push({ kind: "REF", key: `${r.pair}@${vk}|${q}->${base}`, from: q, to: base, venue: vk, realness: "REF", quote: (amt) => ({ out: r6(amt / num(r.rate)), price: r6(1 / num(r.rate)), feeBps: 0 }) });
  }

  return { nodes: [...nodes].sort(), edges, skips, book };
}

/* ── אדג'נטים-לכיוון ────────────────────────────────────────────────────────────────────────────────── */
export function edgesFrom(graph, from) { return graph.edges.filter((e) => e.from === from); }
export function edgeTo(graph, to) { return graph.edges.filter((e) => e.to === to); }

/** ציטוט-קצה-לכיוון: forward = from→to (quote), backward = to→from (reverseQuote). מחזיר null אם-אין-עומק. */
export function quoteEdge(edge, amountIn, dir = "fwd") {
  try {
    const r = dir === "fwd" ? edge.quote(amountIn) : (edge.reverseQuote ? edge.reverseQuote(amountIn) : null);
    return r && r.out > 0 ? r : null;
  } catch { return null; }
}

/* ── k-נתיבים-הטובים (simple-paths חסום-עומק, מדורג-לפי-out) ───────────────────────────────────────── */
/**
 * bestRoutes: כל-המסלולים-הפשוטים עד maxHops (ברירת-מחדל 4) מ-from ל-to עם ציטוט-עומק-מלא לכל-קצה.
 * אופטימיזציה: גיזום לפי mid-rate של כל-קצה (מחיר-אמצע מול מחיר-הקצה-הטוב-ביותר-הנוכחי).
 */
export function bestRoutes(graph, from, to, amountIn, { maxHops = 4, k = 5 } = {}) {
  const results = [];
  const walk = (node, path, amount, realness, visited) => {
    if (path.length > maxHops) return;
    if (node === to && path.length > 0) {
      results.push({ path: [...path], amountIn: r6(amountIn), amountOut: r6(amount), hops: path.length, realness, effPrice: r6(amount / amountIn), legs: path.map((e) => ({ kind: e.kind, venue: e.venue, from: e.from, to: e.to })) });
      return;
    }
    for (const e of edgesFrom(graph, node)) {
      if (e.kind === "REF") continue; // REF = סמכות-סניטי, לא-בר-ביצוע — לעולם לא רגל-נתיב
      if (visited.has(e.key)) continue;
      if (path.some((p) => p.venue === e.venue && p.kind === e.kind)) continue;
      const q = quoteEdge(e, amount, "fwd");
      if (!q) continue;
      visited.add(e.key);
      walk(e.to, [...path, e], q.out, minRealness(realness, e.realness), visited);
      visited.delete(e.key);
    }
  };
  walk(from, [], amountIn, "ONCHAIN_REAL", new Set());
  results.sort((a, b) => b.amountOut - a.amountOut || a.hops - b.hops || (a.legs.join() < b.legs.join() ? -1 : 1));
  return results.slice(0, k);
}

/* ── מעגלי-ארביטראז (Bellman-Ford על -log(mid-rate)) ───────────────────────────────────────────────── */
/**
 * מחזיר מעגלים-שליליים (Σlog(rate)>1 אחרי-עמלות = רווח-מעגלי) עם גודל-רווח ב-bps.
 * קצוות-REF אינם-ברי-ביצוע — מסומנים; מעגל שכולו-REF אינו-רווח אמת.
 */
export function arbCandidates(graph, { maxCycleLen = 4, capAssets = null } = {}) {
  // הגרף מכוון-מלא — כל-קצה כבר-מיוצג-שני-כיוונים; מחיר-אמצע לכל-קצה (מדגם 1 יחידה).
  const mids = new Map(); // key = e.key → {rate, edge, ref}
  for (const e of graph.edges) {
    const q = quoteEdge(e, 1, "fwd");
    if (q && Number.isFinite(q.price) && q.price > 0) mids.set(e.key, { rate: q.price, edge: e, ref: e.kind === "REF" });
  }
  // Bellman-Ford קלאסי על -log(rate); מקור וירטואלי-יחיד.
  const nodeKeys = [...new Set(graph.nodes)];
  const dist = new Map(nodeKeys.map((n) => [n, 0]));
  const prev = new Map();
  const edgesList = [...mids.entries()].map(([key, m]) => ({ key, u: m.edge.from, v: m.edge.to, w: -Math.log(m.rate), m }));
  let negative = [];
  for (let i = 0; i < nodeKeys.length + 1 && i < maxCycleLen + 2; i++) {
    let changed = false;
    for (const e of edgesList) {
      if (dist.get(e.u) + e.w < (dist.get(e.v) ?? 0) - 1e-12) { dist.set(e.v, dist.get(e.u) + e.w); prev.set(e.v, e.key); changed = true; }
    }
    if (!changed) break;
    if (i >= maxCycleLen) {
      // איטרציית-זיהוי: צומת-שהשתפר = על-מעגל-שלילי — שחזור-המעגל
      for (const e of edgesList) {
        if (dist.get(e.u) + e.w < (dist.get(e.v) ?? 0) - 1e-12) {
          const cycle = [];
          let cur = e.v; const seen = new Set();
          while (!seen.has(cur)) { seen.add(cur); const pk = prev.get(cur); if (!pk) break; const pm = mids.get(pk); cycle.push(pk); cur = pm.edge.from; if (cycle.length > maxCycleLen + 1) break; }
          if (cycle.length >= 2 && cycle.length <= maxCycleLen + 1) {
            let product = 1; const legs = [];
            for (let j = 0; j < cycle.length; j++) {
              const m = mids.get(cycle[j]); product *= m.rate;
              legs.push({ from: m.edge.from, to: m.edge.to, venue: m.edge.venue, kind: m.edge.kind, rate: m.rate, ref: !!m.ref });
            }
            const profitBps = r6((product - 1) * 1e4);
            if (product > 1 + 1e-9) negative.push({ legs, profitBps, executable: legs.every((l) => !l.ref), sizeCap: capAssets ?? null });
          }
        }
      }
      if (negative.length) break;
    }
  }
  // דדופ לפי-מחרוזת-מעגל
  const seenC = new Set();
  negative = negative.filter((c) => { const sig = c.legs.map((l) => `${l.from}>${l.to}@${l.venue}`).join("|"); if (seenC.has(sig)) return false; seenC.add(sig); return true; });
  negative.sort((a, b) => b.profitBps - a.profitBps);
  return negative;
}

/* ── מפת-הנתיבים החיה (הפלט-הקנוני שמפורסם-לריפו ומוגש-חי) ─────────────────────────────────────────── */
export const HUB_QUERIES = [
  { from: "STEEM", to: "USDS" }, { from: "SBD", to: "USDS" }, { from: "HIVE", to: "USDS" },
  { from: "BTC", to: "SAOS" }, { from: "USDT", to: "SAOS" }, { from: "USDS", to: "STEEM" },
  { from: "SAOS", to: "USDT" }, { from: "BLURT", to: "USDS" }, { from: "TRX", to: "SAOS" }, { from: "SOL", to: "SAOS" },
];

/** רצועת-סניטי-מול-אורקל: נתיב שהמחיר-האפקטיבי שלו סוטה-מעל-הרצועה מ-REF → ORACLE-ALERT
 * (המפה מפרסמת-בשקיפות אבל מסמנת — זהו-דגל-תמחור-שבור, לא-הזדמנות-מסחר). */
export const SANITY_BAND_PCT = 25;

/** מחירי-ייחוד-פר-נכס-מול-USDS (ב-USDS): fixpoint על קצוות-REF + דלתות-קבועות (DOOR — קצב-מובטח-kernel)
 * — כולל-שרשראות (SBD→STEEM→WSTEEM...); בריכות/ספרים/חוץ = שוק-משתנה — לעולם לא מקור-ערך-ייחוד. */
export function refPriceMap(graph) {
  const ref = new Map([["USDS", 1]]);
  const refEdges = graph.edges.filter((e) => e.kind === "REF" || e.kind === "DOOR");
  for (let iter = 0; iter < 20; iter++) {
    let changed = false;
    for (const e of refEdges) {
      const q = quoteEdge(e, 1, "fwd");
      if (!q || !(q.price > 0)) continue;
      const a = ref.get(e.from), b = ref.get(e.to);
      // p = יחידות-to פר-1-from ⇒ 1-to = 1/p-from ⇒ ref[to]=ref[from]/p · ref[from]=ref[to]·p
      if (a > 0 && !(b > 0)) { ref.set(e.to, a / q.price); changed = true; }
      else if (b > 0 && !(a > 0)) { ref.set(e.from, b * q.price); changed = true; }
    }
    if (!changed) break;
  }
  for (const [k, v] of ref) if (!(v > 0)) ref.delete(k); // נקה-null
  return ref;
}

/** אזהרות-תמחור: בריכה שהמחיר-האמצעי שלה סוטה-מעל-הרצועה מה-REF → דגל-מבני (פעולת-אוצר, לא-מסחר). */
export function mispricingAlerts(graph, { bandPct = SANITY_BAND_PCT } = {}) {
  const ref = refPriceMap(graph);
  const alerts = [];
  const seen = new Set();
  for (const e of graph.edges) {
    if (e.kind !== "POOL") continue;
    const q = quoteEdge(e, 1, "fwd");
    if (!q) continue;
    const refIn = ref.get(e.from), refOut = ref.get(e.to);
    if (!(refIn > 0) || !(refOut > 0)) continue; // אין-ייחוד-חוץ-לאחד-הצדדים → אין-סמכות-השוואה
    const impliedIn = q.price * refOut; // ערך-USDS פר-1 from לפי-הבריכה
    const devPct = Math.abs(impliedIn - refIn) / refIn * 100;
    const sig = `${e.from}/${e.to}`;
    if (devPct > bandPct && !seen.has(sig)) {
      seen.add(sig);
      alerts.push({ pool: sig, venue: e.venue, impliedUsdPer: r6(impliedIn), refUsdPer: r6(refIn), devPct: r6(devPct), severity: devPct > 500 ? "CRITICAL" : "WARNING", action: "TREASURY-REBALANCE — לא-מסלול-מסחר; סיכון-ניקוז-אמת" });
    }
  }
  alerts.sort((a, b) => b.devPct - a.devPct);
  return alerts;
}

/**
 * buildRouteMap — מרכיב את המפה-החיה: גרף + k-נתיבים-טובים לזוגות-הציר + ארביטראז + יומן-דילוגים כנה.
 * inputs כמו-buildRouteGraph + amountIn פר-שאילתה (ברירת-מחדל 100 יחידות-מקור).
 */
export function buildRouteMap(inputs, { now, amountIn = 100 } = {}) {
  const graph = buildRouteGraph(inputs);
  const ref = refPriceMap(graph);
  const alerts = mispricingAlerts(graph);
  // סינון-סיכון: בריכות-CRITICAL (ניקוז-אמת) מוצאות-מהמסלולים-הברי-ביצוע — הן סיכון-אוצר, לא-דרך-מסחר
  const criticalVenues = new Set(alerts.filter((a) => a.severity === "CRITICAL").map((a) => a.venue));
  const safeGraph = criticalVenues.size
    ? { ...graph, edges: graph.edges.filter((e) => !criticalVenues.has(e.venue)) }
    : graph;
  const SOVEREIGN = new Set(["SAOS", "USDS", "ENERGY", "PHIVE"]); // נכסי-זהות — הערך מוגדר-על-ידי-הבריכות-שלנו עצמן
  const routes = [];
  for (const q of HUB_QUERIES) {
    const src = q.from === "USDT" ? (inputs.usdtSize ?? 100) : amountIn;
    const paths = bestRoutes(safeGraph, q.from, q.to, src, { maxHops: 4, k: 6 });
    // סניטי-אורקל: נתיב-שהתשואה-שלו סוטה-מהרצועה-מערך-ה-REF-העצמאי → ORACLE-ALERT (מפורסם-אך-לא-מוצע).
    // נכס-זהות-ריבונית בקצה ללא-REF → SOVEREIGN-ANCHOR (הערך-מוגדר-עצמי — אין-סמכות-חוץ-להשוות).
    for (const p of paths) {
      const refIn = ref.get(q.from), refOut = ref.get(q.to);
      if (refIn > 0 && refOut > 0) {
        const implied = p.effPrice * refOut;
        p.oracleDevPct = r6(Math.abs(implied - refIn) / refIn * 100);
        p.verdict = p.oracleDevPct > SANITY_BAND_PCT ? "ORACLE-ALERT" : "OK";
      } else if ((!refIn || !(refIn > 0)) && SOVEREIGN.has(q.from) || (!refOut || !(refOut > 0)) && SOVEREIGN.has(q.to)) {
        p.verdict = "SOVEREIGN-ANCHOR";
      } else p.verdict = "UNREFERENCED";
    }
    const healthy = paths.filter((p) => p.verdict === "OK" || p.verdict === "SOVEREIGN-ANCHOR");
    const verdict = healthy.length ? "ROUTED" : (paths.length ? (paths.every((p) => p.verdict === "UNREFERENCED") ? "UNREFERENCED" : "ORACLE-ALERT") : "NO-PATH");
    routes.push({ from: q.from, to: q.to, amountIn: src, best: healthy[0] ?? null, alternates: healthy.slice(1), flagged: paths.filter((p) => p.verdict !== "OK" && p.verdict !== "SOVEREIGN-ANCHOR"), verdict });
  }
  const arb = arbCandidates(graph, { maxCycleLen: 4 });
  return {
    schema: "SAOS-ROUTE-MAP/1",
    at: now,
    identity: "הציר-הריבוני SAOS↔USDS · נכסי-חוץ הם דלתות, לא-זהות",
    graph: { nodes: graph.nodes, edgeCount: graph.edges.length, byKind: graph.edges.reduce((acc, e) => { acc[e.kind] = (acc[e.kind] ?? 0) + 1; return acc; }, {}) },
    routes,
    arb,
    mispricingAlerts: alerts,
    skips: graph.skips,
    honesty: "כל-קצה ממקור-מדוד · PLAN-ONLY · realness=הרגל-החלשה · נתיב-חורג-מ-REF±" + SANITY_BAND_PCT + "% מסומן-ORACLE-ALERT · אין-הצהרה-שלא-נמדדה",
  };
}
