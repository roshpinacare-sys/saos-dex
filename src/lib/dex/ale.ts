/**
 * ale.ts — ALE · מנוע-הנזילות-האוטונומית (Task 55)
 * ═════════════════════════════════════════════════════════════════════════════
 * דבר-המפעיל: "איך נוכל מתוך כל מה שיש לנו לגרום למערכת להשיג נזילות אוטונומית
 * ולצמוח בלי תלות במשתמשים — נסה לפרוץ דרך על הרשת שלנו בלייב ולאמת".
 *
 * התרגום-הקנוני על הגרעין (אפס-float · אפס-random · אפס-Date.now — גובה-בלוקים
 * טהורים, ריפליי דטרמיניסטי):
 *
 *  1. POL-SEED (האוצר הזורע): כל-ALE_EVERY-בלוקים, חלק-מדוד מה-USDS-החופשי
 *     של האוצר (מעל-רצפת-הראוטר) נזרע-ישירות-לבריכות כנזילות-בעלות-פרוטוקול
 *     (Protocol-Owned Liquidity). ה-LP-מוטבע-לאוצר — הפרוטוקול הוא-ה-LP,
 *     והעמלים-מקומפסמים-אוטומטית בתוך-הרזרבות (Uniswap-V2-native).
 *     מקור-הכסף: עמלות-אמת שנאספו-מהמסחר — המערכת מפרה-את-עצמה.
 *  2. הגנות-ברזל: רצפת-אוצר (לא-מרוקן-אף-פעם — מתחת-ל-ROUTER_USDS_FLOOR
 *     לא-נוגעים), תקרה-פר-מחזור (ALE_MAX_PER_CYCLE), סף-אבק (ALE_MIN_SEED),
 *     וחלוקה-מדודה-לבריכות-לפי-חלק-האוצר (הכי-דל-נזילות-פרוטוקול קודם).
 *  3. הפלאיהול (flywheel): עמלות → רווח-אוצר → revenueCycle (40% שריפה ·
 *     40% קרן-ve · 20% אוצר) → ALE-זורע-מה-20% → בריכות-עמוקות-יותר →
 *     פגיעה-במחיר-קטנה-יותר → מחזור-גבוה-יותר → עמלות-גבוהות-יותר. סגור.
 *  4. אמת-אוטונומית (הבדלנות מול-DEX-ים-אחרים): כל-מספר-כאן נמדד-מהמצב-החי —
 *     fills-של-הארנה (סוחרים-אוטונומיים, אפס-משתמשים-אנושיים), POL%-אמת
 *     (LP-אוצר ÷ LP-כולל), Σשריפות, Σהזרעות. השוואה-חיה: /api/dex/compare.
 *
 * בנוסף (דבר-המפעיל "יש לנו בכספת קצת כסף — תמצא דרך לשמש את הדקס"):
 * מסדרון-העיגון (STEEM→WSTEEM 1:1 מגובה-גיבוי-אמת) הוא-הצינור-מהכספת-החיה
 * לנזילות-המקומית — aleState מדווח-עליו (vaultFeed) מה-backing-האמיתי.
 */
import type { DexState, Pool } from "./kernel";
/* FIX(SWEEP-1c · 2026-10-13): T25's pol-respect-locks calls avail() (lines 69/70/104)
 * but the import was missing — every arena tick that reached the seed path died
 * "avail is not defined" MID-BLOCK: state mutated, no header written, snapshot↔DB
 * desync (measured live: cloud beat 38417068844 BOOT-REFUSED on real corroboration;
 * reproduced locally h26500). One word — the import. */
import { addBal, bal, avail } from "./kernel";
import {
  ALE_EVERY, ALE_SEED_PCT, ALE_MIN_SEED, ALE_MAX_PER_CYCLE,
  ROUTER_USDS_FLOOR,
} from "./kernel";
import { LP_ASSET_PREFIX } from "./amm";
import { RAIL_OWNED_POOLS } from "./rail";

/* ══ 1. POL-SEED — ההזרעה-האוטונומית ═════════════════════════════════════════ */

/** בחירת-בריכות-יעד: כל-הבריכות-החיות, ממוינות-דטרמיניסטית לפי-חלק-האוצר
 * (הכי-דל-נזילות-פרוטוקול קודם) ואז-מפתח-קנוני — בלי-random, ריפליי-אמת. */
function seedTargets(st: DexState): { key: string; pool: Pool; treasuryShareBps: number }[] {
  const out: { key: string; pool: Pool; treasuryShareBps: number }[] = [];
  for (const [key, p] of Object.entries(st.pools)) {
    const totalLp = p.lp;
    const tLp = bal(st, "treasury", LP_ASSET_PREFIX + key);
    const shareBps = totalLp > 0 ? Math.floor((tLp * 10_000) / totalLp) : 0;
    if (p.ra > 0 && p.rb > 0) out.push({ key, pool: p, treasuryShareBps: shareBps });
  }
  out.sort((x, y) => (x.treasuryShareBps - y.treasuryShareBps) || (x.key < y.key ? -1 : 1));
  return out;
}

/** הזרעת-USDS-לבריכה: שני-הצדדים-פרופורציונלית-ליחס-הרזרבות הנוכחי, LP-מוטבע
 * לאוצר — שכפול-מדויק של-מתמטיקת poolAdd אך-מהפרוטוקול-עצמו (בלי-עמלה-עצמית).
 * אם-לאוצר אין-מספיק-מהצד-השני — מצמצמים-לפי-הצד-המחסום (כנות, לא-הדפסה). */
function seedPool(st: DexState, key: string, p: Pool, usdsBudgetMu: number, nowMs: number): number {
  if (usdsBudgetMu < ALE_MIN_SEED || p.ra <= 0 || p.rb <= 0) return 0;
  // איזה-צד-הוא-USDS (ממוין-אלפבתית — USDS יכול-להיות a או b)
  const usdsIsA = p.a === "USDS";
  const rUsds = usdsIsA ? p.ra : p.rb;
  const rOther = usdsIsA ? p.rb : p.ra;
  if (rUsds <= 0 || rOther <= 0) return 0;
  const otherAsset = usdsIsA ? p.b : p.a;
  // FIX(T25 · pol-respect-locks): bal → avail — הזרעת-POL חייבת-לסגד לנעילות-הערבות
  // של-פקודות-השומר-החיות על-אותו-מלאי. נמדד-חי (סימולציית-T25, HALT h21201):
  // מלאי-PHIVE/ENERGY-אמת-ראשון-באוצר (כבשן-הנזילות) חשף-חור-ישן: pol_seed/pol_acquire
  // חייבו-bal-גולמי ודרדרו-מתחת-לנעילת-אסק-של-פקודת-שומר → negative-balance:maker-base.
  const tUsds = avail(st, "treasury", "USDS");
  const tOther = avail(st, "treasury", otherAsset);
  const maxByOther = tOther > 0 ? Math.floor((tOther * rUsds) / rOther) : 0;
  const addUsds = Math.min(usdsBudgetMu, maxByOther);
  if (addUsds < ALE_MIN_SEED || tUsds < addUsds) return 0;
  const addOther = Math.floor((addUsds * rOther) / rUsds);
  if (addOther <= 0) return 0;
  const lpMint = p.lp > 0 ? Math.max(1, Math.floor((p.lp * addUsds) / rUsds)) : Math.floor(Math.sqrt(addUsds * addOther));
  // חיוב-אמת + הזרעה + הטבעת-LP-לאוצר (אטומי בתוך-הבלוק — דבר-גורר-דבר)
  addBal(st, "treasury", "USDS", -addUsds);
  addBal(st, "treasury", otherAsset, -addOther);
  if (usdsIsA) { p.ra += addUsds; p.rb += addOther; } else { p.rb += addUsds; p.ra += addOther; }
  // FIX(Roast-66 · lp-supply-ghost): ההטבעה-הייתה-חצי-פעולה — addBal(LP) בלי p.lp +=
  // → כל-pol_seed יצר-LP-רפאים: Σbal(LP|) גדל-והמונה-הקנוני של-הבריכה נשאר →
  // implied = pool.lp − Σbal צנח-בכל-מחזור (הוכח-חי: HALT h20808, drift −4,448).
  // עכשיו: שיקוף-מלא של-מתמטיקת poolAdd — המונה-והיתרה-זזים-יחד, אפס-רפאים.
  p.lp += lpMint;
  addBal(st, "treasury", LP_ASSET_PREFIX + key, lpMint);
  st.journal.push({
    h: st.height, t: nowMs, soldier: "ale", action: "pol_seed",
    profitMu: addUsds, note: `POL-seed ${key}: +${addUsds}µ USDS +${addOther}µ ${otherAsset} → ${lpMint}µ LP`,
  });
  return addUsds;
}

/**
 * רכישת-הצד-השני-מהבריכה-עצמה (מוסכמת-הגרעין, כמו-revenueCycle: הפרוטוקול
 * אינו-גובה-עמלה-מעצמו — כנות): ממירים-USDS→otherAsset במתמטיקת-בריכה טהורה.
 * חגורת-בטיחות: פגיעה-במחיר-מוגבלת — swapIn ≤ rUsds/9 (≈סף-10% פגיעה).
 */
function acquireOther(st: DexState, p: Pool, usdsWantedMu: number, nowMs: number): number {
  const usdsIsA = p.a === "USDS";
  const rIn = usdsIsA ? p.ra : p.rb;   // רזרבת-USDS
  const rOut = usdsIsA ? p.rb : p.ra;  // רזרבת-הצד-השני
  if (rIn <= 0 || rOut <= 0) return 0;
  const tUsds = avail(st, "treasury", "USDS"); // FIX(T25 · pol-respect-locks) — ראה-seedPool
  const swapIn = Math.min(usdsWantedMu, Math.floor(rIn / 9), tUsds);
  if (swapIn <= 0) return 0;
  const out = Math.floor((rOut * swapIn) / (rIn + swapIn));
  if (out <= 0 || out >= rOut) return 0;
  addBal(st, "treasury", "USDS", -swapIn);
  addBal(st, "treasury", usdsIsA ? p.b : p.a, out);
  if (usdsIsA) { p.ra += swapIn; p.rb -= out; } else { p.rb += swapIn; p.ra -= out; }
  st.journal.push({
    h: st.height, t: nowMs, soldier: "ale", action: "pol_acquire",
    note: `acquire ${out}µ ${usdsIsA ? p.b : p.a} ב-${swapIn}µ USDS (פגיעה-מוגבלת ≤10%)`,
  });
  return out;
}

/** ה-מחזור-האוטונומי — נקרא-מ-economyTick (buildBlock) על-כל-גובה.
 * יעדים: בריכות-המכילות-USDS (אנחנו-מזריעים-מהעמלות שהן-USDS), ממוינות
 * לפי-חלק-האוצר-העולה (הכי-דל-POL קודם) — דטרמיניסטי-מלא. */
export function aleTick(st: DexState, nowMs: number): void {
  const h = st.height;
  if (h <= 0 || h % ALE_EVERY !== 0) return;
  // R26 · בריכות-המסדרון מחוץ-לתחום-ה-ALE: עבור-נכס-עיגון-1:1 (WSTEEM ≡ STEEM)
  // "רכישת-הצד-השני מהבריכה" היא-כפיית-ביקוש-סימולטיבי-מעל-האמת-החיצונית —
  // ה-ALE קנה WSTEEM ב-USDS-אוצר כל-100-בלוקים (פגיעה ≤10% למחזור) ודחף-את
  // מחיר-המסדרון במתמדת מעל-העוגן (נמדד-חי: 54→136µ תוך-480-טיקים; ובהיסטוריה —
  // זה-שהביא-את-הבריכה-ל-917µ מעל-עוגן-360µ). עומק-המסדרון בא-מהעולם-האמת:
  // הפקדות-STEEM דרך-הדלת — לא-מקניות-פרוטוקול-עצמי. ה-ALE ממשיך-להזריע-לזוגות
  // הריבוניים (SAOS/USDS וכל-בריכה-חופשית-מחיר).
  const targets = seedTargets(st).filter((t) =>
    (t.pool.a === "USDS" || t.pool.b === "USDS") && !RAIL_OWNED_POOLS.has(t.key));
  if (targets.length === 0) return;
  // מקור-המימון: USDS-חופשי-מעל-רצפת-האוצר (הרצפה = אותה-רצפת-הראוטר — מגן-אחד)
  const freeUsds = Math.max(0, bal(st, "treasury", "USDS") - ROUTER_USDS_FLOOR);
  const budget = Math.min(
    Math.floor((freeUsds * ALE_SEED_PCT) / 100),
    ALE_MAX_PER_CYCLE,
  );
  if (budget < ALE_MIN_SEED) return;
  // חלוקה-מדודה: 60% ליעד-הכי-דל, 40% לבא-אחריו (אם-יש) — עומק-ראשון-לזרע.
  // FIX(roast-81 · ale-split-deadlock): הפיצול-60/40 חייב-שתי-מנות-מעל-המינימום —
  // נמדד-חי: budget=7,256 → first=4,353<5,000 → break → ALE-ישן-5,600+בלוקים
  // (מאז-h39,600) בזמן-שלאוצר-היו-29,025µ-חופשיים-לזריעה. עכשיו: תקציב-שאינו-
  // מספיק-לשתי-מנות → מנה-אחת ליעד-הכי-דל; הפיצול-60/40 נשאר-לתקציבים-גדולים.
  // אותו-מינימום (ALE_MIN_SEED), אותה-סדר-עדיפויות — רק-המוות-של-התקציב-הקטן-נפתר.
  const twoSlices = budget >= 2 * ALE_MIN_SEED;
  const first = twoSlices ? Math.floor((budget * 60) / 100) : budget;
  const rest = twoSlices ? budget - first : 0;
  const slices = twoSlices ? [first, rest] : [budget];
  let seeded = 0;
  for (let i = 0; i < slices.length && i < targets.length; i++) {
    const slice = slices[i];
    if (slice < ALE_MIN_SEED) break;
    const t = targets[i];
    // שלב-א: רכישת-הצד-השני-מהבריכה (חצי-הסלייס — השני-נשאר-USDS-לזריעה)
    acquireOther(st, t.pool, Math.floor(slice / 2), nowMs);
    // שלב-ב: זריעת-שני-הצדדים-כנזילות-בעלות-פרוטוקול
    seeded += seedPool(st, t.key, t.pool, slice, nowMs);
  }
  if (seeded <= 0) return;
  const a = st.ale ?? { lastH: h, cycles: 0, seededMu: 0, seeds: 0, polBaseUsdsMu: 0 };
  a.lastH = h;
  a.cycles++;
  a.seeds++;
  a.seededMu += seeded;
  if (a.polBaseUsdsMu === 0) a.polBaseUsdsMu = treasuryLpValue(st); // בסיס-מדידת-צמיחה
  st.ale = a;
}

/* ══ 2. הדוח-החי — aleState (הכל-נמדד-מהמצב, אפס-זיוף) ══════════════════════ */

/**
 * שווי-עמדות-LP-של-האוצר ב-µ-USDS.
 * תמחור-LP כנה: עמדת-LP = חלק-יחסי מהבריכה. בריכה-עם-צד-USDS: שווי-הבריכה
 * במונחי-USDS = 2×רזרבת-USDS (שני-הצדדים-שווי-ערך-בקירוב-על-פי-הבריכה-עצמה).
 * בריכה-בלי-צד-USDS: אין-תמחור-אמת-לנו — נספר-כ-0 עם-דגל (כנות, לא-שווא).
 */
export function treasuryLpValue(st: DexState): number {
  let total = 0;
  for (const [key, p] of Object.entries(st.pools)) {
    const tLp = bal(st, "treasury", LP_ASSET_PREFIX + key);
    if (tLp <= 0 || p.lp <= 0) continue;
    const usdsReserve = p.a === "USDS" ? p.ra : (p.b === "USDS" ? p.rb : 0);
    if (usdsReserve <= 0) continue; // בלי-צד-USDS אין-מה-לתמחר-באמת
    total += Math.floor((tLp * 2 * usdsReserve) / p.lp);
  }
  return total;
}

/** דוח-מלא: מה-המערכת משיגה-לבד, בלי-משתמשים. */
export function aleState(st: DexState) {
  const targets = seedTargets(st);
  const pools = targets.map(({ key, pool: p, treasuryShareBps }) => {
    return {
      key,
      reserveAMu: p.ra, reserveBMu: p.rb,
      assetA: p.a, assetB: p.b,
      lpTotalMu: p.lp,
      lpTreasuryMu: bal(st, "treasury", LP_ASSET_PREFIX + key),
      polShareBps: treasuryShareBps,
      dynFeeBps: p.dynFeeBps ?? null,
      swaps: p.swaps,
    };
  });
  const lpValue = treasuryLpValue(st);
  const ale = st.ale ?? null;
  const growthBps = ale && ale.polBaseUsdsMu > 0
    ? Math.floor(((lpValue - ale.polBaseUsdsMu) * 10_000) / ale.polBaseUsdsMu)
    : 0;
  const lpHolders = pools.filter((x) => x.lpTreasuryMu > 0);
  const weightedPolBps = lpHolders.length > 0
    ? Math.floor(lpHolders.reduce((s, x) => s + x.polShareBps * x.lpTreasuryMu, 0) /
      Math.max(1, lpHolders.reduce((s, x) => s + x.lpTreasuryMu, 0)))
    : 0;
  return {
    ok: true,
    height: st.height,
    policy: {
      every: ALE_EVERY, seedPct: ALE_SEED_PCT, maxPerCycleMu: ALE_MAX_PER_CYCLE,
      minSeedMu: ALE_MIN_SEED, floorUsdsMu: ROUTER_USDS_FLOOR,
    },
    treasury: {
      usdsFreeMu: bal(st, "treasury", "USDS"),
      usdsFreeAboveFloorMu: Math.max(0, bal(st, "treasury", "USDS") - ROUTER_USDS_FLOOR),
      lpValueUsdsMu: lpValue,
      profitMu: st.treasuryProfit,
    },
    ale,
    pol: { growthBps, weightedPolBps },
    flywheel: {
      feeMeterMu: st.feeMeter,
      burnedSaosMu: st.burnedSaos ?? 0,
      revCycles: st.rev?.cycles ?? 0,
      vePaidMu: st.rev?.vePaidMu ?? 0,
      aleSeededMu: ale?.seededMu ?? 0,
      aleSeeds: ale?.seeds ?? 0,
      aleCycles: ale?.cycles ?? 0,
    },
    autonomy: {
      arenaFills: st.stats.fills,     // סוחרים-אוטונומיים — אפס-משתמשים
      swapsTotal: st.stats.swaps,
      liveOrders: st.orders.length,
      note: "FIX(Roast-63): הנזילות-כאן-צומחת-מעמלות-פנימיות (סים) שהמערכת-גבתה-מעצמה-ומהארנה-הפנימית — לא-מהדפסה-ישירה, אך-גם-לא-מכסף-חוץ · סימולציה-סגורה",
    },
    pools,
    recentSeeds: st.journal.filter((j) => j.soldier === "ale" && j.action === "pol_seed").slice(-12).reverse(),
    vaultFeed: {
      // הצינור-מהכספת: עטיפת-WSTEEM — FIX(Roast-63): כנות-מלאה. הגיבוי-במצב-הוא
      // STEEM-ספר-פנימי (סים) שהאוצר עטף-1:1 (וכולל REARM-חוזרים). ה-STEEM-אמת
      // על-השרשרת (נזיל+SP) נמדד-בנפרד-ובכנות ב-truth.ts — והוא-קטן-בהרבה.
      backingWsteemMu: st.backing["WSTEEM"] ?? 0,
      honesty: "backing = STEEM-ספר-פנימי (סים) שנעטף-1:1-על-ידי-האוצר · STEEM-אמת-על-השרשרת נמדד-בנפרד ב-truth.ts והוא-קטן-בהרבה — אל-תחליפו-ביניהם",
    },
    honesty: "כל-המספרים-נמדדים-מהמצב-החי-של-הגרעין (height " + st.height + ") · אין-float · אין-random · ריפליי-דטרמיניסטי",
  };
}
