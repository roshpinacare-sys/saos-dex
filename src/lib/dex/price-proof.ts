/**
 * price-proof.ts — מנוע-הוכחת-המחיר (Task 56, פידים-מאוחדים-ב-58) · Price-Proof Engine
 * ═════════════════════════════════════════════════════════════════════════════
 * דבר-המפעיל: "חייב לפתוח כמה שיותר ולאמת את המחיר האמיתי של SAOS — הרי אין
 * לנו באמת יתרות כאלה". התשובה: שרשרת-הוכחה גלויה מקצה-לקצה, בלי-מספר-יחיד-
 * סמכותי-שאי-אפשר-לבדוק:
 *
 *  1. שרשרת-נגזרת (דטרמיניסטית, מהמצב-החי): mid SAOS/USDS ÷ mid WSTEEM/USDS
 *     → SAOS/WSTEEM → ×מחיר-STEEM-אמת (שוק-ציבורי) → **SAOS-ב-$-אמת**.
 *     ה-WSTEEM מגובה-1:1 ב-STEEM אמת (backing) — העיגון הוא הראיה.
 *  2. פידים-עמידים (Task 58): שרשרת-מקורות-ממוינת — CoinGecko → CoinPaprika →
 *     CryptoCompare → Binance; לכל-נכס המקור-הראשון-שענה זוכה, שדה-מקור-גלוי,
 *     קאש-last-good-עד-שעה עם דגל-STALE כנה — אין-עוד-NO-FEED בגלל-מקור-אחד.
 *  3. עומק-אמת (depth profile): סימולציית-שלמים של פגיעה במחיר עבור מסחרות
 *     של 0.5%..10% מהרזרבות — "מה המחיר באמת" = כמה אפשר לממש ובאיזה מחיר.
 *  4. הצלבה-חוץ (cross-venue): מחיר-הבריכה של WSTEEM/USDS מול STEEM/USD ציבורי
 *     → סטייה ב-bps + פס-דין (CONVERGED/DRIFT/DIVERGENT/STALE) — ה-MAD הכנה שלנו.
 *  5. אוצר-אמת (כמה יש לנו באמת): יתרות-השרשראות החיות (STEEM/SBD מ-api.steemit.com,
 *     HIVE/HBD מ-api.hive.blog, BLURT מ-blurt-rpc.saboin.com) × מחירי-שוק-אמת
 *     = שווי-הכספת-החוץ-ב-$ — המספרים הקטנים-והאמיתיים, מוצגים-כמו-שהם.
 *
 * אפס-סודות · קריאה-בלבד · TTL-קאש · fail-כנה-כשפיד-חוץ-לא-עונה.
 */
import type { DexState } from "./kernel";
import { getPool, poolMid, poolMidFor } from "./amm";
import { sortBook } from "./book";
import { assertAllowedHost } from "./fence";
import { onrampSnapshot } from "@/lib/onramp";

// ─── פידים-חוץ-אמת — שרשרת-מקורות-ממוינת (Task 58: עמידות-ל-429/השבתות) ───────
const CG_URL = "https://api.coingecko.com/api/v3/simple/price?ids=steem,hive,hive_dollar,blurt&vs_currencies=usd";
const BLURT_NODE = "https://blurt-rpc.saboin.com";
const HEAD_ACCOUNT = "headcorner";
const FEED_TTL_MS = 5 * 60_000;
const FEED_STALE_OK_MS = 60 * 60_000; // last-good-חוקי עד-שעה — מעבר-לזה: NO-FEED כנה

type FeedKey = "steem" | "hive" | "hbd" | "blurt";
type FeedVal = { v: number | null; src: string | null };
type FeedMap = Record<FeedKey, FeedVal>;

interface FeedSource { name: string; url: string; where: string; parse: (j: unknown) => Partial<Record<FeedKey, number | null>> }

const FEED_SOURCES: FeedSource[] = [
  {
    name: "coingecko",
    url: CG_URL,
    where: "price-proof/coingecko",
    parse: (j) => {
      const o = j as Record<string, { usd?: number }>;
      const p = (id: string): number | null => (typeof o[id]?.usd === "number" && o[id].usd > 0 ? o[id].usd : null);
      return { steem: p("steem"), hive: p("hive"), hbd: p("hive_dollar"), blurt: p("blurt") };
    },
  },
  {
    name: "coinpaprika",
    url: "https://api.coinpaprika.com/v1/tickers?quotes=USD",
    where: "price-proof/coinpaprika",
    parse: (j) => {
      const arr = Array.isArray(j) ? (j as { id?: string; quotes?: { USD?: { price?: number } } }[]) : [];
      const p = (id: string): number | null => {
        const row = arr.find((x) => x.id === id);
        const v = row?.quotes?.USD?.price;
        return typeof v === "number" && v > 0 ? v : null;
      };
      return { steem: p("steem-steem"), hive: p("hive-hive"), blurt: p("blurt-blurt") };
    },
  },
  {
    name: "cryptocompare",
    url: "https://min-api.cryptocompare.com/data/pricemulti?fsyms=STEEM,HIVE,HBD,BLURT&tsyms=USD",
    where: "price-proof/cryptocompare",
    parse: (j) => {
      const o = j as Record<string, Record<string, number>>;
      const p = (sym: string): number | null => {
        const v = o[sym]?.USD;
        return typeof v === "number" && v > 0 ? v : null;
      };
      return { steem: p("STEEM"), hive: p("HIVE"), hbd: p("HBD"), blurt: p("BLURT") };
    },
  },
  {
    name: "binance",
    url: "https://api.binance.com/api/v3/ticker/price?symbols=%5B%22STEEMUSDT%22,%22HIVEUSDT%22%5D",
    where: "price-proof/binance",
    parse: (j) => {
      const arr = Array.isArray(j) ? (j as { symbol?: string; price?: string }[]) : [];
      const p = (sym: string): number | null => {
        const row = arr.find((x) => x.symbol === sym);
        const v = parseFloat(String(row?.price ?? ""));
        return Number.isFinite(v) && v > 0 ? v : null;
      };
      return { steem: p("STEEMUSDT"), hive: p("HIVEUSDT") };
    },
  },
];

export interface ExtFeeds {
  ok: boolean;
  at: number;
  stale: boolean;
  usd: { steem: number | null; hive: number | null; hbd: number | null; blurt: number | null };
  src: { steem?: string | null; hive?: string | null; hbd?: string | null; blurt?: string | null };
  error?: string;
}

interface FeedRT { at: number; data: ExtFeeds | null; inflight: Promise<ExtFeeds> | null }
const g = globalThis as unknown as { __saosPriceFeeds?: FeedRT };
function feedRt(): FeedRT {
  if (!g.__saosPriceFeeds) g.__saosPriceFeeds = { at: 0, data: null, inflight: null };
  return g.__saosPriceFeeds;
}

async function fetchOne(s: FeedSource): Promise<Partial<Record<FeedKey, number | null>>> {
  assertAllowedHost(s.url, s.where);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8_000);
  try {
    const r = await fetch(s.url, { signal: ac.signal, cache: "no-store", headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`${s.name} ${r.status}`);
    return s.parse(await r.json());
  } finally {
    clearTimeout(t);
  }
}

async function fetchFeeds(): Promise<ExtFeeds> {
  const merged: FeedMap = { steem: { v: null, src: null }, hive: { v: null, src: null }, hbd: { v: null, src: null }, blurt: { v: null, src: null } };
  const errs: string[] = [];
  // בסדר-קנוני: הראשון-שענה-לנכס זוכה (סדר-קבוע = דטרמיניזם-קריאה)
  for (const s of FEED_SOURCES) {
    try {
      const vals = await fetchOne(s);
      for (const k of Object.keys(merged) as FeedKey[]) {
        if (merged[k].v === null && typeof vals[k] === "number" && vals[k] > 0) {
          merged[k] = { v: vals[k] as number, src: s.name };
        }
      }
    } catch (e) {
      errs.push(`${s.name}: ${e instanceof Error ? e.message : "err"}`);
    }
  }
  const any = (Object.keys(merged) as FeedKey[]).some((k) => merged[k].v !== null);
  if (any) {
    return {
      ok: true, at: Date.now(), stale: false,
      usd: { steem: merged.steem.v, hive: merged.hive.v, hbd: merged.hbd.v, blurt: merged.blurt.v },
      src: { steem: merged.steem.src, hive: merged.hive.src, hbd: merged.hbd.src, blurt: merged.blurt.src },
      error: errs.length > 0 ? errs.join("; ") : undefined, // כנות: מקורות-שנפלו נראים
    };
  }
  // fail-כנה: אין-מקור-חי = אין-מחיר-חוץ (לא מאולף)
  return { ok: false, at: Date.now(), stale: false, usd: { steem: null, hive: null, hbd: null, blurt: null }, src: {}, error: errs.join("; ") || "all-sources-down" };
}

export async function extFeeds(force = false): Promise<ExtFeeds> {
  const m = feedRt();
  if (!force && m.data?.ok && Date.now() - m.at < FEED_TTL_MS) return { ...m.data, stale: false };
  if (m.inflight) return m.inflight;
  m.inflight = fetchFeeds().then((d) => {
    m.inflight = null;
    if (d.ok) {
      m.at = Date.now();
      m.data = d;
      return d;
    }
    // אין-מקור-חי — last-good-עד-שעה עם דגל-STALE כנה (ומקור-המחיר-המקורי-שמור)
    if (m.data?.ok && Date.now() - m.at < FEED_STALE_OK_MS) {
      return { ...m.data, stale: true, error: d.error };
    }
    return d;
  }).catch(() => {
    m.inflight = null;
    if (m.data?.ok && Date.now() - m.at < FEED_STALE_OK_MS) {
      return { ...m.data, stale: true, error: "feed-crash" } as ExtFeeds;
    }
    return { ok: false, at: Date.now(), stale: false, usd: { steem: null, hive: null, hbd: null, blurt: null }, src: {}, error: "feed-crash" } as ExtFeeds;
  });
  return m.inflight;
}

/** BLURT-ראש — הרשת-השלישית שלנו (Task 4): יתרת-headcorner החיה מהצומת-הקהילתי */
export async function blurtHead(): Promise<{ account: string; liquid: number; vested: number } | null> {
  try {
    assertAllowedHost(BLURT_NODE, "price-proof/blurt");
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 10_000);
    const r = await fetch(BLURT_NODE, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "condenser_api.get_accounts", params: [[HEAD_ACCOUNT]], id: 1 }),
      signal: ac.signal, cache: "no-store",
    });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = (await r.json()) as { result?: Array<Record<string, string>> };
    const a = (j.result ?? []).find((x) => x.name === HEAD_ACCOUNT);
    if (!a) return null;
    const num = (s: string | undefined): number => {
      const v = parseFloat(String(s ?? "0").replace(/,/g, "").split(" ")[0]);
      return Number.isFinite(v) ? v : 0;
    };
    return { account: HEAD_ACCOUNT, liquid: num(a.balance), vested: num(a.vesting_shares) };
  } catch {
    return null; // fail-כנה
  }
}

// ─── עומק-אמת (depth profile) — סימולציית-שלמים על הבריכה החיה ──────────────
export interface DepthRow { pctOfReserve: number; amountInBaseMu: number; effPriceMu: number; impactBps: number }

export function depthProfile(st: DexState, key: string, baseDir: boolean): { rows: DepthRow[]; midMu: number } | null {
  const p = st.pools[key];
  if (!p || p.ra <= 0 || p.rb <= 0) return null;
  const mid = poolMid(p); // µ-ציטוט ל-1µ-בסיס ×1000
  const rIn = baseDir ? p.ra : p.rb;
  const rows: DepthRow[] = [];
  for (const pct of [0.5, 1, 2, 5, 10]) {
    const amountIn = Math.floor((rIn * pct) / 100);
    if (!(amountIn > 0)) continue;
    const inA = baseDir ? true : false;
    const rInRes = baseDir ? p.ra : p.rb, rOutRes = baseDir ? p.rb : p.ra;
    const feeBps = 30; // עמלת-בסיס — הפרופיל מייצג-עומק, לא-תמחור-דינמי
    const feeAmt = Math.floor((amountIn * feeBps) / 10_000);
    const inAfterFee = amountIn - feeAmt;
    const out = Math.floor((rOutRes * inAfterFee) / (rInRes + inAfterFee));
    if (!(out > 0)) continue;
    const eff = inA ? Math.floor((out * 1000) / amountIn) : Math.floor((amountIn * 1000) / out);
    const impactBps = mid > 0 ? Math.floor((Math.abs(eff - mid) * 10_000) / mid) : 0;
    rows.push({ pctOfReserve: pct, amountInBaseMu: amountIn, effPriceMu: eff, impactBps });
  }
  return { rows, midMu: mid };
}

/** עומק-ספר בתוך-1% מהמחיר-האמצעי (bids+asks) — עומק-אמת-פר-זוג */
export function bookDepth1pct(st: DexState, base: string, quote: string): { bidMu: number; askMu: number; orders: number } {
  const key = [base, quote].sort().join("/");
  const p = st.pools[key];
  const mid = p ? poolMidFor(p, base, quote) : 0;
  if (!(mid > 0)) return { bidMu: 0, askMu: 0, orders: 0 };
  const floorPx = Math.floor((mid * 99) / 100);
  const ceilPx = Math.floor((mid * 101) / 100);
  let bidMu = 0, askMu = 0, orders = 0;
  for (const o of sortBook(st, base, quote, "buy")) {
    if (o.price < floorPx) break;
    const rem = o.amount - o.filled;
    if (rem > 0) { bidMu += rem; orders++; }
  }
  for (const o of sortBook(st, base, quote, "sell")) {
    if (o.price > ceilPx) break;
    const rem = o.amount - o.filled;
    if (rem > 0) { askMu += rem; orders++; }
  }
  return { bidMu, askMu, orders };
}

// ─── שרשרת-הנגזרת — SAOS ב-$-אמת דרך-העיגון ────────────────────────────────
export interface PriceProof {
  ok: boolean;
  height: number;
  at: string;
  internal: {
    saosUsdsMu: number;        // mid SAOS/USDS (µ-USDS ל-1µ-SAOS ×1000)
    wsteemUsdsMu: number;      // mid WSTEEM/USDS בכיוון-הנכון (µ-USDS ל-1µ-WSTEEM ×1000)
    wsteemPerSaosBps: number;  // כמה WSTEEM ב-SAOS-אחד (×10⁴) — ציר-העיגון
    backingWsteemMu: number;   // גיבוי-1:1 אמת
  };
  external: {
    steemUsd: number | null;
    hiveUsd: number | null;
    hbdUsd: number | null;
    blurtUsd: number | null;
    feedOk: boolean;
    feedStale: boolean;
    feedSrc: { steem?: string | null; hive?: string | null; hbd?: string | null; blurt?: string | null };
    feedError?: string;
  };
  derived: {
    saosUsdMicro: number | null;   // SAOS ב-$-אמת (µ$ = 10⁻⁶ $)
    saosUsdText: string | null;
    wsteemDivBps: number | null;   // סטיית-הבריכה מול-השוק-הציבורי
    verdict: "CONVERGED" | "DRIFT" | "DIVERGENT" | "NO-FEED" | "STALE";
  };
  depth: {
    saosUsds: { rows: DepthRow[]; midMu: number } | null;
    wsteemUsds: { rows: DepthRow[]; midMu: number } | null;
    book1pct: { bidMu: number; askMu: number; orders: number };
  };
  treasuryReal: {
    feedsNote: string;
    steemHead: { account: string; steem: number; sbd: number; sp: number } | null;
    hiveFleet: { liquidHive: number; hbd: number; hp: number } | null;
    blurt: { account: string; liquid: number; vested: number } | null;
    usd: { steem: number | null; hbd: number | null; hive: number | null; blurt: number | null; total: number | null };
    honesty: string;
  };
}

const fmtUsd = (v: number): string => (v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`);

/** המאגד-המלא — נקרא מ-/api/dex/price-proof (GET ציבורי) */
export async function priceProof(st: DexState): Promise<PriceProof> {
  const saosPool = st.pools["SAOS/USDS"];
  const wstPool = st.pools["USDS/WSTEEM"];
  const saosUsdsMu = saosPool ? poolMid(saosPool) : 0;
  const wsteemUsdsMu = wstPool ? poolMidFor(wstPool, "WSTEEM", "USDS") : 0;
  // ציר-העיגון: כמה WSTEEM ב-SAOS אחד = (USDS/SAOS) ÷ (USDS/WSTEEM) ×10⁴
  // = saosUsdsMu/wsteemUsdsMu ×10⁴ (ה-1000-ים נחתכים)
  const wsteemPerSaosBps = saosUsdsMu > 0 && wsteemUsdsMu > 0
    ? Math.floor((saosUsdsMu * 10_000) / wsteemUsdsMu)
    : 0;

  const [feeds, blurt, onramp] = await Promise.all([extFeeds(), blurtHead(), onrampSnapshot().catch(() => null)]);

  // SAOS-ב-$ (µ$ = 10⁻⁶ $): (WSTEEM/SAOS × steemUsd). יחידות: bps=×10⁻⁴ WSTEEM/SAOS
  // × $/STEEM → $/SAOS. ב-µ$: ×10⁶ → wsteemPerSaosBps × steemUsd × 10².
  const steemUsd = feeds.usd.steem;
  const saosUsdMicro = steemUsd !== null && wsteemPerSaosBps > 0
    ? wsteemPerSaosBps * steemUsd * 100
    : null;
  const saosUsdText = saosUsdMicro !== null ? fmtUsd(saosUsdMicro / 1_000_000) : null;

  // הצלבה-חוץ: מחיר-הבריכה של WSTEEM (ב-$) מול STEEM-ציבורי
  const wsteemPoolUsd = wsteemUsdsMu > 0 ? wsteemUsdsMu / 1000 : 0; // USDS≈$-יחידת-חשבון-פנימית
  const wsteemDivBps = steemUsd !== null && wsteemPoolUsd > 0
    ? Math.floor(((wsteemPoolUsd - steemUsd) / steemUsd) * 10_000)
    : null;
  const verdict: PriceProof["derived"]["verdict"] =
    wsteemDivBps === null ? "NO-FEED" : feeds.stale ? "STALE" : Math.abs(wsteemDivBps) < 300 ? "CONVERGED" : Math.abs(wsteemDivBps) < 1_500 ? "DRIFT" : "DIVERGENT";

  // אוצר-אמת: הכסף-החוץ-החי × מחירי-שוק-אמת
  const steemHead = onramp?.steemHead ?? null;
  const hiveFleet = onramp ? { liquidHive: onramp.totals.liquidHive, hbd: onramp.totals.hbd, hp: onramp.totals.hp } : null;
  const hiveUsd = feeds.usd.hive, hbdUsd = feeds.usd.hbd, blurtUsd = feeds.usd.blurt;
  const usdSteem = steemHead && steemUsd !== null ? steemHead.steem * steemUsd : null;
  const usdHbd = steemHead && hbdUsd !== null ? steemHead.sbd * hbdUsd : null;
  const usdHive = hiveFleet && hiveUsd !== null ? (hiveFleet.liquidHive + hiveFleet.hp) * hiveUsd : null;
  const usdBlurt = blurt && blurtUsd !== null ? blurt.liquid * blurtUsd : null;
  const parts = [usdSteem, usdHbd, usdHive, usdBlurt].filter((x): x is number => x !== null);
  const usdTotal = parts.length > 0 ? parts.reduce((s, x) => s + x, 0) : null;

  return {
    ok: true,
    height: st.height,
    at: new Date().toISOString(),
    internal: {
      saosUsdsMu,
      wsteemUsdsMu,
      wsteemPerSaosBps,
      backingWsteemMu: st.backing["WSTEEM"] ?? 0,
    },
    external: {
      steemUsd, hiveUsd, hbdUsd, blurtUsd,
      feedOk: feeds.ok,
      feedStale: feeds.stale,
      feedSrc: feeds.src,
      feedError: feeds.error,
    },
    derived: {
      saosUsdMicro: saosUsdMicro,
      saosUsdText,
      wsteemDivBps,
      verdict,
    },
    depth: {
      saosUsds: saosPool ? depthProfile(st, "SAOS/USDS", true) : null,
      wsteemUsds: wstPool ? depthProfile(st, "USDS/WSTEEM", false) : null,
      book1pct: bookDepth1pct(st, "SAOS", "USDS"),
    },
    treasuryReal: {
      feedsNote: onramp?.note ?? "קריאה-ציבורית-חסרת-מפתחות-מה-RPC-המקובע",
      steemHead: steemHead ? { account: steemHead.account, steem: steemHead.steem, sbd: steemHead.sbd, sp: steemHead.sp } : null,
      hiveFleet,
      blurt,
      usd: { steem: usdSteem, hbd: usdHbd, hive: usdHive, blurt: usdBlurt, total: usdTotal },
      honesty: "אלה יתרות-השרשראות-הציבוריות-האמת שלנו × מחירי-שוק-אמת — המספרים-הקטנים-והאמיתיים. מצב-הספר-הפנימי (SAOS/USDS) הוא סימולציה-ריבונית נפרדת ומתועדת-ככזו.",
    },
  };
}
