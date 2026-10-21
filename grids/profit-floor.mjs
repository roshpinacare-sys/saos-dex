// PROFIT-FLOOR — שער-רצפת-הרווח של רגלי-הסולם (SAOS-PROFIT-FLOOR/1)
// ════════════════════════════════════════════════════════════════════════════════════════
// דונור-הדפוס: The-Swarm-Corporation/AutoHedge — experimental/market_making.py
// MarketMakingConfig.min_profit_threshold = 0.002 (0.2% יעד-רווח מינימלי לראונד-טריפ),
// ראש-מדוד 2026-10-21. הקוד שלהם לא רץ כאן לעולם (R330 · NO-ARMING · אין-ריצת-קוד-חוץ)
// — רק הדפוס נמדד ואומץ למציאות-שלנו: שופט-טהור, דטרמיניסטי, אפס-LLM בנתיב-כסף.
//
// האנטי-כפילות (חוק-הבעלים «שלא יהיו דריסות וכפילויות» — trace 1a15cc5625bc9901):
//   execution-fabric (Task 107) מחזיק את ניהול-המלאי במנוע-הגריד החי (RiskGovernor צד-כבד,
//   :3072 מועצה) — שם-הוא ביתו של השער ההוא ולא נבנה כאן שוב.
//   הפער-החי שנמדד: לסולם (army-ladder) אין חוק-רווח-מינימלי — רגל שסיבוב-מלא שלה
//   (קנייה-ב-edge ומכירה-ב-edge) לא מניבה מעל העמלות היא טחינה (churn): שורפת עמלות,
//   מלאה את הספר ברגליים שרווחן-אמת שלילי. pnl-audit מדד כבר מילויים ב-edge שלילי
//   (−83..−64bps) — החוק הזה נולד מהמדידה, לא מהדונור.
//
// מודל-הרווח (כנה ומינימלי, אפס-מספרים-מומצאים):
//   roundTripCaptureBps = buyEdgeBps + sellEdgeBps − 2 × feeBpsPerLeg
//   · buyEdge/sellEdge מוזרמים מהסולם עצמו (plan.edgeBps + stagger, נמדדים ב-grid-params).
//   · feeBpsPerLeg = מודל-העמלה של הבית (FEE_BPS=30 לרגל — strategies.mjs דרך arb-scan.mjs).
//   · פסק-הדין על היד-הגרועה-ביותר (sell-1 ב-edge — כל-רגל-מכירה-גבוהה-יותר טובה ממנה):
//     אם הלכידה-הגרועה < minProfitBps → היד כולה טחינה.
//
// חוקי-הברזל (אותה-משמעת של brake/policy/daily-budget/risk-size — fail-closed לכל-אורך):
//   1. תצורה חסרה/פגומה/פרוטוקול-זר → HALT (השער נחשב סגור; אף-רגל לא נחתמת).
//   2. קלט לא-סופי (edge/fee) → UNMEASURED = חסימה ב-enforce, דפוס בלבד ב-observe.
//   3. mode="observe" (ברירת-המחדל המדורגת — דוקטרינת STASIS-עובר-מדורג): טחינה מדווחת
//      WOULD-SKIP בלבד (אפס-שינוי-התנהגות). המעבר observe→enforce = שדה-אחד + קבלת-מעבר.
//   4. ביטולים (cancel) לעולם לא נחסמים ע"י השער — ביטול תמיד מפחית-סיכון.
//   5. אפס-סודות, אפס-רשת, אפס-LLM בנתיב-כסף: שופט-טהור.
//   6. tightens-only: השער לעולם לא מרפה רגל — הוא רק מונע חתימת-טחינה; הרחבת-פעילות
//      נובעת מתצורה אנושית-מתועדת (עריכת minProfitBps/feeBpsPerLeg עם-provenance).

import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
let STATE_DIR = join(HERE, "state");

/** לבדיקות-עצמיות בלבד: נתיב-מדינה מבודד (אותו-דפוס של policy/daily-budget/risk-size). */
export function setPaths(stateDir) {
  STATE_DIR = String(stateDir ?? "");
  if (!STATE_DIR) throw new Error("setPaths: empty stateDir");
}

export const CONFIG_PATH = () => join(STATE_DIR, "profit-floor.json");
export const PROFIT_FLOOR_PROTOCOL = "SAOS-PROFIT-FLOOR/1";

const finiteNum = (v) => typeof v === "number" && Number.isFinite(v);

/** טוען-התצורה: חסר/פגום/פרוטוקול-זר = halt:true (fail-closed — לעולם לא ברירות-מחדל שקטות). */
export function loadProfitFloorConfig() {
  const p = CONFIG_PATH();
  if (!existsSync(p)) return { halt: true, reason: `config missing at ${p} — profit-floor gate closed` };
  let raw = null;
  try { raw = JSON.parse(readFileSync(p, "utf8")); } catch (e) { return { halt: true, reason: `config corrupt: ${String(e?.message ?? e).slice(0, 80)}` }; }
  if (!raw || typeof raw !== "object") return { halt: true, reason: "config not an object" };
  if (raw.protocol !== PROFIT_FLOOR_PROTOCOL) return { halt: true, reason: `foreign protocol '${raw.protocol}' — expected ${PROFIT_FLOOR_PROTOCOL}` };
  const mode = raw.mode === "enforce" ? "enforce" : "observe";
  const minProfitBps = raw.minProfitBps;
  if (!finiteNum(minProfitBps) || minProfitBps < 0) return { halt: true, reason: `minProfitBps '${minProfitBps}' not finite ≥0` };
  const feeBpsPerLeg = raw.feeBpsPerLeg;
  if (!finiteNum(feeBpsPerLeg) || feeBpsPerLeg < 0) return { halt: true, reason: `feeBpsPerLeg '${feeBpsPerLeg}' not finite ≥0` };
  return { halt: false, mode, minProfitBps, feeBpsPerLeg };
}

/**
 * שופט-רצפת-הרווח ליד (round-trip): טהור וניתן-לבדיקה.
 *   { verdict: ALLOW | CHURN | UNMEASURED, captureBps, minProfitBps, reason }
 * buyEdgeBps/sellEdgeBps = edge-הרגל-מול-parity (bps) מהסולם; feeBpsPerLeg מהתצורה.
 */
export function evaluateHandProfitFloor(input) {
  const a = input && typeof input === "object" ? input : {};
  const buyEdge = a.buyEdgeBps;
  const sellEdge = a.sellEdgeBps;
  const fee = a.feeBpsPerLeg;
  const minProfit = a.minProfitBps;
  if (!finiteNum(buyEdge) || !finiteNum(sellEdge) || !finiteNum(fee) || !finiteNum(minProfit)) {
    return { verdict: "UNMEASURED", captureBps: null, minProfitBps: finiteNum(minProfit) ? minProfit : null, reason: "non-finite edge/fee/minProfit — fail-closed (no churn leg ever signed blind)" };
  }
  const capture = buyEdge + sellEdge - 2 * fee;
  const ok = capture >= minProfit;
  return {
    verdict: ok ? "ALLOW" : "CHURN",
    captureBps: +capture.toFixed(3),
    minProfitBps: minProfit,
    reason: ok
      ? `round-trip capture ${capture.toFixed(1)}bps (buy ${buyEdge} + sell ${sellEdge} − 2×${fee} fee) ≥ floor ${minProfit}bps`
      : `round-trip capture ${capture.toFixed(1)}bps (buy ${buyEdge} + sell ${sellEdge} − 2×${fee} fee) < floor ${minProfit}bps — churn leg (AutoHedge min_profit_threshold law, measured into our ladder)`,
  };
}

/** פסק-משולב: תצורה + יד. HALT מתצורה גובר על-הכל (השער-סגור). */
export function evaluateProfitFloor({ buyEdgeBps, sellEdgeBps }) {
  const cfg = loadProfitFloorConfig();
  if (cfg.halt) return { verdict: "HALT", mode: "enforce", captureBps: null, reason: cfg.reason };
  const v = evaluateHandProfitFloor({ buyEdgeBps, sellEdgeBps, feeBpsPerLeg: cfg.feeBpsPerLeg, minProfitBps: cfg.minProfitBps });
  return { ...v, mode: cfg.mode, wouldSkip: !cfg.halt && cfg.mode === "observe" && v.verdict === "CHURN" };
}

/* ── selftest — דטרמיניסטי, אפס-רשת, אפס-סודות ───────────────────────────────── */
export function selftest() {
  const t = (name, cond) => { if (!cond) { console.error("SELFTEST-FAIL:", name); process.exitCode = 1; } };

  // דין-היד: לכידה חיוביה מעל הרצפה → ALLOW
  const a1 = evaluateHandProfitFloor({ buyEdgeBps: 80, sellEdgeBps: 80, feeBpsPerLeg: 30, minProfitBps: 20 });
  t("round trip 160−60=100 ≥ 20 → ALLOW", a1.verdict === "ALLOW" && a1.captureBps === 100);

  // טחינה: edge-צר עלול-לא-לכסות עמלות+רצפה
  const a2 = evaluateHandProfitFloor({ buyEdgeBps: 30, sellEdgeBps: 30, feeBpsPerLeg: 30, minProfitBps: 20 });
  t("round trip 60−60=0 < 20 → CHURN", a2.verdict === "CHURN" && a2.captureBps === 0);

  // שלילי-כנה: edge שלילי = לכידה שלילית → CHURN (pnl-audit מדד מילויים כאלה)
  const a3 = evaluateHandProfitFloor({ buyEdgeBps: -80, sellEdgeBps: 80, feeBpsPerLeg: 30, minProfitBps: 20 });
  t("negative edge → capture −60 → CHURN", a3.verdict === "CHURN" && a3.captureBps === -60);

  // גבול-מדויק: לכידה בדיוק-הרצפה → ALLOW (≥)
  const a4 = evaluateHandProfitFloor({ buyEdgeBps: 55, sellEdgeBps: 55, feeBpsPerLeg: 30, minProfitBps: 50 });
  t("capture exactly 50 ≥ 50 → ALLOW", a4.verdict === "ALLOW");

  // קלט לא-סופי → UNMEASURED (fail-closed)
  t("NaN edge → UNMEASURED", evaluateHandProfitFloor({ buyEdgeBps: NaN, sellEdgeBps: 80, feeBpsPerLeg: 30, minProfitBps: 20 }).verdict === "UNMEASURED");
  t("missing fee → UNMEASURED", evaluateHandProfitFloor({ buyEdgeBps: 80, sellEdgeBps: 80, minProfitBps: 20 }).verdict === "UNMEASURED");

  // תצורה חסרה/פגומה/זרה → HALT (fail-closed, אפס-ברירות-מחדל שקטות)
  const tmp = `${PROFIT_FLOOR_PROTOCOL}-selftest-tmp`;
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  mkdirSync(tmp, { recursive: true });
  const prev = STATE_DIR;
  try {
    setPaths(tmp);
    t("missing config → HALT", evaluateProfitFloor({ buyEdgeBps: 80, sellEdgeBps: 80 }).verdict === "HALT");
    writeFileSync(join(tmp, "profit-floor.json"), "{corrupt");
    t("corrupt config → HALT", evaluateProfitFloor({ buyEdgeBps: 80, sellEdgeBps: 80 }).verdict === "HALT");
    writeFileSync(join(tmp, "profit-floor.json"), JSON.stringify({ protocol: "FOREIGN/9", mode: "enforce" }));
    t("foreign protocol → HALT", evaluateProfitFloor({ buyEdgeBps: 80, sellEdgeBps: 80 }).verdict === "HALT");

    // תצורה חיה-observe: טחינה → WOULD-SKIP דפוס-בלבד (אפס-שינוי-התנהגות)
    writeFileSync(join(tmp, "profit-floor.json"), JSON.stringify({ protocol: PROFIT_FLOOR_PROTOCOL, mode: "observe", minProfitBps: 20, feeBpsPerLeg: 30 }));
    const o1 = evaluateProfitFloor({ buyEdgeBps: 30, sellEdgeBps: 30 });
    t("observe churn → wouldSkip true, verdict CHURN", o1.verdict === "CHURN" && o1.mode === "observe" && o1.wouldSkip === true);
    const o2 = evaluateProfitFloor({ buyEdgeBps: 80, sellEdgeBps: 80 });
    t("observe allow → no wouldSkip", o2.verdict === "ALLOW" && o2.wouldSkip === false);

    // תצורה-enforce: טחינה → CHURN אכיפה
    writeFileSync(join(tmp, "profit-floor.json"), JSON.stringify({ protocol: PROFIT_FLOOR_PROTOCOL, mode: "enforce", minProfitBps: 20, feeBpsPerLeg: 30 }));
    const e1 = evaluateProfitFloor({ buyEdgeBps: 30, sellEdgeBps: 30 });
    t("enforce churn → CHURN enforce, wouldSkip false", e1.verdict === "CHURN" && e1.mode === "enforce" && e1.wouldSkip === false);

    // minProfitBps שלילי/לא-מספר → HALT (תצורה-רעה נסגרת)
    writeFileSync(join(tmp, "profit-floor.json"), JSON.stringify({ protocol: PROFIT_FLOOR_PROTOCOL, mode: "enforce", minProfitBps: -5, feeBpsPerLeg: 30 }));
    t("negative minProfit config → HALT", evaluateProfitFloor({ buyEdgeBps: 80, sellEdgeBps: 80 }).verdict === "HALT");
  } finally {
    setPaths(prev);
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  if (process.exitCode) { console.error("profit-floor selftest: FAILED"); process.exit(process.exitCode); }
  console.log("profit-floor selftest: 13/13 PASS");
}

const isMain = process.argv[1] && process.argv[1].endsWith("profit-floor.mjs");
if (isMain && process.argv.includes("--selftest")) { selftest(); process.exit(process.exitCode || 0); }
