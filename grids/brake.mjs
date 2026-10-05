// BRAKE — בלם-ההון של רשת-הגרידים (owner directive 2026-10-04, IM trace 1a108e28015b0451)
// ════════════════════════════════════════════════════════════════════════════════════════
// הבעלים מדד חי ומצא שהאוטונומיה רצה "בלי שכל" — כולל חתימות-הון מכמה-כותבים
// בלי-תיאום. החוק מהיום: כל-חותם (mover/convert) שואל קודם-הכל את הבלם.
//
// הבלם קורא state/STASIS.json (אותו-פרוטוקול FATE-DEFENSE של Domain/agents/STASIS.json).
// active=true → החותם מחזיר תוצאה-כנה (no-op בריא, exit 0) עם שורת-חסימה מפורשת.
// fail-closed: קובץ-פגום = הבלם נחשב פעיל (עצירה בטוחה), לעולם לא ההפך.
//
// LANE-AWARE STAGED RE-ENTRY (owner directive 2026-10-05, IM trace 1a10bfe1342b2391
// — "Re-enable its autonomous capabilities intelligently. Let it operate." + calibration
// mandate: staged re-entry, limited exposure, observation, increasing confidence):
//   STASIS נשאר active=true — אבל mode='staged' פותח רק מסילות-מפורטות
//   (state/STASIS.json → stagedLanes.allow). חותם שהמסילה-שלו פתוחה מקבל
//   קבלת STASIS-STAGED-ALLOW וממשיך; כל-יתר (כלי-לא-מוכר, מסילה-לא-פתוחה,
//   mode אחר) נעצר כמו-תמיד. אין-מצב-שבו-הבלם נופל-פתוח: קובץ-חסר/פגום/
//   פרוטוקול-זר = active=true full → עצירה. אפס-מחיקת-היסטוריה — הקובץ-הוא-המסמך.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const STASIS_PATH = join(HERE, "state", "STASIS.json");

export function stasisState() {
  try {
    const j = JSON.parse(readFileSync(STASIS_PATH, "utf8"));
    if (j.protocol !== "SAOS-FATE-DEFENSE-STASIS/1") return { active: true, reason: `unknown stasis protocol '${j.protocol}' — fail-closed` };
    return j;
  } catch (_) {
    return { active: true, reason: `stasis file unreadable at ${STASIS_PATH} — fail-closed` };
  }
}

/**
 * מסילת-הכלי — laneOf(tool): לאן-שהחותם שייך. מיפוי-מפורש מהאודיט (R24-c/R25-d):
 *   'grid'    — מכונות-הסולם/הספר (limit_order_create/cancel על הספר-הפנימי):
 *               mover, grid-beat:steem, grid-beat:hive.
 *   'general' — כל-יתר החותמים: convert (convert_hd), agent-swap-api (מסילת-החלפות —
 *               לא מכונת-הסולם; נשארת עצורה תחת staged בכוונה), וכל-כלי-לא-מוכר.
 * כלי-לא-מוכר → 'general' (fail-closed: היכרות-חסרה = מסילה-סגורה, לעולם לא פתוחה).
 */
export function laneOf(tool) {
  const t = String(tool ?? "").trim().toLowerCase();
  if (t === "mover" || t === "grid-beat:steem" || t === "grid-beat:hive") return "grid";
  return "general";
}

/** true = החותם חייב לצאת no-op בריר עם הסבר (אסור לחתום). */
export function stasisHalt(tool) {
  const s = stasisState();
  if (s.active !== true) return false;
  const lane = laneOf(tool);
  const allow = Array.isArray(s.stagedLanes && s.stagedLanes.allow) ? s.stagedLanes.allow.map((x) => String(x).toLowerCase()) : [];
  if (s.mode === "staged" && allow.includes(lane)) {
    console.log(`[CAPITAL-GATE] STASIS-STAGED-ALLOW ${tool} (lane=${lane}) · reason: ${String(s.reason ?? "unspecified").slice(0, 160)} · since ${s.since ?? "?"}`);
    return false;
  }
  console.log(`[STASIS-HALT] ${tool} (lane=${lane}) · reason: ${String(s.reason ?? "unspecified").slice(0, 160)} · since ${s.since ?? "?"}`);
  return true;
}
