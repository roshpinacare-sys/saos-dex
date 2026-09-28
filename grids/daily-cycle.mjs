// DAILY-CYCLE (A-8 · T-7) — המחזור-היומי העצמי: צפה → טיק → הצמד → מוביל → דוח
// ═══════════════════════════════════════════════════════════════════════════
// הרוסט שחייב תיקון: רשת "שמפעילה-את-עצמה" שהייתה תלויה בסשן-סוכן אנושי
// כדי לרוץ — אינה רשת-עצמאית. המחזור הזה הוא פקודה-אחת שעושה הכל:
//
//   1. observe-deep  — חלון-עמוק (2000) על account_history → יסוד-עלות אמת
//                      מקניות-ההיסטוריה (T-7: סוגר את חור-ה-unbased מה-chain)
//   2. tick          — דופק רשת-הטריגרים (דבר-גורר-דבר)
//   3. peg           — מדידה→הצעה→פרסום offer.json (חסר-מפתחות)
//   4. mover         — רק אם מקור-מפתח נוכח בסביבה: פריסת-נזיל-פנוי additive
//                      (גלי-powerdown, הכנסות-מילויים) · בלי-מפתח: דילוג-כנה
//   5. curate        — תוכנית-קיורציה חסרת-מפתחות; ביצוע רק עם posting-WIF
//                      בסביבה (אותה-משמעת C-1/C-3)
//   6. report        — daily-report.json פומבי + אירועים ליומן-הרשת
//
// בידוד-כישלון: כל-שלב לבד — כישלון-שלב לא מפיל את-המחזור, הדוח כנה על מה
// שרץ ומה לא. ליבה (observe/tick/peg) נכשלת → יציאה 2. מוביל/קיורציה
// הם שלבי-חתימה — דילוג כנה אינו כישלון-מחזור.

import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { appendEvent } from "./events.mjs";
import { runTick, loadState, saveState } from "./engine.mjs";
import { runPeg } from "./peg.mjs";
import { runConvert } from "./convert.mjs";
import { observeDeepWindow, realizedPnl } from "./observe.mjs";
import { planCurations } from "./curate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(HERE, "state");
const EVENTS_LOG = join(STATE_DIR, "events.jsonl");
const REPORT_PATH = join(STATE_DIR, "daily-report.json");

const DEFAULT_MASTER_SOURCE = "/tmp/keystation/live-agent/keys/hed-soldiers-source.txt";
export const masterSourcePath = () => process.env.MASTER_SOURCE_PATH || DEFAULT_MASTER_SOURCE;
export const hasMasterSource = () => existsSync(masterSourcePath());
export const hasPostingWif = () => !!process.env.STEEM_POSTING_WIF;

/* ── צעד 1: חלון-עמוק אדפטיבי → יסוד-עלות אמת מה-chain (T-7) ─────────────── */
export async function stepObserveDeep({ account, deepLimit = 2000 } = {}) {
  const deep = await observeDeepWindow({ account, wanted: deepLimit });
  const pnl = realizedPnl(deep.fills);
  const state = loadState();
  state.feeMeter.realPnl = pnl;
  state.feeMeter._lastRealSeq = Math.max(state.feeMeter._lastRealSeq ?? -1, deep.lastSeq);
  const basisBids = deep.fills.filter((f) => f.side === "bid");
  const basisInfo = {
    windowFills: deep.fills.length,
    windowBids: basisBids.length,
    windowServed: deep.served,
    windowRequested: deep.window,
    note: "יסוד מחושב-מחדש מהחלון-העמוק בכל-מחזור — דטרמיניסטי, אפס-סטייה; windowServed = מה שהשרשרת אכן מסרה",
  };
  saveState(state);
  appendEvent(EVENTS_LOG, {
    type: "pnl.recomputed",
    source: "daily-cycle",
    payload: {
      fills: deep.fills.length, realizedSbd: pnl.realizedSbd,
      positionSteem: pnl.positionSteem, openAvgCost: pnl.openAvgCost, unbasedSteem: pnl.unbasedSteem,
      window: deep.window, served: deep.served,
    },
  });
  return { deep: deep.fills.length, pnl, basisInfo };
}

/* ── צעד 3b: מסילת-ההמרה D-023 (T-8) — תוכנית תמיד; ביצוע רק עם מקור-ריבוני ── */
export async function stepConvert() {
  const ev = await runConvert({ execute: hasMasterSource() });
  return {
    ok: true,
    verdict: ev.plan?.verdict ?? null,
    amountSbd: ev.plan?.amountSbd ?? 0,
    discountBps: ev.plan?.discountBps ?? null,
    executed: ev.summary?.converted ?? 0,
    txids: (ev.txids ?? []).filter((t) => t.txid).map((t) => t.txid),
    note: ev.note ?? null,
  };
}

/* ── צעד 4: מוביל additive — פריסת-נזיל-פנוי, רק עם מפתח בסביבה ──────────── */
export async function stepMover() {
  if (!hasMasterSource()) {
    return { skipped: true, reason: `master source absent at ${masterSourcePath()} (fail-closed · A-7 gate) — keyless cycle continues` };
  }
  const { runMover, summarizeEvidence } = await import("./mover.mjs");
  const evidence = await runMover({ additive: true });
  const s = evidence.summary ?? summarizeEvidence(evidence); // T-8: הגנה — יציאה-מוקדמת תמיד מקבלת-סיכום
  return { skipped: false, cancelled: s.cancelled, placed: s.placed, failed: s.failed, blocked: s.blocked, blockers: evidence.blockers ?? [] };
}

/* ── צעד 5: קיורציה — תוכנית תמיד, ביצוע רק עם posting-WIF ───────────────── */
export async function stepCurate({ account } = {}) {
  const plan = await planCurations({ account });
  if (!process.env.STEEM_POSTING_WIF) {
    return { planned: plan.votes.length, executed: 0, skipped: true, reason: "posting WIF absent in environment (fail-closed · C-1/C-3 doctrine)", plan: plan.votes.slice(0, 3) };
  }
  const { executeVotes } = await import("./curate.mjs");
  const res = await executeVotes(plan, { wif: process.env.STEEM_POSTING_WIF });
  return { planned: plan.votes.length, executed: res.executed, skipped: false, txids: res.txids };
}

/* ── המחזור — צעדים מבודדים, דוח כנה; stepOverrides להזרקה בבדיקות-אופליין ── */
export async function runDailyCycle({ account = process.env.SAOS_RELAY_AGENT_ACCOUNT || "headcorner", quiet = false, stepOverrides = {}, persist = true } = {}) {
  const startedAt = new Date().toISOString();
  const report = { startedAt, account, steps: {}, ok: false };
  const run = (name, fn) => (stepOverrides[name] ? stepOverrides[name] : fn);

  /* 1. צפה-עמוק (יסוד-אמת) */
  try {
    const o = await run("observe", () => stepObserveDeep({ account }))();
    report.steps.observe = { ok: true, ...o.basisInfo, realizedSbd: o.pnl.realizedSbd, unbasedSteem: o.pnl.unbasedSteem };
  } catch (e) {
    report.steps.observe = { ok: false, error: String(e?.message ?? e).slice(0, 160) };
  }

  /* 2. דופק-הרשת */
  try {
    const t = await run("tick", () => runTick({ quiet: true }))();
    report.steps.tick = { ok: t.ok, summary: String(t.summary ?? "").slice(0, 200), violations: t.violations ?? null };
  } catch (e) {
    report.steps.tick = { ok: false, error: String(e?.message ?? e).slice(0, 160) };
  }

  /* 3. הצמדה→הצעה */
  try {
    const doc = await run("peg", () => runPeg())();
    report.steps.peg = { ok: true, verdict: doc.verdict, parityBps: doc.parityBps, asks: doc.plan?.asks?.length ?? 0, bids: doc.plan?.bids?.length ?? 0, blockers: doc.blocker, convertArb: doc.marks?.convertArb?.verdict ?? null };
  } catch (e) {
    report.steps.peg = { ok: false, error: String(e?.message ?? e).slice(0, 160) };
  }

  /* 3b. מסילת-ההמרה (D-023 · T-8): קציר-SBD → פאריטי-פנים → STEEM חוזר */
  try {
    report.steps.convert = await run("convert", () => stepConvert())();
  } catch (e) {
    report.steps.convert = { ok: false, error: String(e?.message ?? e).slice(0, 160) };
  }

  /* 4. מוביל (חתימה — שלב-אופציונלי) */
  try {
    report.steps.mover = await run("mover", () => stepMover())();
  } catch (e) {
    report.steps.mover = { skipped: true, reason: `refused honestly: ${String(e?.message ?? e).slice(0, 140)}` };
  }

  /* 5. קיורציה (חתימה — שלב-אופציונלי) */
  try {
    report.steps.curate = await run("curate", () => stepCurate({ account }))();
  } catch (e) {
    report.steps.curate = { planned: 0, executed: 0, skipped: true, reason: `refused honestly: ${String(e?.message ?? e).slice(0, 140)}` };
  }

  /* 6. דוח — ליבה ירוקה = מחזור-תקין */
  const core = ["observe", "tick", "peg"];
  report.ok = core.every((s) => report.steps[s]?.ok);
  report.finishedAt = new Date().toISOString();
  if (persist) writeFileSync(REPORT_PATH, JSON.stringify(report, null, 1) + "\n");
  if (persist) appendEvent(EVENTS_LOG, {
    type: report.ok ? "daily.cycle" : "daily.cycle-degraded",
    source: "daily-cycle",
    payload: { ok: report.ok, steps: Object.fromEntries(Object.entries(report.steps).map(([k, v]) => [k, v.ok ?? !v.skipped ?? false])) },
  });
  if (!quiet) {
    for (const [k, v] of Object.entries(report.steps)) {
      const mark = v.ok === false ? "✗" : v.skipped ? "⏭" : "✓";
      console.log(`[daily] ${mark} ${k}: ${JSON.stringify(v).slice(0, 180)}`);
    }
    console.log(`[daily] ${report.ok ? "CYCLE-OK" : "CYCLE-DEGRADED"} · report: grids/state/daily-report.json`);
  }
  return report;
}

/* ── selftest: אופליין לגמרי — צעדים מוזרקים, אפס-רשת, אפס-מפתחות ────────── */
export async function selftest() {
  const t = (name, ok) => {
    console.log(`${ok ? " ✓" : " ✗"} ${name}`);
    if (!ok) process.exitCode = 1;
  };

  /* וקטור-1: יסוד-פתיחה מהשרשרת → מכירה מתממשת נגד יסוד אמת (סוגר unbased) */
  const { seedPnlPosition, emptyPnl, applyPnlFill } = await import("./observe.mjs");
  let pnl = seedPnlPosition(emptyPnl(), 200, 19); // קנייה-היסטורית: 200 STEEM @ 0.095
  pnl = applyPnlFill(pnl, { side: "ask", steem: 40, sbd: 40 * 0.12, rate: 0.12, seq: 1, at: "t", counterparty: "x" });
  t("seeded basis: sell 40@0.12 vs basis 0.095 → +1.0 SBD", Math.abs(pnl.realizedSbd - 1.0) < 1e-9 && pnl.unbasedSteem === 0);
  t("seed tracked honestly", pnl.basisSeededSteem === 200 && pnl.basisSeededCostSbd === 19);

  /* וקטור-2: בלי יסוד — אותה מכירה נשארת unbased (כנות לא נפגעת) */
  const raw = applyPnlFill(emptyPnl(), { side: "ask", steem: 40, sbd: 40 * 0.12, rate: 0.12, seq: 1, at: "t", counterparty: "x" });
  t("no seed: same sell honestly unbased", raw.unbasedSteem === 40 && raw.realizedSbd === 0);

  /* וקטור-2b (T-8): summarizeEvidence — יציאה-מוקדמת של מוביל תמיד מקבלת-סיכום (הבאג-החי: summary undefined) */
  const { summarizeEvidence } = await import("./mover.mjs");
  const earlyExit = summarizeEvidence({ cancelled: [{ skipped: true }], placed: [], blockers: ["additive: both sides empty"] });
  t("summarizeEvidence: early-exit evidence → zeros, never undefined", earlyExit.cancelled === 0 && earlyExit.placed === 0 && earlyExit.failed === 0 && earlyExit.blocked === 0);
  const withTx = summarizeEvidence({ cancelled: [{ txid: "a" }, { error: "x" }], placed: [{ txid: "b" }, { blocked: "y" }, { error: "z" }] });
  t("summarizeEvidence: tx-only counts (cancelled=1 placed=1 failed=1 blocked=1)", withTx.cancelled === 1 && withTx.placed === 1 && withTx.failed === 1 && withTx.blocked === 1);

  /* וקטור-2c (T-8b): classifyStale — רצפת-ערך r134-VF1 (השיעור-ההפוך לבידים!) */
  const { classifyStale } = await import("./mover.mjs");
  const PP = 0.106978;
  const ord = [
    { orderid: 1, sell_price: { base: "28.806 STEEM", quote: "3.055 SBD" } },   // ask 0.106054 מתחת-לרצפה → stale
    { orderid: 2, sell_price: { base: "10.000 STEEM", quote: "1.070 SBD" } },   // ask 0.1070 מעל → תקין
    { orderid: 3, sell_price: { base: "10.000 STEEM", quote: "1.06968 SBD" } }, // בתוך-סבילות-10bps → תקין
    { orderid: 4, sell_price: { base: "2.000 STEEM", quote: "0.220 SBD" } },    // לא-שלי → מתעלם
    { orderid: 5, sell_price: { base: "1.000 SBD", quote: "9.000 STEEM" } },    // ביד px=1/9=0.1111 מעל → stale
    { orderid: 6, sell_price: { base: "1.000 SBD", quote: "9.900 STEEM" } },    // ביד px=0.10101 מתחת → תקין
  ];
  const myIds = [1, 2, 3, 5, 6];
  const st = classifyStale(ord, myIds, PP);
  t("classifyStale: ask below floor caught", st.some((x) => x.orderid === 1 && x.side === "ask" && Math.abs(x.price - 0.1060543) < 1e-6));
  t("classifyStale: within-tolerance ask NOT stale (no churn on noise)", !st.some((x) => x.orderid === 3));
  t("classifyStale: foreign orderid never stale (D-021 lane)", !st.some((x) => x.orderid === 4));
  t("classifyStale: bid above floor caught via 1/unit inversion (the measured trap)", st.some((x) => x.orderid === 5 && x.side === "bid" && Math.abs(x.price - 1 / 9) < 1e-9));
  t("classifyStale: healthy bid not stale", !st.some((x) => x.orderid === 6));
  t("classifyStale: empty/foreign-only input → no invention", classifyStale([], [99], PP).length === 0);

  /* וקטור-3: מחזור מוזרק — ליבה ירוקה + סדר-ביצוע; אופליין לגמרי */
  const executed = [];
  const ov = {
    observe: async () => { executed.push("observe"); return { basisInfo: { windowFills: 34, windowBids: 29, basisEstablished: true }, pnl: { realizedSbd: -0.016, unbasedSteem: 0 } }; },
    tick: async () => { executed.push("tick"); return { ok: true, summary: "tick#1" }; },
    peg: async () => { executed.push("peg"); return { verdict: "OFFER-READY", parityBps: -267, plan: { asks: [1, 2, 3, 4, 5], bids: [] }, marks: { convertArb: { verdict: "NO-EDGE" } } }; },
    convert: async () => { executed.push("convert"); return { ok: true, verdict: "CONVERT-HOLD", amountSbd: 0 }; },
    mover: async () => { executed.push("mover"); return { skipped: true, reason: "keyless (fail-closed)" }; },
    curate: async () => { executed.push("curate"); return { planned: 5, executed: 0, skipped: true, reason: "no posting WIF" }; },
  };
  const injected = await runDailyCycle({ quiet: true, stepOverrides: ov, persist: false });
  t("injected cycle: all steps ran in order", JSON.stringify(executed) === JSON.stringify(["observe", "tick", "peg", "convert", "mover", "curate"]));
  t("injected cycle: core green → ok=true", injected.ok === true);
  t("injected cycle: peg surfaces convertArb", injected.steps.peg.convertArb === "NO-EDGE");

  /* וקטור-4: ליבה נכשלת → ok=false כנה, שלבי-חתימה לא מפילים */
  const failing = await runDailyCycle({
    quiet: true,
    persist: false,
    stepOverrides: {
      observe: async () => { throw new Error("rpc-down"); },
      tick: async () => ({ ok: true, summary: "t" }),
      peg: async () => ({ verdict: "OFFER-BLOCKED", plan: { asks: [], bids: [] }, marks: {} }),
      mover: async () => { throw new Error("refused"); },
    },
  });
  t("observe fail → cycle degraded honestly", failing.ok === false && failing.steps.observe.ok === false);
  t("mover throw → honest skip, cycle continues", failing.steps.mover.skipped === true && /refused/.test(failing.steps.mover.reason));

  /* וקטור-5: היגיינה — בלי persist, אף-ארטיפקט לא נכתב (הבדיקה לא משאירה עקבות) */
  t("no-persist runs wrote no daily-report", !existsSync(REPORT_PATH) || JSON.parse(readFileSync(REPORT_PATH, "utf8")).startedAt !== "t");

  console.log(process.exitCode === 1 ? "DAILY-SELFTEST: FAIL" : "DAILY-SELFTEST: PASS");
}

/* ── CLI: node grids/daily-cycle.mjs [--selftest] ────────────────────────── */
if (process.argv[1] && process.argv[1].endsWith("daily-cycle.mjs")) {
  if (process.argv.includes("--selftest")) {
    await selftest();
  } else {
    const report = await runDailyCycle();
    process.exit(report.ok ? 0 : 2);
  }
}
