/**
 * launchpad.ts — מסילת-ההשקות (Task 57, נבנה-מחדש-ב-58) · Launch-Rail
 * ═════════════════════════════════════════════════════════════════════════════
 * מקורות: pump.fun/LaunchLab (עקומת-מחיר + הגירה-אוטומטית) · Balancer/Gnosis LBP
 * (מכירה-הולנדית-רציפה). דבר-המפעיל: "נזילות-חדשה-ללא-משתמשים".
 *
 * התרגום-הקנוני על הגרעין (אפס-float · אפס-random · אפס-Date.now):
 *  · הקנייה/המכירה על העקומה הן ops בגרעין (launch_buy/launch_sell) — כסף-אמת:
 *    הגיוס נעול-בחשבון-ההשקה; הוירטואלי משמש תמחור בלבד; מכירות clamp fail-closed.
 *  · ההגירה (graduation) כאן — tick-גובה-טהור מ-buildBlock: בגיוס-הסף ההשקה
 *    מוגרת-אוטומטית לבריכת-AMM אמת (שארית-ההיצע + הגיוס-האמת), LP-100%-לאוצר
 *    (POL-חדש-מההשקות — מתחבר-למדידת-ה-ALE), והנכס נרשם ב-assets (ראוטר-חי).
 *  · רב-משתמשי: כל-אזרח-רשת יכול-להשיק (תקרות: 2-חיות-פר-בעלים, 8-ברשת).
 *  · הפלאיהול: עמלות-השקות (60%-פלטפורמה) → revAux → revenueCycle → 40%-שריפה /
 *    40%-קרן-ve → ALE זורע-את-הבריכות-החדשות. סגור-מעגלית.
 */
import type { DexState } from "./kernel";
import {
  addBal, bal, launchVq, poolKey,
  LPAD_FEE_BPS, LPAD_CREATOR_PCT, LPAD_GRAD_MIN_USDS, LPAD_MAX_RAISE,
  LPAD_LBP_BLOCKS, LPAD_MIN_SUPPLY, LPAD_MAX_SUPPLY, LPAD_VQ_DIV,
} from "./kernel";

export const launchAccount = (id: string): string => `launch:${id}`;

/** הגירה-אוטומטית — נקרא-מ-buildBlock (באמצעות economyTick הורים) על-כל-בלוק.
 * מחזיר את מזהי-ההשקות-שהוגרו (ליומן). כשל-חלקי בהשקה אחת לא עוצר את האחרות. */
export function launchpadTick(st: DexState): string[] {
  const h = st.height;
  if (h <= 0) return [];
  const graduated: string[] = [];
  for (const l of Object.values(st.launch ?? {})) {
    if (l.graduated) continue;
    const raised = bal(st, launchAccount(l.id), "USDS");
    if (raised < LPAD_GRAD_MIN_USDS) continue;
    // ── GRADUATION: העקומה הופכת בריכת-AMM אמת ──
    const R = l.supplyMu - l.soldMu; // שארית-ההיצע (אצל-העקומה — וירטואלי עד-עכשיו)
    const B = raised;                 // הגיוס-האמת (כסף-אמת-נעול)
    if (!(R > 0) || !(B > 0)) continue;
    const key = poolKey(l.code, "USDS");
    const a = key.split("/")[0]; // ממוין — LB|X < USDS
    const b = a === l.code ? "USDS" : l.code;
    const ra = a === l.code ? R : B;
    const rb = a === l.code ? B : R;
    if (st.pools[key]) continue; // לעולם לא (קוד ייחודי) — הגנה fail-closed
    st.pools[key] = { a: a as never, b: b as never, ra, rb, lp: Math.floor(Math.sqrt(ra * rb)), feeAccruedTreasury: 0, swaps: 0 };
    // LP-100%-לאוצר — POL-חדש שנולד-מהשקה-אמת (לא-הדפסה: הכסף הוא הגיוס-האמת)
    addBal(st, "treasury", `LP|${key}`, st.pools[key].lp);
    // רישום-הנכס — הראוטר והספר נפתחים-לו מיד (knownAsset)
    st.assets[l.code] = { refPrice: Math.floor((B * 1000) / R), listed: h };
    // חשבון-ההשקה מתרוקן — כל-הכסף ברזרבות-הבריכה-עצמה
    addBal(st, launchAccount(l.id), "USDS", -B);
    l.graduated = true;
    l.gradH = h;
    l.poolKey = key;
    graduated.push(l.id);
    st.journal.push({
      h, t: 0, soldier: "launchpad", action: "graduation",
      note: `${l.code} GRADUATED → ${key}: ${R}µ טוקן + ${B}µ USDS · LP ${st.pools[key].lp}µ (100% אוצר)`,
    });
  }
  return graduated;
}

/* ══ הדוח-החי — launchpadState (הכל-נמדד-מהמצב, אפס-זיוף) ══════════════════ */

export function launchpadState(st: DexState) {
  const h = st.height;
  const launches = Object.values(st.launch ?? {})
    .sort((x, y) => (x.id < y.id ? -1 : 1))
    .map((l) => {
      const vq = launchVq(st, l);
      const vb = l.supplyMu - l.soldMu;
      const priceMu = vb > 0 ? Math.floor((vq * 1000) / vb) : 0;
      const raised = l.graduated ? 0 : bal(st, launchAccount(l.id), "USDS");
      return {
        id: l.id, owner: l.owner, ticker: l.ticker, name: l.name, code: l.code, mode: l.mode,
        priceMu,
        supplyMu: l.supplyMu,
        circulatingMu: l.soldMu,
        raisedMu: raised,
        gradPctBps: Math.min(10_000, Math.floor((raised * 10_000) / LPAD_GRAD_MIN_USDS)),
        gradTargetMu: LPAD_GRAD_MIN_USDS,
        feesCreatorMu: l.feesCreatorMu,
        feesPlatformMu: l.feesPlatformMu,
        atH: l.atH,
        endH: l.endH,
        blocksLeft: l.endH > 0 ? Math.max(0, l.endH - h) : 0,
        graduated: l.graduated,
        gradH: l.gradH,
        poolKey: l.poolKey,
        status: l.graduated ? "graduated" : l.mode === "lbp" && l.endH > 0 && h >= l.endH ? "ended" : l.mode === "lbp" ? "lbp-live" : "curve",
      };
    });
  return {
    ok: true,
    height: h,
    policy: {
      feeBps: LPAD_FEE_BPS, creatorPct: LPAD_CREATOR_PCT,
      gradMinUsdsMu: LPAD_GRAD_MIN_USDS, maxRaiseMu: LPAD_MAX_RAISE,
      lbpBlocks: LPAD_LBP_BLOCKS, minSupplyMu: LPAD_MIN_SUPPLY, maxSupplyMu: LPAD_MAX_SUPPLY,
      vqDiv: LPAD_VQ_DIV,
    },
    launches,
    revAux: {
      protorevMu: st.revAux?.protorevMu ?? 0,
      launchpadMu: st.revAux?.launchpadMu ?? 0,
    },
    honesty: "כסף-אמת-בלבד: הגיוס נעול-בחשבון-ההשקה, המכירות clamp fail-closed לגיוס-האמת, ההגירה בוראת בריכה אמת עם LP-100%-לאוצר — אפס-rug, אפס-הדפסה, ריפליי-דטרמיניסטי",
  };
}
