/**
 * economy.ts — SOVEREIGN ECONOMY ENGINE (Task 54) · כלכלת-הטופ של עולם-ה-DEX
 * ═════════════════════════════════════════════════════════════════════════════
 * מחקר-מפעיל: "בחון דקס אלטרנטיביים עם פונקציות כלכליות חדשניות מטורפות,
 * לבחון את הכי מטורפות וליישם יותר טובות" — מדוד ומיושם כאן, על המנוע האמיתי:
 *
 *  1. veSAOS — vote-escrow + גייגים + 100%-דמי-סוואפ-למצביעים (Aerodrome ve(3,3),
 *     $322M דמי-מצטברים) — בגרסה-קנונית-שלמה: נעילה-1..208שב', הצבעה-לבריכות,
 *     אפוק-פליפ מחלק את קרן-התגמולים פרופורציונלי לכוח-הצבעה.
 *  2. REVENUE-ROUTER + Buy-&-Burn (Hyperliquid 92–97%→buybacks=$1.16B · GMX
 *     real-yield אפס-הדפסה): כל-מחזור 40% מרווח-האוצר קונה SAOS מהבריכה-החיה
 *     ושורף (ΣSAOS יורד — דפלציוני אמת), 40% נשפך לקרן-ve, 20% נשאר אוצר.
 *  3. עמלים-דינמיים (Uniswap-V4 hooks/Bunni am-AMM — "raise fees per block when
 *     price moves sharply"): EWMA של תנודתיות-פגיעה-במחיר פר-בריכה → עמלה
 *     מסתגלת 4..1500bps (מגן-LP מ-LVR) — מיושם ב-amm.ts (poolSwap).
 *  4. BONDS-2.0 (Olympus POL בלי-מלכודת-ההדפסה): מכירת-SAOS-בהנחה-3% מול-USDS,
 *     ההטבה נכנסת-ve-נעולה-12שב' — נזילות-אוצר שאי-אפשר-למשוך.
 *
 * כללי-ברזל (כמו-הגרעין): אפס-float · אפס-random · אפס-Date.now בנתיבי-קונצנזוס —
 * הטריגרים הם גובה-בלוקים טהורים → ריפליי דטרמיניסטי, השורש נשאר אמת.
 */
import type { DexState } from "./kernel";
import { MINT_FUEL_CAP } from "./kernel"; // EXEC-CD-9 · אותו-גבול-נזק למחזור-פר-טיק
import { getPool } from "./amm";
import { aleTick } from "./ale";
import { launchpadTick } from "./launchpad";
import { bookGasRecycleAvail, bookGasTake, bookGasFloor, BOOKGAS_RECYCLE_CAP } from "./bookgas"; // EXEC-CD-9 · מד-גז-הספר
import {
  BLOCKS_PER_WEEK, VE_MAX_WEEKS, EPOCH_BLOCKS, ROUTER_EVERY, REV_FLOOR,
  REV_BURN_PCT, REV_VE_PCT, ROUTER_USDS_FLOOR, REV_MIN_CYCLE, VE_POT,
  LADDER_FUEL_FLOOR,
  RESERVE_ROUTER_PCT, RESERVE_VAULT, pushReserveEvent, LADDER_EVERY,
} from "./kernel";
import { ladderTick } from "./ladder"; // EXEC-CD-21 · סולם-הגיבוי

// FIX(Roast-67 · ZFB-gas-tank): מימון-דלק-דטרמיניסטי מהפונטיין — 10% מכל-מחזור-ראוטר
// הופך-עמלות-שנמדדו (מעל-רצפת-הסולם) לקרדיטים-בארנק-האוצר (ה-FUEL_FUNDER) —
// אותן-סמנטיקות-מדויקות-של-mint_fuel (הגרעין): feeMinted↑ + treasuryProfit↓/feeMeter↓ —
// כל-µ-נצרך-פעם-אחת; האינווריאנטות (a)+(d) נשמרות-בדיוק. האוצר-מפיץ-דרך-refuel
// (העברה-טהורה) לסוכנים-שאזל-מסלולם — ריצת-המערכת-לא-תיגמר-בשקט.
export const ZFB_GAS_PCT = 10;

// EXEC-CD-9 · fuel-freeze-fix: קדנס-מחזור-גז-הספר — כל-100-בלוקים (אותו-סדר-גודל של ALE_EVERY).
// ממצא-EXEC-CD-8: המזרקה ממחזרת רק-עמלות-בריכות; גז-הספר (order/fill/cancel/cancel_all/gc)
// בורח-מהמחזור → מלכות-מוות-דלקית בכלכלה ספר-מרכזית. התיקון: המזרקה מחזירה את גז-הספר
// שנגבה-בפועל לאוצר (אותן-סמנטיקות-mint_fuel: feeMinted↑ — האינווריאנטה נשמרת בדיוק),
// והאוצר מפיץ-דרך-סולם-refuel. הגז נשאר **טול-אנטי-ספאם** (שולם-מראש; המחזור-חברתי
// לכול — לא-החזר-ישיר-לשולח) — הפילוסופיה הריבונית: אפס-עלות-מבנית, המגנים מבניים.
export const BOOKGAS_RECYCLE_EVERY = 100;

// קבועים-מקומיים (לא-קונצנזוסיים — רק-לתצוגה/מדידה)
export const REV_TREASURY_PCT = 20; // → נשאר באוצר (לא-מוזז)

/** כוח-ve של עמדה: amt × ימים-שנותרו/4-שנים — לינארי-דעיכה כמו-Aerodrome */
export function vePoints(st: DexState, who: string, hNow: number): number {
  const pos = st.ve?.[who];
  if (!pos || pos.unlockH <= hNow) return 0;
  const remain = Math.min(pos.unlockH - hNow, VE_MAX_WEEKS * BLOCKS_PER_WEEK);
  return Math.floor((pos.amt * remain) / (VE_MAX_WEEKS * BLOCKS_PER_WEEK));
}

export function totalVePoints(st: DexState, hNow: number): number {
  let t = 0;
  for (const who of Object.keys(st.ve ?? {})) t += vePoints(st, who, hNow);
  return t;
}

/** ה-מחזור-הכלכלי הקנוני — נקרא מ-buildBlock (לפני-העלאת-גובה) אחרי-כל-ה-ops.
 * FIX(Roast-64): nowMs מוזרק — רשומות-הג'ורנל נושאות זמן-הבלוק-האמיתי (היו t:0). */
export function economyTick(st: DexState, nowMs: number): void {
  const h = st.height;
  if (h <= 0) return;
  if (h % ROUTER_EVERY === 0) revenueCycle(st, h, nowMs);
  if (h % EPOCH_BLOCKS === 0) epochFlip(st, h, nowMs);
  if (h % BOOKGAS_RECYCLE_EVERY === 0) bookGasRecycle(st, h, nowMs); // EXEC-CD-9 · fuel-freeze-fix
  if (h % LADDER_EVERY === 0) ladderTick(st, h, nowMs); // EXEC-CD-21 · סולם-הגיבוי: סחיבה→המרה-אמת→מדרגות (תחזוקה-שמזינה-גיבוי)
  launchpadTick(st, nowMs); // Task 57/58 · הגירות-אוטומטיות של מסילת-ההשקות (גיוס-הסף → בריכה)
  aleTick(st, nowMs); // Task 55 · ALE: הזרעת-POL-אוטונומית כל-ALE_EVERY-בלוקים
}

/** EXEC-CD-9 · מחזור-גז-הספר (fuel-freeze-fix): גז-ספר-שנגבה-בפועל חוזר-לארנק-האוצר —
 * מהמד-החוץ-מצב-הדטרמיניסטי (db/book-gas.json — נעקב-גיט, נבנה-מחדש-מהזנות-הבלוקים;
 * רצפת-מצב bookGasFloor בטעינה קוטל-הטבעה-כפולה). סמנטיקות-mint_fuel-מלאות:
 * feeMinted↑ יחד-עם-הקרדיטים → האינווריאנטה Σcredits+gasUsed−feeMinted===ג'נזיס
 * נשמרת-בדיוק. אפס-נגיעה ב-treasuryProfit/feeMeter (אלו עמלות-בריכות — משטר-נפרד).
 * כל-µ-נגרע-מהמד-פעם-אחת-בלבד; תקרה-פר-טיק (BOOKGAS_RECYCLE_CAP) — גבול-נזק. */
export function bookGasRecycle(st: DexState, h: number, nowMs: number): void {
  // FIX(zai-audit-2026-10-11 · H3 · replay-determinism): רצפת-המצב עד-כה יושרה רק בטעינת-שרשרת —
  // שחזור-מה-op-log על-רפליקה-טרייה (מד-0/0, collected גדל-מההזנות) היה מחשב avail שונה
  // מהתהליך-החי (שהמד שלו נושא-היסטוריה) → taken שונה → st.bookGasRecycledMu שונה
  // → stateRoot שונה באותו-גובה, בלי-אזעקה. עתה: סנכרון-רצפה פר-טיק לפני-כל-מחזור —
  // המד מתיישר מול המצב-הקנוני והמחזור הופך פונקציה-טהורה של (הזנות-הבלוקים, מצב-הגובה).
  // על-תהליך-חי-בריא הסנכרון נייטרלי (recycled-מטר === recycled-מצב תמיד).
  bookGasFloor(st.bookGasRecycledMu ?? 0);
  const amt = Math.min(bookGasRecycleAvail(), BOOKGAS_RECYCLE_CAP, MINT_FUEL_CAP);
  if (amt <= 0) return;
  const taken = bookGasTake(amt); // צריכה-פעם-אחת מהמד — לפני-כל-נגיעה-במצב
  if (taken <= 0) return;
  st.feeMinted = (st.feeMinted ?? 0) + taken;
  st.credits["treasury"] = (st.credits["treasury"] ?? 0) + taken;
  st.bookGasRecycledMu = (st.bookGasRecycledMu ?? 0) + taken; // רצפת-המצב — מיישרת-את-המד בטעינה
  st.journal.push({ h, t: nowMs, soldier: "router", action: "bookgas_recycle", note: `+${taken}µ credits →treasury (book-gas recycled — burned work re-funded; every-µ-once, meter git-backed)` });
}

/** (2) REVENUE-ROUTER: רווח-אוצר מדוד → 40% burn (קנייה-מהבריכה + השמדה) ·
 * 40% → קרן-ve · 20% נשאר. מקור-הכסף: יתרת-USDS-אמת של האוצר (שהגיעה-מעמלות),
 * מקורזל לרווח-המדוד — הראוטר לעולם לא חורג מההכנסה-שנמדדה.
 * Task 58 · סדר-צריכה: **revAux-ראשון** — הכנסה-נלווית-מדודה (ארב-ProtoRev +
 * עמלות-השקות) נצרכת-לפני-רווח-עמלות-הסוואפ (שמוגן-ברצפת-REV_FLOOR). כך
 * הפלאיהול סגור: ארב+השקות → שריפה/ve → ALE-זורע → עומק → עמלות. */
function revenueCycle(st: DexState, h: number, nowMs: number): void {
  // ── FEE-SWEEPER (EDGE-MAP Tier0 · הוראת-המפעיל "כל-השאר חייב לבצע עכשיו") ──
  // עודפי-מדידה-מעל-רצפת-הסולם הופכים-רווח-ממומש (סמנטיקת-harvest, תנועה-ישירה
  // כמו gas_tank_fund באותו-מקום). ביקורת-העמלות (pools===feeMeter+profit+minted)
  // נשמרת-במדויק: העברה-פנימית-בין-שני-אגפי-החיבור, אפס-יצירת-ערך.
  // רצפת-8,000µ לא-נוגעת — סולם-הערך לא-נשאר-בלי-גיבוי; המזרקה (mint_fuel)
  // ממשיכה-לעבוד על profit-ראשון (fromProfit-קודם). treasuryProfitEver (מונה-מונוטוני)
  // מתעד-את-ההכרה; כשהרווח יחצה REV_FLOOR+REV_MIN_CYCLE — מחזור-השריפה קם-מעצמו.
  {
    const meterAvail = Math.max(0, (st.feeMeter ?? 0) - LADDER_FUEL_FLOOR);
    if (meterAvail > 0) {
      st.feeMeter -= meterAvail;
      st.treasuryProfit += meterAvail;
      st.treasuryProfitEver = (st.treasuryProfitEver ?? 0) + meterAvail;
      st.journal.push({ h, t: nowMs, soldier: "router", action: "fee_sweep", profitMu: meterAvail, note: `fee-sweep ${meterAvail}µ meter→realized-profit (floor ${LADDER_FUEL_FLOOR}µ intact) — measured fees realized (fee-audit invariant preserved)` });
    }
  }
  const aux = Math.max(0, (st.revAux?.protorevMu ?? 0) + (st.revAux?.launchpadMu ?? 0));
  const treasuryUsds = st.balances["treasury"]?.["USDS"] ?? 0;
  const usableProfit = Math.max(0, st.treasuryProfit - REV_FLOOR);
  const usableBalance = Math.max(0, treasuryUsds - ROUTER_USDS_FLOOR);
  const take = Math.min(usableProfit + aux, usableBalance);
  if (take < REV_MIN_CYCLE) return;
  const pool = getPool(st, "SAOS/USDS");
  if (!pool || pool.ra <= 0) return;
  // p.a=SAOS p.b=USDS (ממוין) — קניית-SAOS-בשוק-הבריכה עם-take-USDS
  const burnUsds = Math.floor((take * REV_BURN_PCT) / 100);
  const veUsds = Math.floor((take * REV_VE_PCT) / 100);
  let vePaidThis = 0; // FIX(Roast-64 · ve-paid-ghost): רק-העברות-שבוצעו-בפועל נמדדות
  if (burnUsds > 0) {
    // FIX(AUDIT-2026-09-10 · critical · conservation + Roast-64 · router-money-print):
    // לפני התיקון הנתיב הזה הוסיף burnUsds לבריכה (pool.rb += burnUsds) בלי לנכות
    // אותם מיתרת האוצר — USDS-פנטום הוזרם לרזרבות בכל מחזור (Σbalances+Σpools גדל
    // יש-מאין; ענף ה-ve ניכה כחוק, ענף ה-burn לא). התיקון fail-closed: מנכים מהאוצר
    // רק כשיש לו באמת, אחרת skip-כנה מתועד ביומן (בלי לבטל את ענף ה-ve).
    const tBalB = st.balances["treasury"] ?? (st.balances["treasury"] = {});
    if ((tBalB.USDS ?? 0) >= burnUsds) {
      const out = swapReserves(pool.rb, pool.ra, burnUsds); // USDS→SAOS מתמטיקת-בריכה
      if (out > 0) {
        tBalB.USDS = (tBalB.USDS ?? 0) - burnUsds; // הכסף האמיתי יוצא מהאוצר — שימור-כספים
        pool.rb += burnUsds;
        pool.ra -= out;
        pool.swaps++;
        // השמדה-אמת: ה-SAOS שנקנה לא מגיע-לאף-ארנק — ΣSAOS במצב יורד
        st.burnedSaos = (st.burnedSaos ?? 0) + out;
        st.journal.push({ h, t: nowMs, soldier: "router", action: "burn", profitMu: out, note: `burn ${out}µ SAOS (${burnUsds}µ USDS from fees)` });
      }
    } else {
      st.journal.push({ h, t: nowMs, soldier: "router", action: "burn_skipped", profitMu: 0, note: `treasury USDS below burn ${burnUsds}µ — honest skip (fail-closed, audit fix)` });
    }
  }
  if (veUsds > 0) {
    const tBal = st.balances["treasury"] ?? (st.balances["treasury"] = {});
    if ((tBal.USDS ?? 0) >= veUsds) {
      tBal.USDS = (tBal.USDS ?? 0) - veUsds;
      const pot = st.balances[VE_POT] ?? (st.balances[VE_POT] = {});
      pot.USDS = (pot.USDS ?? 0) + veUsds;
      vePaidThis = veUsds;
      st.journal.push({ h, t: nowMs, soldier: "router", action: "ve_fund", profitMu: veUsds, note: `ve pot +${veUsds}µ USDS` });
    }
  }
  // צריכת-המדידה: revAux-ראשון (protorev → launchpad, סדר-קנוני), ואז-רווח-העמלות
  const auxTake = Math.min(take, aux);
  let rem = auxTake;
  // FIX(Roast-65-a · HIGH-3d): צריכת-treasuryProfit-על-ידי-הראוטר חייבת-להירשם-בדלי
  // feesSpentMu — בלעדיו ביקורת-העמלות (pools===meter+profit+minted+spent, FIX 3-a·D1:
  // הסימן-המתוקן — הצריכה-נזקפת כי היא זורמת-לבריכות) נשברת
  // נצחית מהמחזור-הראשון שבו-הראוטר שורף: המדידה-בבריכות אינה יורדת, הרווח כן.
  // רק-החלק-שנצרך-מרווח-עמלות-הסוואפ נספר (החלק-מ-revAux אינו עמלות-בריכות-כלל).
  let feesSpentThis = 0;
  if (rem > 0) {
    const pr = Math.min(st.revAux?.protorevMu ?? 0, rem);
    if (pr > 0) { st.revAux = { ...(st.revAux ?? { protorevMu: 0, launchpadMu: 0 }), protorevMu: (st.revAux?.protorevMu ?? 0) - pr }; rem -= pr; }
    const lp = Math.min(st.revAux?.launchpadMu ?? 0, rem);
    if (lp > 0) { st.revAux = { ...(st.revAux ?? { protorevMu: 0, launchpadMu: 0 }), launchpadMu: (st.revAux?.launchpadMu ?? 0) - lp }; rem -= lp; }
    st.treasuryProfit -= (take - auxTake); // השארית — מרווח-עמלות-הסוואפ-המדוד
    feesSpentThis = take - auxTake;
  } else {
    st.treasuryProfit -= take;
    feesSpentThis = take;
  }
  if (feesSpentThis > 0) st.feesSpentMu = (st.feesSpentMu ?? 0) + feesSpentThis;
  // ── FIX(Roast-67 · ZFB-gas-tank): מימון-דלק-מהעמלות-שנמדדו (אחרי-חלוקת-הראוטר) ──
  // אותן-סמנטיקות-כמו-mint_fuel-של-הגרעין (treasury-only, fees-backed, cap):
  // רק-מהרווח-שנמדד-שנותר מעל-רצפת-הסולם (+meter מעל-רצפתו); feeMinted מתועד —
  // האינווריאנטה Σcredits+gasUsed−feeMinted===genesis וביקורת-העמלות ממשיכות-לעמוד.
  {
    const profitAvail = Math.max(0, st.treasuryProfit - REV_FLOOR);
    const meterAvail = Math.max(0, (st.feeMeter ?? 0) - LADDER_FUEL_FLOOR);
    const gasAlloc = Math.min(
      Math.floor((take * ZFB_GAS_PCT) / 100),
      MINT_FUEL_CAP,
      profitAvail + meterAvail,
    );
    if (gasAlloc > 0) {
      const fromProfit = Math.min(gasAlloc, profitAvail);
      const fromMeter = gasAlloc - fromProfit;
      if (fromMeter <= meterAvail) {
        st.treasuryProfit -= fromProfit;
        st.feeMeter -= fromMeter;
        st.feeMinted = (st.feeMinted ?? 0) + gasAlloc;
        st.credits["treasury"] = (st.credits["treasury"] ?? 0) + gasAlloc;
        st.gasFundedMu = (st.gasFundedMu ?? 0) + gasAlloc;
        st.journal.push({ h, t: nowMs, soldier: "router", action: "gas_tank_fund", note: `gasTank +${gasAlloc}µ credits →treasury (fees-backed: profit ${fromProfit} + meter ${fromMeter}) — ZFB runway` });
      }
    }
  }
  // ── EXEC-CD-21 · RESERVE-SLICE: חלק-קבוע-מכל-מחזור-ראוטר זורם-לכספת-העתודה ──
  // "התחזוקה-עצמה מזינה-את-הגיבוי": כל-מחזור-ראוטר מקצה RESERVE_ROUTER_PCT%-מהתפוקה
  // לכספת-העתודה-הגלויה (בעקבות-חלוקת-ה-burn/ve, מוגן-באותו-יתרה-אמת — fail-closed).
  // אפס-נגיעה-במשטר-העמלות (התביעה-כבר-נצרכה-למעלה — היתרה-היא-חופשית-כללית).
  {
    const reserveSlice = Math.floor((take * RESERVE_ROUTER_PCT) / 100);
    if (reserveSlice > 0) {
      const tBal = st.balances["treasury"] ?? (st.balances["treasury"] = {});
      if ((tBal.USDS ?? 0) >= reserveSlice) {
        tBal.USDS = (tBal.USDS ?? 0) - reserveSlice;
        const rvBal = st.balances[RESERVE_VAULT] ?? (st.balances[RESERVE_VAULT] = {});
        rvBal.USDS = (rvBal.USDS ?? 0) + reserveSlice;
        st.reserve = st.reserve ?? { phase: 0, sinceH: h, streak: 0, streakTarget: 0, lastH: 0, sweptMu: 0, routerSlicedMu: 0, realSwappedMu: 0, migrated: true, redeemWindowH: 0, redeemWindowMu: 0, redeemMu: 0, events: [] };
        st.reserve.routerSlicedMu += reserveSlice;
        pushReserveEvent(st, h, "router_slice", reserveSlice, `${reserveSlice}µ from router cycle → reserve-vault (${RESERVE_ROUTER_PCT}% — maintenance feeds the backing ladder)`);
      }
    }
  }
  st.rev = {
    lastH: h,
    cycles: (st.rev?.cycles ?? 0) + 1,
    burnedMu: st.burnedSaos ?? 0,           // Σ שריפה מצטברת
    vePaidMu: (st.rev?.vePaidMu ?? 0) + vePaidThis, // Σ מימון-קרן-ve מצטבר (העברות-שבוצעו-בלבד)
  };
}

/** (1) אפוק-פליפ: קרן-ve-pot מתחלקת פרופורציונלית לכוח-הצבעה (vePoints) של
 * המצביעים — "100%-דמי-הסוואפ-למצביעים" של-Aerodrome, על-כל-מקורות-הקרן. */
function epochFlip(st: DexState, h: number, nowMs: number): void {
  const pot = st.balances[VE_POT]?.USDS ?? 0;
  st.veEpoch = (st.veEpoch ?? 0) + 1;
  if (pot <= 0) return;
  const votes = st.veVotes ?? {};
  const byPool: Record<string, { who: string; pts: number }[]> = {};
  let totalPts = 0;
  for (const [who, pool] of Object.entries(votes)) {
    const pts = vePoints(st, who, h);
    if (pts <= 0) continue;
    (byPool[pool] = byPool[pool] ?? []).push({ who, pts });
    totalPts += pts;
  }
  if (totalPts <= 0) return;
  for (const arr of Object.values(byPool)) {
    for (const { who, pts } of arr) {
      const pay = Math.floor((pot * pts) / totalPts);
      if (pay <= 0) continue;
      st.balances[VE_POT] = { ...(st.balances[VE_POT] ?? {}), USDS: (st.balances[VE_POT]?.USDS ?? 0) - pay };
      st.balances[who] = { ...(st.balances[who] ?? {}), USDS: (st.balances[who]?.USDS ?? 0) + pay };
      st.journal.push({ h, t: nowMs, soldier: who, action: "ve_reward", profitMu: pay, note: `epoch ${st.veEpoch} payout` });
    }
  }
}

/** תמטיקת-בריכה טהורה (x*y=k עם-floor) — שכפול-מדויק של-poolSwap-בלי-עמלה
 * (הראוטר הוא-הפרוטוקול עצמו; אין-עמלה-עצמית — כנות). */
function swapReserves(rIn: number, rOut: number, amountIn: number): number {
  if (rIn <= 0 || rOut <= 0 || amountIn <= 0) return 0;
  const out = Math.floor((rOut * amountIn) / (rIn + amountIn));
  return out <= 0 || out >= rOut ? 0 : out;
}
