// MODEL — מתמטיקת-המשימה: 1000$/יום, בכנות
//
// הכלל היחיד: כל נוסחה כאן זהות-מתמטית שניתנת-לבדיקה, וכל קלט מסומן:
//   [מדידה]  — נמדד מ-RPC ציבורי בזמן-ריצה
//   [הנחה]   — פרמטר מפורש שהמפעיל קובע (מסומן כהנחה, לא כאמת)
//
// מסילות-ההכנסה הממשיות של הרשת (המודל מדבר בשפה-אחת: $/יום):
//
//   1) עמלות-AMM       : volume$/day × feeBps/10000 × poolShareBps/10000
//   2) מסילת-מייקר-גריד: capital$ × turnover/day × captureBps/10000
//   3) קורצ'ן (Steem)  : SP × aprPct/100/365 × price$
//                        [הנחה] aprPct דורש הצבעה-פעילה ושותפי-הצבעה איכותיים
//   4) ריבייט-מייקרים  : משולם רק מעמלות-שנמדדו (feeMeter) — מסילת-חלוקה, לא-יצירה

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FEE_BPS = 30; // [מדידה] עמלת-ה-AMM ב-Dex (chain.ts)

/* ── מדידות-אמת מה-RPC הציבורי ─────────────────────────────────────────── */
export async function measureSteem(account = "headcorner") {
  const rpc = async (method, params) => {
    const r = await fetch("https://api.steemit.com", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(7000),
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
    });
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${String(j.error.message).slice(0, 80)}`);
    return j.result;
  };
  const [accs, feed] = await Promise.all([
    rpc("condenser_api.get_accounts", [[account]]),
    rpc("condenser_api.get_feed_history", []),
  ]);
  const a = accs?.[0];
  if (!a) throw new Error(`account ${account} not found`);
  const num = (s) => parseFloat(String(s).replace(/[A-Za-z ]+/g, ""));
  const cur = feed?.current_median_history;
  const sbdPerSteem = cur ? num(cur.base) / num(cur.quote) : null; // SBD : STEEM
  return {
    account,
    steemLiquid: num(a.balance),          // [מדידה]
    sbdLiquid: num(a.sbd_balance),        // [מדידה]
    vesting: num(a.vesting_shares),       // [מדידה] VESTS
    sbdPerSteem,                          // [מדידה] תזונת-המחיר הציבורית
    note: "USD-honesty: SBD מנוחש ≈1$ עם סטיות-מוכרות (העיגון האמתי של SBD משתנה)",
  };
}

/* ── זהויות-ההכנסה (כל אחת ניתנת-לאימות בחשבון) ────────────────────────── */
/** עמלות-AMM ליום: נפח × עמלה × נתח-בריכה. */
export function ammFeesPerDay(volumeUsd, poolShareBps = 10000) {
  return volumeUsd * (FEE_BPS / 10000) * (poolShareBps / 10000);
}
/** הכנסת-מייקר-גריד ליום: הון × מחזור × תפיסת-פיזור. */
export function mmRevenuePerDay(capitalUsd, turnoverPerDay, captureBps) {
  return capitalUsd * turnoverPerDay * (captureBps / 10000);
}
/** קורצ'ן ליום (כוח-Steem × APR-הנחה × מחיר). */
export function curationPerDay(spPower, aprPct, steemUsd) {
  return spPower * (aprPct / 100 / 365) * steemUsd;
}
/** ההון הדרוש ליעד: target / (turnover × capture). */
export function capitalForTarget(targetPerDay, turnoverPerDay, captureBps) {
  return turnoverPerDay > 0 && captureBps > 0 ? targetPerDay / (turnoverPerDay * (captureBps / 10000)) : Infinity;
}
/** הנפח הדרוש ליעד דרך עמלות-AMM בלבד. */
export function volumeForTarget(targetPerDay, poolShareBps = 10000) {
  return targetPerDay / ((FEE_BPS / 10000) * (poolShareBps / 10000));
}

/** טבלת-שבירה מלאה ליעד 1000$/יום — המסמך-שהמפעיל צריך להחליט לידו. */
export function breakEvenTable(targetPerDay = 1000) {
  const rows = [];
  for (const captureBps of [1, 2, 5, 10, 20]) {
    for (const turnover of [1, 3, 10, 30]) {
      rows.push({
        captureBps, turnoverPerDay: turnover,
        capitalUsd: Math.round(capitalForTarget(targetPerDay, turnover, captureBps)),
      });
    }
  }
  return rows;
}

/* ── צבירת-המודל המלא ──────────────────────────────────────────────────── */
export async function buildModel({ targetPerDay = 1000, aprPct = 2, steemUsd = null, turnoverPerDay = 3, captureBps = 2 } = {}) {
  const m = await measureSteem();
  // הערכת-USD כנה: SBD≈1$ [הנחה] + STEEM דרך תזונת-המחיר אם לא נמסר
  const price = steemUsd ?? (m.sbdPerSteem ? 1 / m.sbdPerSteem : null);
  const capitalNowUsd = m.steemLiquid * (price ?? 0) + m.sbdLiquid; // [מדידה]+[הנחה]
  const capitalNow = Math.round(capitalNowUsd * 100) / 100;
  const sp = m.vesting / 1e6; // קירוב SP גס (VESTS→SP דורש המדידה המלאה של הרשת — מסומן)
  const model = {
    asof: new Date().toISOString(),
    targetPerDay,
    measured: {
      account: m.account,
      steemLiquid: m.steemLiquid,
      sbdLiquid: m.sbdLiquid,
      sbdPerSteem: m.sbdPerSteem,
      capitalNowUsd: capitalNow,
      spApprox: Math.round(sp),
      sources: "api.steemit.com (condenser_api) — ניתן-לשחזור על-ידי כל אחד",
    },
    assumptions: [
      { param: "sbdUsd", value: 1, kind: "הנחה", note: "סטיית-עיגון SBD מוכרת ולא-כאן-מוסתרת" },
      { param: "aprPct", value: aprPct, kind: "הנחה", note: "קורצ'ן דורש הצבעה-פעילה" },
      { param: "turnoverPerDay", value: turnoverPerDay, kind: "הנחה" },
      { param: "captureBps", value: captureBps, kind: "הנחה", note: "תפיסת-פיזור אפקטיבית אחרי adverse-selection" },
    ],
    now: {
      ammFeesPerDay: 0,          // [מדידה] נפח אמת: 0 (dex-watch: 0 deposits)
      mmRevenuePerDay: 0,        // [מדידה] אין-מכונה-חמושה-פעילה
      curationPerDay: Math.round(curationPerDay(sp, aprPct, price ?? 0) * 1e6) / 1e6,
      totalPerDay: 0,
      honest: "ההכנסה-האמתית-היום: $0/יום. קורצ'ן-פוטנציאלי אינו הכנסה עד שמופעל.",
    },
    required: {
      volumeForTargetUsd: Math.round(volumeForTarget(targetPerDay)),
      capitalTable: breakEvenTable(targetPerDay),
      withCurrentCapital: {
        note: "מה-ההון-הנמדד-יכול-לתת-בהנחות-המפורשות",
        mmRevenuePerDay: Math.round(mmRevenuePerDay(capitalNow, turnoverPerDay, captureBps) * 1e6) / 1e6,
        gapToTarget: Math.round((targetPerDay - mmRevenuePerDay(capitalNow, turnoverPerDay, captureBps)) * 100) / 100,
      },
    },
  };
  model.now.totalPerDay = model.now.ammFeesPerDay + model.now.mmRevenuePerDay + model.now.curationPerDay;
  writeFileSync(join(HERE, "model.json"), JSON.stringify(model, null, 1) + "\n");
  return model;
}

/* CLI: node mission/model.mjs [target] */
if (process.argv[1] && process.argv[1].endsWith("model.mjs")) {
  const target = Number(process.argv[2]) || 1000;
  const m = await buildModel({ targetPerDay: target });
  console.log(`measured capital (${m.measured.account}): $${m.measured.capitalNowUsd}`);
  console.log(`honest now: $${m.now.totalPerDay}/day · target: $${m.targetPerDay}/day`);
  console.log(`volume needed for target via AMM fees alone: $${m.required.volumeForTargetUsd}/day`);
  console.log(`with measured capital @${m.assumptions[2].value}x turnover @${m.assumptions[3].value}bps capture: $${m.required.withCurrentCapital.mmRevenuePerDay}/day (gap: $${m.required.withCurrentCapital.gapToTarget})`);
}
