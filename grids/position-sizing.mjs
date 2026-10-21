// POSITION-SIZING — שער-הגודל-היחסי של סילות-השוק (SAOS-RISK-SIZE/1)
// ════════════════════════════════════════════════════════════════════════════════════════
// דונור-הדפוס: The-Swarm-Corporation/AutoHedge — ה-Risk-Agent (prompts.py RISK_PROMPT,
// ראש-מדוד 2026-10-21): "recommended position size / maximum drawdown risk / market risk
// exposure / overall risk score" — מחושבים **לפני-ביצוע**. הקוד שלהם לא רץ כאן לעולם
// (R330 · NO-ARMING · אין-ריצת-קוד-חוץ · ה-pipeline שלהם python+LLM) — רק הדפוס נמדד
// ואומץ למציאות-חסרת-המפתחות שלנו: שופט-טהור, דטרמיניסטי, אפס-LLM בנתיב-כסף.
//
// המדידה-שקדמה-לקוד (אנטי-כפילות, חוק-הבעלים 2026-10-21 trace 1a15c66bd6ef02f9):
//   brake.mjs        — הבלם הריבוני (עוצר מסילות-שלמות; לא גודל-מחזורים)
//   policy.mjs       — תקרות-סטטיות לפי-op/מחזור/שעה מה-ledger (לא-יחסיות-לאחוזה)
//   daily-budget.mjs — תקרת-יום מתמדת פר-מסילה (לא-מגיבה-לנזילות/לנפילת-יום)
//   → הפער-החי: תקרת-מחזור **נגזרת-מערך-האחוזה עצמו** (risk fraction), מתהדקת
//     עם-התרחבות-הפיזור בספר (vol-proxy) ועם-יום-PnL שלילי (drawdown guard).
//
// חוקי-הברזל (אותה-משמעת של הבלם/המדיניות/התקציב — fail-closed לכל-אורך):
//   1. קובץ-תצורה חסר/פגום/פרוטוקול-זר → HALT (השער נחשב סגור).
//   2. mode="observe" (ברירת-המחדל המדורגת — דוקטרינת STASIS-עובר-מדורג): חריגה
//      מניבה WOULD-REDUCE בלבד (אפס-שינוי-התנהגות). המעבר observe→enforce =
//      שדה-אחד בתצורה + קבלת-מעבר ב-ledger — מדורג, נמדד, מפורסם.
//   3. tightens-only: התקרה-המגודלת לעולם לא רפויה מעבר לתקרת-המסילה בתצורה
//      (הרחבה = עריכת-תצורה אנושית-מתועדת, לעולם לא היררכיית-שוק-עצמאית).
//   4. אפס-מספרים-מומצאים: אחוזה/spread/pnl מוזרמים מהקורא; השופט מחשב בלבד.
//   5. אפס-סודות ואפס-רשת: שופט-טהור (כמו brake/policy/daily-budget).
//   6. אפס-LLM בנתיב-כסף: גודל = מתמטיקה בלבד (ה-LLM של הצי נשאר במסילת-ה-counsel).

import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
let STATE_DIR = join(HERE, "state");

/** לבדיקות-עצמיות בלבד: נתיב-מדינה מבודד (אותו-דפוס של policy/daily-budget setPaths). */
export function setPaths(stateDir) {
  STATE_DIR = String(stateDir ?? "");
  if (!STATE_DIR) throw new Error("setPaths: empty stateDir");
}

export const CONFIG_PATH = () => join(STATE_DIR, "position-sizing.json");
export const SIZING_PROTOCOL = "SAOS-RISK-SIZE/1";

const finiteNum = (v) => typeof v === "number" && Number.isFinite(v);

/** טוען-התצורה: חסר/פגום/פרוטוקול-זר = halt:true (fail-closed — לעולם לא ברירות-מחדל שקטות). */
export function loadSizingConfig() {
  const p = CONFIG_PATH();
  if (!existsSync(p)) return { halt: true, reason: `config missing at ${p} — sizing gate closed` };
  let raw = null;
  try { raw = JSON.parse(readFileSync(p, "utf8")); } catch (e) { return { halt: true, reason: `config corrupt: ${String(e?.message ?? e).slice(0, 80)}` }; }
  if (!raw || typeof raw !== "object") return { halt: true, reason: "config not an object" };
  if (raw.protocol !== SIZING_PROTOCOL) return { halt: true, reason: `foreign protocol '${raw.protocol}' — expected ${SIZING_PROTOCOL}` };
  const mode = raw.mode === "enforce" ? "enforce" : "observe";
  const frac = raw.maxRiskFractionOfEstate;
  if (!finiteNum(frac) || frac <= 0 || frac > 1) return { halt: true, reason: `maxRiskFractionOfEstate '${frac}' not in (0,1]` };
  const hard = raw.hardCapSbd;
  if (!finiteNum(hard) || hard < 0) return { halt: true, reason: `hardCapSbd '${hard}' not finite ≥0` };
  const spreadTighten = finiteNum(raw.spreadTightenBps) ? raw.spreadTightenBps : 30;
  const drawdownTighten = finiteNum(raw.drawdownTightenSbd) ? raw.drawdownTightenSbd : 25;
  const laneCaps = raw.laneCaps && typeof raw.laneCaps === "object" ? raw.laneCaps : {};
  return { halt: false, mode, maxRiskFractionOfEstate: frac, hardCapSbd: hard, spreadTightenBps: spreadTighten, drawdownTightenSbd: drawdownTighten, laneCaps };
}

/**
 * שופט-הגודל: מחזיר פסק-דין אחיד.
 *   { verdict: ALLOW | REDUCE | WOULD-REDUCE | HALT, mode, sizedCapSbd, baseCapSbd, tightened: [..], reason }
 * קלטים מוזרמים מהקורא (אחוזה ב-SBD, תקרת-מחזור, פיזור-ספר ב-bps, PnL-יום ב-SBD).
 */
export function evaluateSizing(input) {
  const a = input && typeof input === "object" ? input : {};
  const lane = String(a.lane ?? "grid");
  const estateSbd = a.estateSbd;
  const cycleUpper = a.cycleNotionalSbdUpper;
  const spreadBps = finiteNum(a.spreadBps) ? a.spreadBps : 0;
  const dayPnlSbd = finiteNum(a.dayPnlSbd) ? a.dayPnlSbd : 0;
  if (!lane) return { verdict: "HALT", mode: "enforce", sizedCapSbd: null, baseCapSbd: null, tightened: [], reason: "empty lane — fail-closed" };
  if (!finiteNum(estateSbd) || estateSbd < 0) return { verdict: "HALT", mode: "enforce", sizedCapSbd: null, baseCapSbd: null, tightened: [], reason: `estateSbd '${estateSbd}' not finite ≥0 — fail-closed` };
  if (!finiteNum(cycleUpper) || cycleUpper < 0) return { verdict: "HALT", mode: "enforce", sizedCapSbd: null, baseCapSbd: null, tightened: [], reason: `cycleNotionalSbdUpper '${cycleUpper}' not finite ≥0 — fail-closed` };
  if (spreadBps < 0) return { verdict: "HALT", mode: "enforce", sizedCapSbd: null, baseCapSbd: null, tightened: [], reason: "negative spreadBps — fail-closed" };

  const cfg = loadSizingConfig();
  if (cfg.halt) return { verdict: "HALT", mode: "enforce", sizedCapSbd: null, baseCapSbd: null, tightened: [], reason: cfg.reason };

  // הבסיס: אחוזה × שבר-סיכון (דפוס-התורם: size = estate × risk fraction)
  let cap = estateSbd * cfg.maxRiskFractionOfEstate;
  const tightened = [];
  // דרגת-הידוק 1: ספר-רחב (vol-proxy) — הזדמנות-דקה = סיכון-גבוה → חצי-גודל
  if (spreadBps >= cfg.spreadTightenBps) { cap *= 0.5; tightened.push(`spread ${spreadBps.toFixed(1)}bps ≥ ${cfg.spreadTightenBps} → ×0.5`); }
  // דרגת-הידוק 2: יום-שלילי מעבר-הרף (drawdown guard) — מצב-הגנה, לא-מצב-נקמה
  if (dayPnlSbd <= -cfg.drawdownTightenSbd) { cap *= 0.5; tightened.push(`dayPnl ${dayPnlSbd.toFixed(3)} ≤ -${cfg.drawdownTightenSbd} → ×0.5`); }
  // tightens-only: תקרת-מסילה בתצורה + תקרה-קשיחה — השופט לעולם לא מרפה
  const laneCap = finiteNum(cfg.laneCaps[lane]) ? cfg.laneCaps[lane] : null;
  if (laneCap != null && laneCap < cap) { cap = laneCap; tightened.push(`laneCap ${laneCap} bound`); }
  if (cfg.hardCapSbd < cap) { cap = cfg.hardCapSbd; tightened.push(`hardCap ${cfg.hardCapSbd} bound`); }
  const sizedCapSbd = +cap.toFixed(3);

  const reason = sizedCapSbd <= 0
    ? "sized cap 0 (estate floor) — nothing to risk this cycle"
    : tightened.length
      ? `estate ${estateSbd.toFixed(3)} × ${cfg.maxRiskFractionOfEstate} tightened: ${tightened.join(" ; ")}`
      : `estate ${estateSbd.toFixed(3)} × ${cfg.maxRiskFractionOfEstate}`;

  if (cycleUpper <= sizedCapSbd) return { verdict: "ALLOW", mode: cfg.mode, sizedCapSbd, baseCapSbd: +(estateSbd * cfg.maxRiskFractionOfEstate).toFixed(3), tightened, reason };
  if (cfg.mode === "enforce") return { verdict: "REDUCE", mode: cfg.mode, sizedCapSbd, baseCapSbd: +(estateSbd * cfg.maxRiskFractionOfEstate).toFixed(3), tightened, reason: `cycle ${cycleUpper.toFixed(3)} > sized cap ${sizedCapSbd} — reduce or skip (fail-closed)` };
  return { verdict: "WOULD-REDUCE", mode: cfg.mode, sizedCapSbd, baseCapSbd: +(estateSbd * cfg.maxRiskFractionOfEstate).toFixed(3), tightened, reason: `cycle ${cycleUpper.toFixed(3)} > sized cap ${sizedCapSbd} — observe-only, zero behavior change` };
}

function selftest() {
  process.exitCode = 1;
  const tmp = join(HERE, "state", ".sizing-selftest-tmp");
  let passed = 0;
  const t = (name, ok) => { if (!ok) throw new Error(`selftest FAIL: ${name}`); passed++; };
  mkdirSync(tmp, { recursive: true });
  setPaths(tmp);
  const CFG = () => join(tmp, "position-sizing.json");
  const writeAt = (o) => writeFileSync(CFG(), JSON.stringify(o, null, 1));

  // 1. תצורה-חסרה → HALT
  rmSync(CFG(), { force: true });
  t("missing config = HALT", evaluateSizing({ lane: "grid", estateSbd: 100, cycleNotionalSbdUpper: 1 }).verdict === "HALT");
  // 2. תצורה-פגומה → HALT
  writeFileSync(CFG(), "{corrupt");
  t("corrupt config = HALT", evaluateSizing({ lane: "grid", estateSbd: 100, cycleNotionalSbdUpper: 1 }).verdict === "HALT");
  // 3. פרוטוקול-זר → HALT
  writeAt({ protocol: "FOREIGN/9", mode: "enforce", maxRiskFractionOfEstate: 0.25, hardCapSbd: 100 });
  t("foreign protocol = HALT", evaluateSizing({ lane: "grid", estateSbd: 100, cycleNotionalSbdUpper: 1 }).verdict === "HALT");

  // 4. תצורה-תקינה observe
  writeAt({ protocol: SIZING_PROTOCOL, mode: "observe", maxRiskFractionOfEstate: 0.25, hardCapSbd: 400, spreadTightenBps: 30, drawdownTightenSbd: 25, laneCaps: { grid: 300 } });
  const a1 = evaluateSizing({ lane: "grid", estateSbd: 1000, cycleNotionalSbdUpper: 200, spreadBps: 10, dayPnlSbd: 5 });
  t("under cap = ALLOW", a1.verdict === "ALLOW" && a1.sizedCapSbd === 250);
  t("reason carries the math", a1.reason.includes("1000.000 × 0.25"));
  // 5. חריגה-ב-observe → WOULD-REDUCE (אפס-שינוי-התנהגות)
  const a2 = evaluateSizing({ lane: "grid", estateSbd: 1000, cycleNotionalSbdUpper: 300, spreadBps: 10, dayPnlSbd: 5 });
  t("over cap in observe = WOULD-REDUCE", a2.verdict === "WOULD-REDUCE" && a2.mode === "observe" && a2.sizedCapSbd === 250);
  // 6. הידוק-פיזור: spread ≥ 30bps → ×0.5
  const a3 = evaluateSizing({ lane: "grid", estateSbd: 1000, cycleNotionalSbdUpper: 300, spreadBps: 42, dayPnlSbd: 5 });
  t("wide spread tightens ×0.5", a3.verdict === "WOULD-REDUCE" && a3.sizedCapSbd === 125 && a3.tightened.some((s) => s.includes("42.0bps")));
  // 7. הידוק-drawdown: יום-שלילי מעבר-הרף → ×0.5
  const a4 = evaluateSizing({ lane: "grid", estateSbd: 1000, cycleNotionalSbdUpper: 300, spreadBps: 10, dayPnlSbd: -30 });
  t("negative day tightens ×0.5", a4.sizedCapSbd === 125 && a4.tightened.some((s) => s.includes("dayPnl -30.000")));
  // 8. הידוק-כפול → ×0.25
  const a5 = evaluateSizing({ lane: "grid", estateSbd: 1000, cycleNotionalSbdUpper: 300, spreadBps: 42, dayPnlSbd: -30 });
  t("both tiers stack ×0.25", a5.sizedCapSbd === 62.5);
  // 9. laneCap כובע-מקומי (tightens-only)
  const a6 = evaluateSizing({ lane: "grid", estateSbd: 4000, cycleNotionalSbdUpper: 50, spreadBps: 10, dayPnlSbd: 0 });
  t("laneCap bounds the base", a6.verdict === "ALLOW" && a6.sizedCapSbd === 300 && a6.tightened.some((s) => s.includes("laneCap 300")));
  // 10. hardCap כובע-קשיח
  writeAt({ protocol: SIZING_PROTOCOL, mode: "observe", maxRiskFractionOfEstate: 0.25, hardCapSbd: 90, laneCaps: {} });
  const a7 = evaluateSizing({ lane: "grid", estateSbd: 4000, cycleNotionalSbdUpper: 50, spreadBps: 0, dayPnlSbd: 0 });
  t("hardCap bounds the base", a7.sizedCapSbd === 90);
  // 11. enforce → REDUCE
  writeAt({ protocol: SIZING_PROTOCOL, mode: "enforce", maxRiskFractionOfEstate: 0.25, hardCapSbd: 400, laneCaps: { grid: 300 } });
  const a8 = evaluateSizing({ lane: "grid", estateSbd: 1000, cycleNotionalSbdUpper: 300, spreadBps: 10, dayPnlSbd: 5 });
  t("over cap in enforce = REDUCE", a8.verdict === "REDUCE" && a8.mode === "enforce" && a8.sizedCapSbd === 250);
  const a9 = evaluateSizing({ lane: "grid", estateSbd: 1000, cycleNotionalSbdUpper: 250, spreadBps: 10, dayPnlSbd: 5 });
  t("at cap in enforce = ALLOW", a9.verdict === "ALLOW");
  // 12. אחוזה-אפס → תקרה-אפס (רצפת-אחוזה)
  const a10 = evaluateSizing({ lane: "grid", estateSbd: 0, cycleNotionalSbdUpper: 1, spreadBps: 0, dayPnlSbd: 0 });
  t("zero estate = zero cap (ALLOW only when cycle 0)", a10.sizedCapSbd === 0 && a10.verdict === "REDUCE");

  // 13. קלט-זר → HALT
  t("bad estate = HALT", evaluateSizing({ lane: "grid", estateSbd: "x", cycleNotionalSbdUpper: 1 }).verdict === "HALT");
  t("negative estate = HALT", evaluateSizing({ lane: "grid", estateSbd: -1, cycleNotionalSbdUpper: 1 }).verdict === "HALT");
  t("NaN cycle = HALT", evaluateSizing({ lane: "grid", estateSbd: 100, cycleNotionalSbdUpper: NaN }).verdict === "HALT");
  t("empty lane = HALT", evaluateSizing({ lane: "", estateSbd: 100, cycleNotionalSbdUpper: 1 }).verdict === "HALT");
  t("negative spread = HALT", evaluateSizing({ lane: "grid", estateSbd: 100, cycleNotionalSbdUpper: 1, spreadBps: -5 }).verdict === "HALT");
  // 14. מסילה-אחרת בלי-laneCap → לא-דולף מהמסילה
  writeAt({ protocol: SIZING_PROTOCOL, mode: "observe", maxRiskFractionOfEstate: 0.25, hardCapSbd: 400, laneCaps: { grid: 300 } });
  const a11 = evaluateSizing({ lane: "arb", estateSbd: 4000, cycleNotionalSbdUpper: 50, spreadBps: 0, dayPnlSbd: 0 });
  t("lane cap does not leak across lanes", a11.sizedCapSbd === 400 && a11.verdict === "ALLOW");

  rmSync(tmp, { recursive: true, force: true });
  process.exitCode = 0;
  console.log(`position-sizing selftest: PASS (${passed} laws)`);
}

const isSelf = process.argv.includes("--selftest");
if (isSelf) selftest();
