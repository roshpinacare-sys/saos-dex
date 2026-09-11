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
import { LADDER_FUEL_FLOOR, MINT_FUEL_CAP, REFUEL_CAP, funderFor, poolKey, avail, notional } from "./kernel";
import { sortBook } from "./book";
import { poolMid, poolMidFor, getPool } from "./amm";
import { railTick, RAIL_OWNED_POOLS } from "./rail";

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
const BOT_SEED_CAP_USDS = 2_400_000;
const BOT_SEED_CAP_SAOS = 1_200_000;

/** ── THE-REARM (SETTLE-14 price-truth) ──
 * ממצא-חי: הארנה שרפה את כל-המלאי (8M SAOS + 20M USDS מג'נזיס) בלחימה-חד-צדדית
 * מול סולם-הערך-העולה — ומאז היא-ענייה (0 SAOS): כל-פעולות-הייצוב (מנעול-בריכה,
 * חגורת-סולם) נדחות-בשקט והשוק צף ללא-גרביטציה. זה-המנוע-האמיתי של "המחיר-מטפס".
 * הטיפול: חייל-אספקה — אוצר→ארנה העברה-טהורה (אפס-הטבעה, Σשומר), מנות-2M,
 * תקרה-מצטברת-לכל-חיי-התהליך (8M SAOS + 20M USDS = מלאי-ג'נזיס-אחד),
 * ורק-אם-לאוצר יש-באמת (אפס-דחיות-ספר). עם-הסולם-הסימטרי (keel) הלחימה
 * כבר-לא-חד-צדדית — המלאי החדש נשחק בשני-הכיוונים ומתוחזק. */
const REARM_TRANCHE_SAOS = 2_000_000;
const REARM_TRANCHE_USDS = 4_000_000;
const REARM_TRANCHE_WSTEEM = 1_000_000;
const REARM_LIFETIME_SAOS = 8_000_000;
const REARM_LIFETIME_USDS = 20_000_000;
const REARM_LIFETIME_WSTEEM = 1_000_000; // גבול-אמת: סטוק-ה-STEEM-הטבעי של-האוצר (אפס-הטבעה)
const REARM_FLOOR_SAOS = 600_000;   // מתחת-לזה הארנה לא יכולה למכור-לתוך-בידים
const REARM_FLOOR_USDS = 1_200_000; // ולא-לקנות-מאסקים
const REARM_FLOOR_WSTEEM = 300_000; // מנעול-בריכת-WSTEEM צריך בסיס-למכור-בו
// FIX(Roast-64 · phantom-lifetime-caps): היה const arenaRearm = {...} במודול —
// ריסטארט = תקרה-מלאה-חדשה. עכשיו: st.rearmCounts (חוזה-מעלה).
const rearmCounts = (st: DexState): { saos: number; usds: number; wsteem: number } =>
  (st.rearmCounts ??= { saos: 0, usds: 0, wsteem: 0 });
const botSeedCounts = (st: DexState, bot: string): { usds: number; saos: number } => {
  st.botSeedCounts ??= {};
  return (st.botSeedCounts[bot] ??= { usds: 0, saos: 0 });
};

type PushOp = (op: Op) => void;

/** FIX(Task 56 replay-storm): אחרי-טעינת-תמונת-מצב, st.nonces מכיל אלפי-נונסים
 * `a<N>` של-החיילים-מהריצות-הקודמות; RT-רץ-חדש התחיל מ-seq=0 והתנגש-בכולם
 * (replay-rejected המוני עד-שה-seq עובר-את-החלון). הפתרון: בעת-יצירת-RT לחייל,
 * נזרע-seq מעל-המקסימום-הקיים-בחלון-הנונסים — התנגשות-אפסית מהטיק-הראשון. */
function seedNonceSeq(st: DexState, soldier: string): number {
  let max = 0;
  const prefix = `${soldier}:a`;
  for (let i = st.nonces.length - 1; i >= 0 && i >= st.nonces.length - 2000; i--) {
    const n = st.nonces[i];
    if (n.startsWith(prefix)) {
      const v = parseInt(n.slice(prefix.length), 10);
      if (Number.isFinite(v) && v > max) max = v;
    }
  }
  return max;
}

function submit(rt: Map<string, SoldierRT>, st: DexState | null, soldier: string, op: Omit<Op, "issuer" | "nonce">, pushOp: PushOp): void {
  const r = rt.get(soldier) ?? { nonceSeq: st ? seedNonceSeq(st, soldier) : 0, fills: 0, takes: 0 };
  r.nonceSeq++;
  rt.set(soldier, r);
  pushOp({ ...op, issuer: soldier, nonce: `a${r.nonceSeq}` } as Op);
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
  // SETTLE-16 THE-MICRORAIL: הזוגות-בבעלות-המסילה (USDS/WSTEEM) נשלפים-מהנעילה-
  // הצפה — המסילה היא בעלת-המשמעת שלהם מול-עוגן-אמת (refPrice ≡ STEEM 1:1),
  // ולא מול-פייר-צף שהבוק-מדלל (ממצא-חי: הפייר-הצף גרר-את-הבריכה-בחזרה-מעלה
  // אחרי-ה-REPEG — מלחמת-סוכנים). מנוע-אחד-לעוגן.
  for (const mk of MARKETS) {
    const mkPair = poolKey(mk.base, mk.quote);
    if (RAIL_OWNED_POOLS.has(mkPair)) continue;
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
      const rIn = assetIn === p.a ? p.ra : p.rb;
      // גודל-לסגירת-חצי-פער (ליניאריזציה), מדורג: 10k..600k µ (היה 150k —
      // לא-היה-מסוגל לסגור פער של 25% והבריכה צפה מעל השוק) — ולא-יותר-מהזמין
      const halfGap = Math.floor(Math.abs(Math.floor((rIn * gapBps) / 10_000)) / 2);
      const size = Math.min(Math.max(halfGap, 10_000), 600_000, avail(st, "arena", assetIn));
      if (size >= 5_000) {
        pushOp({ type: "pool_swap", issuer: "arena", nonce: `pk-pool-${tick}-${mk.base}`, pair: poolKey(mk.base, mk.quote), assetIn, amount: size });
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
          pushOp({ type: "fill", issuer: "arena", nonce: `pk-band-${tick}`, base: m.base, quote: m.quote, side: "sell", amount: qty, market: true });
        }
      } else if (devBps < -400) {
        // זול-מדי → הארנה קונה-מהאסקים (מרימה-את-המגע)
        const px = ba > 0 ? ba : ref;
        const qty = Math.min(bandQty, Math.floor((avail(st, "arena", m.quote) * 900) / (px * 10)));
        if (qty >= 5_000) {
          pushOp({ type: "fill", issuer: "arena", nonce: `pk-band-${tick}`, base: m.base, quote: m.quote, side: "buy", amount: qty, market: true });
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
      pushOp({ type: "pool_add", issuer: "arena", nonce: `pk-floor-${tick}-${p.a}`, pair: poolKey(p.a, p.b), amount: addA });
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
  const soldiers = ["soldier-1", "soldier-2", "soldier-3", "soldier-4"];

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
    // THE-FOUNTAIN: אוצר-ריק? הטבעה-עצמית מגובה-עמלות-מדודות (profit-שהוכר +
    // feeMeter-מעל-רצפת-הסולם, מדוד-תקרה) — המסחר-עצמו מחזיר-את-הדלק-ששרף.
    // קודם-ההטבעה, אחר-כך העירוי.
    // FIX(roast-79): השער fuelAvail>20k היה-חסם-מבני — נמדד fuelAvail=18,618
    // (מתחת-ל-20k) = מזרקה-יבשה-לנצח בזמן-שלטרשורה-היה-גיבוי-אמת. השער הורד-ל-1k:
    // הגרעין (kernel mint_fuel) עדיין אוכף בעצמו את הגיבוי-הכפול, הרצפה (8k) והתקרה —
    // כאן-רק-החלטת-תזמון-כלכלית, לא-שכבת-אבטחה.
    const trCr = st.credits["treasury"] ?? 0;
    const fuelAvail = Math.max(0, st.treasuryProfit) + Math.max(0, Math.floor(((st.feeMeter ?? 0) - LADDER_FUEL_FLOOR) / 2));
    if (trCr < 10_000 && fuelAvail > 1_000) {
      const mint = Math.min(60_000, MINT_FUEL_CAP, fuelAvail);
      if (mint > 0) pushOp({ type: "mint_fuel", issuer: "treasury", nonce: `fountain-${tick}`, to: "treasury", amount: mint });
    }
    for (const ag of [...soldiers, "arena", "bot-a", "bot-b", "bot-c", "rail"]) {
      const c = st.credits[ag] ?? 0;
      // FIX(SETTLE-15 fuel-oscillation, נתפס-בלוג-הדחיות): סף-4k עם-חלון-16-טיק
      // איפשר לחיילים-פעילים להגיע-ל-0-בין-הבדיקות (נמדד: 23-27-דחיות/בלוק
      // insufficient-credits בשיא). סף-10k = מילוי-מוקדם-בחלון-אחד, אפס-דחיות;
      // זו-העברה-טהורה (אפס-הטבעה) — השריפה-הכוללת-לא-משתנה, רק-התזמון-מוקדם.
      if (c < 10_000) {
        const amt = Math.min(30_000 - c, REFUEL_CAP);
        if (amt <= 0) continue;
        // ממנה-מדורג (SETTLE-5/9 + roast-79 — funderFor אחד בגרעין): ארנה → בוטים →
 // אוצר (עמלות — THE-FOUNTAIN) → מפעיל-אנושי (קו-הגנה-האחרון).
        // FIX(SETTLE-7): הארנה עצמה נוספה-לרשימת-המקבלים — היא משלמת-גז על
        // pegkeeper וממנת-את-כולם ומעולם-לא-קיבלה-עירוי. אסור-שתממן-את-עצמה
        // (המנוע דוחה rTo==issuer) — לכן-הממנה-שלה הוא אוצר/מפעיל בלבד.
        // FIX(roast-79): exclude=ag לכל-המקבלים (לא-רק-ארנה) — עכשיו-שהבוטים בסולם,
        // בוט-שצריך-עירוי היה-יכול-להיבחר-כממנה-של-עצמו (דחיית-bad-refuel מיותרת).
        const funder = funderFor(st, amt, ag);
        pushOp({ type: "refuel", issuer: funder, nonce: `refuel-${tick}-${ag}`, to: ag, amount: amt });
      }
    }
  }

  // ── THE-REARM: חייל-אספקה-למייצב (למעלה — תיעוד-מלא) — קצב 16-טיק כמו-העירוי ──
  if (tick % 16 === 0) {
    const rc = rearmCounts(st);
    if (avail(st, "arena", "SAOS") < REARM_FLOOR_SAOS && rc.saos + REARM_TRANCHE_SAOS <= REARM_LIFETIME_SAOS) {
      const amt = Math.min(REARM_TRANCHE_SAOS, REARM_LIFETIME_SAOS - rc.saos);
      if (avail(st, "treasury", "SAOS") >= amt) {
        rc.saos += amt;
        pushOp({ type: "transfer", issuer: "treasury", nonce: `rearm-s${tick}`, to: "arena", asset: "SAOS", amount: amt });
      }
    }
    if (avail(st, "arena", "USDS") < REARM_FLOOR_USDS && rc.usds + REARM_TRANCHE_USDS <= REARM_LIFETIME_USDS) {
      const amt = Math.min(REARM_TRANCHE_USDS, REARM_LIFETIME_USDS - rc.usds);
      if (avail(st, "treasury", "USDS") >= amt) {
        rc.usds += amt;
        pushOp({ type: "transfer", issuer: "treasury", nonce: `rearm-u${tick}`, to: "arena", asset: "USDS", amount: amt });
      }
    }
    // קו-WSTEEM (SETTLE-14): אוצר-עוטף-את-ה-STEEM-הטבעי-שלו-עצמו (גיבוי 1:1 כנה —
    // אפס-הטבעה-רכה: הגיבוי נרשם ב-backing) ואז מעביר לארנה לשירות-המנעול.
    // העטיפה-וההעברה-בטיקים-נפרדים — הבדיקה-על-avail לפני-כל-דחיפה מסדרת-את-הסדר.
    if (avail(st, "arena", "WSTEEM") < REARM_FLOOR_WSTEEM && rc.wsteem + REARM_TRANCHE_WSTEEM <= REARM_LIFETIME_WSTEEM) {
      const amt = Math.min(REARM_TRANCHE_WSTEEM, REARM_LIFETIME_WSTEEM - rc.wsteem);
      const tw = avail(st, "treasury", "WSTEEM");
      if (tw < amt && avail(st, "treasury", "STEEM") >= amt - tw) {
        pushOp({ type: "wrap_mint", issuer: "treasury", nonce: `rearm-wrap-${tick}`, wrapAsset: "WSTEEM", amount: amt - tw });
      }
      if (avail(st, "treasury", "WSTEEM") >= amt) {
        rc.wsteem += amt;
        pushOp({ type: "transfer", issuer: "treasury", nonce: `rearm-w${tick}`, to: "arena", asset: "WSTEEM", amount: amt });
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
      const caps = botSeedCounts(st, bot);
      if (avail(st, bot, "USDS") < 100_000 && caps.usds < BOT_SEED_CAP_USDS) {
        caps.usds += 400_000;
        pushOp({ type: "transfer", issuer: "arena", nonce: `botseed-u${tick}-${bot}`, to: bot, asset: "USDS", amount: 400_000 });
      }
      const caps2 = botSeedCounts(st, bot);
      if (avail(st, bot, "SAOS") < 100_000 && caps2.saos < BOT_SEED_CAP_SAOS) {
        caps2.saos += 200_000;
        pushOp({ type: "transfer", issuer: "arena", nonce: `botseed-s${tick}-${bot}`, to: bot, asset: "SAOS", amount: 200_000 });
      }
    }
  }

  for (const m of MARKETS) {
    const fair = fairPrice(st, m.base, m.quote);
    if (fair <= 0) continue;

    if (params.enabled) {
      for (const soldier of soldiers) {
        // FIX(SETTLE-7): שער-הפסד — חייל-מתחת-לרצפת-הון לא מציב-פקודות-חדשות (רק-מנקה)
        const starving = soldierEquity(st, soldier, fair) < SOLDIER_EQUITY_FLOOR;
        const sk = skewShiftBps(st, soldier, m.base, params);
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
            if (o.live) submit(rt, st, soldier, { type: "cancel", orderId: o.id }, pushOp);
          } else {
            desired.delete(o.price);
          }
        }
        // הצב-חסרים — רק-אם-הערבות בכדאיות (מניעת-הצפת-ממפול מדחיות-חוזרות)
        // ורק-אם-החייל מעל-רצפת-ההון (שער-הפסד, SETTLE-7)
        if (!starving) {
        let lvl = 1;
        for (const [, d] of desired) {
          const size = Math.floor(params.sizeMu * (1 + (lvl - 1) * 0.5));
          lvl++;
          const lockAsset = d.side === "sell" ? m.base : m.quote;
          const lockMu = d.side === "sell" ? size : notional(d.px, size);
          if (lockMu <= 0 || avail(st, soldier, lockAsset) < lockMu) continue;
          submit(rt, st, soldier, {
            type: "order", base: m.base, quote: m.quote, side: d.side,
            price: d.px, amount: size,
          }, pushOp);
        }
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
        // FIX(Roast-64 · phantom-fee): הפחתת-FEE_BPS נמחקה — הספר לא גובה עמלת-taker
        // (matchBook מעביר ערך-מלא); השער-מגן מול-סיכון-מלאי-ובכיוון-הפייר, בלי
        // להציג-עמלה-שאינה-קיימת כ"רווחיות-וודאית".
        const edgeBps = Math.floor(((fair - bestAsk.price) / bestAsk.price) * 10_000);
        if (edgeBps >= params.minEdgeBps) {
          const qty = Math.min(bestAsk.amount - bestAsk.filled, 150_000);
          submit(rt, st, taker, { type: "fill", base: m.base, quote: m.quote, side: "buy", amount: qty, market: true }, pushOp);
        }
      }
      if (bestBid) {
        const edgeBps = Math.floor(((bestBid.price - fair) / fair) * 10_000);
        if (edgeBps >= params.minEdgeBps) {
          const qty = Math.min(bestBid.amount - bestBid.filled, 150_000);
          submit(rt, st, taker, { type: "fill", base: m.base, quote: m.quote, side: "sell", amount: qty, market: true }, pushOp);
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
              ? Math.floor((avail(st, bot, m.quote) * 9) / (px * 10))
              : Math.floor((avail(st, bot, m.base) * 9) / 10))
          : 0;
        const qty = Math.min(25_000 + (tick % 5) * 10_000, affordable);
        if (qty > 0) {
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
        const amt = 20_000 + (tick % 7) * 8_000;
        submit(rt, st, bot, { type: "order", base: m.base, quote: m.quote, side, price: px, amount: amt }, pushOp);
      } else {
        const p = getPool(st, poolKey(m.base, m.quote));
        if (p) {
          // FIX(SETTLE-14): הכיוון היה tick%3 — מוטה-מבנית 2:1 (על-הזוג-הריבוני:
          // 2/3 קניות-בסיס). זרימה-חד-צדדית קטנה-אך-מתמדת היא-הרמת-מחיר,
          // לא-גילוי-מחיר. זוגיות-טיק = איזון-מושלם שתי-הכיוונים.
          const assetIn = tick % 2 === 0 ? p.a : p.b;
          submit(rt, st, bot, { type: "pool_swap", pair: poolKey(p.a, p.b), assetIn, amount: 15_000 + (tick % 5) * 5_000 }, pushOp);
        }
      }
    }
  }
}
