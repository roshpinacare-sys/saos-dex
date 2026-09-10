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
import { getPool } from "./amm";
import { aleTick } from "./ale";
import { launchpadTick } from "./launchpad";
import {
  BLOCKS_PER_WEEK, VE_MAX_WEEKS, EPOCH_BLOCKS, ROUTER_EVERY, REV_FLOOR,
  REV_BURN_PCT, REV_VE_PCT, ROUTER_USDS_FLOOR, REV_MIN_CYCLE, VE_POT,
} from "./kernel";

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

/** ה-מחזור-הכלכלי הקנוני — נקרא מ-buildBlock (לפני-העלאת-גובה) אחרי-כל-ה-ops. */
export function economyTick(st: DexState): void {
  const h = st.height;
  if (h <= 0) return;
  if (h % ROUTER_EVERY === 0) revenueCycle(st, h);
  if (h % EPOCH_BLOCKS === 0) epochFlip(st, h);
  launchpadTick(st); // Task 57/58 · הגירות-אוטומטיות של מסילת-ההשקות (גיוס-הסף → בריכה)
  aleTick(st); // Task 55 · ALE: הזרעת-POL-אוטונומית כל-ALE_EVERY-בלוקים
}

/** (2) REVENUE-ROUTER: רווח-אוצר מדוד → 40% burn (קנייה-מהבריכה + השמדה) ·
 * 40% → קרן-ve · 20% נשאר. מקור-הכסף: יתרת-USDS-אמת של האוצר (שהגיעה-מעמלות),
 * מקורזל לרווח-המדוד — הראוטר לעולם לא חורג מההכנסה-שנמדדה.
 * Task 58 · סדר-צריכה: **revAux-ראשון** — הכנסה-נלווית-מדודה (ארב-ProtoRev +
 * עמלות-השקות) נצרכת-לפני-רווח-עמלות-הסוואפ (שמוגן-ברצפת-REV_FLOOR). כך
 * הפלאיהול סגור: ארב+השקות → שריפה/ve → ALE-זורע → עומק → עמלות. */
function revenueCycle(st: DexState, h: number): void {
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
  if (burnUsds > 0) {
    // FIX(AUDIT-2026-09-10 · critical · conservation): לפני התיקון הנתיב הזה הוסיף
    // burnUsds לבריכה (pool.rb += burnUsds) בלי לנכות אותם מיתרת האוצר — USDS-פנטום
    // הוזרם לרזרבות בכל מחזור (Σbalances+Σpools גדל יש-מאין; ענף ה-ve ניכה כחוק, ענף ה-burn לא).
    // התיקון fail-closed: מנכים מהאוצר רק כשיש לו באמת, אחרת skip-כנה מתועד ביומן.
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
        st.journal.push({ h, t: 0, soldier: "router", action: "burn", profitMu: out, note: `burn ${out}µ SAOS (${burnUsds}µ USDS from fees)` });
      }
    } else {
      st.journal.push({ h, t: 0, soldier: "router", action: "burn_skipped", profitMu: 0, note: `treasury USDS below burn ${burnUsds}µ — honest skip (fail-closed, audit fix)` });
    }
  }
  if (veUsds > 0) {
    const tBal = st.balances["treasury"] ?? (st.balances["treasury"] = {});
    if ((tBal.USDS ?? 0) >= veUsds) {
      tBal.USDS = (tBal.USDS ?? 0) - veUsds;
      const pot = st.balances[VE_POT] ?? (st.balances[VE_POT] = {});
      pot.USDS = (pot.USDS ?? 0) + veUsds;
      st.journal.push({ h, t: 0, soldier: "router", action: "ve_fund", profitMu: veUsds, note: `ve pot +${veUsds}µ USDS` });
    }
  }
  // צריכת-המדידה: revAux-ראשון (protorev → launchpad, סדר-קנוני), ואז-רווח-העמלות
  const auxTake = Math.min(take, aux);
  let rem = auxTake;
  if (rem > 0) {
    const pr = Math.min(st.revAux?.protorevMu ?? 0, rem);
    if (pr > 0) { st.revAux = { ...(st.revAux ?? { protorevMu: 0, launchpadMu: 0 }), protorevMu: (st.revAux?.protorevMu ?? 0) - pr }; rem -= pr; }
    const lp = Math.min(st.revAux?.launchpadMu ?? 0, rem);
    if (lp > 0) { st.revAux = { ...(st.revAux ?? { protorevMu: 0, launchpadMu: 0 }), launchpadMu: (st.revAux?.launchpadMu ?? 0) - lp }; rem -= lp; }
    st.treasuryProfit -= (take - auxTake); // השארית — מרווח-עמלות-הסוואפ-המדוד
  } else {
    st.treasuryProfit -= take;
  }
  st.rev = {
    lastH: h,
    cycles: (st.rev?.cycles ?? 0) + 1,
    burnedMu: st.burnedSaos ?? 0,           // Σ שריפה מצטברת
    vePaidMu: (st.rev?.vePaidMu ?? 0) + veUsds, // Σ מימון-קרן-ve מצטבר
  };
}

/** (1) אפוק-פליפ: קרן-ve-pot מתחלקת פרופורציונלית לכוח-הצבעה (vePoints) של
 * המצביעים — "100%-דמי-הסוואפ-למצביעים" של-Aerodrome, על-כל-מקורות-הקרן. */
function epochFlip(st: DexState, h: number): void {
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
      st.journal.push({ h, t: 0, soldier: who, action: "ve_reward", profitMu: pay, note: `epoch ${st.veEpoch} payout` });
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
