/**
 * ladder.ts — THE-RESERVE-LADDER (EXEC-CD-21) · מטבעות-הבית → כסף-אמת, צעד-צעד
 * ═════════════════════════════════════════════════════════════════════════════
 * הוראת-המפעיל: "איך נוכל להפוך את הכלכלה שלנו לכסף אמת צעד צעד... עד שתהפוך אותם
 * לרלוונטיים עם גב נזיל אמת... תמצא דרך חכמה שזה לאט לאט יהפוך, ואיך לתחזק את זה
 * נכון שגם התחזוקה עצמה והפעילות יגרמו לטריגרים רבים שיניבו לנו רווחים גדולים".
 *
 * התשובה ההנדסית — שלושה מנגנונים דטרמיניסטיים (כל-הטריגרים גובהי-בלוקים):
 *
 *  (1) כספת-עתודה גלויה (reserve-vault): חשבון-ריכוזי שכל-אזרח יכול לאמת מה-wallets.
 *      מזינים אותה: חלק-קבוע מכל מחזור-ראוטר (router_slice), סחיבת-עודף-אוצר
 *      מעל-כל-הרצפות (sweep), הגירה-חד-פעמית של נכסי-דלת-אוצר (migrate),
 *      והפקדות-אמת של אזרחים (xfer_free → reserve-vault).
 *
 *  (2) המרה-אמת (real_swap): חלק-מהסחיבה מומר לנכסי-דלת (WTRX/WSOL/...) דרך בריכה
 *      אמת, מוגבל-עומק (10% מצד-הבריכה-לטיק) — הגיבוי-האמתי גדל-בשוק, לא-בספר.
 *
 *  (3) מדרגות-נמדדות (phases): כל-טיק-סולם מודד את יחסי הגיבוי מהמצב-הקנוני
 *      (reserveMeasure) — מדרגה-נפתחת רק אחרי 3-טיקים-רצופים מעל-הסף, ויורדת-בכנות
 *      כשהרצפה נשברת. במדרגה 3+ נפתח חלון-פדיון (redeem_saos): שריפת-SAOS מול
 *      הכספת — ההוכחה-הקשה שהגיבוי אמת.
 *
 * כללי-ברזל (כמו-הגרעין): אפס-float · אפס-random · אפס-Date.now בנתיבי-קונצנזוס —
 * הטריגרים גובהי-בלוקים טהורים → ריפליי דטרמיניסטי, ה-stateRoot נשאר אמת.
 */
import type { DexState } from "./kernel";
import {
  RESERVE_VAULT, RESERVE_STREAK, RESERVE_SWEEP_PCT, RESERVE_SWEEP_CAP,
  RESERVE_MIN_SWEEP, RESERVE_REAL_PCT, RESERVE_REAL_CAP, RESERVE_REAL_DEPTH_BPS,
  RESERVE_PHASES, ROUTER_USDS_FLOOR, REV_FLOOR,
  reserveMeasure, pushReserveEvent,
} from "./kernel";
import { getPool } from "./amm";

/** מתמטיקת-בריכה טהורה (x·y=k עם floor) — אותו-חוק של poolSwap/revenueCycle, בלי עמלה
 * (הסולם הוא הפרוטוקול עצמו — קניית-גיבוי עצמית אינה מתומחרת על-עצמה; כנות). */
function cpOut(rIn: number, rOut: number, amountIn: number): number {
  if (rIn <= 0 || rOut <= 0 || amountIn <= 0) return 0;
  const out = Math.floor((rOut * amountIn) / (rIn + amountIn));
  return out <= 0 || out >= rOut ? 0 : out;
}

/** המדרגה-הגבוהה שספיה עומדים-במדידה הנוכחית (0 אם אף-סף). */
export function targetPhaseOf(unitBps: number, realBps: number): number {
  let t = 0;
  for (const p of RESERVE_PHASES) if (unitBps >= p.unitBps && realBps >= p.realBps) t = Math.max(t, p.id);
  return t;
}

/** טיק-סולם — נקרא-מ-economyTick כל-LADDER_EVERY-בלוקים (לפני-העלאת-הגובה, כמו-הראוטר). */
export function ladderTick(st: DexState, h: number, nowMs: number): void {
  const r = st.reserve ?? (st.reserve = {
    phase: 0, sinceH: h, streak: 0, streakTarget: 0, lastH: 0,
    sweptMu: 0, routerSlicedMu: 0, realSwappedMu: 0, migrated: false,
    redeemWindowH: 0, redeemWindowMu: 0, redeemMu: 0, events: [],
  });
  r.lastH = h;

  // (1) הגירה-חד-פעמית: נכסי-דלת של האוצר → כספת-העתודה (כסף-אמת הופך עתודה ייעודית-גלויה)
  if (!r.migrated) {
    const tBal = st.balances["treasury"] ?? (st.balances["treasury"] = {});
    const rvBal = st.balances[RESERVE_VAULT] ?? (st.balances[RESERVE_VAULT] = {});
    let moved = 0;
    for (const a of ["WTRX", "WSOL", "WETH", "WBNB", "WBASE"] as const) {
      const amt = tBal[a] ?? 0;
      if (amt > 0) { tBal[a] = 0; rvBal[a] = (rvBal[a] ?? 0) + amt; moved += amt; }
    }
    r.migrated = true;
    if (moved > 0) {
      pushReserveEvent(st, h, "migrate", moved, `treasury door-assets → reserve-vault (one-time, ${moved}µ) — real assets become the dedicated sovereign reserve`);
    }
  }

  // (2) סחיבה: עודף-אוצר-מעל-כל-הרצפות (גם-רצפת-הראוטר וגם-רצפת-הרווח) → כספת-העתודה.
  //     אפס-נגיעה ב-treasuryProfit/feeMeter (משטר-העמלות של settle (d) נשאר-שלם):
  //     הסחיבה היא העברת-יתרה-אמת בין-חשבונות — הראוטר ימצא-פחות-יתרה וידלג-בכנות.
  const tBal = st.balances["treasury"] ?? (st.balances["treasury"] = {});
  const treasuryUsds = tBal.USDS ?? 0;
  const surplus = Math.min(
    Math.max(0, treasuryUsds - ROUTER_USDS_FLOOR),
    Math.max(0, st.treasuryProfit - REV_FLOOR),
  );
  const sweep = Math.min(Math.floor((surplus * RESERVE_SWEEP_PCT) / 100), RESERVE_SWEEP_CAP);
  let sweptThis = 0;
  if (sweep >= RESERVE_MIN_SWEEP) {
    tBal.USDS = treasuryUsds - sweep;
    const rvBal = st.balances[RESERVE_VAULT] ?? (st.balances[RESERVE_VAULT] = {});
    rvBal.USDS = (rvBal.USDS ?? 0) + sweep;
    r.sweptMu += sweep;
    sweptThis = sweep;
    pushReserveEvent(st, h, "sweep", sweep, `treasury surplus → reserve-vault (${sweep}µ, ${RESERVE_SWEEP_PCT}% of surplus above all floors)`);
    st.journal.push({ h, t: nowMs, soldier: "treasury", action: "reserve_sweep", profitMu: sweep, note: `sweep ${sweep}µ USDS → reserve-vault (backing ladder fed by real surplus)` });
  }

  // (3) המרה-אמת: חלק-מהסחיבה → נכסי-דלת (WTRX) דרך הבריכה-האמת — מוגבל-עומק-שוק.
  //     ישירות-במתמטיקת-הבריכה (כמו-הראוטר): שימור-כספים מלא, אפס-עמלה-עצמית.
  const pool = getPool(st, "USDS/WTRX");
  if (pool && sweptThis > 0 && pool.ra > 0 && pool.rb > 0) {
    const depthCap = Math.floor((pool.ra * RESERVE_REAL_DEPTH_BPS) / 10_000);
    const convIn = Math.min(
      Math.floor((sweptThis * RESERVE_REAL_PCT) / 100),
      RESERVE_REAL_CAP,
      Math.max(depthCap, 100), // אפילו בריכה-רזה ממשיכה-לבנות-גיבוי-אמת בטיפות
    );
    if (convIn >= 100) {
      const out = cpOut(pool.ra, pool.rb, convIn); // USDS (צד-a) → WTRX (צד-b)
      if (out > 0) {
        const rvBal = st.balances[RESERVE_VAULT] ?? (st.balances[RESERVE_VAULT] = {});
        rvBal.USDS = (rvBal.USDS ?? 0) - convIn;
        pool.ra += convIn;
        pool.rb -= out;
        pool.swaps = (pool.swaps ?? 0) + 1;
        rvBal.WTRX = (rvBal.WTRX ?? 0) + out;
        r.realSwappedMu += convIn;
        pushReserveEvent(st, h, "real_swap", convIn, `reserve converted ${convIn}µ USDS → ${out}µ WTRX via live pool (real-door backing, depth cap ${depthCap}µ)`);
        st.journal.push({ h, t: nowMs, soldier: "treasury", action: "reserve_real_swap", profitMu: 0, note: `reserve ${convIn}µ USDS → ${out}µ WTRX (real backing via live pool)` });
      }
    }
  }

  // (4) מדרגות: מדידה-חי → קידום/הורדה-כנה לפי רצף-טיקים (אנטי-רעש)
  const m = reserveMeasure(st);
  const target = targetPhaseOf(m.unitBps, m.realBps);
  if (target > r.phase) {
    if (r.streakTarget === target) r.streak += 1; else { r.streakTarget = target; r.streak = 1; }
    if (r.streak >= RESERVE_STREAK) {
      r.phase = target;
      r.sinceH = h;
      r.streak = 0;
      const ph = RESERVE_PHASES[target];
      pushReserveEvent(st, h, "phase_up", 0, `PHASE ${target}: ${ph?.name ?? "?"} — ${ph?.note ?? ""} (${RESERVE_STREAK} consecutive measured ticks)`);
      st.journal.push({ h, t: nowMs, soldier: "treasury", action: "ladder_phase_up", profitMu: 0, note: `PHASE ${target}: ${ph?.name ?? "?"} — home coins climb the real-money ladder` });
    }
  } else if (target < r.phase) {
    // ירידת-כנות: הרצפה נשברה מתחת-למדרגה הנוכחית — הורדה-אחת אחרי רצף (אותו-אנטי-רעש)
    if (r.streakTarget === -1) r.streak += 1; else { r.streakTarget = -1; r.streak = 1; }
    if (r.streak >= RESERVE_STREAK && r.phase > 0) {
      r.phase -= 1;
      r.sinceH = h;
      r.streak = 0;
      const ph = RESERVE_PHASES[r.phase];
      pushReserveEvent(st, h, "phase_down", 0, `honest demotion → PHASE ${r.phase}: ${ph?.name ?? "?"} (floor lost, measured 3 consecutive ticks)`);
      st.journal.push({ h, t: nowMs, soldier: "treasury", action: "ladder_phase_down", profitMu: 0, note: `honest demotion → PHASE ${r.phase}: ${ph?.name ?? "?"}` });
    }
  } else {
    r.streakTarget = target;
    r.streak = 0;
  }
}
