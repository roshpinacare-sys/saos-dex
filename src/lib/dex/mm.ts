/**
 * mm.ts — הארנה האוטונומית (מורשת grid98.cjs "זאן-חיילים"):
 *  · כל-חייל עושה-שוק (maker) בגריד-סביב-מחיר-הוגן
 *  · טייק-מסתובב: רוטציה בין-החיילים — לוקח רק-אם-שער-השוליים עובר
 *    edge ≥ עמלה + רווח-מינ' ("רווחיות-וודאית" לפני-הוצאה)
 *  · סטיית-מלאי (inventory skew) מזיזה-ציטוטים לכיוון-האיזון
 *  · בוטי-רעש: זרימה-חופשית שמגלה-מחיר (dex-facts: "עודף-מחיר נאכל מיד")
 */
import type { DexState, Op, Asset } from "./kernel";
import { FEE_BPS, poolKey, avail, notional } from "./kernel";
import { sortBook } from "./book";
import { poolMid, getPool } from "./amm";

export const MARKETS: { base: Asset; quote: Asset }[] = [
  { base: "SAOS", quote: "USDS" },
  { base: "WSTEEM", quote: "USDS" },
];

export interface ArenaParams {
  enabled: boolean;
  spreadBps: number; // רוחב-גריד בסיסי
  stepBps: number;   // מרווח-בין-רמות
  levels: number;    // רמות לכל-צד
  sizeMu: number;    // גודל-ציטוט בסיסי (µ בסיס)
  maxInventoryMu: number;
  minEdgeBps: number; // שער-השוליים לטייק (מעל העמלה)
  requoteBps: number; // סטייה-מותרת לפני-ריקוט
  noise: boolean;     // בוטי-רעש
}

export const DEFAULT_PARAMS: ArenaParams = {
  enabled: true,
  spreadBps: 40,
  stepBps: 25,
  levels: 2,
  sizeMu: 80_000, // 80 SAOS
  maxInventoryMu: 2_400_000,
  minEdgeBps: 15,
  requoteBps: 12,
  noise: true,
};

export interface SoldierRT { nonceSeq: number; fills: number; takes: number; }

/** מחיר-הוגן: עדות-משוקללת של הספר, הבריכה וסולם-הערך */
export function fairPrice(st: DexState, base: string, quote: string): number {
  const ref = st.assets[base]?.refPrice ?? 0;
  const bids = sortBook(st, base, quote, "buy");
  const asks = sortBook(st, base, quote, "sell");
  const bestBid = bids[0]?.price ?? 0;
  const bestAsk = asks[0]?.price ?? 0;
  const bookMid = bestBid > 0 && bestAsk > 0 ? Math.floor((bestBid + bestAsk) / 2) : (bestBid || bestAsk || 0);
  const p = getPool(st, poolKey(base, quote));
  const pm = p ? poolMid(p) : 0;
  // משקלים: ספר 50% · בריכה 30% · סולם-ערך 20% (נפילה-חן למקורות-קיימים)
  const parts: [number, number][] = [];
  if (bookMid > 0) parts.push([bookMid, 0.5]);
  if (pm > 0) parts.push([pm, 0.3]);
  if (ref > 0) parts.push([ref, 0.2]);
  if (parts.length === 0) return ref;
  const wsum = parts.reduce((s, [, w]) => s + w, 0);
  return Math.floor(parts.reduce((s, [v, w]) => s + v * w, 0) / wsum);
}

function skewShiftBps(st: DexState, soldier: string, base: string): number {
  const inv = st.balances[soldier]?.[base] ?? 0;
  const target = Math.floor(DEFAULT_PARAMS.maxInventoryMu / 2);
  const dev = (inv - target) / DEFAULT_PARAMS.maxInventoryMu; // -0.5..0.5+
  const clamped = Math.max(-1, Math.min(1, dev * 2));
  return Math.floor(clamped * (DEFAULT_PARAMS.spreadBps / 2)); // מלאי-כבד → מוכר-זול יותר
}

type PushOp = (op: Op) => void;

function submit(rt: Map<string, SoldierRT>, soldier: string, op: Omit<Op, "issuer" | "nonce">, pushOp: PushOp): void {
  const r = rt.get(soldier) ?? { nonceSeq: 0, fills: 0, takes: 0 };
  r.nonceSeq++;
  rt.set(soldier, r);
  pushOp({ ...op, issuer: soldier, nonce: `a${r.nonceSeq}` } as Op);
}

/** טיק-ארנה: ריקוט-גריד לכל-חייל + טייק-מסתובב עם-שער-שוליים + בוטי-רעש */
export function arenaTick(
  st: DexState, tick: number, nowMs: number,
  params: ArenaParams,
  rt: Map<string, SoldierRT>,
  pushOp: PushOp,
): void {
  const soldiers = ["soldier-1", "soldier-2", "soldier-3", "soldier-4"];

  for (const m of MARKETS) {
    const fair = fairPrice(st, m.base, m.quote);
    if (fair <= 0) continue;

    if (params.enabled) {
      const shift = 0; // skew מחושב-פר-חייל בהמשך
      void shift;
      for (const soldier of soldiers) {
        const sk = skewShiftBps(st, soldier, m.base);
        // ריקוט: בטל ציטוטים שסטו מעל הרף
        const mine = st.orders.filter((o) => o.live && o.owner === soldier && o.base === m.base && o.quote === m.quote);
        const desired = new Map<number, { side: "buy" | "sell"; px: number }>();
        for (let lvl = 1; lvl <= params.levels; lvl++) {
          const off = params.spreadBps / 2 + (lvl - 1) * params.stepBps;
          let bidPx = Math.floor((fair * (10_000 - off - sk)) / 10_000);
          let askPx = Math.floor((fair * (10_000 + off - sk)) / 10_000);
          // משמעת-ספרד: הביד שלי תמיד מתחת-לפייר והאסק מעליו (מונע-התנגשות-עצמית)
          const minGap = Math.max(1, Math.floor((fair * 5) / 10_000)); // ≥5bps סביב-הפייר
          bidPx = Math.min(bidPx, fair - minGap);
          askPx = Math.max(askPx, fair + minGap);
          if (bidPx > 0) desired.set(bidPx, { side: "buy", px: bidPx });
          if (askPx > 0) desired.set(askPx, { side: "sell", px: askPx });
        }
        for (const o of mine) {
          const d = desired.get(o.price);
          const stillGood = d && d.side === o.side &&
            Math.abs(((fair - o.price) / fair) * 10_000) <= params.requoteBps + params.spreadBps;
          if (!stillGood) {
            if (o.live) submit(rt, soldier, { type: "cancel", orderId: o.id }, pushOp);
          } else {
            desired.delete(o.price);
          }
        }
        // הצב-חסרים — רק-אם-הערבות בכדאיות (מניעת-הצפת-ממפול מדחיות-חוזרות)
        let lvl = 1;
        for (const [, d] of desired) {
          const size = Math.floor(params.sizeMu * (1 + (lvl - 1) * 0.5));
          lvl++;
          const lockAsset = d.side === "sell" ? m.base : m.quote;
          const lockMu = d.side === "sell" ? size : notional(d.px, size);
          if (lockMu <= 0 || avail(st, soldier, lockAsset) < lockMu) continue;
          submit(rt, soldier, {
            type: "order", base: m.base, quote: m.quote, side: d.side,
            price: d.px, amount: size,
          }, pushOp);
        }
      }
    }

    // טייק-מסתובב: רק-אם-השוליים מכסים עמלה+רווח-מינ'
    if (params.enabled) {
      const taker = soldiers[tick % soldiers.length]!;
      const bids = sortBook(st, m.base, m.quote, "buy");
      const asks = sortBook(st, m.base, m.quote, "sell");
      const bestAsk = asks.find((o) => o.owner !== taker);
      const bestBid = bids.find((o) => o.owner !== taker);
      if (bestAsk) {
        const edgeBps = Math.floor(((fair - bestAsk.price) / bestAsk.price) * 10_000) - FEE_BPS;
        if (edgeBps >= params.minEdgeBps) {
          const qty = Math.min(bestAsk.amount - bestAsk.filled, 150_000);
          submit(rt, taker, { type: "fill", base: m.base, quote: m.quote, side: "buy", amount: qty, market: true }, pushOp);
        }
      }
      if (bestBid) {
        const edgeBps = Math.floor(((bestBid.price - fair) / fair) * 10_000) - FEE_BPS;
        if (edgeBps >= params.minEdgeBps) {
          const qty = Math.min(bestBid.amount - bestBid.filled, 150_000);
          submit(rt, taker, { type: "fill", base: m.base, quote: m.quote, side: "sell", amount: qty, market: true }, pushOp);
        }
      }
    }

    // בוטי-רעש: זרימה-חופשית → גילוי-מחיר אמת; לפעמים טייק-שוק (חוצה-ספרד)
    if (params.noise) {
      const bots = ["bot-a", "bot-b", "bot-c"];
      const bot = bots[tick % bots.length]!;
      const roll = (tick * 7 + m.base.length * 3) % 10;
      if (roll < 3) {
        // טייק-שוק של בוט — יוצר מילויים וגילוי-מחיר אמיתי
        const side: "buy" | "sell" = roll === 0 ? "buy" : "sell";
        submit(rt, bot, { type: "fill", base: m.base, quote: m.quote, side, amount: 25_000 + (tick % 5) * 10_000, market: true }, pushOp);
      } else if (roll < 6) {
        const px = Math.floor((fair * (10_000 + (roll === 3 ? 40 : -40))) / 10_000);
        const side: "buy" | "sell" = roll === 4 ? "sell" : "buy";
        const amt = 20_000 + (tick % 7) * 8_000;
        submit(rt, bot, { type: "order", base: m.base, quote: m.quote, side, price: px, amount: amt }, pushOp);
      } else {
        const p = getPool(st, poolKey(m.base, m.quote));
        if (p) {
          const assetIn = tick % 3 === 0 ? p.a : p.b;
          submit(rt, bot, { type: "pool_swap", pair: poolKey(p.a, p.b), assetIn, amount: 15_000 + (tick % 5) * 5_000 }, pushOp);
        }
      }
    }
  }
  void nowMs;
}
