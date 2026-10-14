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

import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

export const POLICY_PROTOCOL = "SAOS-POLICY-ENGINE/1";
export const ARM_PROTOCOL = "SAOS-POLICY-ARM/1";
export const VERDICT_PROTOCOL = "SAOS-POLICY-VERDICT/1";

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

  const laneCfg = p.lanes?.[intent.lane];
  if (!laneCfg || typeof laneCfg !== "object") {
    return finish(intent, at, "HALT", [`unknown lane '${intent.lane}' — fail-closed`]);
  }
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

  if (reasons.length) return finish(intent, at, "HALT", reasons);
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
