#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// FEE-HARVEST — קציר-עמלות-מתוזמן (ESC-11 · החלטה #24/#25)
// ───────────────────────────────────────────────────────────────────────────
// תפקיד: להעביר עמלות-שנצברו (feeMeter) → רווח-אוצר (treasuryProfit) כדי שהראצ'ט
// treasuryProfitEver יגדל והדלתא-היומית-האמת תזרום לנתיב-הדיבידנד (self-deposit).
//
// חוקי-קציר (ברזל):
//   H-1 · קציר-רק-מה-שנמדד: amount ≤ feeMeter (הקרנל אוכף; הכלי-מציית מראש).
//   H-2 · רצפת-הסולם: כש-feeMeter ≥ LADDER_FUEL_FLOOR(8000) קוצרים רק-את-העודף-מעל-
//         הרצפה — דלק-הרמת-הסולם-אינו-נגע. מתחת-לרצפה: קוצרים-הכל (הרצפה-מתה-ממילא).
//   H-3 · סף-אבק: מתחת-MIN_HARVEST_MU(500µ) — מדלגים-בכנות (op-עלות > תועלת).
//   H-4 · fail-honest: אין-מנוע-חי/אין-טוקן/שגיאה → פלט-כנה, exit-קוד-מדויק, אף-המצאה.
//   H-5 · אפס-סודות: הטוקן-נקרא-מסביבת-תהליך-המנוע-בזמן-ריצה-בלבד (אותו-אמון
//         מארח כמו batch-run.ts: מי-שרץ-על-המארח-הוא-המפעיל) — לעולם לא-נכתב/נרשם.
//
// ריצה:  node grids/fee-harvest.mjs            → קציר-אם-ראוי (ברירת-מחדל)
//        node grids/fee-harvest.mjs --check    → מדידה-בלבד (אפס-מוטציה)
//        node grids/fee-harvest.mjs --selftest → בדיקות-ברזל (אופליין)
// ═══════════════════════════════════════════════════════════════════════════
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

/* ESC-11 (2026-10-19): guard-כניסה — ה-main-רץ-רק-כשהמודול-הוא-הכניסה-הראשית.
 * נמדד-חי: ה-import-מ-dividend-sweep.mjs ביצע-את-ה-main-וקרא-process.exit(0)
 * וקטע-את-סדולת-הדיבידנד. עכשיו: import=הגדרות-בלבד; ריצה-ישירה=התנהגות-מלאה. */
const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

const HERE = dirname(fileURLToPath(import.meta.url));
export const LADDER_FUEL_FLOOR = 8_000; // kernel.ts:176 — אותו-חוק, מועתק-מדויק
export const MIN_HARVEST_MU = 500;      // H-3: סף-אבק
const DEX_PORT = 3010;

export function planHarvest({ feeMeterMu, floor = LADDER_FUEL_FLOOR, minMu = MIN_HARVEST_MU }) {
  const fm = Number(feeMeterMu ?? 0);
  if (!Number.isFinite(fm) || fm < 0) return { action: "SKIP", why: "bad-feeMeter (fail-honest)" };
  if (fm < minMu) return { action: "SKIP", why: `dust ${fm}µ < ${minMu}µ (H-3) — עלות-op > תועלת` };
  const above = Math.max(0, fm - floor);
  if (fm >= floor) {
    if (above < minMu) return { action: "SKIP", why: `at floor (${fm}µ) — ladder fuel untouched, surplus ${above}µ < dust ${minMu}µ` };
    return { action: "HARVEST", amount: above, why: `floor intact: ${floor}µ stays, harvest ${above}µ above` }; // H-2
  }
  return { action: "HARVEST", amount: fm, why: `below floor (${fm}µ < ${floor}µ) — full harvest, ladder already starved either way` };
}

async function liveState() {
  const r = await fetch(`http://127.0.0.1:${DEX_PORT}/saos-dex/api/dex/state`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`state ${r.status}`);
  const d = await r.json();
  const st = d?.state ?? d;
  return { height: st.height, feeMeterMu: st.feeMeter, treasuryProfitMu: st.treasuryProfit, halted: st.halted };
}

function operatorToken(pid) {
  try { return (readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").find((s) => s.startsWith("DEX_OPERATOR_TOKEN=")) ?? "").split("=").slice(1).join("="); }
  catch { return ""; }
}

export async function selftest() {
  const A = (c, m) => { if (!c) throw new Error("SELFTEST-FAIL: " + m); };
  A(planHarvest({ feeMeterMu: 0 }).action === "SKIP", "zero fees → skip");
  A(planHarvest({ feeMeterMu: 33 }).why.includes("dust"), "dust < 500µ → honest skip");
  const below = planHarvest({ feeMeterMu: 1497 });
  A(below.action === "HARVEST" && below.amount === 1497, "below floor → full harvest (ladder starved anyway)");
  const above = planHarvest({ feeMeterMu: 9300 });
  A(above.action === "HARVEST" && above.amount === 1300 && above.why.includes("floor intact"), "above floor → only surplus harvested, 8000µ fuel stays");
  A(planHarvest({ feeMeterMu: 8000 }).action === "SKIP", "exactly at floor → skip (ladder fuel untouched)");
  A(planHarvest({ feeMeterMu: -5 }).action === "SKIP", "negative → skip (fail-honest)");
  A(planHarvest({ feeMeterMu: "x" }).action === "SKIP", "non-numeric → skip");
  A(LADDER_FUEL_FLOOR === 8000 && MIN_HARVEST_MU === 500, "caps match doctrine");
  return { ok: true, tests: 8 };
}

const args = process.argv.slice(2);
if (!IS_MAIN) {
  /* הובא-כמודול — אין-ריצת-main בכלל (נמדד-חי 2026-10-19: import-בלי-guard ביצע-קציר-אמת
   * 2152µ-וקטע-את-סדולת-הדיבידנד; הקציר-עצמו-היה-לגיטימי-אך-הנתיב-היה-מקרי — מתוקן-מהשורש) */
} else if (args.includes("--selftest")) {
  try { const r = await selftest(); console.log(JSON.stringify({ selftest: "PASS", ...r })); process.exit(0); }
  catch (e) { console.error(e.message); process.exit(1); }
} else {
  const checkOnly = args.includes("--check");
  try {
    const st = await liveState();
    if (st.halted) { console.log(JSON.stringify({ action: "SKIP", why: "engine halted — honest sleep" })); process.exit(0); }
    const plan = planHarvest({ feeMeterMu: st.feeMeterMu });
    if (plan.action !== "HARVEST" || checkOnly) { console.log(JSON.stringify({ mode: checkOnly ? "CHECK" : "RUN", height: st.height, feeMeterMu: st.feeMeterMu, ...plan })); process.exit(0); }
    const pid = Number(process.env.SAOS_DEX_PID ?? "") || findEnginePid();
    const token = pid ? operatorToken(pid) : "";
    if (!token) { console.log(JSON.stringify({ action: "SKIP", why: "operator token unreachable (H-5 fail-honest)" })); process.exit(0); }
    const r = await fetch(`http://127.0.0.1:${DEX_PORT}/saos-dex/api/dex/batch`, {
      method: "POST",
      headers: { "x-saos-operator": token, "x-saos-dex-console": "1", "content-type": "application/json" },
      body: JSON.stringify({ issuer: "treasury", ops: [{ type: "harvest", amount: plan.amount, memo: `fee-harvest ${plan.amount}µ @h${st.height} · ESC-11 cadence · ${plan.why}` }] }),
      signal: AbortSignal.timeout(8000),
    });
    const out = await r.json();
    console.log(JSON.stringify({ mode: "RUN", height: st.height, harvestedMu: plan.amount, treasuryProfitBeforeMu: st.treasuryProfitMu, batch: out }, null, 1));
  } catch (e) {
    console.log(JSON.stringify({ action: "SKIP", why: `fail-honest: ${String(e?.message ?? e).slice(0, 120)}` }));
    process.exit(1);
  }
}

function findEnginePid() {
  try { const out = execSync("pgrep -f 'next dev -p 3010' | head -1", { encoding: "utf8" }).trim(); return out ? Number(out) : null; }
  catch { return null; }
}
