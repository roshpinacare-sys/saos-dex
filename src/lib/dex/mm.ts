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
import { LADDER_FUEL_FLOOR, MINT_FUEL_CAP, REFUEL_CAP, FUEL_ASK_MIN, FUNDER_ORDER, funderAfford, poolKey, avail, notional } from "./kernel";
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
const soldierSeedCounts = (st: DexState, soldier: string): { wsteem: number } => {
  st.soldierSeedCounts ??= {};
  return (st.soldierSeedCounts[soldier] ??= { wsteem: 0 });
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
      const size = Math.min(Math.max(raw, 1), 600_000, avail(st, "arena", assetIn));
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
    // FIX(roast-81 · afford-race): ספר-תקציב-פר-טיק (ראה-למטה) — אפס-חפירה-מעבר-לרצפת.
    const fuelBudget = new Map<string, number>();
    // THE-FOUNTAIN: אוצר-ריק? הטבעה-עצמית מגובה-עמלות-מדודות (profit-שהוכר +
    // feeMeter-מעל-רצפת-הסולם, מדוד-תקרה) — המסחר-עצמו מחזיר-את-הדלק-ששרף.
    // קודם-ההטבעה, אחר-כך העירוי.
    // FIX(roast-79): השער fuelAvail>20k היה-חסם-מבני — נמדד fuelAvail=18,618
    // (מתחת-ל-20k) = מזרקה-יבשה-לנצח בזמן-שלטרשורה-היה-גיבוי-אמת. השער הורד-ל-1k:
    // הגרעין (kernel mint_fuel) עדיין אוכף בעצמו את הגיבוי-הכפול, הרצפה (8k) והתקרה —
    // כאן-רק-החלטת-תזמון-כלכלית, לא-שכבת-אבטחה.
    const trCr = st.credits["treasury"] ?? 0;
    // FIX(roast-81 · fountain-half-throttle): ה-/2 כאן היה-חנק-כפול-מעל-אכיפת-הגרעין
    // (mint_fuel כבר-אוכף-בעצמו רצפת-8k + תקרה). נמדד-חי: fuelAvail=577<שער-1,000
    // בזמן-שהגרעין-הרשה-1,154 → מזרקה-יבשה, האוצר-תקוע-על-8µ-גז, ו-ProtoRev —
    // מנוע-הארב-שרץ-כ-batch-אוצר — מת-מרעב-גז (revAux.rejections=5,181).
    // עכשיו: אותו-מדד-בדיוק-של-הגרעין — האכיפה-במקום-אחד.
    const fuelAvail = Math.max(0, st.treasuryProfit) + Math.max(0, (st.feeMeter ?? 0) - LADDER_FUEL_FLOOR);
    if (trCr < 10_000 && fuelAvail > 1_000) {
      const mint = Math.min(60_000, MINT_FUEL_CAP, fuelAvail);
      if (mint > 0) pushOp({ type: "mint_fuel", issuer: "treasury", nonce: `fountain-h${st.height}`, to: "treasury", amount: mint });
    }
    for (const ag of [...soldiers, "arena", "bot-a", "bot-b", "bot-c", "bot-e", "rail"]) {
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
        for (const f of FUNDER_ORDER) {
          if (f === ag) continue;
          const afford = funderAfford(st, f) - (fuelBudget.get(f) ?? 0);
          if (afford >= Math.min(need, FUEL_ASK_MIN)) { funder = f; amt = Math.min(need, afford); break; }
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
    if (avail(st, "arena", "SAOS") < REARM_FLOOR_SAOS && rc.saos + REARM_TRANCHE_SAOS <= REARM_LIFETIME_SAOS) {
      const amt = Math.min(REARM_TRANCHE_SAOS, REARM_LIFETIME_SAOS - rc.saos);
      if (avail(st, "treasury", "SAOS") >= amt) {
        rc.saos += amt;
        pushOp({ type: "transfer", issuer: "treasury", nonce: `rearm-sh${st.height}`, to: "arena", asset: "SAOS", amount: amt });
      }
    }
    if (avail(st, "arena", "USDS") < REARM_FLOOR_USDS && rc.usds + REARM_TRANCHE_USDS <= REARM_LIFETIME_USDS) {
      const amt = Math.min(REARM_TRANCHE_USDS, REARM_LIFETIME_USDS - rc.usds);
      if (avail(st, "treasury", "USDS") >= amt) {
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
    }
  }

  for (const m of MARKETS) {
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
          // FIX(R45 · inflight-escrow): הבדיקה מנכה-את-הנעילות-שכבר-נדחפה-בטיק-הזה —
          // סדרת-פקודות-של-אותו-חייל לא-מתחרה-עוד-על-אותה-יתרה-מתה.
          if (lockMu <= 0 || inflightAvail(soldier, lockAsset) < lockMu) continue;
          inflightAdd(soldier, lockAsset, lockMu);
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
          // FIX(R45 · inflight-escrow): הטייק-קונה-משלם-ציטוט — נחתך-לכיסוי-הבטיסה
          // (יתרה-חיה פחות-הנעילות-שנדחפה-בטיק-הזה, ×0.9 שוליים-בטיחות).
          const canQuote = Math.floor((inflightAvail(taker, m.quote) * 9) / 10);
          const maxQty = bestAsk.price > 0 ? Math.floor(canQuote / bestAsk.price) : 0;
          const qty = Math.min(bestAsk.amount - bestAsk.filled, 150_000, maxQty);
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
          const qty = Math.min(bestBid.amount - bestBid.filled, 150_000, maxQty);
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
              ? Math.floor((inflightAvail(bot, m.quote) * 9) / (px * 10))
              : Math.floor((inflightAvail(bot, m.base) * 9) / 10))
          : 0;
        const qty = Math.min(25_000 + (tick % 5) * 10_000, affordable);
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
        const amt = 20_000 + (tick % 7) * 8_000;
        // FIX(R44 · noise-escrow-guard): פקודת-הלימיט של בוט-הרעש נבדקת-לכיסוי לפני-
        // השליחה — כמו-טייק-השוק. נמדד-חי: order(bot-c):insufficient-escrow ב-
        // world.json (h28759) — הבוט המשיך-להציע-פקודות אחרי-שאזל-מלאיו, כל-טיק
        // מחדש, מזהם-את-מונה-הדחיות ומבזבז-סליקה. כעת: בלי-כיסוי → אין-פקודה (הבוט
        // שותק-בכנות, בדיוק-כמו-סוחר-אמת-שאין-לו-מה-להציע).
        {
          const needMu = side === "buy" ? px * amt : amt; // קנייה: הצעת-ציטוט; מכירה: הבסיס-עצמו
          const haveMu = inflightAvail(bot, side === "buy" ? m.quote : m.base);
          if (needMu > 0 && haveMu >= needMu) {
            inflightAdd(bot, side === "buy" ? m.quote : m.base, needMu);
            submit(rt, st, bot, { type: "order", base: m.base, quote: m.quote, side, price: px, amount: amt }, pushOp);
          }
        }
      } else {
        const p = getPool(st, poolKey(m.base, m.quote));
        // R26 · בוטי-רעש לא-נוגעים-בבריכת-המסדרון: הזרימה-שלהם חד-צדדית-מבנית
        // (לבוטים אין WSTEEM — המכירות נדחות insufficient, הקניות נשארות → סחיפת-
        // הבריכה מעל-העוגן; נמדד-חי: 54→79µ ב-240-טיקים). בנכס-עיגון-1:1 גילוי-
        // המחיר הוא-מבחוץ (STEEM-אמת באורקל) — רעש-סימולטיבי על-המסדרון הוא-לא
        // גילוי-מחיר אלא-סתם-עיוות. האמת באה-מהדלת, מהמסילה-ומהסימון-המחדש.
        if (p && !RAIL_OWNED_POOLS.has(poolKey(m.base, m.quote))) {
          // FIX(SETTLE-14): הכיוון היה tick%3 — מוטה-מבנית 2:1 (על-הזוג-הריבוני:
          // 2/3 קניות-בסיס). זרימה-חד-צדדית קטנה-אך-מתמדת היא-הרמת-מחיר,
          // לא-גילוי-מחיר. זוגיות-טיק = איזון-מושלם שתי-הכיוונים.
          const assetIn = tick % 2 === 0 ? p.a : p.b;
          // FIX(R45 · noise-pool-guard): סוואפ-הבריכה של בוט-הרעש נבדק-לכיסוי לפני-
          // השליחה — החור שהשאיר R44 (תיקן-לימיט-פקודות-בלבד). נמדד-חי:
          // pool_swap(bot-b):insufficient ב-world.json (h29305) — bot-b עם
          // {USDS:958, SAOS:1} המשיך-לדחוף-סוואפים-של-15k-35kµ כל-טיק מחדש.
          // כעת: הגודל נחתך-לכיסוי-האמת (×0.9), אפס-כיסוי → אין-סוואפ — הבוט
          // שותק-בכנות, כמו-סוחר-אמת-שאין-בכיסו-כלום.
          const haveMu = inflightAvail(bot, assetIn as Asset);
          const wantMu = 15_000 + (tick % 5) * 5_000;
          const amt = Math.min(wantMu, Math.floor((haveMu * 9) / 10));
          if (amt > 0) {
            inflightAdd(bot, assetIn as Asset, amt);
            submit(rt, st, bot, { type: "pool_swap", pair: poolKey(p.a, p.b), assetIn, amount: amt }, pushOp);
          }
        }
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
