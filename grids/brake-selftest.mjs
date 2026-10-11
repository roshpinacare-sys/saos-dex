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
function sandbox(stasisDoc, guardsDoc) {
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
  if (guardsDoc !== undefined) {
    if (guardsDoc === null) { /* leave missing */ }
    else if (typeof guardsDoc === "string") writeFileSync(join(root, "grids", "state", "lane-guards.json"), guardsDoc);
    else writeFileSync(join(root, "grids", "state", "lane-guards.json"), JSON.stringify(guardsDoc, null, 2));
  }
  return root;
}

async function loadWith(stasisDoc, captured, guardsDoc) {
  const root = sandbox(stasisDoc, guardsDoc); // החול נשאר-חי עד-סוף-הריצה — stasisHalt נקרא אחרי-ה-import
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

// 2-b) 9-c (2026-10-11): liquidity-bootstrap — מסילת-בת של lane=grid (חותם limit_order_create בלבד)
captured.lines.length = 0;
m = await loadWith(STAGED(["grid", "claims"]), captured);
ok = withCapture(() => m.stasisHalt("liquidity-bootstrap") === false, captured);
t("staged + grid lane opens the liquidity-bootstrap sub-lane", ok);
t("liquidity-bootstrap gets the STASIS-STAGED-ALLOW receipt on lane=grid", captured.lines.some((l) => /STASIS-STAGED-ALLOW liquidity-bootstrap \(lane=grid\)/.test(l)));
m = await loadWith(STAGED(["claims"]), captured);
t("staged WITHOUT grid still halts liquidity-bootstrap (fail-closed)", m.stasisHalt("liquidity-bootstrap") === true);

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

// 11-b) zai-audit 2026-10-11 · מסילת delegations — הכלי delegator ממופה למסילה משלו;
// סגורה כברירת-מחדל (staged עם grid בלבד), נפתחת רק כשה-STASIS עצמו מרשה.
m = await loadWith(STAGED(["grid"]), captured);
ok = m.laneOf("delegator") === "delegations" && m.stasisHalt("delegator") === true;
t("staged + delegations NOT in allow → delegator halts on its own lane", ok);
m = await loadWith(STAGED(["grid", "delegations"]), captured);
ok = m.stasisHalt("delegator") === false;
t("staged + delegations allowed → delegator flows (fail-closed still binds unknown tools)", ok);

for (const s of SANDBOXES) rmSync(s, { recursive: true, force: true }); // ניקוי-החול בתום-הריצה
console.log(process.exitCode ? "brake-selftest: FAIL" : "brake-selftest: all vectors PASS");

/* ── LANE-GUARDS vectors (SAOS-LANE-GUARDS/1 — cognition-beat 1a10c90522120149) ── */
{
  const cap = { lines: [] };
  const staged = { protocol: "SAOS-FATE-DEFENSE-STASIS/1", active: true, mode: "staged", since: "2026-10-05T13:05:00Z", stagedLanes: { allow: ["grid"] }, reason: "staged test" };
  let m = await loadWith(staged, cap, { protocol: "SAOS-LANE-GUARDS/1", guards: [{ id: "g1", lane: "grid", closed: true, reason: "unknown-writer ttl=12h", openedAt: "2026-10-05T16:42:08Z", expiresAt: "2027-01-01T00:00:00Z" }] });
  t("guard closes staged-allowed grid lane", m.stasisHalt("grid-beat:steem") === true);
  m = await loadWith(staged, cap, { protocol: "SAOS-LANE-GUARDS/1", guards: [{ id: "g2", lane: "grid", closed: false, open: true, reason: "forged-open" }] });
  t("guard open-attempt ignored → staged allow stands", m.stasisHalt("grid-beat:steem") === false);
  m = await loadWith(staged, cap, "{ GARBAGE {{{");
  t("corrupt guards file → fail-closed halt", m.stasisHalt("grid-beat:steem") === true);
  m = await loadWith(staged, cap, { protocol: "FOREIGN/9", guards: [] });
  t("foreign guards protocol → fail-closed halt", m.stasisHalt("grid-beat:steem") === true);
  m = await loadWith(staged, cap, { protocol: "SAOS-LANE-GUARDS/1", guards: [{ id: "g3", lane: "grid", closed: true, reason: "expired", expiresAt: "2020-01-01T00:00:00Z" }] });
  t("expired guard is inert → staged allow stands", m.stasisHalt("grid-beat:steem") === false);
  m = await loadWith(staged, cap, null);
  t("missing guards file → staged baseline unchanged (allow)", m.stasisHalt("grid-beat:steem") === false);
  m = await loadWith({ protocol: "SAOS-FATE-DEFENSE-STASIS/1", active: true, mode: "full", since: "2026-10-04T22:18:00Z", reason: "full" }, cap, { protocol: "SAOS-LANE-GUARDS/1", guards: [{ id: "g4", lane: "grid", closed: false, open: true }] });
  t("guard cannot open a full-STASIS home", m.stasisHalt("grid-beat:steem") === true);
}
