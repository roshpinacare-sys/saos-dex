/**
 * usds-refloat.ts — G77-e · רכבת-ההצפה-מחדש של-האוצר (TREASURY REFLOAT · מנדט §3.2).
 * ═══════════════════════════════════════════════════════════════════════════════
 * הבעיה-החיה שנמדדה (db/state-snapshot.json @h1753690 · main 521de810 · 2026-10-26):
 *   G76-a בנה-את-הנתיב (pool_reseed) אבל-הבריכות-נשארו-מתות — executable=0 — כי
 *   **הצף-החופשי-של-האוצר אפס**: כל-המלאי הרלוונטי נעול בשתי-פקודות-ספר-עתיקות
 *   מ-2026-10-20 שמחירן רחוק-מהעוגן בסדרי-גודל:
 *     · #1327834 WSBD/USDS sell @ 7,164,802µ/WSBD — עוגן 473µ → prem +151,465,729bps
 *       (15,147x) — מלכודת-מחיר: כל-קונה-תמים שייכנס ישלם 15,000x-השווי. נועלת 99,230µ WSBD.
 *     · #1327836 ENERGY/USDS buy @ 54,636µ/ENERGY — עוגן 125µ → prem +4,360,880bps
 *       (437x) — פצצת-הדמדומים: כל-מוכר שייכנס אליה יגבה 437x-השווי מהאוצר. נועלת 999,948µ USDS.
 *   בדיוק-הנעילות-האלה חוסמות-את-reseed של-USDS/WSBD (המדידה: צריך +99,999µ WSBD
 *   ו-+35,363µ USDS — והצף היה 1,051µ USDS / 0µ WSBD).
 *
 * שלוש-הרכבות (הכול טהור, שלמים-בלבד, deterministic, fail-honest):
 *   1. מיחזור (recycle) — פקודת-אוצר שמחירה ±5,000bps מהעוגן אינה-ציטוט-כשר
 *      (רצפת-הפרסה-לציטוט היא 60bps; רצועת-העוגן-החוקית 1000bps) ואינה-יכולה
 *      לחצות-אלא-כאסון-לסוחר-או-לאוצר → op-`cancel`-פר-פקודה (הגרעין **תומך**
 *      ביטול — cancelOrder owner-check fail-closed; אין-צורך-ב-op-גרעין-חדש).
 *      הנעילה חוזרת-לצף, Σ(balances+reserves) נשמרת-בדיוק.
 *   2. reseed-רוחב-חלקי — כשהזרע-המלא (G76-a reseedOpFor) חסום-מלאי: זריעה
 *      דו-צדדית-על-העוגן **בגודל-הצף-האמיתי** (שומרת-יחס, Σ נשמר, אידמפוטנטית
 *      כמו-המלא). שער-אבק: מתחת-ל-USDS_RESEED_DUST_B_MU-צד-b אין-הפעלה —
 *      fail-closed-עם-הגירעון-המדויק (אבק-בריכה הוא-טחינת-עמלות-על-עומק-פיקטיבי).
 *   3. pool_add-רוחב-חלקי — העמקת-מסדרונות-דקים בגודל-הצף (שומרת-יחס — מחיר-
 *      הבריכה לא-זז), אותו-שער-אבק-צד-a.
 *
 * `usdsSidesOnce` — חוות-הדעת של --once: מריץ-את-הרצף-המלא (מיחזור→reseed→fund→
 * repeg) **על עותק-אמת של-המצב-החי דרך-הגרעין-האמיתי** (אפס-מוק) ומוציא לכל-בריכה
 * פסק-דין כנה: EXECUTED או BLOCKED-עם-הגירעון-המדויק. דלק: אם-op-נדחה-גז
 * (insufficient-credits) מוסיפים-על-העותק **בדיוק-את-גז-הגרעין** (GAS_TABLE —
 * לא-יתרה-מומצאת) ומגלים-את-זה ב-receipt (fuelTopMu) — בפעימה-החיה הדלק הזה
 * מגיע מנתיב-ה-refuel של-wash שהפעימה מריצה-בכל-בוק (חוק-קיים, לא-הנחה).
 */
import type { DexState, Op } from "./kernel";
import { applyOp, GAS_TABLE, avail } from "./kernel";
import {
  USDS_PAIRS,
  poolHealth,
  reseedOpFor,
  fundOpFor,
  usdsActivationPlan,
  type UsdsPoolAction,
} from "./usds-activation";

/** שער-האבק של-reseed-חלקי: מתחת-ל-10,000µ-צד-b (10-יחידות) אין-הפעלה —
 * בריכה-כזו "חיה" רק-על-הנייר (סיבוב-אחד של יחידה-אחת שואב-את-כל-העומק). */
export const USDS_RESEED_DUST_B_MU = 10_000;
/** שער-האבק של-pool_add-חלקי — אותו-עיקרון על צד-a. */
export const USDS_FUND_DUST_A_MU = 10_000;
/** חוק-המיחזור: פקודת-אוצר שמחירה ±5,000bps (±50%) מהעוגן אינה-ציטוט-כשר
 * (רצפת-הפרסה 60bps · רצועת-העוגן 1000bps) — מתה-מבנית או מסוכנת; מיחזור. */
export const USDS_RECYCLE_OFFBOOK_BPS = 5_000;

/** מחיר-העוגן של-שוק base/quote ב-µ-ציטוט ליחידת-בסיס — אותו-קנון של-poolHealth
 * (anchorMidMu): floor(refB×1000/refA) כשהציטוט הוא µ-a ליחידת-b. אפס = אין-עוגן. */
export function anchorBookPxMu(st: DexState, base: string, quote: string): number {
  const refBase = st.assets[base]?.refPrice ?? 0;
  const refQuote = st.assets[quote]?.refPrice ?? 0;
  if (!(refBase > 0) || !(refQuote > 0)) return 0;
  return Math.floor((refBase * 1000) / refQuote);
}

export interface TreasuryFloatRow {
  asset: string;
  balanceMu: number;
  lockedMu: number;
  freeMu: number;
}

/** מדידת-הצף-האוצר: יתרה/נעול/חופשי לכל-נכס של-האוצר (קריאה-בלבד, סדר-ממוין). */
export function treasuryFloatOf(st: DexState): TreasuryFloatRow[] {
  const wallet = st.balances["treasury"] ?? {};
  const locks = st.locked["treasury"] ?? {};
  const assets = new Set([...Object.keys(wallet), ...Object.keys(locks)]);
  const out: TreasuryFloatRow[] = [];
  for (const a of Array.from(assets).sort()) {
    if (a.startsWith("LP|")) continue; // LP-אוצר נעול-לצמיתות מהג'נזיס — לא-צף
    const bal = wallet[a] ?? 0;
    const locked = locks[a] ?? 0;
    out.push({ asset: a, balanceMu: bal, lockedMu: locked, freeMu: bal - locked });
  }
  return out;
}

export interface ParkedOrderRow {
  orderId: number;
  market: string;
  side: "buy" | "sell";
  priceMu: number;
  anchorMu: number;
  premBps: number;
  lockAsset: string;
  lockMu: number;
  amountMu: number;
  filledMu: number;
  /** החוק: |premBps| ≥ USDS_RECYCLE_OFFBOOK_BPS = מתה-מבנית/מסוכנת → מיחזור. */
  recyclable: boolean;
}

/** פקודות-האוצר-החיות על הספר — המדידה שהפעימה מפרסמת-כל-ריצה (קריאה-בלבד). */
export function parkedTreasuryOrders(st: DexState): ParkedOrderRow[] {
  const out: ParkedOrderRow[] = [];
  for (const o of st.orders) {
    if (!o.live || o.owner !== "treasury") continue;
    const anchor = anchorBookPxMu(st, o.base, o.quote);
    const premBps = anchor > 0 ? Math.floor(((o.price - anchor) * 10_000) / anchor) : Number.MAX_SAFE_INTEGER;
    out.push({
      orderId: o.id,
      market: `${o.base}/${o.quote}`,
      side: o.side,
      priceMu: o.price,
      anchorMu: anchor,
      premBps,
      lockAsset: o.side === "sell" ? o.base : o.quote,
      lockMu: typeof o.lockMu === "number" && o.lockMu >= 0 ? o.lockMu : 0,
      amountMu: o.amount,
      filledMu: o.filled,
      recyclable: Math.abs(premBps) >= USDS_RECYCLE_OFFBOOK_BPS,
    });
  }
  return out.sort((a, b) => a.orderId - b.orderId); // דטרמיניזם-מפורש
}

export interface RecycleOp {
  op: Op;
  orderId: number;
  freedAsset: string;
  freedMu: number;
}

export interface RecyclePlan {
  rows: ParkedOrderRow[];
  ops: RecycleOp[];
  freedMuByAsset: Record<string, number>;
}

/** רכבת-המיחזור: op-`cancel`-אוצר-אחד לכל-פקודת-סכנה (סדר-id — דטרמיניסטי).
 * הנונס-דטרמיניסטי-מצב (orderId+height) — ריפליי-בטוח; הפעימה-החיה מחליפה-אותו
 * בנונס-חי (nextNonce) בעת-השליחה. */
export function recycleOpsFor(st: DexState): RecyclePlan {
  const rows = parkedTreasuryOrders(st);
  const ops: RecycleOp[] = [];
  const freedMuByAsset: Record<string, number> = {};
  for (const r of rows) {
    if (!r.recyclable) continue;
    ops.push({
      op: {
        type: "cancel",
        issuer: "treasury",
        nonce: `recycle:${r.orderId}:${st.height}`,
        orderId: r.orderId,
      } as Op,
      orderId: r.orderId,
      freedAsset: r.lockAsset,
      freedMu: r.lockMu,
    });
    freedMuByAsset[r.lockAsset] = (freedMuByAsset[r.lockAsset] ?? 0) + r.lockMu;
  }
  return { rows, ops, freedMuByAsset };
}

/** זריעה-על-העוגן בדיוק לכל-seedB (הנגזרת הקנונית — אותו-חוזה של-הגרעין). */
const seedAOf = (refB: number, refA: number, seedB: number): number =>
  refA > 0 ? Math.floor((refB * seedB) / refA) : 0;

export interface PartialReseedResult {
  op: Op | null;
  executable: boolean;
  blocked: string[];
  seedA: number;
  seedB: number;
  /** רוחב-ההפעלה מול-יעד-התצורה (µ% שלמים) — גילוי-כנה של-השבר. */
  widthPct: number;
  /** חסמי-הזרע-המלא (G76-a) — הגירעון-עד-היעד-המלא, מפורסם-לצד-החלקי. */
  fullBlocked: string[];
}

/** reseed-רוחב-חלקי: הזרע-המלא קודם (G76-a); אם-חסום-מלאי — זריעה-שומרת-יחס
 * בגודל-הצף, תחת-שער-האבק. fail-closed-כנה עם-הגירעון-המדויק לרוחב-המינימום. */
export function partialReseedOpFor(st: DexState, pair: string, nonce?: string): PartialReseedResult {
  const cfg = USDS_PAIRS.find((c) => c.pair === pair);
  const p = st.pools[pair];
  const [aS, bS] = pair.split("/");
  if (!cfg || !p) return { op: null, executable: false, blocked: ["pool-not-found"], seedA: 0, seedB: 0, widthPct: 0, fullBlocked: [] };
  const full = reseedOpFor(st, pair);
  if (full.executable) {
    return {
      op: { ...full.op!, nonce: nonce ?? full.op!.nonce },
      executable: true, blocked: [], seedA: full.seedA, seedB: full.seedB,
      widthPct: Math.floor((full.seedB * 100) / cfg.reseedTargetBMu), fullBlocked: [],
    };
  }
  const refA = st.assets[aS]?.refPrice ?? 0;
  const refB = st.assets[bS]?.refPrice ?? 0;
  if (!(refA > 0) || !(refB > 0)) {
    return { op: null, executable: false, blocked: ["no-anchor"], seedA: 0, seedB: 0, widthPct: 0, fullBlocked: full.blocked };
  }
  // המלאי-האפשרי — כולל-הרזרבות-הישנות שחוזרות-לאוצר ב-reseed (החשבון-הקנוני של-הגרעין):
  const affordA = avail(st, "treasury", aS) + p.ra;
  const affordB = avail(st, "treasury", bS) + p.rb;
  // seedA(seedB) ≤ affordA ⇔ seedB ≤ floor(((affordA+1)×refA − 1)/refB) — חד-פעמי-מדויק (שלמים):
  const capByA = Math.floor(((affordA + 1) * refA - 1) / refB);
  const candB = Math.max(0, Math.min(cfg.reseedTargetBMu, affordB, capByA));
  const candA = seedAOf(refB, refA, candB);
  const blocked: string[] = [];
  // מגן-אפס (defensive): הנגזרת-המדויקת חייבת-להתקבל-בגרעין (off-anchor-seed לעולם לא):
  if (candB > 0 && seedAOf(refB, refA, candB) > affordA) blocked.push("sizing-overflow(fail-closed)");
  if (candB < USDS_RESEED_DUST_B_MU || candA <= 0) {
    // הגירעון-המדויק עד-רוחב-המינימום-החוקי (על-שני-הצדדים, כולל-הרזרבות-שחוזרות):
    const needA = seedAOf(refB, refA, USDS_RESEED_DUST_B_MU);
    const defB = Math.max(0, USDS_RESEED_DUST_B_MU - affordB);
    const defA = Math.max(0, needA - affordA);
    if (defB > 0) blocked.push(`insufficient-treasury: need B+${defB}µ ${bS} free (have ${affordB}µ incl. reserves) to reach minimal activation width`);
    if (defA > 0) blocked.push(`insufficient-treasury: need A+${defA}µ ${aS} free (have ${affordA}µ incl. reserves) for the anchor-exact seed`);
    if (candA <= 0 && defA === 0) blocked.push("seed-dust(no-anchor-ratio)");
    return { op: null, executable: false, blocked, seedA: candA, seedB: candB, widthPct: Math.floor((candB * 100) / cfg.reseedTargetBMu), fullBlocked: full.blocked };
  }
  return {
    op: {
      type: "pool_reseed",
      issuer: "treasury",
      nonce: nonce ?? `preseed:${pair}:${st.height}:${candA}:${candB}`,
      pair,
      amount: candA,
      amountB: candB,
    } as Op,
    executable: blocked.length === 0,
    blocked,
    seedA: candA,
    seedB: candB,
    widthPct: Math.floor((candB * 100) / cfg.reseedTargetBMu),
    fullBlocked: full.blocked,
  };
}

export interface PartialFundResult {
  op: Op | null;
  executable: boolean;
  blocked: string[];
  addA: number;
  addB: number;
  widthPct: number;
  fullBlocked: string[];
}

/** pool_add-רוחב-חלקי: העמקה-שומרת-יחס (addB = floor(rb×addA/ra) — מחיר-הבריכה
 * לא-זז) בגודל-הצף-החופשי, תחת-שער-האבק. הזרע-המלא (G76-a fundOpFor) קודם. */
export function partialFundOpFor(st: DexState, pair: string, nonce?: string): PartialFundResult {
  const cfg = USDS_PAIRS.find((c) => c.pair === pair);
  const p = st.pools[pair];
  const [aS, bS] = pair.split("/");
  if (!cfg || !p) return { op: null, executable: false, blocked: ["pool-not-found"], addA: 0, addB: 0, widthPct: 0, fullBlocked: [] };
  const full = fundOpFor(st, pair);
  if (full.executable) {
    return {
      op: { ...full.op!, nonce: nonce ?? full.op!.nonce },
      executable: true, blocked: [], addA: full.addA, addB: full.addB,
      widthPct: 100, fullBlocked: [],
    };
  }
  if (!(p.ra > 0) || !(p.rb > 0)) {
    return { op: null, executable: false, blocked: ["empty-pool"], addA: 0, addB: 0, widthPct: 0, fullBlocked: full.blocked };
  }
  const desiredA = Math.max(0, cfg.targetRaMu - p.ra);
  const freeA = avail(st, "treasury", aS);
  const freeB = avail(st, "treasury", bS);
  // addB(addA) ≤ freeB ⇔ addA ≤ floor(((freeB+1)×ra − 1)/rb) — חד-פעמי-מדויק (שלמים):
  const capByB = Math.floor(((freeB + 1) * p.ra - 1) / p.rb);
  const candA = Math.max(0, Math.min(desiredA, freeA, capByB));
  const candB = candA > 0 ? Math.floor((p.rb * candA) / p.ra) : 0;
  const blocked: string[] = [];
  if (candA > 0 && candB > freeB) blocked.push("sizing-overflow(fail-closed)");
  if (candA < USDS_FUND_DUST_A_MU || candB <= 0) {
    // הגירעון-המדויק עד-רוחב-המינימום-החוקי:
    const needB = Math.floor((p.rb * USDS_FUND_DUST_A_MU) / p.ra);
    const defA = Math.max(0, USDS_FUND_DUST_A_MU - freeA);
    const defB = Math.max(0, needB - freeB);
    if (defA > 0) blocked.push(`insufficient-treasury: need A+${defA}µ ${aS} free (have ${freeA}µ) to reach minimal lawful width`);
    if (defB > 0) blocked.push(`insufficient-treasury: need B+${defB}µ ${bS} free (have ${freeB}µ) to reach minimal lawful width A=${USDS_FUND_DUST_A_MU}µ`);
    if (candB <= 0 && defB === 0) blocked.push("dust-add");
    return { op: null, executable: false, blocked, addA: candA, addB: candB, widthPct: desiredA > 0 ? Math.floor((candA * 100) / desiredA) : 0, fullBlocked: full.blocked };
  }
  return {
    op: {
      type: "pool_add",
      issuer: "treasury",
      nonce: nonce ?? `pfund:${pair}:${st.height}:${candA}`,
      pair,
      amount: candA,
    } as Op,
    executable: blocked.length === 0,
    blocked,
    addA: candA,
    addB: candB,
    widthPct: desiredA > 0 ? Math.floor((candA * 100) / desiredA) : 100,
    fullBlocked: full.blocked,
  };
}

export type UsdsSidesOpKind =
  | "recycle-cancel"
  | "pool-reseed-full"
  | "pool-reseed-partial"
  | "pool-fund-full"
  | "pool-fund-partial"
  | "pool-repeg";

export interface UsdsSidesOpRow {
  kind: UsdsSidesOpKind;
  pair?: string;
  orderId?: number;
  verdict: "EXECUTED" | "BLOCKED";
  /** חסמי-המתכנן (fail-honest — הגירעונות-המדויקים). */
  blocked: string[];
  /** שגיאת-הגרעין-האמיתית בעת-האימות (אם-נדחה-בגרעין ולא-במתכנן). */
  err?: string;
  /** דלק-גז-שגולה: סך-ה-µ-קרדיטים-שנוספו-על-העותק **בדיוק-לפי-גז-הגרעין**
   * כדי-שהאימות-יעבור (בפעימה-החיה: מגיע-מנתיב-ה-refuel של-wash). */
  fuelTopMu: number;
  /** ה-op-הקנוני — מוכן-לתור-הפעימה (הנונס-דטרמיניסטי; הפעימה מחליפה-לנונס-חי). */
  op?: Op;
  detail?: Record<string, number | string>;
}

export interface UsdsSidesOnce {
  atH: number;
  treasuryFloat: TreasuryFloatRow[];
  parked: ParkedOrderRow[];
  pools: UsdsPoolAction[];
  ops: UsdsSidesOpRow[];
  counts: {
    executed: number;
    blocked: number;
    recycled: number;
    freedMuByAsset: Record<string, number>;
    fuelTopMuTotal: number;
  };
}

/** תוספת-דלק-מדויקת: גז-הגרעין של-סוג-ה-op (GAS_TABLE — לא-המצאה). */
const gasOf = (op: Op): number => (GAS_TABLE as Record<string, number | undefined>)[op.type] ?? 0;

const VERIFY_NOW_MS = 1_700_000_000_000; // אין-op-תלוי-זמן בתוכנית — קבוע-דטרמיניסטי

/** applyOp-שקט: האימות לא מסתיר-שגיאות (kernel זורק רק על-שחיתות-מצב — ואז-תן-לזה לזרוק). */
function applyOpQuiet(st: DexState, op: Op): { ok: boolean; err?: string } {
  const r = applyOp(st, op, VERIFY_NOW_MS);
  return r.ok ? { ok: true } : { ok: false, err: (r as { err?: string }).err };
}

/**
 * חוות-הדעת של --once — הרצף-המלא על עותק-אמת דרך-הגרעין-האמיתי:
 *   1. מיחזור (שחרור-הצף) → 2. reseed-מלא/חלקי לבריכות-מתות →
 *   3. fund-מלא/חלקי למסדרונות-דקים → 4. repeg לבריכות-חוץ-מהעוגן.
 * שלב-נמדד-מול-השלב: כל-op-נבדק-על המצב-שאחרי-קודמיו (בדיוק-התנהגות-הפעימה,
 * submitOp→stepOnce→measure). פסק-דין EXECUTED = הגרעין-האמיתי קיבל-את-ה-op
 * על-העותק; BLOCKED = מתכנן-או-גרעין דחה — עם-הסיבה-והגירעון-המדויקים.
 */
export function usdsSidesOnce(st: DexState): UsdsSidesOnce {
  const float = treasuryFloatOf(st);
  const parked = parkedTreasuryOrders(st);
  const pools = usdsActivationPlan(st).pools; // חוות-הדעת-המלאה של-G76-a — מפורסמת-לצד-האופים

  const work = JSON.parse(JSON.stringify(st)) as DexState;
  const ops: UsdsSidesOpRow[] = [];
  let fuelTotal = 0;
  const freedMuByAsset: Record<string, number> = {};
  let recycled = 0;

  /** אימות-גרעין-אמת על-העותק — עם-גילוי-דלק-מדויק (GAS_TABLE) במקרה-מחסור. */
  const verify = (op: Op): { verdict: "EXECUTED" | "BLOCKED"; err?: string; fuelTopMu: number } => {
    const first = applyOpQuiet(work, op);
    if (first.ok) return { verdict: "EXECUTED", fuelTopMu: 0 };
    if (first.err !== "insufficient-credits") return { verdict: "BLOCKED", err: first.err, fuelTopMu: 0 };
    // דלק-מגולה: בדיוק-גז-הגרעין (GAS_TABLE) — הפעימה-החיה מזרימה-אותו מ-wash
    // (נתיב-refuel-קיים-כחוק) לפני-השלבים; האימות משקף-זאת בגילוי-מלא:
    const g = gasOf(op);
    work.credits["treasury"] = (work.credits["treasury"] ?? 0) + g;
    const second = applyOpQuiet(work, op);
    if (second.ok) return { verdict: "EXECUTED", fuelTopMu: g };
    return { verdict: "BLOCKED", err: second.err, fuelTopMu: g };
  };

  // 1) מיחזור — שחרור-הצף-החי:
  const rec = recycleOpsFor(st);
  for (const r of rec.ops) {
    const v = verify(r.op);
    if (v.verdict === "EXECUTED") {
      freedMuByAsset[r.freedAsset] = (freedMuByAsset[r.freedAsset] ?? 0) + r.freedMu;
      recycled++;
    }
    fuelTotal += v.fuelTopMu;
    ops.push({
      kind: "recycle-cancel", orderId: r.orderId, verdict: v.verdict,
      blocked: [], err: v.err, fuelTopMu: v.fuelTopMu, op: r.op,
      detail: { freedAsset: r.freedAsset, freedMu: r.freedMu },
    });
  }

  // 2+3+4) הבריכות — מדוד-מול-המצב-שאחרי-המיחזור (כמו-הפעימה-האמיתית):
  for (const cfg of USDS_PAIRS) {
    const h = poolHealth(work, cfg.pair);
    if (h.verdict === "dead") {
      // הזרע-המלא קודם (G76-a); חסום-מלאי → הרוחב-החלקי (G77-e):
      const pr = partialReseedOpFor(work, cfg.pair);
      const kind: UsdsSidesOpKind = pr.widthPct >= 100 ? "pool-reseed-full" : "pool-reseed-partial";
      if (pr.executable && pr.op) {
        const v = verify(pr.op);
        fuelTotal += v.fuelTopMu;
        ops.push({
          kind, pair: cfg.pair, verdict: v.verdict, blocked: [], err: v.err,
          fuelTopMu: v.fuelTopMu, op: pr.op,
          detail: { seedA: pr.seedA, seedB: pr.seedB, widthPct: pr.widthPct },
        });
      } else {
        ops.push({
          kind, pair: cfg.pair, verdict: "BLOCKED", blocked: pr.blocked,
          fuelTopMu: 0, detail: {
            seedA: pr.seedA, seedB: pr.seedB, widthPct: pr.widthPct,
            fullBlocked: pr.fullBlocked.join(" | "),
          },
        });
      }
      continue;
    }
    if (h.verdict === "thin") {
      if (cfg.managedBy === "forge") {
        ops.push({
          kind: "pool-fund-partial", pair: cfg.pair, verdict: "BLOCKED",
          blocked: ["deepening-owned-by-forge-phase (חוק-T25)"], fuelTopMu: 0,
        });
        continue;
      }
      const pf = partialFundOpFor(work, cfg.pair);
      const kind: UsdsSidesOpKind = pf.widthPct >= 100 ? "pool-fund-full" : "pool-fund-partial";
      if (pf.executable && pf.op) {
        const v = verify(pf.op);
        fuelTotal += v.fuelTopMu;
        ops.push({
          kind, pair: cfg.pair, verdict: v.verdict, blocked: [], err: v.err,
          fuelTopMu: v.fuelTopMu, op: pf.op,
          detail: { addA: pf.addA, addB: pf.addB, widthPct: pf.widthPct },
        });
      } else {
        ops.push({
          kind, pair: cfg.pair, verdict: "BLOCKED", blocked: pf.blocked,
          fuelTopMu: 0, detail: {
            addA: pf.addA, addB: pf.addB, widthPct: pf.widthPct,
            fullBlocked: pf.fullBlocked.join(" | "),
          },
        });
      }
      continue;
    }
    if (h.verdict === "off-anchor") {
      // repeg — אותו-שער של-R26-ALL בפעימה: הגרעין יקבל רק-במלאי-אוצר-מספיק:
      const [aS] = cfg.pair.split("/");
      const p = work.pools[cfg.pair];
      const raNew = Math.floor(((work.assets[p.b]?.refPrice ?? 0) * p.rb) / (work.assets[p.a]?.refPrice || 1));
      const need = Math.max(0, raNew - p.ra);
      const freeA = avail(work, "treasury", aS);
      const blocked: string[] = [];
      if (!(work.assets[p.a]?.refPrice > 0) || !(work.assets[p.b]?.refPrice > 0)) blocked.push("no-anchor");
      else if (freeA < need) {
        blocked.push(`insufficient-treasury: need A+${need - freeA}µ ${aS} free (have ${freeA}µ) for anchor repeg`);
      }
      const op: Op = { type: "pool_repeg", issuer: "treasury", nonce: `rpeg:${cfg.pair}:${work.height}`, pair: cfg.pair } as Op;
      if (blocked.length === 0) {
        const v = verify(op);
        fuelTotal += v.fuelTopMu;
        ops.push({
          kind: "pool-repeg", pair: cfg.pair, verdict: v.verdict, blocked: [],
          err: v.err, fuelTopMu: v.fuelTopMu, op,
          detail: { raNew, need, premBps: h.premBps },
        });
      } else {
        ops.push({
          kind: "pool-repeg", pair: cfg.pair, verdict: "BLOCKED", blocked,
          fuelTopMu: 0, detail: { raNew, need, premBps: h.premBps },
        });
      }
      continue;
    }
    // healthy / missing — אין-פעולה (הזוג-הריבוני מנוהל-ע"י-forgePhase):
  }

  return {
    atH: st.height,
    treasuryFloat: float,
    parked,
    pools,
    ops,
    counts: {
      executed: ops.filter((o) => o.verdict === "EXECUTED").length,
      blocked: ops.filter((o) => o.verdict === "BLOCKED").length,
      recycled,
      freedMuByAsset,
      fuelTopMuTotal: fuelTotal,
    },
  };
}
