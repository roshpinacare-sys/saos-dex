// PARAMS-SELFTEST — וקטורים דטרמיניסטיים אופליין לשומר-סף-הפרמטרים (9-c)
//   node grids/params-selftest.mjs → אפס-רשת, אפס-מפתחות, אפס-כתיבה
// החוק: פרמטרים-רעים לעולם לא מדורגים לספר — כל-וקטור כאן הוא ניסיון-הברחה
// שחייב להיתקע בשומר (fail-closed), והפרופוזיציה-החיה חייבת לעבור בכבוד.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateParams } from "./validate-params.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const t = (name, ok) => {
  console.log(`${ok ? " ✓" : " ✗"} ${name}`);
  if (ok) pass++; else { fail++; process.exitCode = 1; }
};

const GOOD = {
  protocol: "SAOS-GRID-PARAMS/1",
  sealedAt: "2026-10-11T16:55:00Z",
  steem: { commitPct: 0.85, minKeepSteem: 0.5, minLevelSteem: 1.0, minLevelSbd: 0.05, bidLevels: 3, bidStepBps: 150, askLevels: 3, askStepBps: 80, parityBandBps: 5000, expiryDays: 27 },
  hive: { commitPct: 0.9, minKeepHive: 0.005, minLevelHive: 0.010, minLevelHbd: 0.001, askMinRecvHbd: 0.2, bidLevels: 3, bidStepBps: 200, askLevels: 3, askStepBps: 50, parityBandBps: 5000, expiryDays: 27 },
};
const clone = (o) => JSON.parse(JSON.stringify(o));

/* 1) הפרופוזיציה-החיה על-הדיסק חייבת לעבור (הקובץ-שהמנוע קורא) */
for (const [label, p] of [["grids/state/grid-params.json", join(HERE, "state", "grid-params.json")], ["grids/param-proposal-2026-10-11.json", join(HERE, "param-proposal-2026-10-11.json")]]) {
  if (!existsSync(p)) { t(`${label} exists on disk to validate`, false); continue; }
  let doc = null;
  try { doc = JSON.parse(readFileSync(p, "utf8")); } catch { /* refused below */ }
  const r = validateParams(doc);
  t(`${label} validates against the rails (${r.errors.length} errors)`, r.ok === true);
}

/* 2) מסמך-תקין מינימלי עובר */
t("minimal valid doc passes", validateParams(GOOD).ok === true);

/* 3) commitPct 0.99 — הברחת-התחייבות-מלאה → נדחה */
{
  const d = clone(GOOD); d.steem.commitPct = 0.99;
  t("commitPct 0.99 refused (rail ≤ 0.95)", validateParams(d).ok === false);
}
/* 4) commitPct שלילי/לא-מספר → נדחה */
{
  const d = clone(GOOD); d.hive.commitPct = "0.9";
  t("commitPct as string refused (type law)", validateParams(d).ok === false);
}
/* 5) levels=12 — שריפת-RC → נדחה */
{
  const d = clone(GOOD); d.steem.askLevels = 12;
  t("askLevels 12 refused (rail ≤ 6)", validateParams(d).ok === false);
}
/* 6) bidStepBps=1 — ספאם-תור/הצלבה-עצמית → נדחה */
{
  const d = clone(GOOD); d.steem.bidStepBps = 1;
  t("bidStepBps 1 refused (min spread floor 25bps)", validateParams(d).ok === false);
}
/* 7) askMinRecvHbd=0.05 — עיוות-מיל מעל 0.5% (חוק R99) → נדחה */
{
  const d = clone(GOOD); d.hive.askMinRecvHbd = 0.05;
  t("hive.askMinRecvHbd 0.05 refused (R99 price-fidelity law ≥ 0.2)", validateParams(d).ok === false);
}
/* 8) parityBandBps=100 — רצועה שמכבה את הספר → נדחה */
{
  const d = clone(GOOD); d.steem.parityBandBps = 100;
  t("parityBandBps 100 refused (rail [1000, 10000])", validateParams(d).ok === false);
}
/* 9) expiryDays=90 — מעבר לתקרת-STEEM → נדחה */
{
  const d = clone(GOOD); d.hive.expiryDays = 90;
  t("expiryDays 90 refused (STEEM ceiling 27)", validateParams(d).ok === false);
}
/* 10) שדה-זר בשרשרת — הברחת-התנהגות → נדחה */
{
  const d = clone(GOOD); d.steem.selfCross = true;
  t("foreign field steem.selfCross refused (unknown fields never deploy)", validateParams(d).ok === false);
}
/* 11) פרוטוקול-זר → נדחה */
{
  const d = clone(GOOD); d.protocol = "SAOS-GRID-PARAMS/2-better";
  t("foreign protocol refused", validateParams(d).ok === false);
}
/* 12) חצי-שרשרת חסרה → נדחה (fail-closed, לא ברירת-מחדל שקטה) */
{
  const d = clone(GOOD); delete d.hive;
  t("missing hive section refused (no silent defaults)", validateParams(d).ok === false);
}
/* 13) null / מחרוזת / מערך → נדחה */
t("null doc refused", validateParams(null).ok === false);
t("string doc refused", validateParams("pwn").ok === false);
t("array doc refused", validateParams([GOOD]).ok === false);
/* 14) NaN/Infinity → נדחה */
{
  const d = clone(GOOD); d.steem.commitPct = Infinity;
  t("commitPct Infinity refused (finite law)", validateParams(d).ok === false);
}
/* 15) rationale מתועד-אך-לא-מכונה: מותר כמחרוזות, נדחה כמבנה-זר */
{
  const d = clone(GOOD); d.rationale = { note: "measured drift 11bps/day" };
  t("rationale as string map accepted (documentation only)", validateParams(d).ok === true);
  const d2 = clone(GOOD); d2.rationale = [{ smuggled: true }];
  t("rationale as array refused", validateParams(d2).ok === false);
}
/* 16) השומר לא מעוות מסמך-תקין: הפרמטרים-שיוצאים זהים לשהוכנסו */
{
  const r = validateParams(GOOD);
  t("validated params round-trip intact", r.ok && r.params.steem.bidStepBps === 150 && r.params.hive.askMinRecvHbd === 0.2 && r.params.steem.commitPct === 0.85);
}

console.log(`\nparams-selftest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
