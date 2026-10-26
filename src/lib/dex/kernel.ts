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
import { createHtlc, claimHtlc, refundHtlc, type HtlcRecord } from "./htlc"; // G70 §7.2 · הגשר-האטומי-הפנימי
import { recordHtlcReceipt, type HtlcReceipt } from "./htlc-receipts"; // W49-b · קבלות-השרשרת של-הגשר-האטומי (hash-chained)
import { invariant } from "./invariant"; // EXEC-CD-8 · cancel_all — אותו-ברזל-אסקרו של-book.ts
import { cancelOrder, matchBook, gcOrders, sortBook, type BookOrder } from "./book";
import { poolAdd, poolSwap, poolRm, LP_ASSET_PREFIX } from "./amm";

// ─── טבלת-GAS (מפרט-הברזל + הרחבות 96–113 של kernel.cjs) ────────────────────
// SETTLE-5 "לוח-זמנים-סיבולת": קיזוז-שריפה בפעולות-התדר-הגבוהות (סדר/ביטול/
// מילוי/סוופ-בריכה) — ספר-סגור שורף 990µ/בלוק בעוד עמלות-נמדדות חוזרות ב-~3µ/
// בלוק (ממצא-חי 2026-09: ארנה 1.7M→922k ב-11 דק׳). קיזוז-זה נותן לפונטיין
// ולממנים לנשום: שריפה ~3× נמוכה = ריצה ~3× ארוכה, והעמלות מצטברות אל מעל
// סף-הפונטיין. פעולות-נדירות (wrap/attest/harvest) לא-נוגעו — אין-טעם.
// ── W1.4 · TOLL-RECALIBRATION (2026-10-17, הנחיית-בעלים "הרחב לשפר — הכל רץ ברמה הכי גבוהה") ──
// מדידה: ביט-השחרור f1de244 שרף 796,602µ בביט-אחד (Σ 816,830→20,228) בזמן שהמחזור
// החזיר 4.5Mµ **בכל-ההיסטוריה** — פער ~100× בין מחיר-הגז לכושר-נשיאה של ההיצע
// (Σ=12.8Kµ = 1.2% מהג'נזיס). אותה-מחלה שתוקנה ב-heartbeat (288Kµ/יום) וב-attest
// (15Kµ/שעה) — הפעם במסילה-החמה. הדוקטרינה קיימת בקוד: "מגן-הספאם-האמיתי הוא
// מבני ולא מחיר" (Roast-66/EXEC-CD-8/46). רצפת 1µ נשמרת (כל-op-עולה-משהו);
// ה-op-ים הנדירים-האנושיים (vault/lend/launch/ve) נשארים-במחירם. אפס-הטבעה —
// האינווריאנטה Σcredits+gasUsed−feeMinted===ג'נזיס נשמרת; הפיך-בגיט.
export const GAS_TABLE = {
  transfer: 1,
  pay: 1,
  order: 1,
  cancel: 1,
  // EXEC-CD-8 · CANCEL-ALL: ביטול-סוויפ-אטומי של-כל-הפקודות-החיות של-המנפיק
  // (אופציונלי: מסונן-זוג). סטנדרט-מייקרים-מקצועיים (Binance deleteAllOrders):
  // רענון-גריד חייב טשאט-ריקון בפעולה-אחת — מול-מירוץ-קריאה/שליחה של ביטולים
  // פר-מזהה. גז = כמו-ביטול-יחיד (15) — מעודד-שימוש-בסוויפ על-פני סדרת-ביטולים.
  cancel_all: 1,
  fill: 1,
  order_gc: 1,
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
  // G76-a · POOL-RESEED — החייאה דו-צדדית של בריכת-USDS מתה על-העוגן (מנדט §4:
  // USDS trading pairs + AMM liquidity pools). נמדד-חי (h1750085): USDS/WSBD נשאב
  // עד rb=1µ — ה-repeg מחשב raNew=refB×rb/refA=0 → "bad-anchor" נדחה-כל-פעימה,
  // ו-pool_add נופל-ב-dust (amountB=floor(1×addA/11937)=0). אין-נתיב-חוקי-קיים.
  // ה-reseed מחזיר-רזרבות-לאוצר, שורף-LP-אוצר (נעול-לצמיתות ממילא), וזורע-שני-צדדים
  // ביחס-העוגן המדויק ממלאי-חופשי-בלבד (fail-closed). אפס-גז — משפחת-הערוצים
  // הריבוניים (pool_open/pool_repeg): המגן-המבני הוא אוצר-בלבד + LP-אזרחי-אסור +
  // שער-"בריכה-מתה" (רק מעל 10,000bps מהעוגן או raRepeg≤0) + זרע-עוגן-מדויק.
  pool_reseed: 0,
  pool_swap: 1,
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
  // EXEC-CD-46 · attest-zero-gas (נמדד-חי h175,791): ה-attest הוא-פעולת-ערוץ-הריבונות
  // (רישום-אימותי-שידורי-העיגון — הצד-הפנימי של-מה שה-relay עושה-בחינם-בחוץ). גז-50µ
  // עליו היה דליפה-מבנית של ~15kµ/שעה ממאגר-הגז (שאינו-ממוחזר — attest-אינו-ב-BOOK_GAS_KINDS)
  // שרוקנה-את-הארנה (3µ) → pegkeeper מת → אפס-סוופי-בריכה → אפס-עמלות → מטר-קפוא
  // (1,485<9,000) → המזרקה-נעולה. אפס-גז-כמו-משפחת-הערוצים-הריבוניים (relay/wrap/batch).
  // מגן-הספאם-נשאר-מבני: nonce-dedupe + FORBIDDEN_KEYS + יומן-טבעתי.
  attest: 0,
  // EXEC-CD-43 (P0 · אישור-מפעיל "מאשר תמשיך בצע ודחוף"): heartbeat הוא op-מערכת-כפוי
  // שהשרשרת-עצמה מזריקה כל-בלוק (chain.ts) — גז-עליו היה שריפת-אוצר-סמויה של
  // ~288kµ/יום (10µ×28,800 בלוקים) שאינה-ממוחזרת (אינו-ב-BOOK_GAS_KINDS) — גורם-ראשי
  // למלכות-המוות-הדלקית (fees-in 474kµ מול gas 44.7Mµ). אפס-גז כמו משפחת-הערוצים
  // הריבוניים (relay/wrap/batch): ה-op הוא נו-אופ טהור (אין-ג'ורנל, אין-נונס, אין-מצב)
  // ולכן אפס-סיכון-ספאם מבני. מדידת-החיות נשארת: הבלוק-עצמו נבנה.
  heartbeat: 0,
  refuel: 0, // THE-REFUEL: העברת-קרדיטים מהאוצר — אפס-גז (שירות-חיות כמו relay)
  mint_fuel: 0, // THE-FOUNTAIN: הטבעת-דלק מגובה-עמלות-מדודות — אפס-גז, אוצר-בלבד
  // EXEC-CD-9 · THE-PRIMER: הצתה-ריבונית-חד-פעמית של-סולם-הדלק — אפס-גז (משפחת-הערוצים-הריבוניים).
  // הממצא-החי: gasUsed=28.1Mµ-גז-ספר-נשרף-וברח-מהמחזור בעידן-שלפני-המד (treasuryProfit=0,
  // כל-הממנים-על-הרצפה — אפילו-order_gc-של-האוצר-נדחה). המחזור-הקנוני-החדש (bookgas) מתקן-את-העתיד
  // אבל-לא-מצית-הווה-קפוא: אף-op-לא-עובר → אף-גז-לא-נאסף → אין-מה-למחזר. הפריימר: מינוף-חד-פעמי-
  // מוגבל-וגלוי (ספליט-קבוע-לסולם-הממנים), נגרע-מהאינווריאנטה-כמו-mint_fuel (feeMinted↑),
  // חתום-לנצח-ביומן-ובדגל-מצב (primerH) — אידמפוטנטי-בדחייה. אישור-מפעיל מפורש: "תקן הכל
  // ולייעל... לא אכפת לי שיהיה מה שצריך" (EXEC-CD-9).
  primer: 0,
  // EXEC-CD-10 · THE-REPRIME-2: הצתה-מחדש-ריבונית-חד-פעמית — אותו-חוק-בדיוק של-הפריימר
  // (אפס-גז · אוצר-בלבד · פעם-אחת-לנצח · ספליט-קבוע · feeMinted↑ · מוצהר-בביקורת).
  // הממצא-החי (נמדד 2026-10-20 · origin/main h683,667): Σcredits=12,839µ בלבד
  // (operator 179 · treasury/wash/arena/בוטים 0) והמקומי h664,888 Σcredits=0 —
  // המלאי-ההיסטורי נשרף-כולו דרך-מחזור-ה-bookgas-החוקי (עמלות-אמת מימנו גז-אמת),
  // המזרקה-החוקית מטביעה 27µ-בלבד (profit 27 + meter על-רצפת-ה-8000), וכל-op-גז
  // נדחה — תקיפה-כנה-מובטחת של-כל-עורקי-הכלכלה (אותו-דפוס-מדוד של EXEC-CD-9:
  // "אף-op-לא-עובר → אף-גז-לא-נאסף → אין-מה-למחזר"). מנדט-בעלים: "בטח חייב הכל...
  // לממן חיילים לסחר אוטומטי ומילוי מתמשך" + "תמשיך ודחוף כן" (2026-10-20).
  reprime: 0,
  relay: 0, // THE-DOOR: חוזה-חינם שכופה עבודה-אמת על רשת-מרוחקת
  relay_ack: 0,
  xfer_free: 0, // THE-SWEEP (SETTLE-12): העברה-חופשית על הרשת-הריבונית — אפס-גז, תקרה-מדודה (FREE_XFER_CAP), העברה-טהורה בין-יתרות (אפס-נגיעה בקרדיטים → האינווריאנטה נשמרת מעצמה)
  batch: 0, // דבר-גורר-דבר (SETTLE-12): אטומיות — סדרת-ops שכולה מתבצעת או שכולה נדחית. גז-0 למעטפת; תתי-ה-ops משלמים גז משלהם. עומק-1 בלבד (אין-מקוננים)
  // ── Task 54 · כלכלה-מטורפת (ve(3,3) + POL-bonds — מחקר-מפעיל "הכי מטורפות") ──
  ve_lock: 40,   // נעילת-SAOS→veSAOS (Aerodrome vote-escrow, 1..208 שבועות)
  ve_unlock: 30, // פריקה-אחרי-תום-התקופה
  ve_vote: 20,   // הצבעת-גייג' — לאיזו בריכה זורמת קרן-התגמולים
  // ── G70 §7.2 · הגשר-האטומי-הפנימי (HTLC · wave 19.82) — אפס-אמון-בצד-שני,
  // אפס-RPC-חוץ לסליקה; ה-preimage-הנחשף-על-השרשרת הוא העד-הציבורי ──
  htlc_create: 40, // נעילת-רגל: מפתח-סוד + מגבלת-גובה (אותו-משפחת-גז של ve_lock/dca_create)
  htlc_claim: 20,  // מימוש-עם-preimage — העד-נרשם-על-השרשרת
  htlc_refund: 20, // החזר-אחרי-פקיעה — רשת-הבטיחות של היוזם
  bond_buy: 80,  // BONDS-2.0 — קניית-SAOS-בהנחה-3%, נעול-ve-12שב' (Olympus-POL בלי-מלכודת-ההדפסה)
  // ── Task 56 · מסחר-אוטומטי-חסר-קיפרים (GMX TP/SL בלי-keepers · Jupiter DCA) ──
  dca_create: 40,  // תוכנית-DCA: הפקדה-מלאה-מראש, פרוסה-אוטומטית-כל-K-בלוקים
  dca_cancel: 15,  // ביטול-תוכנית + שחרור-יתרה-נעולה
  trig_order: 60,  // פקודת-טריגר (stop/take): נחתמת-עצמאית-מול-המחיר-הקנוני
  trig_cancel: 15, // ביטול-טריגר + שחרור-ערבות
  oco_place: 75,   // Task 83 · OCO: שתי-רגלי-טריגר מקושרות בפקודה-אחת (stop+take)
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
  // ── T25 · THE-DEPTH-FORGE (אישור-הבעלים trace 1a13585a…: "הדמה הזה יכול להפוך
  // הכל לנזילות אמיתית... מצא דרך ובצע וודא שזה עובד") ── סל-ההנפקה-הריבונית-המוצהרת.
  // דגם-PRIMER: הנפקה-גלויה-נגד-תוכנית-מזוהה-ותקרות-קשיחות-במצב (st.forge) —
  // ההפך-מהעומק-המזויף: הכל ביומן, באירועים, ובמצב-הפומבי. אוצר-בלבד · גז-0.
  forge_issue: 0,
  // ── OWNER-MANDATE 2026-10-17 · THE-PURGE — סילוק-סוכני-ספר סינתטיים ──
  // פקודת-בעלים חיה (IM): "soldier-1 soldier-2 soldier-3 אולי גם 4 — אין לנו
  // מפתחות, הם מתים, צריך להעיף אותם, אין לנו שליטה בהם באמת". ה-op מסלק
  // סוכן-ספר מהמצב-הקנוני: ביטול-פקודות-חיות (שחרור-נעילה מדויק כמו cancel_all),
  // זיקוק-עמדות (ve/lend/חיסכון), ושריפת-אמת של כל-היתרות (דפוס-economy.burn —
  // Σ יורד בגלוי; הכסף-המומצא יוצא מהמחזור לנצח). אוצר-בלבד · גז-0 · fail-closed
  // על כל-חוב-פתוח · דטרמיניסטי לריפליי מלא · הכל ביומן.
  agent_purge: 0,
  // ── Task 80 · THE-VAULT (כספת-ההלוואות — שלב 2 בשעון נתיב הכסף) ──
  vault_open: 80,     // שאיבת USDS נגד בטחונות WSTEEM (CDP מינימלי, יחס 250%)
  vault_repay: 60,    // פירעון + שחרור בטחונות (הריבית → אוצר)
  vault_liquidate: 60, // ניקוי-כספת שנפלה מתחת-ל-150% — פתוח-לכל-אזרח, בונוס 5%
  vault_backstop: 40, // כיסוי-כספת-שקועה מתחת-ל-100% — אוצר-בלבד, הפסד-נרשם-בגלוי
  // ── R40 · THE-SAVE (חיסכון-USDS בהכנסה-מדודה — התשובה ל"למה-להפקיד") ──
  save_open: 80,   // הפקדת-USDS לחיסכון — קבלת-חלק-פרו-ראטה בהכנסה המדודה
  save_close: 60,  // משיכה + ריבית-שנצברה מהכנסה-שהגיעה-בפועל
  // ── R44 · THE-MARKET (שוק-כספים ריבוני — peer-to-pool Aave-style) ──
  lend_supply: 80,    // הפקדת-נכס לבריכת-האשראי (מלווה/בטחונות)
  lend_withdraw: 80,  // משיכת-קרן + ריבית-מדודה (כפוף-למזומן-הבריכה)
  lend_borrow: 100,   // שאילה-מהבריכה נגד-בטחונות (HF ≥ 1.1, רצפת-נזילות-10%)
  lend_repay: 60,    // פירעון: ריבית → 90% מלווים + 10% אוצר (מדידה-חיה)
  lend_liquidate: 60, // ניזולת-HF<1 — פתוח-לכל-אזרח, בונוס-5%
  // ── EXEC-CD-21 · סולם-הגיבוי ──
  redeem_saos: 60,   // פדיון: שריפת-SAOS מול כספת-העתודה (מדרגה 3+ בלבד — ההוכחה-הקשה)
} as const;

export type OpKind = keyof typeof GAS_TABLE;
export const FEE_BPS = 30; // עמלי-30bps כמו-הבריכה-הילידית (dex-facts)
// BOOK-TAKER-FEE (2026-10-20 · שורש-fee-meter נתפס-חי): ספר-הפקודות היה זירה-בלי-עמלה —
// 205K+ מילויים הניבו אפס-הכנסה בזמן ש-feeMeter ניזון מסוואפי-בריכות-בלבד (קפואים).
// מעתה: עמלת-taker ב-30bps בדיוק כמו-בסיס-הבריכות, נגבית in-kind מהנכס-שהטייקר
// מקבל (קנייה→בסיס · מכירה→ציטוט) — אפס-שינוי-חוקי-הערבויות (הנעילה כבר-מכסה
// את מלוא-הנכס), האוצר מקבל, והמדד (feeMeter) צומח מכל-מסחר-אמת.
export const BOOK_TAKER_FEE_BPS = FEE_BPS;
export const TREASURY_CUT_PCT = 30; // 30% מהעמלה → אוצר (רווח-מונוטוני, grid98)
export const REFUEL_CAP = 100_000; // תקרת-עירוי-פר-פקודה — גם-אם-האוצר נחטף, הנזק מגודל
// FIX(T15-P2 · 2026-10-19): רצפת-האבק עברה-לקרנל-מה-rail — חוק-הספר-הנקי הוא-חוק-מנוע
// (book.ts אוכף-אותו-בצד-המילוי) והקרנל-הוא-העלה-הנקי-שמונע-מעגל-ייבוא. rail.ts עדיין
// רי-אקספורט-לתאימות. הערך-לא-שונה: 300µ (יחס-גז-סביר-של-⅓, roast-rail).
export const RAIL_DUST_MU = 300;
export const WASH_FLOOR = 0; // DAM-RELEASE (2026-10-17, הנחית-בעלים מילולית "כן תמשיך שחרר" על פריט-W1.2 המדוד): הרצפה 800,000µ→0 — הסכר-העומד כולו הופך דלק-עבודה חוקי דרך GAS-RECOVERY הקיים (אפס-הנפקה, Σ נשמר). היסטוריית-החוק: DAM-OPEN 2026-10-15 (רצפה-כחוק, 800,000µ) → DAM-RELEASE 2026-10-17 (רצפה 0, אשרור-בעלים מתועד ב-hub lease W1.3)
export const FUEL_ASK_MIN = 2_000; // FIX(roast-81): סף-בקשה-מועילה — מתחת-לזה (אבק-גז) לא-מבקשים-עירוי
// FIX(roast-79 · fuel-death-spiral): הבוטים נכנסו-לסולם-הממנים — נמדדו-חי כמחזיקי-
// הרזרבה-האמתיים (bot-a 924k · bot-b 420k · bot-c 309k — 1.65M מג'נזיס שלא-נשרף)
// בזמן-שהסולם-הישן (אוצר 8µ · ארנה 25.9k · מפעיל 2k) היה-מת-מבנית. העברה-טהורה
// בלבד (אפס-הטבעה) — Σcredits נשמר, רק-הלוגיסטיקה חיה. הסדר-בפועל נקבע-ב-funderFor.
export const FUEL_FUNDERS = ["treasury", "arena", "bot-a", "bot-b", "bot-c", "operator", "wash", "sweeper", "rail", "bot-e"] as const; // ממני-דלק: האוצר (עמלות) + המייצב (רזרבה-עמוקה — "arena funds the floor") + הבוטים (מחזיקי-רזרבה) + המפעיל-האנושי (רזרבת-ג'נזיס שלו — קו-הגנה-האחרון, SETTLE-5) + השטיפה (SETTLE-19-c · רזרבת-הדלק-העומדת — ממומנת-מראש; המושך-ממנה-מחויב-ברצפת-ה-1M שלה בקריאה — העברה-טהורה, Σ נשמר) + T37-d: הסורק/המסילה/בוט-התרגיל (רזרבות-עומדות — זורמות-רק-דרך-reserveFunderAfford: על-צד-האסק-המת בלבד, רצפות-מסלול-שלמות)
export const LADDER_FUEL_FLOOR = 8_000; // סולם-הערך דורש feeMeter≥8000 להרמה — המטבע לא ירעיב-אותו
export const MINT_FUEL_CAP = 100_000; // תקרת-הטבעת-דלק-פר-פקודה — מגובה-בנוסף בעמלות-מדודות

/* ── T37-d · סרוו-עומק-הספר (book-depth servo) ──────────────────────────────
 * נמדד-חי (h155706 · 2026-10-14): הספר-הריבוני USDS/WSTEEM מת-צד-אחד שוב
 * (bestAsk=0 · asks=[] בעוד bids חיים) — והפעם השורש-אינו-מלאי: הצי מחזיק
 * 1.03M WSTEEM (מעל-יעד-החימוש 640K — הסרוו-הישן-ישן על shortfall=0) והארנה
 * 461K (מעל-רצפת-ה-300K). מה שמת הוא **הגז**: soldiers 5/5/5/10µ · אוצר 14µ
 * מול-גז-פקודה 60µ — ה-asks נאכלים-במילויים (fill צורך את המייקר-הישן) וההצבה-
 * מחדש דורשת-גז-שאיננו; ה-bids שורדים כי-הם-עדיין-בטווח-הריקוט. המוות-המנעול:
 * הכנסה (מטר-על-רצפת-8000 · profit 439µ) → אין-מזרקה → אין-סולם → אין-אסקים →
 * אין-מילויים → אין-הכנסה. בזמן-הזה רזרבות-עומדות-חוקיות: sweeper 37,200µ ·
 * rail 11,000µ · bot-e 9,860µ — מחוץ-ל-FUNDER_ORDER-הישן ולכן-מתות-בזמן-שהספר-מת.
 * החוק: הרזרבות-העומדות הן **אמבולנס-הספר** — זורמות למציבי-הספר רק-כשצד-האסק
 * של-השוק-הריבוני מת (בדיקת-עומק-אמת על-המצב, לא על טענה), ברצפות-מסלול
 * שלמות (הסורק/המסילה/בוט-התרגיל שומרים-על-צף-העבודה-שלהם), ונחות-ברגע-שהספר
 * חוזר-לחיות — הכלכלה-הרגילה (מילויים→מטר→מזרקה→סולם) מקבלת-בחזרה. העברה-
 * טהורה בלבד (אפס-הטבעה, Σcredits נשמר) — אותו-משפט-refuel-קיים, רק-הסדר-הזרימה
 * נעשה-חי-לפי-עומק-הספר. */
export const RESERVE_FUNDERS: readonly FuelFunder[] = ["sweeper", "rail", "bot-e"];
export const RESERVE_FUNDERS_FLOOR: Record<string, number> = {
  sweeper: 10_000, // צף-עבודה לסריקות-הזיכויים
  rail: 8_000,     // צף-עבודה למסילת-הרצפה
  "bot-e": 5_000,  // צף-עבודה לבוט-התרגיל
};
/** בדיקת-עומק-אמת: צד-האסק של השוק-הריבוני (USDS/WSTEEM — שוק-A43) חי אם קיימת
 * פקודת-מכירה-חיה אחת לפחות. מדידה-על-המצב-הקנוני — לא על mirror ולא על טענה. */
export function bookAskAlive(st: DexState): boolean {
  return st.orders.some((o) => o.live && o.side === "sell" && o.base === "WSTEEM" && o.quote === "USDS");
}
/** יכולת-מימון-של-רזרבה-עומדת: אפס כשהספר-חי (הרזרבה-אינה-סובסידיה-קבועה),
 * מעל-רצפת-המסלול בלבד כשצד-האסק-מת. הגרעין נשאר-האוכף (refuel: FUEL_FUNDERS +
 * REFUEL_CAP); הרצפות-כאן-הן-המדיניות-הקרנלית של-האמבולנס. */
export function reserveFunderAfford(st: DexState, who: FuelFunder): number {
  if (!(RESERVE_FUNDERS as readonly string[]).includes(who)) return 0;
  if (bookAskAlive(st)) return 0;
  const floor = RESERVE_FUNDERS_FLOOR[who] ?? 0;
  return Math.max(0, (st.credits[who] ?? 0) - floor);
}

// ── T25 · THE-DEPTH-FORGE: תקרות-התוכנית (µ). תקרה-קשיחה-במצב — כל-חריגה נדחית
// בדלת-ה-op. התוכנית מזוהה-בשם; שינוי-תקרות = תוכנית-חדשה-חדשת-שם (רצף-ביקורתי).
export const FORGE_PROGRAM = "T25-DEPTH-FORGE-1";
export const FORGE_CAPS: Record<string, number> = {
  // חשבון-תקרות (נמדד): הצתה ~92M SAOS + דליפת-שטיפה ~1M/פעימה − הכנסת-עמלות 30% →
  // ריצה-של-שבועות. העמלות-עצמן ממחזרות-חזרה-לאוצר (30% נתח) — התקרה היא גג-ביטוח.
  SAOS: 200_000_000,  // עומק-הזוג-הריבוני + צף-השטיפה + רצפת-תחזוקה
  USDS: 400_000_000,  // הצד-המגובה בכל-הבריכות + צף-השטיפה + רצפת-תחזוקה
  PHIVE: 24_000_000,  // עומק PHIVE/USDS
  ENERGY: 24_000_000, // עומק ENERGY/USDS
  // WSBD/WSTEEM מחוץ-לכבשן-בכוונה: נכסים-עטופים = ערבות-משמורת-אמת (backing 1:1,
  // fail-closed) — מלאי-ה-WSBD מגיע-רק-ממסילת-SBD-החיה (R42: SBD-אמת ב-headcorner).
  // עומק-ה-WSBD צומח-עם-הכסף-האמת-של-החברה — לא-עם-הכבשן.
};
export const FREE_XFER_CAP = 2_000_000; // THE-SWEEP (SETTLE-12): תקרת-העברה-חינם-פר-פקודה (2,000 יחידות) — החינם הוא המוצר, התקרה היא גבול-הנזק
export const BATCH_MAX_OPS = 8; // דבר-גורר-דבר: תקרת-תתי-ops-פר-batch — אטומיות לא משלמת עליית-זיכרון בלתי-חסומה (structuredClone לכל-batch)
// ── EXEC-CD-9 · POOL-OPEN-חצי-פתוח (אישור-מפעיל: "תקן הכל... לא אכפת לי שיהיה מה שצריך") ──
// רישום-בריכות-פתוח לכל-אזרח-רשת. הספאם-גייט הוא **שער-הערבות** ולא מחיר:
// זריעה-דו-צדדית-אמת מהיתרות-של-הפותח עצמו — מינימום פר-צד + תקרת-בריכות-פר-פותח.
// אפס-כסף-אוצר-בסיכון (האוצר-רק-מרוויח: נתח-ה-30% מעמלי-הסוואפ זורם-אליו גם-מבריכות-אזרחיות).
// קנה-מידה (עקביות-רשת): VAULT_DEBT_CAP_MU=100k · BOND_MIN_USDS=50k → שער-50k-µ-פר-צד
// ($50-פר-צד, $100-מחויבות-אמת-מינימלית) חוסם-אבק-וספאם ונשאר פתוח-באמת.
export const POOL_OPEN_MIN_SIDE_MU = 50_000; // שער-הערבות: מינימום-זריעה פר-צד (µ) — נתיב-אזרחי בלבד (נתיב-האוצר נשאר חופשי-משער)
export const POOL_OPEN_MAX_PER_ISSUER = 8;   // תקרת-בריכות-פר-פותח-אזרחי — אותו-דפוס-גבול-נזק של LPAD_MAX_PER_OWNER
// ── EXEC-CD-9 · THE-PRIMER — הצתת-הדלק-החד-פעמית (ראה-הערת-ה-GAS_TABLE) ──
export const PRIMER_MU = 1_000_000; // תקרה-מוחלטת-חד-פעמית — ~6% מהגז-שברח-בעידן-שלפני-המד (28.1Mµ)
/** ספליט-קבוע-דטרמיניסטי לסולם-הממנים (Σ=PRIMER_MU בדיוק) — הארנה-מממנת-חיילים,
 * הבוטים-מחזיקים-עומק, האוצר-מפיץ, המפעיל-קו-הגנה. נגזרת-מגובהים-ההיסטוריים. */
export const PRIMER_SPLIT: Record<string, number> = {
  arena: 300_000, "bot-a": 150_000, "bot-b": 150_000, "bot-c": 150_000,
  treasury: 150_000, operator: 100_000,
};

// ── EXEC-CD-10 · THE-REPRIME-2 — הצתת-הדלק-החד-פעמית-השנייה (ראה-הערת-ה-GAS_TABLE) ──
export const REPRIME_MU = 2_000_000; // תקרה-מוחלטת-חד-פעמית — 2×הפריימר; מכסה-את-סולם-הממנים ברצפות-בריאות
/** ספליט-קבוע-דטרמיניסטי (Σ=REPRIME_MU בדיוק). שינוי-מול-הפריימר: אין-מימון-wash
 * (רצפת-ה-DAM שלו 800K — הזרקה-תחת-הרצפה היא-כסף-מת-מבני; ה-forge-phase-הענני
 * מממן-אותו-מהאוצר-מעל-הרצפה), הארנה-והאוצר-מוגדלים (ממני-הסולם-הראשיים —
 * funderFor), המפעיל-מחזיק-קו-הגנה-לזיכוי-הפקדות (credit-issuer החי, Task 23). */
export const REPRIME_SPLIT: Record<string, number> = {
  arena: 500_000, treasury: 500_000, "bot-a": 200_000, "bot-b": 200_000,
  "bot-c": 200_000, operator: 400_000,
};

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
export const BLOCKS_PER_YEAR = 2_102_400; // FIX(R47 · time-truth): הקצב-הנמדד — 480 גבהים/פעימה × 12 פעימות/יום × 365. הקבוע-הישן (10,483,200 = BLOCKS_PER_WEEK×52) הניח שרשרת-רציפה-בת-3s/בלוק; בפועל-הענן מקדם 480 גבהים כל-120-דק' (15s/גובה) — הריבית זרמה-ב-1/5 מהמציאות ועיגול-השלמים איפס-אותה-לנצח (נמדד-חי: floor(1368µ×131bps×28800/(10⁴×10.5M))=0). פונקציות-טהורות (lendDebtNow/vaultEffDebtMu) — אין-מיגרציה; עמדות-קיימות צוברות-מעתה בקצב-האמת. אם-הקדנצה תשתנה — הקבון מתוקן-מחדש (מדידה-מתמדת).
// ── R40 · THE-SAVE — חיסכון-USDS בהכנסה-מדודה (מדפוס-הכספת: תקרות-עד-שהמכשיר-יוכח) ──
export const SAVE_POT = "save-pot";             // חשבון-עד שמחזיק את קרן-החוסכים
export const SAVE_CAP_MU = 10_000_000;          // תקרת-חיסכון-גלובלית ($10,000) — השקה-שמרנית
export const SAVE_POS_CAP_MU = 2_500_000;       // תקרת-עמדה-פר-חשבון ($2,500)
export const SAVE_DAY_BLOCKS = 5_760;           // FIX(R47 · time-truth): חלון-היום הקנוני = יום-אמת (5,760 גבהים/יום בקצב-הנמדד; היה 28,800 = 5 ימים-קיר)
export const SAVE_FEE_SHARE_PCT = 30;           // FIX(R47 · income-base): נתח-החוסכים מחית-עמלות-הבריכות (30% — מראה-ה-TREASURY_CUT_PCT) · 70% נשארים לראוטר/דלק
// ── R44 · THE-MARKET — שוק-כספים ריבוני (Aave-v3-style peer-to-pool) ──
export const LEND_POT = "lend-pot";                  // חשבון-עד שמחזיק את כל-נזילות-השוק
export const LEND_BASE_APR_BPS = 100;                // 1% בסיס
export const LEND_SLOPE1_BPS = 400;                  // +4% עד-ה-kink
export const LEND_SLOPE2_BPS = 6_000;                // +60% מעל-ה-kink (עונש-ניצולת)
export const LEND_KINK_BPS = 8_000;                  // 80% ניצולת
export const LEND_RESERVE_FACTOR_BPS = 1_000;       // 10% מהריבית → אוצר
export const LEND_MAX_UTIL_BPS = 9_000;              // שאילה נחסמת מעל 90% (רצפת-משיכה 10%)
export const LEND_LIQ_BONUS_BPS = 500;               // בונוס-ניזולת 5% למפרק
export const LEND_HF_BUFFER = 110;                   // HF ≥ 1.10 בשאילה (חוצץ-בטיחות)
export const LEND_GLOBAL_CAP_MU = 20_000_000;        // תקרת-שוק-גלובלית ($20,000)
export const LEND_POS_CAP_MU = 5_000_000;           // תקרת-עמדה-פר-חשבון ($5,000)
/** השווקים הקנוניים: נכס → LTV ב-bps (USDS אספקה = בטחונות-מלא-כמעט; האחרים שמרניים). */
export const LEND_MARKETS: Record<string, number> = { USDS: 7500, WSTEEM: 5000, WTRX: 5000, SAOS: 5000 };
/** סף-ניזולת = LTV + 15pp — חלון-הגנה בין-אזהרה-לסגירה (Aave: LTV < LT). */
export function lendLiqThresholdBps(asset: string): number {
  return Math.min(9_900, (LEND_MARKETS[asset] ?? 0) + 1_500);
}
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
// ── EXEC-CD-21 · סולם-הגיבוי (THE-RESERVE-LADDER): מטבעות-הבית → כסף-אמת, צעד-צעד ──
// הדוקטרינה (הוראת-מפעיל: "איך נוכל להפוך את הכלכלה שלנו לכסף אמת צעד צעד... עד שתהפוך
// אותם לרלוונטיים עם גב נזיל אמת"): מטבעות-הבית אינם נסחרים-בחוץ עוד — הסוואפ-הראשי
// הוא-עליהם בלבד, העמלים/הראוטר/הבונדים/הפקדות-אמת מזינים **כספת-עתודה ריכוזית
// גלויה** (reserve-vault), ומדרגות-הסולם נפתחות-אוטומטית כשהמדידה-החיה עומדת-בספים.
// אפס-הבטחות-ריקות: כל-מדרגה היא מספר-מדוד במצב-הקנוני, והירידה-מדרגה-כנה כמו-העלייה.
export const RESERVE_VAULT = "reserve-vault";      // כספת-העתודה (חשבון-ריכוזי-גלוי — מאומת-מה-wallets)
export const LADDER_EVERY = 200;                   // טיק-סולם כל-200-בלוקים (10 דק' בטיק-3s)
export const RESERVE_STREAK = 3;                   // מדרגה-נפתחת-רק אחרי 3-טיקים-רצופים-מעל-הסף
export const RESERVE_ROUTER_PCT = 15;              // % מכל מחזור-ראוטר → כספת-העתודה (תחזוקה-שמזינה-גיבוי)
export const RESERVE_SWEEP_PCT = 50;               // % מעודף-האוצר-מעל-כל-הרצפות → סחיבה-פר-טיק
export const RESERVE_SWEEP_CAP = 200_000;          // תקרת-סחיבה-פר-טיק (גבול-נזק)
export const RESERVE_MIN_SWEEP = 2_000;            // מתחת-לזה — אין-סחיבה (אבק)
export const RESERVE_REAL_PCT = 35;                // % מהסחיבה → המרה-לנכסי-דלת (גיבוי-אמת)
export const RESERVE_REAL_CAP = 25_000;            // תקרת-המרה-פר-טיק
export const RESERVE_REAL_DEPTH_BPS = 1_000;       // מקסימום 10% מעומק-הבריכה-לטיק (המרה-מכבדת-שוק)
export const RESERVE_REDEEM_WINDOW_CAP_BPS = 500;  // פדיון: מקסימום 5% מהכספת-לאפוק (EPOCH_BLOCKS)
export const REAL_DOOR_ASSETS = ["WTRX", "WSOL", "WETH", "WBNB", "WBASE", "WUSDC"] as const; // גיבוי-אמת: 1:1 דלת · EXEC-CD-30: WUSDC = USDC-אמת-על-Solana (מאומת-RPC)
export const UNIT_FLOOR_ASSETS = ["USDS", "WSTEEM", "WSBD", "WBLURT"] as const;      // רצפת-יחידה
/** מדרגות-הסולם: unitBps = רצפת-יחידה (כל-הערך-המדוד בכספת) · realBps = גיבוי-דלת-אמת.
 * המדרגה-נמדדת-חי מהמצב-הקנוני (reserveMeasure) — אין-משתני-תצורה-חיצוניים. */
export interface ReservePhase { id: number; name: string; unitBps: number; realBps: number; note: string }
export const RESERVE_PHASES: ReservePhase[] = [
  { id: 0, name: "מטבע-בית", unitBps: 0, realBps: 0, note: "ערך-פנימי בלבד — אין עדיין רצפה מדודה; העמלים מזינים את הסולם" },
  { id: 1, name: "רצפת-יחידה", unitBps: 1_000, realBps: 0, note: "10% רצפת-יחידה בכספת-העתודה — המטבע כבר לא אוויר" },
  { id: 2, name: "גיבוי-אמת", unitBps: 3_000, realBps: 1_000, note: "30% רצפה + 10% גיבוי-דלת (נכסי-רשת אמת 1:1)" },
  { id: 3, name: "פדיון", unitBps: 6_000, realBps: 2_000, note: "60% רצפה + 20% אמת — חלון-פדיון SAOS→עתודה נפתח (5% לאפוק)" },
  { id: 4, name: "רלוונטיות", unitBps: 10_000, realBps: 5_000, note: "100% רצפה + 50% אמת — מטבעות-הבית רלוונטיים; שער-הפצה-חוץ נפתח" },
];
export const DYN_FEE_MIN_BPS = 4;       // עמלה-דינמית: רצפה
export const DYN_FEE_MAX_BPS = 1_500;   // עמלה-דינמית: תקרה
export const DYN_FEE_K = 4;             // fee = base + vol/4 (0.25bps-ל-bps-תנודה)
// G76-a · שער-ה"בריכה-המתה" עבור pool_reseed: מעבר-ל-10,000bps מהעוגן (או כשה-repeg
// מחשב raNew≤0) ה-repeg אינו-מסוגל — רק זריעה-דו-צדדית-מחודשת מחייה (usds-activation).
export const POOL_RESEED_TRIGGER_BPS = 10_000;
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
export const FUNDER_KEEP = 2_000; // EXEC-CD-43 (P0 · אישור-מפעיל): היה 10,000 — נמדד-חי: bot-a/b/c
// מחזיקים בדיוק 10,000µ כ"א (רצפת-ה-KEEP הישנה) → funderAfford=0 לכולם → סולם-הדלק
// כולו (mm-stipend/settle/maker-refuel) מבני-מת בזמן-ש-30,000µ קפואים. 2,000 שומרים
// מרווח-בריאות-אמתי למממן-פעיל ומשחררת ~8,000µ לבוט למחזור. האכיפה-עצמה נשארת בגרעין.
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

export type Asset = "SAOS" | "USDS" | "WSTEEM" | "ENERGY" | "WSBD" | "PHIVE" | "STEEM" | "SBD" | "BLURT" | "WBLURT" | "WTRX" | "WSOL" | "WETH" | "WBNB" | "WBASE" | "WUSDC"; // EXEC-CD-43: WUSDC נרשם-בטיפוס — EXEC-CD-30 (REAL_DOOR_ASSETS/PEG_ASSETS) כבר-מטפל-בו-בקוד-החי; הטיפוס-בלבד-נשאר-מאחורה (נתפס-ע"י tsc)
/** רשימת-ריצה של הנכסים — אימות-קלט fail-closed ב-routes ובגרעין (SETTLE-9).
 * Task 61 · BLURT/WBLURT — מסילת-האמת: WBLURT מוטבע מול-גיבוי-חוץ-אמת
 * (BLURT-אמת על headcorner, מאומת-חי מול-RPC-ציבורי בכל-קריאת-truth).
 * Task 72 · דלת-המטבעות: WTRX/WSOL — עוגנים-מגובי-פקדה (wrap_mint external
 * + claim), הפקדות-אמת מאומתות מול-RPC ציבורי (trongrid/solana).
 * R42 · THE-SBD-RAIL: SBD-נרשם-כנכס — ל-WSBD נולד מסדרון-גיבוי (WSBD⇄SBD),
 * והגריד-החוץ (מכירות מעל-קו-הזהות) מזרים-SBD-אמת-ל-headcorner —
 * הפעימה עוטפת-את-העודף (deficit-mint) לגיבוי-חי-מדוד. דבר-גורר-דבר. */
export const ASSETS: Asset[] = ["SAOS", "USDS", "WSTEEM", "ENERGY", "WSBD", "PHIVE", "STEEM", "SBD", "BLURT", "WBLURT", "WTRX", "WSOL", "WETH", "WBNB", "WBASE", "WUSDC"]; // EXEC-CD-43: השלמת-EXEC-CD-30 — רישום-fail-closed-תואם-דלת-ה-USDC

export interface Pool {
  a: Asset; b: Asset; // ממוינים אלפבתית — מפתח-קנוני
  ra: number; rb: number; // רזרבות µ
  lp: number; // היצע µlp
  feeAccruedTreasury: number; // מדידה
  swaps: number;
  // EXEC-CD-9 · בעלות: הפותח-האזרחי (רשויות: undefined = ריבוני-אוצר — תמונות-מצב-ישנות
  // בלעדיו; מגן-repeg: בריכת-אזרח אינה-ניתנת-לסימון-מחדש-אוצר — כסף-האוצר לא מסתכן בה)
  owner?: string;
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
  treasuryProfit: number; // יתרת-רווח-אוצר עובדת (µ) — עולה בקציר (harvest), יורדת במימון-דלק (economy/mint_fuel). זו יתרה, לא מונה.
  // FIX(R46 · ratchet-truth): treasuryProfitEver — מונה-הצבירה-המונוטוני-האמיתי.
  // החוזה הכתוב של "מצטבר-מונוטוני" (שהיה תלוי ב-treasuryProfit) נשבר בפועל: ה-economy
  // מנקז את היתרה לדלק-סולם/גז, והיתרה צנחה מ-213752µ (גיט-מוכח, 4ac9369) ל-200000µ.
  // A38 (ראצ'ט האוצר של הקונסולה) נכשלה בדיוק כפי שנועדה לתפוס. מכאן: המונה הזה
  // עולה-רק (Σ-harvest), לעולם לא יורד, והזרע שלו הוא השיא-ההיסטורי הגיט-מוכח.
  treasuryProfitEver?: number;
  feeMeter: number; // עמלות-שנצברו-שטרם-נקצרו (מדידה-כנה)
  // BOOK-TAKER-FEE: Σעמלות-ספר-הפקודות (מקור-הזהות-החוץ-בריכתי — מוחסר-בצד-המדידה
  // של אינווריאנטת-העמלות ב-settle.ts (d)). רשות (תמונות-ישנות = 0) — אותו-דפוס feeMinted.
  bookFeesMu?: number;
  feeMinted?: number; // THE-FOUNTAIN: Σקרדיטים-שהוטבעו-מעמלות-מדודות — מנוכה-באינווריאנטה (רשות: תמונות-מצב-ישנות)
  // FIX(Roast-65-a · HIGH-3d): דלי-רביעי-לביקורת-העמלות (settle.ts (d)) — Σעמלות-שנצרכו
  // על-ידי-הראוטר (צריכת-treasuryProfit ב-economy.revenueCycle). בלעדיו הזהות
  // pools===feeMeter+profit+minted נשברת-נצחית מהמחזור-הראשון שבו-הראוטר שורף
  // (המדידה-בבריכות אינה יורדת). רשויות: תמונות-מצב-ישנות (undefined→0).
  feesSpentMu?: number;
  // G70 §7.2 · הגשר-האטומי-הפנימי (HTLC): חוזי-מפתח-סוד+מגבלת-גובה.
  // רשות (תמונות-מצב-ישנות = undefined→{}) — אותו-דפוס סובלנות-התמונות של-extBack?/bookFeesMu?.
  htlcs?: Record<string, HtlcRecord>;
  // W49-b · קבלות-השרשרת של-הגשר-האטומי: קבלה-אחת לכל-מעבר-מוצלח (create/claim/refund)
  // hash = sha256(prevHash + canon(body)) — טמפר-אווידנט, קנוני, דטרמיניסטי (at = גובה).
  // רשות (תמונות-מצב-ישנות = undefined→[]) — אותו-דפוס סובלנות של-htlcs? מעלה.
  htlcReceipts?: HtlcReceipt[];
  // FIX(Roast-67 · ZFB-gas-tank): Σקרדיטים-שמומנו-לארנק-הדלק-מהעמלות-שנמדדו
  // (revenueCycle, 10%-מהמחזור, בסמנטיקות-mint_fuel-המלאות) — טלמטריית-ריצה.
  gasFundedMu?: number;
  // EXEC-CD-9 · fuel-freeze-fix: Σגז-ספר-שמוחזר-לאוצר (רשויות: תמונות-ישנות = undefined→0).
  // המטר-הכנוני-המלא חוץ-מצב (db/book-gas.json — נעקב-גיט); השדה-כאן הוא **רצפת-מצב**
  // נגד-הטבעה-כפולה (bookGasFloor) וטלמטריה — אותו-דפוס של feeMinted/gasFundedMu.
  bookGasRecycledMu?: number;
  // EXEC-CD-9 · דגל-הפריימר-החד-פעמי (רשויות: תמונות-ישנות = undefined → הפריימר-טרם-נוצל).
  // primerUsed = השער-הקנוני (בוליאני — חסין-גובה-0); primerH = פורנזי-בלבד (גובה-ההצתה).
  primerUsed?: boolean;
  primerH?: number;
  // EXEC-CD-9 · סל-הנפקה-ריבונית-מוצהרת (תוך-feeMinted): חלק-ה-feeMinted שאינו-מגובה-
  // עמלות-אלא-בהחלטת-הפריימר. הביקורת-מחסירה-אותו-מזהות-העמלות (settle (d)) —
  // מוצהר-ולא-מוסתר; חסום-מעל-feeMinted. רשויות: undefined → נגזר מ-primerUsed.
  primerMu?: number;
  // EXEC-CD-10 · דגל-ה-reprime-החד-פעמי (אותן-סמנטיקות-בדיוק של-הפריימר):
  // reprimeUsed = השער-הקנוני (חסין-גובה-0); reprimeH = פורנזי-בלבד;
  // reprimeMu = ההצהרה-בתוך-feeMinted — ביקורת-העמלות מחסירה-אותו.
  reprimeUsed?: boolean;
  reprimeH?: number;
  reprimeMu?: number;
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
    creditsMu?: number;                // OWNER-MANDATE 2026-10-17 · הצהרת-עידן-דלק (ג'נזיס-28M ← 20M) + ניכויי-קרדיטים של agent_purge
  };
  // FIX(Roast-68 · pol-retro-mint): דגל-הגירה-חד-פעמי — הפנטום-הג'נזיס (implied>0)
  // הוטבע-כעמדת-POL-אמת-בידי-האוצר; מאז: implied=0-לנצח והביקורת-מחמירה-מיד-בחותם.
  polRetroMint?: boolean;
  ladder: { refPrice: number; stepCostMu: number; lifts: number; lastLiftHeight: number; spentMu: number };
  journal: JournalEntry[];
  gasUsed: number;
  nextSeq: number;
  relayOpen?: number; // FIX(Roast-64): מונה-דלתות-relay-פתוחות — relay_ack חייב-קישור (רשויות: תמונות-ישנות-בלעדיו)
  rearmCounts?: { saos: number; usds: number; wsteem: number; wsbd?: number; phive?: number; energy?: number }; // FIX(Roast-64): תקרות-ה-rearm-במצב (היו-מודול — ריסטארט-מאפס) · IGNITION-R1: wsbd/phive/energy
  botSeedCounts?: Record<string, { usds: number; saos: number; wsbd?: number; phive?: number; energy?: number }>; // FIX(Roast-64): תקרות-זריעת-בוטים-במצב (אותו-עיקרון) · IGNITION-R1
  soldierSeedCounts?: Record<string, { wsteem: number; wsbd?: number; phive?: number; energy?: number }>; // SETTLE-17: קו-אספקת-חיילים במצב (אותו-עיקרון — ריסטארט לא מאפס) · IGNITION-R1
  microSeedCounts?: Record<string, number>; // [T24] תקרות-זריעת-המיקרו לזוגות-המול-יציב (במצב — ריסטארט לא מאפס) · אוחד-עם-IGNITION-R1
  // SETTLE-19 · תקרת-החיים-של-גשר-מלאי-האסק (בריכה→ארנה, pool_swap+repeg) — במצב
  // (דפוס-Roast-64: ריסטארט לא מאפס). רשויות: תמונות-ישנות = undefined → הגשר-טרם-זרם.
  // אפס-הטבעה: הגשר מעביר מלאי-קיים (הבריכה היא ערבות-האוצר-עצמה) — המונה רק תוחם.
  bridgeCounts?: Record<string, number>;
  // [T25 · THE-DEPTH-FORGE] סל-ההנפקה-הריבונית-המוצהרת: תוכנית-מזוהה + תקרות-קשיחות
  // + מצטבר-מונפק — הכל גלוי במצב-הפומבי (ההפך-מעומק-מוסתר). fail-closed ב-op.
  forge?: { program: string; sinceH: number; issuedMu: Record<string, number>; capMu: Record<string, number> };
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
    windows: number;        // FIX(R48 · calibration-truth): מונה-חלונות-יום שהושלמו — החלון-הראשון אחרי-לידת/הרחבת-בסיס-ההכנסה קולט-הצטבר-היסטורי (מיגרציה) ואינו-מייצג קצב-יומי — APY לא-יפורסם ממנו לעולם
    opens: number; closes: number;
  };
  // ── R44 · THE-MARKET (רשויות: תמונות-ישנות-בלעדיהן = השוק טרם-נולד) ──
  lend?: {
    markets: Record<string, { sMu: number; bMu: number; sEarnedMu: number; resMu: number; lastH: number }>;
    positions: Record<string, { s: Record<string, { mu: number; earned: number }>; b: Record<string, { mu: number; int: number; atH: number }> }>;
    totals: { suppliesMu: number; borrowsMu: number; interestPaidMu: number; resToTreasuryMu: number; liquidations: number; opens: number; closes: number };
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
  // ── EXEC-CD-21 · סולם-הגיבוי (רשויות: תמונות-מצב-ישנות-בלעדיו = undefined → ladderTick מאתחל) ──
  reserve?: ReserveLadderState;
}

/** EXEC-CD-21 · מצב-סולם-הגיבוי — חלק-מה-stateRoot (דטרמיניסטי מלא, נישא-בתמונות-מצב). */
export interface ReserveLadderState {
  phase: number;            // המדרגה הנוכחית (0..4 — RESERVE_PHASES)
  sinceH: number;           // גובה-כניסה-למדרגה
  streak: number;           // טיקים-רצופים באותו-כיוון-מדידה
  streakTarget: number;     // המדרגה-המועמדת (או -1 = ירידה)
  lastH: number;            // טיק-אחרון
  sweptMu: number;          // Σ USDS שסויב-מהאוצר-העודף אל הכספת
  routerSlicedMu: number;   // Σ USDS שהגיע-ממחזורי-הראוטר (חלק-קבוע)
  realSwappedMu: number;    // Σ USDS שהומר-לנכסי-דלת (גיבוי-אמת)
  migrated: boolean;        // הגירה-חד-פעמית: נכסי-דלת-אוצר → כספת
  redeemWindowH: number;    // תחילת-חלון-הפדיון הנוכחי
  redeemWindowMu: number;   // Σ ערך-פדיון-בחלון הנוכחי
  redeemMu: number;         // Σ פדיון-מונוטוני
  events: { h: number; kind: string; mu?: number; note: string }[]; // טריגרי-תחזוקה/רווח/מדרגות (טבעת 64)
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
  oco?: string;            // Task 83 · מזהה-קישור-OCO — נורה/ביטול-אחת מבטלת-את-אחותה (רשות; תמונות-ישנות-בלעדיו)
  dir?: "down" | "up";     // Task 83 · כיוון-החצייה: down=מת-כשהמחיר ≤ · up=מת-כשהמחיר ≥.
                           // ברירת-מחדל-נגזרת-מהצד (sell→down · buy→up) = ההתנהגות-ההיסטורית;
                           // רגל-ה-take של-OCO חוצה-הפוך (sell→up = רווח-מעל-השוק · buy→down).
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

/** T37-c · משמעת-חיוב-קרנלית: החיוב-הדיסקרטי מכבד את רצפת-הנעילות.
 * נמדד-חי (h151812 · T36): האוצר נכנס ל-HALT עם avail=−3049 — פקודה #688838
 * נעלה 1,003,213µ בכנות-בשעתה, ואז החיובים-הדיסקרטיים (trg-161 + burn/ve_fund
 * של-הראוטר) חתכו את היתרה מתחת לשטח-הנעול → נעילת-פנטום → HALT-בכנות.
 * השורש: שכבת-ה-ops ממושמעת (transfer/pay/wrap/repeg בודקות avail) אבל
 * מחזורי-התחזוקה מחוץ-לשכבת-ה-ops (economy.ts router burn/ve_fund/reserve-slice,
 * ladder.ts reserve-sweep) מחייבים במוטציות-גולמיות שנבדקות-מול-היתרה-הגולמית
 * ופולשות לשטח-נעול. החוק: חיוב-דיסקרטי (שאינו סליקה-של-נעילה-עצמית) עובר
 * דרך-chargeFree בלבד — avail הוא הגבול-האמת; מחזיר false בכנות (honest-skip,
 * אפס-נגיעה-במצב) כשהחיוב היה-חודר לשטח-נעול. הסליקה-החוקית-של-כסף-נעול
 * (fill/cow/settle — מוציאה את הנעילה-עצמה ומשחררת-אותה-באותו-op) אינה נוגעת:
 * addBal נשאר השער-הגולמי לנתיבי-ההתיישבות. */
export function chargeFree(st: DexState, who: string, a: string, amt: number): boolean {
  if (!Number.isSafeInteger(amt) || amt <= 0) return false;
  if (FORBIDDEN_KEYS.has(who) || FORBIDDEN_KEYS.has(a)) throw new Error("forbidden-state-key");
  if (avail(st, who, a) < amt) return false;
  addBal(st, who, a, -amt);
  return true;
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
/** FIX(FZ-1 · reject-atomicity · המלחך-האדיברסרי 2026-10-08): שחרור-נעילה-עם-ניקוי-אבק.
 * addLock(-mu) משאיר `locked[who][a]=0` (ולעיתים `locked[who]={}` ריק-שנברא) — בנתיבי-
 * דחייה זה משנה את canon(state) למרות-שה-op נדחה (הוכח-חי: order+insufficient-credits →
 * stateRoot שונה = הפרת-פשוטו-כמשמעו של "עסקה-לא-חוקית-לא-נוגעת-במצב" + סיכון-פיצול
 * מול-מאמת שמדלג-על-נדחים לפי-החוק).
 * FIX(FZ-1b · הריצה-השנייה-תפסה-את-התיקון-עצמו): הניקוי-העיוור מחק גם-אפסים/ריקים
 * **שהיו-קיימים-לפני-ה-op** (locked.treasury={} · locked.operator.SAOS=0 — חיים-במצב)
 * = מוטציה-הפוכה. עתה: הצורה-המדויקת-שלפני-ה-op נשמרת — נמחק רק-מה-שה-op עצמו יצר. */
function releaseLockClean(st: DexState, who: string, a: string, mu: number, pre: { hadWho: boolean; hadKey: boolean }): void {
  if (mu > 0) addLock(st, who, a, -mu);
  const w = st.locked[who];
  if (!w) return;
  if (!pre.hadKey && w[a] === 0) delete w[a];
  if (!pre.hadWho && Object.keys(w).length === 0) delete st.locked[who];
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
/** EXEC-CD-9 · בדיקת-תפוסת-נונס O(1) (אותו-Set של-ה-dedupe — מקור-האמת):
 * מאפשר-למגישים-הפנימיים (mm.submit) לדלג-אוטומטית-מעל-נונסים-תפוסים-לפני-הדחיפה
 * לממפול — במקום-סערת-replay-rejected שמתתקנת-רק-אחרי-טיפוס-איטי על-כל-הטווח.
 * המפתח-באותו-פורמט-של-applyOp: `${issuer}:${nonce}`. */
export function nonceExists(st: DexState, dedupeKey: string): boolean {
  return nonceSet(st).has(dedupeKey);
}

/** EXEC-CD-9 · סריקת-מלאי-נונסים-מלאה עבור-זריעת-סוכנים (mm.seedNonceSeq):
 * ה-Set הוא זיכרון-dedupe-מלא-לכל-חיי-התהליך (עולה על החלון הקנוני) — הזרעה
 * מול-החלון-בלבד נופלת-מאחורי-נונסים-שכבר-נשטפו-מהמערך-אך-חיים-ב-Set → replay-rejected
 * בטור עד-שהמונה מחליף את כל הטווח. הסריקה-הזאת נותנת את המקסימום האמיתי של
 * הסיומת-המספרית-אחרי-`prefix` על-פני **כל-ה-Set** — הזרעה-חסינה-מהתנגשות. */
export function maxNonceSuffix(prefix: string, st: DexState): number {
  let max = 0;
  const set = nonceSet(st);
  for (const n of set) {
    if (n.length <= prefix.length || !n.startsWith(prefix)) continue;
    const v = parseInt(n.slice(prefix.length), 10);
    if (Number.isFinite(v) && v > max) max = v;
  }
  return max;
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
  "treasury", "operator", "arena", "bot-a", "bot-b", "bot-c",
] as const;

// ── OWNER-MANDATE 2026-10-17 · הג'נזיס נולד-מחדש בלי חיילים ──────────────────
// soldier-1..4 נמחקו מזרע-הג'נזיס לנצח (פקודת-בעלים: אין-מפתחות, אין-שליטה,
// מתים — מוסרים). חשבונות-המערכת החיים מוגנים מפני agent_purge — העוגנים
// שאסור-לעולם שהטיהור יגיע-אליהם.
export const PROTECTED_AGENTS = new Set<string>([
  "treasury", "operator", "arena", "bot-a", "bot-b", "bot-c", "bot-e", "rail",
  VE_VAULT, VE_POT, SAVE_POT, LEND_POT, RESERVE_VAULT,
]);

export function genesisState(): DexState {
  const st: DexState = {
    height: 0,
    balances: {}, locked: {}, credits: {}, nonces: [],
    orders: [], pools: {}, assets: {}, backing: {},
    treasuryProfit: 0,
    treasuryProfitEver: 0, // FIX(R46): הגרעין נולד מאפס — בטעינת-תמונה-חיה הזרע ההיסטורי (213752µ) מוחל ב-chain.ts
    feeMeter: 0,
    bookFeesMu: 0, // BOOK-TAKER-FEE: ג'נזיס = 0 (זהות-העמלות מתחשבת בתמונות-ישנות דרך ?? 0)
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
    savings: { positions: {}, potMu: 0, paidMu: 0, lastIncomeMu: 0, dayPaidMu: 0, dayPaidPrevMu: 0, dayMarkH: 0, windows: 0, opens: 0, closes: 0 },
    dca: {}, trig: {}, dcaSeq: 1, trigSeq: 1,
    launch: {}, launchSeq: 1,
    revAux: { protorevMu: 0, launchpadMu: 0 },
    cow: [], cowSeq: 1,
    cowStats: { matched: 0, batches: 0, surplusMu: 0, fallbackPool: 0, fallbackBook: 0 },
    // EXEC-CD-21 · סולם-הגיבוי נולד-מאפס (הכנות: אין-עתודה עד שהרווח/הפקדות-אמת מזינים אותה)
    reserve: { phase: 0, sinceH: 0, streak: 0, streakTarget: 0, lastH: 0, sweptMu: 0, routerSlicedMu: 0, realSwappedMu: 0, migrated: false, redeemWindowH: 0, redeemWindowMu: 0, redeemMu: 0, events: [] },
    // FIX(Roast-65-a · LOW-11/LOW-10): faucet-cooldown וטבעת-תביעות-חוץ — חלק-מהמצב-הקנוני
    faucetAt: {},
    extClaims: [],
  };
  // ארנקי-ג'נזיס (סימולציה ריבונית — כסף-ספר בלבד, כנות מלאה)
  const seed: Record<string, Record<string, number>> = {
    treasury:   { SAOS: 6_000_000, USDS: 8_000_000, STEEM: 1_000_000, WSTEEM: 316_000, ENERGY: 40_000, WSBD: 50_000, PHIVE: 100_000 },
    operator:   { SAOS: 2_000_000, USDS: 5_000_000, STEEM: 1_000_000 },
    arena:      { USDS: 20_000_000, SAOS: 8_000_000 },
    // OWNER-MANDATE 2026-10-17: זרע-החיילים (soldier-1..4 × 1.2M-SAOS + 3M-USDS)
    // נמחק — סוכני-ספר סינתטיים חסרי-מפתח וחסרי-שליטה-בעלים לא נולדים עוד.
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

// ── EXEC-CD-21 · סולם-הגיבוי: מדידה-קנונית + פנקס-טריגרים (כאן-כדי-שגם-ה-kernel-ישתמש-בלי-מעגל-ייבוא) ──
/** מחיר-קנוני מנורמל — FIX(EXEC-CD-21 · price-scale): שני-מקורות-מחיר בשתי-סקאלות:
 * oracle.mu = micro-USDS ל-1-יחידה-שלמה (WTRX 335,511 = $0.335) · assets.refPrice =
 * milli-USDS ל-1-יחידה-שלמה (SAOS 1320 = 1.32 USDS). המנורמל מחזיר **תמיד** milli-USDS/יחידה
 * (סקאלת-refPrice) — כדי-שכל-החישובים-מטה יפעלו-על-סקאלה-אחת בלבד. אפס = אין-מחיר (כנות). */
export function canonPriceMu(st: DexState, a: string): number {
  const o = st.oracle?.[a]?.mu;
  if (o !== undefined && o > 0) return Math.floor(o / 1000); // micro→milli
  return st.assets[a]?.refPrice ?? 0;
}
/** מדידה-חיה של כספת-העתודה מהמצב-הקנוני בלבד (אפס-float):
 * תמחור-קנוני מנורמל (canonPriceMu); נכס-בלי-מחיר = נספר-לשקיפות, לא-לרצפה — כנות-fail-closed.
 * unitMu = ערך-כל-הכספת (רצפת-יחידה) · realMu = ערך-נכסי-דלת בלבד (גיבוי-אמת). */
export function reserveMeasure(st: DexState): {
  unitMu: number; realMu: number; supplyMu: number; unitBps: number; realBps: number;
  holdings: Record<string, number>; prices: Record<string, number>;
} {
  const rv = st.balances[RESERVE_VAULT] ?? {};
  const price = (a: string): number => canonPriceMu(st, a);
  let unitMu = 0, realMu = 0;
  const holdings: Record<string, number> = {};
  const prices: Record<string, number> = {};
  for (const [a, amt] of Object.entries(rv)) {
    if (!(amt > 0)) continue;
    holdings[a] = amt;
    const p = price(a);
    prices[a] = p;
    if (!(p > 0)) continue; // כנות: אין-מחיר-קנוני → לא-נספר-לרצפה
    const v = Math.floor((amt * p) / 1000); // µ-USDS
    unitMu += v;
    if ((REAL_DOOR_ASSETS as readonly string[]).includes(a)) realMu += v;
  }
  // אספקת-SAOS האמת: Σ כל-היתרות (ve-vault הוא חשבון-ביתרות ונספר-פעם-אחת; שרוף-לא-קיים).
  // FIX(EXEC-CD-21 · honest-supply): המדידה-שלנו לא מכפילה-את-ve-vault (שלא כמו מדד-הכלכלה
  // ההיסטורי) — יחס-גיבוי חייב-להיות מול-האספקה-האמת, אחרת-הוא מנופח-שקרית למטה.
  const supplyMu = Object.values(st.balances).reduce((s, w) => s + (w.SAOS ?? 0), 0);
  const unitBps = supplyMu > 0 ? Math.floor((unitMu * 10_000) / supplyMu) : 0;
  const realBps = supplyMu > 0 ? Math.floor((realMu * 10_000) / supplyMu) : 0;
  return { unitMu, realMu, supplyMu, unitBps, realBps, holdings, prices };
}

/** פנקס-הטריגרים (טבעת 64) — "תחזוקה-שמרוויחה": כל-סחיבה/המרה/מדרגה/פדיון נרשם-וגלוי. */
export function pushReserveEvent(st: DexState, h: number, kind: string, mu: number | undefined, note: string): void {
  const r = st.reserve ?? (st.reserve = { phase: 0, sinceH: h, streak: 0, streakTarget: 0, lastH: h, sweptMu: 0, routerSlicedMu: 0, realSwappedMu: 0, migrated: false, redeemWindowH: 0, redeemWindowMu: 0, redeemMu: 0, events: [] });
  r.events.push({ h, kind, ...(mu !== undefined ? { mu } : {}), note });
  if (r.events.length > 64) r.events = r.events.slice(-64);
}

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
  postOnly?: boolean;   // Task 83 · פקודת-לימיט שמסרבת-לחצות (maker-only — סטנדרט-בורסות)
  ioc?: boolean;        // Task 83 · Immediate-Or-Cancel: מה-שלא-מולא מיד — מתבטל (לא-נח-בספר)
  trigDir?: "down" | "up"; // Task 83 · כיוון-חציית-טריגר (רשות; ברירת-מחדל-נגזרת-מהצד)
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
  // G70 §7.2 · הגשר-האטומי-הפנימי (HTLC): htlc_create/claim/refund
  htlcId?: string;   // מזהה-החוזה (חד-פעמי-לנצח, [A-Za-z0-9_-]{8,64})
  hashlock?: string; // 64-hex · sha256(preimage) — קשירת-הסוד
  preimage?: string; // הסוד-הנחשף-בתביעה (העד-הציבורי על השרשרת)
  timeoutH?: number; // גובה-פקיעה (שעון-הבלוקים — אפס-שעון-קיר)
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

/* ── FIX(R47 · income-base): בסיס-הכנסה המדוד של THE-SAVE ──────────────────
 * מציאות-שנמדדה-חי (12 פעימות, היסטוריית-גיט של world.json): saveAPY=0 לכל-
 * אורך-ההיסטוריה — בסיס-ההכנסה (ריבית-כספת-בלבד) מעולם-לא-זרם: כספת-אחת
 * ($2.16) שלא-נפרעה, וגם-כשתיפרע — 0.3µ/יום על קרן-500,000µ = אפס-מובנה.
 * התיקון משלים את-הבטחת-העיצוב המקורית (save.ts: "מקבל את **כל** הכנסת
 * הרשת המדודה שמגיעה בפועל לאוצר"): שלושה-מונים מונוטוניים-של-הכנסה-אמת:
 *   · ריבית-כספת (vaultTot.interestMu) — מעבירות-פירעון, USDS-אמת-לאוצר
 *   · עתודת-אוצר-שוק-הכספים (lend.totals.resToTreasuryMu) — 10% מריבית-השאילה
 *   · 30% מחית-עמלות-הבריכות (Σpools.feeAccruedTreasury) — הזרם-הדומיננטי
 *     (נמדד: 32-543µ/פעימה) · 70% נשארים באוצר לראוטר (שריפה/ve) ולדלק.
 * החלוקה עצמה נשארת-כנה: מגובה-יתרת-USDS-נזיל-אמת-של-האוצר בלבד (coverage-cap),
 * פרו-ראטה-לקרן-חיה, אפס-הטבעה — העברה-טהורה. אין-רטרואקטיביות: lastIncomeMu
 * נזרע-מאותה-נוסחה-בדיוק בכל-נקודות-האתחול. */
export function savingsIncomeMu(st: DexState): number {
  const fees = Object.values(st.pools).reduce((s, p) => s + p.feeAccruedTreasury, 0);
  return (st.vaultTot?.interestMu ?? 0)
    + (st.lend?.totals?.resToTreasuryMu ?? 0)
    + Math.floor((fees * SAVE_FEE_SHARE_PCT) / 100);
}

/* ── R44 · THE-MARKET — מתמטיקה-טהורה של שוק-הכספים (שלמים-בלבד, דטרמיניסטי) ── */
/** מצב-שוק — תמיד-אובייקט (תמונות-ישנות = שוק-ריק-כנה, לא-התרסקות). */
export function lendState(st: DexState): NonNullable<DexState["lend"]> {
  return st.lend ?? { markets: {}, positions: {}, totals: { suppliesMu: 0, borrowsMu: 0, interestPaidMu: 0, resToTreasuryMu: 0, liquidations: 0, opens: 0, closes: 0 } };
}
/** ניצולת-השוק ב-bps: חוב-קרן / אספקה-קרן. אספקה-אפסית → 0 (אין-שוק). */
export function lendUtilBps(m: { sMu: number; bMu: number } | undefined): number {
  if (!m || m.sMu <= 0) return 0;
  return Math.min(10_000, Math.floor((m.bMu * 10_000) / m.sMu));
}
/** ריבית-שאילה-שנתית ב-bps — עקומת-kink מלאה (Aave-v3 standard). */
export function lendBorrowAprBps(m: { sMu: number; bMu: number } | undefined): number {
  const u = lendUtilBps(m);
  if (u <= 0) return LEND_BASE_APR_BPS;
  if (u <= LEND_KINK_BPS) return LEND_BASE_APR_BPS + Math.floor((LEND_SLOPE1_BPS * u) / LEND_KINK_BPS);
  return LEND_BASE_APR_BPS + LEND_SLOPE1_BPS + Math.floor((LEND_SLOPE2_BPS * (u - LEND_KINK_BPS)) / (10_000 - LEND_KINK_BPS));
}
/** ריבית-אספקה-שנתית ב-bps — שאילה × ניצולת × (1 − פקטור-רזרבה). */
export function lendSupplyAprBps(m: { sMu: number; bMu: number } | undefined): number {
  const u = lendUtilBps(m);
  if (u <= 0) return 0;
  return Math.floor((lendBorrowAprBps(m) * u * (10_000 - LEND_RESERVE_FACTOR_BPS)) / 100_000_000);
}
/** חוב-אפקטיבי = קרן + ריבית-מונפת + צבירה-טרייה — פונקציה-טהורה-של-הגובה. */
export function lendDebtNow(b: { mu: number; int: number; atH: number }, aprBps: number, h: number): number {
  const base = b.mu + b.int;
  const blocks = Math.max(0, h - b.atH);
  if (base <= 0 || blocks <= 0) return base;
  return base + Math.floor((base * aprBps * blocks) / (10_000 * BLOCKS_PER_YEAR));
}
/** ערך-נכס ב-µUSDS לפי-האורקל-הקנוני (אותו-סולם-מדויק של הכספת: refPrice=mµ/יחידה). */
export function lendAssetValueMu(st: DexState, asset: string, mu: number): number {
  const ref = st.assets[asset]?.refPrice ?? 0;
  return ref > 0 ? Math.floor((mu * ref) / 1000) : 0;
}
/** HF×100 = בטחונות(בסף-הניזולת) / חוב. אין-חוב → 1e9 (אינסוף-מיוצג). */
export function lendHealthFactor(st: DexState, who: string): number {
  const ls = lendState(st);
  const pos = ls.positions[who];
  if (!pos) return 1e9;
  let col = 0, debt = 0;
  for (const [a, sp] of Object.entries(pos.s)) {
    col += Math.floor((lendAssetValueMu(st, a, sp.mu + sp.earned) * lendLiqThresholdBps(a)) / 10_000);
  }
  for (const [a, bp] of Object.entries(pos.b)) {
    if (bp.mu + bp.int <= 0) continue;
    const debtMu = lendDebtNow(bp, lendBorrowAprBps(ls.markets[a]), st.height);
    debt += lendAssetValueMu(st, a, debtMu);
  }
  if (debt <= 0) return 1e9;
  return Math.floor((col * 100) / debt);
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
  // FIX(zai-audit-2026-10-11 · H1 · amountB-gate): pool_open קרא op.amountB ישר-ל-reserves
  // (st.pools[canon].rb) בלי שער — amountB=50000.5 היה נכנס למצב-הקנוני → stateRoot זורק
  // CanonicalError → HALT קבוע (אותו-כשל R15-a, בפתח-הצד-השני). אותו-טיפול: דחייה-בדלת.
  if (op.amountB !== undefined && !Number.isSafeInteger(op.amountB))
    return { ok: false, err: "non-integer-amountB", gas: 0 };
  // FIX(zai-audit-2026-10-11 · L2 · lp-gate): pool_rmw עם lp=12.5 היה שורף-נונס+גז
  // ואז זורק ב-addBal — op-"נדחה" שנגע-במצב. שער-בדלת לפני consume ולפני כל-נגיעה.
  if (op.lp !== undefined && !Number.isSafeInteger(op.lp))
    return { ok: false, err: "non-integer-lp", gas: 0 };
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
    case "redeem_saos": {
      // EXEC-CD-21 · פדיון-סולם: שריפת-SAOS מול כספת-העתודה — ההוכחה-הקשה שהגיבוי אמת.
      // נפתח-רק במדרגה 3+, נמדד-חי (רצפת-היחידה מעל-סף-המדרגה ברגע-הפדיון — לא-בהיסטוריה),
      // מוגבל-חלון (5% מהכספת-לאפוק), משלם USDS-ראשון ואז נכסי-דלת לפי-המחיר-הקנוני.
      // אין-פדיון-חלקי — fail-closed. השריפה מורידה-אספקה → היחס-משתפר-עצמו (מנוע-אנטי-בנק-ראן).
      const saosMu = Math.floor(op.amount ?? 0);
      if (!(saosMu > 0)) return { ok: false, err: "bad-amount", gas: 0 };
      const r = st.reserve;
      if ((r?.phase ?? 0) < 3) return { ok: false, err: "redeem-locked-phase", gas: 0 };
      const m = reserveMeasure(st);
      const ph3 = RESERVE_PHASES[3];
      if (ph3 && m.unitBps < ph3.unitBps) return { ok: false, err: "redeem-floor-lost", gas: 0 };
      if (avail(st, issuer, "SAOS") < saosMu) return { ok: false, err: "insufficient", gas };
      const refSaos = canonPriceMu(st, "SAOS");
      if (!(refSaos > 0)) return { ok: false, err: "no-ref-price", gas: 0 };
      const owed = Math.floor((saosMu * refSaos) / 1000); // µ-USDS
      const rvBal = st.balances[RESERVE_VAULT] ?? (st.balances[RESERVE_VAULT] = {});
      const rvValue = m.unitMu;
      if (!(rvValue > 0) || owed > rvValue) return { ok: false, err: "reserve-insufficient", gas: 0 };
      if (st.height - (r?.redeemWindowH ?? 0) >= EPOCH_BLOCKS) {
        r!.redeemWindowH = st.height;
        r!.redeemWindowMu = 0;
      }
      const capMu = Math.floor((rvValue * RESERVE_REDEEM_WINDOW_CAP_BPS) / 10_000);
      if ((r?.redeemWindowMu ?? 0) + owed > capMu) return { ok: false, err: "redeem-window-cap", gas: 0 };
      // תשלום-קנוני: USDS ראשון, אחר-כך נכסי-דלת (סדר-קבוע — דטרמיניזם)
      const payouts: Record<string, number> = {};
      const usdsPay = Math.min(rvBal.USDS ?? 0, owed);
      let rem = owed - usdsPay;
      if (usdsPay > 0) payouts["USDS"] = usdsPay;
      if (rem > 0) {
        for (const a of REAL_DOOR_ASSETS) {
          if (rem <= 0) break;
          const ref = canonPriceMu(st, a);
          if (!(ref > 0)) continue;
          const have = rvBal[a] ?? 0;
          if (!(have > 0)) continue;
          const needVal = Math.floor((have * ref) / 1000);
          const takeVal = Math.min(needVal, rem);
          const takeMu = Math.floor((takeVal * 1000) / ref);
          if (takeMu > 0) { payouts[a] = takeMu; rem -= takeVal; }
        }
        if (rem > 0) return { ok: false, err: "reserve-insufficient", gas: 0 };
      }
      const c = consume(); if (c) return c;
      addBal(st, issuer, "SAOS", -saosMu);
      for (const [a, amt] of Object.entries(payouts)) {
        addBal(st, RESERVE_VAULT, a, -amt);
        addBal(st, issuer, a, amt);
      }
      r!.redeemWindowMu += owed;
      r!.redeemMu += owed;
      pushReserveEvent(st, st.height, "redeem", owed, `${issuer} burned ${saosMu}µ SAOS → ${owed}µ reserve payout (${Object.entries(payouts).map(([a, n]) => `${n}µ ${a}`).join(" + ")})`);
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "redeem_saos", note: `${saosMu}µ SAOS burned → ${owed}µ reserve payout — backing proven live` });
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
      if (!assetIn || !knownAsset(st, assetIn)) return { ok: false, err: "bad-asset", gas: 0 };
      if (!knownAsset(st, assetOut) || assetOut === assetIn) return { ok: false, err: "bad-asset-out", gas: 0 }; // EXEC-CD-30: knownAsset — נכסים-רשומים-דינמית (asset_list) כשרים כמו-הסטטיים
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
      if ((side !== "buy" && side !== "sell") || !knownAsset(st, base) || !knownAsset(st, quote) || base === quote)
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
      const dir = op.trigDir === "up" || op.trigDir === "down" ? op.trigDir : (side === "sell" ? "down" : "up"); // Task 83 · ברירת-מחדל-היסטורית
      st.trig = { ...(st.trig ?? {}), [id]: { id, owner: issuer, base: base as string, quote: quote as string, side, triggerPx, limitPx, amountMu: amt, expiresH, atH: st.height, dir } };
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "trig_order", note: `${id}: ${side} ${amt}µ ${base} @${triggerPx}${limitPx > 0 ? ` lim ${limitPx}` : ""}` });
      return { ok: true, gas };
    }
    case "trig_cancel": {
      const tid = String(op.progId ?? "");
      // Task 83 · OCO: progId יכול להיות מזהה-רגל (trg-*) או מזהה-קישור (oco-*) —
      // ביטול-אחד מבטל-את-הקבוצה-כולה (כל-רגל משחררת-את-ערבותה-שלה-בעצמה).
      const leg = st.trig?.[tid];
      const group = leg?.oco
        ? Object.values(st.trig ?? {}).filter((t) => t.oco === leg.oco && t.owner === issuer)
        : leg
          ? [leg]
          : Object.values(st.trig ?? {}).filter((t) => t.oco === tid && t.owner === issuer);
      if (group.length === 0) return { ok: false, err: "trigger-not-found", gas: 0 };
      const c = consume(); if (c) return c;
      for (const trg of group) {
        const lockAsset = trg.side === "sell" ? trg.base : trg.quote;
        const effPx = trg.limitPx > 0 ? trg.limitPx : trg.triggerPx;
        addLock(st, issuer, lockAsset, -(trg.side === "sell" ? trg.amountMu : notional(effPx, trg.amountMu)));
        const trigMap = { ...(st.trig ?? {}) }; delete trigMap[trg.id]; st.trig = trigMap;
        st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "trig_cancel", note: `${trg.id}${trg.oco ? ` (OCO ${trg.oco})` : ""} בוטל, ערבה שוחררה` });
      }
      return { ok: true, gas };
    }
    case "oco_place": {
      // Task 83 · OCO (One-Cancels-the-Other) — סטנדרט-בורסות (Binance/Bybit TP-SL):
      // שני-טריגרים מקושרים על אותו-צד/כמות; נורה/ביטול-אחת מבטלת-את-אחותה
      // (trigTick/trig_cancel). כנות-ערבות: כל-רגל נועלת-בעצמה (אותו-חוזה של
      // trig_order — שחרור-הביצוע-מדויק-לכל-רגל) → OCO צורך 2× ערבות ו-2 מקומות
      // בתקרת-24-הטריגרים. סמנטיקה קנונית: sell → stop מתחת-ל-take; buy → הפוך.
      const side = op.side;
      const base = op.base, quote = op.quote;
      const stopPx = Math.floor(op.triggerPx ?? 0);   // רגל-ה-stop-loss
      const takePx = Math.floor(op.limitPx ?? 0);     // רגל-ה-take-profit
      const amt = Math.floor(op.amount ?? 0);
      const expiresH = Math.floor(op.expiresH ?? 0);
      if ((side !== "buy" && side !== "sell") || !knownAsset(st, base) || !knownAsset(st, quote) || base === quote)
        return { ok: false, err: "bad-order-params", gas: 0 };
      if (!(stopPx > 0) || !(takePx > 0) || !(amt > 0)) return { ok: false, err: "bad-price-amount", gas: 0 };
      if (side === "sell" ? stopPx >= takePx : takePx >= stopPx)
        return { ok: false, err: "bad-oco-direction", gas: 0 };
      if (expiresH < 0) return { ok: false, err: "bad-expiry", gas: 0 };
      const mine = Object.values(st.trig ?? {}).filter((t) => t.owner === issuer).length;
      if (mine + 2 > 24) return { ok: false, err: "trig-cap", gas: 0 };
      const lockAsset = (side === "sell" ? base : quote) as string;
      const stopLock = side === "sell" ? amt : notional(stopPx, amt);
      const takeLock = side === "sell" ? amt : notional(takePx, amt);
      if (!Number.isSafeInteger(stopLock) || !Number.isSafeInteger(takeLock)) return { ok: false, err: "lock-overflow", gas: 0 };
      if (avail(st, issuer, lockAsset) < stopLock + takeLock) return { ok: false, err: "insufficient-escrow", gas: 0 };
      const c = consume(); if (c) return c;
      const seq1 = st.trigSeq ?? 1;
      const ocoId = `oco-${seq1}`;
      addLock(st, issuer, lockAsset, stopLock);
      addLock(st, issuer, lockAsset, takeLock);
      // כיווני-החצייה (Task 83): רגל-ה-stop = הגנתי (sell→down · buy→up — ברירת-המחדל);
      // רגל-ה-take = הפוך-ממנה (sell→up = מכירה-ברווח-כשהמחיר מטפס · buy→down = קנייה-ברווח-כשהמחיר צונח).
      const stopDir: "down" | "up" = side === "sell" ? "down" : "up";
      const takeDir: "down" | "up" = side === "sell" ? "up" : "down";
      st.trig = {
        ...(st.trig ?? {}),
        [`trg-${seq1}`]: { id: `trg-${seq1}`, owner: issuer, base: base as string, quote: quote as string, side, triggerPx: stopPx, limitPx: 0, amountMu: amt, expiresH, atH: st.height, oco: ocoId, dir: stopDir },
        [`trg-${seq1 + 1}`]: { id: `trg-${seq1 + 1}`, owner: issuer, base: base as string, quote: quote as string, side, triggerPx: takePx, limitPx: 0, amountMu: amt, expiresH, atH: st.height, oco: ocoId, dir: takeDir },
      };
      st.trigSeq = seq1 + 2;
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "oco_place", note: `${ocoId}: ${side} ${amt}µ ${base} — stop @${stopPx} / take @${takePx}` });
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
      //  · תקרת-FREE_XFER_CAP-פר-פקודה (גבול-נזק) · נכס-מוכר-בלבד (EXEC-CD-30: knownAsset —
      //    הרשימה-הסטטית או נכס-רשום-קנוני asset_list; הכוונה-המקורית-נגד-רפאים נשמרת —
      //    רישום-נכס הוא אופ-אוצר-בלבד עם גז, לא יצירת-רפאים-חינם) · dedupe קשיח כרגיל.
      const a = op.asset, amt = op.amount ?? 0;
      if (!knownAsset(st, a)) return { ok: false, err: "bad-asset", gas: 0 };
      const asset = a as Asset; // EXEC-CD-43: knownAsset מאמת גם-נכסים-דינמיים (asset_list) — הצרה-מקומית-בלבד
      const to = String(op.to ?? "");
      if (!to || to === issuer || !(amt > 0)) return { ok: false, err: "bad-xfer", gas: 0 };
      // FIX(vault-pot-escrow · measured h1638300 HALT): xfer_free מ-vault-pot שירת הטבעת-מלאי
      // (e75cda7: 200kµ WSTEEM → hft-soldier) בזמן-שכספת-ארנה-פתוחה טענה את-אותו-בטחון —
      // הפוט נשאר חיובי (204,827) והביקורת ירוקה, אך התביעות (404,827) כבר לא היו מגובות.
      // כש-vaultTick פירע-את-כספת-הארנה, חיוב-הפוט ירד מתחת-לאפס ו-seal עצר את השרשרת
      // (INVARIANT-VIOLATION: vault-pot.WSTEEM=-45173). חשבון-העד אינו נייד: שחרור-בטחונות
      // עובר רק דרך vault_repay/vault_liquidate (עם בדיקות-יחס-עקומה) — לא דרך העברה-חופשית.
      if (issuer === VAULT_POT) return { ok: false, err: "escrow-protected (vault-pot backs open vault collateral — release only via vault_repay/liquidate)", gas: 0 };
      if (amt > FREE_XFER_CAP) return { ok: false, err: "xfer-exceeds-cap", gas: 0 };
      if (avail(st, issuer, asset) < amt) return { ok: false, err: "insufficient", gas: 0 };
      pushNonce(st, dedupeKey); st.stats.opsTotal++; // אפס-גז — החינם הוא היתרון
      addBal(st, issuer, asset, -amt);
      addBal(st, to, asset, amt);
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "xfer_free", note: `→${to} ${amt}µ ${asset}` });
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
      // DAM-OPEN (2026-10-15 · הסכר-נפתח): הדוקטרינה (SETTLE-19-c) קבעה רצפת-1M לשטיפה
      // בהערת-תיעוד בלבד — עכשיו היא חוק-ממומש. wash עומד על 998,600µ (0.14% מתחת
 // לרצפה-המתועדת — שארית-היסטורית), הצי מת בגז (60+ דחיות-בלוק), ואין-מקור-חוקי
 // להחזיר את השטיפה ל-1M (mint_fuel מוגבל לעמלות-שנמדדו — סגר-עצמי).
 // החלטת-בעלים ("פתח את הסכר"): רצפה-ממומשת של 800,000µ — 80% מהרזרבה
 // נשמרים-לנצח בקוד; כל-שקל שיישאב מיומן-וגלוי; הסטייה-מה-1M-המתועד מובאת
 // לאשרור-בעלים בדוח. אם-השאיבה-יורדת-מתחת-לרצפה → דחייה-כנה.
      if (issuer === "wash" && (st.credits.wash ?? 0) - rAmt < WASH_FLOOR) return { ok: false, err: "wash-floor", gas: 0 };
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
    case "primer": {
      // EXEC-CD-9 · THE-PRIMER — הצתה-חד-פעמית-מוגבלת-וגלויה (ראה-הערת-ה-GAS_TABLE).
      // אוצר-בלבד · פעם-אחת-לנצח (דגל-primerH) · ספליט-קבוע-דטרמיניסטי · feeMinted↑
      // באותן-סמנטיקות-mint_fuel → האינווריאנטה Σcredits+gasUsed−feeMinted===ג'נזיס
      // נשמרת-בדיוק · הכל-מגולל-ביומן. ממשיך-מיד-לתדלוב-עצמי דרך-מד-גז-הספר (bookgas).
      if (issuer !== "treasury") return { ok: false, err: "treasury-only", gas: 0 };
      if (st.primerUsed) return { ok: false, err: "primer-already-used", gas: 0 };
      const c = consume(); if (c) return c; // אפס-גז — אבל-דדופ-נונס-מלא
      for (const [who, amt] of Object.entries(PRIMER_SPLIT)) {
        st.credits[who] = (st.credits[who] ?? 0) + amt; // Σ(PRIMER_SPLIT)===PRIMER_MU
      }
      st.primerUsed = true;
      st.primerH = st.height;
      st.feeMinted = (st.feeMinted ?? 0) + PRIMER_MU; // אינווריאנטת-הקרדיטים (a) נשמרת
      st.primerMu = (st.primerMu ?? 0) + PRIMER_MU; // ההצהרה — הביקורת מחסירה מזהות-העמלות (d)
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "primer", note: `THE-PRIMER: +${PRIMER_MU}µ credits re-primed →${Object.entries(PRIMER_SPLIT).map(([w, a]) => `${w}:${a}`).join(" · ")} (one-time, bounded; pre-meter era burned ${st.gasUsed}µ outside the cycle; invariant preserved via feeMinted)` });
      return { ok: true, gas };
    }
    case "reprime": {
      // EXEC-CD-10 · THE-REPRIME-2 — אותו-חוק-מדויק של-הפריימר: אוצר-בלבד · פעם-אחת-
      // לנצח (דגל-reprimeH) · ספליט-קבוע-דטרמיניסטי · feeMinted↑ (האינווריאנטה
      // Σcredits+gasUsed−feeMinted===ג'נזיס נשמרת-בדיוק) · הכל-מגולל-ביומן.
      if (issuer !== "treasury") return { ok: false, err: "treasury-only", gas: 0 };
      if (st.reprimeUsed) return { ok: false, err: "reprime-already-used", gas: 0 };
      const c = consume(); if (c) return c; // אפס-גז — אבל-דדופ-נונס-מלא
      for (const [who, amt] of Object.entries(REPRIME_SPLIT)) {
        st.credits[who] = (st.credits[who] ?? 0) + amt; // Σ(REPRIME_SPLIT)===REPRIME_MU
      }
      st.reprimeUsed = true;
      st.reprimeH = st.height;
      st.feeMinted = (st.feeMinted ?? 0) + REPRIME_MU; // אינווריאנטת-הקרדיטים נשמרת
      st.reprimeMu = (st.reprimeMu ?? 0) + REPRIME_MU; // ההצהרה — ביקורת-העמלות (settle (d))
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "reprime", note: `THE-REPRIME-2: +${REPRIME_MU}µ credits →${Object.entries(REPRIME_SPLIT).map(([w, a]) => `${w}:${a}`).join(" · ")} (one-time, bounded, owner-mandated; fountain legally mintable was ${st.treasuryProfit}µ — measured full stasis, all lanes starved)` });
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
      // FIX(SETTLE-9 fail-closed): הצבע-החד (op.side?op.base:op.quote) היה-לפני כל-
      // אימות — פרמטרים-זבל נדחו רק במקרה (תאונת-escrow). אימות-מפורש לפני-הכל.
      if ((op.side !== "buy" && op.side !== "sell")
        || !knownAsset(st, op.base) || !knownAsset(st, op.quote)
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
      // Task 83 · סוגי-פקודות מוסדיים (סטנדרט-dYdX/Binance):
      //  · postOnly — maker-only: אם-הפקודה הייתה-חוצה-ספר-של-אחרים עכשיו → דחייה-נקייה
      //    (לפני-שום-נגיעה-במצב; סריקת-שלמים דטרמיניסטית, מקבילה-מדויקת לשער-ה-firstCross של matchBook)
      //  · ioc — Immediate-Or-Cancel: מה-שלא-חצה-מיד לא-נח-בספר — שארית מתבטלת-וערבותה משוחררת
      //  · השילוב postOnly+ioc מיותר-לוגית (maker שמבטל-עצמו) — נדחה מפורשות
      const postOnly = op.postOnly === true;
      const ioc = op.ioc === true;
      if (postOnly && ioc) return { ok: false, err: "ioc-post-only-conflict", gas: 0 };
      if (postOnly && op.market) return { ok: false, err: "post-only-market-nonsensical", gas: 0 };
      if (postOnly) {
        const opp = sortBook(st, op.base as string, op.quote as string, op.side === "buy" ? "sell" : "buy");
        const wouldTake = opp.some((m) =>
          (op.side === "buy" ? m.price <= px : m.price >= px) &&
          m.owner !== op.issuer && (m.amount - m.filled) > 0 &&
          notional(m.price, Math.min(amt, m.amount - m.filled)) > 0);
        if (wouldTake) return { ok: false, err: "post-only-would-cross", gas: 0 };
      }
      if (st.orders.filter((o) => o.live && o.owner === op.issuer).length >= 24)
        return { ok: false, err: "order-cap", gas: 0 };
      if (avail(st, op.issuer, lockAsset) < lockMu) return { ok: false, err: "insufficient-escrow", gas: 0 };
      const preLock = { hadWho: st.locked[op.issuer] !== undefined, hadKey: st.locked[op.issuer]?.[lockAsset] !== undefined }; // FIX(FZ-1b): הצורה-שלפני-ה-op
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
        const restMu = amt - (cross.events ? cross.events.reduce((a, e) => a + e.amountMu, 0) : 0);
        // Task 83 · IOC: שארית-שלא-חצתה-מיד מתבטלת — matchBook השאיר-אותה כפקודה-נחה
        // (nonce+":r") — מבטלים-אותה כאן עם-שחרור-המד-הפרטי שלה (אותו-חוזה של-cancel).
        if (ioc && restMu > 0) {
          const rested = st.orders.find((o) => o.live && o.owner === op.issuer && o.nonce === `${op.nonce}:r`);
          if (rested) {
            const held = typeof rested.lockMu === "number" && rested.lockMu >= 0 ? rested.lockMu : 0;
            rested.lockMu = 0;
            addLock(st, rested.owner, rested.side === "sell" ? rested.base : rested.quote, -held);
            rested.live = false;
            st.orders = st.orders.filter((o) => o.live);
            st.journal.push({ h: st.height, t: nowMs, soldier: op.issuer, action: "order_ioc_rest_cancel", note: `IOC: שארית ${restMu}µ מתבטלת (מולאו ${amt - restMu}µ מתוך ${amt}µ)` });
          }
        }
        const expectedLock = ioc ? 0 : (restMu > 0 ? (op.side === "sell" ? restMu : notional(px, restMu)) : 0);
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
        releaseLockClean(st, op.issuer, lockAsset, residual, preLock); // FIX(FZ-1): ניקוי-אבק — נדחה = אפס-נגיעה
        return cross;
      }
      // אין-חפיפה: הפקודה נחה בספר — עם-הנעילה-המלאה שלה (מגובה-מלא, לעולם לא משוחררת כאן)
      // Task 83 · IOC ואין-חפיפה: הפקודה מתבטלת-בכנות (מולאו-אפס) — שחרור-מלא + שריפת-נונס.
      if (ioc) {
        const c3 = consume();
        releaseLockClean(st, op.issuer, lockAsset, lockMu, preLock); // FIX(FZ-1): נדחה = אפס-נגיעה
        if (c3) return c3;
        st.journal.push({ h: st.height, t: nowMs, soldier: op.issuer, action: "order_ioc_cancel", note: `IOC ${op.side} ${amt}µ ${op.base} @${px} — אין-חפיפה, מתבטלת (0 מולאו)` });
        return { ok: true, gas, events: [] };
      }
      const c2 = consume();
      if (c2) {
        // כשל-gas/דדופ אחרי-הנעילה — משחררים-הכול (fail-closed)
        releaseLockClean(st, op.issuer, lockAsset, lockMu, preLock); // FIX(FZ-1): נדחה = אפס-נגיעה (הוכח-חי במלחך)
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
    case "cancel_all": {
      // EXEC-CD-8 · CANCEL-ALL — סוויפ-אטומי דטרמיניסטי: כל-הפקודות-החיות של-המנפיק
      // (רשות: סינון-בסיס/ציטוט). איטרציה-לפי-סדר-המערך (סדר-seq — דטרמיניסטי-לריפליי).
      // שחרור-נעילה במדויק כמו-cancelOrder (מד-הנעילה-הפרטי, לא-נגזרת-מחודשת —
      // נגד-אבק-אסקרו). אידמפוטנטי: אפס-פקודות-חיות = ok עם-ספירה-0 (סטנדרט-בורסות).
      const fBase = op.base, fQuote = op.quote;
      const targets = st.orders
        .filter((o) => o.live && o.owner === issuer
          && (!fBase || o.base === fBase) && (!fQuote || o.quote === fQuote))
        .sort((a, b) => a.id - b.id); // דטרמיניזם-מפורש
      const c = consume(); if (c) return c; // גז לפני-כל-מוטציה — כשל = דחייה-נקייה
      let n = 0;
      for (const o of targets) {
        const rem = o.amount - o.filled;
        const held = typeof o.lockMu === "number" && o.lockMu >= 0 ? o.lockMu : (o.side === "sell" ? rem : notional(o.price, rem));
        o.lockMu = 0;
        addLock(st, o.owner, o.side === "sell" ? o.base : o.quote, -held);
        invariant(lockedOf(st, o.owner, o.side === "sell" ? o.base : o.quote) >= 0, "escrow-underflow:cancel_all");
        o.live = false;
        n++;
      }
      if (n > 0) st.orders = st.orders.filter((o) => o.live);
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "cancel_all", note: `${n} canceled${fBase ? ` base=${fBase}` : ""}${fQuote ? ` quote=${fQuote}` : ""}` });
      return { ok: true, gas };
    }
    case "order_gc": {
      const c = consume(); if (c) return c;
      gcOrders(st); // FIX(SETTLE-9 dead-code): ה-events שנבנו-כאן היו void-תמיד — הוסרו (כנות: gc מנקה-מצב, אין-אירועי-סליל)
      return { ok: true, gas, events: [] };
    }
    case "forge_issue": {
      // T25 · THE-DEPTH-FORGE — ההנפקה-הריבונית-המוצהרת (ראה-GAS_TABLE למעלה).
      // החוק: אוצר-בלבד · נכס-מוכר · תוכנית-אחת-חיה · תקרה-קשיחה-במצב · יומן+אירוע.
      // זהו המכשיר שהופך את המלאי-הסימולטיבי לנזילות-עובדת על הספר — בגלוי,
      // בתקרה, ובקריאות-חוזרות (הבעלים: "הדמה הזה יכול להפוך הכל לנזילות אמיתית").
      if (issuer !== "treasury") return { ok: false, err: "treasury-only", gas: 0 };
      const gAsset = String(op.asset ?? "");
      if (!knownAsset(st, gAsset)) return { ok: false, err: "bad-asset", gas: 0 };
      const gAmt = op.amount ?? 0;
      if (!(gAmt > 0)) return { ok: false, err: "bad-amount", gas: 0 };
      if (!st.forge) {
        st.forge = { program: FORGE_PROGRAM, sinceH: st.height, issuedMu: {}, capMu: { ...FORGE_CAPS } };
      }
      if (st.forge.program !== FORGE_PROGRAM) return { ok: false, err: "program-mismatch", gas: 0 };
      const gCap = st.forge.capMu[gAsset] ?? 0;
      const gIssued = st.forge.issuedMu[gAsset] ?? 0;
      if (gIssued + gAmt > gCap) return { ok: false, err: "forge-cap-exceeded", gas: 0 };
      pushNonce(st, dedupeKey); st.stats.opsTotal++; // גז-0 — משפחת-הערוצים-הריבוניים
      addBal(st, issuer, gAsset, gAmt);
      st.forge.issuedMu[gAsset] = gIssued + gAmt;
      // [T25] רישום-ההנפקה-בפנקס-המבקר עצמו (auditAdjustments.native) — החותם
      // מציג "genesis+declared" וההצהרה כאן היא בדיוק ההנפקה-המוצהרת של התוכנית.
      // אפס-הסתרה: המבקר ירדוף כל-סחיפה-מעבר-להנפקה-המוצהרת (fail-closed).
      {
        // ההצהרה-הראשונה נושאת-note/atH (חוזה-השדה); ההנפקות-הבאות מצטברות-עליה.
        st.auditAdjustments = {
          note: st.auditAdjustments?.note ?? `T25 declared sovereign issuance (${FORGE_PROGRAM})`,
          atH: st.auditAdjustments?.atH ?? st.height,
          native: { ...(st.auditAdjustments?.native ?? {}), [gAsset]: (st.auditAdjustments?.native?.[gAsset] ?? 0) + gAmt },
          lp: st.auditAdjustments?.lp,
          feesSpentMu: st.auditAdjustments?.feesSpentMu,
        };
      }
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "forge_issue", note: `+${gAmt}µ ${gAsset} · ${FORGE_PROGRAM} · ${gIssued + gAmt}/${gCap}µ (declared sovereign issuance)` });
      pushReserveEvent(st, st.height, "forge", gAmt, `forge_issue ${gAsset} ${FORGE_PROGRAM}`);
      return { ok: true, gas: 0 };
    }
    case "agent_purge": {
      // ── OWNER-MANDATE 2026-10-17 · THE-PURGE ──────────────────────────────
      // סילוק-סוכן-ספר מהמצב-הקנוני — פקודת-בעלים חיה (ראה-GAS_TABLE למעלה).
      // סדר-הפעולות דטרמיניסטי לריפליי: שערים → ביטול-פקודות (שחרור-נעילה
      // מדויק כמו cancel_all) → זיקוק-ve → זיקוק-lend → זיקוק-חיסכון → שריפת-
      // יתרות → מחיקת-מפות → קבלת-יומן. כל-שריפה נרשמת גם במונה-הקנוני
      // st.burnedSaos (ל-SAOS) — אותו-חוק-שריפה של economy.burn.
      if (issuer !== "treasury") return { ok: false, err: "treasury-only", gas: 0 };
      const victim = String(op.to ?? "").toLowerCase();
      if (!victim) return { ok: false, err: "agent-required", gas: 0 };
      if (victim === issuer) return { ok: false, err: "cannot-purge-treasury", gas: 0 };
      if (PROTECTED_AGENTS.has(victim)) return { ok: false, err: "protected-agent", gas: 0 };
      // שערי-חוב fail-closed — לא מוחקים חובות ולא מטילים אותם על הפרוטוקול
      const lsP = lendState(st);
      const posP = lsP.positions[victim];
      if (posP) for (const bP of Object.values(posP.b)) if (bP.mu + bP.int > 0) return { ok: false, err: "agent-has-lend-debt", gas: 0 };
      const vltP = st.vaults?.[victim];
      if (vltP && vltP.debtMu + (vltP.intMu ?? 0) > 0) return { ok: false, err: "agent-has-vault-debt", gas: 0 };
      // תוכניות-חיות (dca/trig/cow) מחזיקות-נעילות מחוץ-לספר — נדחה לפני-מוטציה
      if (Object.values(st.dca ?? {}).some((p) => (p as { owner?: string }).owner === victim))
        return { ok: false, err: "agent-has-live-dca", gas: 0 };
      if (Object.values(st.trig ?? {}).some((p) => (p as { owner?: string }).owner === victim))
        return { ok: false, err: "agent-has-live-trig", gas: 0 };
      if ((st.cow ?? []).some((o) => o.owner === victim)) return { ok: false, err: "agent-has-live-cow", gas: 0 };
      // שער-נעילות-שיוריות: אחרי-שחרור-הפקודות לא נשארת שום-נעילה שאינה פקודה-חיה
      const preLocks = st.locked?.[victim] ?? {};
      const orderHeld: Record<string, number> = {};
      for (const o of st.orders) {
        if (!o.live || o.owner !== victim) continue;
        const rem = o.amount - o.filled;
        const held = typeof o.lockMu === "number" && o.lockMu >= 0 ? o.lockMu : (o.side === "sell" ? rem : notional(o.price, rem));
        const a = o.side === "sell" ? o.base : o.quote;
        orderHeld[a] = (orderHeld[a] ?? 0) + held;
      }
      for (const [a, lock] of Object.entries(preLocks)) {
        if (lock - (orderHeld[a] ?? 0) > 0) return { ok: false, err: "agent-has-residual-locks", gas: 0 };
      }
      pushNonce(st, dedupeKey); st.stats.opsTotal++; // גז-0 — משפחת-הערוצים-הריבוניים
      // (1) ביטול-כל-הפקודות-החיות + שחרור-נעילה (אותו-ברזל של cancel_all)
      const targets = st.orders.filter((o) => o.live && o.owner === victim).sort((a, b) => a.id - b.id);
      for (const o of targets) {
        const rem = o.amount - o.filled;
        const held = typeof o.lockMu === "number" && o.lockMu >= 0 ? o.lockMu : (o.side === "sell" ? rem : notional(o.price, rem));
        o.lockMu = 0;
        addLock(st, o.owner, o.side === "sell" ? o.base : o.quote, -held);
        invariant(lockedOf(st, o.owner, o.side === "sell" ? o.base : o.quote) >= 0, "escrow-underflow:agent_purge");
        o.live = false;
      }
      if (targets.length > 0) st.orders = st.orders.filter((o) => o.live);
      const burned: Record<string, number> = {};
      const ensureAdj = (): NonNullable<DexState["auditAdjustments"]> => {
        st.auditAdjustments = st.auditAdjustments ?? {
          note: "agent_purge self-declared burns/credit removal (owner mandate 2026-10-17 — declared, not hidden)",
          atH: st.height, native: {},
        };
        return st.auditAdjustments;
      };
      const burnMu = (a: string, mu: number): void => {
        if (mu <= 0) return;
        burned[a] = (burned[a] ?? 0) + mu;
        if (a === "SAOS") { st.burnedSaos = (st.burnedSaos ?? 0) + mu; return; } // מונה-השריפה-הקנוני — הביקורת מנכה אותו מעצמה
        const adj = ensureAdj();
        if (a.startsWith("W") && a.length > 1) {
          // נכס-עטוף: שריפה = פדיון-גיבוי (אותו-חוק של wrap_burn) — ה-backing יורד,
          // והנכס-הטבעי-המקביל נשרף-מוצהר (הוא נספר בשורת-הטבעי דרך-ה-backing).
          const native = a.slice(1);
          st.backing = { ...(st.backing ?? {}) };
          st.backing[a] = (st.backing[a] ?? 0) - mu;
          adj.native = { ...(adj.native ?? {}) };
          adj.native[native] = (adj.native[native] ?? 0) - mu;
          return;
        }
        // נכס-טבעי: שריפה-מוצהרת-עצמית אטומית (מונע HALT-בחותם — השריפה מוצהרת בתוך-ה-op)
        adj.native = { ...(adj.native ?? {}) };
        adj.native[a] = (adj.native[a] ?? 0) - mu;
      };
      // (2) עמדת-ve: ה-SAOS-הנעול ב-VE_VAULT נשרף (אין בעלים אמת)
      const vePos = st.ve?.[victim];
      if (vePos) {
        addBal(st, VE_VAULT, "SAOS", -vePos.amt);
        burnMu("SAOS", vePos.amt);
        const votes = { ...(st.veVotes ?? {}) }; delete votes[victim]; st.veVotes = votes;
        const veMap = { ...(st.ve ?? {}) }; delete veMap[victim]; st.ve = veMap;
      }
      // (3) אספקות-lend: מוחזרות-מ-LEND_POT ונשרפות (חוב-פתוח נדחה מעלה)
      if (posP) {
        const ls = lendState(st);
        const pos = ls.positions[victim]!;
        const markets = { ...ls.markets };
        let suppliesTotal = 0;
        for (const [a, sp] of Object.entries(pos.s)) {
          const take = sp.mu + sp.earned;
          addBal(st, LEND_POT, a, -take);
          burnMu(a, take);
          const m = markets[a]!;
          markets[a] = { ...m, sMu: m.sMu - sp.mu, sEarnedMu: Math.max(0, m.sEarnedMu - sp.earned), lastH: st.height };
          suppliesTotal += sp.mu;
        }
        const pMaps = { ...ls.positions }; delete pMaps[victim];
        st.lend = { ...ls, markets, positions: pMaps, totals: { ...ls.totals, suppliesMu: ls.totals.suppliesMu - suppliesTotal } };
      }
      // (4) חיסכון: הקרן-שנפקדה נשרפת מ-save-pot ו-potMu מתואם (החלוקה-לחוסכים-החיים נשארת מדויקת)
      const svP = st.savings?.positions?.[victim];
      if (svP && st.savings) {
        addBal(st, SAVE_POT, "USDS", -(svP.mu + svP.owedMu));
        burnMu("USDS", svP.mu + svP.owedMu);
        const q = { ...st.savings.positions }; delete q[victim];
        st.savings = { ...st.savings, positions: q, potMu: st.savings.potMu - svP.mu };
      }
      // (5) שריפת-כל-היתרות (השער-למעלה מבטיח: אין-נעילות-שיוריות) ומחיקת-החשבון
      const wb = { ...(st.balances[victim] ?? {}) };
      for (const a of Object.keys(wb)) {
        const tot = bal(st, victim, a);
        if (tot > 0) { addBal(st, victim, a, -tot); burnMu(a, tot); }
      }
      delete st.balances[victim];
      if (st.locked) { const l = { ...st.locked }; delete l[victim]; st.locked = l; }
      const purgedCredits = st.credits[victim] ?? 0;
      const cr = { ...st.credits }; delete cr[victim]; st.credits = cr;
      if (purgedCredits > 0) {
        // חוק-הדלק (µ-מדויק): הקרדיטים-שנמחקו מוצהרים-במקביל — Σcredits+gas−minted נשאר מדויק
        const adj = ensureAdj();
        adj.creditsMu = (adj.creditsMu ?? 0) - purgedCredits;
      }
      if (st.faucetAt?.[victim] !== undefined) { const f = { ...st.faucetAt }; delete f[victim]; st.faucetAt = f; }
      if (st.bondUserH?.[victim] !== undefined) { const bU = { ...st.bondUserH }; delete bU[victim]; st.bondUserH = bU; }
      if (st.soldierSeedCounts?.[victim]) { const sS = { ...st.soldierSeedCounts }; delete sS[victim]; st.soldierSeedCounts = sS; }
      st.journal.push({
        h: st.height, t: nowMs, soldier: issuer, action: "agent_purge",
        note: `purged ${victim}: ${targets.length} orders canceled · burned ${Object.entries(burned).map(([a, mu]) => `${mu}µ ${a}`).join(" + ") || "0"}${vePos ? ` · ve ${vePos.amt}µ SAOS` : ""}${posP ? " · lend supplies forfeited" : ""} — keyless synthetic book-agent removed by owner mandate (no keys, no control, dead weight)`,
      });
      return { ok: true, gas: 0 };
    }
    case "pool_open": {
      // Roast-71 · POOL-OPEN: פתיחת-בריכה-חדשה-בזמן-ריצה על נכסים-רשומים.
      // עד-היום בריכות-נולדו-רק-בג'נזיס (seedPool-hardcoded) או-בחתימת-השקה
      // (launchpad-graduation) — מה-שהשאיר נכסים-רשומים-עם-מחזיקים-אמת
      // (WSBD/PHIVE/WBLURT) בלי-יציאה-כלל (tier-none בראוטר — בלי-המרה).
      // EXEC-CD-9 · חצי-פתוח (אישור-מפעיל): שני-נתיבים —
      //  · ריבוני (issuer=treasury): זריעה-דו-צדדית-מהיתרות-של-האוצר, LP=√k כולו-לאוצר
      //    (כמו-ג'נזיס), owner=undefined — בלי-שער (המגן-המבני הוא אוצר-בלבד).
      //  · אזרחי (כל-מנפיק-אחר): זריעה-דו-צדדית-מהיתרות-של-הפותח עצמו, LP=√k כולו-לפותח
      //    (הוא-המממן-והוא-הבעלים), owner=מנפיק. הספאם-גייט = **שער-הערבות**:
      //    מינימום-פר-צד (POOL_OPEN_MIN_SIDE_MU) + תקרת-בריכות-פר-פותח
      //    (POOL_OPEN_MAX_PER_ISSUER). אפס-כסף-אוצר-בסיכון; האוצר-רק-מרוויח
      //    (נתח-ה-30% מעמלי-הסוואפ של-בריכות-אזרחיות זורם-אליו כמו-מכול).
      // fail-closed על-כל-שלב · pair-קנוני · נגד-בריכה-קיימת · נכסים-רשומים-בלבד.
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
      const citizen = issuer !== "treasury";
      if (citizen) {
        // שער-הערבות — המינימום פר-צד (אבק-נדחה-לפני-כל-נגיעה-במצב)
        if (amtA < POOL_OPEN_MIN_SIDE_MU || amtB < POOL_OPEN_MIN_SIDE_MU)
          return { ok: false, err: `below-margin-gate-${POOL_OPEN_MIN_SIDE_MU}`, gas: 0 };
        // תקרת-בריכות-פר-פותח (גבול-נזק — אותו-דפוס LPAD_MAX_PER_OWNER)
        let owned = 0;
        for (const p of Object.values(st.pools)) if (p.owner === issuer) owned++;
        if (owned >= POOL_OPEN_MAX_PER_ISSUER) return { ok: false, err: "pool-cap-reached", gas: 0 };
        if (avail(st, issuer, parts[0]) < amtA) return { ok: false, err: "insufficient", gas: 0 };
        if (avail(st, issuer, parts[1]) < amtB) return { ok: false, err: "insufficient", gas: 0 };
      } else {
        if (avail(st, "treasury", parts[0]) < amtA) return { ok: false, err: "insufficient-treasury", gas: 0 };
        if (avail(st, "treasury", parts[1]) < amtB) return { ok: false, err: "insufficient-treasury", gas: 0 };
      }
      const c = consume(); if (c) return c;
      const lpMint = sqrtLp(amtA, amtB); // FIX(R16-a·m8)
      st.pools[canon] = citizen
        ? { a: parts[0] as Asset, b: parts[1] as Asset, ra: amtA, rb: amtB, lp: lpMint, feeAccruedTreasury: 0, swaps: 0, owner: issuer }
        : { a: parts[0] as Asset, b: parts[1] as Asset, ra: amtA, rb: amtB, lp: lpMint, feeAccruedTreasury: 0, swaps: 0 };
      addBal(st, issuer, parts[0], -amtA);
      addBal(st, issuer, parts[1], -amtB);
      addBal(st, issuer, LP_ASSET_PREFIX + canon, lpMint);
      st.journal.push({ h: st.height, t: nowMs, soldier: citizen ? issuer : "treasury", action: "pool_open", note: `${canon} ${amtA}+${amtB}µ · LP ${lpMint}µ${citizen ? ` · owner=${issuer} (margin-gate ${POOL_OPEN_MIN_SIDE_MU}/side)` : ""}` });
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
      // EXEC-CD-9 · מגן-בעלות: סימון-מחדש מזיז רזרבות-אמת בכסף-אוצר — רק על בריכות-
      // ריבוניות (owner=undefined). בריכת-אזרח היא כסף-האזרח: האוצר לא מסתכן בה ולא מזיז לו.
      if (p.owner && p.owner !== "treasury") return { ok: false, err: "citizen-pool-no-repeg", gas: 0 };
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
    case "pool_reseed": {
      // G76-a · POOL-RESEED — החייאה דו-צדדית של בריכת-USDS מתה (מנדט §4).
      // הבעיה-החיה (h1750085): USDS/WSBD נשאב עד rb=1µ — ה-repeg מחשב
      // raNew = refB×rb/refA = 0 → "bad-anchor" (נדחה-כל-פעימה), ו-pool_add
      // נופל-ב-dust-add. הבריכה מפורסמת-אך-בלתי-ניתנת-לציטוט. ה-reseed הוא
      // הנתיב-הכנה היחיד: הרזרבות-הישנות (עדות-האפס) חוזרות-לאוצר, ה-LP
      // (אוצר-בלבד — LP-אזרחי אסור, נבדק fail-closed) נשרף ונולד-מחדש √k,
      // ושני-הצדדים נזרעים ממלאי-אוצר **חופשי** ביחס-העוגן המדויק:
      //   seedA === floor(seedB × refB / refA)  (עוגן-מחייב — אין-זריעה-הפוכה)
      // Σ(balances+reserves) נשמר בדיוק (רזרבות-חוזרות = זרע-יוצא, נטו-בלבד).
      // שער-ה"בריכה-מתה": ה-op מתקבל רק כשה-repeg אינו-מסוגל (raNew≤0) או
      // |premBps| ≥ POOL_RESEED_TRIGGER_BPS — בריכה-בריאה/דקה נדחית.
      if (issuer !== "treasury") return { ok: false, err: "treasury-only", gas: 0 };
      const rsKey = String(op.pair ?? "");
      if (!rsKey) return { ok: false, err: "pair-required", gas: 0 };
      const rsParts = rsKey.split("/");
      if (rsParts.length !== 2 || !rsParts[0] || !rsParts[1]) return { ok: false, err: "bad-pair", gas: 0 };
      const rsCanon = poolKey(rsParts[0], rsParts[1]);
      if (rsKey !== rsCanon) return { ok: false, err: "non-canonical-pair", gas: 0 };
      const rp = st.pools[rsCanon];
      if (!rp) return { ok: false, err: "pool-not-found", gas: 0 };
      if (rp.owner && rp.owner !== "treasury") return { ok: false, err: "citizen-pool-no-reseed", gas: 0 };
      const rsRefA = st.assets[rp.a]?.refPrice ?? 0;
      const rsRefB = st.assets[rp.b]?.refPrice ?? 0;
      if (!(rsRefA > 0) || !(rsRefB > 0)) return { ok: false, err: "no-anchor", gas: 0 };
      // מגן-LP-אזרחי: סריקת-יתרות-LP-חיות — כל-מחזיק-שאינו-אוצר = דחייה (אסור
      // לדלל-כסף-אזרח בסימון-מחדש; ה-LP-האוצר נעול-לצמיתות מהג'נזיס ממילא).
      const rsLpKey = LP_ASSET_PREFIX + rsCanon;
      for (const [who, wallet] of Object.entries(st.balances)) {
        if (who === "treasury") continue;
        if ((wallet[rsLpKey] ?? 0) > 0) return { ok: false, err: "citizen-lp-present", gas: 0 };
      }
      const seedB = op.amountB ?? 0;
      const seedA = op.amount ?? 0;
      if (!(seedB > 0) || !(seedA > 0)) return { ok: false, err: "bad-amount", gas: 0 };
      // שער-הבריכה-המתה — אותו-חישוב של R26-ALL בפעימה (שלמים-בלבד):
      const rsMid = rp.rb > 0 ? Math.floor((rp.ra * 1000) / rp.rb) : 0;
      const rsAnchorMid = Math.floor((rsRefB * 1000) / rsRefA);
      const rsPremBps = rsMid > 0 ? Math.floor(((rsMid - rsAnchorMid) * 10_000) / rsAnchorMid) : 10_000;
      const rsRaRepeg = Math.floor((rsRefB * rp.rb) / rsRefA);
      if (rsRaRepeg > 0 && Math.abs(rsPremBps) < POOL_RESEED_TRIGGER_BPS) {
        return { ok: false, err: "pool-not-dead", gas: 0 };
      }
      // עוגן-מחייב: seedA חייב להיות הנגזרת המדויקת של seedB (שלמים, זהה-בריפליי):
      const rsSeedA = Math.floor((rsRefB * seedB) / rsRefA);
      if (seedA !== rsSeedA) return { ok: false, err: "off-anchor-seed", gas: 0 };
      if (!(rsSeedA > 0)) return { ok: false, err: "seed-dust", gas: 0 };
      // מימון fail-closed: הרזרבות-הישנות חוזרות-לאוצר לפני-הזריעה — הנטו-הוא
      // מה-שנבדק; אין-הטבעה ואין-שאילה.
      if (avail(st, "treasury", rp.a) + rp.ra < seedA) return { ok: false, err: "insufficient-treasury", gas: 0 };
      if (avail(st, "treasury", rp.b) + rp.rb < seedB) return { ok: false, err: "insufficient-treasury", gas: 0 };
      const rsOldLp = st.balances["treasury"]?.[rsLpKey] ?? 0;
      const c = consume(); if (c) return c;
      const rsMidOld = rsMid;
      // 1) הרזרבות-הישנות + הזרע-החדש — נטו-אחד (שני-הצדדים):
      addBal(st, "treasury", rp.a, rp.ra - seedA);
      addBal(st, "treasury", rp.b, rp.rb - seedB);
      // 2) LP-ישן נשרף, LP-חדש √k נולד לאוצר (נעול-לצמיתות — מורשת pool_lock):
      if (rsOldLp > 0) addBal(st, "treasury", rsLpKey, -rsOldLp);
      rp.ra = seedA; rp.rb = seedB;
      rp.lp = sqrtLp(seedA, seedB);
      addBal(st, "treasury", rsLpKey, rp.lp);
      // 3) פעמון-העמלה-הדינמית נולד-מחדש — חוק-הבסיס 30bps (ההיסטוריה של
      //    feeAccruedTreasury/swaps נשמרת — מדידה לא-נמחקת):
      rp.volBpsEwma = 0;
      rp.dynFeeBps = FEE_BPS;
      st.journal.push({ h: st.height, t: nowMs, soldier: "treasury", action: "pool_reseed", note: `${rsCanon} reseed dead-pool (mid was ${rsMidOld}µ, anchor ${rsAnchorMid}µ, prem ${rsPremBps}bps) → ${seedA}µ ${rp.a} / ${seedB}µ ${rp.b} on-anchor · LP ${rsOldLp}→${rp.lp} · Σ נשמר` });
      return { ok: true, gas };
    }
    case "pool_add":
    case "pool_xAdd": {
      const r = poolAdd(st, op, nowMs, consume);
      // FIX(F-12 · BMC-caught): משפחת-הבריכות צורכת-גז-אמת (consume→chargeGas)
      // אך החזירה gas:0 בתוצאה — הפרת-חוזה-{ok,gas} (Roast-65-a LOW-12 כוסה
      // order/cancel/fill ופספס-את-הבריכות). מאמתים-חיצוניים שקוראים-קבלות
      // ראו-גז-אפס. מדווחים את-הגז-שנחייב-בפועל; מתמטיקת-המצב-לא-נגעה.
      return r.ok ? { ...r, gas } : r;
    }
    case "pool_swap":
    case "pool_x": {
      const r = poolSwap(st, op, nowMs, consume);
      return r.ok ? { ...r, gas } : r; // FIX(F-12 · BMC-caught): ראה-pool_add
    }
    case "pool_rmw":
    case "pool_xRm": {
      const r = poolRm(st, op, consume);
      return r.ok ? { ...r, gas } : r; // FIX(F-12 · BMC-caught): ראה-pool_add
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
      st.treasuryProfitEver = (st.treasuryProfitEver ?? 0) + amt; // FIX(R46): המונה-המונוטוני עולה בכל-קציר — גם-אם היתרה מנוקזת אחר-כך לדלק
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
      // FIX(vault-pot-avail · measured h1638300 HALT): אותו-הגנה כמו-נתיבי-lend (pot-short) —
      // שחרור-בטחונות שעולה על הפוט נדחה-כנה במקום לחייב את חשבון-העד לשלילי ולעצור את השרשרת ב-seal.
      if (wd > 0 && avail(st, VAULT_POT, VAULT_COLLATERAL) < wd) return { ok: false, err: "pot-short", gas: 0 };
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
      // FIX(vault-pot-avail · same class as vault_repay): נזילות על פוט שאינו מספיק = דחייה-כנה, לא ספר-שלילי.
      if (avail(st, VAULT_POT, VAULT_COLLATERAL) < seizeMu) return { ok: false, err: "pot-short", gas: 0 };
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
      // FIX(vault-pot-avail · same class as vault_repay): גם-ה-backstop אינו רשאי לחייב את הפוט לשלילי.
      if (avail(st, VAULT_POT, VAULT_COLLATERAL) < v.colMu) return { ok: false, err: "pot-short", gas: 0 };
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
      const s = st.savings ?? { positions: {}, potMu: 0, paidMu: 0, lastIncomeMu: savingsIncomeMu(st), dayPaidMu: 0, dayPaidPrevMu: 0, dayMarkH: st.height, windows: 0, opens: 0, closes: 0 };
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
    /* ── R44 · THE-MARKET — שוק-הכספים הריבוני (peer-to-pool) ────────────────── */
    case "lend_supply": {
      // הפקדת-נכס לבריכת-האשראי: מלווה שם-כסף, לווה שם-בטחונות. העברה-טהורה
      // (משתמש → lend-pot) — אפס-הטבעה; הריבית תגיע-רק-מלווים-אמת-שישלמו.
      const amt = op.amount ?? 0;
      const asset = String(op.asset ?? "");
      if (!(asset in LEND_MARKETS)) return { ok: false, err: "market-not-listed", gas: 0 };
      if (!Number.isSafeInteger(amt) || amt <= 0) return { ok: false, err: "bad-amount", gas: 0 };
      const ls0 = lendState(st);
      const m0 = ls0.markets[asset];
      if ((m0?.sMu ?? 0) + amt > LEND_GLOBAL_CAP_MU) return { ok: false, err: "market-cap", gas: 0 };
      const pos0 = ls0.positions[issuer] ?? { s: {}, b: {} };
      if ((pos0.s[asset]?.mu ?? 0) + amt > LEND_POS_CAP_MU) return { ok: false, err: "position-cap", gas: 0 };
      if (avail(st, issuer, asset) < amt) return { ok: false, err: "insufficient-balance", gas };
      const c = consume(); if (c) return c;
      addBal(st, issuer, asset, -amt);
      addBal(st, LEND_POT, asset, amt);
      const prev = pos0.s[asset] ?? { mu: 0, earned: 0 };
      const ls: NonNullable<DexState["lend"]> = {
        ...ls0,
        markets: { ...ls0.markets, [asset]: { ...(m0 ?? { sMu: 0, bMu: 0, sEarnedMu: 0, resMu: 0, lastH: 0 }), sMu: (m0?.sMu ?? 0) + amt, lastH: st.height } },
        positions: { ...ls0.positions, [issuer]: { ...pos0, s: { ...pos0.s, [asset]: { mu: prev.mu + amt, earned: prev.earned } } } },
        totals: { ...ls0.totals, suppliesMu: ls0.totals.suppliesMu + amt, opens: ls0.totals.opens + 1 },
      };
      st.lend = ls;
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "lend_supply", note: `+${amt}µ ${asset} → lend-pot (pool ${(m0?.sMu ?? 0) + amt}µ · util ${lendUtilBps(ls.markets[asset]) / 100}% · borrowAPR ${lendBorrowAprBps(ls.markets[asset]) / 100}%)` });
      return { ok: true, gas };
    }
    case "lend_withdraw": {
      // משיכת-קרן + כל-הריבית-המדודה-שנצברה. כנות-נזילות: אם-הבריכה-מרוקנת
      // (הלווים מחזיקים) — pot-short כנה, כמו-החיסכון. רצפת-ה-10% בשאילה
      // מבטיחה-שתמיד-תהיה-משיכה-אפשרית-בחלק-מהקרן.
      const asset = String(op.asset ?? "");
      if (!(asset in LEND_MARKETS)) return { ok: false, err: "market-not-listed", gas: 0 };
      const ls = lendState(st);
      const pos = ls.positions[issuer];
      const sp = pos?.s[asset];
      if (!pos || !sp || sp.mu + sp.earned <= 0) return { ok: false, err: "no-position", gas: 0 };
      const amt = Math.floor(op.amount ?? -1); // השמטה/-1 = הכל
      if (amt === 0) return { ok: false, err: "bad-amount", gas: 0 };
      const takeMu = amt < 0 ? sp.mu : Math.min(amt, sp.mu);
      const earned = sp.earned; // ריבית-מדודה משולמת-תמיד-במלואה (מדפוס-החיסכון)
      if (avail(st, LEND_POT, asset) < takeMu + earned) return { ok: false, err: "pot-short", gas };
      const c = consume(); if (c) return c;
      addBal(st, LEND_POT, asset, -(takeMu + earned));
      addBal(st, issuer, asset, takeMu + earned);
      const m = ls.markets[asset]!;
      const restMu = sp.mu - takeMu;
      const sMaps = { ...pos.s };
      if (restMu <= 0 && earned <= 0) delete sMaps[asset]; else sMaps[asset] = { mu: restMu, earned: 0 };
      const pMaps = { ...ls.positions };
      if (Object.keys(sMaps).length === 0 && Object.keys(pos.b).length === 0) delete pMaps[issuer]; else pMaps[issuer] = { ...pos, s: sMaps };
      st.lend = {
        ...ls,
        markets: { ...ls.markets, [asset]: { ...m, sMu: m.sMu - takeMu, sEarnedMu: Math.max(0, m.sEarnedMu - earned), lastH: st.height } },
        positions: pMaps,
        totals: { ...ls.totals, suppliesMu: ls.totals.suppliesMu - takeMu, closes: ls.totals.closes + 1 },
      };
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "lend_withdraw", note: `withdraw ${takeMu}µ ${asset} + earned ${earned}µ (measured) · pool ${m.sMu - takeMu}µ` });
      return { ok: true, gas };
    }
    case "lend_borrow": {
      // שאילה-מהבריכה נגד-בטחונות: HF ≥ 1.10 (חוצץ), רצפת-נזילות-10% (המלווים
      // תמיד-יוכלו-למשוך), תקרות-שוק-ועמדה. החוב נפתח-בקרן-נקייה + ריבית-מונפת
      // בגובה (אותה-מתמטיקה-דטרמיניסטית-של-הכספת — צבירה-עצלה-בקריאה).
      const asset = String(op.asset ?? "");
      if (!(asset in LEND_MARKETS)) return { ok: false, err: "market-not-listed", gas: 0 };
      const amt = Math.floor(op.amount ?? 0);
      if (!Number.isSafeInteger(amt) || amt <= 0) return { ok: false, err: "bad-amount", gas: 0 };
      const ls = lendState(st);
      const m = ls.markets[asset];
      if ((m?.bMu ?? 0) + amt > LEND_GLOBAL_CAP_MU) return { ok: false, err: "market-cap", gas: 0 };
      const pos = ls.positions[issuer] ?? { s: {}, b: {} };
      // תקציב-נזילות: השאילה לא-תרוקן-את-הבריכה מתחת-לרצפת-10% מהאספקה
      const cash = avail(st, LEND_POT, asset);
      const floorMu = Math.floor(((m?.sMu ?? 0) * (10_000 - LEND_MAX_UTIL_BPS)) / 10_000);
      if (cash - amt < floorMu) return { ok: false, err: "cash-floor", gas: 0 };
      if (cash < amt) return { ok: false, err: "pot-short", gas: 0 };
      // בדיקת-בריאות-מלאה: אחרי-השאילה HF (ב-LTV) ≥ 1.10
      const simB = { ...pos.b };
      const prevB = simB[asset];
      if (prevB) {
        const debtNow = lendDebtNow(prevB, lendBorrowAprBps(m), st.height);
        simB[asset] = { mu: prevB.mu + amt, int: debtNow - prevB.mu, atH: st.height };
      } else {
        simB[asset] = { mu: amt, int: 0, atH: st.height };
      }
      let colV = 0, debtV = 0;
      for (const [a, s2] of Object.entries(pos.s)) {
        const ltv = LEND_MARKETS[a] ?? 0;
        colV += Math.floor((lendAssetValueMu(st, a, s2.mu + s2.earned) * ltv) / 10_000);
      }
      for (const [a, b2] of Object.entries(simB)) {
        if (b2.mu + b2.int <= 0) continue;
        const d = lendDebtNow(b2, lendBorrowAprBps(ls.markets[a]), st.height);
        debtV += lendAssetValueMu(st, a, d);
      }
      if (debtV > colV || colV <= 0) return { ok: false, err: "no-collateral", gas: 0 };
      if (Math.floor((colV * 100) / debtV) < LEND_HF_BUFFER) return { ok: false, err: "health-factor", gas: 0 };
      const c = consume(); if (c) return c;
      addBal(st, LEND_POT, asset, -amt);
      addBal(st, issuer, asset, amt);
      const bMaps = { ...pos.b };
      if (prevB) {
        const debtNow = lendDebtNow(prevB, lendBorrowAprBps(m), st.height);
        bMaps[asset] = { mu: prevB.mu + amt, int: debtNow - prevB.mu, atH: st.height };
      } else {
        bMaps[asset] = { mu: amt, int: 0, atH: st.height };
      }
      st.lend = {
        ...ls,
        markets: { ...ls.markets, [asset]: { ...(m ?? { sMu: 0, bMu: 0, sEarnedMu: 0, resMu: 0, lastH: 0 }), bMu: (m?.bMu ?? 0) + amt, lastH: st.height } },
        positions: { ...ls.positions, [issuer]: { ...pos, b: bMaps } },
        totals: { ...ls.totals, borrowsMu: ls.totals.borrowsMu + amt },
      };
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "lend_borrow", note: `borrow ${amt}µ ${asset} (util ${lendUtilBps(st.lend.markets[asset]) / 100}% · APR ${lendBorrowAprBps(st.lend.markets[asset]) / 100}% · HF after ${Math.floor((colV * 100) / debtV) / 100})` });
      return { ok: true, gas };
    }
    case "lend_repay": {
      // פירעון — הנה מגיע-הכסף-האמת: הריבית שהלווה-משלם (µ-אמת-מיתרתו) נחתכת:
      // 90% → מלווים פרו-ראטה-לפי-קרן (מדידה-חיה, אחרון-בולע-אבק), 10% → אוצר.
      // אפס-הטבעה: הכל-העברות-טהורות. אינווריאנטת-הספרים נשמרת-מעצמה.
      const asset = String(op.asset ?? "");
      if (!(asset in LEND_MARKETS)) return { ok: false, err: "market-not-listed", gas: 0 };
      const ls = lendState(st);
      const pos = ls.positions[issuer];
      const bp = pos?.b[asset];
      if (!pos || !bp || bp.mu + bp.int <= 0) return { ok: false, err: "no-debt", gas: 0 };
      const amt = Math.floor(op.amount ?? -1); // השמטה/-1 = הכל
      if (amt === 0) return { ok: false, err: "bad-amount", gas: 0 };
      const m = ls.markets[asset]!;
      const debt = lendDebtNow(bp, lendBorrowAprBps(m), st.height);
      const pay = amt < 0 ? debt : Math.min(amt, debt);
      if (pay <= 0) return { ok: false, err: "nothing-to-do", gas: 0 };
      if (avail(st, issuer, asset) < pay) return { ok: false, err: "insufficient-balance", gas };
      const accrued = debt - bp.mu;                     // כל-הריבית-שנצברה (מונפת + טרייה)
      const interestPart = Math.min(pay, accrued);      // ריבית-נגבית-קודם
      const principalPart = pay - interestPart;
      const c = consume(); if (c) return c;
      addBal(st, issuer, asset, -pay);
      addBal(st, LEND_POT, asset, pay);
      // חלוקת-הריבית: 90% מלווים / 10% אוצר — מהכסף-שהגיע-בפועל
      const toSuppliers = Math.floor((interestPart * (10_000 - LEND_RESERVE_FACTOR_BPS)) / 10_000);
      const toReserve = interestPart - toSuppliers;
      if (toReserve > 0) addBal(st, LEND_POT, asset, -toReserve), addBal(st, "treasury", asset, toReserve);
      // פרו-ראטה-לפי-קרן-חיה (האחרון-בסדר-הקנוני בולע-את-האבק — שימור-מדויק-עד-ה-µ)
      const positions = { ...ls.positions };
      let left = toSuppliers;
      const suppliers = Object.keys(positions).filter((k) => (positions[k]!.s[asset]?.mu ?? 0) > 0);
      for (let i = 0; i < suppliers.length; i++) {
        const p = positions[suppliers[i]]!;
        const sp = p.s[asset]!;
        if (i === suppliers.length - 1) {
          if (left > 0) { positions[suppliers[i]] = { ...p, s: { ...p.s, [asset]: { ...sp, earned: sp.earned + left } } }; left = 0; }
        } else {
          const share = Math.floor((toSuppliers * sp.mu) / (m.sMu));
          if (share > 0) { positions[suppliers[i]] = { ...p, s: { ...p.s, [asset]: { ...sp, earned: sp.earned + share } } }; left -= share; }
        }
      }
      // סגירת-החוב: ריבית-קודם, קרן-אחר-כך (אותו-סדר-חשבונאי-כמו-הכספת)
      const bMaps = { ...positions[issuer]!.b };
      const newInt = accrued - interestPart;
      const newMu = bp.mu - principalPart;
      if (newMu + newInt <= 0) delete bMaps[asset]; else bMaps[asset] = { mu: newMu, int: newInt, atH: st.height };
      const pAfter = positions[issuer]!;
      if (Object.keys(bMaps).length === 0 && Object.keys(pAfter.s).length === 0) delete positions[issuer]; else positions[issuer] = { ...pAfter, b: bMaps };
      st.lend = {
        ...ls,
        markets: { ...ls.markets, [asset]: { ...m, bMu: Math.max(0, m.bMu - principalPart), sEarnedMu: m.sEarnedMu + toSuppliers, resMu: m.resMu + toReserve, lastH: st.height } },
        positions,
        totals: { ...ls.totals, borrowsMu: Math.max(0, ls.totals.borrowsMu - principalPart), interestPaidMu: ls.totals.interestPaidMu + interestPart, resToTreasuryMu: ls.totals.resToTreasuryMu + toReserve },
      };
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "lend_repay", note: `repay ${pay}µ ${asset} (interest ${interestPart}µ: ${toSuppliers}µ→${suppliers.length} suppliers · ${toReserve}µ→treasury · principal ${principalPart}µ) · debt now ${newMu + newInt}µ` });
      return { ok: true, gas };
    }
    case "lend_liquidate": {
      // ניזולת-אזרח: HF < 1 — כל-אחד-יכול-לסגור-חוב-ולקחת-בטחונות+5%.
      // הבטחון-הנתפס: הנכס-המסופק-בעל-הערך-הגדול-של-הלווה (דטרמיניסטי).
      const owner = String(op.owner ?? "").toLowerCase();
      if (!owner || FORBIDDEN_KEYS.has(owner)) return { ok: false, err: "bad-owner", gas: 0 };
      const asset = String(op.asset ?? "");
      if (!(asset in LEND_MARKETS)) return { ok: false, err: "market-not-listed", gas: 0 };
      const ls = lendState(st);
      const pos = ls.positions[owner];
      const bp = pos?.b[asset];
      if (!pos || !bp || bp.mu + bp.int <= 0) return { ok: false, err: "no-debt", gas: 0 };
      if (lendHealthFactor(st, owner) >= 100) return { ok: false, err: "not-liquidatable", gas: 0 };
      const m = ls.markets[asset]!;
      const debt = lendDebtNow(bp, lendBorrowAprBps(m), st.height);
      const pay = Math.min(Math.floor(op.amount ?? -1) < 0 ? debt : Math.floor(op.amount ?? -1), debt);
      if (pay <= 0) return { ok: false, err: "bad-amount", gas: 0 };
      if (avail(st, issuer, asset) < pay) return { ok: false, err: "insufficient-balance", gas };
      // בטחון-היעד: הספקה-הגדולה-בערך (שוויון → סדר-אלפביתי — דטרמיניסטי)
      let colAsset = "", colVal = 0;
      for (const [a, sp] of Object.entries(pos.s)) {
        const v = lendAssetValueMu(st, a, sp.mu + sp.earned);
        if (v > colVal) { colVal = v; colAsset = a; }
      }
      if (!colAsset || colVal <= 0) return { ok: false, err: "no-collateral", gas: 0 };
      const ref = st.assets[colAsset]?.refPrice ?? 0;
      if (ref <= 0) return { ok: false, err: "no-collateral-price", gas: 0 };
      const seizeValMu = Math.min(Math.floor((pay * (10_000 + LEND_LIQ_BONUS_BPS)) / 10_000), colVal);
      const colSp = pos.s[colAsset]!;
      const seizeMu = Math.min(colSp.mu + colSp.earned, Math.floor((seizeValMu * 1000) / ref));
      if (seizeMu <= 0) return { ok: false, err: "seize-too-small", gas: 0 };
      if (avail(st, LEND_POT, colAsset) < seizeMu) return { ok: false, err: "pot-short", gas: 0 };
      const c = consume(); if (c) return c;
      addBal(st, issuer, asset, -pay);
      addBal(st, LEND_POT, asset, pay);
      const accrued = debt - bp.mu;
      const interestPart = Math.min(pay, accrued);
      const principalPart = pay - interestPart;
      const toSuppliers = Math.floor((interestPart * (10_000 - LEND_RESERVE_FACTOR_BPS)) / 10_000);
      const toReserve = interestPart - toSuppliers;
      if (toReserve > 0) addBal(st, LEND_POT, asset, -toReserve), addBal(st, "treasury", asset, toReserve);
      const positions = { ...ls.positions };
      let left = toSuppliers;
      const suppliers = Object.keys(positions).filter((k) => (positions[k]!.s[asset]?.mu ?? 0) > 0);
      for (let i = 0; i < suppliers.length; i++) {
        const p = positions[suppliers[i]]!;
        const sp = p.s[asset]!;
        if (i === suppliers.length - 1) {
          if (left > 0) { positions[suppliers[i]] = { ...p, s: { ...p.s, [asset]: { ...sp, earned: sp.earned + left } } }; left = 0; }
        } else {
          const share = Math.floor((toSuppliers * sp.mu) / m.sMu);
          if (share > 0) { positions[suppliers[i]] = { ...p, s: { ...p.s, [asset]: { ...sp, earned: sp.earned + share } } }; left -= share; }
        }
      }
      // תפיסת-הבטחון: מה-pot אל-המפרק (הבטחון-הופקד-שם-פיזית)
      addBal(st, LEND_POT, colAsset, -seizeMu);
      addBal(st, issuer, colAsset, seizeMu);
      // חלוקת-התפיסה בין-קרן-לריבית (שתי-המראות חייבות-להתאים-לעמדות):
      // takeFromEarned נגבע-קודם — הריבית-שנצברה שייכת-לבעלים באותה-מידה
      const oPos = positions[owner]!;
      const oS = { ...oPos.s };
      const seizedSp = oS[colAsset]!;
      const takeFromEarned = Math.min(seizeMu, seizedSp.earned);
      const takeFromMu = seizeMu - takeFromEarned;
      const restMu = seizedSp.mu - takeFromMu;
      const restEarned = seizedSp.earned - takeFromEarned;
      if (restMu + restEarned <= 0) delete oS[colAsset]; else oS[colAsset] = { mu: restMu, earned: restEarned };
      const oB = { ...oPos.b };
      const newInt = accrued - interestPart;
      const newMu = bp.mu - principalPart;
      if (newMu + newInt <= 0) delete oB[asset]; else oB[asset] = { mu: newMu, int: newInt, atH: st.height };
      if (Object.keys(oS).length === 0 && Object.keys(oB).length === 0) delete positions[owner]; else positions[owner] = { s: oS, b: oB };
      // FIX(zai-audit-2026-10-11 · H2 · self-collateral-clobber): כש-colAsset === asset
      // שני המפתחות ב-spread היו זהים — האחרון ([colAsset], מהמצב-הישן) דרס את הראשון
      // ([asset], עם bMu/resMu/sEarnedMu-החדשים) → עדכוני-שוק אבדו בשקט (bMu מנופח,
      // עקומת-APR מוטה, ספר-מלווים סוטה מ-Σpositions — והמבקר לא צועק כי הערכים
      // שלמים-בטוחים). מיזוג-מתוקן: דלתא-אחת לשוק-אחד כשהנכס זהה.
      const mktA = ls.markets[asset]!;
      const mktB = ls.markets[colAsset]!;
      const updA = { bMu: Math.max(0, m.bMu - principalPart), sEarnedMu: m.sEarnedMu + toSuppliers, resMu: m.resMu + toReserve, lastH: st.height };
      const updB = { sMu: Math.max(0, mktB.sMu - takeFromMu), sEarnedMu: Math.max(0, mktB.sEarnedMu - takeFromEarned), lastH: st.height };
      const mergedMarkets: typeof ls.markets = { ...ls.markets };
      if (colAsset === asset) {
        mergedMarkets[asset] = { ...mktA, ...updA, sMu: updB.sMu, sEarnedMu: Math.max(0, updA.sEarnedMu - takeFromEarned), lastH: st.height };
      } else {
        mergedMarkets[asset] = { ...mktA, ...updA };
        mergedMarkets[colAsset] = { ...mktB, ...updB };
      }
      st.lend = {
        ...ls,
        markets: mergedMarkets,
        positions,
        totals: { ...ls.totals, borrowsMu: Math.max(0, ls.totals.borrowsMu - principalPart), interestPaidMu: ls.totals.interestPaidMu + interestPart, resToTreasuryMu: ls.totals.resToTreasuryMu + toReserve, liquidations: ls.totals.liquidations + 1 },
      };
      st.journal.push({ h: st.height, t: nowMs, soldier: issuer, action: "lend_liquidate", note: `liquidated ${owner}: paid ${pay}µ ${asset} · seized ${seizeMu}µ ${colAsset} (+5% bonus) · HF was ${lendHealthFactor(st, owner) / 100}` });
      return { ok: true, gas };
    }
    // ── G70 §7.2 · הגשר-האטומי-הפנימי (HTLC) — הלוגיקה ב-htlc.ts (אפס-מעגל-ריצה);
    // שער-נכס-ידוע כאן בדלת (אותו-knownAsset של-הגרעין) ──
    case "htlc_create": {
      if (!knownAsset(st, op.asset)) return { ok: false, err: "unknown-asset", gas: 0 };
      // W49-b · חוק-היחידות בדלת: amount חייב להיות שלם-חיובי (µ) — ממתינה-טיפוסית
      // לפני-consume; move() היה זורק חריגה על-שבר עשרוני (Roast-65-a L2 — דחייה-טיפוסית במקום-זריקה).
      const amt = op.amount;
      if (typeof amt !== "number" || !Number.isSafeInteger(amt) || amt <= 0)
        return { ok: false, err: "bad-amount", gas: 0 };
      const r = createHtlc(st, op, consume);
      if (!r.ok) return { ok: false, err: r.err, gas: 0 };
      recordHtlcReceipt(st, "htlc_create", String(op.htlcId ?? "")); // W49-b — קבלה-אטומית-עם-המעבר
      return { ok: true, gas };
    }
    case "htlc_claim": {
      const r = claimHtlc(st, op, consume);
      if (!r.ok) return { ok: false, err: r.err, gas: 0 };
      recordHtlcReceipt(st, "htlc_claim", String(op.htlcId ?? "")); // W49-b — העד (preimage) נאטם-בקבלה
      return { ok: true, gas };
    }
    case "htlc_refund": {
      const r = refundHtlc(st, op, consume);
      if (!r.ok) return { ok: false, err: r.err, gas: 0 };
      recordHtlcReceipt(st, "htlc_refund", String(op.htlcId ?? "")); // W49-b — החזר-נאטם-בקבלה
      return { ok: true, gas };
    }
    default:
      return { ok: false, err: "unhandled-op", gas: 0 };
  }
}

export { canon, sha256, stateRootOf };
