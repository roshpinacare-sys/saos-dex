// BRAKE-SELFTEST — וקטורים דטרמיניסטיים אופליין לבלם-ההון המודע-מסילות (staged lanes)
//   node grids/brake-selftest.mjs  → אפס-רשת, אפס-מפתחות, אפס-כתיבה-למדינה-החיה
//   (הבלם נבדק תמיד על עותק-חול שלו + קובץ-STASIS.json פיקטיבי — המדינה-החיה לא נוגעת)
// נולד ב-T-B (owner directive 2026-10-05, trace 1a10bfe1342b2391 — staged re-entry):
// הבלם נשאר active=true; mode=staged פותח רק מסילות-מפורטות; כל-כישלון-קריאה = עצירה.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const t = (name, ok) => {
  console.log(`${ok ? " ✓" : " ✗"} ${name}`);
  if (!ok) process.exitCode = 1;
};

/* ── חול: עותק של brake.mjs + state/STASIS.json פיקטיבי לכל-וקטור ────────── */
const SANDBOXES = [];
function sandbox(stasisDoc) {
  const root = mkdtempSync(join(tmpdir(), "brake-selftest-"));
  SANDBOXES.push(root);
  mkdirSync(join(root, "grids", "state"), { recursive: true });
  const brakeSrc = join(HERE, "brake.mjs");
  // עותק-בתים-מילולי — אותו-קוד-בדיוק; STASIS_PATH נגזר מ-import.meta.url של העותק,
  // ולכן העותק קורא את קובץ-ה-STASIS.json של החול (המדינה-החיה לא נוגעת לעולם)
  writeFileSync(join(root, "grids", "brake.mjs"), readFileSync(brakeSrc, "utf8"));
  if (stasisDoc !== undefined) {
    if (stasisDoc === null) { /* leave missing */ }
    else if (typeof stasisDoc === "string") writeFileSync(join(root, "grids", "state", "STASIS.json"), stasisDoc);
    else writeFileSync(join(root, "grids", "state", "STASIS.json"), JSON.stringify(stasisDoc, null, 2));
  }
  return root;
}

async function loadWith(stasisDoc, captured) {
  const root = sandbox(stasisDoc); // החול נשאר-חי עד-סוף-הריצה — stasisHalt נקרא אחרי-ה-import
  const origLog = console.log;
  console.log = (...a) => { captured.lines.push(a.join(" ")); };
  try {
    const m = await import(join(root, "grids", "brake.mjs"));
    return m;
  } finally {
    console.log = origLog;
  }
}

const STAGED = (allow) => ({
  protocol: "SAOS-FATE-DEFENSE-STASIS/1", active: true, mode: "staged",
  reason: "selftest staged brake", since: "2026-10-05T00:00:00Z",
  stagedLanes: { allow, reason: "selftest", since: "2026-10-05T00:00:00Z" },
});

/* תפיסת-הקבלות בזמן-קריאת-השער עצמה (לא רק בזמן-ה-import) */
function withCapture(fn, captured) {
  const origLog = console.log;
  console.log = (...a) => { captured.lines.push(a.join(" ")); };
  try { return fn(); } finally { console.log = origLog; }
}

const captured = { lines: [] };

/* ── וקטורים ─────────────────────────────────────────────────────────────── */

// 1) מורשת: active=true בלי-mode → עצירה מלאה (התנהגות קודמת נשמרת)
let m = await loadWith({ protocol: "SAOS-FATE-DEFENSE-STASIS/1", active: true, reason: "full brake" }, captured);
t("legacy active=true (no mode) halts the grid signer", m.stasisHalt("mover") === true);

// 2) staged + מסילת-grid פתוחה → הסולם מותר, עם קבלת STASIS-STAGED-ALLOW
captured.lines.length = 0;
m = await loadWith(STAGED(["grid", "claims"]), captured);
let ok = withCapture(() => m.stasisHalt("mover") === false && m.stasisHalt("grid-beat:steem") === false && m.stasisHalt("grid-beat:hive") === false, captured);
t("staged + allowed lane (grid) lets the ladder machines sign", ok);
t("allow path prints the STASIS-STAGED-ALLOW receipt with the lane", captured.lines.some((l) => /STASIS-STAGED-ALLOW mover \(lane=grid\)/.test(l)));

// 3) staged + כלי-לא-מוכר → עצירה (fail-closed: אין-היכרות = אין-מסילה)
captured.lines.length = 0;
m = await loadWith(STAGED(["grid", "claims"]), captured);
ok = withCapture(() => m.stasisHalt("totally-unknown-tool") === true, captured) && captured.lines.some((l) => /STASIS-HALT\] totally-unknown-tool \(lane=general\)/.test(l));
t("staged + unknown tool halts on the general lane", ok);

// 4) staged + convert/agent-swap-api → עצירה (מסילה-כללית — נשארת-סגורה בכוונה)
m = await loadWith(STAGED(["grid", "claims"]), captured);
t("staged does NOT open convert (general lane)", m.stasisHalt("convert") === true);
t("staged does NOT open agent-swap-api (general lane)", m.stasisHalt("agent-swap-api") === true);

// 5) staged עם allow=['claims'] בלבד → הגריד נעצר (רק-המסילה-המפורסמת-פתוחה)
m = await loadWith(STAGED(["claims"]), captured);
t("staged with only claims in allow still halts the grid lane", m.stasisHalt("mover") === true);

// 6) active=true + mode=full → עצירה גם-למסילה-שנמצאת-ברשימה
m = await loadWith({ protocol: "SAOS-FATE-DEFENSE-STASIS/1", active: true, mode: "full", reason: "full brake", stagedLanes: { allow: ["grid"] } }, captured);
t("mode=full halts even a listed lane (master flag wins)", m.stasisHalt("mover") === true);

// 7) קובץ-לא-קריאable (JSON שבור) → עצירה fail-closed
m = await loadWith("{ this is not json", captured);
t("unreadable (corrupt) stasis file halts — fail-closed", m.stasisHalt("mover") === true);

// 8) קובץ-חסר → עצירה fail-closed
m = await loadWith(null, captured);
t("missing stasis file halts — fail-closed", m.stasisHalt("mover") === true);

// 9) פרוטוקול-זר → עצירה fail-closed (בלי-קשר-ל-mode)
m = await loadWith({ protocol: "SOMETHING-ELSE/9", active: false, mode: "staged", stagedLanes: { allow: ["grid"] } }, captured);
t("unknown protocol halts even with active=false + staged lanes", m.stasisHalt("mover") === true);

// 10) הדגל-הראשי active=false → מותר (תאימות-אחורה מלאה — ליפת-הבלם-המלאה)
m = await loadWith({ protocol: "SAOS-FATE-DEFENSE-STASIS/1", active: false, reason: "lifted" }, captured);
t("active=false still allows (full-lift backward compat)", m.stasisHalt("mover") === false && m.stasisHalt("convert") === false && m.stasisHalt("anything-new") === false);

// 11) laneOf — המיפוי-המפורש עצמו
m = await loadWith(STAGED(["grid"]), captured);
ok = m.laneOf("mover") === "grid" && m.laneOf("grid-beat:steem") === "grid" && m.laneOf("grid-beat:hive") === "grid"
  && m.laneOf("convert") === "general" && m.laneOf("agent-swap-api") === "general" && m.laneOf("") === "general" && m.laneOf(undefined) === "general";
t("laneOf maps ladder machines to grid, everything else to general", ok);

for (const s of SANDBOXES) rmSync(s, { recursive: true, force: true }); // ניקוי-החול בתום-הריצה
console.log(process.exitCode ? "brake-selftest: FAIL" : "brake-selftest: all vectors PASS");
