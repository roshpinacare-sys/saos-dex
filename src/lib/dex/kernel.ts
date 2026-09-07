/**
 * kernel.ts — הגרעין הדטרמיניסטי של SAOS-DEX (מורשת ישירה:
 *   · CHAIN_SPEC.md — יחידות-מיקרו, טבלת-GAS, עימות-עסקאות
 *   · kernel.cjs (steem-main) — applyTx {ok,gas,err}, אפס-float, dedupe קשיח
 *   · saos-dex.ts — ספר-הזמנות עם נעילת-ערבות (escrow) ומחיר-מייקר
 *   · grid98.cjs — DEX-98 בריכות-גנריות, order_gc, שער-שוליים
 *
 * כללי-ברזל: 1 SAOS = 1000µ · מחיר = µ-ציטוט ל-1-יחידת-בסיס · אין float במצב ·
 * עסקה לא-חוקית לא נוגעת במצב · stateRoot = sha256(canonicalJSON(state)).
 */
import { canon, sha256, stateRootOf } from "./canonical";
import { cancelOrder, matchBook, gcOrders, type BookOrder } from "./book";
import { poolAdd, poolSwap, poolRm } from "./amm";

// ─── טבלת-GAS (מפרט-הברזל + הרחבות 96–113 של kernel.cjs) ────────────────────
export const GAS_TABLE = {
  transfer: 100,
  pay: 120,
  order: 150,
  cancel: 60,
  fill: 200,
  order_gc: 30,
  pool_add: 180,
  pool_swap: 220,
  pool_rmw: 120,
  pool_xAdd: 180,
  pool_x: 220,
  pool_xRm: 120,
  wrap_mint: 250,
  wrap_burn: 250,
  asset_list: 70,
  asset_price: 40,
  harvest: 20,
  attest: 50,
  heartbeat: 10,
  relay: 0, // THE-DOOR: חוזה-חינם שכופה עבודה-אמת על רשת-מרוחקת
  relay_ack: 0,
} as const;

export type OpKind = keyof typeof GAS_TABLE;
export const FEE_BPS = 30; // עמלי-30bps כמו-הבריכה-הילידית (dex-facts)
export const TREASURY_CUT_PCT = 30; // 30% מהעמלה → אוצר (רווח-מונוטוני, grid98)

export type Asset = "SAOS" | "USDS" | "WSTEEM" | "ENERGY" | "WSBD" | "PHIVE" | "STEEM";

export interface Pool {
  a: Asset; b: Asset; // ממוינים אלפבתית — מפתח-קנוני
  ra: number; rb: number; // רזרבות µ
  lp: number; // היצע µlp
  feeAccruedTreasury: number; // מדידה
  swaps: number;
}

export interface JournalEntry {
  h: number; t: number; soldier: string; action: string;
  edgeBps?: number; profitMu?: number; note?: string;
}

export interface DexState {
  height: number;
  balances: Record<string, Record<string, number>>; // חשבון → נכס (כולל LP|…) → µ
  locked: Record<string, Record<string, number>>; // ערבות-ספר
  credits: Record<string, number>;
  nonces: string[]; // dedupe קשיח
  orders: BookOrder[];
  pools: Record<string, Pool>;
  assets: Record<string, { refPrice: number; listed: number }>;
  backing: Record<string, number>; // גיבוי נעול 1:1 לנכסים-עטופים
  treasuryProfit: number; // רווח-אוצר מצטבר-מונוטוני (µ)
  feeMeter: number; // עמלות-שנצברו-שטרם-נקצרו (מדידה-כנה)
  ladder: { refPrice: number; stepCostMu: number; lifts: number; lastLiftHeight: number; spentMu: number };
  journal: JournalEntry[];
  gasUsed: number;
  nextSeq: number;
  stats: { fills: number; swaps: number; opsTotal: number; ladders: number };
}

// ─── עזרי-מצב (שלמים-בלבד) ──────────────────────────────────────────────────
export const bal = (st: DexState, who: string, a: string): number => st.balances[who]?.[a] ?? 0;
export const lockedOf = (st: DexState, who: string, a: string): number => st.locked[who]?.[a] ?? 0;
export const avail = (st: DexState, who: string, a: string): number =>
  bal(st, who, a) - lockedOf(st, who, a);

export function addBal(st: DexState, who: string, a: string, d: number): void {
  if (!Number.isSafeInteger(d)) throw new Error("non-integer balance delta");
  const b = (st.balances[who] = st.balances[who] ?? {});
  b[a] = (b[a] ?? 0) + d;
}
export function addLock(st: DexState, who: string, a: string, d: number): void {
  const l = (st.locked[who] = st.locked[who] ?? {});
  l[a] = (l[a] ?? 0) + d;
}
export function chargeGas(st: DexState, who: string, gas: number): boolean {
  if ((st.credits[who] ?? 0) < gas) return false;
  st.credits[who] = (st.credits[who] ?? 0) - gas;
  st.gasUsed += gas;
  return true;
}
/** dedupe-קשיח עם חלון-נע (מונע צמיחת-זיכרון בריצה ארוכה — מורשת WINDOW_FLUSH) */
const NONCE_WINDOW = 6000;
function pushNonce(st: DexState, key: string): void {
  st.nonces.push(key);
  if (st.nonces.length > NONCE_WINDOW) st.nonces.splice(0, 1000);
}
export const poolKey = (x: string, y: string): string => [x, y].sort().join("/");
export const notional = (price: number, amountMu: number): number =>
  Math.floor((price * amountMu) / 1000); // price=µ-ציטוט/יחידה · amount=µ-בסיס

// ─── ג'נזיס ─────────────────────────────────────────────────────────────────
export const GENESIS_ACCOUNTS = [
  "treasury", "operator", "arena", "soldier-1", "soldier-2", "soldier-3", "soldier-4",
  "bot-a", "bot-b", "bot-c",
] as const;

export function genesisState(): DexState {
  const st: DexState = {
    height: 0,
    balances: {}, locked: {}, credits: {}, nonces: [],
    orders: [], pools: {}, assets: {}, backing: {},
    treasuryProfit: 0,
    feeMeter: 0,
    ladder: { refPrice: 2500, stepCostMu: 8_000, lifts: 0, lastLiftHeight: 0, spentMu: 0 },
    journal: [], gasUsed: 0, nextSeq: 1,
    stats: { fills: 0, swaps: 0, opsTotal: 0, ladders: 0 },
  };
  // ארנקי-ג'נזיס (סימולציה ריבונית — כסף-ספר בלבד, כנות מלאה)
  const seed: Record<string, Record<string, number>> = {
    treasury:   { SAOS: 6_000_000, USDS: 8_000_000, STEEM: 1_000_000, WSTEEM: 316_000, ENERGY: 40_000, WSBD: 50_000, PHIVE: 100_000 },
    operator:   { SAOS: 2_000_000, USDS: 5_000_000, STEEM: 1_000_000 },
    arena:      { USDS: 20_000_000, SAOS: 8_000_000 },
    "soldier-1": { SAOS: 1_200_000, USDS: 3_000_000 },
    "soldier-2": { SAOS: 1_200_000, USDS: 3_000_000 },
    "soldier-3": { SAOS: 1_200_000, USDS: 3_000_000 },
    "soldier-4": { SAOS: 1_200_000, USDS: 3_000_000 },
    "bot-a": { SAOS: 400_000, USDS: 1_000_000 },
    "bot-b": { WSTEEM: 500_000, USDS: 500_000 },
    "bot-c": { ENERGY: 100_000, SAOS: 100_000 },
  };
  for (const [who, wallet] of Object.entries(seed)) {
    st.balances[who] = { ...wallet };
    st.credits[who] = who === "operator" ? 10_000_000 : 2_000_000;
  }
  // נכסים רשומים + מחיר-ייחוס (asset_list/asset_price בג'נזיס)
  st.assets = {
    SAOS: { refPrice: 2500, listed: 0 },     // 2.50 USDS
    USDS: { refPrice: 1000, listed: 0 },
    WSTEEM: { refPrice: 320, listed: 0 },    // 0.32 USDS (feedPrice מורשת)
    ENERGY: { refPrice: 125, listed: 0 },    // 0.125 SAOS
    WSBD: { refPrice: 1000, listed: 0 },
    PHIVE: { refPrice: 40, listed: 0 },
  };
  // בריכות-זריעה (pool_add ג'נזיס): LP כולו לאוצר
  const mk = (a: Asset, b: Asset, ra: number, rb: number): Pool =>
    ({ a: [a, b].sort()[0] as Asset, b: [a, b].sort()[1] as Asset, ra: 0, rb: 0, lp: 0, feeAccruedTreasury: 0, swaps: 0 });
  const seedPool = (x: Asset, y: Asset, rx: number, ry: number) => {
    const p = mk(x, y, rx, ry);
    p.ra = p.a === x ? rx : ry; p.rb = p.a === x ? ry : rx;
    p.lp = Math.floor(Math.sqrt(p.ra * p.rb)); // x*y=k → lp=√k
    st.pools[poolKey(x, y)] = p;
    addBal(st, "treasury", p.a, 0); // ensure entry
  };
  seedPool("SAOS", "USDS", 8_000_000, 20_000_000);   // mid 2.50
  seedPool("WSTEEM", "USDS", 10_000_000, 3_200_000); // mid 0.32
  seedPool("ENERGY", "SAOS", 40_000, 5_000);         // mid 0.125 SAOS
  st.locked["treasury"] = {}; // LP נעול-לצמיתות (מורשת pool_lock) — ניהולי בלבד
  return st;
}

export const stateRoot = (st: DexState): string => stateRootOf(st);

// ─── עימות-עסקאות: applyOp — מחזיר {ok, gas, err?} (חתימת kernel.cjs) ────────
export type OpResult = { ok: true; gas: number; events?: TradeEvent[] } | { ok: false; err: string; gas: number };
export interface TradeEvent { kind: "fill" | "swap"; base: Asset; quote: Asset; price: number; amountMu: number; taker: string; maker?: string; at: number }

export interface Op {
  type: OpKind;
  issuer: string;
  nonce: string;
  // משותף
  to?: string; asset?: Asset; amount?: number;
  // ספר
  base?: Asset; quote?: Asset; side?: "buy" | "sell"; price?: number; market?: boolean;
  orderId?: number;
  // בריכות
  pair?: string; assetIn?: Asset; minOut?: number; lp?: number; kind?: "x";
  // עטיפות/רשימות/עדים/דלתות
  wrapAsset?: Asset; name?: string; refPrice?: number; claim?: string; memo?: string;
  at?: number;
}

export function applyOp(st: DexState, op: Op, nowMs: number): OpResult {
  if (!op || typeof op !== "object") return { ok: false, err: "bad-op", gas: 0 };
  const gas = GAS_TABLE[op.type];
  if (gas === undefined) return { ok: false, err: "unknown-op", gas: 0 };
  const issuer = String(op.issuer ?? "").toLowerCase();
  if (!issuer || !op.nonce) return { ok: false, err: "issuer+nonce-required", gas: 0 };
  const dedupeKey = `${issuer}:${op.nonce}`;
  if (st.nonces.includes(dedupeKey)) return { ok: false, err: "replay-rejected", gas: 0 };

  const consume = (): OpResult | null => {
    if (!chargeGas(st, issuer, gas)) return { ok: false, err: "insufficient-credits", gas };
    pushNonce(st, dedupeKey);
    st.stats.opsTotal++;
    return null;
  };

  switch (op.type) {
    case "transfer":
    case "pay": {
      const a = op.asset, amt = op.amount ?? 0;
      if (!a || !(amt > 0) || !op.to) return { ok: false, err: "bad-transfer", gas };
      if (avail(st, issuer, a) < amt) return { ok: false, err: "insufficient", gas };
      const c = consume(); if (c) return c;
      addBal(st, issuer, a, -amt);
      addBal(st, op.to, a, amt);
      if (op.type === "pay") st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "pay", note: `→${op.to} ${amt}µ ${a}` });
      return { ok: true, gas };
    }
    case "order": {
      // פקודת-לימיט מוסדית (סטנדרט-בורסות): חפיפה-מיידית כ-taker במחיר-המייקר,
      // ושארית נחה בספר. אין-חפיפה כלל → מנוחה-מלאה. נעילה-מראש על מלוא-הכמות;
      // matchBook משחרר-במדויק לכל-רגל — הנעילה נשארת מדויקת-בסוף (מורשת saos-dex).
      // FIX(escrow): בנתיב-אין-חפיפה הפקודה נחה עם-הנעילה-שלה — שחרור-הנעילה
      // לפני-המנוחה יצר פקודה בלתי-מגובה (uncollateralized) שמילויה-כמייקר
      // משחרר נעילות-פנטום (נתפס-ע"י invariant: escrow-underflow — HALT).
      const px = op.price ?? 0, amt = op.amount ?? 0;
      const lockAsset = (op.side === "sell" ? op.base : op.quote) as string;
      const lockMu = op.side === "sell" ? amt : notional(px, amt);
      if (!(px > 0) || !(amt > 0) || !(lockMu > 0)) return { ok: false, err: "bad-price-amount", gas: 0 };
      if (st.orders.filter((o) => o.live && o.owner === op.issuer).length >= 24)
        return { ok: false, err: "order-cap", gas: 0 };
      if (avail(st, op.issuer, lockAsset) < lockMu) return { ok: false, err: "insufficient-escrow", gas: 0 };
      addLock(st, op.issuer, lockAsset, lockMu);
      const lockBefore = lockedOf(st, op.issuer, lockAsset);
      const cross = matchBook(st, op, nowMs, consume);
      if (cross.ok) {
        // שחרור-אבק-רצפה: floor לא-אדיטיבי עלול להשאיר נעילה-עודפת בלי-פקודה
        // מאחוריה — מכוונים את הנעילה בדיוק לשארית (או-אפס אם-מולאה-כולה).
        const filledMu = amt - (cross.events ? cross.events.reduce((a, e) => a + e.amountMu, 0) : 0);
        const expectedLock = filledMu > 0 ? notional(px, filledMu) : 0;
        const released = lockBefore - lockedOf(st, op.issuer, lockAsset);
        const dust = lockMu - released - expectedLock;
        if (dust > 0) addLock(st, op.issuer, lockAsset, -dust);
        return cross;
      }
      if (cross.err !== "no-cross") {
        // כשל-קשה שאינו-אין-חפיפה → שחרור-שארית-הנעילה בלבד: matchBook עשוי
        // להיות שחרר-חלק בטרם-הכשל — משחררים רק-את-מה-שנותר מהנעילה שלנו
        // (שחרור-מלא-עיוור כאן היה מייצר נעילה שלילית — אותו-חור שה-invariant תפס).
        const residual = lockedOf(st, op.issuer, lockAsset) - (lockBefore - lockMu);
        if (residual > 0) addLock(st, op.issuer, lockAsset, -residual);
        return cross;
      }
      // אין-חפיפה: הפקודה נחה בספר — עם-הנעילה-המלאה שלה (מגובה-מלא, לעולם לא משוחררת כאן)
      const c2 = consume();
      if (c2) {
        // כשל-gas/דדופ אחרי-הנעילה — משחררים-הכול (fail-closed)
        addLock(st, op.issuer, lockAsset, -lockMu);
        return c2;
      }
      const seq = st.nextSeq++;
      st.orders.push({
        seq, id: seq, owner: op.issuer, base: op.base as string, quote: op.quote as string, side: op.side as "buy" | "sell",
        price: px, amount: amt, filled: 0, live: true, nonce: op.nonce, at: nowMs,
      });
      return { ok: true, gas: 0 };
    }
    case "fill": {
      // טייק-מיידי: חוצה את הספר לפי מחיר-מייקר (saos-dex) — market או limit-חוצה
      const r = matchBook(st, op, nowMs, consume);
      return r;
    }
    case "cancel": {
      const r = cancelOrder(st, op, consume);
      return r;
    }
    case "order_gc": {
      const c = consume(); if (c) return c;
      const removed = gcOrders(st);
      const evs: TradeEvent[] = removed > 0
        ? [{ kind: "fill", base: "SAOS", quote: "USDS", price: 0, amountMu: -removed, taker: "gc", at: nowMs }]
        : [];
      void evs; // gc מנקה-מצב; אין-אירועי-סליל (כנות)
      return { ok: true, gas, events: [] };
    }
    case "pool_add":
    case "pool_xAdd": {
      const r = poolAdd(st, op, nowMs, consume);
      return r;
    }
    case "pool_swap":
    case "pool_x": {
      const r = poolSwap(st, op, nowMs, consume);
      return r;
    }
    case "pool_rmw":
    case "pool_xRm": {
      const r = poolRm(st, op, consume);
      return r;
    }
    case "wrap_mint":
    case "wrap_burn": {
      const a = op.wrapAsset, amt = op.amount ?? 0;
      if (!a || !a.startsWith("W") || !(amt > 0)) return { ok: false, err: "bad-wrap", gas };
      const native = a.slice(1) as Asset;
      if (op.type === "wrap_mint") {
        // גיבוי 1:1 אמת (dex-facts): היליד ננעל → נפקה עטופה
        if (avail(st, issuer, native) < amt) return { ok: false, err: "insufficient-native", gas };
        const c = consume(); if (c) return c;
        addBal(st, issuer, native, -amt);
        st.backing[a] = (st.backing[a] ?? 0) + amt;
        addBal(st, issuer, a, amt);
        return { ok: true, gas };
      } else {
        if (avail(st, issuer, a) < amt) return { ok: false, err: "insufficient-wrapped", gas };
        if ((st.backing[a] ?? 0) < amt) return { ok: false, err: "backing-shortfall", gas };
        const c = consume(); if (c) return c;
        addBal(st, issuer, a, -amt);
        st.backing[a] = (st.backing[a] ?? 0) - amt;
        addBal(st, issuer, native, amt);
        return { ok: true, gas };
      }
    }
    case "asset_list":
    case "asset_price": {
      if (issuer !== "treasury") return { ok: false, err: "treasury-only", gas };
      const a = op.asset;
      if (!a) return { ok: false, err: "asset-required", gas };
      if (op.type === "asset_list" && st.assets[a]) return { ok: false, err: "already-listed", gas };
      const c = consume(); if (c) return c;
      st.assets[a] = { refPrice: op.refPrice ?? st.assets[a]?.refPrice ?? 0, listed: st.height };
      return { ok: true, gas };
    }
    case "harvest": {
      // THE-HARVEST (111): הכרה-על-הספר בערך-שהופק — אוצר-בלבד, מונוטוני,
      // ומוגבל-במדידה: אסור-לקצור מעבר-לעמלות-שנצברו בפועל
      if (issuer !== "treasury") return { ok: false, err: "treasury-only", gas };
      const amt = op.amount ?? 0;
      if (!(amt > 0)) return { ok: false, err: "bad-amount", gas };
      if (amt > st.feeMeter) return { ok: false, err: "harvest-exceeds-measured-fees", gas };
      const c = consume(); if (c) return c;
      st.feeMeter -= amt;
      st.treasuryProfit += amt;
      st.journal.push({ h: st.height, t: nowMs, soldier: "treasury", action: "harvest", profitMu: amt, note: op.memo });
      return { ok: true, gas };
    }
    case "attest": {
      const c = consume(); if (c) return c;
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "attest", note: (op.claim ?? "").slice(0, 24) });
      return { ok: true, gas };
    }
    case "relay": {
      if (!op.to) return { ok: false, err: "relay-requires-destination", gas: 0 };
      pushNonce(st, dedupeKey); st.stats.opsTotal++; // אפס-גז — החינם הוא היתרון
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "relay", note: `→${op.to} ${(op.memo ?? "").slice(0, 30)}` });
      return { ok: true, gas: 0 };
    }
    case "relay_ack": {
      pushNonce(st, dedupeKey); st.stats.opsTotal++;
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "relay_ack", note: (op.memo ?? "").slice(0, 30) });
      return { ok: true, gas: 0 };
    }
    case "heartbeat": {
      const c = consume(); if (c) return c;
      return { ok: true, gas };
    }
    default:
      return { ok: false, err: "unhandled-op", gas: 0 };
  }
}

export { canon, sha256, stateRootOf };
