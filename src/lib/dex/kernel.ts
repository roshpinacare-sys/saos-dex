/**
 * kernel.ts — הגרעין הדטרמיניסטי של SAOS-DEX (מורשת ישירה:
 *   · CHAIN_SPEC.md — יחידות-מיקרו, טבלת-GAS, עימות-עסקאות
 *   · kernel.cjs (steem-main) — applyTx {ok,gas,err}, אפס-float, dedupe קשיח
 *   · saos-dex.ts — ספר-הזמנות עם נעילת-ערבות (escrow) ומחיר-מייקר
 *   · grid98.cjs — DEX-98 בריכות-גנריות, order_gc, שער-שוליים
 *
 * כללי-ברזל: 1 SAOS = 1000µ · מחיר = µ-ציטוט ל-1-יחידת-בסיס · אין float במצב ·
 * עסקה לא-חוקית לא נוגעת במצב · stateRoot = sha256(canonicalJSON(state)).
 *
 * FIX(Roast-63 · H1) — כנות-על-דטרמיניזם: journal.t נושא חותמת-שעון (nowMs
 * שהוזרק-מ-buildBlock) והוא חלק-מה-state → ריפליי מהטייפ דטרמיניסטי רק-כשמשחזרים
 * גם-את-t-מהרשומות-הכלולות-במצב. יישום-טרי-של-אותם-ops ייתן-journal.t אחר
 * → stateRoot אחר. שינוי-מבני (t=height) דורש-הגירה-של-השרשרת-החיה — מתועד-כחוב-
 * טכני-פתוח, לא-מוסתר.
 */
import { canon, sha256, stateRootOf } from "./canonical";
import { cancelOrder, matchBook, gcOrders, type BookOrder } from "./book";
import { poolAdd, poolSwap, poolRm, LP_ASSET_PREFIX } from "./amm";

// ─── טבלת-GAS (מפרט-הברזל + הרחבות 96–113 של kernel.cjs) ────────────────────
// SETTLE-5 "לוח-זמנים-סיבולת": קיזוז-שריפה בפעולות-התדר-הגבוהות (סדר/ביטול/
// מילוי/סוופ-בריכה) — ספר-סגור שורף 990µ/בלוק בעוד עמלות-נמדדות חוזרות ב-~3µ/
// בלוק (ממצא-חי 2026-09: ארנה 1.7M→922k ב-11 דק׳). קיזוז-זה נותן לפונטיין
// ולממנים לנשום: שריפה ~3× נמוכה = ריצה ~3× ארוכה, והעמלות מצטברות אל מעל
// סף-הפונטיין. פעולות-נדירות (wrap/attest/harvest) לא-נוגעו — אין-טעם.
export const GAS_TABLE = {
  transfer: 100,
  pay: 120,
  order: 60,
  cancel: 15,
  fill: 60,
  order_gc: 30,
  pool_add: 180,
  // Roast-71 · POOL-OPEN: פתיחת-בריכה-חדשה-בזמן-ריצה — אפס-גז (משפחת-הערוצים-הריבוניים:
  // xfer_free/refuel/relay/wrap/batch). מגן-הספאם-האמיתי הוא **מבני** ולא-מחיר:
  // אוצר-בלבד + זריעה-דו-צדדית-מלאה-מיתרות-האוצר + pair-קנוני + נגד-בריכה-קיימת.
  // gas-על-op-אוצר-בלבד אינו-מוסיף-הגנה-ורק-מרעיב-את-ספר-הריבון (תשישות-מבנית —
// אותו-דפוס-שתוקן-ב-ZFB-66-וב-קצבת-החיות-SETTLE-15).
  pool_open: 0,
  // R26 · POOL-REPEG — סימון-מחדש-ריבוני של בריכה-בבעלות-מלאה אל-עוגן-האורקל.
  // אפס-גז — אותה-משפחת-ערוצים-ריבוניים (מבנה-המגן: אוצר-בלבד + pair-קנוני +
  // אורקל-קיים; לא-מחיר). זה-לא-swap — ההחלפה-היא-בסימון-בלבד (Σ נשמר).
  pool_repeg: 0,
  pool_swap: 100,
  pool_rmw: 120,
  pool_xAdd: 180,
  pool_x: 220,
  pool_xRm: 120,
  // FIX(Roast-66 · ZFB-zero-fee-bridge): wrap = מסדרון-הגשר (STEEM⇄WSTEEM · BLURT⇄WBLURT 1:1)
  // — המנדט: גשר-עסקאות-על-כלל-הרשתות **ללא-עמלה**. היה 250-גז-קרדיטים-סמוי-על-המסילה
  // (היה-מונע-ממשתמש-בלי-קרדיטים-לעטוף/לפדות — MED-66). עכשיו: אפס-גז-כמו-הריליי —
  // מגן-הספאם-האמיתי הוא חובת-הגיבוי-1:1 (avail/backing fail-closed) ולא המחיר.
  wrap_mint: 0,
  wrap_burn: 0,
  asset_list: 70,
  asset_price: 40,
  harvest: 20,
  attest: 50,
  heartbeat: 10,
  refuel: 0, // THE-REFUEL: העברת-קרדיטים מהאוצר — אפס-גז (שירות-חיות כמו relay)
  mint_fuel: 0, // THE-FOUNTAIN: הטבעת-דלק מגובה-עמלות-מדודות — אפס-גז, אוצר-בלבד
  relay: 0, // THE-DOOR: חוזה-חינם שכופה עבודה-אמת על רשת-מרוחקת
  relay_ack: 0,
  xfer_free: 0, // THE-SWEEP (SETTLE-12): העברה-חופשית על הרשת-הריבונית — אפס-גז, תקרה-מדודה (FREE_XFER_CAP), העברה-טהורה בין-יתרות (אפס-נגיעה בקרדיטים → האינווריאנטה נשמרת מעצמה)
  batch: 0, // דבר-גורר-דבר (SETTLE-12): אטומיות — סדרת-ops שכולה מתבצעת או שכולה נדחית. גז-0 למעטפת; תתי-ה-ops משלמים גז משלהם. עומק-1 בלבד (אין-מקוננים)
  // ── Task 54 · כלכלה-מטורפת (ve(3,3) + POL-bonds — מחקר-מפעיל "הכי מטורפות") ──
  ve_lock: 40,   // נעילת-SAOS→veSAOS (Aerodrome vote-escrow, 1..208 שבועות)
  ve_unlock: 30, // פריקה-אחרי-תום-התקופה
  ve_vote: 20,   // הצבעת-גייג' — לאיזו בריכה זורמת קרן-התגמולים
  bond_buy: 80,  // BONDS-2.0 — קניית-SAOS-בהנחה-3%, נעול-ve-12שב' (Olympus-POL בלי-מלכודת-ההדפסה)
  // ── Task 56 · מסחר-אוטומטי-חסר-קיפרים (GMX TP/SL בלי-keepers · Jupiter DCA) ──
  dca_create: 40,  // תוכנית-DCA: הפקדה-מלאה-מראש, פרוסה-אוטומטית-כל-K-בלוקים
  dca_cancel: 15,  // ביטול-תוכנית + שחרור-יתרה-נעולה
  trig_order: 60,  // פקודת-טריגר (stop/take): נחתמת-עצמאית-מול-המחיר-הקנוני
  trig_cancel: 15, // ביטול-טריגר + שחרור-ערבות
  // ── Task 57/58 · מסילת-ההשקות (עקומת-pump.fun + LBP) — פתוחה-לכל-אזרח-רשת ──
  launch_create: 60, // השקת-טוקן-חדש על-העקומה (אזרחי-הרשת — לא-רק-המפעיל)
  launch_buy: 80,    // קנייה-מהעקומה — כסף-אמת-בלבד (הגיוס נעול-בחשבון-ההשקה)
  launch_sell: 80,   // מכירה-חזרה-לעקומה — clamp fail-closed לגיוס-האמת
  // ── Task 58 · CoW-אצווה (מחקר R-56 #7): מכירות-אצווה-פר-בלוק במחיר-אחיד ──
  cow_order: 60,   // הזמנת-אצווה: נעולה-מראש, נסגרת-במחיר-שווק-אחיד בסוף-הבלוק
  cow_cancel: 15,  // ביטול-הזמנת-אצווה + שחרור-ערבות
  // ── Task 72 · THE-COIN-DOOR (דלת-המטבעות): אורקל-מחירים קנוני ──
  // נתון-שוק-אמת (median חוצה-מקורות ציבוריים) נכנס למצב-הקנוני דרך op-אוצר.
  // הערכים חיים בתוך ה-op עצמו → ריפליי דטרמיניסטי. אפס-גז (משפחת-הערוצים
  // הריבוניים: relay/wrap/batch) — השקיפות היא המוצר, והמגן-המבני הוא אוצר-בלבד.
  oracle_set: 0,
  // ── Task 80 · THE-VAULT (כספת-ההלוואות — שלב 2 בשעון נתיב הכסף) ──
  vault_open: 80,     // שאיבת USDS נגד בטחונות WSTEEM (CDP מינימלי, יחס 250%)
  vault_repay: 60,    // פירעון + שחרור בטחונות (הריבית → אוצר)
  vault_liquidate: 60, // ניקוי-כספת שנפלה מתחת-ל-150% — פתוח-לכל-אזרח, בונוס 5%
  vault_backstop: 40, // כיסוי-כספת-שקועה מתחת-ל-100% — אוצר-בלבד, הפסד-נרשם-בגלוי
  // ── R40 · THE-SAVE (חיסכון-USDS בהכנסה-מדודה — התשובה ל"למה-להפקיד") ──
  save_open: 80,   // הפקדת-USDS לחיסכון — קבלת-חלק-פרו-ראטה בהכנסה המדודה
  save_close: 60,  // משיכה + ריבית-שנצברה מהכנסה-שהגיעה-בפועל
} as const;

export type OpKind = keyof typeof GAS_TABLE;
export const FEE_BPS = 30; // עמלי-30bps כמו-הבריכה-הילידית (dex-facts)
export const TREASURY_CUT_PCT = 30; // 30% מהעמלה → אוצר (רווח-מונוטוני, grid98)
export const REFUEL_CAP = 100_000; // תקרת-עירוי-פר-פקודה — גם-אם-האוצר נחטף, הנזק מגודל
export const FUEL_ASK_MIN = 2_000; // FIX(roast-81): סף-בקשה-מועילה — מתחת-לזה (אבק-גז) לא-מבקשים-עירוי
// FIX(roast-79 · fuel-death-spiral): הבוטים נכנסו-לסולם-הממנים — נמדדו-חי כמחזיקי-
// הרזרבה-האמתיים (bot-a 924k · bot-b 420k · bot-c 309k — 1.65M מג'נזיס שלא-נשרף)
// בזמן-שהסולם-הישן (אוצר 8µ · ארנה 25.9k · מפעיל 2k) היה-מת-מבנית. העברה-טהורה
// בלבד (אפס-הטבעה) — Σcredits נשמר, רק-הלוגיסטיקה חיה. הסדר-בפועל נקבע-ב-funderFor.
export const FUEL_FUNDERS = ["treasury", "arena", "bot-a", "bot-b", "bot-c", "operator"] as const; // ממני-דלק: האוצר (עמלות) + המייצב (רזרבה-עמוקה — "arena funds the floor") + הבוטים (מחזיקי-רזרבה) + המפעיל-האנושי (רזרבת-ג'נזיס שלו — קו-הגנה-האחרון, SETTLE-5)
export const LADDER_FUEL_FLOOR = 8_000; // סולם-הערך דורש feeMeter≥8000 להרמה — המטבע לא ירעיב-אותו
export const MINT_FUEL_CAP = 100_000; // תקרת-הטבעת-דלק-פר-פקודה — מגובה-בנוסף בעמלות-מדודות
export const FREE_XFER_CAP = 2_000_000; // THE-SWEEP (SETTLE-12): תקרת-העברה-חינם-פר-פקודה (2,000 יחידות) — החינם הוא המוצר, התקרה היא גבול-הנזק
export const BATCH_MAX_OPS = 8; // דבר-גורר-דבר: תקרת-תתי-ops-פר-batch — אטומיות לא משלמת עליית-זיכרון בלתי-חסומה (structuredClone לכל-batch)

// ── Task 54 · קבועי-כלכלה (חיים-בגרעין כדי-למנוע-יבוא-מעגלי: kernel ← economy) ──
export const BLOCKS_PER_WEEK = 201_600; // טיק 3s → 7 ימים מדויק
export const VE_MAX_WEEKS = 208;        // 4 שנים — מעטפת-Aerodrome בדיוק
export const VE_MIN_WEEKS = 1;
export const VE_VAULT = "ve-vault";     // כספת-SAOS-הנעולים (חשבון-עד)
export const VE_POT = "ve-pot";         // קרן-התגמולים-למצביעים
export const BOND_DISC_BPS = 300;       // הנחת-בונד 3% מעל-מחיר-בריכה-חי
export const BOND_VE_WEEKS = 12;        // SAOS-של-בונד נעול 12שב' (≈90 יום)
export const BOND_MIN_USDS = 50_000;    // תקרה-תחתונה-פר-בונד (µ)
export const BOND_MAX_USDS = 2_000_000; // תקרת-בונד-פר-פקודה (2000 USDS)
export const BOND_COOLDOWN = 10;        // בלוקים-בין-בונדים-פר-חשבון
// ── Task 80 · THE-VAULT — כספת-ההלוואות המינימלית (שלב 2 בשעון נתיב הכסף · money.html) ──
// דוקטרינה: USDS נגד בטחונות WSTEEM בלבד · יחס שמרני · תקרות עד-שהמכשיר-יוכח ·
// ריבית מתומחרת-במצב-השרשרת · אפס-float-במצב · ריפליי-מדויק (הונפה-עצלה-טהורה).
export const VAULT_POT = "vault-pot";                // חשבון-עד שמחזיק את כל-הבטחונות
export const VAULT_COLLATERAL = "WSTEEM";            // הבטחון היחיד (money.html שלב 2: WSTEEM בלבד)
export const VAULT_MIN_CR_PCT = 250;                 // יחס-בטחונות מינימלי 250% — שאיבה ≤ 40% מערך
export const VAULT_LIQ_CR_PCT = 150;                 // מתחת-ל-150% — נזילות פתוחה-לכל-אזרח
export const VAULT_LIQ_BONUS_BPS = 500;              // בונוס-מפרק 5% — תמריץ-ניקוי-חוב אמת
export const VAULT_DEBT_CAP_MU = 100_000;            // תקרת-חוב-פר-כספת ($100) — השקה-שמרנית, אפס-ביקורת-חוץ
export const VAULT_GLOBAL_CAP_MU = 500_000;          // תקרת-חוב-גלובלית ($500) — עד-שהמכשיר-יוכח-בחיים
export const VAULT_BASE_RATE_BPS = 500;              // ריבית-בסיס 5%/שנה
export const VAULT_UTIL_SURGE_BPS = 1_000;           // תוספת-ניצולת עד +10%/שנה — מתומחר-בשרשרת
export const BLOCKS_PER_YEAR = BLOCKS_PER_WEEK * 52; // 10,483,200 — ריבית-שלמים-בלבד
// ── R40 · THE-SAVE — חיסכון-USDS בהכנסה-מדודה (מדפוס-הכספת: תקרות-עד-שהמכשיר-יוכח) ──
export const SAVE_POT = "save-pot";             // חשבון-עד שמחזיק את קרן-החוסכים
export const SAVE_CAP_MU = 10_000_000;          // תקרת-חיסכון-גלובלית ($10,000) — השקה-שמרנית
export const SAVE_POS_CAP_MU = 2_500_000;       // תקרת-עמדה-פר-חשבון ($2,500)
export const SAVE_DAY_BLOCKS = 28_800;          // חלון-היום הקנוני — לשיעור-המפורסם
export const EPOCH_BLOCKS = 1_200;      // אפוק-פליפ כל-שעה (טיק 3s) — נראה-חי
export const ROUTER_EVERY = 600;        // מחזור-קנייה-ושריפה כל-30 דק'
export const REV_FLOOR = 200_000;       // רצפת-רווח-אוצר שהראוטר לא נוגע בה (µ)
export const REV_BURN_PCT = 40;         // → קנייה-מהבריכה-ושריפה
export const REV_VE_PCT = 40;           // → קרן-veSAOS
export const ROUTER_USDS_FLOOR = 1_000_000; // רצפת-USDS-אוצר — הראוטר לא מרוקן
// FIX(roast-81 · router-dust-lock): היה 10,000 — נמדד-חי: revAux=9,124µ (רווח-אמת-מדוד)
// תקוע-מתחת-לשער → הראוטר-ישן-מאז-h33,000 (12,000+ בלוקים), השריפה-קפואה-על-206,741µ,
// קרן-ה-ve-יבשה-6-אפוקים. אותו-דפוס-של-roast-79 (שער-המזרקה): שער-נגד-אבק היה-החלטת-
// תזמון, לא-אבטחה — האבטחה-היא-הרצפות (REV_FLOOR · ROUTER_USDS_FLOOR) והגיבוי-הכפול.
export const REV_MIN_CYCLE = 1_000;     // מתחת-לזה — אין-מחזור (עמלות-אבק נשארות)
export const DYN_FEE_MIN_BPS = 4;       // עמלה-דינמית: רצפה
export const DYN_FEE_MAX_BPS = 1_500;   // עמלה-דינמית: תקרה
export const DYN_FEE_K = 4;             // fee = base + vol/4 (0.25bps-ל-bps-תנודה)
// ── Task 55 · ALE (מנוע-הנזילות-האוטונומית) — POL שצומח-מהעמלים עצמם, בלי-משתמשים ──
export const ALE_EVERY = 100;           // מחזור-הזרעה-כל-100-בלוקים (5 דק' בטיק-3s)
export const ALE_SEED_PCT = 25;         // % מהחופשי-מעל-הרצפה שיוזרע-כ-POL
export const ALE_MIN_SEED = 5_000;      // מתחת-לזה — אין-הזרעה (אבק)
export const ALE_MAX_PER_CYCLE = 500_000; // תקרת-הזרעה-פר-מחזור — גם-אם-האוצר נשפך, הנזק חסום
// ── Task 57/58 · מסילת-ההשקות (מחקר R-56 #4 pump.fun/LaunchLab + #8 Balancer-LBP) ──
export const LPAD_FEE_BPS = 150;        // עמלת-השקה: 40% יוצר-חי-פר-מסחר · 60% פלטפורמה→revAux
export const LPAD_CREATOR_PCT = 40;
export const LPAD_GRAD_MIN_USDS = 2_000_000; // סף-הגירה: גיוס-2Mµ → בריכת-AMM אמת
export const LPAD_MAX_RAISE = 20_000_000;    // תקרת-גיוס-כוללת-פר-השקה (גבול-נזק)
export const LPAD_LBP_BLOCKS = 1200;    // משך-דצ'י-אוקציה (שעה בטיק-3s)
export const LPAD_MIN_SUPPLY = 50_000_000;
export const LPAD_MAX_SUPPLY = 1_000_000_000;
export const LPAD_VQ_DIV = 100;         // vq0 = supply/100 — מחיר-פתיחה-שטוח (תמחור-וירטואלי)
export const LPAD_MAX_PER_OWNER = 2;    // השקות-חיות-מקבילות-פר-בעלים
export const LPAD_MAX_ACTIVE = 8;       // השקות-חיות-מקבילות-ברשת-כולה
export const LPAD_CODE_PREFIX = "LB|";  // קוד-נכס-מוגר: LB|TICKER
export const LPAD_TRADE_CAP = 2_000_000; // תקרת-קנייה-פר-פקודה (גבול-נזק)
// ── Task 58 · CoW-אצווה (מחקר R-56 #7 CoW-Swap): מחיר-אחיד-פר-בלוק ──
export const COW_MAX_PENDING_PER_ISSUER = 16; // הזמנות-אצווה-פתוחות-פר-חשבון
export const COW_FALLBACK_MIN_OUT_BPS = 200;  // מגן-minOut לברירת-המחדל של המסלול (2%)

export type FuelFunder = (typeof FUEL_FUNDERS)[number];
/** סדר-הסולם (SETTLE-5/9 · roast-79): arena → bot-a/b/c → treasury → operator.
 * FIX(roast-79 · fuel-death-spiral): סדר-הקדימות הוא-התרופה. היה: ארנה→אוצר→מפעיל —
 * נמדד-חי: שלושתם מתים (25.9k שאינו-עובר-מבחן-amt+10k · 8 · 2k) בזמן-שהבוטים
 * מחזיקים 1.65M. עכשיו: ארנה → בוטים (מרווח לבריאות-המממן) → אוצר → מפעיל. */
export const FUNDER_ORDER: FuelFunder[] = ["arena", "bot-a", "bot-b", "bot-c", "treasury", "operator"];
/** FIX(roast-81 · afford-single-source): יכולת-המימון-המקסימלית של ממנה — אותם-מרווחי-
 * ברזל של-funderFor (ארנה/בוטים שומרים-רצפת-10k לבריאות-המממן; האוצר/המפעיל ניתנים-עד-
 * תום-היתרה). SETTLE-9 dedup: המרווחים חיים-פה-בלבד — הדריפט-פה = דליפה-כלכלית. */
export const FUNDER_KEEP = 10_000;
export function funderAfford(st: DexState, who: FuelFunder): number {
  const cr = st.credits[who] ?? 0;
  const keep = who === "treasury" || who === "operator" ? 0 : FUNDER_KEEP;
  return Math.max(0, cr - keep);
}
/** ממנה-דלק מדורג (SETTLE-5/9 · roast-79 · roast-81-refactor-טהור):
 * exclude — לא-לממן-עצמי (הארנה אסור-שתממן-את-עצמה: המנוע דוחה rTo==issuer).
 * התנהגות-זהה-במדויק לקודם — רק-המרווחים עברו-למקור-אמת-אחד (funderAfford). */
export function funderFor(st: DexState, amt: number, exclude?: string): FuelFunder {
  for (const f of FUNDER_ORDER) {
    if (f === exclude) continue;
    if (funderAfford(st, f) >= amt) return f;
  }
  return "operator";
}

export type Asset = "SAOS" | "USDS" | "WSTEEM" | "ENERGY" | "WSBD" | "PHIVE" | "STEEM" | "SBD" | "BLURT" | "WBLURT" | "WTRX" | "WSOL";
/** רשימת-ריצה של הנכסים — אימות-קלט fail-closed ב-routes ובגרעין (SETTLE-9).
 * Task 61 · BLURT/WBLURT — מסילת-האמת: WBLURT מוטבע מול-גיבוי-חוץ-אמת
 * (BLURT-אמת על headcorner, מאומת-חי מול-RPC-ציבורי בכל-קריאת-truth).
 * Task 72 · דלת-המטבעות: WTRX/WSOL — עוגנים-מגובי-פקדה (wrap_mint external
 * + claim), הפקדות-אמת מאומתות מול-RPC ציבורי (trongrid/solana).
 * R42 · THE-SBD-RAIL: SBD-נרשם-כנכס — ל-WSBD נולד מסדרון-גיבוי (WSBD⇄SBD),
 * והגריד-החוץ (מכירות מעל-קו-הזהות) מזרים-SBD-אמת-ל-headcorner —
 * הפעימה עוטפת-את-העודף (deficit-mint) לגיבוי-חי-מדוד. דבר-גורר-דבר. */
export const ASSETS: Asset[] = ["SAOS", "USDS", "WSTEEM", "ENERGY", "WSBD", "PHIVE", "STEEM", "SBD", "BLURT", "WBLURT", "WTRX", "WSOL"];

export interface Pool {
  a: Asset; b: Asset; // ממוינים אלפבתית — מפתח-קנוני
  ra: number; rb: number; // רזרבות µ
  lp: number; // היצע µlp
  feeAccruedTreasury: number; // מדידה
  swaps: number;
  // Task 54 · עמלים-דינמיים (V4-hooks/Bunni am-AMM): EWMA-תנודתיות-פר-בריכה
  // + עמלה-מסתגלת 4..1500bps — מגן-LP מ-LVR. רשויות: תמונות-מצב-ישנות-בלעדיהן.
  volBpsEwma?: number;
  dynFeeBps?: number;
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
  extBack?: Record<string, { claim: string; mu: number; atH: number }>; // Task 61 · גיבוי-חוץ-אמת (תביעה + מדידה חיה ב-truth)
  treasuryProfit: number; // רווח-אוצר מצטבר-מונוטוני (µ)
  feeMeter: number; // עמלות-שנצברו-שטרם-נקצרו (מדידה-כנה)
  feeMinted?: number; // THE-FOUNTAIN: Σקרדיטים-שהוטבעו-מעמלות-מדודות — מנוכה-באינווריאנטה (רשות: תמונות-מצב-ישנות)
  // FIX(Roast-65-a · HIGH-3d): דלי-רביעי-לביקורת-העמלות (settle.ts (d)) — Σעמלות-שנצרכו
  // על-ידי-הראוטר (צריכת-treasuryProfit ב-economy.revenueCycle). בלעדיו הזהות
  // pools===feeMeter+profit+minted נשברת-נצחית מהמחזור-הראשון שבו-הראוטר שורף
  // (המדידה-בבריכות אינה יורדת). רשויות: תמונות-מצב-ישנות (undefined→0).
  feesSpentMu?: number;
  // FIX(Roast-67 · ZFB-gas-tank): Σקרדיטים-שמומנו-לארנק-הדלק-מהעמלות-שנמדדו
  // (revenueCycle, 10%-מהמחזור, בסמנטיקות-mint_fuel-המלאות) — טלמטריית-ריצה.
  gasFundedMu?: number;
  // FIX(Roast-65-a · LOW-11): cooldown-הברזל-של-ה-faucet — במצב (לא-בזיכרון-מודול)
  // כדי-שריסטארט לא יאפס את התקרה. רשויות: תמונות-ישנות (undefined→0).
  faucetAt?: Record<string, number>;
  // FIX(Roast-65-a · LOW-10): טבעת-חסומה של-תביעות-חוץ-בשימוש (ה-dedupe היה slot-יחיד
  // ב-extBack[a].claim — רצף-טענות C1,C2,C1 עבר). רשויות: תמונות-ישנות.
  extClaims?: string[];
  // FIX(R17-b·M1): טבעת-גלובלית-אחת (256) שוחקת-אחרי-256-תביעות-חדשות — תביעה-ישנה
  // של-נכס-X נשכחת-מהטבעת ועולה-שוב (דדופ-שכבתי-רק-עם extBack.claim-האחרון = הגנה-רקובה).
  // עתה: טבעת-פר-נכס (64-אחרונות-פר-נכס) — הדדופ-נשאר-חזק-גם-אחרי-מאות-תביעות.
  extClaimsBy?: Record<string, string[]>;
  // FIX(Roast-65 · drift-declaration): הצהרת-סחיפה-היסטורית — פערי-שימור-שנצברו-בעידן
  // שלפני-התיקונים (מדפסות-שתוקנו ב-63/64). העיקרון: **מוצהר-ולא-מוסתר** — המבקר
  // (settle.ledgerAudit) כולל-את-הסכומים-המוצהרים-בלבד; כל-סחיפה-חדשה-מעבר-להצהרה
  // = HALT. ההצהרה נכתבת-פעם-אחת-בטעינה (chain.loadSnapshot) עם-מספרים-מדויקים
  // ביומן, והיא-חלק-מהמצב-הקנוני (נכנסת-ל-stateRoot — לא-תעודה-חוץ-רשמית).
  auditAdjustments?: {
    note: string;
    atH: number;
    native?: Record<string, number>;   // נכס → (live−genesis) היסטורי מוצהר
    lp?: Record<string, number>;       // מפתח-בריכה → הפרש-implied מוצהר
    feesSpentMu?: number;              // עמלות-שנצרכו-טרם-שדה-feesSpentMu (חתימה)
  };
  // FIX(Roast-68 · pol-retro-mint): דגל-הגירה-חד-פעמי — הפנטום-הג'נזיס (implied>0)
  // הוטבע-כעמדת-POL-אמת-בידי-האוצר; מאז: implied=0-לנצח והביקורת-מחמירה-מיד-בחותם.
  polRetroMint?: boolean;
  ladder: { refPrice: number; stepCostMu: number; lifts: number; lastLiftHeight: number; spentMu: number };
  journal: JournalEntry[];
  gasUsed: number;
  nextSeq: number;
  relayOpen?: number; // FIX(Roast-64): מונה-דלתות-relay-פתוחות — relay_ack חייב-קישור (רשויות: תמונות-ישנות-בלעדיו)
  rearmCounts?: { saos: number; usds: number; wsteem: number }; // FIX(Roast-64): תקרות-ה-rearm-במצב (היו-מודול — ריסטארט-מאפס)
  botSeedCounts?: Record<string, { usds: number; saos: number }>; // FIX(Roast-64): תקרות-זריעת-בוטים-במצב (אותו-עיקרון)
  soldierSeedCounts?: Record<string, { wsteem: number }>; // SETTLE-17: קו-אספקת-חיילים במצב (אותו-עיקרון — ריסטארט לא מאפס)
  // ── Task 80 · THE-VAULT (רשויות: תמונות-ישנות-בלעדיהן = undefined) ──
  vaults?: Record<string, { colMu: number; debtMu: number; intMu: number; atH: number }>; // עמדת-כספת-פר-חשבון (בטחונות/קרן/ריבית-מונפת/גובה-הונפה)
  vaultTot?: { opened: number; repaid: number; liquidations: number; interestMu: number; backstopLossMu: number; issuedMu: number; burnedMu: number }; // מוני-חיים + חשבונאות-היצע-כנה (issued−burned = ההיצע שהכספת יצרה)
  // ── R40 · THE-SAVE (רשויות: תמונות-ישנות-בלעדיהן = undefined — המכשיר טרם-נולד) ──
  savings?: {
    positions: Record<string, { mu: number; owedMu: number; atH: number }>; // עמדת-חוסך-פר-חשבון (קרן/ריבית-שנצברה/גובה-פתיחה-אחרון)
    potMu: number;          // קרן-חוסכים כוללת (µ USDS) — שווה-סכום-positions.mu
    paidMu: number;         // ריבית-שחולקה-מצטברת (מדידה-כנה, אף-µ-לא-הוטבע)
    lastIncomeMu: number;   // תמונת-מונה-ריבית-הכספת שנראתה לאחרונה — דלתא=הכנסה-חדשה
    dayPaidMu: number; dayPaidPrevMu: number; dayMarkH: number; // חלון-יום מתגלגל — שיעור-מפורסם-אמת
    opens: number; closes: number;
  };
  stats: { fills: number; swaps: number; opsTotal: number; ladders: number };
  // ── Task 54 · כלכלה (רשויות-כולן: תמונות-מצב-ישנות-בלעדיהן = undefined) ──
  ve?: Record<string, { amt: number; unlockH: number; weeks: number; atH: number }>; // עמדת-veSAOS-פר-חשבון
  veVotes?: Record<string, string>;     // חשבון → בריכה-מוצבעת
  veEpoch?: number;                     // מונה-אפוקים (עולה בפליפ)
  rev?: { lastH: number; cycles: number; burnedMu: number; vePaidMu: number }; // מדידת-ראוטר
  burnedSaos?: number;                  // ΣSAOS-שנשרף (דפלציוני-אמת)
  bond?: { soldSaosMu: number; usdsInMu: number; count: number };
  bondUserH?: Record<string, number>;   // cooldown-בונד-פר-חשבון
  ale?: { lastH: number; cycles: number; seededMu: number; seeds: number; polBaseUsdsMu: number }; // ALE-מדידה (רשויות: תמונות-מצב-ישנות-בלעדיהן)
  // ── Task 56 · מסחר-אוטומטי (רשויות: תמונות-מצב-ישנות-בלעדיהן = undefined) ──
  dca?: Record<string, DcaProgram>;   // תוכניות-DCA חיות
  trig?: Record<string, TrigOrder>;   // פקודות-טריגר חיות
  dcaSeq?: number;                    // מונה-תוכניות
  trigSeq?: number;                   // מונה-טריגרים
  // ── Task 57/58 · מסילת-ההשקות + ProtoRev + CoW (רשויות: תמונות-ישנות-בלעדיהן) ──
  launch?: Record<string, Launch>;    // השקות חיות/שהוגרו
  launchSeq?: number;                 // מונה-השקות
  revAux?: { protorevMu: number; launchpadMu: number; runs?: number; cycles?: number; rejections?: number; lastH?: number }; // פנקס-הכנסה-נלווית (מחוץ-לאינווריאנטה-d — הרווח אינו עמלת-סוואפ)
  cow?: CowOrder[];                   // הזמנות-אצווה-פתוחות (נסגרות-בסוף-הבלוק)
  cowSeq?: number;                    // מונה-הזמנות-אצווה
  cowStats?: { matched: number; batches: number; surplusMu: number; fallbackPool: number; fallbackBook: number }; // מדידת-CoW
  // ── Task 72 · דלת-המטבעות: אורקל-מחירים קנוני (רשויות: תמונות-מצב-ישנות-בלעדיו) ──
  // נכס → { mu: µ-USDS ל-1-יחידת-שלמה · atH: גובה-העדכון · src: תווית-מקור }. חלק-מה-stateRoot.
  oracle?: Record<string, { mu: number; atH: number; src: string }>;
}

/** Task 57/58 · השקה-על-מסילת-ההשקות: עקומת-מחיר-וירטואלית (pump.fun) או
 * דצ'י-אוקציה (LBP), בגיוס-הסף → הגירה-אוטומטית-לבריכת-AMM אמת + LP-100%-לאוצר.
 * כסף-אמת-בלבד: הגיוס נעול-בחשבון-ההשקה; הוירטואלי משמש-תמחור-בלבד —
 * מכירות clamp fail-closed לגיוס-האמת (הוירטואלי-תמחור, האמת-תשלום). */
export interface Launch {
  id: string; owner: string; ticker: string; name: string; code: string;
  mode: "curve" | "lbp";
  supplyMu: number;      // היצע-כולל (µ-טוקן)
  soldMu: number;        // מחזור-נוכחי (µ-טוקן בידי-קונים)
  vqAccumMu: number;     // צבירת-הציטוט-הווירטואלי (רשומת-עקומה; לא-דועך)
  feesCreatorMu: number; feesPlatformMu: number;
  atH: number; endH: number; // endH=0 → עקומה-טהורה (ללא-תפוגה)
  graduated: boolean; gradH: number; poolKey: string;
}

/** Task 58 · הזמנת-אצווה (CoW): נעולה-מראש כמו-פקודת-לימיט; בסוף-הבלוק
 * נסגרת-מול-הצד-השני במחיר-שווק-אחיד (uniform-clearing) — עודף-המחיר נשאר
 * אצל-הסוחרים; שארית-חוצה-ברירת-מחדל: בריכה-ואז-ספר. סנדוויץ'-בלתי-אפשרי
 * מבנית: הסליקה בתוך-בונה-הבלוקים, מחיר-אחיד-לכולם. */
export interface CowOrder {
  seq: number; id: number; owner: string;
  base: string; quote: string;
  side: "buy" | "sell";
  price: number;  // מחיר-גבול (µ-ציטוט ל-1µ-בסיס ×1000) — הגבול-להצטרפות
  amount: number; // µ בסיס
  atH: number; at: number;
  lockMu: number; // מד-הנעילה-הפרטי (יחידות-נעילה)
}

/** Task 56 · תוכנית-DCA (Jupiter/Brink): הפקדה-מלאה-מראש (נעולה), פרוסה-אוטומטית
 * דרך-הראוטר כל-everyK-בלוקים — ה-keper הוא-בונה-הבלוקים-עצמו (אפס-תשתית-חוץ). */
export interface DcaProgram {
  id: string; owner: string;
  assetIn: string; assetOut: string;
  perSliceMu: number;     // גודל-פרוסה (µ)
  remainingMu: number;     // יתרה-לפרוס (µ) — נעולה-מראש-על-הבעלים
  everyK: number;          // פרוסה-כל-K-בלוקים
  minOutBps: number;       // מגן-סטייה-לכל-רגל (bps)
  lastH: number;           // גובה-הפרוסה-האחרונה (0=טרם-פרסה)
  done: number;            // פרוסות-שבוצעו
  slicesMax: number;       // תקרת-פרוסות (ביטחון)
  atH: number;             // גובה-יצירה
}

/** Task 56 · פקודת-טריגר (GMX TP/SL): נעולה-מראע, נסרקת-כל-בלוק-מול-המחיר
 * הקנוני (mid-בריכה); בטריגר → הופכת-פקודת-לימיט-חוצת-ספר (taker-first). */
export interface TrigOrder {
  id: string; owner: string;
  base: string; quote: string; side: "buy" | "sell";
  triggerPx: number;       // מחיר-הטריגר (µ-ציטוט)
  limitPx: number;         // מחיר-לימיט-בביצוע (0 → triggerPx)
  amountMu: number;        // כמות-בסיס (µ)
  expiresH: number;        // 0=ללא-תפוגה
  atH: number;
}

// ─── עזרי-מצב (שלמים-בלבד) ──────────────────────────────────────────────────
export const bal = (st: DexState, who: string, a: string): number => st.balances[who]?.[a] ?? 0;
export const lockedOf = (st: DexState, who: string, a: string): number => st.locked[who]?.[a] ?? 0;
export const avail = (st: DexState, who: string, a: string): number =>
  bal(st, who, a) - lockedOf(st, who, a);

/** FIX(Roast-64 · CRITICAL prototype-pollution): חשבון בשם "__proto__" (או
 * constructor/prototype) דרך-addBal/addLock/credits — הכתיבה הייתה נופלת על
 * Object.prototype וכל-חשבון-קיים היה יורש יתרה-חינם (מדפסת-כסף — הוכחה-חיה
 * ברוסט-64: transfer ל-"__proto__" → כל-ארנק רואה יתרה שלא הייתה לו). עכשיו:
 * fail-closed — זיהוי-מסוכן זורק, בגרעין ובעזרי-המצב (הגנה-כפולה). */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
export function safeAccountName(name: string, kind: string): void {
  if (FORBIDDEN_KEYS.has(name)) throw new Error(`forbidden-account-name:${kind}:${name}`);
}

/** FIX(R16-a·m8): √k-שלמים — ra·rb מעל-2^53 הוא-צף-לא-מדויק (מניית-LP-סוטה);
 * עתה: מכפלה-לא-בטוחה = √ra·√rb (בלי-גלישה). תחום-היחידות-הקיים (µ) אינו-נוגע
 * בתקרה — זו-הגנת-עומק, לא-תיקון-התנהגות. */
export function sqrtLp(ra: number, rb: number): number {
  const p = ra * rb;
  return Number.isSafeInteger(p) ? Math.floor(Math.sqrt(p)) : Math.floor(Math.sqrt(ra) * Math.sqrt(rb));
}

export function addBal(st: DexState, who: string, a: string, d: number): void {
  if (!Number.isSafeInteger(d)) throw new Error("non-integer balance delta");
  if (FORBIDDEN_KEYS.has(who) || FORBIDDEN_KEYS.has(a)) throw new Error("forbidden-state-key");
  const b = (st.balances[who] = st.balances[who] ?? {});
  b[a] = (b[a] ?? 0) + d;
}
export function addLock(st: DexState, who: string, a: string, d: number): void {
  // FIX(Roast-65-a · HIGH-1): addLock היה-השער-היחיד-בלי-בדיקת-שלם (addBal כבר-היה-גדור) —
  // lockMu=1000.5 נכנס-ל-st.locked (הוכח-חי ב-P2b) והמצב-הקנוני הפך-רעיל (stateRoot זורק
  // CanonicalError בכל-חישוב). אותו-חוזה-בדיוק כמו-addBal: זריקה fail-closed.
  if (!Number.isSafeInteger(d)) throw new Error("non-integer lock delta");
  if (FORBIDDEN_KEYS.has(who) || FORBIDDEN_KEYS.has(a)) throw new Error("forbidden-state-key");
  const l = (st.locked[who] = st.locked[who] ?? {});
  l[a] = (l[a] ?? 0) + d;
}
export function chargeGas(st: DexState, who: string, gas: number): boolean {
  if ((st.credits[who] ?? 0) < gas) return false;
  st.credits[who] = (st.credits[who] ?? 0) - gas;
  st.gasUsed += gas;
  return true;
}
/** FIX(Roast-64 · replay-hole): החלון-הנע היה חור-ריפליי אמיתי — עסקה שהוזרחה
 * מה-window (6000 ops ≈ דקות) הייתה מתקבלת שוב (יתרות שונות → העברה-כפולה).
 * עכשיו: ה-Set הוא זיכרון-dedupe-מלא-לכל-חיי-התהליך (מעולם לא מוחק) — החלון נשאר
 * רק-על-המערך-הקנוני (גודל-השורש); איפוס-זיכרון קורה רק בריסטארט (כמו כל-רשת
 * שמחזיקה-dedupe בזיכרון). מסמך-בכנות: אחרי-ריסטארט ה-dedupe נבנה-מחדש מה-window. */
const NONCE_WINDOW = 6000;
// FIX(SETTLE-9 perf): st.nonces.includes היה סריקה O(window) לכל-op (21µs × 160 ops/בלוק
// = ~3.3ms/בלוק). Set מקביל שומר-סנכרון מול-המערך (שניהם תמיד חד-ערכיים — המערך
// ממשיך להיות חלק-מה-canonical/שורש, ה-Set חוץ-מצב לגמרי). נבנה-עצלנית לכל-אובייקט-
// מצב: כיסוי-מלא ל-loadSnapshot/resetChain/שיבוטי-exam (אובייקט-חדש = בנייה-מחדש).
const nonceSets = new WeakMap<DexState, Set<string>>();
function nonceSet(st: DexState): Set<string> {
  let s = nonceSets.get(st);
  if (!s) { s = new Set(st.nonces); nonceSets.set(st, s); }
  return s;
}
function pushNonce(st: DexState, key: string): void {
  st.nonces.push(key);
  nonceSet(st).add(key);
  if (st.nonces.length > NONCE_WINDOW) {
    // FIX(Roast-64 · replay-hole): העלים יוצאים מהמערך-הקנוני בלבד — ה-Set ממשיך
    // לזכור לנצח (אפס-ריפליי). ראה-הערת-המודול מעלה.
    st.nonces.splice(0, 1000);
  }
}
export const poolKey = (x: string, y: string): string => [x, y].sort().join("/");
export const notional = (price: number, amountMu: number): number =>
  Math.floor((price * amountMu) / 1000); // price=µ-ציטוט/יחידה · amount=µ-בסיס

/** Task 57/58 · הציטוט-הווירטואלי הנוכחי של-השקה (µ-ציטוט ×1000-סקאלה):
 * בסיס-וירטואלי (vq0 = supply/100; ב-LBP דועך-לינארית מ-atH עד-endH — דצ'י-אוקציה)
 * + צבירת-הכסף-האמת (vqAccumMu — קניות-מרימות, מכירות-מורידות).
 * הוירטואלי משמש תמחור בלבד; התשלום תמיד מהגיוס-האמת הנעול-בחשבון-ההשקה. */
export function launchVq(st: DexState, l: Launch): number {
  const vq0 = Math.floor(l.supplyMu / LPAD_VQ_DIV);
  let base = vq0;
  if (l.mode === "lbp" && l.endH > l.atH) {
    const left = Math.max(0, l.endH - st.height);
    base = Math.floor((vq0 * left) / (l.endH - l.atH));
  }
  return base + (l.vqAccumMu ?? 0);
}

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
    ve: {}, veVotes: {}, veEpoch: 0,
    rev: { lastH: 0, cycles: 0, burnedMu: 0, vePaidMu: 0 },
    burnedSaos: 0,
    bond: { soldSaosMu: 0, usdsInMu: 0, count: 0 },
    bondUserH: {},
    vaults: {},
    vaultTot: { opened: 0, repaid: 0, liquidations: 0, interestMu: 0, backstopLossMu: 0, issuedMu: 0, burnedMu: 0 },
    savings: { positions: {}, potMu: 0, paidMu: 0, lastIncomeMu: 0, dayPaidMu: 0, dayPaidPrevMu: 0, dayMarkH: 0, opens: 0, closes: 0 },
    dca: {}, trig: {}, dcaSeq: 1, trigSeq: 1,
    launch: {}, launchSeq: 1,
    revAux: { protorevMu: 0, launchpadMu: 0 },
    cow: [], cowSeq: 1,
    cowStats: { matched: 0, batches: 0, surplusMu: 0, fallbackPool: 0, fallbackBook: 0 },
    // FIX(Roast-65-a · LOW-11/LOW-10): faucet-cooldown וטבעת-תביעות-חוץ — חלק-מהמצב-הקנוני
    faucetAt: {},
    extClaims: [],
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
    WSTEEM: { refPrice: 320, listed: 0 },    // 0.32 USDS — מורשת; R23: העוגן מחליק אל מחיר-החוץ מיישום-oracle_set הראשון
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
    p.lp = sqrtLp(p.ra, p.rb); // x*y=k → lp=√k — FIX(R16-a·m8)
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
export interface TradeEvent { kind: "fill" | "swap"; base: Asset; quote: Asset; price: number; amountMu: number; taker: string; maker?: string; at: number; quoteMu?: number }

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
  amountB?: number; // Roast-71 · pool_open — זריעת-הצד-השני (pair קנוני: amount=צד-שמאל, amountB=צד-ימין)
  // veSAOS (Task 54)
  weeks?: number;
  // עטיפות/רשימות/עדים/דלתות
  wrapAsset?: Asset; name?: string; refPrice?: number; claim?: string; memo?: string;
  external?: boolean; // Task 61 · wrap_mint-מגובה-חוץ (אוצר-בלבד)
  at?: number;
  // Task 56 · מסחר-אוטומטי
  progId?: string;      // dca_cancel
  everyK?: number; perSlice?: number; slicesMax?: number; minOutBps?: number; // dca_create
  triggerPx?: number; limitPx?: number; expiresH?: number;                    // trig_order
  // Task 57/58 · מסילת-ההשקות
  ticker?: string; lmode?: "curve" | "lbp"; supply?: number;
  // Task 72 · oracle_set — מפת-מחירים (נכס → µ-USDS ל-1-יחידה, שלמים בלבד)
  prices?: Record<string, number>;
  // Task 80 · THE-VAULT — כספת-ההלוואות
  drawMu?: number;       // vault_open: סכום-השאיבה ב-USDSµ
  repayMu?: number;      // vault_repay: סכום-הפירעון ב-USDSµ (0 = פירעון-מלא-עד-החוב)
  withdrawMu?: number;   // vault_repay: בטחונות-לשחרור ב-WSTEEMµ
  owner?: string;        // vault_liquidate / vault_backstop: בעל-הכספת המטופלת
  // דבר-גורר-דבר (SETTLE-12): תתי-ops של batch — כל-תת-op חייב-issuer זהה למנפיק-ה-batch
  ops?: Op[];
}

/** נכס-מוכר לגרעין: רשימת-הריצה הקבועה או נכס-רשום (השקות-שהוגרו, asset_list). */
export function knownAsset(st: DexState, a: string | undefined): boolean {
  if (!a) return false;
  return (ASSETS as string[]).includes(a) || !!st.assets[a];
}

/* ── Task 80 · THE-VAULT — מתמטיקה-טהורה (שלמים-בלבד, זהה-בריפליי) ─────────────── */
/** ערך בטחונות ב-µUSDS: refPrice ב-mµ-ליחידה (USDS=1000 → $1; WSTEEM=54 → $0.054). */
export function vaultColValueMu(st: DexState, colMu: number): number {
  const ref = st.assets[VAULT_COLLATERAL]?.refPrice ?? 0;
  return ref > 0 ? Math.floor((colMu * ref) / 1000) : 0;
}
/** ריבית מתומחרת-במצב-השרשרת: בסיס 5%/שנה + תוספת-ניצולת (חוב-גלובלי/תקרה). */
export function vaultRateBps(st: DexState): number {
  let debt = 0;
  for (const v of Object.values(st.vaults ?? {})) debt += v.debtMu + v.intMu; // קרן + ריבית-מונפת — התביעה-הכוללת
  const util = debt >= VAULT_GLOBAL_CAP_MU ? 1 : debt / VAULT_GLOBAL_CAP_MU;
  return VAULT_BASE_RATE_BPS + Math.floor(util * VAULT_UTIL_SURGE_BPS);
}
/** חוב-אפקטיבי = קרן + ריבית שנצברה — הונפה-עצלה: פונקציה-טהורה-של-המצב, אפס-כתיבה-פר-בלוק. */
export function vaultEffDebtMu(debtMu: number, rateBps: number, fromH: number, toH: number): number {
  const blocks = Math.max(0, toH - fromH);
  if (blocks <= 0 || debtMu <= 0) return debtMu;
  return debtMu + Math.floor((debtMu * rateBps * blocks) / (10_000 * BLOCKS_PER_YEAR));
}
/** מוני-חיים וחשבונאות-היצע של הכספת — תמיד-אובייקט (תמונות-ישנות-בלעדיו = אפסים-כנים). */
export function vaultTotals(st: DexState): { opened: number; repaid: number; liquidations: number; interestMu: number; backstopLossMu: number; issuedMu: number; burnedMu: number } {
  return st.vaultTot ?? { opened: 0, repaid: 0, liquidations: 0, interestMu: 0, backstopLossMu: 0, issuedMu: 0, burnedMu: 0 };
}
/** היצע-הכספת-החי (µ USDS): מה-שהוטבע-בשאיבה וטרם-נשרף בפירעון — הצהרת-הביקורת המדויקת. */
export function vaultNetSupplyMu(st: DexState): number {
  const t = vaultTotals(st);
  return t.issuedMu - t.burnedMu;
}

export function applyOp(st: DexState, op: Op, nowMs: number): OpResult {
  if (!op || typeof op !== "object") return { ok: false, err: "bad-op", gas: 0 };
  const gas = GAS_TABLE[op.type];
  if (gas === undefined) return { ok: false, err: "unknown-op", gas: 0 };
  // FIX(R15-a · CRITICAL-1 · integer-gates): op.amount גולמי (100.5) עבר כמה-שערים
  // (refuel/mint_fuel/wrap) שכתבו אותו ישר-למצב-הקנוני → stateRoot זרק CanonicalError
  // → HALT, וההתאוששות היחידה היא reset שמוחק-ראיות. עתה: שער-שלמים אחיד בדלת-ה-op —
  // נדחה לפני-כל-נגיעה-במצב (אותו-עיקרון Roast-65-a HIGH-1 שהוחל-רק על order/cow/price).
  if (op.amount !== undefined && !Number.isSafeInteger(op.amount))
    return { ok: false, err: "non-integer-amount", gas: 0 };
  const issuer = String(op.issuer ?? "").toLowerCase();
  if (!issuer || !op.nonce) return { ok: false, err: "issuer+nonce-required", gas: 0 };
  // FIX(Roast-64 · prototype-pollution): זיהוי-מסוכן נדחה-בדלת (שים-לב: גם addBal/
  // addLock מוגנים — הגנה-כפולה fail-closed). נמען-"__proto__" נדחה בדיוק-כך.
  if (FORBIDDEN_KEYS.has(issuer)) return { ok: false, err: "forbidden-issuer", gas: 0 };
  // FIX(SETTLE-7 authz-split): נרמול-פעם-אחת בכניסה — כל-הנתיבים (יתרות/נעילות/
  // order-cap/ספר/בריכות) חייבים-לראות את אותו-מזהה. החור-ההיסטורי: issuer-גולמי
  // ("TREASURY") עבר בדיקת-funder-only במנוע-המנורמל אך נגע ביתרות-של-מזהה-אחר.
  op.issuer = issuer;
  if (typeof op.to === "string") {
    op.to = op.to.toLowerCase(); // אותו-עיקרון לנמענים — אין-חשבונות-רפאים בגלל-רישוי
    if (FORBIDDEN_KEYS.has(op.to)) return { ok: false, err: "forbidden-recipient", gas: 0 };
  }
  const dedupeKey = `${issuer}:${op.nonce}`;
  if (nonceSet(st).has(dedupeKey)) return { ok: false, err: "replay-rejected", gas: 0 };

  const consume = (): OpResult | null => {
    if (!chargeGas(st, issuer, gas)) return { ok: false, err: "insufficient-credits", gas };
    pushNonce(st, dedupeKey);
    st.stats.opsTotal++;
    return null;
  };

  switch (op.type) {
    case "ve_lock": {
      // Task 54 · veSAOS (Aerodrome ve(3,3)): SAOS→כספת-ve, עמדה-אחת-פר-חשבון;
      // הצטברות = מיזוג-עמדה + הארכת-unlock למקסימום. כוח-ve דועך-לינארית.
      const a = op.asset, amt = op.amount ?? 0, weeks = Math.floor(op.weeks ?? 0);
      if (a !== "SAOS") return { ok: false, err: "ve-saos-only", gas: 0 };
      if (!(amt > 0)) return { ok: false, err: "bad-amount", gas: 0 };
      if (!Number.isInteger(weeks) || weeks < VE_MIN_WEEKS || weeks > VE_MAX_WEEKS)
        return { ok: false, err: "bad-weeks", gas: 0 };
      if (avail(st, issuer, "SAOS") < amt) return { ok: false, err: "insufficient", gas };
      const c = consume(); if (c) return c;
      addBal(st, issuer, "SAOS", -amt);
      addBal(st, VE_VAULT, "SAOS", amt);
      const prev = st.ve?.[issuer];
      const unlockFromWeeks = st.height + weeks * BLOCKS_PER_WEEK;
      st.ve = {
        ...(st.ve ?? {}),
        [issuer]: {
          amt: (prev?.amt ?? 0) + amt,
          unlockH: Math.max(prev?.unlockH ?? 0, unlockFromWeeks),
          weeks: Math.max(prev?.weeks ?? 0, weeks),
          atH: st.height,
        },
      };
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "ve_lock", note: `${amt}µ SAOS × ${weeks}w → ve` });
      return { ok: true, gas };
    }
    case "ve_unlock": {
      // פריקה — רק-אחרי-תום-הנעילה (fail-closed: הגובה הוא-החוק)
      const pos = st.ve?.[issuer];
      if (!pos) return { ok: false, err: "no-ve-position", gas: 0 };
      if (st.height < pos.unlockH) return { ok: false, err: "ve-still-locked", gas: 0 };
      const c = consume(); if (c) return c;
      addBal(st, VE_VAULT, "SAOS", -pos.amt);
      addBal(st, issuer, "SAOS", pos.amt);
      const votes = { ...(st.veVotes ?? {}) }; delete votes[issuer];
      st.veVotes = votes;
      const veMap = { ...(st.ve ?? {}) }; delete veMap[issuer];
      st.ve = veMap;
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "ve_unlock", note: `${pos.amt}µ SAOS → free` });
      return { ok: true, gas };
    }
    case "ve_vote": {
      // הצבעת-גייג': קרן-התגמולים זורמת-לבריכות-שמוצבות (Aerodrome: 100%-דמי-הסוואפ
      // למצביעים). משקל = כוח-ve-בשעת-הפליפ; הצבעה-חדשה דורסת-ישנה (עדכון-חופשי).
      const pair = String(op.pair ?? "");
      if (!st.pools[pair]) return { ok: false, err: "pool-not-found", gas: 0 };
      if (!st.ve?.[issuer] || st.ve[issuer].amt <= 0) return { ok: false, err: "no-ve-position", gas: 0 };
      const c = consume(); if (c) return c;
      st.veVotes = { ...(st.veVotes ?? {}), [issuer]: pair };
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "ve_vote", note: `→ ${pair}` });
      return { ok: true, gas };
    }
    case "bond_buy": {
      // Task 54 · BONDS-2.0 (Olympus-POL, נלמד-מהכשל): SAOS-אוצר בהנחת-3% מול-USDS;
      // התמורה יורדת-לאוצר, ה-SAOS נכנס-ve-נעול-12שב' לקונה — נזילות-אוצר
      // שאי-אפשר-למשוך + אפס-הדפסה (נמכר-רק-מהיתרה-האמת של-האוצר).
      const usdsIn = Math.floor(op.amount ?? 0);
      if (!(usdsIn >= BOND_MIN_USDS && usdsIn <= BOND_MAX_USDS)) return { ok: false, err: "bond-size", gas: 0 };
      if (avail(st, issuer, "USDS") < usdsIn) return { ok: false, err: "insufficient", gas };
      const last = st.bondUserH?.[issuer] ?? 0;
      if (st.height - last < BOND_COOLDOWN) return { ok: false, err: "bond-cooldown", gas: 0 };
      const pool = st.pools["SAOS/USDS"];
      if (!pool || pool.ra <= 0) return { ok: false, err: "no-ref-pool", gas: 0 };
      const price = Math.floor((pool.rb * 1000) / pool.ra); // µ-USDS ל-1µ-SAOS (×1000-סקאלה)
      if (!(price > 0)) return { ok: false, err: "no-price", gas: 0 };
      const saosOut = Math.floor((usdsIn * 1000 * 10_000) / (price * (10_000 - BOND_DISC_BPS)));
      if (!(saosOut > 0)) return { ok: false, err: "bad-quote", gas: 0 };
      if (bal(st, "treasury", "SAOS") < saosOut) return { ok: false, err: "treasury-empty", gas: 0 };
      const c = consume(); if (c) return c;
      addBal(st, issuer, "USDS", -usdsIn);
      addBal(st, "treasury", "USDS", usdsIn);
      addBal(st, "treasury", "SAOS", -saosOut);
      addBal(st, VE_VAULT, "SAOS", saosOut);
      const prev = st.ve?.[issuer];
      const unlockFromWeeks = st.height + BOND_VE_WEEKS * BLOCKS_PER_WEEK;
      st.ve = {
        ...(st.ve ?? {}),
        [issuer]: {
          amt: (prev?.amt ?? 0) + saosOut,
          unlockH: Math.max(prev?.unlockH ?? 0, unlockFromWeeks),
          weeks: Math.max(prev?.weeks ?? 0, BOND_VE_WEEKS),
          atH: st.height,
        },
      };
      st.bond = {
        soldSaosMu: (st.bond?.soldSaosMu ?? 0) + saosOut,
        usdsInMu: (st.bond?.usdsInMu ?? 0) + usdsIn,
        count: (st.bond?.count ?? 0) + 1,
      };
      st.bondUserH = { ...(st.bondUserH ?? {}), [issuer]: st.height };
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "bond_buy", note: `${usdsIn}µ USDS → ${saosOut}µ SAOS (-3%, ve ${BOND_VE_WEEKS}w)` });
      return { ok: true, gas };
    }
    case "dca_create": {
      // Task 56 · DCA (Jupiter/Brink): הפקדה-מלאה-מראע → נעילה-על-הבעלים;
      // הפריסה-עצמה קורית-ב-dcaTick (chain.ts) — פרוסות-דרך-הראוטר במסגרת
      // batch אטומי עם-מגן-minOut לכל-רגל. הבלוק-בילדר הוא-ה-keper.
      // FIX(Task 56): applyOp מנרמל op.to לאותיות-קטנות (עבור-נמענים) — כאן `to`
      // הוא קוד-נכס ולכן מנרמל-חזרה לאותיות-גדולות (USDS/SAOS/WSTEEM).
      const assetIn = op.asset, assetOut = String(op.to ?? "").toUpperCase();
      const perSlice = Math.floor(op.perSlice ?? 0);
      const amount = perSlice * Math.floor(op.slicesMax ?? 0);
      const everyK = Math.floor(op.everyK ?? 0);
      const slicesMax = Math.floor(op.slicesMax ?? 0);
      const minOutBps = Math.floor(op.minOutBps ?? 100);
      if (!assetIn || !ASSETS.includes(assetIn)) return { ok: false, err: "bad-asset", gas: 0 };
      if (!ASSETS.includes(assetOut as Asset) || assetOut === assetIn) return { ok: false, err: "bad-asset-out", gas: 0 };
      if (!(perSlice > 0) || !(slicesMax >= 1) || slicesMax > 200) return { ok: false, err: "bad-slice", gas: 0 };
      if (!Number.isInteger(everyK) || everyK < 1 || everyK > 10_000) return { ok: false, err: "bad-everyk", gas: 0 };
      if (!(minOutBps >= 0) || minOutBps > 2_000) return { ok: false, err: "bad-minout", gas: 0 };
      if (!(amount > 0)) return { ok: false, err: "bad-amount", gas: 0 };
      if (Object.keys(st.dca ?? {}).filter((k) => st.dca?.[k]?.owner === issuer).length >= 8)
        return { ok: false, err: "dca-cap", gas: 0 };
      if (avail(st, issuer, assetIn) < amount) return { ok: false, err: "insufficient", gas: 0 };
      const c = consume(); if (c) return c;
      addLock(st, issuer, assetIn, amount); // הפקדה-מלאה-מראע — נעולה-עד-ביטול/גמר
      const id = `dca-${st.dcaSeq ?? 1}`;
      st.dcaSeq = (st.dcaSeq ?? 1) + 1;
      st.dca = { ...(st.dca ?? {}), [id]: { id, owner: issuer, assetIn, assetOut, perSliceMu: perSlice, remainingMu: amount, everyK, minOutBps, lastH: 0, done: 0, slicesMax, atH: st.height } };
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "dca_create", note: `${id}: ${amount}µ ${assetIn}→${assetOut}, ${perSlice}µ/פרוסה כל-${everyK}-בלוקים` });
      return { ok: true, gas };
    }
    case "dca_cancel": {
      const pid = String(op.progId ?? "");
      const prog = st.dca?.[pid];
      if (!prog) return { ok: false, err: "program-not-found", gas: 0 };
      if (prog.owner !== issuer) return { ok: false, err: "not-owner", gas: 0 };
      const c = consume(); if (c) return c;
      if (prog.remainingMu > 0) addLock(st, issuer, prog.assetIn, -prog.remainingMu); // שחרור-יתרה
      const dcaMap = { ...(st.dca ?? {}) }; delete dcaMap[pid]; st.dca = dcaMap;
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "dca_cancel", note: `${pid} בוטל, הוחזרו ${prog.remainingMu}µ ${prog.assetIn}` });
      return { ok: true, gas };
    }
    case "trig_order": {
      // Task 56 · טריגר (GMX TP/SL חסר-קיפרים): נעילה-מלאה-מראע כמו-פקודת-לימיט;
      // הסריקה-כל-בלוק-מול-המחיר-הקנוני; בטריגר → פקודת-לימיט-חוצת-ספר.
      const side = op.side;
      const base = op.base, quote = op.quote;
      const triggerPx = Math.floor(op.triggerPx ?? 0);
      const limitPx = Math.floor(op.limitPx ?? 0);
      const amt = Math.floor(op.amount ?? 0);
      const expiresH = Math.floor(op.expiresH ?? 0);
      if ((side !== "buy" && side !== "sell") || !ASSETS.includes(base as Asset) || !ASSETS.includes(quote as Asset) || base === quote)
        return { ok: false, err: "bad-order-params", gas: 0 };
      if (!(triggerPx > 0) || !(amt > 0)) return { ok: false, err: "bad-price-amount", gas: 0 };
      if (limitPx < 0) return { ok: false, err: "bad-limit", gas: 0 };
      if (expiresH < 0) return { ok: false, err: "bad-expiry", gas: 0 };
      const lockAsset = (side === "sell" ? base : quote) as string;
      const effPx = limitPx > 0 ? limitPx : triggerPx;
      const lockMu = side === "sell" ? amt : notional(effPx, amt);
      if (!(lockMu > 0)) return { ok: false, err: "bad-lock", gas: 0 };
      if (!Number.isSafeInteger(lockMu)) return { ok: false, err: "lock-overflow", gas: 0 }; // FIX(R15-a): px*amt שלמים-אך מעל 2^53 — נפסל לפני consume
      if (Object.keys(st.trig ?? {}).filter((k) => st.trig?.[k]?.owner === issuer).length >= 24)
        return { ok: false, err: "trig-cap", gas: 0 };
      if (avail(st, issuer, lockAsset) < lockMu) return { ok: false, err: "insufficient-escrow", gas: 0 };
      const c = consume(); if (c) return c;
      addLock(st, issuer, lockAsset, lockMu);
      const id = `trg-${st.trigSeq ?? 1}`;
      st.trigSeq = (st.trigSeq ?? 1) + 1;
      st.trig = { ...(st.trig ?? {}), [id]: { id, owner: issuer, base: base as string, quote: quote as string, side, triggerPx, limitPx, amountMu: amt, expiresH, atH: st.height } };
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "trig_order", note: `${id}: ${side} ${amt}µ ${base} @${triggerPx}${limitPx > 0 ? ` lim ${limitPx}` : ""}` });
      return { ok: true, gas };
    }
    case "trig_cancel": {
      const tid = String(op.progId ?? "");
      const trg = st.trig?.[tid];
      if (!trg) return { ok: false, err: "trigger-not-found", gas: 0 };
      if (trg.owner !== issuer) return { ok: false, err: "not-owner", gas: 0 };
      const c = consume(); if (c) return c;
      const lockAsset = trg.side === "sell" ? trg.base : trg.quote;
      const effPx = trg.limitPx > 0 ? trg.limitPx : trg.triggerPx;
      addLock(st, issuer, lockAsset, -(trg.side === "sell" ? trg.amountMu : notional(effPx, trg.amountMu)));
      const trigMap = { ...(st.trig ?? {}) }; delete trigMap[tid]; st.trig = trigMap;
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "trig_cancel", note: `${tid} בוטל, ערבה שוחררה` });
      return { ok: true, gas };
    }
    case "launch_create": {
      // Task 57/58 · מסילת-ההשקות — פתוחה-לכל-אזרח-רשת (לא רק המפעיל): השקת-טוקן
      // על עקומת-מחיר וירטואלית (pump.fun) או דצ'י-אוקציה (LBP). אפס-כסף-ביצירה —
      // ההון נכנס רק בקניות אמת; ההגירה (launchpadTick) היא הרגע שבו נבראת הבריכה.
      const ticker = String(op.ticker ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      const lmode: "curve" | "lbp" = op.lmode === "lbp" ? "lbp" : "curve";
      const supply = Math.floor(op.supply ?? 0);
      if (ticker.length < 2 || ticker.length > 8) return { ok: false, err: "bad-ticker", gas: 0 };
      if (!(supply >= LPAD_MIN_SUPPLY && supply <= LPAD_MAX_SUPPLY)) return { ok: false, err: "bad-supply", gas: 0 };
      const code = LPAD_CODE_PREFIX + ticker;
      if (st.assets[code]) return { ok: false, err: "ticker-taken", gas: 0 };
      const active = Object.values(st.launch ?? {});
      // FIX(Roast-64 · launch-cap-brick): התקרה-הרשתית ספרה גם-השקות-שהסתיימו —
      // אחרי-8-השקות-היסטוריות הרשת-כולה-הייתה-ננעלת-להשקות-לנצח (DoS-עצמי).
      // עכשיו: רק-השקות-חיות-נספרות (עקבי-עם-התקרה-פר-בעלים שכבר-סננה !graduated).
      if (active.filter((l) => !l.graduated).length >= LPAD_MAX_ACTIVE) return { ok: false, err: "launch-cap", gas: 0 };
      if (active.filter((l) => l.owner === issuer && !l.graduated).length >= LPAD_MAX_PER_OWNER)
        return { ok: false, err: "launch-owner-cap", gas: 0 };
      if (active.some((l) => l.ticker === ticker)) return { ok: false, err: "ticker-active", gas: 0 };
      const c = consume(); if (c) return c;
      const id = `lp-${st.launchSeq ?? 1}`;
      st.launchSeq = (st.launchSeq ?? 1) + 1;
      st.launch = {
        ...(st.launch ?? {}),
        [id]: {
          id, owner: issuer, ticker, name: String(op.name ?? ticker).slice(0, 24), code,
          mode: lmode, supplyMu: supply, soldMu: 0, vqAccumMu: 0,
          feesCreatorMu: 0, feesPlatformMu: 0,
          atH: st.height, endH: lmode === "lbp" ? st.height + LPAD_LBP_BLOCKS : 0,
          graduated: false, gradH: 0, poolKey: "",
        },
      };
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "launch_create", note: `${code} (${lmode}) supply ${supply}µ` });
      return { ok: true, gas };
    }
    case "launch_buy": {
      // קנייה-מהעקומה — כסף-אמת-בלבד: הנטו נכנס-לחשבון-ההשקה (נעול-עד-הגירה),
      // העמלה מתפצלת-חי: 40% יוצר · 60% פלטפורמה→revAux. הוירטואלי = תמחור-בלבד.
      const l = Object.values(st.launch ?? {}).find((x) => x.ticker === String(op.ticker ?? "").toUpperCase() && !x.graduated);
      if (!l) return { ok: false, err: "launch-not-found", gas: 0 };
      if (l.mode === "lbp" && l.endH > 0 && st.height >= l.endH) return { ok: false, err: "launch-ended", gas: 0 };
      const usdsIn = Math.floor(op.amount ?? 0);
      if (!(usdsIn > 0) || usdsIn > LPAD_TRADE_CAP) return { ok: false, err: "bad-amount", gas: 0 };
      if (avail(st, issuer, "USDS") < usdsIn) return { ok: false, err: "insufficient", gas: 0 };
      const launchAcc = `launch:${l.id}`;
      if ((bal(st, launchAcc, "USDS")) + usdsIn > LPAD_MAX_RAISE) return { ok: false, err: "raise-cap", gas: 0 };
      const c = consume(); if (c) return c;
      const feeIn = Math.floor((usdsIn * LPAD_FEE_BPS) / 10_000);
      const netIn = usdsIn - feeIn;
      const creatorFee = Math.floor((feeIn * LPAD_CREATOR_PCT) / 100);
      const platFee = feeIn - creatorFee;
      // FIX(R16-a·M1): vq כבר-כלל את netIn (launchVq = בסיס-דועך + vqAccumMu) — ההוספה השנייה
      // במונה-המחיר הייתה מנפיחה את הדנומינטור פי-2 (קונים מקבלים ~0.44× מהעקומה במקס-קנייה).
      // עתה: אותו משוואת-עקומה בדיוק כמו-צד-המכירה (vq*t/(vq+t) ↔ vb*netIn/(vq+netIn)).
      const vq = launchVq(st, l); // הווירטואלי: בסיס-דועך (LBP) + צבירה-אמת — תמחור-בלבד
      const vb = l.supplyMu - l.soldMu;
      const tokensOut = vb > 0 ? Math.floor((vb * netIn) / (vq + netIn)) : 0;
      if (!(tokensOut > 0)) return { ok: false, err: "bad-quote", gas: 0 };
      addBal(st, issuer, "USDS", -usdsIn);
      addBal(st, issuer, l.code, tokensOut);
      addBal(st, launchAcc, "USDS", netIn);
      if (creatorFee > 0) addBal(st, l.owner, "USDS", creatorFee);
      if (platFee > 0) {
        addBal(st, "treasury", "USDS", platFee);
        st.revAux = { protorevMu: st.revAux?.protorevMu ?? 0, launchpadMu: (st.revAux?.launchpadMu ?? 0) + platFee };
      }
      l.soldMu += tokensOut;
      l.vqAccumMu += netIn;
      l.feesCreatorMu += creatorFee;
      l.feesPlatformMu += platFee;
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "launch_buy", note: `${l.code}: ${usdsIn}µ USDS → ${tokensOut}µ (${l.soldMu}/${l.supplyMu} מוחזק)` });
      return { ok: true, gas };
    }
    case "launch_sell": {
      // מכירה-חזרה-לעקומה — clamp fail-closed לגיוס-האמת: הוירטואלי מתמחר,
      // התשלום מוגבל-לכספת-ההשקה-האמתית (הוירטואלי-תמחור, האמת-תשלום).
      const l = Object.values(st.launch ?? {}).find((x) => x.ticker === String(op.ticker ?? "").toUpperCase() && !x.graduated);
      if (!l) return { ok: false, err: "launch-not-found", gas: 0 };
      const t = Math.floor(op.amount ?? 0);
      if (!(t > 0)) return { ok: false, err: "bad-amount", gas: 0 };
      if (avail(st, issuer, l.code) < t) return { ok: false, err: "insufficient", gas: 0 };
      const c = consume(); if (c) return c;
      const launchAcc = `launch:${l.id}`;
      const vq = launchVq(st, l);
      const vb = l.supplyMu - l.soldMu;
      let gross = vb + t > 0 ? Math.floor((vq * t) / (vb + t)) : 0;
      const real = bal(st, launchAcc, "USDS");
      if (gross > real) gross = real; // clamp fail-closed — הגיוס-האמת הוא-התקרה
      if (!(gross > 0)) return { ok: false, err: "no-raise-backing", gas: 0 };
      const feeOut = Math.floor((gross * LPAD_FEE_BPS) / 10_000);
      const netOut = gross - feeOut;
      const creatorFee = Math.floor((feeOut * LPAD_CREATOR_PCT) / 100);
      const platFee = feeOut - creatorFee;
      addBal(st, issuer, l.code, -t);
      l.soldMu -= t;
      addBal(st, launchAcc, "USDS", -gross);
      l.vqAccumMu -= gross; // העקומה משלמת-בפועל gross — הצבירה יורדת
      addBal(st, issuer, "USDS", netOut);
      if (creatorFee > 0) addBal(st, l.owner, "USDS", creatorFee);
      if (platFee > 0) {
        addBal(st, "treasury", "USDS", platFee);
        st.revAux = { protorevMu: st.revAux?.protorevMu ?? 0, launchpadMu: (st.revAux?.launchpadMu ?? 0) + platFee };
      }
      l.feesCreatorMu += creatorFee;
      l.feesPlatformMu += platFee;
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "launch_sell", note: `${l.code}: ${t}µ → ${netOut}µ USDS (clamp ${gross}/${vq > 0 ? "vq" : "0"})` });
      return { ok: true, gas };
    }
    case "cow_order": {
      // Task 58 · הזמנת-אצווה (CoW): נעילה-מלאה-מראע כמו-פקודת-לימיט; נסגרת
      // בסוף-הבלוק במחיר-אחיד מול-הצד-השני, ובלי-הצלבה — ברירת-מחדל: בריכה→ספר.
      const side = op.side;
      const base = op.base, quote = op.quote;
      const px = op.price ?? 0, amt = op.amount ?? 0;
      // FIX(R17-b·L3): cow_order קיבל-knownAsset (כולל-LB|* מוגדלים) בעוד-ה-fallback
      // (פקודת-order) מקבל-רק-ASSETS-קבוע → פקודת-CoW-על-נכס-השקה תמיד-נכשלת-ב-fallback
      // ("bad-order-params") ומוחזרת-cow_refund — נתיב-מת-שהפקיד-עמלת-גז-חינם. עתה:
      // נעול-ל-ASSETS — עקביות-מלאה-בין-ה-CoW-ל-fallback-שלו (השקות ממשיכות-דרך-העקומה-שלהן).
      if ((side !== "buy" && side !== "sell") || !(ASSETS as string[]).includes(base as string) || !(ASSETS as string[]).includes(quote as string) || base === quote)
        return { ok: false, err: "bad-order-params", gas: 0 };
      if (!(px > 0) || !(amt > 0)) return { ok: false, err: "bad-price-amount", gas: 0 };
      // FIX(Roast-65-a · HIGH-1): שער-שלמים גם-על-CoW — אותו-חור בדיוק (price/amount
      // גולמיים היו נכנסים ל-st.cow ולנעילה). נדחה-לפני-הנעילה.
      if (!Number.isSafeInteger(px) || !Number.isSafeInteger(amt))
        return { ok: false, err: "non-integer-price-amount", gas: 0 };
      const lockAsset = (side === "sell" ? base : quote) as string;
      const lockMu = side === "sell" ? amt : notional(px, amt);
      if (!(lockMu > 0)) return { ok: false, err: "bad-lock", gas: 0 };
      if (!Number.isSafeInteger(lockMu)) return { ok: false, err: "lock-overflow", gas: 0 }; // FIX(R15-a): ראה trig_order
      if ((st.cow ?? []).filter((o) => o.owner === issuer).length >= COW_MAX_PENDING_PER_ISSUER)
        return { ok: false, err: "cow-cap", gas: 0 };
      if (avail(st, issuer, lockAsset) < lockMu) return { ok: false, err: "insufficient-escrow", gas: 0 };
      const c = consume(); if (c) return c;
      addLock(st, issuer, lockAsset, lockMu);
      const seq = st.nextSeq++;
      st.cow = [...(st.cow ?? []), { seq, id: seq, owner: issuer, base: base as string, quote: quote as string, side, price: px, amount: amt, atH: st.height, at: nowMs, lockMu }];
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "cow_order", note: `${side} ${amt}µ ${base}/${quote} @${px} — אצווה-הבלוק` });
      return { ok: true, gas };
    }
    case "cow_cancel": {
      const cid = Math.floor(op.orderId ?? 0);
      const idx = (st.cow ?? []).findIndex((o) => o.id === cid);
      if (idx < 0) return { ok: false, err: "cow-not-found", gas: 0 };
      const o = st.cow![idx];
      if (o.owner !== issuer) return { ok: false, err: "not-owner", gas: 0 };
      const c = consume(); if (c) return c;
      addLock(st, issuer, o.side === "sell" ? o.base : o.quote, -o.lockMu);
      st.cow = st.cow!.filter((x) => x.id !== cid);
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "cow_cancel", note: `cow-${cid} בוטל, ערבה שוחררה` });
      return { ok: true, gas };
    }
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
    case "xfer_free": {
      // THE-SWEEP (SETTLE-12): העברה-חופשית על הרשת-הריבונית. מה שמיישם את דבר-המפעיל:
      // "שנוכל להעביר חופשי ללא עלות של גז ותלות — על הרשת שלנו". כללים:
      //  · אפס-גז (מפרט-האופקודה למעלה) · העברה-טהורה בין-יתרות-נכסים בלבד —
      //    אפס-נגיעה ב-credits → Σcredits נשמר מעצמו והאינווריאנטה עומדת.
      //  · תקרת-FREE_XFER_CAP-פר-פקודה (גבול-נזק) · נכס-מרשימת-ASSETS בלבד
      //    (fail-closed — אין-יצירת-נכסים-רפאים דרך-החינם) · dedupe קשיח כרגיל.
      const a = op.asset, amt = op.amount ?? 0;
      if (!a || !ASSETS.includes(a)) return { ok: false, err: "bad-asset", gas: 0 };
      if (!op.to || op.to === issuer || !(amt > 0)) return { ok: false, err: "bad-xfer", gas: 0 };
      if (amt > FREE_XFER_CAP) return { ok: false, err: "xfer-exceeds-cap", gas: 0 };
      if (avail(st, issuer, a) < amt) return { ok: false, err: "insufficient", gas: 0 };
      pushNonce(st, dedupeKey); st.stats.opsTotal++; // אפס-גז — החינם הוא היתרון
      addBal(st, issuer, a, -amt);
      addBal(st, op.to, a, amt);
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "xfer_free", note: `→${op.to} ${amt}µ ${a}` });
      return { ok: true, gas: 0 };
    }
    case "batch": {
      // דבר-גורר-דבר (SETTLE-12): אטומיות-קבוצתית. הכל-או-כלום: תתי-ה-ops מיושמים
      // על-עותק-צל (structuredClone) — רק-אם-כולם-עברו מאומץ-העותק כולו. כישלון
      // יחיד (מגן-minOut בקפיצה-2 של-המרה, למשל) מוחק את-כולה — אין-ביצוע-חלקי
      // שמשאיר נכס-תלוש-באמצע-שרשרת. תתי-ops חייבים issuer==מנפיק-ה-batch
      // (אין-הסעה-בין-חשבונות-בעטיפה-אחת) ואסורים-מקוננים (עומק-1).
      // FIX(3-a · D3 · open-pool-atomicity): חריג-pinning-יחיד ומצומצם — pool_open
      // עם issuer-מוצהר "treasury" רשאי לרוץ בתוך-batch של מנפיק-אחר. pool_open הוא
      // מעשה-ריבוני-של-האוצר (gas-0 · אפס-קרדיטים · LP-כולו-לאוצר · fail-closed-פנימי
      // · אינו-יכול להעשיר את חותם-ה-batch — בדיקת-ההתעשרות למטה נשארת מלאה), והדלת
      // (door open-pool) צריכה אותו אטומי-מול העברת-העוגן של-המפעיל: בלי-החריג,
      // שני-ה-ops היו נדחפים נפרדים וכישלון-פתיחה בזמן-בלוק היה מקרקע את העוגן
      // באוצר. שאר-התתי-ops נשארים issuer-pinned במלואם — ההגנה-המקורית-שלמה.
      const sub = Array.isArray(op.ops) ? op.ops : null;
      if (!sub || sub.length === 0 || sub.length > BATCH_MAX_OPS) return { ok: false, err: "bad-batch", gas: 0 };
      if (sub.some((s) => !s || s.type === "batch" || Array.isArray(s.ops))) return { ok: false, err: "batch-nesting-forbidden", gas: 0 };
      const trial = structuredClone(st) as DexState;
      let failedAt = -1; let failErr = "";
      // FIX(Task 56): אירועי-מסחר של תתי-ops נאספים-ומוחזרים — בלי-זה מסחר-אמת
      // (DCA/ראוטר) לא-נכנס-לטייפ ולעדות-המחיר (feedPriceOracle) — עדות-נעלמת.
      const evs: TradeEvent[] = [];
      for (let i = 0; i < sub.length; i++) {
        const pinned = sub[i].type === "pool_open" && sub[i].issuer === "treasury" ? "treasury" : issuer; // FIX(3-a · D3) — ראה-הערה למעלה
        const r = applyOp(trial, { ...sub[i], issuer: pinned }, nowMs); // issuer-pinned — הזהות של-החותם (חריג-יחיד: pool_open-אוצר)
        if (!r.ok) { failedAt = i; failErr = r.err; break; }
        if (r.events) evs.push(...r.events);
      }
      if (failedAt >= 0) return { ok: false, err: `batch-atomic-fail@${failedAt}:${failErr}`, gas: 0 };
      // בדיקת-התעשרות-עצמית — על-העותק, לפני-האימוץ (fail-closed נקי: דחייה
      // בלי-נגיעה במצב-החי). תתי-ה-ops נחתמו-על-העותק כולל-גז-שלהם — החותם
      // משלם-בעצמו; אסור-שה-batch יעשיר את-חותמו (למשל transfer-עצמי-כפול-תוך-העטיפה).
      const selfBefore = st.credits[issuer] ?? 0;
      if ((trial.credits[issuer] ?? 0) > selfBefore) return { ok: false, err: "batch-self-enrich-forbidden", gas: 0 };
      // FIX(Roast-65-a · MED-5): הדחיפה-הישנה כאן (על-המצב-החי) הוסרה — היא נמחקה ע"י ה-assign שמיד-אחריה (dead-code ששיקר); הנונס-החיצוני נדחף עכשיו אחרי-האימוץ (למטה)
      Object.assign(st, trial); // אימוץ-אטומי — אותו-אובייקט-זהות (ה-WeakMap של-ה-nonces נשאר-מכוון)
      nonceSets.set(st, new Set(st.nonces)); // סנכרון-מדד-ה-dedupe-מול-ה-nonces-המאומצים
      // FIX(Roast-65-a · MED-5): dedupe-העטיפה היה-מת — ה-pushNonce-על-המצב-החי (לפני-
      // Object.assign(st,trial)) נמחק-על-ידי-האימוץ, וה-Set נבנה-מחדש בלי המפתח
      // (הוכח-חי P1: batchNonceInState=false; אותו-nonce-חיצוני עם תתי-nonces-טריים עבר כחוק).
      // עכשיו: הנונס-החיצוני נדחף אחרי-האימוץ (ערך-קנוני זהה לדחיפה-לעותק) —
      // ריפליי-מדויק של-העטיפה נדחה replay-rejected, והחוזה "dedupe קשיח" אמת-גם-על-העטיפה.
      st.nonces.push(dedupeKey);
      nonceSet(st).add(dedupeKey);
      st.stats.opsTotal++;
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "batch", note: `${sub.length} ops atomic` });
      return { ok: true, gas: 0, events: evs };
    }
    case "refuel": {
      // THE-REFUEL (114): חיות-כלכלית מתמדת — ממני-הדלק (FUEL_FUNDERS: אוצר +
      // ארנה-המייצבת) מעבירים קרדיטים לסוכנים שאזל-המסלול-שלהם. **העברה-טהורה
      // בלבד (אפס-הטבעה)**: Σcredits נשמר לכל-אורך (המממן מאבד-בדיוק מה-שהסוכן
      // מקבל). מדוד-תקרה.
      if (!(FUEL_FUNDERS as readonly string[]).includes(issuer)) return { ok: false, err: "funder-only", gas: 0 };
      const rAmt = op.amount ?? 0, rTo = String(op.to ?? "");
      if (!rTo || rTo === issuer || !(rAmt > 0)) return { ok: false, err: "bad-refuel", gas: 0 };
      if (rAmt > REFUEL_CAP) return { ok: false, err: "refuel-exceeds-cap", gas: 0 };
      if ((st.credits[issuer] ?? 0) < rAmt) return { ok: false, err: "insufficient-credits", gas: 0 };
      pushNonce(st, dedupeKey); st.stats.opsTotal++; // אפס-גז — כמו relay
      st.credits[issuer] = (st.credits[issuer] ?? 0) - rAmt;
      st.credits[rTo] = (st.credits[rTo] ?? 0) + rAmt;
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "refuel", note: `→${rTo} ${rAmt}µ credits` });
      return { ok: true, gas: 0 };
    }
    case "mint_fuel": {
      // THE-FOUNTAIN (115): מיחזור-דלק — עמלות-שנמדדו-בפועל הופכות-חזרה לקרדיטים.
      // בכלכלה-אמת העמלות משלמות-גז לוולידטורים; בספר-הריבוני הן מחזירות-את-הדלק
      // שהמסחר-עצמו שרף. **גיבוי-כפול-וחד-פעמי**: treasuryProfit (עמלות-שהוכרו,
      // נצרך-ראשון) + feeMeter-מעל-רצפת-הסולם (לא-מרעיב-את-מנוע-הערך). כל-µ
      // מוטבע-נגרע-בדיוק-פעם-אחת מהמדידה (אין-הטבעה-כפולה של-אותה-עמלה) —
      // ביקורת-העמלות (pools===feeMeter+profit) והאינווריאנטה
      // Σcredits+gasUsed−feeMinted===ג'נזיס ממשיכות-לעמוד-בדיוק.
      if (issuer !== "treasury") return { ok: false, err: "treasury-only", gas: 0 };
      const fAmt = op.amount ?? 0, fTo = String(op.to ?? issuer);
      if (!(fAmt > 0) || !fTo) return { ok: false, err: "bad-amount", gas: 0 };
      if (fAmt > MINT_FUEL_CAP) return { ok: false, err: "mint-exceeds-cap", gas: 0 };
      const fromProfit = Math.min(fAmt, Math.max(0, st.treasuryProfit));
      const fromMeter = fAmt - fromProfit;
      const meterAvail = Math.max(0, (st.feeMeter ?? 0) - LADDER_FUEL_FLOOR);
      if (fromMeter > meterAvail) return { ok: false, err: "mint-exceeds-measured-fees", gas: 0 };
      pushNonce(st, dedupeKey); st.stats.opsTotal++; // אפס-גז — כמו relay
      st.treasuryProfit -= fromProfit;
      st.feeMeter -= fromMeter;
      st.feeMinted = (st.feeMinted ?? 0) + fAmt;
      st.credits[fTo] = (st.credits[fTo] ?? 0) + fAmt;
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "mint_fuel", note: `+${fAmt}µ credits →${fTo} (fees-backed: profit ${fromProfit} + meter ${fromMeter})` });
      return { ok: true, gas: 0 };
    }
    case "order": {
      // פקודת-לימיט מוסדית (סטנדרט-בורסות): חפיפה-מיידית כ-taker במחיר-המייקר,
      // ושארית נחה בספר. אין-חפיפה כלל → מנוחה-מלאה. נעילה-מראש על מלוא-הכמות;
      // matchBook משחרר-במדויק לכל-רגל — הנעילה נשארת מדויקת-בסוף (מורשת saos-dex).
      // FIX(escrow): בנתיב-אין-חפיפה הפקודה נחה עם-הנעילה-שלה — שחרור-הנעילה
      // לפני-המנוחה יצר פקודה בלתי-מגובה (uncollateralized) שמילויה-כמייקר
      // משחרר נעילות-פנטום (נתפס-ע"י invariant: escrow-underflow — HALT).
      const px = op.price ?? 0, amt = op.amount ?? 0;
      // FIX(SETTLE-9 fail-closed): הצבע-החד (op.side?op.base:op.quote) היה-לפני כל-
      // אימות — פרמטרים-זבל נדחו רק במקרה (תאונת-escrow). אימות-מפורש לפני-הכל.
      if ((op.side !== "buy" && op.side !== "sell")
        || !ASSETS.includes(op.base as Asset) || !ASSETS.includes(op.quote as Asset)
        || op.base === op.quote)
        return { ok: false, err: "bad-order-params", gas: 0 };
      const lockAsset = (op.side === "sell" ? op.base : op.quote) as string;
      const lockMu = op.side === "sell" ? amt : notional(px, amt);
      if (!(px > 0) || !(amt > 0) || !(lockMu > 0)) return { ok: false, err: "bad-price-amount", gas: 0 };
      if (!Number.isSafeInteger(lockMu)) return { ok: false, err: "lock-overflow", gas: 0 }; // FIX(R15-a): ראה trig_order
      // FIX(Roast-65-a · HIGH-1): שער-שלמים בכניסה-ל-op — price/amount גולמיים (2500.5)
      // נכנסו-לספר/לנעילה (הוכח-חי P2), המצב-הקנוני הפך-רעיל ו-stateRoot זרק CanonicalError
      // בכל-חישוב. "אין-float במצב" היה-הצהרה, לא-שער. נדחה-לפני-כל-נגיעה-במצב.
      if (!Number.isSafeInteger(px) || !Number.isSafeInteger(amt))
        return { ok: false, err: "non-integer-price-amount", gas: 0 };
      if (st.orders.filter((o) => o.live && o.owner === op.issuer).length >= 24)
        return { ok: false, err: "order-cap", gas: 0 };
      if (avail(st, op.issuer, lockAsset) < lockMu) return { ok: false, err: "insufficient-escrow", gas: 0 };
      addLock(st, op.issuer, lockAsset, lockMu);
      const lockBefore = lockedOf(st, op.issuer, lockAsset);
      // FIX(SETTLE-7 double-escrow): הנעילה כבר-על-הספר (שורה למעלה) — מעבירים
      // preLocked=true כדי-ש-matchBook לא-ידרוש שוב avail ≥ lockMu (הזמין כבר-ירד
      // בגובה-הנעילה!). החור-ההיסטורי: חשבון-עם **בדיוק** הערבות-הנדרשת קיבל
      // "insufficient-taker" — כל-פקודת-לימיט חייבה 2× ערבות, והדחייה הייתה שקטה
      // (ה-route מדווח "queued", buildBlock מוריד-את-ה-op בלי-עדה).
      const cross = matchBook(st, op, nowMs, consume, true, gas); // FIX(Roast-65-a · LOW-12): הגז-האמת עובר-לתוצאה
      if (cross.ok) {
        // שחרור-אבק-רצפה: floor לא-אדיטיבי עלול להשאיר נעילה-עודפת בלי-פקודה
        // מאחוריה — מכוונים את הנעילה בדיוק לשארית (או-אפס אם-מולאה-כולה).
        // FIX(escrow-units): שארית-הנעילה חייבת-להיות באותו-יחידות של-הנעילה-המקורית:
        //  · sell → הנעילה היא בסיס-µ (lockMu=amt) → שארית = filledMu (לא-notional!)
        //  · buy  → הנעילה היא ציטוט-µ (lockMu=notional) → שארית = notional(px,filledMu)
        // הבאג-ההיסטורי: notional(px,filledMu) על-sell במחיר-px<1000 (WSTEEM) שחרר
        // 1−px/1000 מהנעילה של-השארית → cancel מאוחר = escrow-underflow:cancel → HALT
        // (נתפס-ע"י-ה-invariant — fail-fast עבד; השורש תוקן כאן).
        const filledMu = amt - (cross.events ? cross.events.reduce((a, e) => a + e.amountMu, 0) : 0);
        const expectedLock = filledMu > 0 ? (op.side === "sell" ? filledMu : notional(px, filledMu)) : 0;
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
        lockMu: lockMu, // מד-הנעילה-הפרטי — הפקודה נחה עם-הנעילה-המלאה שלה
      });
      // FIX(Roast-65-a · LOW-12): פקודה-נחה מדווחת gas:0 למרות-consume-חייב 60 — חוזה-
      // {ok,gas} (ראש-הקובץ) שיקר. מדווחים את-הגז-שנחייב-בפועל.
      return { ok: true, gas };
    }
    case "fill": {
      // טייק-מיידי: חוצה את הספר לפי מחיר-מייקר (saos-dex).
      // FIX(SETTLE-7): fill הוא **market-בלבד** — fill-limit עובר את matchBook כ-taker
      // limit בלי-נעילת-מראע, ומשחרר-נעילות שלא-הוצבו (addLock שלילי →
      // escrow-underflow → HALT של-השרשרת כולה). דחייה-מפורשת fail-closed:
      // מי-שרוצה limit חוצה — משתמש ב-"order" (נועל-מראע בגרעין).
      if (!op.market) return { ok: false, err: "limit-fill-unsupported", gas: 0 };
      const r = matchBook(st, op, nowMs, consume, false, gas); // FIX(Roast-65-a · LOW-12): הגז-האמת עובר-לתוצאה
      return r;
    }
    case "cancel": {
      const r = cancelOrder(st, op, consume, gas); // FIX(Roast-65-a · LOW-12): הגז-האמת עובר-לתוצאה
      return r;
    }
    case "order_gc": {
      const c = consume(); if (c) return c;
      gcOrders(st); // FIX(SETTLE-9 dead-code): ה-events שנבנו-כאן היו void-תמיד — הוסרו (כנות: gc מנקה-מצב, אין-אירועי-סליל)
      return { ok: true, gas, events: [] };
    }
    case "pool_open": {
      // Roast-71 · POOL-OPEN: פתיחת-בריכה-חדשה-בזמן-ריצה על נכסים-רשומים.
      // עד-היום בריכות-נולדו-רק-בג'נזיס (seedPool-hardcoded) או-בחתימת-השקה
      // (launchpad-graduation) — מה-שהשאיר נכסים-רשומים-עם-מחזיקים-אמת
      // (WSBD/PHIVE/WBLURT) בלי-יציאה-כלל (tier-none בראוטר — בלי-המרה).
      // פתיחת-בריכה = מעשה-ריבוני-של-האוצר: זריעה-דו-צדדית-מהיתרות-שלו,
      // LP=√k כולו-לאוצר (כמו-ג'נזיס), fail-closed על-כל-שלב.
      if (issuer !== "treasury") return { ok: false, err: "treasury-only", gas };
      const oKey = String(op.pair ?? "");
      if (!oKey) return { ok: false, err: "pair-required", gas: 0 };
      const parts = oKey.split("/");
      if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, err: "bad-pair", gas: 0 };
      const canon = poolKey(parts[0], parts[1]);
      if (oKey !== canon) return { ok: false, err: "non-canonical-pair", gas: 0 };
      if (st.pools[canon]) return { ok: false, err: "pool-exists", gas: 0 };
      if (!knownAsset(st, parts[0]) || !knownAsset(st, parts[1])) return { ok: false, err: "asset-not-listed", gas: 0 };
      const amtA = op.amount ?? 0, amtB = op.amountB ?? 0;
      if (!(amtA > 0) || !(amtB > 0)) return { ok: false, err: "dust-open", gas: 0 };
      if (avail(st, "treasury", parts[0]) < amtA) return { ok: false, err: "insufficient-treasury", gas: 0 };
      if (avail(st, "treasury", parts[1]) < amtB) return { ok: false, err: "insufficient-treasury", gas: 0 };
      const c = consume(); if (c) return c;
      const lpMint = sqrtLp(amtA, amtB); // FIX(R16-a·m8)
      st.pools[canon] = { a: parts[0] as Asset, b: parts[1] as Asset, ra: amtA, rb: amtB, lp: lpMint, feeAccruedTreasury: 0, swaps: 0 };
      addBal(st, "treasury", parts[0], -amtA);
      addBal(st, "treasury", parts[1], -amtB);
      addBal(st, "treasury", LP_ASSET_PREFIX + canon, lpMint);
      st.journal.push({ h: st.height, t: nowMs, soldier: "treasury", action: "pool_open", note: `${canon} ${amtA}+${amtB}µ · LP ${lpMint}µ` });
      return { ok: true, gas };
    }
    case "pool_repeg": {
      // R26 · POOL-REPEG (ריענון-עוגן-רשת): סימון-מחדש של בריכה בבעלות-מלאה לעוגן-האמת.
      // הבעיה-החיה (2026-09-17, h18553): בריכת USDS/WSTEEM נסחרה mid=473µ בעוד
      // העוגן-האורקל החי (STEEM בפועל) = 54µ — פער 8.8x. ה-fairPrice המעורבב
      // (ספר 50% + בריכה 30% + עוגן 20%) יצר-נקודת-שבת-עצמית: הספר-העצמי נתן
      // לעצמו לגיטימציה. מי-שהיה-מפקיד STEEM אמת דרך-הדלת (wrap 1:1) היה-מוכר
      // WSTEEM ב-473µ — מדפיס-כסף-חינם על-חשבון-האוצר. זהו-כשל-כלכלי-P0.
      // הפיתרון: כיוון-שהבריכה 100% בבעלות-האוצר (polShare=10000; אין-LP-חוץ;
      // pool_rmw-של-אוצר נעול-לנצח מ-הג'נזיס) — סימון-מחדש ריבוני הוא-הכלי-הכנה:
      // ra נקבע-כך-שמחיר-הבריכה יהיה-העוגן; העודף חוזר-לאוצר (או האוצר משלים).
      // אפס-הטבעה · אפס-שריפה · Σ(balances+pool-reserves) נשמר-בדיוק (המבקר-הברזל
      // ירוק) · LP לא-נגע · הכל-מגולל-ביומן. הכיוון-הכפול: גם-בריכה-זולה-מהעוגן
      // מושלמת-ממלאי-האוצר (במלאי-קיים-בלבד — fail-closed).
      if (issuer !== "treasury") return { ok: false, err: "treasury-only", gas: 0 };
      const rKey = String(op.pair ?? "");
      if (!rKey) return { ok: false, err: "pair-required", gas: 0 };
      const parts = rKey.split("/");
      if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, err: "bad-pair", gas: 0 };
      const canon = poolKey(parts[0], parts[1]);
      if (rKey !== canon) return { ok: false, err: "non-canonical-pair", gas: 0 };
      const p = st.pools[canon];
      if (!p) return { ok: false, err: "pool-not-found", gas: 0 };
      // עוגן-דו-צדדי: refPrice של-שני-הצדדים (µ-USDS ל-1-יחידה). היעד: מחיר-1-B
      // במונחי-A === refB/refA. עבור USDS/WSTEEM: 54/1000 → ra_new = 54×rb/1000.
      const refA = st.assets[p.a]?.refPrice ?? 0;
      const refB = st.assets[p.b]?.refPrice ?? 0;
      if (!(refA > 0) || !(refB > 0)) return { ok: false, err: "no-anchor", gas: 0 };
      if (!(p.rb > 0)) return { ok: false, err: "empty-pool", gas: 0 };
      const raNew = Math.floor((refB * p.rb) / refA);
      if (!(raNew > 0)) return { ok: false, err: "bad-anchor", gas: 0 };
      const delta = raNew - p.ra;
      if (delta === 0) return { ok: false, err: "on-anchor", gas: 0 };
      if (delta > 0 && avail(st, "treasury", p.a) < delta) return { ok: false, err: "insufficient-treasury", gas: 0 };
      const c = consume(); if (c) return c;
      const midOld = Math.floor((p.ra * 1000) / p.rb);
      if (delta > 0) { addBal(st, "treasury", p.a, -delta); p.ra += delta; }
      else { p.ra += delta; addBal(st, "treasury", p.a, -delta); }
      const midNew = Math.floor((p.ra * 1000) / p.rb);
      st.journal.push({ h: st.height, t: nowMs, soldier: "treasury", action: "pool_repeg", note: `${canon} mid ${midOld}→${midNew}µ (anchor refB/refA=${Math.floor((refB * 1000) / refA) / 1000}) · ${delta > 0 ? "+" : ""}${delta}µ ${p.a} ${delta > 0 ? "treasury→pool" : "pool→treasury"} · Σ נשמר` });
      return { ok: true, gas };
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
      if (op.type === "wrap_mint" && op.external === true) {
        // TRUTH-RAIL (Task 61): הטבעה-מגובה-חוץ — הגיבוי הוא נכס-אמת על-שרשרת-חוץ
        // (BLURT-אמת ב-headcorner). אוצר-בלבד + תביעה-חובה; מנוע-ה-Truth מאמת-חי
        // מול-RPC-ציבורי שהגיבוי באמת קיים — אם-לא, דגל-BACKING-BROKEN-פומבי.
        // FIX(Roast-64 · double-mint): תביעה-ששימשה-כבר-נדחית — בלי-זה שתי-קריאות-
        // rail באותו-חלון הטביעו פעמיים מול-גיבוי-אחד (ההוכחה-הקיימת מוחזרת-שוב).
        // במקביל truth.ts שולח-claim-ייחודי-פר-טיק (height:deficit) — רובד-שני.
        if (issuer !== "treasury") return { ok: false, err: "treasury-only", gas };
        if (!op.claim) return { ok: false, err: "external-claim-required", gas };
        // FIX(Roast-65-a · LOW-10): טבעת-תביעות-בשימוש במצב — ה-dedupe היה slot-יחיד
        // (extBack[a].claim זוכר רק את האחרונה; רצף C1,C2,C1 עבר). הבדיקה-הישנה נשארת
        // שכבה-שנייה (תאימות-תמונות-ישנות).
        if ((st.extClaims ?? []).includes(op.claim)) return { ok: false, err: "claim-already-used", gas };
        if (st.extBack?.[a]?.claim === op.claim) return { ok: false, err: "claim-already-used", gas };
        // FIX(R17-b·M1): שכבה-שלישית — טבעת-פר-נכס. הטבעת-הגלובלית (256) שוחקת-אחרי-
        // 256-תביעות-מכל-הנכסים; טבעת-הנכס (64) שוחקת-רק-אחרי-64-תביעות-של-אותו-נכס —
        // חזרה-על-claim-ישן-חייבת-כעת 64-תביעות-חוץ-אמת-של-אותו-נכס (עלות-אמת, לא-בג-חינם).
        if ((st.extClaimsBy?.[a] ?? []).includes(op.claim)) return { ok: false, err: "claim-already-used", gas };
        const ce = consume(); if (ce) return ce;
        // FIX(R15-a): addBal קודם — אם-הוא-זורק, ה-backing לא-נגע (היה: backing+= קודם,
        // addBal זרק → גיבוי-נרשם בלי-יתרה = מצב-סותר).
        addBal(st, issuer, a, amt);
        st.backing[a] = (st.backing[a] ?? 0) + amt;
        st.extClaims = [...(st.extClaims ?? []), op.claim].slice(-256); // FIX(Roast-65-a · LOW-10): טבעת-חסומה — גידול-מצב חסום, אין-זליגת-זיכרון
        st.extClaimsBy = { ...(st.extClaimsBy ?? {}), [a]: [...(st.extClaimsBy?.[a] ?? []), op.claim].slice(-64) }; // FIX(R17-b·M1)
        st.extBack = { ...(st.extBack ?? {}), [a]: { claim: op.claim, mu: (st.extBack?.[a]?.mu ?? 0) + amt, atH: st.height } };
        // FIX(Roast-64 · journal-mislabel): הרשומה הייתה עם t:0 (זמן-מזויף) ו-
        // profitMu:amt (הטבעה-מגובה אינה רווח — זיהוי-שקר שהנפיח-כל-Σprofit).
        st.journal.push({ h: st.height, t: nowMs, soldier: "treasury", action: "wrap_mint_ext", note: `external-backed mint ${amt}µ ${a} (${op.claim})` });
        return { ok: true, gas };
      }
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
    case "oracle_set": {
      // Task 72 · THE-COIN-DOOR: אורקל-מחירים קנוני — נתון-שוק-אמת נכנס למצב.
      // אוצר-בלבד · ערכים-שלמים fail-closed · src כתווית-גלויה · מדדי-dedupe רגילים.
      if (issuer !== "treasury") return { ok: false, err: "treasury-only", gas };
      const prices = op.prices;
      if (!prices || typeof prices !== "object" || Array.isArray(prices)) return { ok: false, err: "prices-required", gas: 0 };
      const entries = Object.entries(prices);
      if (entries.length === 0) return { ok: false, err: "prices-empty", gas: 0 };
      const clean: Record<string, { mu: number; atH: number; src: string }> = {};
      for (const [a, v] of entries) {
        if (!a || a.length > 24 || FORBIDDEN_KEYS.has(a)) return { ok: false, err: "bad-oracle-asset", gas: 0 };
        if (!Number.isSafeInteger(v) || v <= 0) return { ok: false, err: "bad-oracle-price", gas: 0 };
        clean[a] = { mu: v, atH: st.height, src: String(op.claim ?? "ext").slice(0, 40) };
      }
      const c = consume(); if (c) return c;
      st.oracle = { ...(st.oracle ?? {}), ...clean };
      // R23 · LIVE-ANCHOR: העוגן עוקב אחרי השוק האמיתי. המדידה שהוכיחה את הכשל:
      // refPrice(WSTEEM)=320mµ ($0.32) מול STEEM אמיתי $0.0552 — פער 5.8x שהחזיק מעודף
      // כי-שום-דבר לא חיבר את האורקל הקנוני לעוגן. עתה כל יישום oracle_set מקרב
      // את refPrice של נכס רשום אל מחיר החוץ: מדומם חצי-פער, תקרה 0.5% בפער-שגרה,
      // עד-25% כשהפער הגולמי >10% (עוגן מיושן מדביק מציאות). אותו הגהון של הסולם
      // (keel), בכיוון האורקל. USDS — יחידת החשבון — לעולם לא זז. דטרמיניסטי מלא:
      // פונקציה טהורה של ה-op והמצב — ריפליי משחזר ביט-לביט.
      const glides: string[] = [];
      for (const [a, rec] of Object.entries(clean)) {
        if (a === "USDS") continue; // יחידת-החשבון לא נעוגנת-מחדש
        const cur = st.assets[a];
        if (!cur || !(cur.refPrice > 0)) continue; // נכס לא-רשום: אין עוגן להזיז
        const target = Math.round(rec.mu / 1000); // אורקל ב-µ$-ליחידה; refPrice ב-mµ-ליחידה
        if (!(target > 0) || target === cur.refPrice) continue;
        const ref = cur.refPrice;
        const gapBps = Math.floor((Math.abs(target - ref) * 10_000) / ref);
        const capPct = gapBps > 1_000 ? 0.25 : 0.005; // פער-גולמי = עוגן-מיושן
        const halfGap = Math.floor(Math.abs(target - ref) / 2);
        const step = Math.max(1, Math.min(Math.floor(ref * capPct), halfGap));
        const next = target > ref ? Math.min(target, ref + step) : Math.max(target, ref - step);
        if (next > 0 && next !== ref) {
          st.assets[a] = { refPrice: next, listed: cur.listed };
          glides.push(`${a} ${ref}>${next} of ${target}`);
        }
      }
      st.journal.push({ h: st.height, t: nowMs, soldier: "treasury", action: "oracle_set", note: `${Object.keys(clean).sort().join(",")} <- ${String(op.claim ?? "ext").slice(0, 40)}${glides.length ? ` · anchor ${glides.join(" ")}` : ""}` });
      return { ok: true, gas };
    }
    case "asset_list":
    case "asset_price": {
      if (issuer !== "treasury") return { ok: false, err: "treasury-only", gas };
      const a = op.asset;
      if (!a) return { ok: false, err: "asset-required", gas };
      // FIX(R15-a · proto-gate): asset_list/asset_price היו המקום-האחרון בלי-FORBIDDEN_KEYS
      // — treasury-op יכול היה לכתוב st.assets["__proto__"] ולהרעיל-אב-טיפוס (אותה-מחלקה
      // Roast-64 סגרה ל-accounts). הגנת-עומק בדלת-ה-op.
      if (FORBIDDEN_KEYS.has(a)) return { ok: false, err: "forbidden-asset", gas };
      // FIX(R16-a·m9): תקרת-אורך כמו-oracle_set — קוד-נכס-בלתי-מוגבל היה-נכנס-למצב-הקנוני
      // (נפיחות-שורש-קנוני/עלות-קנוניזציה). עתה: ≤24-תווים, בדיוק-כמו-האורקל.
      if (a.length > 24) return { ok: false, err: "bad-asset-length", gas };
      if (op.type === "asset_list" && st.assets[a]) return { ok: false, err: "already-listed", gas };
      // FIX(Roast-65-a · HIGH-1): refPrice גולמי (asset_price) היה נכנס למצב-הקנוני כמו-שהוא
      // (float/NaN → CanonicalError-נצחי). שער-שלמים fail-closed על-שני-ה-ops (list/price).
      if (op.refPrice !== undefined && !(Number.isSafeInteger(op.refPrice) && op.refPrice > 0))
        return { ok: false, err: "bad-ref-price", gas: 0 };
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
      // FIX(Roast-64): relay_ack-ללא-קישור — הדלת-והאישור-עכשיו קשורים-במונה:
      // relay פותח (relayOpen++), relay_ack סוגר (חייב >0). אישור-בלי-דלת-פתוחה
      // = רעש-פורמלי — נדחה כעת (fail-closed).
      st.relayOpen = (st.relayOpen ?? 0) + 1;
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "relay", note: `→${op.to} ${(op.memo ?? "").slice(0, 30)}` });
      return { ok: true, gas: 0 };
    }
    case "relay_ack": {
      if ((st.relayOpen ?? 0) <= 0) return { ok: false, err: "no-open-relay", gas: 0 };
      pushNonce(st, dedupeKey); st.stats.opsTotal++;
      st.relayOpen = (st.relayOpen ?? 0) - 1;
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "relay_ack", note: (op.memo ?? "").slice(0, 30) });
      return { ok: true, gas: 0 };
    }
    case "heartbeat": {
      const c = consume(); if (c) return c;
      return { ok: true, gas };
    }
    /* ── Task 80 · THE-VAULT — כספת-ההלוואות המינימלית ─────────────────────────── */
    case "vault_open": {
      // שאיבת USDS נגד בטחונות WSTEEM (CDP): ההטבעה-כנגד-הבטחונות היא-ההנפקה,
      // הפירעון הוא-השריפה. כל-הבדיקות לפני-כל-נגיעה-במצב (עסקה-לא-חוקית לא-נוגעת).
      // issuedMu = הצהרת-ההיצע לביקורת-הספרים (ledgerAudit): ההטבעה נספרת-בגלוי,
      // השריפה בפירעון — אחרת ביקורת-הברזל עוצרת-את-השרשרת (כפי-שהוכח-בהוכחה-המקומית).
      const amt = op.amount ?? 0, draw = op.drawMu ?? 0;
      if (op.asset !== VAULT_COLLATERAL) return { ok: false, err: "vault-wsteem-only", gas: 0 };
      if (!Number.isSafeInteger(amt) || amt <= 0) return { ok: false, err: "bad-amount", gas: 0 };
      if (!Number.isSafeInteger(draw) || draw <= 0) return { ok: false, err: "bad-draw", gas: 0 };
      if (avail(st, issuer, VAULT_COLLATERAL) < amt) return { ok: false, err: "insufficient-collateral", gas };
      const prev = st.vaults?.[issuer];
      const colMu = (prev?.colMu ?? 0) + amt;
      const colVal = vaultColValueMu(st, colMu);
      if (colVal <= 0) return { ok: false, err: "no-collateral-price", gas: 0 };
      const rate = vaultRateBps(st);
      const prevBase = prev ? prev.debtMu + prev.intMu : 0;
      const oldEff = prev ? vaultEffDebtMu(prevBase, rate, prev.atH, st.height) : 0;
      // חלוקה-מדויקת של החוב החדש: הקרן (ישנה + השאיבה הטרייה) + הריבית שנצברה-עד-עתה.
      // תיקון-הוכחה-מקומית: ה-draw חייב-להיכנס-לקרן — אם-הוא נשמט, השאיבה כסף-חינם
      // (32 מחזורים × 2160µ הודפסו בלי חוב — הביקורת יראה זאת כהיצע-כשר כי issuedMu נספר,
      // אבל הכלכלה שקרית. ההוכחה המקומית תפסה את זה לפני שזה נגע בשרשרת-האמת).
      const debtMu = (prev?.debtMu ?? 0) + draw;
      const intMu = oldEff - (prev?.debtMu ?? 0); // ריבית מונפת-קודמת + צבירה-טרייה
      const totalDebt = debtMu + intMu; // === oldEff + draw (התביעה-הכוללת)
      const maxDebt = Math.min(Math.floor((colVal * 100) / VAULT_MIN_CR_PCT), VAULT_DEBT_CAP_MU);
      if (totalDebt > maxDebt) return { ok: false, err: "collateral-ratio", gas: 0 };
      let others = 0;
      for (const [k, v] of Object.entries(st.vaults ?? {})) if (k !== issuer) others += v.debtMu + v.intMu;
      if (others + totalDebt > VAULT_GLOBAL_CAP_MU) return { ok: false, err: "global-debt-cap", gas: 0 };
      const c = consume(); if (c) return c;
      addBal(st, issuer, VAULT_COLLATERAL, -amt);
      addBal(st, VAULT_POT, VAULT_COLLATERAL, amt);
      addBal(st, issuer, "USDS", draw); // שאיבה = הטבעה-כנגד-בטחונות (ספק-CDP אמת)
      st.vaults = { ...(st.vaults ?? {}), [issuer]: { colMu, debtMu, intMu, atH: st.height } };
      st.vaultTot = { ...vaultTotals(st), opened: vaultTotals(st).opened + 1, issuedMu: vaultTotals(st).issuedMu + draw };
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "vault_open", note: `+${amt}µ ${VAULT_COLLATERAL} → draw ${draw}µ USDS · CR ${Math.floor((colVal * 100) / totalDebt)}% · issued ${vaultNetSupplyMu(st)}µ` });
      return { ok: true, gas };
    }
    case "vault_repay": {
      // פירעון + שחרור: הריבית שנצברה → הכנסת אוצר; הקרן נשרפת (היא הוטבעה-בשאיבה).
      // חשבונאות-מפוצלת מדויקת: כל-תשלום נחתך-קודם-כריבית (עד-גובה-הריבית-הכוללת),
      // השארית-קרן — השריפה נספרת-ב-burnedMu וההיצע נשאר-מדויק-מול-הביקורת-לעולם.
      const v = st.vaults?.[issuer];
      if (!v) return { ok: false, err: "no-vault", gas: 0 };
      const repay = Math.floor(op.repayMu ?? 0), wd = Math.floor(op.withdrawMu ?? 0);
      if (repay < 0 || wd < 0) return { ok: false, err: "bad-args", gas: 0 };
      if (repay === 0 && wd === 0) return { ok: false, err: "nothing-to-do", gas: 0 };
      const rate = vaultRateBps(st);
      const base = v.debtMu + v.intMu;
      const eff = vaultEffDebtMu(base, rate, v.atH, st.height);
      const accrued = eff - base;
      const pay = Math.min(repay, eff);
      if (avail(st, issuer, "USDS") < pay) return { ok: false, err: "insufficient-usds", gas };
      const totalInterest = v.intMu + accrued;
      const interestPart = Math.min(pay, totalInterest);
      const principalPart = pay - interestPart;
      const newDebtMu = v.debtMu - principalPart;
      const newIntMu = totalInterest - interestPart;
      const newEff = newDebtMu + newIntMu;
      const newCol = v.colMu - wd;
      if (newCol < 0) return { ok: false, err: "over-withdraw", gas: 0 };
      if (newEff > 0) {
        const colVal = vaultColValueMu(st, newCol);
        if (Math.floor((colVal * 100) / newEff) < VAULT_MIN_CR_PCT) return { ok: false, err: "collateral-ratio", gas: 0 };
      }
      const c = consume(); if (c) return c;
      addBal(st, issuer, "USDS", -pay);
      if (interestPart > 0) addBal(st, "treasury", "USDS", interestPart); // ריבית = הכנסת-אוצר (לא-הוטבעה-מעולם)
      const vt = vaultTotals(st);
      const nextTot = principalPart > 0 ? { ...vt, interestMu: vt.interestMu + interestPart, burnedMu: vt.burnedMu + principalPart }
                                        : (interestPart > 0 ? { ...vt, interestMu: vt.interestMu + interestPart } : vt);
      if (wd > 0) { addBal(st, VAULT_POT, VAULT_COLLATERAL, -wd); addBal(st, issuer, VAULT_COLLATERAL, wd); }
      const maps = { ...(st.vaults ?? {}) };
      if (newEff <= 0 && newCol <= 0) {
        delete maps[issuer];
        st.vaultTot = { ...nextTot, repaid: nextTot.repaid + 1 };
      } else {
        maps[issuer] = { colMu: newCol, debtMu: newDebtMu, intMu: newIntMu, atH: st.height };
        st.vaultTot = nextTot;
      }
      st.vaults = maps;
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "vault_repay", note: `pay ${pay}µ USDS (ריבית ${interestPart}µ→אוצר · קרן ${principalPart}µ→שריפה) · free ${wd}µ ${VAULT_COLLATERAL} · debt ${newEff}µ` });
      return { ok: true, gas };
    }
    case "vault_liquidate": {
      // נזילות-אזרח: כספת שנפלה מתחת-ל-150% — כל-אחד יכול-לסגור-חוב-ולקחת-בטחונות+5%.
      // כנות-כפולה: מתחת-ל-100% אין-רווח-למפרק — רק-האוצר (backstop), לא-תיאטרון.
      // חשבונאות: המפרק משלם את-החוב-הכולל; הריבית → אוצר, הקרן נשרפת (burnedMu).
      const owner = String(op.owner ?? "").toLowerCase();
      if (!owner || FORBIDDEN_KEYS.has(owner)) return { ok: false, err: "bad-owner", gas: 0 };
      const v = st.vaults?.[owner];
      if (!v) return { ok: false, err: "no-vault", gas: 0 };
      const rate = vaultRateBps(st);
      const base = v.debtMu + v.intMu;
      const eff = vaultEffDebtMu(base, rate, v.atH, st.height);
      if (eff <= 0) return { ok: false, err: "no-debt", gas: 0 };
      const colVal = vaultColValueMu(st, v.colMu);
      const cr = Math.floor((colVal * 100) / eff);
      if (cr >= VAULT_LIQ_CR_PCT) return { ok: false, err: "not-liquidatable", gas: 0 };
      if (cr < 100) return { ok: false, err: "underwater-backstop-only", gas: 0 };
      const ref = st.assets[VAULT_COLLATERAL]?.refPrice ?? 0;
      if (ref <= 0) return { ok: false, err: "no-collateral-price", gas: 0 };
      const seizeVal = Math.floor((eff * (10_000 + VAULT_LIQ_BONUS_BPS)) / 10_000);
      const seizeMu = Math.min(v.colMu, Math.floor((seizeVal * 1000) / ref));
      if (avail(st, issuer, "USDS") < eff) return { ok: false, err: "insufficient-usds", gas };
      const c = consume(); if (c) return c;
      addBal(st, issuer, "USDS", -eff);
      const interestPart = eff - v.debtMu; // כל-הריבית-שנצברה (הונפה + חדשה)
      if (interestPart > 0) addBal(st, "treasury", "USDS", interestPart);
      const vt = vaultTotals(st);
      st.vaultTot = { ...vt, interestMu: vt.interestMu + interestPart, burnedMu: vt.burnedMu + v.debtMu, liquidations: vt.liquidations + 1 };
      addBal(st, VAULT_POT, VAULT_COLLATERAL, -seizeMu);
      addBal(st, issuer, VAULT_COLLATERAL, seizeMu);
      const restCol = v.colMu - seizeMu;
      const maps = { ...(st.vaults ?? {}) };
      if (restCol <= 0) delete maps[owner]; else maps[owner] = { colMu: restCol, debtMu: 0, intMu: 0, atH: st.height };
      st.vaults = maps;
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "vault_liquidate", note: `vault ${owner}: paid ${eff}µ USDS · seized ${seizeMu}µ ${VAULT_COLLATERAL} (CR was ${cr}%)` });
      return { ok: true, gas };
    }
    case "vault_backstop": {
      // כספת-שקועה (מפול-אורקל, CR<100%): האוצר סוגר-החוב משלו ולוקח-הכל —
      // ההפסד נרשם-במונה-הגלוי לכל-החיים (backstopLossMu), לא-מוסתר-ברווח.
      // חשבונאות-מדויקת: רק-הקרן (v.debtMu) הוטבעה-על-ידי-הכספת — היא-שנשרפת;
      // הריבית לא-הוטבעה-מעולם — האוצר משלם-אותה-לעצמו (קיזוז-טהור, אפס-היצע-נע).
      if (issuer !== "treasury") return { ok: false, err: "treasury-only", gas: 0 };
      const owner = String(op.owner ?? "").toLowerCase();
      if (!owner || FORBIDDEN_KEYS.has(owner)) return { ok: false, err: "bad-owner", gas: 0 };
      const v = st.vaults?.[owner];
      if (!v) return { ok: false, err: "no-vault", gas: 0 };
      const rate = vaultRateBps(st);
      const base = v.debtMu + v.intMu;
      const eff = vaultEffDebtMu(base, rate, v.atH, st.height);
      const colVal = vaultColValueMu(st, v.colMu);
      if (eff <= 0) return { ok: false, err: "no-debt", gas: 0 };
      if (Math.floor((colVal * 100) / eff) >= 100) return { ok: false, err: "not-underwater", gas: 0 };
      if (avail(st, "treasury", "USDS") < v.debtMu) return { ok: false, err: "treasury-short", gas };
      const c = consume(); if (c) return c;
      addBal(st, "treasury", "USDS", -v.debtMu); // הקרן-המוטבעת נשרפת-מיתרת-האוצר
      addBal(st, VAULT_POT, VAULT_COLLATERAL, -v.colMu);
      addBal(st, "treasury", VAULT_COLLATERAL, v.colMu);
      const maps = { ...(st.vaults ?? {}) }; delete maps[owner]; st.vaults = maps;
      const vt = vaultTotals(st);
      st.vaultTot = { ...vt, burnedMu: vt.burnedMu + v.debtMu, backstopLossMu: vt.backstopLossMu + (eff - colVal) };
      st.journal.push({ h: st.height, t: nowMs, soldier: "treasury", action: "vault_backstop", note: `vault ${owner}: debt ${eff}µ absorbed (principal ${v.debtMu}µ burned, interest self-offset) · loss ${eff - colVal}µ recorded forever` });
      return { ok: true, gas };
    }
    case "save_open": {
      // R40 · THE-SAVE: הפקדת-USDS לחיסכון — קרן בחשבון-עד, ריבית-מהכנסה-המדודה-בלבד.
      // כל-הבדיקות לפני-כל-נגיעה-במצב (עסקה-לא-חוקית לא-נוגעת) — אותו-דוקטרינה-כפר-הכספת.
      const amt = op.amount ?? 0;
      if (!Number.isSafeInteger(amt) || amt <= 0) return { ok: false, err: "bad-amount", gas: 0 };
      if (amt > SAVE_POS_CAP_MU) return { ok: false, err: "position-cap", gas: 0 };
      if ((st.savings?.potMu ?? 0) + amt > SAVE_CAP_MU) return { ok: false, err: "savings-cap", gas: 0 };
      if (avail(st, issuer, "USDS") < amt) return { ok: false, err: "insufficient-usds", gas };
      const c = consume(); if (c) return c;
      const s = st.savings ?? { positions: {}, potMu: 0, paidMu: 0, lastIncomeMu: vaultTotals(st).interestMu, dayPaidMu: 0, dayPaidPrevMu: 0, dayMarkH: st.height, opens: 0, closes: 0 };
      const prev = s.positions[issuer] ?? { mu: 0, owedMu: 0, atH: st.height };
      addBal(st, issuer, "USDS", -amt);
      addBal(st, SAVE_POT, "USDS", amt);
      st.savings = { ...s, positions: { ...s.positions, [issuer]: { mu: prev.mu + amt, owedMu: prev.owedMu, atH: st.height } }, potMu: s.potMu + amt, opens: s.opens + 1 };
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "save_open", note: `+${amt}µ USDS → save-pot (pot ${s.potMu + amt}µ · ${Object.keys(st.savings.positions).length} savers) · income: measured vault-interest pass-through` });
      return { ok: true, gas };
    }
    case "save_close": {
      // R40 · THE-SAVE: משיכה — קרן + כל-הריבית-שנצברה-מהכנסה-שהגיעה-בפועל.
      // אמת-כפולה: הסירה-המלאה מוכחת-בהוכחה-המקומית; על-השרשרת-החיה העמדות-העומדות
      // צוברות-ונשארות — ההפך-מתיאטרון-מחזורי-ריק.
      const s = st.savings;
      const pos = s?.positions[issuer];
      if (!pos || pos.mu + pos.owedMu <= 0) return { ok: false, err: "no-position", gas: 0 };
      const amt = Math.floor(op.amount ?? -1); // השמטה/-1 = הכל
      if (amt === 0) return { ok: false, err: "bad-amount", gas: 0 };
      const takeMu = amt < 0 ? pos.mu : Math.min(amt, pos.mu);
      const owed = pos.owedMu;
      if (avail(st, SAVE_POT, "USDS") < takeMu + owed) return { ok: false, err: "pot-short", gas: 0 };
      const c = consume(); if (c) return c;
      addBal(st, SAVE_POT, "USDS", -(takeMu + owed));
      addBal(st, issuer, "USDS", takeMu + owed);
      const restMu = pos.mu - takeMu;
      const maps = { ...s!.positions };
      if (restMu <= 0) delete maps[issuer]; else maps[issuer] = { mu: restMu, owedMu: 0, atH: st.height };
      st.savings = { ...s!, positions: maps, potMu: s!.potMu - takeMu, paidMu: s!.paidMu + owed, closes: s!.closes + 1 };
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "save_close", note: `withdraw ${takeMu}µ + interest ${owed}µ (measured income, never minted) · pot ${s!.potMu - takeMu}µ` });
      return { ok: true, gas };
    }
    default:
      return { ok: false, err: "unhandled-op", gas: 0 };
  }
}

export { canon, sha256, stateRootOf };
