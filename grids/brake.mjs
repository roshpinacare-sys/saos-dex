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
  // 9-c (2026-10-11): liquidity-bootstrap מצטרף למסילת-הספר — הוא חותם limit_order_create
  // על ספר-STEEM הפנימי בדיוק כמו mover/grid-beat (ואף-פעם לא מבטל). החימוש-כפול שלו
  // (קובץ-arm של-הבעלים + שער-מפתח) הוא שכבה-נוספת מעבר לבלם — לא תחליף לו.
  if (t === "mover" || t === "grid-beat:steem" || t === "grid-beat:hive" || t === "liquidity-bootstrap") return "grid";
  // zai-audit 2026-10-11 · מסילת-ההאצלות (owner directive trace 1a12af43fc4d7489
  // "אני רוצה להאציל SP לכלל החשבונות" + אישור-ביצוע 1a12b258c9776305): כלי-ה-delegator
  // מקבל מסילה משלו — נפתחת רק ב-STASIS stagedLanes.allow (או full-lift), אף-פעם
  // במקרה. כלי-לא-מוכר נשאר general fail-closed.
  if (t === "delegator") return "delegations";
  return "general";
}

// ── LANE-GUARDS (SAOS-LANE-GUARDS/1 — cognition-beat 1a10c90522120149) ──────────────
// שכבת-הלמידה-המכנית: ה-cognition-beat (הלולאה-הפנימית של האורגניזם) כותב סורגים
// שיכולים רק לסגור מסילות — לעולם לא לפתוח. קובץ-חסר = אין-סורגים (רגיל);
// קובץ-פגום/פרוטוקול-זר = fail-closed לכל-המסילות; שדות open/allow זרים = מוזנחים-
// ומדווחים (הסורגים חד-כיווניים). תפוגה (expiresAt בעבר) = סורג-מת.
export const GUARDS_PATH = join(HERE, "state", "lane-guards.json");

export function readGuards() {
  if (!existsSync(GUARDS_PATH)) return { missing: true, guards: [], foreignFields: [] };
  try {
    const j = JSON.parse(readFileSync(GUARDS_PATH, "utf8"));
    if (j.protocol !== "SAOS-LANE-GUARDS/1") return { missing: false, unreadable: true, reason: `unknown guards protocol '${j.protocol}' — fail-closed`, guards: [], foreignFields: [] };
    const all = Array.isArray(j.guards) ? j.guards : [];
    const foreignFields = all.filter((g) => g && (g.closed === false || "open" in g || "allow" in g)).map((g) => String(g.id ?? "?"));
    const now = Date.now();
    const active = all.filter((g) => g && g.closed === true && (!g.expiresAt || new Date(g.expiresAt).getTime() > now));
    return { missing: false, guards: active, foreignFields };
  } catch (_) {
    return { missing: false, unreadable: true, reason: "guards file unreadable — fail-closed", guards: [], foreignFields: [] };
  }
}

export function guardHalt(lane) {
  const g = readGuards();
  if (g.unreadable) {
    console.log(`[CAPITAL-GATE] LANE-GUARD-HALT ${lane} · guard=guards-unreadable · reason: ${g.reason}`);
    return { halt: true, guard: null, foreignFields: [] };
  }
  const hit = g.guards.find((x) => String(x.lane ?? "").toLowerCase() === String(lane).toLowerCase());
  if (hit) {
    console.log(`[CAPITAL-GATE] LANE-GUARD-HALT ${lane} · guard=${hit.id} · reason: ${String(hit.reason ?? "").slice(0, 160)}`);
    return { halt: true, guard: hit, foreignFields: g.foreignFields };
  }
  if (g.foreignFields.length) console.log(`[LOOPGUARD] foreign open/allow fields ignored — guards can only close: ${g.foreignFields.join(",")}`);
  return { halt: false, guard: null, foreignFields: g.foreignFields };
}

/** true = החותם חייב לצאת no-op בריר עם הסבר (אסור לחתום). */
export function stasisHalt(tool) {
  const gh = guardHalt(laneOf(tool));
  if (gh.halt) return true;
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
