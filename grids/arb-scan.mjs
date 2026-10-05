// ARB-SCAN — סורק-ארביטרז'-חוצה-וניוז חסר-מפתחות (Z-87a · trace 1a105e08984d4671)
// ═══════════════════════════════════════════════════════════════════════════════
// מסגרת-השוק של הסוכנים (audit-Z86c פער-c): הסריקה מפרסמת הזדמנויות בפנקס
// paper-PnL מצטבר (grids/state/arb-ledger.json) — הקבלות המדידות הן הדרך שבה
// הרווחיות מוכחת לפני-שמישהו מחמש ביצוע. ברירת-המחדל והחוק: PLAN/SCAN-ONLY —
// אפס-ביצוע, אפס-חתימה, אפס-מפתחות (keyless לגמרי).
//
// חוקי-הברזל:
//   1. אף-מספר לא מומצא: כל-קצה/גודל מחושב מהספרים-החיים המכובדים למטה; פיד
//      שנכשל → רשומה degraded כנה (fail-closed) — הזוג מדולג, לא משוחזר.
//   2. מודל-העמלה של הבית: FEE_BPS=30 לרגל (strategies.mjs) — קנייה משלמת
//      ×(1+f), מכירה מקבלת ×(1−f). paperPnlSbd עלול להיות שלילי — אין-קטיף-דובדבנים.
//   3. תגיות-אמת לכל-וניו (registry אמת, Z-86a): ONCHAIN_REAL (ספר-פנים-על-השרשרת),
//      L2_REAL (Hive-Engine buyBook/sellBook — לעולם לא metrics-מיושנים),
//      CEX_REF (עומק-CEX — נתון-אמת אך מסילת-ביצוע לא-חמושה), PAPER (שער-ייחוס-בלי-ספר).
//      realness של רשומה = הרגל-החלשה (fail-closed כנות).
//   4. דטרמיניזם: הליבה-המתמטית טהורה לגמרי (selftest על קובצי-fixture מוקלטים);
//      הזמן מוזרק, לא נקרא, בכל-נתיב-נבדק.
//   5. אף-קריאה-חיה לא נופלת: כל-פיד ב-timeout + try/catch; הסריקה כולה
//      "never throws" — הריצה תמיד מניבה פנקס כן (גם כשהכל מדולג).
//
// מקורות-הפיד (כולם keyless, נבדקו-חי 2026-10-04 — research-Z86a):
//   · ספר-פנים STEEM  : condenser_api.get_order_book @ api.steemit.com / api.justyy.com
//   · ספר-פנים HIVE   : condenser_api.get_order_book @ api.hive.blog / api.deathwing.me / api.openhive.network
//   · עומק HTX        : /v1/market/depth steemusdt / hiveusdt / sbdusdt (SBD חי רק ב-HTX)
//   · עומק Binance    : /api/v3/ticker/bookTicker (top-of-book STEEMUSDT / HIVEUSDT)
//   · ספרי-Engine     : api.hive-engine.com/rpc/contracts market.buyBook/sellBook (ממוין client-side —
//                       מדוד: השרת מחזיר שורות-לא-ממוינות; metrics נפסלים כמיושנים)
//   · שערי-ייחוס      : coins.llama.fi (confidence 0.99) → coingecko → blurt price_info
//
// סכימת-הפנקס (מדויקת — arb-ledger-v1):
//   {"schema":"arb-ledger-v1","layer":"sovereign-CI","generatedAt":"<iso>",
//    "entries":[{"ts","pair","venueA","venueB","edgeBps","direction","executableSize",
//                "realness","paperPnlSbd","degraded","notes"}],
//    "cumulative":{"paperPnlSbd":<sum>,"entries":<n>,"positiveEntries":<n>,"realized":false,
//                  "strategyPnlSbd":<sum>,"strategyEntries":<n>}}
//   תקרת-קובץ: 200 רשומות-אחרונות + מצטבר-כל-הזמנים (המצטבר שורד את-התקרה).
//   R25 · שני-מצטברים — לא לערבב אותם בכותרות:
//   · paperPnlSbd    = מצטבר-כל-הרשומות (שני-הכיוונים כולל-שליליים) — מד-עלות-שוק
//                      של חציית-שני-צידי-הספרים, לא PnL-אסטרטגיה;
//   · strategyPnlSbd = מצטבר-אסטרטגיה (רק-קצוות-חיוביים-ברי-ביצוע: edge>0 ו-paperPnlSbd
//                      מספרי — שני-הצדדים קיימים לפי חוק-Z88) — מה שאסטרטגיה
//                      שלוקחת-רק-קצה-חיובי הייתה מרוויחה-על-נייר.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const LEDGER_PATH = join(HERE, "state", "arb-ledger.json");
export const FIXTURES_DIR = join(HERE, "state", "fixtures");

/* ── קבועים ───────────────────────────────────────────────────────────────── */
export const FEE_BPS = 30;               // מודל-העמלה של הבית — 30bps לרגל (strategies.mjs)
export const LEDGER_CAP = 200;           // תקרת-רשומות בקובץ (המצטבר חי-מעבר-לה)
export const LEDGER_SCHEMA = "arb-ledger-v1";
export const LEDGER_LAYER = "sovereign-CI"; // provenance: written by CI arb-scan.yml (or its verified build rung), committed in the sovereign repo
export const REALNESS_RANK = { ONCHAIN_REAL: 4, L2_REAL: 3, CEX_REF: 2, PAPER: 1, DEGRADED: 0 };

export const NODES_STEEM = ["https://api.steemit.com", "https://api.justyy.com"];
export const NODES_HIVE = ["https://api.hive.blog", "https://api.deathwing.me", "https://api.openhive.network"];
export const NODES_ENGINE = ["https://api.hive-engine.com/rpc/contracts", "https://api2.hive-engine.com/rpc/contracts"];
/* Z-87a מדוד-חי (2026-10-04): הנתיב /v1/market/depth מחזיר 404 על-כל-המארחים —
 * הנתיב-החי הוא /market/depth (ללא /v1). api.htx.com ענה מהר-ביותר. SBD חי-רק-שם. */
export const HTX_HOSTS = ["https://api.htx.com", "https://api.huobi.pro", "https://api.huobi.com"];
export const HTX_DEPTH_PATH = "/market/depth";

export const r6 = (v) => (Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : null);
export const num = (s) => (s == null ? 0 : parseFloat(String(s).replace(/[A-Za-z$ ]+/g, "")) || 0);

/* ══ שכבת-הפידים — keyless, timeout, fail-soft; כל-פיד מחזיר {ok,data|error} ══ */

async function jget(url, { timeoutMs = 6000, fetchImpl = fetch, headers = {} } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { signal: ctl.signal, headers: { "User-Agent": "saos-dex/arb-scan (keyless)", ...headers } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

/** JSON-RPC עם failover בין-צמתים — זורק רק אחרי-כל-הצמתים (הקורא תופס). */
export async function condenserRpc(method, params, { nodes = NODES_STEEM, fetchImpl = fetch, timeoutMs = 6000 } = {}) {
  let lastErr = null;
  for (const node of nodes) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      let j;
      try {
        const r = await fetchImpl(node, {
          method: "POST", signal: ctl.signal,
          headers: { "Content-Type": "application/json", "User-Agent": "saos-dex/arb-scan (keyless)" },
          body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        j = await r.json();
      } finally { clearTimeout(t); }
      if (j.error) throw new Error(String(j.error.message ?? "rpc-error").slice(0, 90));
      return j.result;
    } catch (e) { lastErr = `${node}: ${String(e?.message ?? e).slice(0, 80)}`; }
  }
  throw new Error(lastErr ?? "no nodes");
}

/** ניתוח-ספר-condenser: real_price (מחיר-quote-ל-base) + כמויות ×1000 (שדות-מספריים). */
export function parseCondenserBook(result, { venue, baseField, quoteField }) {
  if (!result || !Array.isArray(result.asks) || !Array.isArray(result.bids)) return null;
  const lvl = (row) => {
    const price = num(row?.real_price);
    const qty = num(row?.[baseField]) / 1000; // שדות-הרשת הם יחידות-מילי (3-ספרות)
    return price > 0 && qty > 0 ? { price, qty } : null;
  };
  const asks = result.asks.map(lvl).filter(Boolean).sort((a, b) => a.price - b.price);
  const bids = result.bids.map(lvl).filter(Boolean).sort((a, b) => b.price - a.price);
  if (asks.length === 0 || bids.length === 0) return null;
  return { venue, realness: "ONCHAIN_REAL", base: baseField.toUpperCase(), quote: quoteField.toUpperCase(), asks, bids };
}

export async function steemBookFeed({ limit = 20, fetchImpl = fetch } = {}) {
  try {
    const res = await condenserRpc("condenser_api.get_order_book", [limit], { nodes: NODES_STEEM, fetchImpl });
    const book = parseCondenserBook(res, { venue: "steem-internal", baseField: "steem", quoteField: "sbd" });
    return book ? { ok: true, data: book } : { ok: false, error: "steem book empty/invalid" };
  } catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 120) }; }
}

export async function hiveBookFeed({ limit = 20, fetchImpl = fetch } = {}) {
  try {
    const res = await condenserRpc("condenser_api.get_order_book", [limit], { nodes: NODES_HIVE, fetchImpl });
    const book = parseCondenserBook(res, { venue: "hive-internal", baseField: "hive", quoteField: "hbd" });
    return book ? { ok: true, data: book } : { ok: false, error: "hive book empty/invalid" };
  } catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 120) }; }
}

/** חציון-הפיד (get_current_median_history_price) — סמכות-הסניטי של השרשרת. */
export async function condenserMedianFeed({ nodes = NODES_STEEM, fetchImpl = fetch } = {}) {
  try {
    const res = await condenserRpc("condenser_api.get_current_median_history_price", [], { nodes, fetchImpl });
    const base = num(res?.base), quote = num(res?.quote);
    if (!(base > 0) || !(quote > 0)) return { ok: false, error: "median fields unusable" };
    return { ok: true, data: { price: base / quote, raw: { base: res.base, quote: res.quote } } };
  } catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 120) }; }
}

/** HTX עומק — /v1/market/depth (GET, tick.bids/asks = [[price, qty]]). CEX_REF. */
export function parseHtxDepth(json) {
  const bids = (json?.tick?.bids ?? []).map(([p, q]) => ({ price: num(p), qty: num(q) })).filter((l) => l.price > 0 && l.qty > 0).sort((a, b) => b.price - a.price);
  const asks = (json?.tick?.asks ?? []).map(([p, q]) => ({ price: num(p), qty: num(q) })).filter((l) => l.price > 0 && l.qty > 0).sort((a, b) => a.price - b.price);
  if (bids.length === 0 || asks.length === 0) return null;
  return { venue: "htx", realness: "CEX_REF", asks, bids };
}

export async function htxDepthFeed(symbol, { fetchImpl = fetch } = {}) {
  let lastErr = "unreachable";
  for (const host of HTX_HOSTS) {
    // Z-87a: שני-הנתיבים ננסים — /market/depth (החי-המדוד) קודם, /v1/market/depth (הישן) כגיבוי
    for (const path of [HTX_DEPTH_PATH, "/v1/market/depth"]) {
      try {
        // Z-87a מדוד: depth=step0 אינו-חוקי (status:"error" בגוף-200) — depth מספרי + type=step0
        const j = await jget(`${host}${path}?symbol=${symbol}&type=step0&depth=20`, { fetchImpl });
        const book = parseHtxDepth(j);
        if (book) return { ok: true, data: { ...book, pair: symbol } };
        lastErr = "htx depth empty/invalid";
      } catch (e) { lastErr = String(e?.message ?? e).slice(0, 100); }
    }
  }
  return { ok: false, error: `htx ${symbol}: ${lastErr}` };
}

/** Binance top-of-book — CEX_REF רק-מגע (מימסד-ציטוט). */
export async function binanceTopFeed(symbol, { fetchImpl = fetch } = {}) {
  try {
    const j = await jget(`https://api.binance.com/api/v3/ticker/bookTicker?symbol=${symbol}`, { fetchImpl });
    const bid = num(j?.bidPrice), bidQty = num(j?.bidQty), ask = num(j?.askPrice), askQty = num(j?.askQty);
    if (!(bid > 0) || !(ask > 0)) return { ok: false, error: `binance ${symbol}: unusable ticker` };
    return {
      ok: true,
      data: { venue: "binance", realness: "CEX_REF", pair: symbol, asks: askQty > 0 ? [{ price: ask, qty: askQty }] : [], bids: bidQty > 0 ? [{ price: bid, qty: bidQty }] : [] },
    };
  } catch (e) { return { ok: false, error: `binance ${symbol}: ${String(e?.message ?? e).slice(0, 100)}` }; }
}

/** Hive-Engine ספרי-buyBook/sellBook — ממוין client-side (מדוד: השרת לא-ממוין). L2_REAL. */
export function parseEngineBooks(buyRows, sellRows, { symbol = "SWAP.BLURT", venue = "hive-engine" } = {}) {
  const bids = (Array.isArray(buyRows) ? buyRows : [])
    .map((r) => ({ price: num(r?.price), qty: num(r?.quantity) })).filter((l) => l.price > 0 && l.qty > 0)
    .sort((a, b) => b.price - a.price);
  const asks = (Array.isArray(sellRows) ? sellRows : [])
    .map((r) => ({ price: num(r?.price), qty: num(r?.quantity) })).filter((l) => l.price > 0 && l.qty > 0)
    .sort((a, b) => a.price - b.price);
  if (bids.length === 0 || asks.length === 0) return null;
  return { venue, realness: "L2_REAL", pair: `${symbol}:SWAP.HIVE`, asks, bids };
}

export async function engineBookFeed(symbol = "SWAP.BLURT", { fetchImpl = fetch } = {}) {
  const q = (table, sort, desc) => JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "find",
    params: { contract: "market", table, query: { symbol }, limit: 20, sort, descending: desc },
  });
  let lastErr = "unreachable";
  for (const node of NODES_ENGINE) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 7000);
      let buyRes, sellRes;
      try {
        const post = async (body) => {
          const r = await fetchImpl(node, { method: "POST", signal: ctl.signal, headers: { "Content-Type": "application/json", "User-Agent": "saos-dex/arb-scan (keyless)" }, body });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        };
        [buyRes, sellRes] = await Promise.all([post(q("buyBook", "priceDec", true)), post(q("sellBook", "priceAsc", false))]);
      } finally { clearTimeout(t); }
      const book = parseEngineBooks(buyRes?.result, sellRes?.result, { symbol });
      if (book) return { ok: true, data: book };
      lastErr = "engine books empty/invalid";
    } catch (e) { lastErr = String(e?.message ?? e).slice(0, 100); }
  }
  return { ok: false, error: `engine ${symbol}: ${lastErr}` };
}

/** Blurt שער-ייחוס — price_info בלבד; אין-ספר-בלרט-ציבורי (Z-86a מדוד). PAPER. */
export async function blurtPriceRefFeed({ fetchImpl = fetch } = {}) {
  try {
    const j = await jget("https://api.blurt.blog/price_info", { fetchImpl });
    const priceUsd = num(j?.price_usd);
    if (!(priceUsd > 0)) return { ok: false, error: "blurt price_info unusable" };
    return { ok: true, data: { priceUsd, realness: "PAPER" } };
  } catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 100) }; }
}

/** שערי-ייחוס-USD: llama (confidence) → coingecko. מחזיר גם מקור-לכל-שער (כנות). */
export async function llamaRefFeed({ fetchImpl = fetch } = {}) {
  try {
    const j = await jget("https://coins.llama.fi/prices/current/coingecko:steem,coingecko:steem-dollars,coingecko:hive,coingecko:blurt", { fetchImpl });
    const c = j?.coins ?? {};
    const out = {
      steemUsd: num(c["coingecko:steem"]?.price) || null,
      sbdUsd: num(c["coingecko:steem-dollars"]?.price) || null,
      hiveUsd: num(c["coingecko:hive"]?.price) || null,
      blurtUsd: num(c["coingecko:blurt"]?.price) || null,
    };
    if (out.steemUsd == null && out.sbdUsd == null && out.hiveUsd == null) return { ok: false, error: "llama refs unusable" };
    return { ok: true, data: out };
  } catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 100) }; }
}

export async function coingeckoRefFeed({ fetchImpl = fetch } = {}) {
  try {
    const j = await jget("https://api.coingecko.com/api/v3/simple/price?ids=steem,steem-dollars,hive,blurt&vs_currencies=usd", { fetchImpl });
    const out = {
      steemUsd: num(j?.steem?.usd) || null,
      sbdUsd: num(j?.["steem-dollars"]?.usd) || null,
      hiveUsd: num(j?.hive?.usd) || null,
      blurtUsd: num(j?.blurt?.usd) || null,
    };
    if (out.steemUsd == null && out.sbdUsd == null && out.hiveUsd == null) return { ok: false, error: "coingecko refs unusable" };
    return { ok: true, data: out };
  } catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 100) }; }
}

/** איסוף-שערים: HTX sbdusdt-mid קודם (SBD חי-רק-שם), אחר-כך llama, אחר-כך coingecko. */
export async function measureRefs({ fetchImpl = fetch } = {}) {
  const sources = {};
  let refs = { steemUsd: null, sbdUsd: null, hiveUsd: null, blurtUsd: null };
  const htxSbd = await htxDepthFeed("sbdusdt", { fetchImpl });
  if (htxSbd.ok) {
    const mid = (htxSbd.data.bids[0].price + htxSbd.data.asks[0].price) / 2;
    if (mid > 0) { refs.sbdUsd = r6(mid); sources.sbdUsd = "htx:sbdusdt-mid"; }
  }
  const llama = await llamaRefFeed({ fetchImpl });
  if (llama.ok) {
    for (const k of ["steemUsd", "sbdUsd", "hiveUsd", "blurtUsd"]) {
      if (refs[k] == null && llama.data[k] != null) { refs[k] = llama.data[k]; sources[k] = "llama:coins(confidence)"; }
    }
  }
  if (refs.steemUsd == null || refs.sbdUsd == null || refs.hiveUsd == null || refs.blurtUsd == null) {
    const cg = await coingeckoRefFeed({ fetchImpl });
    if (cg.ok) {
      for (const k of ["steemUsd", "sbdUsd", "hiveUsd", "blurtUsd"]) {
        if (refs[k] == null && cg.data[k] != null) { refs[k] = cg.data[k]; sources[k] = "coingecko"; }
      }
    }
  }
  const blurt = await blurtPriceRefFeed({ fetchImpl });
  if (blurt.ok && refs.blurtUsd == null) { refs.blurtUsd = blurt.data.priceUsd; sources.blurtUsd = "blurt:price_info"; }
  return { refs, sources, ok: Object.values(refs).some((v) => v != null) };
}

/* ══ הליבה-הטהורה — דטרמיניסטית לחלוטין; selftest על-fixtures מוקלטים ═══════ */

/** הליכה-בספר: vwap למילוי-size מהמגע-והחוצה (levels ממוינים-לטובת-הלוקח). */
export function walkVwap(levels, size) {
  if (!Array.isArray(levels) || !(size > 0)) return { vwap: null, filled: 0 };
  let remaining = size, cost = 0, filled = 0;
  for (const l of levels) {
    if (remaining <= 1e-12) break;
    const take = Math.min(remaining, l.qty);
    cost += take * l.price; filled += take; remaining -= take;
  }
  if (filled <= 0) return { vwap: null, filled: 0 };
  return { vwap: cost / filled, filled };
}

/** קצה-נטו אחרי-עמלת-בית על-שתי-הרגליים: buy×(1+f) מול sell×(1−f). */
export function netEdgeBps(buyPrice, sellPrice, feeBps = FEE_BPS) {
  if (!(buyPrice > 0) || !(sellPrice > 0)) return null;
  const effBuy = buyPrice * (1 + feeBps / 1e4);
  const effSell = sellPrice * (1 - feeBps / 1e4);
  return r6(((effSell - effBuy) / effBuy) * 1e4);
}

/**
 * עסקת-נייר אחת: קנייה-ומכירה של-executableSize על-המגע-של-שתי-הרגליים.
 * quoteConv נדרש כשהרגליים ביחידות-ציטוט-שונות (CEX-USDT/USD מול ספר-SBD/HBD):
 *   chainQuoteUsd = כמה דולר שווה יחידת-ציטוט-על-השרשרת (sbdUsd; HBD≈$1 כנה-בכנות).
 * refBuyPriceUsd/refSellPriceUsd (Z-87a): רגל-ייחוס-בלי-ספר (PAPER) — המחיר קבוע-מהמדד,
 *   אפס-עומק: הקצה נמדד מול-הייחוס אבל הגודל-בר-הביצוע נשאר 0 (כנות מוחלטת).
 * paperPnlSbd = הרווח/הפסד ב-SBD — עלול-להיות-שלילי (אין-קטיף-דובדבנים);
 *   חוק-Z88: PnL מחייב כמות-דו-צדדית-ברת-מימוש — רגל-ייחוס (אפס-עומק) → paperPnlSbd null
 *   (הקצה נשאר אות-מחיר; רווח-על-רגל-שאי-אפשר-לבצע-בה = כסף-מומצא);
 *   sbdUsd חסר → null (אסור לשקר ביחידות: PnL ב-USD לא נרשם כ-SBD).
 */
export function paperRoundTrip({ buyLevels, sellLevels, size, feeBps = FEE_BPS, buyQuoteUsd = 1, sellQuoteUsd = 1, sbdUsd = 1, refBuyPriceUsd = null, refSellPriceUsd = null }) {
  const b = walkVwap(buyLevels ?? [], size);
  const s = walkVwap(sellLevels ?? [], size);
  const buyHasDepth = b.vwap != null;
  const sellHasDepth = s.vwap != null;
  const effBuy = buyHasDepth ? b.vwap * (1 + feeBps / 1e4) * buyQuoteUsd : (refBuyPriceUsd != null && refBuyPriceUsd > 0 ? refBuyPriceUsd : null);
  const effSell = sellHasDepth ? s.vwap * (1 - feeBps / 1e4) * sellQuoteUsd : (refSellPriceUsd != null && refSellPriceUsd > 0 ? refSellPriceUsd : null);
  if (effBuy == null || effSell == null) return { edgeBps: null, paperPnlSbd: null, executableSize: 0, buyVwap: buyHasDepth ? r6(b.vwap) : null, sellVwap: sellHasDepth ? r6(s.vwap) : null };
  const edgeBps = r6(((effSell - effBuy) / effBuy) * 1e4);
  // גודל-בר-ביצוע = מינימום-העומק-על-הרגליים; רגל-ייחוס (אפס-עומק) → 0 כנה
  const sizeLim = Math.min(size, b.filled, s.filled);
  const twoSided = buyHasDepth && sellHasDepth;
  const executableSize = twoSided ? r6(sizeLim) : 0;
  // Z-88 truth-fix (בחן-היטב-ותקן): paperPnlSbd מחייב כמות-דו-צדדית-ברת-מימוש. רגל-ייחוס
  // אינה-ברת-ביצוע (אין-ספר-אמיתי שבו-הצד-ההוא נסחר) — הקצה נשאר אות-מחיר, ה-PnL = null.
  // עקביות-שכבות: זהו החוק שכבר-היה קיים בשכבת-הסשן (dex-core: ref-legs → size0/null-PnL).
  const paperPnlSbd = twoSided && sbdUsd != null && sbdUsd > 0 ? r6(((effSell - effBuy) * sizeLim) / sbdUsd) : null;
  return { edgeBps, paperPnlSbd, executableSize, buyVwap: buyHasDepth ? r6(b.vwap) : null, sellVwap: sellHasDepth ? r6(s.vwap) : null };
}

function worstRealness(tags) {
  let worst = "ONCHAIN_REAL";
  for (const t of tags) if ((REALNESS_RANK[t] ?? -1) < (REALNESS_RANK[worst] ?? -1)) worst = t;
  return worst;
}

/** רשומה-אחת שלמה מזוג-רגליים (טהור).
 * Wave-2 סעיף 4 (חוק-ההשתקה): קצה עם executableSize<=0 (או realness PAPER) מסומן
 * paperMuted=true + תווית 'PAPER-NO-EXECUTION:' ב-notes — קצה שאי-אפשר לבצע
 * לא מכתר יותר (לא ב-BEST, לא במצטבר-האסטרטגיה); הוא נשמר בפנקס כראיית-מחיר בלבד. */
export function makeEntry({ ts, pair, venueA, venueB, direction, buyLevels, sellLevels, size, feeBps = FEE_BPS, buyQuoteUsd = 1, sellQuoteUsd = 1, sbdUsd = 1, realnessTags, notes = "", refBuyPriceUsd = null, refSellPriceUsd = null }) {
  const rt = paperRoundTrip({ buyLevels, sellLevels, size, feeBps, buyQuoteUsd, sellQuoteUsd, sbdUsd, refBuyPriceUsd, refSellPriceUsd });
  const paperMuted = !(rt.executableSize > 0);
  return {
    ts, pair, venueA, venueB, edgeBps: rt.edgeBps, direction,
    executableSize: rt.executableSize,
    realness: worstRealness(realnessTags ?? []),
    paperPnlSbd: rt.paperPnlSbd,
    paperMuted,
    degraded: false,
    notes: paperMuted ? `PAPER-NO-EXECUTION: ${notes}` : notes,
  };
}

/** רשומת-דילוג כנה — פיד שנכשל: הזוג מדולג, לא משוחזר (fail-closed). */
export function degradedEntry({ ts, pair, venueA, venueB, direction, reason }) {
  return { ts, pair, venueA, venueB, edgeBps: null, direction, executableSize: 0, realness: "DEGRADED", paperPnlSbd: 0, paperMuted: true, degraded: true, notes: `fail-closed skip: ${reason}` };
}

/** חוק-ההשתקה (Wave-2 סעיף 4): קצה בלי-ביצוע = נייר-מושתק — לא מכתר, לא באסטרטגיה. */
export function isPaperMuted(e) {
  return e?.paperMuted === true || (!(e?.executableSize > 0) && !e?.degraded);
}

/**
 * הערכת-הזוגות על-פידים-נתונים (טהור). כל-זיווג נבדק בשני-הכיוונים;
 * קצה-שלילי נרשם-כמו-שהוא; פיד-חסר → רשומת-דילוג.
 * feeds: {steemBook, hiveBook, engineBook, htxSteem, htxHive, binanceSteem, binanceHive} — כל-אחד Book|null
 * refs:  {sbdUsd, hiveUsd, blurtUsd, steemUsd}
 */
export function evaluateFeeds({ feeds, refs, nowIso }) {
  const ts = nowIso ?? null; // הזמן מוזרק-בחוץ (דטרמיניזם)
  const sbdUsd = refs?.sbdUsd ?? null;
  const hiveUsd = refs?.hiveUsd ?? null;
  const blurtUsd = refs?.blurtUsd ?? null;
  const entries = [];

  const crossPair = ({ pair, chainBook, cexBook, venueCex, chainQuoteUsd, chainQuoteLabel, refNote }) => {
    if (!chainBook && !cexBook) { entries.push(degradedEntry({ ts, pair, venueA: "chain-internal", venueB: venueCex, direction: `${pair} cross-venue scan`, reason: "both books unavailable" })); return; }
    if (!chainBook) { entries.push(degradedEntry({ ts, pair, venueA: "chain-internal", venueB: venueCex, direction: `${pair} cross-venue scan`, reason: `chain book unavailable` })); return; }
    if (!cexBook) { entries.push(degradedEntry({ ts, pair, venueA: chainBook.venue, venueB: venueCex, direction: `${pair} cross-venue scan`, reason: `${venueCex} book unavailable` })); return; }
    if (chainQuoteUsd == null || !(chainQuoteUsd > 0)) {
      entries.push(degradedEntry({ ts, pair, venueA: chainBook.venue, venueB: venueCex, direction: `${pair} cross-venue scan`, reason: `no ${chainQuoteLabel}/USD ref — edge not computable without invention` }));
      return;
    }
    const tags = [chainBook.realness, cexBook.realness];
    // A: קנייה-על-השרשרת (אסק) → מכירה ב-CEX (ביד)
    if (chainBook.asks[0] && cexBook.bids[0]) {
      const size = Math.min(chainBook.asks[0].qty, cexBook.bids[0].qty);
      const e = makeEntry({
        ts, pair, venueA: chainBook.venue, venueB: cexBook.venue,
        direction: `buy ${pair.split(":")[0]} on-chain with ${pair.split(":")[1]} → sell on ${cexBook.venue} (USDT)`,
        buyLevels: chainBook.asks, sellLevels: cexBook.bids, size,
        buyQuoteUsd: chainQuoteUsd, sellQuoteUsd: 1, sbdUsd,
        realnessTags: tags, notes: refNote,
      });
      entries.push(e);
    }
    // B: קנייה ב-CEX (אסק) → מכירה-על-השרשרת (ביד)
    if (cexBook.asks[0] && chainBook.bids[0]) {
      const size = Math.min(cexBook.asks[0].qty, chainBook.bids[0].qty);
      entries.push(makeEntry({
        ts, pair, venueA: cexBook.venue, venueB: chainBook.venue,
        direction: `buy ${pair.split(":")[0]} on ${cexBook.venue} (USDT) → sell on-chain for ${pair.split(":")[1]}`,
        buyLevels: cexBook.asks, sellLevels: chainBook.bids, size,
        buyQuoteUsd: 1, sellQuoteUsd: chainQuoteUsd, sbdUsd,
        realnessTags: tags, notes: refNote,
      }));
    }
  };

  // STEEM:SBD — ספר-פנים מול-HTX ומול-Binance; המרה דרך sbdUsd (SBD חי-רק-ב-HTX)
  const steemNote = "chain quote=SBD×sbdUsd→USD; CEX leg is REF until a wallet rail is armed (Z-86a: HTX wallets verified-allowed)";
  if (feeds.steemBook == null) entries.push(degradedEntry({ ts, pair: "STEEM:SBD", venueA: "steem-internal", venueB: "htx/binance", direction: "STEEM:SBD cross-venue scan", reason: feeds._steemBookError ?? "steem internal book unavailable" }));
  else {
    if (feeds.htxSteem) crossPair({ pair: "STEEM:SBD", chainBook: feeds.steemBook, cexBook: feeds.htxSteem, venueCex: "htx", chainQuoteUsd: sbdUsd, chainQuoteLabel: "SBD", refNote: steemNote });
    else entries.push(degradedEntry({ ts, pair: "STEEM:SBD", venueA: "steem-internal", venueB: "htx", direction: "STEEM:SBD cross-venue scan", reason: feeds._htxSteemError ?? "htx steemusdt unavailable" }));
    if (feeds.binanceSteem) crossPair({ pair: "STEEM:SBD", chainBook: feeds.steemBook, cexBook: feeds.binanceSteem, venueCex: "binance", chainQuoteUsd: sbdUsd, chainQuoteLabel: "SBD", refNote: steemNote });
    else entries.push(degradedEntry({ ts, pair: "STEEM:SBD", venueA: "steem-internal", venueB: "binance", direction: "STEEM:SBD cross-venue scan", reason: feeds._binanceSteemError ?? "binance steemusdt unavailable" }));
  }

  // HIVE:HBD — HBD מנוחה-$1 בכנות (משטר-החתך; אין-רצפת-0.955 על-הספר — Z-86a)
  const hiveNote = "chain quote=HBD assumed $1.00 (haircut regime, no floor bids measured — Z-86a); CEX leg REF";
  if (feeds.hiveBook == null) entries.push(degradedEntry({ ts, pair: "HIVE:HBD", venueA: "hive-internal", venueB: "htx", direction: "HIVE:HBD cross-venue scan", reason: feeds._hiveBookError ?? "hive internal book unavailable" }));
  else if (!feeds.htxHive) entries.push(degradedEntry({ ts, pair: "HIVE:HBD", venueA: "hive-internal", venueB: "htx", direction: "HIVE:HBD cross-venue scan", reason: feeds._htxHiveError ?? "htx hiveusdt unavailable" }));
  else crossPair({ pair: "HIVE:HBD", chainBook: feeds.hiveBook, cexBook: feeds.htxHive, venueCex: "htx", chainQuoteUsd: 1, chainQuoteLabel: "HBD", refNote: hiveNote });

  // SWAP.BLURT:SWAP.HIVE — ספר-Engine מול-שער-ייחוס-בלרט (PAPER — אין-ספר-בלרט ציבורי)
  if (feeds.engineBook && blurtUsd != null && hiveUsd != null) {
    const eng = feeds.engineBook;
    const tags = [eng.realness, "PAPER"];
    // Z-87a: הקצה נמדד מול-הייחוס (רגל-הייחוס היא מחיר-קבוע בלי-עומק — refSell/refBuy),
    // הגודל-בר-הביצוע נשאר 0 כנה, realness PAPER, paperPnlSbd = null (חוק-Z88: אין-כמות-ברת-מימוש).
    const refInHive = hiveUsd > 0 ? blurtUsd / hiveUsd : null; // BLURT price expressed in SWAP.HIVE units
    if (eng.asks[0] && refInHive != null) {
      entries.push(makeEntry({
        ts, pair: "SWAP.BLURT:SWAP.HIVE", venueA: eng.venue, venueB: "blurt-price-ref",
        direction: "buy SWAP.BLURT on Engine → sell BLURT at USD ref (paper)",
        buyLevels: eng.asks, sellLevels: null, size: eng.asks[0].qty,
        refSellPriceUsd: blurtUsd,
        buyQuoteUsd: hiveUsd, sellQuoteUsd: 1, sbdUsd,
        realnessTags: tags,
        notes: "sell side is price_ref only — no Blurt orderbook on public nodes (Z-86a); edge measured vs ref, executable size 0 — PAPER",
      }));
    }
    if (eng.bids[0] && refInHive != null) {
      entries.push(makeEntry({
        ts, pair: "SWAP.BLURT:SWAP.HIVE", venueA: "blurt-price-ref", venueB: eng.venue,
        direction: "buy BLURT at USD ref (paper) → sell SWAP.BLURT on Engine",
        buyLevels: null, sellLevels: eng.bids, size: eng.bids[0].qty,
        refBuyPriceUsd: blurtUsd,
        buyQuoteUsd: 1, sellQuoteUsd: hiveUsd, sbdUsd,
        realnessTags: tags,
        notes: "buy side is price_ref only — PAPER; bridge exit = memo to @graphene-swap/@blurt-swap (fee unknown, not invented); executable size 0",
      }));
    }
  } else {
    entries.push(degradedEntry({ ts, pair: "SWAP.BLURT:SWAP.HIVE", venueA: "hive-engine", venueB: "blurt-price-ref", direction: "SWAP.BLURT cross-venue scan", reason: !feeds.engineBook ? (feeds._engineBookError ?? "engine book unavailable") : "blurt/HIVE USD ref unavailable" }));
  }

  return entries;
}

/* ══ הפנקס המצטבר — הסכימה המדויקת arb-ledger-v1 ═══════════════════════════ */

export function emptyLedger() {
  return { schema: LEDGER_SCHEMA, layer: LEDGER_LAYER, generatedAt: null, entries: [], cumulative: { paperPnlSbd: 0, entries: 0, positiveEntries: 0, realized: false, strategyPnlSbd: 0, strategyEntries: 0, mutedEntries: 0 } };
}

/** עדכון-פנקס טהור: מצטבר-כל-הזמנים שורד את-תקרת-ה-200-רשומות. */
export function updateLedger(prev, newEntries, { generatedAt, cap = LEDGER_CAP } = {}) {
  const base = prev && prev.schema === LEDGER_SCHEMA && prev.cumulative ? prev : emptyLedger();
  const added = Array.isArray(newEntries) ? newEntries : [];
  const entries = [...(base.entries ?? []), ...added].slice(-cap);
  const sumPnl = added.reduce((s, e) => s + (typeof e?.paperPnlSbd === "number" ? e.paperPnlSbd : 0), 0);
  const sumPos = added.filter((e) => !e?.degraded && typeof e?.edgeBps === "number" && e.edgeBps > 0).length;
  // R25 · מצטבר-האסטרטגיה: רק-קצוות-חיוביים ברי-ביצוע (edge>0 + paperPnlSbd מספרי —
  // שני-הצדדים קיימים לפי חוק-Z88). רשומת-PAPER (pnl=null) לא נספרת — אין-כסף-מומצא.
  // Wave-2 · חוק-ההשתקה: גם paperMuted (executableSize<=0) מוצא-מן-המניין בגלוי —
  // הפרדה מפורשת (זהה-משמעותית לחוק-Z88; נאכפת-כאן במפורש ולא במקרה).
  const strat = added.filter((e) => !e?.degraded && !e?.paperMuted && typeof e?.edgeBps === "number" && e.edgeBps > 0 && typeof e?.paperPnlSbd === "number");
  const sumStratPnl = strat.reduce((s, e) => s + e.paperPnlSbd, 0);
  // Wave-2 · מונה-המושתקים: רשומות ברות-מדידה-אך-שאינן-ברות-ביצוע (כנות-כמותית)
  const mutedCount = added.filter((e) => !e?.degraded && isPaperMuted(e)).length;
  return {
    schema: LEDGER_SCHEMA,
    layer: LEDGER_LAYER, // provenance stamped on every write — even when base prev lacked it
    generatedAt: generatedAt ?? null,
    entries,
    cumulative: {
      paperPnlSbd: r6((base.cumulative.paperPnlSbd ?? 0) + sumPnl),
      entries: (base.cumulative.entries ?? 0) + added.length,
      positiveEntries: (base.cumulative.positiveEntries ?? 0) + sumPos,
      realized: false, // נייר-בלבד — מתקבל-אמת רק-אחרי-חימוש-מסילה-ע"י-הבעלים
      strategyPnlSbd: r6((base.cumulative.strategyPnlSbd ?? 0) + sumStratPnl),
      strategyEntries: (base.cumulative.strategyEntries ?? 0) + strat.length,
      mutedEntries: (base.cumulative.mutedEntries ?? 0) + mutedCount,
    },
  };
}

export function loadLedger(path = LEDGER_PATH) {
  try {
    if (!existsSync(path)) return null;
    const j = JSON.parse(readFileSync(path, "utf8"));
    return j?.schema === LEDGER_SCHEMA ? j : null;
  } catch { return null; }
}

export function saveLedger(ledger, path = LEDGER_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(ledger, null, 1) + "\n");
}

/* ══ הריצה-החיה — never throws; כל-כישלון-פיד הופך-לרשומת-דילוג כנה ══════════ */

export async function gatherFeeds({ fetchImpl = fetch } = {}) {
  const [steem, hive, engine, htxSteem, htxHive, binSteem, binHive] = await Promise.allSettled([
    steemBookFeed({ fetchImpl }), hiveBookFeed({ fetchImpl }), engineBookFeed("SWAP.BLURT", { fetchImpl }),
    htxDepthFeed("steemusdt", { fetchImpl }), htxDepthFeed("hiveusdt", { fetchImpl }),
    binanceTopFeed("STEEMUSDT", { fetchImpl }), binanceTopFeed("HIVEUSDT", { fetchImpl }),
  ]);
  const val = (r) => (r.status === "fulfilled" && r.value.ok ? r.value.data : null);
  const err = (r) => (r.status === "fulfilled" ? r.value.error : String(r.reason).slice(0, 100));
  return {
    steemBook: val(steem), hiveBook: val(hive), engineBook: val(engine),
    htxSteem: val(htxSteem), htxHive: val(htxHive), binanceSteem: val(binSteem), binanceHive: val(binHive),
    _steemBookError: err(steem), _hiveBookError: err(hive), _engineBookError: err(engine),
    _htxSteemError: err(htxSteem), _htxHiveError: err(htxHive), _binanceSteemError: err(binSteem), _binanceHiveError: err(binHive),
  };
}

export async function runArbScan({ ledgerPath = LEDGER_PATH, fetchImpl = fetch, nowIso = null, cap = LEDGER_CAP } = {}) {
  const at = nowIso ?? new Date().toISOString(); // הזמן האמיתי רק-בריצה-החיה (לא-בליבה)
  const [feeds, refsBox] = await Promise.allSettled([gatherFeeds({ fetchImpl }), measureRefs({ fetchImpl })]);
  const f = feeds.status === "fulfilled" ? feeds.value : gatherFeeds.__emptyFallback();
  const refs = refsBox.status === "fulfilled" ? refsBox.value : { refs: {}, sources: {}, ok: false };
  const entries = evaluateFeeds({ feeds: f, refs: refs.refs, nowIso: at });
  const prev = loadLedger(ledgerPath);
  const ledger = updateLedger(prev, entries, { generatedAt: at, cap });
  // Wave-2 סעיף 1: פסיקת-אמת על מילויים — מוטמעת בפנקס ומפורסמת באותו-נתיב-קבלות
  // שה-CI מקומיט (arb-scan.yml → arb-ledger.json). שער-שנכשל → הפנקס יוצא בלי-truthGate
  // עם-שדה-שגיאה כנה (לעולם לא פסיקה מזויפת).
  try {
    const { truthGateFromFiles } = await import("./truth-gate.mjs");
    ledger.truthGate = truthGateFromFiles({ nowIso: at });
  } catch (e) {
    ledger.truthGateError = `truth-gate unavailable (honest): ${String(e?.message ?? e).slice(0, 100)}`;
  }
  saveLedger(ledger, ledgerPath);
  return { at, entries, ledger, refs, sources: refs.sources };
}

gatherFeeds.__emptyFallback = () => ({
  steemBook: null, hiveBook: null, engineBook: null, htxSteem: null, htxHive: null, binanceSteem: null, binanceHive: null,
  _steemBookError: "feeds stage crashed", _hiveBookError: "feeds stage crashed", _engineBookError: "feeds stage crashed",
  _htxSteemError: "feeds stage crashed", _htxHiveError: "feeds stage crashed", _binanceSteemError: "feeds stage crashed", _binanceHiveError: "feeds stage crashed",
});

/* ── CLI: node grids/arb-scan.mjs [--selftest] ────────────────────────────── */
if (process.argv[1] && process.argv[1].endsWith("arb-scan.mjs")) {
  if (process.argv.includes("--selftest")) {
    await import("./arb-selftest.mjs");
  } else {
    try {
      const { at, entries, ledger, sources } = await runArbScan();
      // Wave-2 סעיף 4: ה-BEST מחושב רק על קצוות ברי-ביצוע — נייר-מושתק לא מכתר יותר
      // (מדוד-חי 2026-10-05: ה-1584bps SWAP.BLURT שכתר היה רשומת-PAPER בגודל-0).
      const best = entries.filter((e) => !e.degraded && !isPaperMuted(e) && typeof e.edgeBps === "number").sort((a, b) => b.edgeBps - a.edgeBps)[0];
      const degraded = entries.filter((e) => e.degraded).length;
      const muted = entries.filter((e) => !e.degraded && isPaperMuted(e)).length;
      const tg = ledger.truthGate;
      console.log(`[arb-scan] ${at} · entries ${entries.length} (degraded ${degraded} · paper-muted ${muted}) · cumulative ${ledger.cumulative.paperPnlSbd} SBD over ${ledger.cumulative.entries} entries · strategy ${ledger.cumulative.strategyPnlSbd} SBD/${ledger.cumulative.strategyEntries}e`);
      console.log(`[truth-gate] ${tg?.verdict ?? "unavailable"} · realFills24h ${tg?.realFills24h ?? "unmeasured"} · realFillsEver ${tg?.realFillsEver ?? 0} · ${tg?.law ?? ""}`);
      console.log(`[arb-scan] refs: ${JSON.stringify(sources)}`);
      if (best) console.log(`[arb-scan] best EXECUTABLE edge: ${best.edgeBps}bps · ${best.direction} · size ${best.executableSize} · realness ${best.realness}`);
      else console.log("[arb-scan] best EXECUTABLE edge: none (paper edges muted — Wave-2 §4)");
      console.log("[arb-scan] law: scan-only receipts — execution stays owner-armed and gated");
    } catch (e) {
      // לעולם לא נופל: גם-כאן — רישום-כנה ויציאה-רכה (CI continue-on-error)
      console.error(`[arb-scan] honest failure (no ledger mutation): ${String(e?.message ?? e).slice(0, 140)}`);
      process.exitCode = 0;
    }
  }
}
