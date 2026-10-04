// BRAKE — בלם-ההון של רשת-הגרידים (owner directive 2026-10-04, IM trace 1a108e28015b0451)
// ════════════════════════════════════════════════════════════════════════════════════════
// הבעלים מדד חי ומצא שהאוטונומיה רצה "בלי שכל" — כולל חתימות-הון מכמה-כותבים
// בלי-תיאום. החוק מהיום: כל-חותם (mover/convert) שואל קודם-הכל את הבלם.
//
// הבלם קורא state/STASIS.json (אותו-פרוטוקול FATE-DEFENSE של Domain/agents/STASIS.json).
// active=true → החותם מחזיר תוצאה-כנה (no-op בריא, exit 0) עם שורת-חסימה מפורשת.
// fail-closed: קובץ-פגום = הבלם נחשב פעיל (עצירה בטוחה), לעולם לא ההפך.

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

/** true = החותם חייב לצאת no-op בריר עם הסבר (אסור לחתום). */
export function stasisHalt(tool) {
  const s = stasisState();
  if (s.active !== true) return false;
  console.log(`[STASIS-HALT] ${tool} · reason: ${String(s.reason ?? "unspecified").slice(0, 160)} · since ${s.since ?? "?"}`);
  return true;
}
