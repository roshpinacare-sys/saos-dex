/**
 * klines.ts — נתוני-שוק מוסדיים (CEX-grade market data) — חוץ-מצב קנוני.
 * ═════════════════════════════════════════════════════════════════════════════
 * סטנדרט-המובילים (Binance/dYdX/Hyperliquid/PancakeSwap): כל בורסה רצינית חושפת
 * OHLCV-נרות (1m בסיס + צבירות), היסטוריית-עסקאות מנותבת וסטטיסטיקת-24ש'.
 * אצלנו: הנרות נגזרים **ממסחר-אמת בלבד** (כל fill/swap שעובר את הגרעין) —
 * אפס-נרות-מזויפים, אפס-מילוי-פערים במחיר-מלאכותי. שקוף: נר קיים רק איפה שהיה סחר.
 *
 * חוץ-מצב בכוונה (אותו-משטר של fuelSamples/priceSamples — מתועד ב-replayNote):
 * ה-DexState/שורש-המצב נשארים דטרמיניסטיים-לריפליי; הנרות הם נגזרת-תצפית.
 * ריבונות: הנרות מוצמדים ל-db/klines.json — **נעקב ב-git** (הריפו הוא בית-המצב,
 * כמו state-snapshot.json) — שורד מחיקת-סנדבוקס, חוזר ב-clone/heal.
 *
 * וקטור-כנות: tape.jsonl מוגבל (TAPE_CAP=600); הנרות מחזיקים 3-ימים של דקות
 * (4,320) פר-זוג — ההיסטוריה-החיה הארוכה ביותר שהמנוע מציג כיום.
 */
import fs from "node:fs";
import path from "node:path";

export interface Candle {
  t: number;   // תחילת-הדקה (ms epoch, UTC) — שלמים
  o: number;   // open — µ-quote ל-1 יחידת-בסיס (שלמים)
  h: number;   // high
  l: number;   // low
  c: number;   // close
  vMu: number; // נפח בסיס (µ)
  qMu: number; // נפח ציטוט (µ)
  n: number;   // מספר-עסקאות
}

export interface TradeRec {
  base: string; quote: string;
  price: number;        // µ-quote ל-1 יחידת-בסיס
  amountMu: number;     // µ בסיס
  taker: string; maker: string;
  kind: string;         // fill | swap
  at: number;           // ms epoch
  h: number;            // גובה-הבלוק
}

const MIN_MS = 60_000;
const MAX_CANDLES = 4_320; // 3 ימים × 1,440 דקות
const MAX_TRADES = 2_000;  // טבעת-עסקאות פר-זוג

const KLINES_FILE = path.join(process.cwd(), "db", "klines.json");

/** מצב-המודול (חוץ-מצב קנוני — מקביל ל-tape של-chain.ts) */
interface KlineRT {
  candles: Map<string, Candle[]>;   // pair → נרות-דקה עולים
  trades: Map<string, TradeRec[]>;  // pair → עסקאות חדשות-בראש
  dirty: boolean;
}
const g = globalThis as unknown as { __saosDexKlines?: KlineRT };

function rt(): KlineRT {
  if (!g.__saosDexKlines) g.__saosDexKlines = { candles: new Map(), trades: new Map(), dirty: false };
  return g.__saosDexKlines;
}

/** מפתח-זוג קנוני (אלפביתי — כמו poolKey בלי-תלות-מעגלית) */
export function kpair(a: string, b: string): string {
  return a < b ? `${a}/${b}` : `${b}/${a}`;
}

/** המרת אירוע-מסחר למחיר-מנורמל (µ-quote ל-1 יחידת-בסיס של הזוג) + נפח-בסיס.
 * אירוע בכיוון-הפוך (base=הציטוט שלנו) → היפוך 1e6/price (דיוק-מיקרו, עיגול-floor).
 * מחזיר null אם-האירוע לא שייך-לזוג / פסול (אפס-המצאה). */
function normalize(ev: { base: string; quote: string; price: number; amountMu: number; kind?: string }, base: string, quote: string): { px: number; baseMu: number } | null {
  if (!(ev.price > 0) || !(ev.amountMu > 0)) return null;
  if (ev.base === base && ev.quote === quote) return { px: Math.floor(ev.price), baseMu: ev.amountMu };
  if (ev.base === quote && ev.quote === base) {
    const px = Math.floor(1_000_000 / ev.price); // µ-base ל-1 יחידת-quote → הופך ל-µ-quote ל-1 base
    if (!(px > 0)) return null;
    return { px, baseMu: Math.floor((ev.amountMu * ev.price) / 1_000) }; // amount היה µ-ציטוט → µ-בסיס
  }
  return null;
}

/** הזנה: אירועי-מסחר אמת (fill/swap) מ-buildBlock — קריאה-אחת-לבלוק.
 * חייב-להיקרא עם הגובה-שלפני-ה++ (אותו-h שה-tape מסמן). */
export function klinesFeed(
  events: Array<{ base: string; quote: string; price: number; amountMu: number; taker?: string; maker?: string; kind?: string; quoteMu?: number }> | undefined,
  h: number,
  nowMs: number,
): void {
  if (!events || events.length === 0) return;
  const R = rt();
  for (const ev of events) {
    const pair = kpair(ev.base, ev.quote);
    const base = ev.base < ev.quote ? ev.base : ev.quote;
    const quote = ev.base < ev.quote ? ev.quote : ev.base;
    const norm = normalize(ev, base, quote);
    if (!norm) continue;
    const t = Math.floor(nowMs / MIN_MS) * MIN_MS;

    let arr = R.candles.get(pair);
    if (!arr) { arr = []; R.candles.set(pair, arr); }
    const last = arr[arr.length - 1];
    if (last && last.t === t) {
      last.h = Math.max(last.h, norm.px); last.l = Math.min(last.l, norm.px); last.c = norm.px;
      last.vMu += norm.baseMu; last.qMu += Math.floor((norm.px * norm.baseMu) / 1_000); last.n += 1;
    } else {
      arr.push({ t, o: norm.px, h: norm.px, l: norm.px, c: norm.px, vMu: norm.baseMu, qMu: Math.floor((norm.px * norm.baseMu) / 1_000), n: 1 });
      if (arr.length > MAX_CANDLES) arr.splice(0, arr.length - MAX_CANDLES);
    }

    let tr = R.trades.get(pair);
    if (!tr) { tr = []; R.trades.set(pair, tr); }
    tr.unshift({
      base, quote, price: norm.px, amountMu: norm.baseMu,
      taker: ev.taker ?? "pool", maker: ev.maker ?? "pool",
      kind: ev.kind ?? "fill", at: nowMs, h,
    });
    if (tr.length > MAX_TRADES) tr.length = MAX_TRADES;
    R.dirty = true;
  }
}

/** צבירה: 1m → interval. מחזיר נרות עולים. */
export function klinesFor(pair: string, interval: "1m" | "5m" | "15m" | "1h" | "4h" | "1d", limit = 500, beforeMs?: number): Candle[] {
  const iv = interval === "1m" ? MIN_MS : interval === "5m" ? 5 * MIN_MS : interval === "15m" ? 15 * MIN_MS
    : interval === "1h" ? 60 * MIN_MS : interval === "4h" ? 240 * MIN_MS : 1440 * MIN_MS;
  const arr = rt().candles.get(pair) ?? [];
  const capped = Math.min(Math.max(1, Math.floor(limit)), 1000);
  const out: Candle[] = [];
  const maxT = beforeMs && beforeMs > 0 ? beforeMs : Number.MAX_SAFE_INTEGER;
  // הליכה-אחורה מהסוף (הנרות עולים) — צבירה-יעילה O(n)
  let cur: Candle | null = null;
  for (let i = arr.length - 1; i >= 0; i--) {
    const c = arr[i];
    if (c.t >= maxT) continue;
    const bucket = Math.floor(c.t / iv) * iv;
    if (cur && cur.t === bucket) {
      cur.h = Math.max(cur.h, c.h); cur.l = Math.min(cur.l, c.l);
      cur.o = c.o; // ההליכה-אחורה: הקודם-בזמן הוא ה-open
      cur.vMu += c.vMu; cur.qMu += c.qMu; cur.n += c.n;
    } else {
      if (cur) { out.unshift(cur); if (out.length >= capped) break; }
      cur = { t: bucket, o: c.o, h: c.h, l: c.l, c: c.c, vMu: c.vMu, qMu: c.qMu, n: c.n };
    }
  }
  if (cur && out.length < capped) out.unshift(cur);
  return out;
}

/** עסקאות-אחרונות עם עימוד-cursor (חדשות-בראש). */
export function tradesFor(pair: string, limit = 50, beforeMs?: number): TradeRec[] {
  const capped = Math.min(Math.max(1, Math.floor(limit)), 500);
  const arr = rt().trades.get(pair) ?? [];
  const maxT = beforeMs && beforeMs > 0 ? beforeMs : Number.MAX_SAFE_INTEGER;
  const out: TradeRec[] = [];
  for (const t of arr) {
    if (t.at >= maxT) continue;
    out.push(t);
    if (out.length >= capped) break;
  }
  return out;
}

export interface Stats24 {
  last: number; chg24Bps: number;
  high24: number; low24: number;
  vol24BaseMu: number; vol24QuoteMu: number; trades24: number;
  candles1m: number; // עומק-היסטוריה אמת (כנות: כמה נרות נאספו)
}

/** סטטיסטיקת-24ש' מהנרות — נגזרת-כנה ממסחר-אמת בלבד. */
export function stats24For(pair: string, nowMs: number): Stats24 {
  const empty: Stats24 = { last: 0, chg24Bps: 0, high24: 0, low24: 0, vol24BaseMu: 0, vol24QuoteMu: 0, trades24: 0, candles1m: 0 };
  const arr = rt().candles.get(pair);
  if (!arr || arr.length === 0) return empty;
  const from = nowMs - 24 * 60 * MIN_MS;
  let high = 0, low = Number.MAX_SAFE_INTEGER, vB = 0, vQ = 0, n = 0, first = 0, last = 0;
  for (const c of arr) {
    if (c.t < from) continue;
    if (high === 0) first = c.o; // הנר-הראשון-בחלון
    high = Math.max(high, c.h); low = Math.min(low, c.l);
    vB += c.vMu; vQ += c.qMu; n += c.n; last = c.c;
  }
  if (low === Number.MAX_SAFE_INTEGER) return empty;
  const chg24Bps = first > 0 ? Math.floor(((last - first) / first) * 10_000) : 0;
  return { last, chg24Bps, high24: high, low24: low, vol24BaseMu: vB, vol24QuoteMu: vQ, trades24: n, candles1m: arr.length };
}

/* ── הישרדות-ריבונית: db/klines.json נעקב ב-git (כמו state-snapshot) ───────── */

export function klinesFlush(): void {
  const R = rt();
  if (!R.dirty) return;
  try {
    const pairs: Record<string, Candle[]> = {};
    for (const [k, v] of R.candles) pairs[k] = v;
    const payload = JSON.stringify({ version: 1, savedAt: Date.now(), pairs });
    const tmp = `${KLINES_FILE}.tmp`;
    fs.writeFileSync(tmp, payload, "utf8");
    fs.renameSync(tmp, KLINES_FILE); // אטומי — אין-קובץ-חלקי
    R.dirty = false;
  } catch (e) {
    // כנות: כשל-כתיבה לא מפיל את השרשרת — הנרות נגזרת-תצפית
    console.error("[saos-dex][klines] flush failed:", e instanceof Error ? e.message : e);
  }
}

export function klinesLoad(): { pairs: number; candles: number } {
  try {
    const raw = JSON.parse(fs.readFileSync(KLINES_FILE, "utf8")) as { version: number; pairs: Record<string, Candle[]> };
    let total = 0;
    for (const [k, arr] of Object.entries(raw.pairs ?? {})) {
      if (!Array.isArray(arr)) continue;
      const clean = arr.filter((c) => c && typeof c.t === "number" && c.o > 0 && c.h >= c.l && c.vMu >= 0);
      rt().candles.set(k, clean);
      total += clean.length;
    }
    return { pairs: rt().candles.size, candles: total };
  } catch {
    return { pairs: 0, candles: 0 }; // אין-קובץ = לידה-כנה (הנרות ייצברו מהסחר-החי)
  }
}
