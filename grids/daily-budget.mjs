// DAILY-BUDGET — מושל-התקציב-היומי של סילות-השוק (SAOS-DAILY-BUDGET/1)
// ════════════════════════════════════════════════════════════════════════════════════════
// דונור-הדפוס: HKUDS/Vibe-Trading #1854 (2026-10-15) — "live runners use independent
// decision sessions with configurable cadence and persistent daily usage budgets" + ה-
// daily_order_lock שנבדק בעל-פרעות-קיצון ב-exec34 (head 54f43595, CLASS-C RESEARCH-ONLY).
// הקוד שלהם לא רץ כאן לעולם (R330 · אין-חימוש · אין-ריצת-קוד-חוץ) — רק הדפוס נמדד ואומץ
// למציאות-חסרת-המפתחות שלנו: הרשומה היא הכסף (SBD-קרדיט), היום הוא גבול-UTC, העתיד הוא
// ה-ledger עצמו.
//
// המדידה-שקדמה-לקוד (אנטי-כפילות, חוק-הבעלים 2026-10-21 trace 1a15c66bd6ef02f9):
//   brake.mjs        — הבלם הריבוני (עוצר מסילות-שלמות; לא מודד תקציב-יומי)
//   policy.mjs       — maxNotionalPerOpSbd · maxCycleNotionalSbd/maxOpsPerCycle ·
//                      maxOpsPerHour (מה-ledger) · ownerGate — אין-תקרה-יומית מתמדת
//   → הפער החי: תקרת-יום מתמדת (persistent daily budget) פר-מסילה, נמדדת מה-ledger
//     עצמו (לא-מזיכרון-תהליך — אותה-משמעת של ה-rate-limit), שורדת מחזורי-סנדבוקס.
//
// חוקי-הברזל (כמו-הבלם, fail-closed לכל-אורך):
//   1. קובץ-תצורה חסר/פגום/פרוטוקול-זר → HALT (הבלם נחשב סגור).
//   2. קובץ-ledger קיים-אבל-בלתי-קריא → HALT (אי-אפשר למדוד את היום = לא סוחרים).
//      ledger שאינו-קיים = יום-ריק כן (ריצה-ראשונה לגיטימית).
//   3. גבול-היום: UTC (התאריך מה-now המוזרק). אין קריאת-שעון בנתיב-הנבדק.
//   4. mode="observe" (ברירת-המחדל המדורגת — דוקטרינת STASIS-עובר-מדורג): חריגה
//      מניבה WOULD-BLOCK כן בלבד. המעבר observe→enforce = שדה-אחד בתצורה, נרשם
//      ב-ledger עצמו (קבלת-מעבר) — מדורג, נמדד, מפורסם.
//   5. אף-מספר לא מומצא: כל-notional מוזרק מהקורא; הקריאה מחשבת מה-ledger בלבד.
//   6. אפס-סודות: המודול אף-פעם לא נוגע במפתחות/בשידור — הוא שופט, לא חותם.

import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
let STATE_DIR = join(HERE, "state");

/** לבדיקות-עצמיות בלבד: נתיב-מדינה מבודד (אותו-דפוס של policy.mjs setPaths). */
export function setPaths(stateDir) {
  STATE_DIR = String(stateDir ?? "");
  if (!STATE_DIR) throw new Error("setPaths: empty stateDir");
}

export const CONFIG_PATH = () => join(STATE_DIR, "daily-budget.json");
export const LEDGER_PATH = () => join(STATE_DIR, "daily-budget-ledger.jsonl");
export const BUDGET_PROTOCOL = "SAOS-DAILY-BUDGET/1";
export const LEDGER_PROTOCOL = "SAOS-DAILY-BUDGET-LEDGER/1";

const r6 = (v) => (Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : null);

/** גבול-היום: התאריך ה-UTC של nowIso — טהור, נבדק. */
export function dayOf(nowIso) {
  const d = new Date(String(nowIso));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** טעינת-תצורה — fail-closed: כל-תקלה = HALT עם-סיבה. */
export function loadBudgetConfig() {
  const p = CONFIG_PATH();
  if (!existsSync(p)) {
    return { ok: false, halt: true, reason: `budget config missing at ${p} — fail-closed`, config: null };
  }
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    if (j.protocol !== BUDGET_PROTOCOL) {
      return { ok: false, halt: true, reason: `unknown budget protocol '${j.protocol ?? "?"}' — fail-closed`, config: null };
    }
    const mode = j.mode === "enforce" ? "enforce" : "observe";
    const capNotional = Number(j.maxDailyNotionalSbd);
    const capOps = Number(j.maxDailyOps);
    if (!Number.isFinite(capNotional) || capNotional <= 0 || !Number.isInteger(capOps) || capOps <= 0) {
      return { ok: false, halt: true, reason: "budget caps missing/non-positive — fail-closed", config: null };
    }
    return {
      ok: true, halt: false, reason: null,
      config: { mode, capNotional: r6(capNotional), capOps, lanes: j.lanes ?? null },
    };
  } catch (_) {
    return { ok: false, halt: true, reason: `budget config unreadable at ${p} — fail-closed`, config: null };
  }
}

/**
 * קריאת-ה-ledger — append-only jsonl. קובץ-קיים שאינו-מתחיל בשורת-פרוטוקול תקינה
 * = בלתי-קריא → HALT (fail-closed). מחזיר { halt, reason, entries, fresh }.
 */
export function readBudgetLedger() {
  const p = LEDGER_PATH();
  if (!existsSync(p)) return { halt: false, reason: null, entries: [], fresh: true };
  let raw;
  try {
    raw = readFileSync(p, "utf8");
  } catch (_) {
    return { halt: true, reason: `budget ledger unreadable at ${p} — fail-closed`, entries: [] };
  }
  const lines = raw.split("\n").map((s) => s.trim()).filter(Boolean);
  if (lines.length === 0) return { halt: false, reason: null, entries: [], fresh: true };
  let header;
  try {
    header = JSON.parse(lines[0]);
  } catch (_) {
    return { halt: true, reason: "budget ledger header corrupt — fail-closed", entries: [] };
  }
  if (header.protocol !== LEDGER_PROTOCOL) {
    return { halt: true, reason: `unknown ledger protocol '${header.protocol ?? "?"}' — fail-closed`, entries: [] };
  }
  const entries = [];
  for (let i = 1; i < lines.length; i++) {
    try {
      const e = JSON.parse(lines[i]);
      if (e && typeof e.lane === "string" && Number.isFinite(Number(e.notionalSbd)) && typeof e.day === "string") {
        entries.push(e);
      }
    } catch (_) { /* שורה-פגומה-בודדת נזרקת-כן: הפרוטוקול עצמו נבדק, השורה לא נחשבת */ }
  }
  return { halt: false, reason: null, entries, fresh: false };
}

/**
 * השיפוט: evaluateBudget(lane, notionalSbd, nowIso, laneCap?)
 *   lane        — 'grid' | 'arb' | מסילה-מוכרת-אחרת (מיפוי-כנה)
 *   notionalSbd — גודל-הכוונה ב-SBD-קרדיט (הקורא מזריק; אין-גילוי-כאן)
 *   nowIso      — הזמן המוזרק (דטרמיניזם)
 *   laneCap     — תקרת-מסילה מיוחדת { capNotional, capOps } (אופציונלי; חייבת להדק, לעולם לא להרפות)
 * מחזיר פסק-דין אחיד: { verdict: ALLOW | WOULD-BLOCK | BLOCK | HALT, mode, day,
 *                        dayNotionalSbd, dayOps, capNotionalSbd, capOps, reason }
 */
export function evaluateBudget(lane, notionalSbd, nowIso, laneCap) {
  const day = dayOf(nowIso);
  if (!day) return { verdict: "HALT", mode: "enforce", day: null, dayNotionalSbd: null, dayOps: null, capNotionalSbd: null, capOps: null, reason: `bad nowIso '${nowIso}' — fail-closed` };
  const cfg = loadBudgetConfig();
  if (cfg.halt) return { verdict: "HALT", mode: "enforce", day, dayNotionalSbd: null, dayOps: null, capNotionalSbd: null, capOps: null, reason: cfg.reason };
  const led = readBudgetLedger();
  if (led.halt) return { verdict: "HALT", mode: cfg.config.mode, day, dayNotionalSbd: null, dayOps: null, capNotionalSbd: null, capOps: null, reason: led.reason };
  if (typeof lane !== "string" || !lane) {
    return { verdict: "HALT", mode: cfg.config.mode, day, dayNotionalSbd: null, dayOps: null, capNotionalSbd: null, capOps: null, reason: "empty lane — fail-closed" };
  }
  const want = Number(notionalSbd);
  if (!Number.isFinite(want) || want < 0) {
    return { verdict: "HALT", mode: cfg.config.mode, day, dayNotionalSbd: null, dayOps: null, capNotionalSbd: null, capOps: null, reason: "non-finite/negative notional — fail-closed" };
  }
  // תקרות: ברירת-המחדל מהתצורה; תקרת-המסילה-בתצורה (cfg.lanes[lane]) נאכפת אוטומטית;
  // laneCap מהקורא מותר רק להדק (כנות: מסילה-לא-יכולה להרפות-עצמה)
  let capNotional = cfg.config.capNotional;
  let capOps = cfg.config.capOps;
  const cfgLane = cfg.config.lanes && cfg.config.lanes[lane];
  if (cfgLane) {
    const clN = Number(cfgLane.maxDailyNotionalSbd);
    const clO = Number(cfgLane.maxDailyOps);
    if (Number.isFinite(clN) && clN > 0 && clN <= capNotional) capNotional = r6(clN);
    if (Number.isInteger(clO) && clO > 0 && clO <= capOps) capOps = clO;
  }
  if (laneCap) {
    const lcN = Number(laneCap.capNotional);
    const lcO = Number(laneCap.capOps);
    if (Number.isFinite(lcN) && lcN > 0 && lcN <= capNotional) capNotional = r6(lcN);
    if (Number.isInteger(lcO) && lcO > 0 && lcO <= capOps) capOps = lcO;
  }
  const dayEntries = led.entries.filter((e) => e.day === day && e.lane === lane);
  const dayNotional = r6(dayEntries.reduce((s, e) => s + Number(e.notionalSbd), 0));
  const dayOps = dayEntries.length;
  const breachNotional = r6(dayNotional + want) > capNotional;
  const breachOps = dayOps + 1 > capOps;
  const breach = breachNotional || breachOps;
  const reason = breach
    ? `daily budget: dayNotional ${dayNotional}+${want} vs cap ${capNotional} · dayOps ${dayOps}+1 vs cap ${capOps}`
    : "within daily budget";
  if (cfg.config.mode === "enforce") {
    return { verdict: breach ? "BLOCK" : "ALLOW", mode: "enforce", day, dayNotionalSbd: dayNotional, dayOps, capNotionalSbd: capNotional, capOps, reason };
  }
  return { verdict: breach ? "WOULD-BLOCK" : "ALLOW", mode: "observe", day, dayNotionalSbd: dayNotional, dayOps, capNotionalSbd: capNotional, capOps, reason };
}

/** רישום-כוונה-שבוצה ב-ledger (append-only; קבלת-מעבר-מצב נרשמת כשורת-מסילה '__gear__'). */
export function recordBudget(lane, op, notionalSbd, nowIso, extraNote) {
  const day = dayOf(nowIso);
  if (!day) throw new Error("recordBudget: bad nowIso");
  const entry = {
    protocol: LEDGER_PROTOCOL,
    ts: String(nowIso),
    day,
    lane: String(lane),
    op: String(op ?? ""),
    notionalSbd: r6(Number(notionalSbd)) ?? 0,
  };
  if (extraNote) entry.note = String(extraNote).slice(0, 200);
  mkdirSync(STATE_DIR, { recursive: true });
  if (!existsSync(LEDGER_PATH())) {
    appendFileSync(LEDGER_PATH(), JSON.stringify({ protocol: LEDGER_PROTOCOL, bornAt: String(nowIso) }) + "\n", "utf8");
  }
  appendFileSync(LEDGER_PATH(), JSON.stringify(entry) + "\n", "utf8");
  return entry;
}

/* ── selftest דטרמיניסטי: node grids/daily-budget.mjs --selftest ─────────────── */

const TMP = join(HERE, "state", "selftest-daily-budget");
const CFG_AT = () => join(TMP, "daily-budget.json");
const LED_AT = () => join(TMP, "daily-budget-ledger.jsonl");

function writeAt(p, s) {
  mkdirSync(TMP, { recursive: true });
  writeFileSync(p, s, "utf8");
}
function resetTmp() {
  mkdirSync(TMP, { recursive: true });
  rmSync(CFG_AT(), { force: true });
  rmSync(LED_AT(), { force: true });
}

function selftest() {
  const t = (name, ok) => {
    console.log(`${ok ? " ✓" : " ✗"} ${name}`);
    if (!ok) process.exitCode = 1;
  };
  const now1 = "2026-10-21T08:00:00.000Z";
  const now2 = "2026-10-21T09:00:00.000Z";
  const nowNext = "2026-10-22T00:30:00.000Z";
  resetTmp();

  // 1. גבול-יום טהור
  t("dayOf UTC pure", dayOf(now1) === "2026-10-21" && dayOf(nowNext) === "2026-10-22" && dayOf("garbage") === null);

  // 2. תצורה חסרה → HALT
  setPaths(join(TMP, "missing-dir-does-not-exist"));
  t("missing config = HALT (fail-closed)", evaluateBudget("grid", 1, now1).verdict === "HALT");

  // 3. תצורה פגומה → HALT
  setPaths(TMP);
  writeAt(CFG_AT(), "{not json");
  t("corrupt config = HALT", evaluateBudget("grid", 1, now1).verdict === "HALT");

  // 4. פרוטוקול-זר → HALT
  writeAt(CFG_AT(), JSON.stringify({ protocol: "FOREIGN/9", mode: "enforce", maxDailyNotionalSbd: 10, maxDailyOps: 5 }));
  t("foreign protocol = HALT", evaluateBudget("grid", 1, now1).verdict === "HALT");

  // 5. תצורה תקינה, אין-ledger → ALLOW; תקציב-יום ריק כן
  writeAt(CFG_AT(), JSON.stringify({ protocol: BUDGET_PROTOCOL, mode: "enforce", maxDailyNotionalSbd: 100, maxDailyOps: 3 }));
  const v0 = evaluateBudget("grid", 40, now1);
  t("fresh day ALLOW", v0.verdict === "ALLOW" && v0.dayNotionalSbd === 0 && v0.dayOps === 0);

  // 6. חריגת-notional → BLOCK (enforce)
  recordBudget("grid", "probe-op", 70, now1);
  const v1 = evaluateBudget("grid", 40, now2);
  t("notional breach BLOCK in enforce", v1.verdict === "BLOCK" && v1.dayNotionalSbd === 70);
  const v1b = evaluateBudget("grid", 25, now2);
  t("within remainder ALLOW", v1b.verdict === "ALLOW" && v1b.dayOps === 1);

  // 7. חריגת-מספר-פעולות → BLOCK
  recordBudget("grid", "probe-op", 10, now2);
  recordBudget("grid", "probe-op", 10, now2);
  const v2 = evaluateBudget("grid", 5, now2);
  t("ops-count breach BLOCK", v2.verdict === "BLOCK" && v2.dayOps === 3 && v2.capOps === 3);

  // 8. היום-הבא מתאפס (הזמן המוזרק — דטרמיניזם)
  const v3 = evaluateBudget("grid", 40, nowNext);
  t("next UTC day resets", v3.verdict === "ALLOW" && v3.day === "2026-10-22" && v3.dayNotionalSbd === 0);

  // 9. בידוד-מסילות: תקציב-grid מלא לא חוסם arb
  const v4 = evaluateBudget("arb", 90, now2);
  t("lane isolation grid≠arb", v4.verdict === "ALLOW" && v4.dayNotionalSbd === 0);

  // 10. laneCap מדק בלבד
  const v5 = evaluateBudget("arb", 90, now2, { capNotional: 50, capOps: 10 });
  t("laneCap tightens only", v5.verdict === "BLOCK" && v5.capNotionalSbd === 50);
  const v6 = evaluateBudget("arb", 90, now2, { capNotional: 5000, capOps: 10 });
  t("laneCap cannot loosen", v6.capNotionalSbd === 100);

  // 11. observe → WOULD-BLOCK בלי-עצירה
  writeAt(CFG_AT(), JSON.stringify({ protocol: BUDGET_PROTOCOL, mode: "observe", maxDailyNotionalSbd: 100, maxDailyOps: 3 }));
  const v7 = evaluateBudget("grid", 999, now2);
  t("observe mode WOULD-BLOCK", v7.verdict === "WOULD-BLOCK" && v7.mode === "observe");

  // 12. ledger פגום-בכותרת → HALT
  writeAt(LED_AT(), "garbage-not-protocol\n");
  t("corrupt ledger header = HALT", evaluateBudget("grid", 1, now1).verdict === "HALT");

  // 13. שורה-פגומה-בודדת נזרקת-כן (הפרוטוקול שופט, השורה לא)
  const hdr = JSON.stringify({ protocol: LEDGER_PROTOCOL, bornAt: now1 });
  writeAt(LED_AT(), hdr + "\n" + "{bad line\n" + JSON.stringify({ protocol: LEDGER_PROTOCOL, ts: now2, day: "2026-10-21", lane: "grid", op: "x", notionalSbd: 5 }) + "\n");
  const v8 = evaluateBudget("grid", 5, now2);
  t("bad line skipped, good line counted", v8.verdict === "ALLOW" && v8.dayNotionalSbd === 5 && v8.dayOps === 1);

  // 14. דטרמיניזם: שתי-ריצות = פסק-דין זהה בייט
  const a = JSON.stringify(evaluateBudget("grid", 5, now2));
  const b = JSON.stringify(evaluateBudget("grid", 5, now2));
  t("determinism byte-equal", a === b);

  // 15. תקרת-מסילה-בתצורה נאכפת אוטומטית
  writeAt(CFG_AT(), JSON.stringify({ protocol: BUDGET_PROTOCOL, mode: "enforce", maxDailyNotionalSbd: 100, maxDailyOps: 3, lanes: { grid: { maxDailyNotionalSbd: 20, maxDailyOps: 3 } } }));
  const v9 = evaluateBudget("grid", 15, nowNext);
  t("config lane cap auto-bound (grid=20)", v9.verdict === "ALLOW" && v9.capNotionalSbd === 20);
  const v10 = evaluateBudget("grid", 25, nowNext);
  t("config lane cap auto-block", v10.verdict === "BLOCK" && v10.capNotionalSbd === 20);
  const v11 = evaluateBudget("arb", 90, nowNext);
  t("config lane cap does not leak to other lane", v11.verdict === "ALLOW" && v11.capNotionalSbd === 100);

  // 16. דחיית-קלט-זר
  t("bad nowIso = HALT", evaluateBudget("grid", 1, "not-a-time").verdict === "HALT");
  t("empty lane = HALT", evaluateBudget("", 1, now2).verdict === "HALT");
  t("negative notional = HALT", evaluateBudget("grid", -1, now2).verdict === "HALT");

  resetTmp();
  console.log(`daily-budget selftest: ${process.exitCode === 1 ? "FAIL" : "PASS"}`);
}

const isSelf = process.argv.includes("--selftest");
if (isSelf) selftest();
