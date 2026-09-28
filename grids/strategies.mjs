// STRATEGIES — המיקרו-גרידים: הסוכנים-כמבצעים-כלכליים
//
// כל אסטרטגיה פונקציה טהורה ודטרמיניסטית: tick(מצב-הגריד, השוק) → פקודות.
// דוקטרינת הציטוט (מ-grid-pulse R83): clamp bid < fair < ask, רוחב-מינימלי,
// תקרת-מלאי, מפסק-חירום מקומי. אין מחירים מומצאים — refPrice חייב להיות
// מדידה אמת (steem-feed) או מדידה-אחרונה עם דגל-stale.

export const FEE_BPS = 30; // עמלת-ה-AMM הממדדת של ה-Dex

/** PRNG מזורע — דטרמיניזם מלא (אותו-זרע → אותו-עולם). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ── mm-grid: מייקר-שוק מדורג ──────────────────────────────────────────
   פרמטרים: levels (כל-צד), widthBps, levelMu, growth (גיאומטרי), capMu   */
export function mmTick(grid, market, inventoryMu) {
  const { levels = 3, widthBps = 60, levelMu = 100, growth = 1.5, capMu = 10000 } = grid.params ?? {};
  const ref = market.refPrice;
  if (!ref || market.stale) return { orders: [], note: "no-fresh-ref" };
  if (inventoryMu > capMu) return { orders: [], note: "inventory-cap", halted: true };
  const orders = [];
  const w = ref * (widthBps / 10000);
  for (let i = 1; i <= levels; i++) {
    const size = levelMu * Math.pow(growth, i - 1);
    orders.push({ side: "bid", price: r6(ref - w * i), sizeMu: size, gridId: grid.id });
    orders.push({ side: "ask", price: r6(ref + w * i), sizeMu: size, gridId: grid.id });
  }
  return { orders, note: "quoted" };
}

/* ── micro-arb: ארביטרז' פאריטי בין שני ספרים ──────────────────────────
   קונים זול-ומוכרים-יקר כשהפער חוצה bandBps, מוגבל במלאי וב-notchional. */
export function arbTick(grid, market, inventoryMu) {
  const { bandBps = 25, maxNotionalMu = 500 } = grid.params ?? {};
  const a = market.bookA?.mid, b = market.bookB?.mid;
  if (!a || !b || market.stale) return { orders: [], note: "no-two-books" };
  const driftBps = ((b - a) / a) * 10000;
  if (Math.abs(driftBps) < bandBps) return { orders: [], note: "in-band" };
  const sizeMu = Math.min(maxNotionalMu, inventoryMu > 0 ? inventoryMu : maxNotionalMu / 2);
  const orders = [];
  if (driftBps > 0) {
    orders.push({ side: "bid", price: r6(a), sizeMu, gridId: grid.id, note: "arb-low" });
    orders.push({ side: "ask", price: r6(b), sizeMu, gridId: grid.id, note: "arb-high" });
  } else {
    orders.push({ side: "bid", price: r6(b), sizeMu, gridId: grid.id, note: "arb-low" });
    orders.push({ side: "ask", price: r6(a), sizeMu, gridId: grid.id, note: "arb-high" });
  }
  return { orders, note: `arb ${driftBps.toFixed(1)}bps`, driftBps };
}

/* ── sweep: קציר-פיזור כשהפיזור מתרחב ─────────────────────────────────── */
export function sweepTick(grid, market, inventoryMu) {
  const { thresholdBps = 80, touchMu = 50, capMu = 5000 } = grid.params ?? {};
  const ref = market.refPrice;
  if (!ref || market.stale) return { orders: [], note: "no-fresh-ref" };
  const spreadBps = market.spreadBps ?? 0;
  if (spreadBps < thresholdBps) return { orders: [], note: "spread-narrow" };
  if (inventoryMu > capMu) return { orders: [], note: "inventory-cap", halted: true };
  return {
    orders: [
      { side: "bid", price: r6(ref * (1 - thresholdBps / 20000)), sizeMu: touchMu, gridId: grid.id },
      { side: "ask", price: r6(ref * (1 + thresholdBps / 20000)), sizeMu: touchMu, gridId: grid.id },
    ],
    note: `sweep@${spreadBps.toFixed(0)}bps`,
  };
}

/* ── anchor-quote: ציטוט-מופעל-עיגון (ריצה על anchor.new בלבד) ─────────── */
export function anchorTick(grid, market) {
  if (!market.refPrice || market.stale) return { orders: [], note: "no-fresh-ref" };
  const { widthBps = 45, levelMu = 120 } = grid.params ?? {};
  const w = market.refPrice * (widthBps / 10000);
  return {
    orders: [
      { side: "bid", price: r6(market.refPrice - w), sizeMu: levelMu, gridId: grid.id },
      { side: "ask", price: r6(market.refPrice + w), sizeMu: levelMu, gridId: grid.id },
    ],
    note: "anchor-refresh",
  };
}

export const STRATEGIES = { "mm-grid": mmTick, "micro-arb": arbTick, sweep: sweepTick, "anchor-quote": anchorTick };

/** מילוי דטרמיניסטי: טייקר-מסתובב לוקח פקודות בטווח-סביר סביב ה-ref.
    כנות: זה סימולציה-מסומנת (sim:true) עד שהמכונה האמתית תחומש. */
export function simFill(orders, market, rng) {
  const fills = [];
  for (const o of orders) {
    const band = market.refPrice * 0.02; // 200bps סבלנות-טייקר
    const near = Math.abs(o.price - market.refPrice) <= band;
    const takes = near && rng() < 0.35;
    if (takes) {
      fills.push({ ...o, fillMu: o.sizeMu, feeMu: Math.round(o.sizeMu * (FEE_BPS / 10000) * 100) / 100, sim: true });
    }
  }
  return fills;
}

const r6 = (v) => Math.round(v * 1e6) / 1e6;
