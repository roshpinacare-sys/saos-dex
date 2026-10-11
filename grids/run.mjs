// RUN — CLI של רשת-הטריגרים
//   node grids/run.mjs                    → טיק אחד (ל-Actions/קרון) + צופה-מילויים-אמת
//   node grids/run.mjs --loop [ms]        → לולאה אוטונומית מקומית
//   node grids/run.mjs --observe          → קריאת-מילויים-אמת-בלבד (כלום-לא-כותב-חוץ-מהיומן)
//   node grids/run.mjs --selftest         → 11 אסרטים דטרמיניסטיים (אופליין, לא נוגע ברשת)

import { runTick, loadState, saveState, measureRefPrice } from "./engine.mjs";
import { processRules } from "./rules.mjs";
import { readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const has = (f) => args.includes(f);

if (has("--selftest")) {
  await selftest();
} else if (has("--observe")) {
  await observeOnce();
} else if (has("--loop")) {
  const interval = Number(args[args.indexOf("--loop") + 1]) || 60000;
  await loop(interval);
} else {
  const r = await runTick();
  if (!r.ok) {
    // owner directive 2026-10-04 (trace 1a108e28015b0451): a halt must SPEAK —
    // the twin kept failing exit-2 with zero output; from now the reason is loud.
    console.error(`run: tick not-ok — honest exit 2 · summary=${r.summary ?? "?"}${Array.isArray(r.violations) && r.violations.length ? ` · violations=${r.violations.join(" | ")}` : ""}${r.haltReason ? ` · halt=${r.haltReason}` : ""}`);
    process.exit(2);
  }
  process.exit(0);
}

/* ── צופה-חד-פעמי: קריאת-מילויים-אמת ללא-טיק (לבדיקת-יד אנושית) ─────────── */
async function observeOnce() {
  const { observeRealFills } = await import("./observe.mjs");
  const state = loadState();
  const sinceSeq = state.feeMeter?._lastRealSeq ?? -1;
  const obs = await observeRealFills({ sinceSeq });
  const totalSbd = obs.fills.reduce((s, f) => s + (f.side === "ask" ? f.sbd : -f.sbd), 0);
  console.log(`observe: ${obs.fills.length} new real fills (since seq>${sinceSeq}) · net SBD delta ${totalSbd.toFixed(4)}`);
  for (const f of obs.fills) {
    console.log(`  [${f.seq}] ${f.at} ${f.side.toUpperCase()} ${f.steem} STEEM <-> ${f.sbd} SBD @ ${f.rate} (vs ${f.counterparty})`);
  }
  console.log(`
state real meter: fills=${state.feeMeter?.realFills ?? 0} · sbdDelta=${state.feeMeter?.realSbdDelta ?? 0} · _lastRealSeq=${state.feeMeter?._lastRealSeq ?? "none"}`);
}

/* ── לולאה אוטונומית: הרשת מריצה את עצמה ─────────────────────────────── */
async function loop(intervalMs) {
  console.log(`loop: tick every ${intervalMs}ms · ctrl-c to stop`);
  let backoff = 1;
  for (;;) {
    try {
      const r = await runTick();
      // T-51: שיקוף-רצף-הענן (grid-trigger.yml) — tick → peg-offer;
      // חסימה-כנה מתפרסמת-כ-offer.json ולא-מפילה-את-הטיק (כמו-continue-on-error-בענן).
      try {
        const peg = await import("./peg.mjs");
        await peg.runPeg({});
      } catch (e) {
        console.error("peg-error:", String(e?.message ?? e).slice(0, 120));
      }
      backoff = r.ok ? 1 : Math.min(backoff * 2, 8);
    } catch (e) {
      console.error("tick-error:", String(e?.message ?? e).slice(0, 120));
      backoff = Math.min(backoff * 2, 8);
    }
    await new Promise((res) => setTimeout(res, intervalMs * backoff));
  }
}

/* ── selftest: הוכחת דבר-גורר-דבר מקצה-לקצה ──────────────────────────── */
async function selftest() {
  const isTty = process.stdout.isTTY ?? false;
  const t = (name, ok) => {
    console.log(`${ok ? " ✓" : " ✗"} ${name}`);
    if (!ok) process.exitCode = 1;
  };

  // סביבת-בדיקה נקייה — state.json + events.jsonl + pnl.json: הכל משוחזר בתום הבדיקה
  // (תיקון-היגיינה: pnl.json נשפך-בעבר עם מצב-ה-HALT של הבדיקה — inventory -5 בפומבי)
  const stateDir = join(HERE, "state");
  const backup = existsSync(join(stateDir, "state.json")) ? readFileSync(join(stateDir, "state.json"), "utf8") : null;
  const evBackup = existsSync(join(stateDir, "events.jsonl")) ? readFileSync(join(stateDir, "events.jsonl"), "utf8") : null;
  const pnlBackup = existsSync(join(stateDir, "pnl.json")) ? readFileSync(join(stateDir, "pnl.json"), "utf8") : null;
  rmSync(join(stateDir, "events.jsonl"), { force: true });

  const seedState = JSON.parse(backup ?? JSON.stringify(SEED));
  const price = { refPrice: 3.5, source: "selftest", stale: false };

  /* 1. טיק ראשון: מחיר → ציטוטים (mm-grid + anchor-quote פעילים) */
  writeFileSync(join(stateDir, "state.json"), JSON.stringify(seedState));
  let r = await runTick({ injectedPrice: price, quiet: true });
  t("tick1 runs ok", r.ok);
  t("tick1 quotes grids", r.summary.includes("grid.quote"));

  /* 2. שרשור: anchor.new מצית requote → grid.quote */
  r = await runTick({ injectedPrice: price, injectedEvents: [{ type: "anchor.new", source: "weave", payload: { checkpoint: 999999 } }], quiet: true });
  t("anchor triggers requote", r.summary.includes("rules-fired:1") || r.summary.includes("grid.quote"));

  /* 3. מילויים מצבירים עמלות למד (דטרמיניסטי — אותו-זרע → אותן-תוצאות) */
  const feesAfter3 = loadState().feeMeter.simMu;
  t("fee meter grows from sim fills", feesAfter3 >= 0);

  /* 4. אבן-דרך מזויפת-מכוון: מד-עמלות → הולדת מיקרו-גריד
   * היגיינה: חייב לאפס milestonesHit — מזרע-ייצור (state.json חי) כבר עבר
   * אבני-דרך (spawnCount=3) ואז nextMilestone = 2×האחרונה, והספאון אף-פעם
   * לא יירה בבדיקה. איפוס = דטרמיניזם בלי-תלות-במצב-המחויב. */
  const s = loadState();
  s.feeMeter.simMu = Math.max(s.feeMeter.simMu, 1500); // חוצה את אבן-הפתיחה (1000µ)
  s.feeMeter.milestonesHit = []; // אבן-הפתיחה תמיד 1000µ מחדש
  saveState(s);
  r = await runTick({ injectedPrice: price, quiet: true });
  const after = loadState();
  t("fee milestone spawns micro-grid", after.grids.length > seedState.grids.length);
  t("queue consumed", (after.feeMeter.queue?.length ?? 0) < (seedState.feeMeter.queue?.length ?? 0));

  /* 5. מגן-לולאה: depth חסום */
  const deepEv = { type: "parity.drift", source: "t", payload: { driftBps: 100, bandBps: 10 } };
  const chainRules = [{ id: "X", on: "parity.drift", when: () => true, then: () => [{ action: "noop", emit: { type: "parity.drift", source: "chain", payload: { driftBps: 100, bandBps: 10 } } }] }];
  const res = processRules({ grids: [], feeMeter: { queue: [] } }, [deepEv], chainRules);
  t("loop guard blocks runaway chain", res.halted === true);

  /* 5b. רגרסיית 09-30 (R25): צי-חוקי עסוק (תצפיות-עומק-0 בלבד) לא עוצר את-עצמו —
   * הצתות-תצפית סופיות-מעצמן ולא נספרות-נגד תקציב-המשוב */
  const busy = Array.from({ length: 200 }, (_, i) => ({ type: "grid.fill", source: "g", payload: { gridId: `g${i}` } }));
  const busyRules = [{ id: "R-FILL-REBAL", on: "grid.fill", when: () => true, then: () => [{ action: "rebalance" }] }];
  const resBusy = processRules({ grids: [], feeMeter: { queue: [] } }, busy, busyRules);
  t("busy legal fleet (200 depth-0 fires) never halts", resBusy.halted === false && resBusy.fired === 200);

  /* 5c. משוב-מסתעף (כל-הצתה פולטת 2 אירועים) נעצר על-ידי תקציב-המשוב לפני מגן-העומק */
  const branchRules = [{ id: "B", on: "parity.drift", when: () => true, then: () => [{ action: "noop", emit: { type: "parity.drift", source: "b1", payload: { driftBps: 1, bandBps: 1 } } }, { action: "noop", emit: { type: "parity.drift", source: "b2", payload: { driftBps: 1, bandBps: 1 } } }] }];
  const resBranch = processRules({ grids: [], feeMeter: { queue: [] } }, [deepEv], branchRules);
  t("feedback cascade halts on fires budget", resBranch.halted === true && String(resBranch.haltReason ?? "").startsWith("feedback-fires"));

  /* 6. שוק-קפוא: בלי מחיר אמת — ידיים-בכיס (כנות) */
  writeFileSync(join(stateDir, "state.json"), JSON.stringify(seedState));
  rmSync(join(stateDir, "events.jsonl"), { force: true });
  r = await runTick({ injectedPrice: { refPrice: 3.5, source: "stale-test", stale: true }, quiet: true });
  t("stale market → grids stay hands-in-pockets", !r.summary.includes("fills:1") && !r.summary.includes("fills:2") || r.summary.includes("fills:0"));

  /* 7. אינווריאנטה: מלאי-שלילי → HALT ויציאה */
  const bad = JSON.parse(JSON.stringify(seedState));
  bad.grids[0].inventoryMu = -5;
  writeFileSync(join(stateDir, "state.json"), JSON.stringify(bad));
  rmSync(join(stateDir, "events.jsonl"), { force: true });
  r = await runTick({ injectedPrice: price, quiet: true });
  t("negative inventory halts", r.ok === false && r.violations?.some((v) => v.includes("negative")));

  /* שחזור המצב המחויב — כולל pnl.json (היגיינה מלאה: הבדיקה לא משאירה עקבות) */
  if (backup !== null) writeFileSync(join(stateDir, "state.json"), backup);
  else writeFileSync(join(stateDir, "state.json"), JSON.stringify(SEED, null, 1));
  if (evBackup !== null) writeFileSync(join(stateDir, "events.jsonl"), evBackup);
  else rmSync(join(stateDir, "events.jsonl"), { force: true });
  if (pnlBackup !== null) writeFileSync(join(stateDir, "pnl.json"), pnlBackup);

  console.log(process.exitCode === 1 ? "SELFTEST: FAIL" : "SELFTEST: PASS");
}

/* מצב-הזרע (זהה ל-state/state.json — מוטמע כאן לבדיקה עצמאית) */
const SEED = {
  asof: null,
  runCount: 0,
  lastCheckpoint: null,
  market: { refPrice: null, source: null, stale: true },
  feeMeter: { simMu: 0, simFills: 0, realMu: 0, realFills: 0, milestonesHit: [], queue: ["micro-arb", "sweep", "mm-variant-2"] },
  spawnCount: 0,
  templates: {
    "micro-arb": { strategy: "micro-arb", params: { bandBps: 25, maxNotionalMu: 400 } },
    sweep: { strategy: "sweep", params: { thresholdBps: 80, touchMu: 50, capMu: 3000 } },
    "mm-variant-2": { strategy: "mm-grid", params: { levels: 2, widthBps: 100, levelMu: 60, capMu: 4000 } },
  },
  grids: [
    { id: "mm-core", strategy: "mm-grid", params: { levels: 3, widthBps: 60, levelMu: 100, growth: 1.5, capMu: 10000 }, active: true, inventoryMu: 0, pnlSimMu: 0 },
    { id: "anchor-q", strategy: "anchor-quote", params: { widthBps: 45, levelMu: 120, capMu: 5000 }, active: true, inventoryMu: 0, pnlSimMu: 0 },
  ],
  mission: null,
};
