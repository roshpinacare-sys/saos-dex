/**
 * mm.ts — הארנה האוטונומית (מורשת grid98.cjs "זאן-חיילים"):
 *  · כל-חייל עושה-שוק (maker) בגריד-סביב-מחיר-הוגן
 *  · טייק-מסתובב: רוטציה בין-החיילים — לוקח רק-אם-שער-השוליים עובר
 *    edge ≥ רווח-מינ'. FIX(Roast-64 · honesty): הספר **לא גובה עמלת-taker**
 *    (matchBook מסונכרן על עלות-אמת אפס) — הסרת-ה-"FEE_BPS"-פיקטיבי מהחשבון
 *    ומהשיווק; השער-מגן-מול-סיכון-מלאי, לא-מול-עמלה-שאינה-קיימת.
 *  · סטיית-מלאי (inventory skew) מזיזה-ציטוטים לכיוון-האיזון
 *  · בוטי-רעש: זרימה-חופשית שמגלה-מחיר (dex-facts: "עודף-מחיר נאכל מיד")
 * FIX(Roast-64 · phantom-lifetime-caps): מדדי-התקרה-המצטברת (rearm/botseed)
 * חיו-במודול — כל-ריסטארט הטביע מחדש מלוא-התקרה. עכשיו: ב-DexState-עצמו
 * (שורד-תמונות-מצב; רשויות-ישנות = undefined → 0-כנה).
 */
import type { DexState, Op, Asset } from "./kernel";
import { LADDER_FUEL_FLOOR, MINT_FUEL_CAP, REFUEL_CAP, FUEL_ASK_MIN, FUNDER_ORDER, funderAfford, RESERVE_FUNDERS, reserveFunderAfford, poolKey, avail, notional, maxNonceSuffix, nonceExists, isFuelDrought, DROUGHT_FLOOR, DROUGHT_ARENA_MIN, auxAvailMu } from "./kernel"; // G105: מזרקת-הבצורת — גרעין-מקור-אמת-יחיד
import { sortBook } from "./book";
import { poolMid, poolMidFor, getPool, quoteOut } from "./amm";
import { railTick, RAIL_OWNED_POOLS, RAIL_DUST_MU } from "./rail";

export const MARKETS: { base: Asset; quote: Asset }[] = [
  { base: "SAOS", quote: "USDS" },
  { base: "WSTEEM", quote: "USDS" },
  // [T24 · THE-STABLE-EXPANSION + IGNITION-R1 — איחוד-שני-סוכנים-מקבילים, 2026-10-13]:
  // זוגות-מול-היציב מהאורקל-החי (T24: sbd/hive feeds — R23) + המשולש-הריבועי של
  // IGNITION-R1 (ENERGY/SAOS+SAOS/USDS+ENERGY/USDS — מעגל-ארביטרז' ל-ProtoRev/CoW).
  // המלאי-מזריעה-כנה-ממלאי-האוצר-הטבעי (אפס-הטבעה) — דרך-שתי-מערכות-תחומות:
  // MICRO_SEED (T24) + שורות-IGNITION (למטה) — שתיהן-תקרות-חיים-במצב.
  { base: "WSBD", quote: "USDS" },
  { base: "PHIVE", quote: "USDS" },
  { base: "ENERGY", quote: "USDS" },
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
  sizeMu: 400_000, // 400 SAOS — IGNITION-R1: עומק-ציטוט ×5 (היה 80k; אותו-מלאי, ספר-עמוק, סיבוב-מהיר)
  maxInventoryMu: 12_000_000, // [T25-FORGE] ×5 — מדף-אמת לכבשן-הנזילות
  minEdgeBps: 15,
  requoteBps: 24,  // סבלנות-ריקוט — פחות-צ'רנוב-גז (היה 12; מהדורת-דלק)
  noise: true,
};

export interface SoldierRT { nonceSeq: number; fills: number; takes: number; }

/* ── [T25 · THE-WASH] מכונת-השטיפה — NEUTRALIZED (audit wave-0, 2026-10-17) ──
 * W0.3 (אישור-בעלים, גל-0 של הביקורת): מכונת-השטיפה מנוטרלת. היא סחרור
 * עצמי (בוט מול הספר של עצמו) שייצר נפח-מדומה — בדיוק-המה שהביקורת קבעה
 * "טענת-נזילות ללא-נזילות". הקוד נשמר (היסטוריה + ריפליי-אמת), אך
 * washTick יוצא-מוקדם ואפס-פעולות. הפעלה-מחדש: לא בהחלטת-קוד — רק
 * החלטת-בעלים מתועדת + מלאי-צף אמיתי + תווית "volume=synthetic" בכל
 * דשבורד שמציג אותה. השער: WASH_ENABLED — קבוע-קומפילציה, דטרמיניסטי,
 * ריפליי-בטוח (אותו-זרע ⇒ אותו-ספר משנת-הנטרול והלאה).
 */
export const WASH_ENABLED = false;

/* ── [T25 · THE-WASH] מכונת-השטיפה — המסחרור-המהיר של הצף-הדל ──────────────
 * אישור-הבעלים (trace 1a13585a…): "יש לנו כסף דל איך נוכל להשתמש בו ולהעביר
 * אותו בדקס מהר כדי לייצר נזילות" + "הרצה כבדה ושטיפה". העיקרון הפיזיקלי:
 * נפח = צף × מהירות-מחזור. את הצף מזריע כבשן-הנזילות (cloud-beat → wallet
 * "wash", מתועד); את המהירות מספק הטיק: סוואפ-בריכה בגודל-יחסי-לעומק (1.2%,
 * תקרה 2.5Mµ), שני-הכיוונים-מאוזנים (זוגיות-טיק), רוטציה בין-הבריכות
 * (כל-טיק-שלישי לפי-אינדקס-הזוג), חתוך-לכיסוי-אמת (×0.9). אפס-רנדומיות,
 * אפס-שעון — ריפליי-אמת. העמלות זורמות: 70% LP · 30% אוצר → המזרקה מזינה-דלק.
 */
const WASH_WALLET = "wash";
const WASH_FRAC_NUM = 12;
const WASH_FRAC_DEN = 1_000; // 1.2% מהרזרבה-בנכס-הכניסה
const WASH_CAP_PER_TRADE = 2_500_000;
const WASH_ROTATE = 3;
export function washTick(st: DexState, tick: number, mIdx: number, base: string, quote: string, pushOp: PushOp): void {
  if (!WASH_ENABLED) return; // W0.3 · audit wave-0: neutralized — zero ops, replay-deterministic
  const pk = poolKey(base, quote);
  const p = getPool(st, pk);
  if (!p || p.ra <= 0 || p.rb <= 0) return;
  if (RAIL_OWNED_POOLS.has(pk)) return; // מסדרון-העוגן — זרימת-השטיפה לא נוגעת (R26)
  if ((tick + mIdx) % WASH_ROTATE !== 0) return; // רוטציה — שתי-בריכות-מנוחות-לכל-בריכה-פועלת
  // FIX(T25 · wash-anchor-rule, v2): הכיוון נגזר-מסטיית-הבריכה-מעוגן-האורקל-שלה —
  // לא-מזוגיות-טיק ולא-מתיק-השטיפה (שני-הקודמים נמדדו-חי-בסימולציה והיו משאבות-
  // מבניות: זוגיות-על-תיק-חד-צדדי דחפה בריכת-יציב 32× מהעוגן; תיק-משותף-חוצה-בריכות
  // דחף-USDS-לכל-בריכה). השטיפה-היא עתה מנוע-נזילות-שומר-עוגן: בריכה-יקרה-מהעוגן
  // מקבלת-מכירה-פנימה, זולה — קנייה, על-העוגן — שטיפה-מאוזנת-שני-הכיוונים. הכל
  // ממלאי-אמת של-הצף (אין-צד-שאין-מלאי-עבורו — דילוג-כנה), אפס-רנדומיות.
  const midA = poolMidFor(p, p.a, p.b); // µ-ציטוט ל-1 יחידת a
  const refA = st.assets[p.a]?.refPrice ?? 0;
  if (!(midA > 0)) return;
  const devBps = refA > 0 ? Math.floor(((midA - refA) * 10_000) / refA) : 0;
  const pushA = devBps > 30 ? true : devBps < -30 ? false : tick % 2 === 0;
  const assetIn = (pushA ? p.a : p.b) as Asset;
  const have = avail(st, WASH_WALLET, assetIn);
  if (!(have > 0)) return;             // אין-מלאי-לצד — דילוג-כנה (אפס-משאבה-חד-צדדית)
  const reserve = pushA ? p.ra : p.rb;
  const want = Math.min(Math.floor((reserve * WASH_FRAC_NUM) / WASH_FRAC_DEN), WASH_CAP_PER_TRADE);
  const amt = Math.min(want, Math.floor((have * 9) / 10));
  if (amt > 0) {
    pushOp({ type: "pool_swap", issuer: WASH_WALLET, nonce: `wash:a${tick}:${base}`, pair: pk, assetIn, amount: amt });
  }
}

/** מחיר-הוגן: עדות-משוקללת של הספר, הבריכה וסולם-הערך */
export function fairPrice(st: DexState, base: string, quote: string): number {
  const ref = st.assets[base]?.refPrice ?? 0;
  // R26 · עוגן-יחיד לזוגות-המסילה: הפייר של זוג-בבעלות-המסילה הוא refPrice — לא
  // תערובת-ספר+בריכה. המצאו-החי (h18553): 80% מהפייר היה self-referential
  // (ספר 50% + בריכה 30%) — נקודת-שבת-עצמית שהחזיקה-את-הספר ב-305µ בעוד-העוגן
  // 54µ (STEEM-אמת). "מנוע-אחד-לעוגן" (SETTLE-16) — המסילה היא בעלת-המשמעות,
  // והעוגן שלה הוא-האורקל, תמיד. הספר מצטט-סביב-העוגן ± spread — נקודה.
  if (ref > 0 && RAIL_OWNED_POOLS.has(poolKey(base, quote))) return ref;
  const bids = sortBook(st, base, quote, "buy");
  const asks = sortBook(st, base, quote, "sell");
  const bestBid = bids[0]?.price ?? 0;
  const bestAsk = asks[0]?.price ?? 0;
  const bookMid = bestBid > 0 && bestAsk > 0 ? Math.floor((bestBid + bestAsk) / 2) : (bestBid || bestAsk || 0);
  const p = getPool(st, poolKey(base, quote));
  const pm = p ? poolMidFor(p, base, quote) : 0;
  // משקלים: ספר 50% · בריכה 30% · סולם-ערך 20% (נפילה-חן למקורות-קיימים)
  const parts: [number, number][] = [];
  if (bookMid > 0) parts.push([bookMid, 0.5]);
  if (pm > 0) parts.push([pm, 0.3]);
  if (ref > 0) parts.push([ref, 0.2]);
  if (parts.length === 0) return ref;
  const wsum = parts.reduce((s, [, w]) => s + w, 0);
  return Math.floor(parts.reduce((s, [v, w]) => s + v * w, 0) / wsum);
}

function skewShiftBps(st: DexState, soldier: string, base: string, params: ArenaParams): number {
  // FIX(SETTLE-7): קראו מ-params החיים (לא DEFAULT_PARAMS) — שינוי-פרמטרים ב-API
  // לא-השפיע על ה-skew והטלמטריה סטתה מהגריד בפועל.
  const inv = st.balances[soldier]?.[base] ?? 0;
  const target = Math.floor(params.maxInventoryMu / 2);
  const dev = (inv - target) / params.maxInventoryMu; // -0.5..0.5+
  const clamped = Math.max(-1, Math.min(1, dev * 2));
  return Math.floor(clamped * (params.spreadBps / 2)); // מלאי-כבד → מוכר-זול יותר
}

/** FIX(SETTLE-7 anti-bandit): שער-תשואה-הפסד לחיילים — סוחר-ממשי עוצר-לצטט
 * כשההון שלו נמחק. בלי-זה: זרימה-עוינת דוחפת את הבריכה ואז מכה-את-הציטוטים
 * המנוחים — הארנה ממחזרת את עצמה אל-הבנדיט ללא-גבול. מתחת-לרצפת-ההון (60%
 * מג'נזיס) החייל מבטל-בלבד (מנקה-ספר) ולא מציב-פקודות-חדשות — שומר-על
 * ההון-שנותר ומאפשר-התאוששות. דטרמיניסטי (מצב-בלבד, אין-רנדומיות). */
const SOLDIER_GENESIS_EQUITY = 6_000_000; // 3M USDS + 1.2M SAOS @2500 (ג'נזיס)
const SOLDIER_EQUITY_FLOOR = Math.floor(SOLDIER_GENESIS_EQUITY * 0.6);
export function soldierEquity(st: DexState, soldier: string, fair: number): number {
  const usds = st.balances[soldier]?.["USDS"] ?? 0;
  const saos = st.balances[soldier]?.["SAOS"] ?? 0;
  const p = fair > 0 ? fair : 2500;
  return usds + Math.floor((saos * p) / 1000);
}

/** FIX(SETTLE-7 anti-bandit): תקרות-זריעה-מצטברות לבוטי-הרעש — FIX(Roast-64):
 * המדדים עברו ממודול-רגיש למצב (st.botSeedCounts) — ריסטארט לא מאפס עוד את
 * הגג-הכולל (זרימה-עוינת לא יכולה לגזור-מחדש מלאי-ג'נזיס-חדש-כל-ריסטארט). */
const BOT_SEED_CAP_USDS = 18_000_000; // [T25-FORGE] ×5
const BOT_SEED_CAP_SAOS = 9_000_000; // [T25-FORGE] ×5
// EXEC-CD-46 · noise-revival: נמדד-חי (h175,455): תקרות-החיים-הישנות מותשות (bot-a/b/c:
// 2.4M/1.2M מלא) בזמן-שהבוטים מרוקנים-לגמרי (1-4µ מכל-נכס) → זרימת-הרעש (גילוי-המחיר
// היחידה) מתה → fills=0 → feeMeter קפוא (1,485<רצפת-8,000) → המזרקה-יבשה. ההרמה
// מחזירה-את-הזרימה בהעברות-ממלאי-קיים-של-הארנה (6.79M SAOS + 3.5M USDS בידיה —
// אפס-הטבעה, Σשומר), עדיין-חסום-חיים (botSeedCounts במצב — שורד-ריסטארטים).

/** ── THE-REARM (SETTLE-14 price-truth) ──
 * ממצא-חי: הארנה שרפה את כל-המלאי (8M SAOS + 20M USDS מג'נזיס) בלחימה-חד-צדדית
 * מול סולם-הערך-העולה — ומאז היא-ענייה (0 SAOS): כל-פעולות-הייצוב (מנעול-בריכה,
 * חגורת-סולם) נדחות-בשקט והשוק צף ללא-גרביטציה. זה-המנוע-האמיתי של "המחיר-מטפס".
 * הטיפול: חייל-אספקה — אוצר→ארנה העברה-טהורה (אפס-הטבעה, Σשומר), מנות-2M,
 * תקרה-מצטברת-לכל-חיי-התהליך (8M SAOS + 20M USDS = מלאי-ג'נזיס-אחד),
 * ורק-אם-לאוצר יש-באמת (אפס-דחיות-ספר). עם-הסולם-הסימטרי (keel) הלחימה
 * כבר-לא-חד-צדדית — המלאי החדש נשחק בשני-הכיוונים ומתוחזק. */
const REARM_TRANCHE_SAOS = 6_000_000; // [T25-FORGE] ×3
const REARM_TRANCHE_USDS = 12_000_000; // [T25-FORGE] ×3
const REARM_TRANCHE_WSTEEM = 1_000_000;
const REARM_LIFETIME_SAOS = 48_000_000; // [T25-FORGE] ×6 — מלאי-הכבשן זורם-ארנה
// REARM-STOCK-LAW (2026-10-20 · שורש-נתפס-חי): מונה-החיים-נשחט (44M/48M — שארית 4M < טרנס 6M)
// בזמן-שלאוצר 29.6Mµ-SAOS אמת — הארנה רעבה (810µ) על-ספר-חשבון. המילוי הוא העברה-אמת
// (אפס-הטבעה) — המגן-האמיתי הוא רצפת-שמורת-האוצר, לא מונה. המונים נשארים מדידה.
const REARM_TREASURY_SAOS_RESERVE = 10_000_000; // האוצר-לא-יורד-מתחתיו-מעולם-מילוי-ארנה
const REARM_TREASURY_USDS_RESERVE = 400_000;
const REARM_LIFETIME_USDS = 120_000_000; // [T25-FORGE] ×6
const REARM_LIFETIME_WSTEEM = 1_000_000; // גבול-אמת: סטוק-ה-STEEM-הטבעי של-האוצר (אפס-הטבעה)
const REARM_FLOOR_SAOS = 3_000_000; // [T25-FORGE] ×5   // מתחת-לזה הארנה לא יכולה למכור-לתוך-בידים
const REARM_FLOOR_USDS = 6_000_000; // [T25-FORGE] ×5 // ולא-לקנות-מאסקים
const REARM_FLOOR_WSTEEM = 300_000; // מנעול-בריכת-WSTEEM צריך בסיס-למכור-בו
// FIX(Roast-64 · phantom-lifetime-caps): היה const arenaRearm = {...} במודול —
// ריסטארט = תקרה-מלאה-חדשה. עכשיו: st.rearmCounts (חוזה-מעלה).
const rearmCounts = (st: DexState): { saos: number; usds: number; wsteem: number; wsbd?: number; phive?: number; energy?: number } =>
  (st.rearmCounts ??= { saos: 0, usds: 0, wsteem: 0 });
const botSeedCounts = (st: DexState, bot: string): { usds: number; saos: number; wsbd?: number; phive?: number; energy?: number } => {
  st.botSeedCounts ??= {};
  return (st.botSeedCounts[bot] ??= { usds: 0, saos: 0 });
};

/** ── SETTLE-17 (soldier-WSTEEM supply line · one-sided-market cure) ──
 * ממצא-חי (R29): שוק USDS/WSTEEM חד-צדדי — אפס-asks חיים בעוד-ה-bids חיים.
 * שורש-מוכח: הג'נזיס מימן-חיילים-ב-SAOS+USDS בלבד (kernel genesis); קו-ה-rearm
 * (SETTLE-14) מזרים WSTEEM מהאוצר לארנה — אבל שום-קו-לא-מזרים-מהארנה-לחיילים.
 * החיילים החזיקו 15-64Kµ WSTEEM — פחות-מרמת-ask-אחת (sizeMu=80Kµ) — אז-
 * כל-ציטוט-המכירה נדחה-בשקט באמת-מלאי, והשוק נשאר-חד-צדדי לנצח.
 * הטיפול: קו-אספקה ארנה→חייל — ניתוב-מלאי-טהר של ה-WSTEEM-העטוף-הכנה
 * (1:1 מSTEEM-טבעי, אפס-הטבעה, Σנשמר), בכפוף-ל: תקרה-מצטברת-פר-חייל-במצב
 * (דפוס-Roast-64 — ריסטארט לא מאפס), כבוד-לרצפת-הארנה (REARM_FLOOR_WSTEEM —
 * בסיס-המנעול-לבריכה), ורק-מהעודף-האמיתי-שמעל-הרצפה. כשהארנה-ריקה-מעודף —
 * הקו-מפסיק-לזרום-בכנות (אין-מקור-נסתר). */
const SOLDIER_SEED_TARGET_WSTEEM = 160_000; // יעד-השלמה: 2 רמות-ask (sizeMu 80Kµ)
const SOLDIER_SEED_CAP_WSTEEM = 320_000;    // תקרה-מצטברת-פר-חייל לכל-חיי-התהליך
const soldierSeedCounts = (st: DexState, soldier: string): { wsteem: number; wsbd?: number; phive?: number; energy?: number } => {
  st.soldierSeedCounts ??= {};
  return (st.soldierSeedCounts[soldier] ??= { wsteem: 0 });
};

/* ── [T24 · MICRO-SEED] זריעת-מלאי-מיקרו לזוגות-המול-יציב ──────────────────
 * החיילים נולדו עם SAOS+USDS בלבד (ג'נזיס) — בזוגות WSBD/USDS ו-PHIVE/USDS
 * צד-האסק היה מת-לנצח (SETTLE-17-b מדד את אותו-שורש בדיוק על WSTEEM: כל-
 * ציטוט-מכירה נדחה-בשקט-מחוסר-מלאי והספר-נשאר-חד-צדדי). הטיפול באותו-רוח:
 * העברות-מלאי-טהרות מהאוצר (מלאי-טבעי-קיים-נמדד: WSBD ~60Kµ · PHIVE ~100Kµ)
 * דרך-הארנה אל-החיילים, בתקרות-חיים-מצטברות-במצב (דפוס-Roast-64 — ריסטארט
 * לא מאפס). הגדלים-המסתגלים (SETTLE-17-b) כבר-יודעים-לצטט ממלאי-אמת —
 * אפס-הטבעה, אפס-עומק-פיקטיבי, והספר-הפוך לדו-צדדי מהשעה-הראשונה. */
const MICRO_SEED: { asset: Asset; perSoldier: number; perSoldierCap: number; fleetCap: number }[] = [
  { asset: "WSBD", perSoldier: 20_000, perSoldierCap: 40_000, fleetCap: 300_000 }, // [T25] מסילת-SBD-אמת — דל-וכנה
  { asset: "PHIVE", perSoldier: 300_000, perSoldierCap: 450_000, fleetCap: 2_000_000 }, // [T25-FORGE] ×50
];

/* ── SETTLE-19 (גשר-מלאי-האסק · בריכה→ארנה) ── נמדד-חי (h135139 · 2026-10-14):
 * כל-קווי-מלאי-ה-WSTEEM יבשים בבת-אחת: rearm מותש (1M/1M — גבול-אמת: הסטוק-הטבעי),
 * העטיפה-החיצונית יבשה (STEEM-חי 124.5Kµ מתחת-לגיבוי ה-1M — אין-גירעון-חוקי-לעטיפה;
 * SBD מגובה-מלא 18,643µ), pool_rmw אסור-אוצר-לנצח (חוק-ג'נזיס FIX-3a) — והספר ריק
 * לגמרי (0 bids · 0 asks — A43 אדום) בזמן-שהבריכה (100% אוצר) מחזיקה 11.8M WSTEEM
 * מאחורי-LP-נעול. החוק: האוצר קונה מהבריכה-שלו-עצמו (pool_swap — Σ נשמר, מחיר-בריכה)
 * מנת-זריעה מתוחמת, מישר-את-הבריכה-בחזרה-לעוגן (pool_repeg — כלי-R26-הריבוני),
 * ומנתב ארנה→חיילים דרך קו-SETTLE-17 הקיים (התקרות-הפר-חייל שלו שלמות). אפס-הטבעה
 * · אפס-pool_rmw · משמעת-ריקון-הבריכה (לעולם לא נוטלים מעבר-ל-guard) · הכל מגולל
 * ביומן-הגרעין.
 * SETTLE-19-b (סרוו · נמדד-חי-בהפעלה-הראשונה, run 38568088488): תקרת-חיים-חד-
 * פעמית (2Mµ) הוסתה-בריצה-אחת ע"י מילויים-אמת (1,166 fills) — השוק סחר, האסקים
 * נאכלו, והצד-התרוקן-שוב. זו-לא-תקלה — זו-כלכלת-שוק: מלאי-אסק נצרך-בהמשך.
 * הטיפול: הגשר-הוא **סרוו** ולא-זריעה — זורם-רק-את-המחסור-החי-של-הצי
 * (Σמלאי-אסק-חופשי של-החיילים-והארנה-מעל-הרצפה מול-יעד-חימוש-מלא), נח-כשהצי-חמוש
 * (כנות — אותו-דפוס של MICRO-SEED), חוזר-לזרום-כשהמילויים-שחקו-את-המלאי. bridgeCounts
 * נשאר-מונה-טלמטריה-מונוטוני (בלי-תקרה — ה-guard-של-הבריכה הוא-הגבול-האמת). */
const BRIDGE_TRANCHE_USDS = 10_000;        // מנת-חלון (16-טיק) במונחי-עלות: ~160Kµ WSTEEM במחיר-בריכה החי
const BRIDGE_WINDOW_CAP_WSTEEM = 200_000;  // מגן-חלון: הפלט-לא-יחרוג (בריכה-זולה-במיוחד → מנה-חצויה)
const BRIDGE_FLEET_ARM_TARGET = SOLDIER_SEED_TARGET_WSTEEM * 4; // יעד-החימוש: הצי-כולו (4-חיילים) ב-2-רמות-אסק
const BRIDGE_POOL_GUARD_WSTEEM = 4_000_000; // משמעת-הבריכה: צד-ה-WSTEEM לעולם לא יורד מתחת
const bridgeUsed = (st: DexState): number => st.bridgeCounts?.wsteem ?? 0;
const bridgeAdd = (st: DexState, mu: number): void => {
  st.bridgeCounts ??= {};
  st.bridgeCounts.wsteem = (st.bridgeCounts.wsteem ?? 0) + mu;
};
const microSeedCounts = (st: DexState, asset: string): number => {
  st.microSeedCounts ??= {};
  return (st.microSeedCounts[asset] ??= 0);
};

type PushOp = (op: Op) => void;

/** FIX(Task 56 replay-storm): אחרי-טעינת-תמונת-מצב, st.nonces מכיל אלפי-נונסים
 * `a<N>` של-החיילים-מהריצות-הקודמות; RT-רץ-חדש התחיל מ-seq=0 והתנגש-בכולם
 * (replay-rejected המוני עד-שה-seq עובר-את-החלון). הפתרון: בעת-יצירת-RT לחייל,
 * נזרע-seq מעל-המקסימום-הקיים-בחלון-הנונסים — התנגשות-אפסית מהטיק-הראשון.
 * FIX(EXEC-CD-9 · deep-window-seed): הסריקה-הייתה-על-2000-האחרונים-בלבד — שטף-ops
 * (למשל-אחרי-הצתת-הדלק: ארנה+בוטים+חיילים-מציפים-את-החלון) דחק-את-הנונסים-של-חייל-
 * נתון-מחוץ-לטווח-הסריקה → זריעה-נמוכה-מדי → התנגשות-עם-נונסים-חיים-בחלון-ה-6000.
 * עתה: סריקה-מלאה-של-החלון-כולו (≤6000 — זול); בנוסף סף-ביטחון: הזריעה = max+200. */
function seedNonceSeq(st: DexState, soldier: string): number {
  // FIX(EXEC-CD-9 · full-set-seed): הזריעה מול **כל-ה-Set** (maxNonceSuffix — הגרעין),
  // לא-מהחלון: נונסים-שנשטפו-מהמערך-אך-חיים-ב-Set היו-מוחזרים-כבעלי-עימות.
  const max = maxNonceSuffix(`${soldier}:a`, st);
  return max + 200; // סף-ביטחון מפני-ops-בדרך-בממפול
}

function submit(rt: Map<string, SoldierRT>, st: DexState | null, soldier: string, op: Omit<Op, "issuer" | "nonce">, pushOp: PushOp): void {
  const r = rt.get(soldier) ?? { nonceSeq: st ? seedNonceSeq(st, soldier) : 0, fills: 0, takes: 0 };
  // FIX(EXEC-CD-9 · skip-occupied): בדיקת-תפוסה O(1) מול-ה-Set-האמת לפני-הדחיפה —
  // הסקוו מדלג-מעל-כל-נונס-שכבר-חי (שרידי-ריצות/rewinds) במקום-סערת-replay-rejected.
  // אותו-פורמט-מפתח כמו-applyOp: `${issuer}:${nonce}`.
  if (st) {
    let n = r.nonceSeq + 1;
    while (nonceExists(st, `${soldier}:${soldier}:a${n}`)) n++;
    r.nonceSeq = n;
  } else {
    r.nonceSeq++;
  }
  rt.set(soldier, r);
  // FIX(R45 · nonce-owner): ה-nonce היה `a${seq}` חסר-בעלים — ה-seeding למעלה סרק
  // קידומת `${soldier}:a` שלעולם-לא-נכתבה (קוד-מת) ← כל-אתחול-תהליך מתחיל-seq-מ-1
  // מחדש, ההזמנות של כל-החיילים-והבוטים מתנגשות-ביניהן ובחלון-הנונסים-ההיסטורי
  // (replay-rejected המוני-עד-שה-seq-עובר-את-החלון — בדיוק-מה-שההערה-למעלה-התכוונה-
  // למנוע). עכשיו: הקידומת-בפועל-שווה-לזו-שה-seeding-סורק — הזריעה-חיה-וההתנגשות-נעלמת.
  pushOp({ ...op, issuer: soldier, nonce: `${soldier}:a${r.nonceSeq}` } as Op);
}

/**
 * pegkeeperTick — עמדת-הייצוב (מהדורת-סליקה): "שהכל ישב".
 *  · מנעול-בריכה: כשהבריכה סוטה מהפייר ≥30bps — הארנה מארביטרג'ת אותה חזרה.
 *    FIX(SETTLE-14 price-truth): גודל-פרופורציונלי לפער (עד 600kµ — היה 150k
 *    שלא-סגר-אף-פער-מעל-1%) — הבריכה מתיישרת למחיר-אמת בשניות, לא בשעות.
 *  · חגורת-סולם: חריגה מ-refPrice מוחזרת-בגודל-פרופורציונלי לסטייה —
 *    חגורה-חלשה-קבועה היא-שאיפשרה-לספר לצוף +15% מעל הסולם (ממצא-חי 2026-09).
 *  · רצפות-עומק: בריכה-שמתחת-לרצפה מקבלת-השלמה-פרופורציונלית מהארנה
 *    (מנעול-יחס-בריכה — הוספה-ביחס-הנוכחי לא מזיזה-את ה-mid) — "הבריכות זמינות".
 * כל-הפעולות: ממפול רגיל, מאושרות-על-הספר, מדודות-GAS, מכסה-גודל ותדר.
 */

/** רצפות-עומק-בריכה (SETTLE-14): רזרבה-מינ' בµ לכל-נכס — מתחת-לזה הבריכה לא
 * "זמינה" מסחרית (slippage איום). הארנה משלימה-פרופורציונלית כל-8 טיקים. */
export const POOL_DEPTH_FLOORS: Record<string, number> = {
  USDS: 10_000_000, SAOS: 4_000_000, WSTEEM: 4_000_000,
};
export function pegkeeperTick(st: DexState, tick: number, pushOp: PushOp): void {
  const m = MARKETS[0]; // הזוג-הריבוני — לחגורת-הסולם
  const fair = fairPrice(st, m.base, m.quote);
  if (fair <= 0) return;

  // (1) מנעול-בריכה — לכל-הזוגות (FIX SETTLE-14: היה רק-הזוג-הריבוני ובריכת
  // WSTEEM צפה חופשי — נסחרה עד 6x מעל הספר בלי-שום-גרביטציה)
  // R26 · הסרת-הפטור-של-זוגות-המסילה: הפטור נולד (SETTLE-16) כי-הפייר-הצף גרר-
  // את-הבריכה-בחזרה-מעלה אחרי-ה-REPEG ("מלחמת-סוכנים"). מאז-R26 הפייר-של-זוג-
  // מסילה ≡ העוגן (fairPrice מחזיר refPrice) — אין-עוד-שני-מנועים-עם-שני-יעדים:
  // מנוע-אחד, יעד-אחד (העוגן). המנעול חוזר-לשמור-גם-על-בריכת-המסדרון — בלי-
  // הכוח-הזה בריכה-רדודה (אחרי-סימון-מחדש) נסחפת-חופשית-ברעש-הבוטים (נמדד:
  // 54→66µ ב-60-טיקים) והמסילה חסרת-מלאי-לשפשף (doses=0). המנוע-השני נשאר
  // למנות-העדינות (TWAP-scrubbing) — שניהם-פונים-לאותו-עוגן.
  for (const mk of MARKETS) {
    const mkPair = poolKey(mk.base, mk.quote);
    const p = getPool(st, mkPair);
    if (!p) continue;
    const pm = poolMidFor(p, mk.base, mk.quote);
    if (pm <= 0) continue;
    const mkFair = fairPrice(st, mk.base, mk.quote); // פייר-פר-זוג — לעולם לא פייר-זר
    if (mkFair <= 0) continue;
    const gapBps = Math.floor(((pm - mkFair) / mkFair) * 10_000);
    // SETTLE-14: פער-גדול (≥200bps) מטופל כל-טיק; קטן — כל-טיק-שני (חיסכון-גז)
    if (Math.abs(gapBps) >= 30 && (Math.abs(gapBps) >= 200 || tick % 2 === 0)) {
      const assetIn = gapBps > 0 ? mk.base : mk.quote; // יקר-בבריכה → מזרימים-בסיס-פנימה (מוריד-mid)
      // R26 · מנה-מדויקת-שורש (סגירת-פער-לאפס): הליניאריזציה-מחצית-הפער היתה
      // כפולה במכפיל — mid ∝ ra/rb (שינוי-יחס), אבל המנה חושבה-ליניארית-על-המונה
      // בלבד. על-בריכה-רדודה מנת-10kµ הרימה-את-ה-mid ב-+3.7% (דיוק-היעד: +1.9%)
      // → הצד-השני לא-החזיר-אותה → ראצ'ט מתמשך שדילדל-את-הבריכה מ-WSTEEM
      // (נמדד-חי: 54→82µ תוך-240-טיקים). המנה-המדויקת להביא-את-מחיר-הבריכה
      // בדיוק-לפייר: sqrt — שכן mid' = 1000·rQ·rB/(rB+x)² למכירה,
      // ו-mid' = 1000(rQ+x)²/(rB·rQ) לקנייה. לפערים-קטנים היא מתכנסת-לליניארית
      // (sqrt(1+g)≈1+g/2) — שיפור-טהור, בלי-overshoot, בלי-ראצ'ט.
      const rBase = mk.base === p.a ? p.ra : p.rb;
      const rQuote = mk.quote === p.a ? p.ra : p.rb;
      const raw = gapBps > 0
        ? Math.floor(Math.sqrt(Math.floor((1000 * rQuote * rBase) / mkFair)) - rBase)   // מכירת-בסיס פנימה
        : Math.floor(Math.sqrt(Math.floor((mkFair * rBase * rQuote) / 1000)) - rQuote); // קניית-בסיס מהבריכה
      const size = Math.min(Math.max(raw, 1), 1_200_000, avail(st, "arena", assetIn)); // IGNITION-R1: תקרת-המנעול ×2 (היתה 600k) — יישור-בריכות מהיר-יותר = עמלות-אמת
      if (size >= 500) {
        pushOp({ type: "pool_swap", issuer: "arena", nonce: `pk-pool-h${st.height}-${mk.base}`, pair: poolKey(mk.base, mk.quote), assetIn, amount: size });
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
      // SETTLE-14 price-truth: גודל-החגורה פרופורציונלי לסטייה — 80k-קבוע מול
      // סטיית-15% היה טיפה-בים (הספר צף ולא חזר). 120k+300µ/סט-בפס, תקרה 600k.
      const bandQty = Math.min(120_000 + Math.abs(devBps) * 300, 600_000);
      if (devBps > 400) {
        // יקר-מדי-מול-הסולם → הארנה מוכרת-לתוך-הבידים (מורידה-את-המגע)
        const qty = Math.min(bandQty, avail(st, "arena", m.base));
        if (qty >= 5_000) {
          pushOp({ type: "fill", issuer: "arena", nonce: `pk-band-h${st.height}-${m.base}-s`, base: m.base, quote: m.quote, side: "sell", amount: qty, market: true });
        }
      } else if (devBps < -400) {
        // זול-מדי → הארנה קונה-מהאסקים (מרימה-את-המגע)
        const px = ba > 0 ? ba : ref;
        const qty = Math.min(bandQty, Math.floor((avail(st, "arena", m.quote) * 900) / (px * 10)));
        if (qty >= 5_000) {
          pushOp({ type: "fill", issuer: "arena", nonce: `pk-band-h${st.height}-${m.base}-b`, base: m.base, quote: m.quote, side: "buy", amount: qty, market: true });
        }
      }
    }
  }

  // (3) רצפות-עומק (SETTLE-14): "הבריכות יהיו זמינות" — בריכה-שרזרבה-אחת-שלה
  // מתחת-לרצפה מקבלת-השלמה-פרופורציונלית-מהארנה (הוספה-ביחס-הנוכחי = אפס-הזזת-mid).
  // ממומן-רק-ממלאי-אמת-של-הארנה (בדיקת-avail לפני-הדחיפה — אפס-דחיות-ספר).
  if (tick % 8 === 0) {
    for (const m of MARKETS) {
      const p = getPool(st, poolKey(m.base, m.quote));
      if (!p) continue;
      const floorA = POOL_DEPTH_FLOORS[p.a] ?? 0;
      const floorB = POOL_DEPTH_FLOORS[p.b] ?? 0;
      const shortA = Math.max(0, floorA - p.ra);
      const shortB = Math.max(0, floorB - p.rb);
      if (shortA <= 0 && shortB <= 0) continue;
      // משלימים-את-הצד-החסר-הגדול; הצד-השני נגזר-מיחס-הבריכה (חוזה pool_add)
      const addA = shortA >= shortB ? shortA : (p.ra > 0 ? Math.floor((shortB * p.ra) / p.rb) : 0);
      if (p.ra <= 0 || p.rb <= 0 || addA <= 0) continue;
      const addB = Math.floor((p.rb * addA) / p.ra);
      if (addA < 20_000 || addB < 20_000) continue;
      if (avail(st, "arena", p.a) < addA || avail(st, "arena", p.b) < addB) continue;
      pushOp({ type: "pool_add", issuer: "arena", nonce: `pk-floor-h${st.height}-${p.a}`, pair: poolKey(p.a, p.b), amount: addA });
    }
  }
}

/** טיק-ארנה: ריקוט-גריד לכל-חייל + טייק-מסתובב עם-שער-שוליים + בוטי-רעש
 * FIX(SETTLE-9): ה-param nowMs היה-מת (void nowMs בלבד) — הוסר מהחתימה ומהקריאה. */
export function arenaTick(
  st: DexState, tick: number,
  params: ArenaParams,
  rt: Map<string, SoldierRT>,
  pushOp: PushOp,
): void {
  // ── OWNER-MANDATE 2026-10-17 · החיילים הסינתטיים סולקו ───────────────────
  // soldier-1..4 נמחקו מהשרשרת (agent_purge — פקודת-בעלים: אין-מפתחות, אין-שליטה,
  // מתים). הרוסטר-ריק — כל-קווי-האספקה-לחיילים להלן נהיים נו-אופ טבעיים.
  // עושי-הספר האמתיים: סוכני-המערכת (הארנה העמוקה + הבוטים).
  const soldiers: string[] = [];
  const makers = ["arena", "bot-a", "bot-b", "bot-c"];

  // עמדת-הייצוב (סליקה): מנעול-בריכה + חגורת-סולם — לפני-הזרימה-החופשית
  pegkeeperTick(st, tick, pushOp);

  // THE-MICRORAIL (SETTLE-16): המסילה-הריבונית-למיקרו — מימון-רצפות מהתקציב-
  // הקיים (אפס-הטבעה) + מנות-שפשוף-לעוגן על הזוגות-בבעלותה. אחרי-pegkeeper,
  // לפני-הגריד — העוגן-קודם-לזרימה-החופשית.
  railTick(st, tick, pushOp);

  // קצבת-חיות (THE-REFUEL): כל-16 טיקים — מי-שהקרדיטים-שלו מתחת-למסלול מקבל
  // הזרמה מהאוצר. **העברה-טהורה (אפס-הטבעה)** — Σcredits נשמר. בלי-זה הגריד
  // מת-מוות-מבני: gas יורד-מונוטונית, החיילים מפסיקים-לצטט, הספר מתרוקן,
  // הספרד-נעלמת והשוק מפסיק-לשבת. תיקון-שורש לתשישות-הכלכלה-הסימולטיבית.
  // FIX(roast-79 · fuel-death-spiral, נמדד-חי): החלון-16-טיק היה-חלק-ממעגל-מוות —
  // הדמון-מת-בסביבה-הזו אחרי-כמה-עשרות-שניות, לפני-הטיק-ה-16 (ציטוט-החיילים מתחיל-בטיק-1!)
  // → החיילים מתים-מוקדם → אין-מסחר → אין-עמלות → אין-מזרקה → אין-דלק. החלון הוקדם
  // ל-4 (וגם-טיק 1–2 מיד-אחרי-boot): התזמון בלבד — ההעברות-עצמן טהורות-ומוגבלות.
  if (tick <= 2 || tick % 4 === 0) {
    // FIX(roast-81 · afford-race): ספר-תקציב-פר-טיק (ראה-למטה) — אפס-חפירה-מעבר-לרצפת.
    const fuelBudget = new Map<string, number>();
    // THE-FOUNTAIN: אוצר-ריק? הטבעה-עצמית מגובה-עמלות-מדודות (profit-שהוכר +
    // feeMeter-מעל-רצפת-הסולם, מדוד-תקרה) — המסחר-עצמו מחזיר-את-הדלק-ששרף.
    // קודם-ההטבעה, אחר-כך העירוי.
    // FIX(roast-79): השער fuelAvail>20k היה-חסם-מבני — נמדד fuelAvail=18,618
    // (מתחת-ל-20k) = מזרקה-יבשה-לנצח בזמן-שלטרשורה-היה-גיבוי-אמת. השער הורד-ל-1k:
    // הגרעין (kernel mint_fuel) עדיין אוכף בעצמו את הגיבוי-הכפול, הרצפה (8k) והתקרה —
    // כאן-רק-החלטת-תזמון-כלכלית, לא-שכבת-אבטחה.
    // FIX(g94): trCr הוסר — השער-החי-הוא-קרדיטי-הארנה (שורש-המימון), לא-האוצר.
    // FIX(roast-81 · fountain-half-throttle): ה-/2 כאן היה-חנק-כפול-מעל-אכיפת-הגרעין
    // (mint_fuel כבר-אוכף-בעצמו רצפת-8k + תקרה). נמדד-חי: fuelAvail=577<שער-1,000
    // בזמן-שהגרעין-הרשה-1,154 → מזרקה-יבשה, האוצר-תקוע-על-8µ-גז, ו-ProtoRev —
    // מנוע-הארב-שרץ-כ-batch-אוצר — מת-מרעב-גז (revAux.rejections=5,181).
    // עכשיו: אותו-מדד-בדיוק-של-הגרעין — האכיפה-במקום-אחד.
    // FIX(g94 · self-enrich-vs-fountain, נתפס-חי-2026-10-20): הזרקה-ל-"treasury" נדחית-תמידית
    // בשער-הגרעין batch-self-enrich-forbidden (מנגד-הטבעה-עצמית) → כל-ההטבעות-האוטומטיות
    // מתו-בשקט-והמשק-נשתק (כל-קרדיטי-הגז=0, ארנה-מוסרת-insufficient-escrow-בכל-בלוק,
    // נמדד h830516: batch(treasury):batch-self-enrich-forbidden). התיקון: להטביע-ישר-לארנה —
    // שורש-שרשרת-המימון (funderFor: arena→בוטים→אוצר→מפעיל) — הארנה-מממנת-את-הכל-בעצמה.
    // הגרעין-ממשיך-לאכוף-בעצמו: גיבוי-כפול (profit-ראשון) + רצפת-8k + תקרה-100k.
    // ── G105 · THE-DROUGHT-FOUNTAIN (trace 1a17ded5ebeb520d) ── נמדד-חי
    // 2026-10-27T15:16Z: feeMeter 3,346 כלוא-מתחת-לרצפה · Σcredits 11,220 · ארנה 0
    // → 13 דחיות/בלוק, ובמקביל revAux.protorevMu 20.3M מדוד-וכלוא (ראוטר-מנוע).
    // בבצורת (isFuelDrought — גרעין-מקור-אמת-יחיד): רצפת-המד DROUGHT_FLOOR + revAux
    // כגיבוי-שלישי. הגרעין עדיין-האוכף-היחיד: כל-µ-מוטבע-נגרע-מדידה-אמת
    // (profit→meter→aux), ודחייה-כנה-אם-הגרעין-לא-מאשר (fail-closed).
    const drought = isFuelDrought(st);
    const meterFloor = drought ? DROUGHT_FLOOR : LADDER_FUEL_FLOOR;
    const fuelAvail = Math.max(0, st.treasuryProfit)
      + Math.max(0, (st.feeMeter ?? 0) - meterFloor)
      + (drought ? auxAvailMu(st) : 0);
    if ((st.credits["arena"] ?? 0) < DROUGHT_ARENA_MIN && fuelAvail > 1_000) {
      const mint = Math.min(60_000, MINT_FUEL_CAP, fuelAvail);
      if (mint > 0) pushOp({ type: "mint_fuel", issuer: "treasury", nonce: `fountain-h${st.height}`, to: "arena", amount: mint });
    }
    // EXEC-CD-46 · arena-first: נמדד-חי (t+2min אחרי-refuel-fairness): החיילים-התעוררו
    // (975/630/850µ) אבל-הארנה-נשארה 3µ — והיא-המממנת-את-בוטי-הרעש (זריעה=transfer
    // שדורש-גז-100µ) ואת-המנעול-ואת-חגורת-הסולם. בלי-גז-ארנה: אפס-זריעה → אפס-רעש →
    // אפס-פילים. הארנה-ראשונה-בתור = מפתח-המפל: גז-ארנה → זריעה → רעש → חציות → עמלות.
    for (const ag of ["arena", ...soldiers, "bot-a", "bot-b", "bot-c", "bot-e", "rail"]) {
      const c = st.credits[ag] ?? 0;
      // FIX(SETTLE-15 fuel-oscillation, נתפס-בלוג-הדחיות): סף-10k = מילוי-מוקדם-בחלון-אחד,
      // אפס-דחיות; זו-העברה-טהורה (אפס-הטבעה) — השריפה-הכוללת-לא-משתנה, רק-התזמון-מוקדם.
      if (c < 10_000) {
        const need = Math.min(30_000 - c, REFUEL_CAP);
        if (need <= 0) continue;
        // FIX(roast-81 · affordability-ask): היה-בקשה-קבועה (30k−c) שהגרעין דוחה-בכנות
        // כשאף-ממנה לא עומד-במרווח — נמדד-חי: Σcredits=54,793µ מול-דרישה-קבועה-של-~240k
        // → סירול-דחיות-נצחי, הספר-ריק-מציטוטים, וחיילים-עשירים-בטוקנים-ועניים-בגז
        // (soldier-1: 2.1M-SAOS+3.8M-USDS · 10µ-קרדיטים) לא-מצטטים. עכשיו: הבקשה
        // מתכווננת-ליכולת-הממנה-בפועל — אותו-סדר-סולם-ואותם-מרווחי-ברזל (funderAfford
        // מקור-אמת-אחד בגרעין); מתחת-ל-FUEL_ASK_MIN לא-מבקשים (אבק-גז); אסור-לממן-עצמי
        // (f≠ag — SETTLE-7). הגרעין נשאר-האוכף-המלא (fail-closed).
        // FIX(roast-81 · afford-race): כל-הדחיפות-באותו-טיק קוראות-את-אותו-st.credits
        // לפני-היישום — נמדד-חי: bot-a (14,940) מומן-3×4,940-בטיק-אחד ונשחק-עד-0
        // (עבר-על-רצפת-ה-10k-שלו). עכשיו: ספר-תקציב-פר-טיק — כל-דחיפה-מנכה-מהיכולת
        // שנתפסה, אף-ממנה-לא-נחפר-מעבר-לרצפת-שלו.
        let funder: string | null = null;
        let amt = 0;
        // EXEC-CD-46 · refuel-fairness: נמדד-חי (h175,455): המחזור-החי-היחיד (מחזור-גז-הספר
        // ~9,600µ/חלון → אוצר) נבלע-כולו בסוכן-הראשון-בתור (soldier-1, דרישה ~27,925µ) —
        // soldier-2/3/4 + arena + bot-e נשארים אפס-גז (45/0/10/3/20µ) לנצח → ספר-מייקר-יחיד →
        // אין-צד-שני-לחצות → fills=0. תקרת-הוגנות-פר-סוכן-פר-חלון מפזרת-את-הדלק-הדח —
        // כל-הגריד-חוזר-לצטט תוך-חלון-שניים, ומחזור-הגז-גדל-עם-השריפה (איזון-עצמי).
        const REFUEL_FAIRNESS_CAP = 2_000;
        for (const f of FUNDER_ORDER) {
          if (f === ag) continue;
          const afford = funderAfford(st, f) - (fuelBudget.get(f) ?? 0);
          if (afford >= Math.min(need, FUEL_ASK_MIN)) { funder = f; amt = Math.min(need, afford, REFUEL_FAIRNESS_CAP); break; }
        }
        // T37-d · סרוו-עומק-הספר: כשהסולם-הראשי-מת (נמדד-חי h155706: אוצר 14µ ·
        // operator 1,860 < FUEL_ASK_MIN · מטר-על-רצפת · profit 439µ — המוות-המנעול
        // אין-אסקים→אין-מילויים→אין-הכנסה) — הרזרבות-העומדות (sweeper/rail/bot-e)
        // נכנסות כ-**אמבולנס-הספר**: זורמות רק-כשצד-האסק-של-השוק-הריבוני-מת
        // (bookAskAlive — מדידת-מצב-אמת), ברצפות-מסלול-שלמות (reserveFunderAfford),
        // ונחות-ברגע-שהספר-חוזר-לחיות. העברה-טהורה (אפס-הטבעה) — אותו-משפט-refuel.
        if (!funder) {
          for (const f of RESERVE_FUNDERS) {
            if (f === ag) continue;
            const afford = reserveFunderAfford(st, f) - (fuelBudget.get(f) ?? 0);
            if (afford >= Math.min(need, FUEL_ASK_MIN)) { funder = f; amt = Math.min(need, afford, REFUEL_FAIRNESS_CAP); break; }
          }
        }
        if (!funder || amt <= 0) continue;
        fuelBudget.set(funder, (fuelBudget.get(funder) ?? 0) + amt);
        pushOp({ type: "refuel", issuer: funder, nonce: `refuel-h${st.height}-${ag}`, to: ag, amount: amt });
      }
    }
  }

  // ── THE-REARM: חייל-אספקה-למייצב (למעלה — תיעוד-מלא) — קצב 16-טיק כמו-העירוי ──
  if (tick % 16 === 0) {
    const rc = rearmCounts(st);
    // REARM-STOCK-LAW: SAOS/USDS מתחדשים-מול-מלאי-אוצר-אמת (מעל-רצפת-שמורה) —
    // מונה-החיים נשאר רק מדידה (rc). WSTEEM נשאר מוגבל-חיים (גבול-עטיפה 1:1 אמת).
    if (avail(st, "arena", "SAOS") < REARM_FLOOR_SAOS) {
      const stockCap = Math.max(0, avail(st, "treasury", "SAOS") - REARM_TREASURY_SAOS_RESERVE);
      const amt = Math.min(REARM_TRANCHE_SAOS, stockCap);
      if (amt > 0) {
        rc.saos += amt;
        pushOp({ type: "transfer", issuer: "treasury", nonce: `rearm-sh${st.height}`, to: "arena", asset: "SAOS", amount: amt });
      }
    }
    if (avail(st, "arena", "USDS") < REARM_FLOOR_USDS) {
      const stockCap = Math.max(0, avail(st, "treasury", "USDS") - REARM_TREASURY_USDS_RESERVE);
      const amt = Math.min(REARM_TRANCHE_USDS, stockCap);
      if (amt > 0) {
        rc.usds += amt;
        pushOp({ type: "transfer", issuer: "treasury", nonce: `rearm-uh${st.height}`, to: "arena", asset: "USDS", amount: amt });
      }
    }
    // קו-WSTEEM (SETTLE-14): אוצר-עוטף-את-ה-STEEM-הטבעי-שלו-עצמו (גיבוי 1:1 כנה —
    // אפס-הטבעה-רכה: הגיבוי נרשם ב-backing) ואז מעביר לארנה לשירות-המנעול.
    // העטיפה-וההעברה-בטיקים-נפרדים — הבדיקה-על-avail לפני-כל-דחיפה מסדרת-את-הסדר.
    if (avail(st, "arena", "WSTEEM") < REARM_FLOOR_WSTEEM && rc.wsteem + REARM_TRANCHE_WSTEEM <= REARM_LIFETIME_WSTEEM) {
      const amt = Math.min(REARM_TRANCHE_WSTEEM, REARM_LIFETIME_WSTEEM - rc.wsteem);
      const tw = avail(st, "treasury", "WSTEEM");
      if (tw < amt && avail(st, "treasury", "STEEM") >= amt - tw) {
        pushOp({ type: "wrap_mint", issuer: "treasury", nonce: `rearm-wraph${st.height}`, wrapAsset: "WSTEEM", amount: amt - tw });
      }
      if (avail(st, "treasury", "WSTEEM") >= amt) {
        rc.wsteem += amt;
        pushOp({ type: "transfer", issuer: "treasury", nonce: `rearm-wh${st.height}`, to: "arena", asset: "WSTEEM", amount: amt });
      }
    }

    // ── SETTLE-17: קו-אספקת-חיילים — ארנה→חייל (רק-מעל-רצפת-הארנה, מצטבר-במצב) ──
    // באותו-חלון-16-טיק של-ה-rearm: קודם-הארנה-מתמלאת, אחר-כך-החיילים-מקבלים.
    // העברה-טהורה של-מלאי-קיים — לא-הטבעה, לא-מקור-חדש; הגרעין-אוכף-בעצמו.
    for (const soldier of soldiers) {
      const free = avail(st, soldier, "WSTEEM");
      const sc = soldierSeedCounts(st, soldier);
      if (free >= SOLDIER_SEED_TARGET_WSTEEM || sc.wsteem >= SOLDIER_SEED_CAP_WSTEEM) continue;
      const want = SOLDIER_SEED_TARGET_WSTEEM - free;            // השלמה-ליעד-בלבד
      const byCap = SOLDIER_SEED_CAP_WSTEEM - sc.wsteem;          // כבוד-לתקרה-המצטברת
      const arenaSpare = avail(st, "arena", "WSTEEM") - REARM_FLOOR_WSTEEM; // עודף-אמיתי-מעל-רצפת-המנעול
      const amt = Math.min(want, byCap, arenaSpare);
      if (amt > 0) {
        sc.wsteem += amt;
        pushOp({ type: "transfer", issuer: "arena", nonce: `swseed-h${st.height}-${soldier}`, to: soldier, asset: "WSTEEM", amount: amt });
      }
    }

    // ── SETTLE-19: גשר-מלאי-האסק — בריכה→ארנה (המקור-החוקי-האחרון-שנשאר) ──
    // באותו-חלון-16: קודם-הגשר ממלא-את-הארנה, אחר-כך קו-SETTLE-17 (למעלה) מזרים-
    // לחיילים. שלושת-ה-ops נדחפים-בטיק-זה ומתבצעים-בבלוקים-עוקבים (חוק-בלוק-אחד-ל-op);
    // הגדלים נגזרים-דטרמיניסטית-ממצב-הקריאה (quoteOut — אותו-מתמטיקה שהגרעין יבצע,
    // עמלה-כלולה) וההעברה מנותבת-בגודל-הפלט-המחושב בדיוק — אפס-שאריות-אבק.
    // דחייה-כלשהי בגרעין (גז-חסר עד-הפריימר, וכו') = ניסיון-חוזר-בחלון-הבא — כנות.
    {
      const poolW = getPool(st, "USDS/WSTEEM");
      const rearmExhausted = rearmCounts(st).wsteem >= REARM_LIFETIME_WSTEEM;
      const arenaBelowFloor = avail(st, "arena", "WSTEEM") < REARM_FLOOR_WSTEEM;
      if (poolW && arenaBelowFloor && rearmExhausted) {
        // SETTLE-19-b · הסרוו: מלאי-האסק-החופשי-של-הצי (חיילים + עודף-הארנה-מעל-הרצפה)
        // מול-יעד-החימוש — זרימה-רק-את-המחסור-האמת; נח-כשהצי-חמוש.
        const fleetAskInv = soldiers.reduce((s, sol) => s + avail(st, sol, "WSTEEM"), 0)
          + Math.max(0, avail(st, "arena", "WSTEEM") - REARM_FLOOR_WSTEEM);
        const shortfall = Math.max(0, BRIDGE_FLEET_ARM_TARGET - fleetAskInv);
        // משמעות-הבריכה: צד-ה-WSTEEM (p.a=USDS ⇒ rb; ההפוך ⇒ ra) לעולם לא יורד מתחת-ל-guard
        const poolWsteem = poolW.a === "WSTEEM" ? poolW.ra : poolW.rb;
        if (shortfall > 0 && poolWsteem >= BRIDGE_POOL_GUARD_WSTEEM) {
          // גודל-דטרמיניסטי-קבוע: מנת-USDS קבועה; הפלט-נגזר-מ-quoteOut (אותו-מתמטיקת-
          // גרעין, עמלה-דינמית-כלולה) וההעברה-מנותבת-בגודל-הפלט-המדויק — אפס-שאריות.
          // מגן-חלון: אם-הפלט-חורג-מתקרת-החלון (בריכה-זולה-במיוחד) — מנה-אחת-וציטוט-חוזר.
          const q1 = quoteOut(poolW, "USDS", BRIDGE_TRANCHE_USDS);
          const quoted = q1 && q1.out > BRIDGE_WINDOW_CAP_WSTEEM
            ? quoteOut(poolW, "USDS", Math.floor(BRIDGE_TRANCHE_USDS / 2))?.out ?? 0
            : q1?.out ?? 0;
          const out = Math.min(quoted, shortfall); // הסרוו: רק-המחסור-האמת; השאריות-נשארות-באוצר (השומר-מנצל)
          if (out > 0 && avail(st, "treasury", "USDS") >= BRIDGE_TRANCHE_USDS) {
            pushOp({ type: "pool_swap", issuer: "treasury", nonce: `bridge-swap-h${st.height}`, pair: "USDS/WSTEEM", assetIn: "USDS", amount: BRIDGE_TRANCHE_USDS });
            // מישור-העוגן באותו-חלון — הסוואפ הופך-את-הבריכה-יקרה-מהעוגן; ה-repeg
            // (אפס-גז, Σ נשמר) מחזיר-את-העודף-לאוצר ומחזיר-את-ה-mid אל-העוגן (R26).
            pushOp({ type: "pool_repeg", issuer: "treasury", nonce: `bridge-repeg-h${st.height}`, pair: "USDS/WSTEEM" });
            pushOp({ type: "transfer", issuer: "treasury", nonce: `bridge-w-h${st.height}`, to: "arena", asset: "WSTEEM", amount: out });
            bridgeAdd(st, out);
          }
        }
      }
    }

    // [T24 · MICRO-SEED] זריעת-המיקרו לזוגות-המול-יציב — שני-שלבים בחלון-16:
    // אוצר→ארנה (השלמת-מלאי-לפי-הצורך-הנמדד) וארנה→חיילים (אספקת-אסקים).
    // אפס-הטבעה — כל-הדרך העברות-של-מלאי-טבעי; התקרות-חיות-במצב (ריסטארט-לא-מאפס).
    // דחייה-כלשהי בגרעין (insufficient) = ניסיון-חוזר-בחלון-הבא — כנות, לא-התעקשות.
    for (const ms of MICRO_SEED) {
      const fleetUsed = microSeedCounts(st, ms.asset);
      const fleetWant = soldiers.reduce((s, sol) => s + Math.max(0, ms.perSoldier - avail(st, sol, ms.asset)), 0);
      if (fleetWant <= 0) continue; // כולם מזוינים — הקו-שותק-בכנות
      // שלב-א: השלמת-הארנה מהאוצר — רק-עד-תקרת-החיים ורק-את-החסר-האמיתי
      const tranche = Math.min(fleetWant, ms.fleetCap - fleetUsed);
      if (tranche > 0 && avail(st, "arena", ms.asset) < tranche && avail(st, "treasury", ms.asset) >= tranche) {
        pushOp({ type: "transfer", issuer: "treasury", nonce: `microseed-a-${ms.asset}-h${st.height}`, to: "arena", asset: ms.asset, amount: tranche });
      }
      // שלב-ב: ארנה→חיילים — רק-עודף-אמיתי; הספירה-החיה מנכה-כל-העברה-בתור
      let arenaSpare = avail(st, "arena", ms.asset);
      for (const sol of soldiers) {
        const have = avail(st, sol, ms.asset);
        if (have >= ms.perSoldier) continue;
        const want = Math.min(ms.perSoldier - have, ms.perSoldierCap, arenaSpare);
        if (want < RAIL_DUST_MU) continue; // אבק — כנות-מלאה
        const used = microSeedCounts(st, ms.asset) + want;
        if (used > ms.fleetCap) continue; // תקרת-החיים-מלאה — אין-מקור-נסתר
        st.microSeedCounts![ms.asset] = used;
        arenaSpare -= want;
        pushOp({ type: "transfer", issuer: "arena", nonce: `microseed-s-${ms.asset}-h${st.height}-${sol}`, to: sol, asset: ms.asset, amount: want });
      }
    }

    // ── IGNITION-R1 · שורות-אספקה + בריכות-סטייבל (2026-10-13 — איחוד-עם-T24) ──
    // דרישת-הבעלים: "להפוך את הדקס לכלי ריבוני עובד — הרבה ווליום, עוד צמדים
    // מול סטייבל, נזילות אמת". הכל-ממלאי-קיים (אפס-הטבעה), תקרות-חיים-במצב
    // (דפוס Roast-64 — ריסטארט לא מאפס). משלים-את-MICRO_SEED (ENERGY-רק-כאן +
    // קו-בוטים + ניסיון-pool_open-על-העוגן).
    {
      const IGN: Array<{ asset: Asset; key: "wsbd" | "phive" | "energy"; pair: string; tranche: number; life: number; poolUnits: number; soldierSeed: number }> = [
        { asset: "WSBD", key: "wsbd", pair: "USDS/WSBD", tranche: 40_000, life: 400_000, poolUnits: 120_000, soldierSeed: 20_000 }, // [T25] מסילת-SBD-אמת — עומק-ה-WSBD צומח-עם-הכסף-האמת
        { asset: "PHIVE", key: "phive", pair: "PHIVE/USDS", tranche: 800_000, life: 8_000_000, poolUnits: 6_000_000, soldierSeed: 400_000 }, // [T25-FORGE]
        { asset: "ENERGY", key: "energy", pair: "ENERGY/USDS", tranche: 600_000, life: 5_000_000, poolUnits: 8_000_000, soldierSeed: 300_000 }, // [T25-FORGE]
      ];
      const rcIg = rearmCounts(st);
      for (const g of IGN) {
        const held = rcIg[g.key] ?? 0;
        const poolAlive = !!st.pools[g.pair];
        const treasuryKeep = poolAlive ? 0 : g.poolUnits; // האוצר-שומר-זריעה-לבריכה-לפני-שהארנה-שואבת
        if (held < g.life) {
          const spare = Math.max(0, avail(st, "treasury", g.asset) - treasuryKeep);
          if (spare >= 1_000) {
            const amt = Math.min(g.tranche, g.life - held, spare);
            rcIg[g.key] = held + amt;
            pushOp({ type: "transfer", issuer: "treasury", nonce: `ign-th-${g.key}-h${st.height}`, to: "arena", asset: g.asset, amount: amt });
          }
        }
        // בריכה-ריבונית על-העוגן (pool_open-אוצר · LP→אוצר · פעם-אחת · mid=refPrice)
        // לקח-IGNITION-R1 (נמדד-חי): סולם-הערך ממחזר-את-מלאי-האוצר (מכר-את-ה-PHIVE/
        // ENERGY-של-האוצר להגן-על-סולם-SAOS — שימור-מלא, זה-תפקידו). לכן-הסניף-ממתין
        // בכנות-עד-שלאוצר-יש-מלאי-אמת-מעל-הזריעה — והשווקים-החדשים נסחרים-בספר
        // (חיילים+בוטים) בלי-לחכות-לבריכה.
        if (!poolAlive) {
          const ref = st.assets[g.asset]?.refPrice ?? 0;
          if (ref > 0) {
            // [T25 · ORIENT-FIX] הצד-א של הזוג-הקנוני נקבע-אלפביתית: USDS/WSBD → א'=USDS,
            // אבל PHIVE/USDS ו-ENERGY/USDS → א'=הנכס. בלי-התיקון amount/amountB היו
            // מתהפכים → בריכה במחיר 64-370× מהעוגן (ונשאבת-מיד-ע"י-הארביטרז').
            const usdsSide = Math.max(100, Math.floor((g.poolUnits * ref) / 1000));
            const canonFirst = g.pair.split("/")[0];
            const assetFirst = canonFirst === g.asset;
            const amtA = assetFirst ? g.poolUnits : usdsSide;
            const amtB = assetFirst ? usdsSide : g.poolUnits;
            if (avail(st, "treasury", "USDS") < usdsSide && avail(st, "arena", "USDS") > 12_000_000) {
              pushOp({ type: "transfer", issuer: "arena", nonce: `ign-ua-${g.key}-h${st.height}`, to: "treasury", asset: "USDS", amount: usdsSide });
            }
            if (avail(st, "treasury", "USDS") >= usdsSide && avail(st, "treasury", g.asset) >= g.poolUnits) {
              pushOp({ type: "pool_open", issuer: "treasury", nonce: `ign-pool-${g.key}-h${st.height}`, pair: g.pair, amount: amtA, amountB: amtB });
            }
          }
        }
      }
      // ארנה→חיילים — יעדי-ציטוט-פר-נכס-חדש (אותו-חוק של SETTLE-17 ל-WSTEEM)
      for (const g of IGN) {
        if (g.soldierSeed <= 0) continue;
        for (const soldier of soldiers) {
          const scIg = soldierSeedCounts(st, soldier);
          const cur = scIg[g.key] ?? 0;
          const free = avail(st, soldier, g.asset);
          if (free >= g.soldierSeed || cur >= g.soldierSeed) continue;
          const arenaSpare = Math.max(0, avail(st, "arena", g.asset) - Math.floor(g.tranche / 4));
          const amt = Math.min(g.soldierSeed - Math.max(free, cur), g.soldierSeed - cur, arenaSpare);
          if (amt >= 500) {
            scIg[g.key] = cur + amt;
            pushOp({ type: "transfer", issuer: "arena", nonce: `ign-ss-${g.key}-${soldier}-h${st.height}`, to: soldier, asset: g.asset, amount: amt });
          }
        }
      }
    }
  }

  // קצבת-בוטים: כל-24 טיקים ממלאים-מחדש סוחרי-רעש שנדלדלו — בלי-זה הזרימה-
  // החופשית מתה (אפס-מילויים → אפס-גילוי-מחיר). **המפעיל-הנדיב: הארנה**
  // (המייצבת-עם-המלאי-העמוק) — לא-האוצר: לאוצר יש רק-את-קיזוז-העמלות,
  // והקצבה-ממנו-רוקנה-אותו-עד-ריק (ממצא-חי 2026-09). מדידה-על-**avail** (כולל
  // נעילות-ספר) ולא-יתרה-גולמית — פקודות-מנוחות של-בוט לא-ימנעו-מימון-חדש.
  if (params.noise && tick % 24 === 0) {
    // R28 · bot-e = סוכן-ההתעמלות (ראה exerciseTick) — מקבל את אותה קצבת-בוטים
    // מהארנה ואותן תקרות-חיים (2.4M USDS / 1.2M SAOS): סוחר-רעש לכל דבר, רק
    // שהזרימה שלו עוברת דרך הפרימיטיבים הציבוריים במקום ישר לספר.
    for (const bot of ["bot-a", "bot-b", "bot-c", "bot-e"]) {
      const caps = botSeedCounts(st, bot);
      if (avail(st, bot, "USDS") < 100_000 && caps.usds < BOT_SEED_CAP_USDS) {
        caps.usds += 400_000;
        pushOp({ type: "transfer", issuer: "arena", nonce: `botseed-uh${st.height}-${bot}`, to: bot, asset: "USDS", amount: 400_000 });
      }
      const caps2 = botSeedCounts(st, bot);
      if (avail(st, bot, "SAOS") < 100_000 && caps2.saos < BOT_SEED_CAP_SAOS) {
        caps2.saos += 200_000;
        pushOp({ type: "transfer", issuer: "arena", nonce: `botseed-sh${st.height}-${bot}`, to: bot, asset: "SAOS", amount: 200_000 });
      }
      // IGNITION-R1: מלאי-מכירה-חדש לבוטים על-הזוגות-החדשים — קצבה-קטנה-אחת
      // (תקרה-מצטברת-במצב; אפס-הטבעה — רק-מהעודף-האמת-של-הארנה-מעל-רצפת-1k)
      for (const [keyIg, assetIg, capIg] of [["wsbd", "WSBD", 800], ["phive", "PHIVE", 3_000]] as const) {
        const capsIg = botSeedCounts(st, bot);
        if (avail(st, bot, assetIg) < 200 && (capsIg[keyIg] ?? 0) < capIg) {
          const amtIg = Math.min(capIg - (capsIg[keyIg] ?? 0), Math.max(0, avail(st, "arena", assetIg) - 1_000));
          if (amtIg >= 200) {
            capsIg[keyIg] = (capsIg[keyIg] ?? 0) + amtIg;
            pushOp({ type: "transfer", issuer: "arena", nonce: `ign-bs-${keyIg}-${bot}-h${st.height}`, to: bot, asset: assetIg, amount: amtIg });
          }
        }
      }
    }
  }

  for (const [mIdx, m] of MARKETS.entries()) {
    const fair = fairPrice(st, m.base, m.quote);
    if (fair <= 0) continue;

    /* FIX(R45 · inflight-escrow): חשבון-נעילות-בטיסה-פר-טיק — נמדד-חי בהוכחת-R45:
     * order(soldier-1):insufficient-escrow חוזר-ונשנה. שורש: כל-הפקודות-של-אותו-
     * סוכן באותו-טיק נבדקות-מול-אותו-avail לא-מעודכן (הנעילה נרשמת-רק-בביצוע-
     * הבלוק) ← הפקודה-השלישית-והלאה נדחות. עכשיו: כל-דחיפה מנכה-מראש-מספר-ספר
     * מקומי — אותו-עיקרון-כמו-fuelBudget של-העירוי, על-המאזן-החי. */
    const inflight = new Map<string, number>();
    const inflightAvail = (who: string, asset: string): number =>
      avail(st, who, asset) - (inflight.get(`${who}:${asset}`) ?? 0);
    const inflightAdd = (who: string, asset: string, mu: number): void => {
      inflight.set(`${who}:${asset}`, (inflight.get(`${who}:${asset}`) ?? 0) + mu);
    }

    if (params.enabled) {
      for (const agent of makers) {
        // FIX(SETTLE-7): שער-הפסד — מייקר-מתחת-לרצפת-הון לא מציב-פקודות-חדשות (רק-מנקה)
        const starving = soldierEquity(st, agent, fair) < SOLDIER_EQUITY_FLOOR;
        const sk = skewShiftBps(st, agent, m.base, params);
        // ריקוט: בטל ציטוטים שסטו מעל הרף
        const mine = st.orders.filter((o) => o.live && o.owner === agent && o.base === m.base && o.quote === m.quote);
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
            if (o.live) submit(rt, st, agent, { type: "cancel", orderId: o.id }, pushOp);
          } else {
            desired.delete(o.price);
          }
        }
        // הצב-חסרים — רק-אם-הערבות בכדאיות (מניעת-הצפת-ממפול מדחיות-חוזרות)
        // ורק-אם-החייל מעל-רצפת-ההון (שער-הפסד, SETTLE-7)
        if (!starving) {
        let lvl = 1;
        for (const [, d] of desired) {
          const fullSize = Math.floor(params.sizeMu * (1 + (lvl - 1) * 0.5));
          lvl++;
          const lockAsset = d.side === "sell" ? m.base : m.quote;
          // ── SETTLE-17-b (inventory-adaptive quotes · T15 2026-10-11) ──
          // הממצא-החי (truth-gate 38178302247, agent-verify 48/51): שוק USDS/WSTEEM
          // חד-צדדי-מחדש — bestAsk=0 בציבור. שורש: גודל-הציטוט קבוע (sizeMu=80Kµ×רמה)
          // בזמן-שהחיילים מחזיקים <80Kµ WSTEEM — כל-הצבת-אסק מדלגת בכנות-מלאי
          // (mm.ts:142-148 תיעד את אותו-שורש ב-SETTLE-17 המקורי), והשוק נשאר חד-צדדי
          // לנצח בזמן-שהחוק המתואר (A43: "לפחות-הצעת-מכירה-חיה-אחת") נשבר-בפועל.
          // התיקון: גודל-מסתגל — החייל מצטט את מה שהוא יכול לנעול באמת (עד-הגודל
          // המלא, מעל-רצפת-אבק RAIL_DUST_MU). אפס-הטבעה, אפס-זיוף: הצעה-קטנה-ממלאי
          // אמת היא הצעה-חיה-אמת; משמעת-הערבות/הספרד/הריקוט כולן נשמרות לאיתן.
          // הכיוון-השני מרוויח-אותו-ריפוי (bestBid=0 על SAOS/USDS נמדד-חי באותו-סנפּשׁוט).
          const budget = inflightAvail(agent, lockAsset);
          const fullLock = d.side === "sell" ? fullSize : notional(d.px, fullSize);
          let size = fullSize;
          if (budget < fullLock) {
            // מסתגל: הגודל-הכנה-המרבי שאפשר לנעול מהמלאי-האמת (מעל-רצפת-האבק)
            size = d.side === "sell"
              ? budget
              : Math.floor((budget * 1000) / Math.max(1, d.px)); // הופך-notional
            if (size < RAIL_DUST_MU) continue; // אבק — כנות-מלאה, לא ציטוט-רעש
          }
          const lockMu = d.side === "sell" ? size : notional(d.px, size);
          // FIX(R45 · inflight-escrow): הבדיקה מנכה-את-הנעילות-שכבר-נדחפה-בטיק-הזה —
          // סדרת-פקודות-של-אותו-חייל לא-מתחרה-עוד-על-אותה-יתרה-מתה.
          if (lockMu <= 0 || lockMu > budget) continue;
          inflightAdd(agent, lockAsset, lockMu);
          submit(rt, st, agent, {
            type: "order", base: m.base, quote: m.quote, side: d.side,
            price: d.px, amount: size,
          }, pushOp);
        }
        }
      }
    }

    // טייק-מסתובב: רק-אם-השוליים מכסים עמלה+רווח-מינ'
    if (params.enabled) {
      // טייק-מסתובב על סוכני-המערכת (החיילים-הסינתטיים סולקו — OWNER-MANDATE 2026-10-17)
      const takers = ["arena", "bot-a", "bot-b", "bot-c", "bot-e"];
      const taker = takers[tick % takers.length]!;
      const bids = sortBook(st, m.base, m.quote, "buy");
      const asks = sortBook(st, m.base, m.quote, "sell");
      const bestAsk = asks.find((o) => o.owner !== taker);
      const bestBid = bids.find((o) => o.owner !== taker);
      if (bestAsk) {
        // FIX(Roast-64 · phantom-fee): הפחתת-FEE_BPS נמחקה — הספר לא גובה עמלת-taker
        // (matchBook מעביר ערך-מלא); השער-מגן מול-סיכון-מלאי-ובכיוון-הפייר, בלי
        // להציג-עמלה-שאינה-קיימת כ"רווחיות-וודאית".
        const edgeBps = Math.floor(((fair - bestAsk.price) / bestAsk.price) * 10_000);
        if (edgeBps >= params.minEdgeBps) {
          // FIX(R45 · inflight-escrow): הטייק-קונה-משלם-ציטוט — נחתך-לכיסוי-הבטיסה
          // (יתרה-חיה פחות-הנעילות-שנדחפה-בטיק-הזה, ×0.9 שוליים-בטיחות).
          const canQuote = Math.floor((inflightAvail(taker, m.quote) * 9) / 10);
          const maxQty = bestAsk.price > 0 ? Math.floor(canQuote / bestAsk.price) : 0;
          const qty = Math.min(bestAsk.amount - bestAsk.filled, 600_000, maxQty); // IGNITION-R1: טייק-חיילים ×4
          if (qty > 0) {
            inflightAdd(taker, m.quote, bestAsk.price * qty);
            submit(rt, st, taker, { type: "fill", base: m.base, quote: m.quote, side: "buy", amount: qty, market: true }, pushOp);
          }
        }
      }
      if (bestBid) {
        const edgeBps = Math.floor(((bestBid.price - fair) / fair) * 10_000);
        if (edgeBps >= params.minEdgeBps) {
          // FIX(R45 · inflight-escrow): הטייק-מוכר-מוסר-בסיס — נחתך-לכיסוי-הבטיסה.
          const maxQty = Math.floor((inflightAvail(taker, m.base) * 9) / 10);
          const qty = Math.min(bestBid.amount - bestBid.filled, 600_000, maxQty); // IGNITION-R1
          if (qty > 0) {
            inflightAdd(taker, m.base, qty);
            submit(rt, st, taker, { type: "fill", base: m.base, quote: m.quote, side: "sell", amount: qty, market: true }, pushOp);
          }
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
      if (roll < 4) { // IGNITION-R1: טייקים 30%→40% — יותר-חציות-אמת (היה roll<3)
        // טייק-שוק של בוט — יוצר מילויים וגילוי-מחיר אמיתי.
        // FIX(SETTLE-14): הצד היה מוטה-מבנית (roll===0 → קנייה; 1,2 → מכירה =
        // 1/3 קנייה 2/3 מכירה). זרימה-חד-צדדית אינה "גילוי-מחיר" — היא מניפולציה
        // בתוך-הסימולציה. עכשיו: זוגיות-טיק = איזון-מושלם קנייה/מכירה.
        const side: "buy" | "sell" = tick % 2 === 0 ? "buy" : "sell";
        const px = side === "buy" ? (sortBook(st, m.base, m.quote, "sell")[0]?.price ?? fair) : (sortBook(st, m.base, m.quote, "buy")[0]?.price ?? fair);
        // FIX(Roast-64 · noise-sell-units): נוסחת-הקנייה הועתקה למכירה — למכירה
 // assetHave=בסיס ואסור-לחלק במחיר (חילקו בסיס במחיר = כמות-0.04%-מהאמת →
 // זרימת-המכירות-הייתה-אפסית וה"איזון-מושלם" היה-שקר). למכירה: הבסיס-עצמו.
        const affordable = px > 0
          ? (side === "buy"
              ? Math.floor((inflightAvail(bot, m.quote) * 9) / (px * 10))
              : Math.floor((inflightAvail(bot, m.base) * 9) / 10))
          : 0;
        const qty = Math.min(400_000 + (tick % 5) * 200_000, affordable); // IGNITION-R1: טייק-בוט ×8 (היה 25k–65k; חתוך-לכיסוי-האמת בכל-מקרה)
        if (qty > 0) {
          if (side === "buy") inflightAdd(bot, m.quote, Math.ceil((px * qty) / 10) * 10);
          else inflightAdd(bot, m.base, qty);
          submit(rt, st, bot, { type: "fill", base: m.base, quote: m.quote, side, amount: qty, market: true }, pushOp);
        }
      } else if (roll < 6) {
        // היגיינת-פקודות לבוטים: בוט מחזיק עד-פקודת-רעש אחת פר-זוג — ישנות מבוטלות.
        // בלי-זה הבוטים צוברים פקודות-מנוחה שנועלות-את-כל-המלאי עד order-cap והזרימה מתה.
        for (const o of st.orders) {
          if (o.live && o.owner === bot && o.base === m.base && o.quote === m.quote) {
            submit(rt, st, bot, { type: "cancel", orderId: o.id }, pushOp);
          }
        }
        const px = Math.floor((fair * (10_000 + (roll === 3 ? 40 : -40))) / 10_000);
        const side: "buy" | "sell" = roll === 4 ? "sell" : "buy";
        // FIX(SETTLE-17-b/c · maker-ask-role · T15 2026-10-11) — שורש-העיצוב-שנמדד:
        // בגלגולי-הלימיט של-בוטי-הרעש לא-היה-תפקיד-של-מכירה-מנוחה: גלגול-3 קנייה-
        // אגרסיבית (fair+40bps), גלגול-4 "מכירה" ב-fair−40bps = חוצה-בידים-מיד
        // (לעולם לא נחה כאסק-מנוח), גלגול-5 קנייה-מנוחה. צד-האסקים של-הספר היה
        // יתום-מבני — כל-אסק חי בא מהחיילים (שהיו ריקים-ממלאי; SETTLE-17 המקורי).
        // הריפוי: גלגול-4 נהיה תפקיד-המכירה-המנוחה (maker ask) — מחיר fair+minGap
        // (משמעת-החיילים), והמוכר נגזר-מהמלאי-האמת: מי-שמחזיק-בסיס ≥ אבק מציב
        // אסק-מנוח מהמלאי-שלו-עצמו (מימוש-דטרמיניסטי: יתרה-מרבית, שובר-שוויון-
        // שם). הגלגל-עצמו (קצב, כיוון, איזון-זוגיות SETTLE-14) נשמר-במדויק;
        // המכירות-האגרסיביות ממשיכות-דרך-מילויי-השוק (גלגול-1,2). אפס-הטבעה,
        // ערבות-אמת מאיזון-המוחזק-עצמו, הגרעין אוכף.
        const makerAskPx = fair + Math.max(1, Math.floor((fair * 5) / 10_000));
        const nominal = 20_000 + (tick % 7) * 8_000;
        let seller = bot;
        let sellPx = px;
        if (side === "sell" && inflightAvail(bot, m.base) < RAIL_DUST_MU) {
          const holders = ["bot-a", "bot-b", "bot-c"]
            .filter((b) => inflightAvail(b, m.base) >= RAIL_DUST_MU)
            .sort((a, b) => (inflightAvail(b, m.base) - inflightAvail(a, m.base)) || a.localeCompare(b));
          if (holders[0]) {
            seller = holders[0]; sellPx = makerAskPx;
            // היגיינה-למוכר-הנגזר: פקודת-רעש-אחת-פר-זוג (אותו-חוק של הבוט-הפועל) —
            // האסק-המנוח-הישן שלו מבוטל לפני ההצבה (החלפה, לא ערימה)
            for (const o of st.orders) {
              if (o.live && o.owner === seller && o.base === m.base && o.quote === m.quote) {
                submit(rt, st, seller, { type: "cancel", orderId: o.id }, pushOp);
              }
            }
          }
        } else if (side === "sell") {
          sellPx = makerAskPx; // התפקיד-החדש: אסק-מנוח-מעל-הפייר (לא-חוצה-בידים)
        }
        const haveNow = inflightAvail(seller, side === "buy" ? m.quote : m.base);
        const amt = haveNow >= (side === "buy" ? px * nominal : nominal)
          ? nominal
          : (side === "buy"
              ? Math.floor(haveNow / Math.max(1, px))
              : haveNow);
        if (amt >= RAIL_DUST_MU) {
        {
          const needMu = side === "buy" ? px * amt : amt; // קנייה: הצעת-ציטוט; מכירה: הבסיס-עצמו
          const haveMu = inflightAvail(seller, side === "buy" ? m.quote : m.base);
          if (needMu > 0 && haveMu >= needMu) {
            inflightAdd(seller, side === "buy" ? m.quote : m.base, needMu);
            submit(rt, st, seller, { type: "order", base: m.base, quote: m.quote, side, price: side === "sell" ? sellPx : px, amount: amt }, pushOp);
          }
        }
        } // סוף-שער-האבק (SETTLE-17-b)
      } else {
        const p = getPool(st, poolKey(m.base, m.quote));
        // R26 · בוטי-רעש לא-נוגעים-בבריכת-המסדרון: הזרימה-שלהם חד-צדדית-מבנית
        // (לבוטים אין WSTEEM — המכירות נדחות insufficient, הקניות נשארות → סחיפת-
        // הבריכה מעל-העוגן; נמדד-חי: 54→79µ ב-240-טיקים). בנכס-עיגון-1:1 גילוי-
        // המחיר הוא-מבחוץ (STEEM-אמת באורקל) — רעש-סימולטיבי על-המסדרון הוא-לא
        // גילוי-מחיר אלא-סתם-עיוות. האמת באה-מהדלת, מהמסילה-ומהסימון-המחדש.
        if (p && !RAIL_OWNED_POOLS.has(poolKey(m.base, m.quote))) {
          // FIX(SETTLE-14 → T25 · anchor-flow): הכיוון היה tick-parity — "איזון-מושלם"
          // רק-על-הנייר: הבוטים עשירים-USDS-ועניים-נכס (זריעה-חד-צדדית), הצד-הדל-זול
          // תמיד-השתחרר-במלואו והצד-הדחוס-נחתך-לאבק → משאבת-USDS-מבנית שהדחפה
          // בריכות 7-27× מהעוגן (נמדד-חי בסימולציית-T25). עתה: הכיוון נגזר-מסטיית
          // הבריכה-מעוגן-האורקל-שלה — נפח-הרעש עצמו הוא-מנוע-שימור-העוגן: יקר →
          // מכירת-הבסיס-פנימה, זול → קנייתו, על-העוגן → זוגיות-טיק (שטיפה-סרק-טהורה).
          const midM = poolMidFor(p, p.a, p.b);
          const refM = st.assets[p.a]?.refPrice ?? 0;
          const devM = refM > 0 && midM > 0 ? Math.floor(((midM - refM) * 10_000) / refM) : 0;
          const assetIn = (devM > 30 ? p.a : devM < -30 ? p.b : (tick % 2 === 0 ? p.a : p.b)) as Asset;
          // FIX(R45 · noise-pool-guard): סוואפ-הבריכה של בוט-הרעש נבדק-לכיסוי לפני-
          // השליחה — החור שהשאיר R44 (תיקן-לימיט-פקודות-בלבד). נמדד-חי:
          // pool_swap(bot-b):insufficient ב-world.json (h29305) — bot-b עם
          // {USDS:958, SAOS:1} המשיך-לדחוף-סוואפים-של-15k-35kµ כל-טיק מחדש.
          // כעת: הגודל נחתך-לכיסוי-האמת (×0.9), אפס-כיסוי → אין-סוואפ — הבוט
          // שותק-בכנות, כמו-סוחר-אמת-שאין-בכיסו-כלום.
          const haveMu = inflightAvail(bot, assetIn as Asset);
          // [T24 · VOLUME-DIAL × IGNITION-R1 — איחוד]: הדיאל-החזק-מנצח (×8) —
          // החלק-המרכזי בהצתת-הנפח; חתוך-לכיסוי-אמת (×0.9) נשאר; שני-הכיוונים
          // מאוזנים (SETTLE-14) נשאר. = עמלות-AMM-אמת 30bps על-נפח-גדול.
          const wantMu = 120_000 + (tick % 5) * 60_000;
          const amt = Math.min(wantMu, Math.floor((haveMu * 9) / 10));
          if (amt > 0) {
            inflightAdd(bot, assetIn as Asset, amt);
            submit(rt, st, bot, { type: "pool_swap", pair: poolKey(p.a, p.b), assetIn, amount: amt }, pushOp);
          }
        }
      }
    }

    // [T25 · THE-WASH] מכונת-השטיפה — הסוואפ-הכבד-הסדיר על בריכת-הזוג (אחרי-הרעש,
    // לפני-השומר): נפח = צף × מהירות. הצף מגיע-מהכבשן; הטיק מספק-את-המהירות.
    washTick(st, tick, mIdx, m.base, m.quote, pushOp);

    // ── SETTLE-17-c (treasury book-keeper of last resort · T15 2026-10-11) ──
    // הממקום: אחרי-זרימת-הרעש (ציטוט-שהוצב-לפני-הרעש נאכל-באותו-טיק — נמדד-חי
    // בהרצה-המקומית: האסק נבלע מיד במילוי-שוק של בוט ולא נשאר חי).
    // הממצא-החי (truth-gate 38178302247, agent-verify 48/51): הספר חד-צדדי
    // (USDS/WSTEEM bestAsk=0 · SAOS/USDS bestBid=0) בזמן-שכל-קווי-האספקה
    // החתומים מרוקנים-מבנית (rearmCounts.wsteem=1M תקרה-כלולה; חיילים ≤2µ
    // WSTEEM — מתחת-לכל-רצפת-ציטוט; ה-POL של-האוצר נעול-בחוק — treasury-lp-locked).
    // החוק-המתואר (A43: "השוק-דו-צדדי — לפחות-הצעת-מכירה חיה-אחת; מחלת-
    // החד-צדדיות לא חוזרת בשקט") חייב-להיאכף-בפועל.
    // הריפוי, אפס-הטבעה: כשצד-בספר ריק ולאוצר יש מלאי-חופשי-אמת — האוצר מציב
    // ציטוט-חי **אחד** ב-fair±minGap, בגודל-המלאי-האמת (רצפת-אבק RAIL_DUST_MU,
    // תקרה params.sizeMu). חימוש-מחדש (re-arm): כשאין מלאי-חופשי אבל יש STEEM
    // טבעי-עצל באוצר — עטיפת-SETTLE-18 הקיימת (1:1 כנה, הגיבוי נרשם ב-backing,
    // הגרעין אוכף מלאי-אמת), פרוסה-חסומה ≤20Kµ פעם-ב-16-טיק — בדיוק-הדפוס
    // של קו-ה-rearm, מנותב לשומר-הסף. משמעות-ערבות/ספרד זהות-לחיילים.
    // משמעת-ריקוט: הציטוט נשאר-מנוח עד שהפייר זז מעל הרף. עמידה-מן-הצד: ברגע
    // שמישהו-אחר מספק-את-הצד — השומר מבטל-את-ציטוטו. fail-closed: אין-מלאי
    // ואין-מה לעטוף → אין-ציטוט (עומק-מזויף = אסור). אפס-מקור-נסתר, Σשומר.
    if (params.enabled) {
      const minGapK = Math.max(1, Math.floor((fair * 5) / 10_000)); // ≥5bps סביב-הפייר
      const keeperOrders = st.orders.filter((o) => o.live && o.owner === "treasury" && o.base === m.base && o.quote === m.quote);
      const keeperAsk = keeperOrders.find((o) => o.side === "sell");
      const keeperBid = keeperOrders.find((o) => o.side === "buy");
      const bookAsks = sortBook(st, m.base, m.quote, "sell");
      const bookBids = sortBook(st, m.base, m.quote, "buy");
      const stillGoodK = (o: { price: number }, px: number): boolean =>
        Math.abs(((fair - o.price) / fair) * 10_000) <= params.requoteBps + params.spreadBps;
      // (א) צד-האסקים
      if (bookAsks.length === 0) {
        let tw = inflightAvail("treasury", m.base);
        // re-arm — עטיפת-SETTLE-18 של המלאי-הטבעי-העצל (חסום: ≤20Kµ/פרוסה, 16-טיק)
        if (tw < RAIL_DUST_MU && tick % 16 === 0) {
          const natSteem = avail(st, "treasury", "STEEM");
          if (m.base === "WSTEEM" && natSteem > 0) {
            pushOp({ type: "wrap_mint", issuer: "treasury", nonce: `keeper-rearm-h${st.height}`, wrapAsset: "WSTEEM", amount: Math.min(natSteem, 20_000) });
          }
        }
        // מחזור-מלאי — נמדד-חי ונפסל: מילוי-שוק-קנייה חוצה-אסקים (הצד-שריק —
        // זה-התנאי) → no-cross לנצח. המלאי-הכנה-היחיד: עטיפת-ה-SETTLE-18 למעלה
        // (נמדד-חי: backing 982110→1000000 = +17,890µ המלאי-הטבעי כולו, מדויק).
        const px = fair + minGapK;
        if (keeperAsk && !stillGoodK(keeperAsk, px)) {
          submit(rt, st, "treasury", { type: "cancel", orderId: keeperAsk.id }, pushOp);
        } else if (!keeperAsk && tw >= RAIL_DUST_MU) {
          const size = Math.min(tw, params.sizeMu);
          inflightAdd("treasury", m.base, size);
          submit(rt, st, "treasury", { type: "order", base: m.base, quote: m.quote, side: "sell", price: px, amount: size }, pushOp);
        }
      } else if (keeperAsk) {
        submit(rt, st, "treasury", { type: "cancel", orderId: keeperAsk.id }, pushOp); // עמידה-מן-הצד
      }
      // (ב) צד-הבידים
      if (bookBids.length === 0) {
        const tq = inflightAvail("treasury", m.quote);
        const px = fair - minGapK;
        if (keeperBid && !stillGoodK(keeperBid, px)) {
          submit(rt, st, "treasury", { type: "cancel", orderId: keeperBid.id }, pushOp);
        } else if (!keeperBid && tq >= RAIL_DUST_MU) {
          const size = Math.min(Math.floor((tq * 1000) / Math.max(1, px)), params.sizeMu);
          const lockMu = notional(px, size);
          if (size >= RAIL_DUST_MU && lockMu > 0 && lockMu <= tq) {
            inflightAdd("treasury", m.quote, lockMu);
            submit(rt, st, "treasury", { type: "order", base: m.base, quote: m.quote, side: "buy", price: px, amount: size }, pushOp);
          }
        }
      } else if (keeperBid) {
        submit(rt, st, "treasury", { type: "cancel", orderId: keeperBid.id }, pushOp); // עמידה-מן-הצד
      }
    }
  }

  // R28 · THE-EXERCISE: הדלקת הפרימיטיבים הציבוריים הרדומים (CoW/DCA/טריגר) —
  // אחרי ה-MARKETS, לפני סוף הטיק. הסוכן פועל רק כשזרימת-הרעש חיה (params.noise):
  // הוא חלק מאותה כלכלה סימולטיבית, לא מנגנון-בחן נפרד.
  if (params.noise) exerciseTick(rt, st, tick, pushOp);
}

/* ── R28 · THE-EXERCISE: הדלקת הפרימיטיבים הציבוריים הרדומים ──────────────
 * ממצא-כנות R28 (נמדד בקוד, לא בהצהרה): שלושת הפרימיטיבים הציבוריים — CoW,
 * DCA וטריגרים — נבנו, עברו תיקוני-רוסט עמוקים (R16/R17/Roast-63/64/65)…
 * ומעולם לא קיבלו תנועה: אף סוכן לא מציב cow_order (grep: אפס מקורות מלבד
 * ה-API הציבורי), אף תוכנית-DCA לא נפתחה, אף טריגר לא ננעל. הטיקים רצים
 * בכל בלוק (chain.ts · dcaTick+trigTick+protoRevTick+cowSettle) על תורים
 * ריקים: "קיים" בלי "חי" — בדיוק סוג ההצהרה-למחצה שהוצאנו מהמערכת.
 * הטיפול מדידתי, לא סטטיסטי: סוכן-ההתעמלות bot-e מפעיל את שלושתם בקצב
 * קבוע-ודטרמיניסטי, בכסף-אמת-שלו (קצבת-הבוטים ועירוי-הדלק הקיימים),
 * עם חילוף-תפקידים מול הארנה (הכיסים העמוקים) כדי שהמלאי ממוחזר ולא מתרוקן:
 *   · CoW כל 40 טיקים: זוג פקודות הפוכות משני בעלים שונים (בעלים אחד —
 *     ניטרול-החפיפה-העצמית R17-b·H1 היה מבטל את ההתאמה), גבולות ±0.3%
 *     סביב הפייר, הצד-השני הארנה — הסליקה במחיר-האחיד ≈ הפייר (אפס זיהום-אורקל), והעודף
 *     ≈ 0.6% מהנומינל נשאר אצל שני הצדדים ונמדד ב-cowStats.surplusMu.
 *   · DCA כל 480 טיקים: תוכנית 3-פרוסות USDS→SAOS (12kµ/פרוסה, כל-40-בלוקים)
 *     — ורק אם אין לסוכן תוכנית פעילה (התור נשאר צנוע והפרוסות אמת).
 *   · טריגר כל 480 טיקים: מכירה/קנייה לסירוגין, 30bps נגד הכיוון — נורה
 *     בדיפ/בראלי, או פג-תוקף בכנות מתועדת; שני הכיוונים הם מדידה-חיה.
 * הכל מ-`tick` והמצב בלבד: אפס-רנדומיות · אפס-שעון — ריפליי-אמת.
 * ההצבה מוגנת-יתרה (avail ×1) לפני-כל-שליחה: אין דחיות-רעש כתוצר-לוואי. */
const EXERCISE_PAIR_TICK = 40;
const EXERCISE_PLAN_TICK = 480;
const EXERCISE_COW_AMT = 20_000;
const EXERCISE_DCA_PER_SLICE = 12_000;
const EXERCISE_DCA_SLICES = 3;
const EXERCISE_TRIG_AMT = 15_000;

export function exerciseTick(rt: Map<string, SoldierRT>, st: DexState, tick: number, pushOp: PushOp): void {
  const m = MARKETS[0]; // הזוג הריבוני SAOS/USDS
  const fair = fairPrice(st, m.base, m.quote);
  if (!(fair > 0)) return;

  // ── CoW: זוג הפוך משני בעלים, גבולות ±0.3% סביב הפייר ──
  // מדידת-מלאי R28 (בדיקת-ההוכחה המקומית): בוטי-הרעש רוקנו עידנים-עידנים
  // (SAOS=1µ — תקרות-הזריעה מוצו), החיילים חסרי-SAOS — הצד-השני היחיד עם
  // כיסים-עמוקים משני-הצדדים ועם התפקיד-הארכיטקטוני המתאים הוא הארנה —
  // "המפעיל-הנדיב" שמממן את הסימולציה מלכתחילה (קצבות, rearm, רצפות-עומק).
  // חילוף-הכיוונים שומר עליה בת-קיימא: מחזור-זוגי היא קונה SAOS, אי-זוגי
  // מוכרת — נטו-שטוח, המלאי ממוחזר בינה לבין סוכן-ההתעמלות ולא מתרוקן.
  if (tick % EXERCISE_PAIR_TICK === 12) {
    const cycle = Math.floor(tick / EXERCISE_PAIR_TICK);
    const botSells = cycle % 2 === 0;
    const seller = botSells ? "bot-e" : "arena";
    const buyer = botSells ? "arena" : "bot-e";
    const sellPx = Math.floor((fair * 9_970) / 10_000); // −0.3% מתחת לפייר
    const buyPx = Math.floor((fair * 10_030) / 10_000);  // +0.3% מעליו — חוצה
    const sellOk = avail(st, seller, m.base) >= EXERCISE_COW_AMT;
    const buyOk = avail(st, buyer, m.quote) >= notional(buyPx, EXERCISE_COW_AMT);
    if (sellPx > 0 && buyPx >= sellPx && sellOk && buyOk) {
      submit(rt, st, seller, { type: "cow_order", base: m.base, quote: m.quote, side: "sell", price: sellPx, amount: EXERCISE_COW_AMT }, pushOp);
      submit(rt, st, buyer, { type: "cow_order", base: m.base, quote: m.quote, side: "buy", price: buyPx, amount: EXERCISE_COW_AMT }, pushOp);
    }
  }

  // ── DCA: תוכנית קטנה, רק אם אין אחת פעילה לסוכן ──
  if (tick % EXERCISE_PLAN_TICK === 60) {
    const mineActive = Object.values(st.dca ?? {}).some((p) => p.owner === "bot-e" && p.remainingMu > 0);
    const cost = EXERCISE_DCA_PER_SLICE * EXERCISE_DCA_SLICES;
    if (!mineActive && avail(st, "bot-e", "USDS") >= cost) {
      submit(rt, st, "bot-e", { type: "dca_create", asset: "USDS", to: "SAOS", perSlice: EXERCISE_DCA_PER_SLICE, slicesMax: EXERCISE_DCA_SLICES, everyK: 40, minOutBps: 100 }, pushOp);
    }
  }

  // ── טריגר: כיוון מתחלף, 30bps נגד הפייר, תוקף 500 בלוקים ──
  if (tick % EXERCISE_PLAN_TICK === 300) {
    const planIdx = Math.floor(tick / EXERCISE_PLAN_TICK);
    const side: "sell" | "buy" = planIdx % 2 === 0 ? "sell" : "buy";
    const triggerPx = side === "sell"
      ? Math.floor((fair * 9_970) / 10_000)   // נורה אם המחיר יורד 0.3%
      : Math.floor((fair * 10_030) / 10_000);  // נורה אם המחיר עולה 0.3%
    if (triggerPx > 0) {
      if (side === "sell" && avail(st, "bot-e", m.base) >= EXERCISE_TRIG_AMT) {
        submit(rt, st, "bot-e", { type: "trig_order", base: m.base, quote: m.quote, side, triggerPx, limitPx: 0, amount: EXERCISE_TRIG_AMT, expiresH: st.height + 500 }, pushOp);
      } else if (side === "buy" && avail(st, "bot-e", m.quote) >= notional(triggerPx, EXERCISE_TRIG_AMT)) {
        submit(rt, st, "bot-e", { type: "trig_order", base: m.base, quote: m.quote, side, triggerPx, limitPx: 0, amount: EXERCISE_TRIG_AMT, expiresH: st.height + 500 }, pushOp);
      }
    }
  }
}
