// POLICY-ENGINE — שכבת-הכסף של הרשת (SAOS-POLICY-ENGINE/1)
// ════════════════════════════════════════════════════════════════════════════════════════
// Owner directive 2026-10-14 (IM trace 1a137c5876e963e9): agentic-wallet PolicyEngine
// pattern adapted to the fleet's keyless reality. DECISIONS #17 (saos-dex).
//
// הפרדת-הרשויות המדודה של המערכת:
//   STASIS (brake.mjs)      = הבלם הריבוני — עוצר מסילות שלמות (owner word בקובץ).
//   POLICY (policy.mjs)     = מנוע-הפוליסות — בודק כל-כוונה (intent) כנגד:
//        (1) סכמת-כוונה (SAOS-INTENT/1) — כוונה-פגומה = עצירה, לעולם לא ניחוש;
//        (2) תקרת-הוצאה לכל-פעולה (maxNotionalPerOpSbd);
//        (3) תקרת-מחזור לרענון-גריד אטומי (maxCycleNotionalSbd/maxOpsPerCycle);
//        (4) מגבלת-קצב (maxOpsPerHour — נמדדת מה-ledger, לא מזיכרון-תהליך);
//        (5) שער-הבעלים (ownerGate.notionalSbd) — פעולה מעל התקרה דורשת את
//            קובץ-ההרעמה של הבעלים (policy-arm.json) = ה-Multisig של-המציאות-חסרת-המפתחות.
//
// fail-closed לכל-אורך השרשרת, בדיוק כמו הבלם:
//   קובץ-פוליסה חסר/פגום/פרוטוקול-זר → HALT.
//   מסילה-לא-מוכרת → HALT. סוג-פעולה-זר למסילה → HALT. סכמה-פגומה → HALT.
//   שכתוב-היסטוריה אסור: ה-ledger (policy-ledger.jsonl) הוא append-only ומפורסם-בגיט
//   על-ידי-ה-beats — קבלת-הפסיקה חיה בגיט גם-אחרי-מחיקת-הסנדבוקס (חוק #14).
//
// rateMode="observe": מדידה-כנה לפני-אכיפה (דוקטרינת STASIS-עובר-מדורג) — WOULD-HALT
// נרשם ביומן ובקונסולה, הפעולה עוברת. המעבר observe→enforce = שדה-אחד, owner-gated.

import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { performanceCap } from "./alpha-performance-math.mjs"; // R330: kelly prices the speed by measured expectancy — can only tighten, never loosen (DECISIONS #18)

const HERE = dirname(fileURLToPath(import.meta.url));
let STATE_DIR = join(HERE, "state");

/** לבדיקות-עצמיות בלבד: נתיב-מדינה מבודד. */
export function setPaths(stateDir) {
  STATE_DIR = String(stateDir ?? "");
  if (!STATE_DIR) throw new Error("setPaths: empty stateDir");
}
export const POLICY_PATH = () => join(STATE_DIR, "policy.json");
export const LEDGER_PATH = () => join(STATE_DIR, "policy-ledger.jsonl");
export const ARM_PATH = () => join(STATE_DIR, "policy-arm.json");
export const GEARS_PATH = () => join(STATE_DIR, "policy-gears.json");

export const POLICY_PROTOCOL = "SAOS-POLICY-ENGINE/1";
export const ARM_PROTOCOL = "SAOS-POLICY-ARM/1";
export const VERDICT_PROTOCOL = "SAOS-POLICY-VERDICT/1";
export const GEARS_PROTOCOL = "SAOS-POLICY-GEARS/1";

/** טעינת-הפוליסה — fail-closed: כל-תקלת-קריאה/פרוטוקול-זר = haltAll. */
export function loadPolicy() {
  try {
    const j = JSON.parse(readFileSync(POLICY_PATH(), "utf8"));
    if (j.protocol !== POLICY_PROTOCOL) {
      return { haltAll: true, reason: `unknown policy protocol '${j.protocol ?? "?"}' — fail-closed`, policy: null };
    }
    return { haltAll: false, reason: null, policy: j };
  } catch (_) {
    return { haltAll: true, reason: `policy file unreadable at ${POLICY_PATH()} — fail-closed`, policy: null };
  }
}

const finiteNonNeg = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;

/** סכמת-הכוונה (SAOS-INTENT/1) — כוונה שאינה ניתנת-לאימות = אסורה (fail-closed). */
export function validateIntent(intent) {
  const errs = [];
  const i = intent && typeof intent === "object" ? intent : {};
  if (typeof i.tool !== "string" || !i.tool.trim()) errs.push("tool:string required");
  if (typeof i.lane !== "string" || !i.lane.trim()) errs.push("lane:string required");
  if (typeof i.kind !== "string" || !i.kind.trim()) errs.push("kind:string required");
  if (typeof i.account !== "string" || !i.account.trim()) errs.push("account:string required");
  if (i.amount !== undefined && !finiteNonNeg(i.amount)) errs.push("amount must be finite >=0");
  if (i.price !== undefined && !(typeof i.price === "number" && Number.isFinite(i.price) && i.price > 0)) errs.push("price must be finite >0");
  if (i.notionalSbd !== undefined && !finiteNonNeg(i.notionalSbd)) errs.push("notionalSbd must be finite >=0");
  if (i.opsEst !== undefined && !(Number.isInteger(i.opsEst) && i.opsEst >= 0)) errs.push("opsEst must be int >=0");
  return { ok: errs.length === 0, errs };
}

/** קריאת-ה-ledger — הקצב נמדד מהקבלות-בגיט, לא מזיכרון-תהליך (שורד-מחיקת-סנדבוקס). */
export function readLedger() {
  try {
    return readFileSync(LEDGER_PATH(), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function rateCounts(lane, windowMs) {
  const now = Date.now();
  return readLedger().filter(
    (e) => e && e.lane === String(lane) && e.verdict === "ALLOW" && now - new Date(e.at).getTime() < windowMs
  ).length;
}

/** שער-הבעלים: קובץ-הרעמה תקין (protocol+armed) בלבד פותח — קובץ-חסר/זר = סגור. */
export function ownerArmOk() {
  if (!existsSync(ARM_PATH())) return false;
  try {
    const j = JSON.parse(readFileSync(ARM_PATH(), "utf8"));
    return j.protocol === ARM_PROTOCOL && j.armed === true;
  } catch (_) {
    return false;
  }
}

// ── R329 התיבת-ההילוכים (the paved road): gears change ONLY from accumulated
// ladder receipts — never from deposits, never from an arm file, never from a
// prompt. The TABLE lives in git (policy-gears.json); this code only reads it.
// Fail-closed: unreadable table / unknown protocol / malformed state = gear 1.
// Re-read on EVERY call (same discipline as loadPolicy) — the file is small,
// and a stale cache would betray a fresh git-written table.
function loadGears() {
  try {
    const j = JSON.parse(readFileSync(GEARS_PATH(), "utf8"));
    if (j.protocol !== GEARS_PROTOCOL) return { ok: false, table: null, state: null, why: `protocol '${j.protocol ?? "?"}' != ${GEARS_PROTOCOL}` };
    const gears = Array.isArray(j.gears) ? j.gears : null;
    if (!gears || gears.length === 0 || gears.some((g) => !g || typeof g !== "object" || typeof g.gear !== "number" || !g.require || typeof g.require.greenStreak !== "number" || !g.laneOverrides || typeof g.laneOverrides !== "object")) {
      return { ok: false, table: null, state: null, why: "malformed gear table" };
    }
    const st = j.state && typeof j.state === "object" ? j.state : {};
    const cur = gears.find((g) => g.gear === st.gear) || gears.find((g) => g.require.greenStreak === 0) || gears[0];
    return { ok: true, table: { gears, kelly: loadKelly(j) }, state: { gear: cur.gear, greenStreak: Number.isFinite(st.greenStreak) && st.greenStreak >= 0 ? st.greenStreak : 0, lastVerdict: st.lastVerdict ?? null, lastKind: st.lastKind ?? null, history: Array.isArray(st.history) ? st.history.slice(0, 20) : [] }, why: null };
  } catch (e) { return { ok: false, table: null, state: null, why: String(e?.message ?? e).slice(0, 120) }; }
}

/** R330: חסימת-הקלי מהטבלה — חסרה/שבורה/מנוטרלת = מצמץ-אינרטי (תקרות-הטבלה עומדות; כשל-מצמץ לעולם-לא-עוצר-את-הכביש). */
function loadKelly(j) {
  const k = j && typeof j === "object" ? j.kelly : null;
  if (!k || typeof k !== "object" || Array.isArray(k)) return null;
  if (k.enabled !== true) return null;
  const receipts = Array.isArray(k.receipts) ? k.receipts.filter((f) => typeof f === "string" && f.trim()).map(String) : [];
  if (!receipts.length) return null;
  return { ...k, receipts };
}

/** R330: המצמץ — min(תקרת-ההילוך, קלי) על-תקרות-הכסף בלבד; תקרות-קצב/ops אינן-נוגעות. */
function kellyThrottle(caps, kelly) {
  if (!kelly) return caps;
  try {
    const baseCap = caps && typeof caps === "object" ? caps.maxNotionalPerOpSbd : null;
    if (!(typeof baseCap === "number" && Number.isFinite(baseCap) && baseCap > 0)) return caps;
    const res = performanceCap({ baseGearCap: baseCap, receiptPaths: kelly.receipts.map((f) => join(STATE_DIR, f)), params: kelly });
    const cap = Math.max(0, Math.min(baseCap, res.cap));
    if (!(cap < baseCap)) return caps; // תוחלת-מלאה = הטבלה-כולה; אין-צורך-בהערה
    const factor = baseCap > 0 ? cap / baseCap : 1;
    const out = { ...caps, maxNotionalPerOpSbd: cap };
    if (typeof caps.maxCycleNotionalSbd === "number" && Number.isFinite(caps.maxCycleNotionalSbd)) {
      out.maxCycleNotionalSbd = Math.max(1, Math.floor(caps.maxCycleNotionalSbd * factor + 1e-9)); // 1e-9: floor-רעש-נקודה-צפה
    }
    out.kellyNote = `kelly-cap: gear cap ${baseCap}→${cap} SBD (mode=${res.mode}; ${res.why})`;
    return out;
  } catch (_) {
    return caps; // throttle failure never stalls the road — the other layers hold
  }
}

/** הילוך-פעיל לפי-הטבלה (fail-closed = ילוך-1 הכי-שמרני). */
export function currentGear() {
  const g = loadGears();
  if (!g.ok) return { gear: 1, greenStreak: 0, why: g.why };
  const row = g.table.gears.find((x) => x.gear === g.state.gear);
  const baseCap = row?.laneOverrides?.grid?.maxNotionalPerOpSbd ?? null;
  let kelly = null;
  if (g.table.kelly && typeof baseCap === "number") {
    try {
      const res = performanceCap({ baseGearCap: baseCap, receiptPaths: g.table.kelly.receipts.map((f) => join(STATE_DIR, f)), params: g.table.kelly });
      kelly = { enabled: true, mode: res.mode, cap: res.cap, gearCap: baseCap, informative: res.stats?.informative ?? 0, minBeats: res.stats?.minBeats ?? null };
    } catch (_) { kelly = { enabled: true, mode: "fault" };
    }
  }
  return { gear: g.state.gear, greenStreak: g.state.greenStreak, lastVerdict: g.state.lastVerdict, kelly, why: null };
}

/** יישום-ההילוך על-תצורת-מסילה — הרחבות-הטבלה בלבד; הקוד אינו-ממציא-תקרות. */
export function applyGear(laneName, laneCfg) {
  const base = laneCfg && typeof laneCfg === "object" ? laneCfg : {};
  const g = loadGears();
  if (!g.ok) return base; // fail-closed = static caps from policy.json (gear 1 equals them anyway)
  const row = g.table.gears.find((x) => x.gear === g.state.gear);
  const ov = row?.laneOverrides?.[String(laneName)];
  if (!ov || typeof ov !== "object") return base;
  return kellyThrottle({ ...base, ...ov }, g.table.kelly); // R330: expectancy-priced speed — kelly can only tighten the table row, never loosen it
}

/**
 * R329: ladder-receipt driven gearbox — הקבלה-היא-ההילוך.
 * verdict containing ACTED (LADDER-ACTED / ARMY-ACTED) = green: streak++
 * verdict containing ACTS-FAILED or POLICY-HALTED = instant reset: streak=0, gear=1
 * neutral (AT-TARGET / STASIS / anything else) = no change
 * Upshift when streak >= next gear's require.greenStreak (one gear per receipt, top = table end).
 * Writer errors NEVER throw — a broken gearbox must not stall the road; it falls back to gear 1.
 */
export function recordLadderReceipt(kind, verdict) {
  const v = String(verdict ?? "");
  const k = String(kind ?? "ladder");
  const green = /ACTED/.test(v) && !/FAILED|HALTED/.test(v);
  const red = /FAILED|HALTED/.test(v);
  try {
    const g = loadGears();
    if (!g.ok) { console.log(`[GEARS] inert: ${g.why ?? "unavailable"} — gear stays 1`); return { moved: false, gear: 1, greenStreak: 0 }; }
    const st = g.state;
    const before = { gear: st.gear, greenStreak: st.greenStreak };
    if (red) { st.greenStreak = 0; st.gear = 1; }
    else if (green) {
      st.greenStreak += 1;
      const sorted = [...g.table.gears].sort((a, b) => a.require.greenStreak - b.require.greenStreak);
      const next = sorted.find((row) => row.require.greenStreak > 0 && st.greenStreak >= row.require.greenStreak && row.gear > st.gear);
      if (next) st.gear = next.gear;
    }
    st.lastVerdict = v; st.lastKind = k; st.at = new Date().toISOString();
    st.history = [{ at: st.at, kind: k, verdict: v, gear: st.gear, greenStreak: st.greenStreak }, ...(st.history || [])].slice(0, 20);
    // R330: kelly snapshot — the expectancy governor is measured at receipt time and published
    // in the git state, so every probe/beat sees it without recomputing (2-core economy).
    try {
      const krow = g.table.gears.find((x) => x.gear === st.gear);
      const kbase = krow?.laneOverrides?.grid?.maxNotionalPerOpSbd ?? null;
      if (g.table.kelly && typeof kbase === "number") {
        const kres = performanceCap({ baseGearCap: kbase, receiptPaths: g.table.kelly.receipts.map((f) => join(STATE_DIR, f)), params: g.table.kelly });
        st.kelly = { mode: kres.mode, cap: kres.cap, gearCap: kbase, informative: kres.stats?.informative ?? 0, minBeats: kres.stats?.minBeats ?? null, at: st.at };
      }
    } catch (_) { /* kelly snapshot never blocks the receipt write */ }
    const j = JSON.parse(readFileSync(GEARS_PATH(), "utf8"));
    j.state = st; j.at = st.at;
    writeFileSync(GEARS_PATH(), JSON.stringify(j, null, 1) + "\n");
    const moved = st.gear !== before.gear;
    console.log(`[GEARS] ${k} ${v} → gear=${st.gear} streak=${st.greenStreak}${moved ? ` UPSHIFT ${before.gear}→${st.gear}` : red ? " (reset)" : ""}`);
    return { moved, gear: st.gear, greenStreak: st.greenStreak };
  } catch (e) {
    console.log(`[GEARS] record failed (road continues, gear falls back conservative): ${String(e?.message ?? e).slice(0, 120)}`);
    return { moved: false, gear: 1, greenStreak: 0, err: String(e?.message ?? e).slice(0, 120) };
  }
}

function finish(intent, at, verdict, reasons) {
  const rec = {
    protocol: VERDICT_PROTOCOL,
    at,
    tool: intent?.tool ?? "?",
    lane: intent?.lane ?? "?",
    kind: intent?.kind ?? "?",
    account: intent?.account ?? "?",
    notionalSbd: typeof intent?.notionalSbd === "number" ? intent.notionalSbd : null,
    verdict,
    reasons,
    engine: "policy-engine v1 · agentic-wallet pattern (owner trace 1a137c5876e963e9) · DECISIONS #17",
  };
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(LEDGER_PATH(), JSON.stringify(rec) + "\n");
  } catch (_) {
    /* כתיבת-קבלה נכשלה לא משחררת את הפעולה — האכיפה היא מהפוליסה, ה-ledger הוא ראיה */
  }
  if (verdict === "HALT") console.log(`[POLICY-ENGINE] HALT ${rec.tool} (${rec.lane}/${rec.kind}) · ${reasons.join(" ; ")}`);
  return { allow: verdict === "ALLOW", verdict, reasons };
}

/**
 * השער — כל-כוונה עוברת כאן לפני-חתימה. החזר: {allow, verdict, reasons}.
 * HALT = החותם חייב לצאת no-op בריר עם הסיבה (אסור לחתום, אסור לשתוק).
 */
export function policyGate(intent) {
  const at = new Date().toISOString();
  const v = validateIntent(intent);
  if (!v.ok) return finish(intent, at, "HALT", [`intent-schema: ${v.errs.join(", ")}`]);

  const lp = loadPolicy();
  if (lp.haltAll) return finish(intent, at, "HALT", [lp.reason]);
  const p = lp.policy;

  const laneCfgBase = p.lanes?.[intent.lane];
  if (!laneCfgBase || typeof laneCfgBase !== "object") {
    return finish(intent, at, "HALT", [`unknown lane '${intent.lane}' — fail-closed`]);
  }
  const laneCfg = applyGear(intent.lane, laneCfgBase); // R329 gearbox: table-driven cap re-pricing, fail-closed to gear 1
  const kinds = Array.isArray(laneCfg.kinds) ? laneCfg.kinds.map(String) : [];
  if (kinds.length && !kinds.includes(intent.kind)) {
    return finish(intent, at, "HALT", [`kind '${intent.kind}' not in allowlist of lane '${intent.lane}'`]);
  }

  const notional =
    typeof intent.notionalSbd === "number"
      ? intent.notionalSbd
      : typeof intent.amount === "number" && typeof intent.price === "number"
        ? intent.amount * intent.price
        : null;
  const reasons = [];

  if (notional != null && finiteNonNeg(laneCfg.maxNotionalPerOpSbd) && notional > laneCfg.maxNotionalPerOpSbd) {
    reasons.push(`per-op notional ${notional.toFixed(3)} SBD > cap ${laneCfg.maxNotionalPerOpSbd} (lane ${intent.lane})`);
  }
  if (typeof intent.opsEst === "number" && finiteNonNeg(laneCfg.maxOpsPerCycle) && intent.opsEst > laneCfg.maxOpsPerCycle) {
    reasons.push(`cycle ops est ${intent.opsEst} > cap ${laneCfg.maxOpsPerCycle}`);
  }
  if (notional != null && intent.kind === "grid_cycle_refresh" && finiteNonNeg(laneCfg.maxCycleNotionalSbd) && notional > laneCfg.maxCycleNotionalSbd) {
    reasons.push(`cycle notional upper-bound ${notional.toFixed(3)} SBD > cap ${laneCfg.maxCycleNotionalSbd}`);
  }

  const og = p.ownerGate && typeof p.ownerGate === "object" ? p.ownerGate : {};
  if (notional != null && finiteNonNeg(og.notionalSbd) && notional > og.notionalSbd && !ownerArmOk()) {
    reasons.push(`notional ${notional.toFixed(3)} SBD > owner-gate ${og.notionalSbd} — requires owner arm file (${ARM_PROTOCOL})`);
  }

  const rateMode = p.rateMode === "observe" ? "observe" : "enforce";
  if (finiteNonNeg(laneCfg.maxOpsPerHour)) {
    const c = rateCounts(intent.lane, 3_600_000) + 1;
    if (c > laneCfg.maxOpsPerHour) {
      if (rateMode === "enforce") reasons.push(`rate: ${c} allowed ops/h > cap ${laneCfg.maxOpsPerHour} (lane ${intent.lane})`);
      else console.log(`[POLICY-ENGINE] WOULD-HALT (rateMode=observe): rate ${c}/h > ${laneCfg.maxOpsPerHour} · lane=${intent.lane} tool=${intent.tool}`);
    }
  }

  if (reasons.length) {
    // R330 receipt-law: a cap-halt under a kelly-throttled lane carries the expectancy evidence
    if (typeof laneCfg.kellyNote === "string" && laneCfg.kellyNote) reasons.push(laneCfg.kellyNote);
    return finish(intent, at, "HALT", reasons);
  }
  return finish(intent, at, "ALLOW", []);
}

/** כוונת-מחזור (רענון-גריד אטומי): כל-הביטולים+ההצבות של-ריצה-אחת = כוונה-אחת. */
export function policyCycleGate(args) {
  const a = args && typeof args === "object" ? args : {};
  return policyGate({
    tool: a.tool,
    lane: a.lane ?? "grid",
    kind: "grid_cycle_refresh",
    account: a.account,
    opsEst: a.opsEst,
    notionalSbd: a.notionalSbdUpper,
    meta: { chain: a.chain ?? null },
  });
}
