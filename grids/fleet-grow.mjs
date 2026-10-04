// FLEET-GROW — צמיחת-הצי הריבונית: רה-סולם של חיילי-העליונות על סולם-רוחבים ייחודי
// =============================================================================
// שער-הצמיחה (Z-79): צמיחה נכנסת ל-state **רק** עם קבלה-נמדדת — שולי-ווליום
// **ושולי-רווח** חיוביים ב-3/3 זרעים ליעד-החדש (growthVerdict GO), כמו-שנעול
// ב-selftest (חוקי 29: growth-marginals-positive-3seeds / growth-verdict-go-3seeds).
// אין-צמיחה-מתוך-תאווה: אם המדידה אינה מאשרת — הסקריפט מסרב (STOP).
//
// כנות-מלאי: חייל-קיים שומר מלאיו ו-pnlSimMu שלו (אפס-המצאה); חייל-חדש
// מתחיל באפס-מלאי. כל-הצי מרוסק-מחדש על סולם-הרוחבים הייחודי (q27) כדי
// שלא-ייווצרו תאומים (קניבליזציה) בין-הישנים לחדשים.
//
// שימוש: node grids/fleet-grow.mjs --soldiers 32 [--cap-mu 3000] [--dry]
//   --dry  : מדפיס את התכנון בלי לכתוב state.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fleetSpawn, growthVerdict, marginalModel } from "./mm-supremacy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = join(HERE, "state", "state.json");

function argGet(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const hasFlag = (flag) => process.argv.includes(flag);

const target = parseInt(argGet("--soldiers", "0"), 10);
const capMu = parseInt(argGet("--cap-mu", "3000"), 10);
const dry = hasFlag("--dry");
if (!(target > 0)) { console.error("fleet-grow: חובה --soldiers N"); process.exit(2); }

/* 1) שער-המדידה: המודל על נתוני-החקר הקנוניים חייב לומר GO ליעד */
const { scalingStudy } = await import("./sim/volume-sim.mjs");
const rows = scalingStudy({ ticks: 480, seed: 20261004, counts: [8, 16, 32] });
const mo = marginalModel(rows);
const verdict = growthVerdict(mo, target);
if (verdict.verdict !== "GO") {
  console.error(`fleet-grow: STOP — ${verdict.note}`);
  process.exit(1);
}
console.log(`fleet-grow: verdict GO — ${verdict.note}`);

/* 2) טעינת-state ורה-סולם */
const state = JSON.parse(readFileSync(STATE_PATH, "utf8"));
const army = (state.grids ?? []).filter((g) => g.strategy === "supremacy")
  .sort((a, b) => parseInt(a.id.slice(4), 10) - parseInt(b.id.slice(4), 10));
const oldCount = army.length;
if (target < oldCount) { console.error(`fleet-grow: מ-מסרב קיטון (${oldCount}→${target}) — צמיחה-בלבד`); process.exit(2); }

const totalMu = 10000; // אותו-קנה-מידה של Z-78 (ההון-המדווח ב-state.mission)
const refPrice = state.market?.refPrice ?? army[0]?.refPrice ?? 0.2;
const fresh = fleetSpawn(totalMu, target, refPrice, { capMu });
const oldByIndex = new Map(army.map((g, i) => [i, g]));

const oldSupIds = new Set(army.map((g) => g.id));
const kept = (state.grids ?? []).filter((g) => g.strategy !== "supremacy");
const rebuilt = fresh.map((grid, i) => {
  const old = oldByIndex.get(i);
  return {
    id: grid.id,
    strategy: "supremacy",
    active: true,
    inventoryMu: old ? old.inventoryMu : 0, // כנות: קיים שומר-מלאי, חדש מתחיל-אפס
    pnlSimMu: old ? (old.pnlSimMu ?? 0) : 0,
    params: { ...grid.params, note: "R-Z79 unique-width ladder + measured-growth gate (q34/27)" },
    lastNote: old?.lastNote ?? "",
  };
});

state.grids = [...kept, ...rebuilt];
/* 3) תקרת-הצי: אותו-חוק של Z-78 (n × capMu × 0.5) */
state.fleetCap = {
  globalCapMu: target * capMu * 0.5,
  note: `${target} soldiers x capMu ${capMu} x 0.5 — soft breach = fleet unwind, hard 2x = estate halt (Z-78/Z-79)`,
};

const plan = {
  from: oldCount, to: target, capMu,
  fleetCapMu: state.fleetCap.globalCapMu,
  widths: rebuilt.map((g) => g.params.widthBps),
  widthsUnique: new Set(rebuilt.map((g) => g.params.widthBps)).size,
  inventoryPreservedMu: rebuilt.reduce((a, g) => a + g.inventoryMu, 0),
  verdict,
};
console.log(JSON.stringify(plan, null, 1));
if (dry) { console.log("fleet-grow: dry — לא נכתב-state"); process.exit(0); }

writeFileSync(STATE_PATH, JSON.stringify(state, null, 1) + "\n");
console.log(`fleet-grow: state עודכן — צי ${oldCount}→${target} חיילים, fleetCap ${plan.fleetCapMu}μ, ${plan.widthsUnique} רוחבים-ייחודיים`);
