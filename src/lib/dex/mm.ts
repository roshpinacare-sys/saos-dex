/**
 * mm.ts — הארנה האוטונומית (מורשת grid98.cjs "זאן-חיילים"):
 *  · כל-חייל עושה-שוק (maker) בגריד-סביב-מחיר-הוגן
 *  · טייק-מסתובב: רוטציה בין-החיילים — לוקח רק-אם-שער-השוליים עובר
 *    edge ≥ עמלה + רווח-מינ' ("רווחיות-וודאית" לפני-הוצאה)
 *  · סטיית-מלאי (inventory skew) מזיזה-ציטוטים לכיוון-האיזון
 *  · בוטי-רעש: זרימה-חופשית שמגלה-מחיר (dex-facts: "עודף-מחיר נאכל מיד")
 */
import type { DexState, Op, Asset } from "./kernel";
import { FEE_BPS, LADDER_FUEL_FLOOR, MINT_FUEL_CAP, REFUEL_CAP, poolKey, avail, notional } from "./kernel";
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
  spreadBps: 32,   // מהדורת-ייצוב: ספרד-צמודה (היתה 40)
  stepBps: 20,     // רמות-צפופות (היה 25)
  levels: 2,       // גריד 2-רמות — מהדורת-דלק: חצי-שריפת-ריקוט (היו 3)
  sizeMu: 80_000, // 80 SAOS
  maxInventoryMu: 2_400_000,
  minEdgeBps: 15,
  requoteBps: 24,  // סבלנות-ריקוט — פחות-צ'רנוב-גז (היה 12; מהדורת-דלק)
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

/**
 * pegkeeperTick — עמדת-הייצוב (מהדורת-סליקה): "שהכל ישב".
 *  · מנעול-בריכה: כשהבריכה סוטה מהפייר ≥50bps — הארנה מארביטרג'ת אותה חזרה
 *    (הזרימה-החופשית יוצרת-תנועה; המנעול מחזיר-אותה לספר). העמלה-שהארנה משלמת
 *    נמדדת ב-feeMeter — דווקא מזינה את סולם-הערך (ייצוב-מממן-את-הרצפה).
 *  · חגורת-סולם: כשמחיר-הספר חורג ±400bps מ-refPrice הריבוני — הארנה סוחבת
 *    את המחיר בחזרה-לחגורה (מכירה-לתוך-הבידים מעל / קנייה-מהאסקים מתחת).
 * כל-הפעולות: ממפול רגיל, מאושרות-על-הספר, מדודות-GAS, מכסה-גודל ותדר.
 */
export function pegkeeperTick(st: DexState, tick: number, pushOp: PushOp): void {
  const m = MARKETS[0]; // SAOS/USDS — הזוג-הריבוני
  const fair = fairPrice(st, m.base, m.quote);
  if (fair <= 0) return;

  // (1) מנעול-בריכה: poolMid → fair
  const p = getPool(st, poolKey(m.base, m.quote));
  if (p) {
    const pm = poolMid(p);
    const gapBps = Math.floor(((pm - fair) / fair) * 10_000);
    if (Math.abs(gapBps) >= 50 && tick % 2 === 0) {
      const assetIn = gapBps > 0 ? m.base : m.quote; // יקר-בבריכה → מזרימים-בסיס-פנימה (מוריד-mid)
      const rIn = assetIn === p.a ? p.ra : p.rb;
      // גודל-לסגירת-חצי-פער (ליניאריזציה), מדורג: 10k..150k µ, ולא-יותר-מהזמין
      const halfGap = Math.floor(Math.abs(Math.floor((rIn * gapBps) / 10_000)) / 2);
      const size = Math.min(Math.max(halfGap, 10_000), 150_000, avail(st, "arena", assetIn));
      if (size >= 5_000) {
        pushOp({ type: "pool_swap", issuer: "arena", nonce: `pk-pool-${tick}`, pair: poolKey(m.base, m.quote), assetIn, amount: size });
      }
    }
  }

  // (2) חגורת-סולם: bookMid ∈ ref±400bps
  const ref = st.assets[m.base]?.refPrice ?? 0;
  if (ref > 0 && tick % 4 === 0) {
    const bb = sortBook(st, m.base, m.quote, "buy")[0]?.price ?? 0;
    const ba = sortBook(st, m.base, m.quote, "sell")[0]?.price ?? 0;
    const mid = bb > 0 && ba > 0 ? Math.floor((bb + ba) / 2) : (bb || ba);
    if (mid > 0) {
      const devBps = Math.floor(((mid - ref) / ref) * 10_000);
      if (devBps > 400) {
        // יקר-מדי-מול-הסולם → הארנה מוכרת-לתוך-הבידים (מורידה-את-המגע)
        const qty = Math.min(80_000, avail(st, "arena", m.base));
        if (qty >= 5_000) {
          pushOp({ type: "fill", issuer: "arena", nonce: `pk-band-${tick}`, base: m.base, quote: m.quote, side: "sell", amount: qty, market: true });
        }
      } else if (devBps < -400) {
        // זול-מדי → הארנה קונה-מהאסקים (מרימה-את-המגע)
        const px = ba > 0 ? ba : ref;
        const qty = Math.min(80_000, Math.floor((avail(st, "arena", m.quote) * 900) / (px * 10)));
        if (qty >= 5_000) {
          pushOp({ type: "fill", issuer: "arena", nonce: `pk-band-${tick}`, base: m.base, quote: m.quote, side: "buy", amount: qty, market: true });
        }
      }
    }
  }
}

/** טיק-ארנה: ריקוט-גריד לכל-חייל + טייק-מסתובב עם-שער-שוליים + בוטי-רעש */
export function arenaTick(
  st: DexState, tick: number, nowMs: number,
  params: ArenaParams,
  rt: Map<string, SoldierRT>,
  pushOp: PushOp,
): void {
  const soldiers = ["soldier-1", "soldier-2", "soldier-3", "soldier-4"];

  // עמדת-הייצוב (סליקה): מנעול-בריכה + חגורת-סולם — לפני-הזרימה-החופשית
  pegkeeperTick(st, tick, pushOp);

  // קצבת-חיות (THE-REFUEL): כל-16 טיקים — מי-שהקרדיטים-שלו מתחת-למסלול מקבל
  // הזרמה מהאוצר. **העברה-טהורה (אפס-הטבעה)** — Σcredits נשמר. בלי-זה הגריד
  // מת-מוות-מבני: gas יורד-מונוטונית, החיילים מפסיקים-לצטט, הספר מתרוקן,
  // הספרד-נעלמת והשוק מפסיק-לשבת. תיקון-שורש לתשישות-הכלכלה-הסימולטיבית.
  if (tick % 16 === 0) {
    // THE-FOUNTAIN: אוצר-ריק? הטבעה-עצמית מגובה-עמלות-מדודות (profit-שהוכר +
    // feeMeter-מעל-רצפת-הסולם, מדוד-תקרה) — המסחר-עצמו מחזיר-את-הדלק-ששרף.
    // קודם-ההטבעה, אחר-כך העירוי.
    const trCr = st.credits["treasury"] ?? 0;
    const fuelAvail = Math.max(0, st.treasuryProfit) + Math.max(0, Math.floor(((st.feeMeter ?? 0) - LADDER_FUEL_FLOOR) / 2));
    if (trCr < 10_000 && fuelAvail > 20_000) {
      const mint = Math.min(60_000, MINT_FUEL_CAP, fuelAvail);
      if (mint > 0) pushOp({ type: "mint_fuel", issuer: "treasury", nonce: `fountain-${tick}`, to: "treasury", amount: mint });
    }
    for (const ag of [...soldiers, "bot-a", "bot-b", "bot-c"]) {
      const c = st.credits[ag] ?? 0;
      if (c < 4_000) {
        const amt = Math.min(30_000 - c, REFUEL_CAP);
        if (amt <= 0) continue;
        // ממנה-ראשון: הארנה (רזרבה-עמוקה — "arena funds the floor"); האוצר-גיבוי
        // (הקרדיטים-שלו מגיעים-מעמלות-בלבד — THE-FOUNTAIN).
        const funder = (st.credits["arena"] ?? 0) >= amt + 10_000 ? "arena" : "treasury";
        pushOp({ type: "refuel", issuer: funder, nonce: `refuel-${tick}-${ag}`, to: ag, amount: amt });
      }
    }
  }

  // קצבת-בוטים: כל-24 טיקים ממלאים-מחדש סוחרי-רעש שנדלדלו — בלי-זה הזרימה-
  // החופשית מתה (אפס-מילויים → אפס-גילוי-מחיר). **המפעיל-הנדיב: הארנה**
  // (המייצבת-עם-המלאי-העמוק) — לא-האוצר: לאוצר יש רק-את-קיזוז-העמלות,
  // והקצבה-ממנו-רוקנה-אותו-עד-ריק (ממצא-חי 2026-09). מדידה-על-**avail** (כולל
  // נעילות-ספר) ולא-יתרה-גולמית — פקודות-מנוחות של-בוט לא-ימנעו-מימון-חדש.
  if (params.noise && tick % 24 === 0) {
    for (const bot of ["bot-a", "bot-b", "bot-c"]) {
      if (avail(st, bot, "USDS") < 100_000) {
        pushOp({ type: "transfer", issuer: "arena", nonce: `botseed-u${tick}-${bot}`, to: bot, asset: "USDS", amount: 400_000 });
      }
      if (avail(st, bot, "SAOS") < 100_000) {
        pushOp({ type: "transfer", issuer: "arena", nonce: `botseed-s${tick}-${bot}`, to: bot, asset: "SAOS", amount: 200_000 });
      }
    }
  }

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

    // בוטי-רעש: זרימה-חופשית → גילוי-מחיר אמת; לפעמים טייק-שוק (חוצה-ספרד).
    // גודל-הטייק מותאם-תקציב-אמת (affordable) — פקודות-שוק שלא-ניתן לממן נדחות
    // על-הספר ומבזבזות-GAS; בוט מכסה-את-מה-שיש-לו, כמו-סוחר-אמת.
    if (params.noise) {
      const bots = ["bot-a", "bot-b", "bot-c"];
      const bot = bots[tick % bots.length]!;
      const roll = (tick * 7 + m.base.length * 3) % 10;
      if (roll < 3) {
        // טייק-שוק של בוט — יוצר מילויים וגילוי-מחיר אמיתי
        const side: "buy" | "sell" = roll === 0 ? "buy" : "sell";
        const px = side === "buy" ? (sortBook(st, m.base, m.quote, "sell")[0]?.price ?? fair) : (sortBook(st, m.base, m.quote, "buy")[0]?.price ?? fair);
        const assetHave = side === "buy" ? m.quote : m.base;
        const affordable = px > 0 ? Math.floor((avail(st, bot, assetHave) * 9) / (px * 10)) : 0;
        const qty = Math.min(25_000 + (tick % 5) * 10_000, affordable);
        if (qty > 0) {
          submit(rt, bot, { type: "fill", base: m.base, quote: m.quote, side, amount: qty, market: true }, pushOp);
        }
      } else if (roll < 6) {
        // היגיינת-פקודות לבוטים: בוט מחזיק עד-פקודת-רעש אחת פר-זוג — ישנות מבוטלות.
        // בלי-זה הבוטים צוברים פקודות-מנוחה שנועלות-את-כל-המלאי עד order-cap והזרימה מתה.
        for (const o of st.orders) {
          if (o.live && o.owner === bot && o.base === m.base && o.quote === m.quote) {
            submit(rt, bot, { type: "cancel", orderId: o.id }, pushOp);
          }
        }
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
