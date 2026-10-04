// VOLUME-SIM — סימולטור-הווליום של מנוע-העליונות (דטרמיניסטי, חתום-SIM)
// =============================================================================
// מה זה מוכיח ומה לא: זו סימולציה-מסומנת (sim:true) שמוכיחה **מנגנון** —
// ציטוט שני-צדדים, הטיית-מלאי, תפיסת-עמלות מזרימת-טייקרים-חוץ, התרחבות-עצמית
// מעמלות-שנמדדו. היא אינה מוכיחה רווח-עתידי. המספרים ניתנים לשחזור מלא:
// אותו-זרע → אותו-קבלה בדיוק (mulberry32, אפס-זמן-קיר).
//
// מודל-השוק (כנה, מוצהר, קצר):
//   · refPrice: הליכה-אקראית אחידה ±volBps לטיק (ללא-קורלציה);
//   · זרימה-חוץ: טייקרים (המשתמשים-האחרים שעל הרשת) מגיעים בהסתברות flowP.
//     **הנחה-מוצהרת של-מיקרו-מבנה: נזילות-רחבה-יותר מושכת זרימה** — כל 8
//     חיילים בצי מוסיפים נגיעה-פוטנציאלית אחת בהסתברות flowP/2. זה כלל-אצבע
//     מוצהר, לא חוק-טבע: בלעדיו "יותר-חיילים" לא יכול להתבטא בשוק-זרימה-קבועה;
//   · עומק-אמת: טייקר צועד בספר — כל הזמנה נצרכת (fill = min(שארית, רמה));
//     5% מהנגיעות הן לווייתנים (×10) שבודקים עומק;
//   · פגיעה-חמצנה: שארית-שלא-נמצאה-עומק בטווח 200bps נסחרת עם נזילות-אחרת —
//     העמלה שלה עדיין לבריכה, אבל לא לספרד שלנו;
//   · עמלת-טייקר: FEE_BPS=30 מכל-notional → בריכת-עמלות;
//   · תפיסת-מייקרים: 70% מהבריכה מתחלק פרו-רטה לפי נתח-נפח (דוקטרינת 70/30);
//   · מפסק-חירום: |מלאי| ≥ capMu → halt; חזרה מתחת 50% מהתקרה → חזרה-לציטוט.
//
// שימוש:
//   node grids/sim/volume-sim.mjs [--receipt נתיב.json] [--report נתיב.md]
//                                  [--ticks 480] [--seed 20261004]

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mulberry32, FEE_BPS } from "../strategies.mjs";
import { supremacyTick, fleetSpawn, feeCompound, captureFees } from "../mm-supremacy.mjs";

const r6 = (v) => Math.round(v * 1e6) / 1e6;

/* ── תרחישים: בסיס / צי / עליונות+התרחבות-עצמית / תנודתיות (עקה) ─────────── */
export const SCENARIOS = {
  "baseline-1":   { soldiers: 1,  capitalMu: 10000, volBps: 30,  flowP: 0.5, compound: false },
  "fleet-8":      { soldiers: 8,  capitalMu: 10000, volBps: 30,  flowP: 0.5, compound: false },
  "supremacy-16": { soldiers: 16, capitalMu: 10000, volBps: 30,  flowP: 0.5, compound: true  },
  "volatile-16":  { soldiers: 16, capitalMu: 10000, volBps: 120, flowP: 0.7, compound: false },
};

/* ── ריצת-תרחיש אחת: מחזירה קבלה-מלאה (כל-המספרים, אפס-טענות) ─────────────── */
export function runScenario(name, cfg, { ticks = 480, seed = 20261004, ref0 = 0.2 } = {}) {
  const rng = mulberry32(seed >>> 0);
  const capMu = Math.max(100, Math.round((cfg.capitalMu * 0.25) / cfg.soldiers));
  const fleet = fleetSpawn(cfg.capitalMu, cfg.soldiers, ref0, { capMu });
  const mkSoldier = (id, grid, cashMul = 0.5) => ({
    id, grid, inv: 0, cash: r6(capMu * ref0 * cashMul), halted: false, vol: 0, fills: 0, halts: 0,
  });
  const st = fleet.map((g, i) => mkSoldier(g.id, g));
  const startCash0 = st.reduce((a, s) => a + s.cash, 0);
  const state = { feeMeter: { capturedMu: 0, compoundedMu: 0, births: 0 } };
  let ref = ref0;
  let feePool = 0, ourVol = 0, extVol = 0, bornTotal = 0;
  let peak = startCash0, maxDD = 0, lastNote = "";
  const BAND = 0.02; // 200bps סבלנות-טייקר (כמו simFill של ה-estate)

  for (let t = 1; t <= ticks; t++) {
    // 1) הליכת-מחיר (אחידה, חתומה)
    ref = r6(ref * (1 + ((rng() * 2 - 1) * cfg.volBps) / 10000));
    if (ref <= 0) ref = ref0;

    // 2) כל-חייל מצטט (מצב-פריקה מנוהל בתוך המנוע; עצירה-מלאה רק 2×תקרה)
    const allOrders = [];
    for (const s of st) {
      if (s.halted && Math.abs(s.inv) < capMu) { s.halted = false; }
      const q = supremacyTick(s.grid, { refPrice: ref, stale: false }, s.inv);
      if (q.halted && !s.halted) { s.halted = true; s.halts += 1; }
      lastNote = q.note;
      if (!q.halted) for (const o of q.orders) allOrders.push({ ...o, owner: s.id, left: o.sizeMu });
    }

    // 3) זרימת-טייקרים-חוץ: נגיעה בסיסית + נגיעות-רחבה (מוצהר: נזילות מושכת זרימה)
    const arrivals = [];
    if (rng() < cfg.flowP) arrivals.push(1);
    const breadth = Math.floor(st.length / 8);
    for (let b = 0; b < breadth; b++) if (rng() < cfg.flowP * 0.5) arrivals.push(1);
    for (const _ of arrivals) {
      const buy = rng() < 0.5;
      const side = buy ? "ask" : "bid";                 // קונה-מרים-ask / מוכר-לתוך-bid
      const whale = rng() < 0.05;
      let remaining = r6((40 + rng() * 80) * (whale ? 10 : 1)); // 40..120μ (לווייתן ×10)
      const band = ref * BAND;
      const cands = allOrders
        .filter((o) => o.side === side && Math.abs(o.price - ref) <= band && o.left > 0)
        .sort((a, b) => (buy ? a.price - b.price : b.price - a.price));
      for (const o of cands) {
        if (remaining <= 0) break;
        const f = Math.min(o.left, remaining);
        const px = o.price;
        const s = st.find((x) => x.id === o.owner);
        if (side === "bid") { s.inv = r6(s.inv + f); s.cash = r6(s.cash - f * px); }
        else { s.inv = r6(s.inv - f); s.cash = r6(s.cash + f * px); }
        ourVol = r6(ourVol + f * px);
        s.vol = r6(s.vol + f * px); s.fills += 1;
        feePool = r6(feePool + f * px * (FEE_BPS / 10000)); // עמלת-הטייקר על המילוי שלנו
        o.left = r6(o.left - f);
        remaining = r6(remaining - f);
      }
      if (remaining > 0) {
        // פגיעה-חמצנה: עסקה עם נזילות-אחרת — עמלה לבריכה, לא לספרד שלנו
        const missNotional = r6(remaining * ref);
        extVol = r6(extVol + missNotional);
        feePool = r6(feePool + missNotional * (FEE_BPS / 10000));
      }
    }

    // 4) התרחבות-עצמית: עמלות-שנמדדו → מיקרו-גריד-חדש (רק כשהתרחיש מרשה)
    if (cfg.compound && t % 60 === 0) {
      state.feeMeter.capturedMu = captureFees(feePool, ourVol, ourVol + extVol);
      const res = feeCompound(state, 25);
      bornTotal += res.born;
      for (let b = 0; b < res.born; b++) {
        const id = `born-${st.length + 1}`;
        st.push(mkSoldier(id, { id, params: { levels: 3, widthBps: 34, levelMu: 60, growth: 1.3, capMu, minSpreadBps: 35, skewAmp: 120 } }, 0.25));
      }
    }

    // 5) מדידת-הון-מתמשכת (drawdown כנה)
    const eq = st.reduce((a, s) => a + s.cash + s.inv * ref, 0);
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > maxDD) maxDD = dd;
  }

  // 6) סגירת-ספר: עמלות-נתפסות פרו-רטה + P&L נגזר (לא מובטח)
  const feesCaptured = captureFees(feePool, ourVol, ourVol + extVol);
  const startCash = r6(startCash0 + Math.max(0, st.length - fleet.length) * capMu * ref0 * 0.25);
  const equityFinal = r6(st.reduce((a, s) => a + s.cash + s.inv * ref, 0));
  const netPnl = r6(equityFinal - startCash + feesCaptured);
  return {
    scenario: name, sim: true, seed, ticks,
    config: { ...cfg, capMu, ref0, breadthArrivals: "liquidity-begets-flow (declared)" },
    results: {
      volumeMu: ourVol, fills: st.reduce((a, s) => a + s.fills, 0),
      extVolumeMu: extVol, feePoolMu: feePool,
      feesCapturedMu: feesCaptured,
      ourVolumeSharePct: r6((ourVol / Math.max(1e-9, ourVol + extVol)) * 100),
      equityFinalMu: equityFinal, startCashMu: startCash,
      spreadPnlMu: r6(equityFinal - startCash),
      netPnlMu: netPnl,
      netPnlPctOfCapital: r6((netPnl / Math.max(1e-9, startCash)) * 100),
      maxDrawdownMu: r6(maxDD),
      halts: st.reduce((a, s) => a + s.halts, 0),
      endSoldiers: st.length, bornFromFees: bornTotal,
      endRef: ref, lastEngineNote: lastNote,
    },
  };
}

/* ── CLI: הרצת-כל-התרחישים + קבלה (JSON) + דוח (MD) + סיכום-מסוף ─────────── */
function argGet(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

export function runAll({ ticks, seed } = {}) {
  const out = [];
  for (const [name, cfg] of Object.entries(SCENARIOS)) out.push(runScenario(name, cfg, { ticks, seed }));
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const ticks = parseInt(argGet("--ticks", "480"), 10);
  const seed = parseInt(argGet("--seed", "20261004"), 10);
  const t0 = Date.now();
  const receipts = runAll({ ticks, seed });
  const dur = Date.now() - t0;
  const receiptPath = argGet("--receipt", "grids/state/supremacy-receipt.json");
  const reportPath = argGet("--report", "grids/state/SUPREMACY-RECEIPT.md");

  const receipt = {
    schema: "saos.mm-supremacy.receipt/v1", sim: true, generatedAt: new Date().toISOString(),
    engine: "grids/mm-supremacy.mjs", seed, ticks, determinism: "mulberry32 — same seed → same numbers",
    model: "declared assumptions in header; liquidity-begets-flow breadth term",
    honesty: "SIM-מסומן: מוכיח מנגנון, לא רווח-עתידי. האמת הריאלית נמדדת ב-observe.mjs מה-chain.",
    scenarios: receipts, runtimeMs: dur,
  };
  mkdirSync(dirname(receiptPath), { recursive: true });
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 1) + "\n");

  const line = (r) => {
    const x = r.results;
    return `| ${r.scenario} | ${x.volumeMu.toFixed(0)} | ${x.fills} | ${x.feesCapturedMu.toFixed(1)} | ${x.spreadPnlMu.toFixed(1)} | ${x.netPnlMu.toFixed(1)} (${x.netPnlPctOfCapital.toFixed(2)}%) | ${x.maxDrawdownMu.toFixed(1)} | ${x.halts} | ${x.endSoldiers} |`;
  };
  const md = [
    "# SUPREMACY-RECEIPT — קבלת-הווליום של מנוע-העליונות (SIM)",
    "",
    `· נוצר: ${receipt.generatedAt} · seed=${seed} · ticks=${ticks} · runtime=${dur}ms`,
    "· דטרמיניזם: אותו-זרע → אותם-מספרים בדיוק (mulberry32). שחזור: `node grids/sim/volume-sim.mjs`",
    "· כנות: **SIM**. מוכיח מנגנון (ציטוט, הטיית-מלאי, תפיסת-עמלות, התרחבות-מעמלות) — לא רווח-עתידי.",
    "· מודל: הנחת-רחבה מוצהרת — נזילות-רחבה-יותר מושכת זרימה (כל 8 חיילים → נגיעה-פוטנציאלית נוספת).",
    "",
    "| תרחיש | ווליום-שלנו(μ) | מילויים | עמלות-נתפסות(μ) | רווח-ספרד(μ) | רווח-נטו(μ) | ירידה-מקס(μ) | הפסקות | חיילים-סוף |",
    "|---|---|---|---|---|---|---|---|---|",
    ...receipts.map(line),
    "",
    "קריאה: יותר-חיילים → יותר-ווליום ויותר-עמלות-נתפסות; תנודתיות מגדילה ווליום **וגם** מלאי-סיכון (ירידה-מקס, הפסקות) — לכן יש מפסקי-חירום ותקרות-מלאי.",
  ].join("\n");
  writeFileSync(reportPath, md + "\n");

  for (const r of receipts) {
    const x = r.results;
    console.log(`${r.scenario}: vol=${x.volumeMu.toFixed(0)}μ fills=${x.fills} fees=${x.feesCapturedMu.toFixed(1)}μ netPnl=${x.netPnlMu.toFixed(1)}μ (${x.netPnlPctOfCapital.toFixed(2)}%) dd=${x.maxDrawdownMu.toFixed(0)}μ halts=${x.halts} soldiers=${x.endSoldiers}`);
  }
  console.log(`receipt → ${receiptPath} | report → ${reportPath} | ${dur}ms`);
}
