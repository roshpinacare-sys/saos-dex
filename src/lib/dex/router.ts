/**
 * router.ts — THE-ROUTER (SETTLE-15): מקור-הנזיל-שמכניס-מהכל.
 *
 * דבר-המפעיל: "רק את מי שאפשר לעשות ראוטר ושיהיה נזילות גם מבחוץ — שנוכל
 * לשרשר את המערכת עם נזילות מבחוץ כדי לשפשף את העסקאות, ושיהיה מקור-נזיל
 * שמכניס מהכל".
 *
 * התרגום-הכנה על הגרעין-שלנו (אפס-קוד-זר):
 *  · גרף-ביצוע: כל-הבריכות החיות (שני-הכיוונים) + מסדרון-העיגון
 *    (wrap_mint/wrap_burn 1:1 על נכסים-עטופים שהיליד-שלהם קיים ברשימת-ASSETS
 *    — כרגע STEEM⇄WSTEEM בלבד; WSBD/PHIVE נשארים-בלי-קו כי SBD/HIVE לא-רשומים
 *    — כנות, לא-הבטחות).
 *  · ציטוט: פסיעה על כל-המסלולים-הפשוטים עד-3-רגליים, סימולציה-שלמים
 *    (quoteOut — אותה-מתמטיקה שתבצע), בחירת-התוצאה-הגבוהה, ושקיפות-מלאה
 *    של החלופות.
 *  · ביצוע: תתי-ops (pool_swap / wrap_mint / wrap_burn) בתוך batch אטומי
 *    (דבר-גורר-דבר, SETTLE-12) — הכל-או-כלום, minOut fail-closed לכל-רגל.
 *  · מפת-נזילות (routable): מי-מגיע-ל-האב (USDS) ובאיזה-טירון — deep/micro/
 *    rail/none. זו התשובה ל"רק את מי שאפשר לעשות ראוטר": גלוי-לכל, בלי
 *    זוגות-פנטום.
 *  · תמחור-LP (התועלת-מהמטבעות-שנראו-חסרי-שווי): טוקן-LP הוא חלק-יחסי
 *    מהרזרבות — נמדד ומוצג בשווי-אמת במקום 0 שקרי.
 *  · הכנסה (מקור-הנזיל-שמכניס-מהכל): כל-עסקה-דרך-האב משלמת 30bps → 30% מהעמלה
 *    לאוצר. income מצטבר-מפורט ב-getState.
 *
 * אפס-float במצב · אפס-הטבעה · אפס-מפתחות — קריאה-בלבד על המצב-החי.
 */
import { getLiveState } from "./chain";
import { getPool, quoteOut } from "./amm";
import { ASSETS, type Pool } from "./kernel";

export const ROUTE_HUB = "USDS";
export const MAX_LEGS = 3; // עד-3-רגליים: ישיר / דרך-האב / דרך-מסדרון-העיגון
export const LP_PREFIX = "LP|";

/** מסדרון-העיגון: עטיפה/פריקה 1:1 — ניתנת-לביצוע רק-אם-היליד רשום ב-ASSETS.
 * WSBD→SBD ו-PHIVE→HIVE אינם-ביצועים-כאן (SBD/HIVE לא-רשומים) — כנות. */
export function wrapPairs(): { wrapped: string; native: string; backingMu: number }[] {
  const st = getLiveState();
  const out: { wrapped: string; native: string; backingMu: number }[] = [];
  for (const a of ASSETS) {
    if (a.length > 1 && a.startsWith("W")) {
      const native = a.slice(1);
      if ((ASSETS as string[]).includes(native)) {
        out.push({ wrapped: a, native, backingMu: st.backing[a] ?? 0 });
      }
    }
  }
  return out;
}

export interface RouteLeg {
  kind: "pool" | "wrap";
  venue: string; // "POOL:SAOS/USDS" | "PEG-RAIL:WSTEEM"
  from: string;
  to: string;
  inMu: number;
  outMu: number;
  priceMu: number; // µ-יציאה ל-1-יחידת-כניסה (×1000). עטיפה-1:1 = 1000
}

export interface RouteQuote {
  assetIn: string;
  assetOut: string;
  amountInMu: number;
  amountOutMu: number;
  effPriceMu: number; // µ-יציאה ליחידת-כניסה
  legs: RouteLeg[];
  alternatives: { amountOutMu: number; path: string[] }[];
}

/** ציטוט-מסלול-הטוב-ביותר לכל-המסלולים-הפשוטים עד-MAX_LEGS (קריאה-בלבד). */
export function quoteRoute(assetIn: string, assetOut: string, amountInMu: number): RouteQuote | null {
  const results = walkRoutes(assetIn, assetOut, amountInMu);
  if (results.length === 0) return null;

  results.sort((a, b) => b.inMu - a.inMu);
  const best = results[0];
  return {
    assetIn, assetOut, amountInMu,
    amountOutMu: best.inMu,
    effPriceMu: Math.floor((best.inMu * 1000) / amountInMu),
    legs: best.legs,
    alternatives: results.slice(0, 4).map((r) => ({ amountOutMu: r.inMu, path: r.legs.map((l) => l.venue) })),
  };
}

interface Walk { to: string; inMu: number; legs: RouteLeg[] }

/** פסיעה-על-גרף-הבריכות+מסדרון-העיגון: כל-המסלולים-עד-MAX_LEGS, סימולציה-שלמים.
 * מופשט-מכאן-כדי-ש-quoteRoute ו-quoteSplit ישתמשו-באותה-מתמטיקה-בדיוק. */
export function walkRoutes(assetIn: string, assetOut: string, amountInMu: number): Walk[] {
  const st = getLiveState();
  if (!(amountInMu > 0) || !ASSETS.includes(assetIn as never) || !ASSETS.includes(assetOut as never) || assetIn === assetOut) return [];

  // בניית-גרף: שכנויות-בריכה + שכנויות-עטיפה
  const pools: { key: string; p: Pool }[] = Object.entries(st.pools).map(([key, p]) => ({ key, p }));
  const wraps = wrapPairs();
  const neighbors = (a: string): { to: string; kind: "pool" | "wrap"; pool?: Pool; key?: string; wrapTo?: string }[] => {
    const out: { to: string; kind: "pool" | "wrap"; pool?: Pool; key?: string; wrapTo?: string }[] = [];
    for (const { key, p } of pools) {
      if (p.a === a) out.push({ to: p.b, kind: "pool", pool: p, key });
      if (p.b === a) out.push({ to: p.a, kind: "pool", pool: p, key });
    }
    for (const w of wraps) {
      if (a === w.wrapped) out.push({ to: w.native, kind: "wrap", wrapTo: w.native });
      if (a === w.native) out.push({ to: w.wrapped, kind: "wrap", wrapTo: w.wrapped });
    }
    return out;
  };

  const results: Walk[] = [];
  const walk = (cur: string, mu: number, legs: RouteLeg[], visited: Set<string>, depth: number): void => {
    if (depth > 0 && cur === assetOut) { results.push({ to: cur, inMu: mu, legs }); return; }
    if (depth >= MAX_LEGS) return;
    for (const nx of neighbors(cur)) {
      if (visited.has(nx.to)) continue;
      let outMu = 0; let priceMu = 0; let venue = "";
      if (nx.kind === "pool" && nx.pool) {
        const q = quoteOut(nx.pool, cur, mu);
        if (!q) continue;
        outMu = q.out;
        priceMu = Math.floor((outMu * 1000) / mu);
        venue = `POOL:${nx.key}`;
      } else {
        // מסדרון-עיגון 1:1 — אין-דמי-עמלה על-העטיפה-עצמה (הגז-בלבד; wrap_mint/burn).
        // כנות-ביצוע: פריקה (wrapped→native) מחייבת-גיבוי-1:1 בפועל — אין-לצטט
        // מסלול-שייכשל-בביצוע (fail-closed גם-בציטוט).
        const wp = wraps.find((w) => w.wrapped === nx.wrapTo || w.native === nx.wrapTo);
        if (!wp) continue;
        if (cur === wp.wrapped && nx.to === wp.native && (st.backing[wp.wrapped] ?? 0) < mu) continue;
        outMu = mu; priceMu = 1000; venue = `PEG-RAIL:${nx.wrapTo}`;
      }
      const v2 = new Set(visited); v2.add(nx.to);
      walk(nx.to, outMu, [...legs, { kind: nx.kind, venue, from: cur, to: nx.to, inMu: mu, outMu, priceMu }], v2, depth + 1);
    }
  };
  walk(assetIn, amountInMu, [], new Set([assetIn]), 0);
  return results;
}

// ─── SPLIT-ROUTING (Task 55 · Uniswap-V3 חתימה): פיצול-חכם בין-שני-מסלולים ──

export interface SplitQuote {
  assetIn: string;
  assetOut: string;
  amountInMu: number;
  singleBestOutMu: number;
  splitOutMu: number;
  savingBps: number; // חיסכון-הפיצול מעל-המסלול-הטוב-ביותר (bps)
  splitPctFirst: number; // אחוז-הראשון (0-100)
  leg1: { path: string; amountInMu: number; amountOutMu: number };
  leg2: { path: string; amountInMu: number; amountOutMu: number } | null;
  executed: boolean; // האם-הפיצול אכן-משתלם (savingBps>0)
}

const SPLIT_FRACTIONS = [50, 60, 70, 80] as const; // אחוז-הראשון — דטרמיניסטי

/** פיצול-מסלול: במקום-לשפוך-הכל-למסלול-אחד (פגיעה-במחיר), מפצלים-בין
 * שני-המסלולים-הטובים-הנבדלים ובוחרים-את-החיתוך-הדטרמיניסטי-המשתלם-ביותר.
 * הכל-סימולציית-שלמים על-הבריכות-החיות — אותה-מתמטיקה שתבצע. */
export function quoteSplit(assetIn: string, assetOut: string, amountInMu: number): SplitQuote | null {
  const full = walkRoutes(assetIn, assetOut, amountInMu);
  if (full.length === 0) return null;
  full.sort((a, b) => b.inMu - a.inMu);
  const singleBestOut = full[0].inMu;
  // שני-המסלולים-הטובים-הנבדלים (זהות-מסלול שונה — לא-אותו-ציר)
  const pathOf = (w: Walk) => w.legs.map((l) => l.venue).join(">");
  const bestPath = pathOf(full[0]);
  const second = full.find((w) => pathOf(w) !== bestPath);
  if (!second) return null;
  const secondPath = pathOf(second);

  let best: SplitQuote | null = null;
  for (const pct of SPLIT_FRACTIONS) {
    const in1 = Math.floor((amountInMu * pct) / 100);
    const in2 = amountInMu - in1;
    if (in1 <= 0 || in2 <= 0) continue;
    const o1 = walkRoutes(assetIn, assetOut, in1);
    const o2 = walkRoutes(assetIn, assetOut, in2);
    const leg1 = o1.filter((w) => pathOf(w) === bestPath).sort((a, b) => b.inMu - a.inMu)[0] ?? o1.sort((a, b) => b.inMu - a.inMu)[0];
    const leg2 = o2.filter((w) => pathOf(w) === secondPath).sort((a, b) => b.inMu - a.inMu)[0] ?? o2.sort((a, b) => b.inMu - a.inMu)[0];
    if (!leg1 || !leg2) continue;
    const totalOut = leg1.inMu + leg2.inMu;
    if (totalOut <= singleBestOut) continue;
    const savingBps = Math.floor(((totalOut - singleBestOut) * 10_000) / singleBestOut);
    const cand: SplitQuote = {
      assetIn, assetOut, amountInMu,
      singleBestOutMu: singleBestOut,
      splitOutMu: totalOut,
      savingBps,
      splitPctFirst: pct,
      leg1: { path: pathOf(leg1), amountInMu: in1, amountOutMu: leg1.inMu },
      leg2: { path: pathOf(leg2), amountInMu: in2, amountOutMu: leg2.inMu },
      executed: savingBps > 0,
    };
    if (!best || cand.savingBps > best.savingBps) best = cand;
  }
  return best;
}

// ─── מפת-נזילות: מי-ראוטר-ביל ומי-לא (כנות-מלאה) ─────────────────────────────

export type RouteTier = "hub" | "deep" | "micro" | "rail" | "none";

export interface RoutableEntry {
  asset: string;
  tier: RouteTier;
  priceUsdsMu: number; // המחיר-הנזיל-הטוב-ביותר ל-USDS (µ-USDS ליחידה); ל-USDS עצמה 1000
  routeDesc: string; // "POOL:SAOS/USDS" או "POOL:ENERGY/SAOS → POOL:SAOS/USDS"
  depthUsdsMu: number; // עומק-המסלול: צד-הבריכה-הצר-ביותר בשווי-USDS
}

/** עומק-בריכה בשווי-USDS (מיקרו-צד): min(ra,rb) בהמרה ל-µ-USDS. */
function poolDepthUsdsMu(p: Pool, priceOf: (a: string) => number): number {
  const va = Math.floor((p.ra * priceOf(p.a)) / 1000);
  const vb = Math.floor((p.rb * priceOf(p.b)) / 1000);
  return Math.min(va, vb);
}

export function routableMap(): RoutableEntry[] {
  const st = getLiveState();
  const out: RoutableEntry[] = [];
  for (const a of ASSETS) {
    if (a === ROUTE_HUB) {
      out.push({ asset: a, tier: "hub", priceUsdsMu: 1000, routeDesc: "HUB — יחידת-החשבון", depthUsdsMu: 0 });
      continue;
    }
    const q = quoteRoute(a, ROUTE_HUB, 1000); // 1000µ דגימה — מחיר-ייצוגי
    if (!q || q.amountOutMu <= 0) {
      const ref = st.assets[a]?.refPrice ?? 0;
      out.push({ asset: a, tier: "none", priceUsdsMu: ref, routeDesc: "אין-מסלול-מבצע — רצפת-refPrice בלבד", depthUsdsMu: 0 });
      continue;
    }
    // טירון: ישיר-עמוק / מיקרו / דרך-מסדרון
    const direct = getPool(st, [a, ROUTE_HUB].sort().join("/"));
    const isRail = q.legs.some((l) => l.kind === "wrap");
    let depth = 0;
    for (const l of q.legs) {
      if (l.kind !== "pool" || !l.venue.startsWith("POOL:")) continue;
      const p = getPool(st, l.venue.slice(5));
      if (p) depth = Math.max(depth, poolDepthUsdsMu(p, (x) => priceRef(x, st)));
    }
    let tier: RouteTier;
    if (isRail) tier = "rail";
    else if (direct) tier = "deep";
    else tier = "micro";
    out.push({ asset: a, tier, priceUsdsMu: q.effPriceMu, routeDesc: q.legs.map((l) => l.venue).join(" → "), depthUsdsMu: depth });
  }
  return out;
}

/** refPrice-כנן להערכת-עומק בלבד (לא-מחיר-מסחר). */
function priceRef(a: string, st: ReturnType<typeof getLiveState>): number {
  if (a === "USDS") return 1000;
  const direct = getPool(st, [a, "USDS"].sort().join("/"));
  if (direct) return direct.a === a ? Math.floor((direct.rb * 1000) / direct.ra) : Math.floor((direct.ra * 1000) / direct.rb);
  const viaSaos = getPool(st, [a, "SAOS"].sort().join("/"));
  const saosUsds = getPool(st, "SAOS/USDS");
  if (viaSaos && saosUsds) {
    const pm = viaSaos.a === a ? Math.floor((viaSaos.rb * 1000) / viaSaos.ra) : Math.floor((viaSaos.ra * 1000) / viaSaos.rb);
    const su = Math.floor((saosUsds.rb * 1000) / saosUsds.ra);
    if (pm > 0 && su > 0) return Math.floor((pm * su) / 1000);
  }
  return st.assets[a]?.refPrice ?? 0;
}

// ─── תמחור-טוקני-LP: התועלת-ממה-שנראה-חסר-שווי ──────────────────────────────

export interface LpValuation {
  lpAsset: string;
  poolKey: string;
  lpMu: number; // ההיצע-הכולל
  shareBps: number; // חלק יחסי ב-bps עבור 1000µ-LP (דגימה)
  valueUsdsMuPer1000: number; // שווי-USDS של 1000µ-LP
  totalPoolValueUsdsMu: number;
}

/** שווי-אמת של טוקן-LP: חלק-יחסי מהרזרבות במחירי-הבריכות-החיות. */
export function lpValuation(lpAsset: string): LpValuation | null {
  if (!lpAsset.startsWith(LP_PREFIX)) return null;
  const key = lpAsset.slice(LP_PREFIX.length);
  const st = getLiveState();
  const p = getPool(st, key);
  if (!p || p.lp <= 0) return null;
  const priceOf = (a: string): number => priceRef(a, st);
  const va = Math.floor((p.ra * priceOf(p.a)) / 1000);
  const vb = Math.floor((p.rb * priceOf(p.b)) / 1000);
  const total = va + vb;
  const per1000 = Math.floor((total * 1000) / p.lp);
  return {
    lpAsset, poolKey: key, lpMu: p.lp,
    shareBps: Math.floor((1000 * 10_000) / p.lp),
    valueUsdsMuPer1000: per1000,
    totalPoolValueUsdsMu: total,
  };
}

/** כל-טוקני-ה-LP-החיים במצב (מה-שהמפעיל-ראה-כ"צמודים-מוזרים" בתיקייה-השנייה). */
export function allLpValuations(): LpValuation[] {
  const st = getLiveState();
  const seen = new Set<string>();
  for (const w of Object.values(st.balances)) {
    for (const a of Object.keys(w)) if (a.startsWith(LP_PREFIX) && (w[a] ?? 0) > 0) seen.add(a);
  }
  return Array.from(seen).map((a) => lpValuation(a)).filter((v): v is LpValuation => v !== null);
}
