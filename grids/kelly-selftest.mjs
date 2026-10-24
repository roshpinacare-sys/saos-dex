#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// KELLY-SELFTEST — ברזל-אופליין למנוע-הקלי (SAOS-KELLY/1) · דוקטרינת "שום-טענה-בלי-מדידה"
// ───────────────────────────────────────────────────────────────────────────
// כיסוי (מוקטורים דטרמיניסטיים, אפס-רשת, אפס-תלות — node טהור):
//   1. kellyFraction(0.6, 1.5) — בדיקה-רציונלית-מדויקת: f* = 3/5 − (2/5)/(3/2) = 3/5 − 4/15 = 1/3
//   2. תוחלת-שלילית (p=0.4, b=1) → 0 — אף-פעם-לא-מגדילים-קצה-מפסיד
//   3. קצוות: p=1 · b→0 · b=∞ (נדחה-כנה) · p-זר → 0 fail-honest · אפס-עסקאות ב-estimate
//   4. רבע-קלי: מתמטיקת-החלקה + היצמדות לתקרת [0,1]
//   5. readFillStats על פנקס-fixture ב-/tmp: 3-נצחונות/2-הפסדים + רווחים ידועים
//      → p/b/wins/losses מדויקים, ספירת-שורות-פגומות כנה, מילויי-wash (selfCross)
//      נשללים-לעולם (LAW-P1 — pnl-audit: מילויי-צמד-עצמי אינם-ראיה)
//   6. recommendSizing מצמיד ל-policyCapBps כשהשבר-הגולמי חורג
//   7. INSUFFICIENT-DATA על פנקס-ריק/פגום/חסר — כנות-כישלון, אף-המצאה
//   8. סכימת-פלט SAOS-KELLY/1 — שדות-מדויקים
//   9. כתיבה-אטומית (tmp+rename) — לא-נשאר-קובץ-tmp
//  10. בריאות-הפנקס-החי (db/grid-ledger.json — עדות-ה-grid-beat): עקביות-ספירה
// ═══════════════════════════════════════════════════════════════════════════
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { fail++; const d = detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`; failures.push(name); console.log(`✗ ${name}${d}`); }
}
const near = (a, b, eps = 1e-9) => typeof a === "number" && Number.isFinite(a) && Math.abs(a - b) <= eps;

process.exitCode = 1; // fail-closed: רק-סוף-ירוק מנקה

const kelly = await import("./kelly.mjs");
const {
  KELLY_PROTOCOL, readFillStats, estimate, kellyFraction, fractionalKelly,
  recommendSizing, writeRecommendation, DEFAULT_LEDGER_PATHS,
} = kelly;

/* ── 1. מוקטור-קלי-קלאסי: f*(0.6, 1.5) = 1/3 (חישוב-יד-במבחן) ────────────── */
check("kellyFraction(0.6,1.5) = 1/3 exact rational",
  near(kellyFraction(0.6, 1.5), 1 / 3, 1e-12), kellyFraction(0.6, 1.5));

/* ── 2. תוחלת-שלילית → 0 ──────────────────────────────────────────────────── */
check("negative expectancy p=0.4 b=1 → 0", kellyFraction(0.4, 1) === 0, kellyFraction(0.4, 1));
check("break-even p=0.5 b=1 → 0", kellyFraction(0.5, 1) === 0);
const negEst = estimate({ wins: 2, losses: 3, avgWin: 0.02, avgLoss: 0.03 });
check("estimate negative-edge → ok + negative kelly clamps to 0",
  negEst.ok === true && negEst.p > 0 && negEst.b > 0
  && (negEst.p - (1 - negEst.p) / negEst.b) < 0 // התוחלת-הגולמית שלילית (מדידה-כנה)
  && kellyFraction(negEst.p, negEst.b) === 0, { est: negEst, raw: negEst.p - (1 - negEst.p) / negEst.b });

/* ── 3. קצוות ──────────────────────────────────────────────────────────────── */
check("p=1 edge: full Kelly = 1 (all-in per classic formula)", kellyFraction(1, 1.5) === 1);
check("p=0 edge → 0", kellyFraction(0, 1.5) === 0);
check("b→0 edge (degenerate payoff) → 0", kellyFraction(0.9, 0) === 0);
check("b=Infinity rejected fail-honest → 0", kellyFraction(0.9, Number.POSITIVE_INFINITY) === 0);
check("b negative → 0 (never size nonsense)", kellyFraction(0.9, -2) === 0);
check("p out of range (1.2) → 0 fail-honest", kellyFraction(1.2, 1.5) === 0);
check("p NaN → 0 fail-honest", kellyFraction(NaN, 1.5) === 0);
const zeroTrades = estimate({ wins: 0, losses: 0, avgWin: 0, avgLoss: 0 });
check("zero trades estimate → ok:false, p/b null (never invent)",
  zeroTrades.ok === false && zeroTrades.p === null && zeroTrades.b === null, zeroTrades);
const noLoss = estimate({ wins: 5, losses: 0, avgWin: 0.1, avgLoss: 0 });
check("zero avgLoss estimate → ok:false (b undefined — fail-honest, no ∞ sizing)",
  noLoss.ok === false && noLoss.p === null && noLoss.b === null, noLoss);

/* ── 4. רבע-קלי ────────────────────────────────────────────────────────────── */
check("fractionalKelly(1/3) quarter = 1/12", near(fractionalKelly(1 / 3), 1 / 12, 1e-12), fractionalKelly(1 / 3));
check("fractionalKelly(0.42, 0.5) = 0.21", near(fractionalKelly(0.42, 0.5), 0.21, 1e-12));
check("fractionalKelly clamp: (2, 0.25) → 0.5 (≤1)", fractionalKelly(2, 0.25) === 0.5);
check("fractionalKelly negative → 0", fractionalKelly(-0.3, 0.25) === 0);
check("fractionalKelly default quarter = 0.25", near(fractionalKelly(1), 0.25, 1e-12));

/* ── 5. fixture-פנקס ב-/tmp — JSON צורת-grid-ledger (מערך fills) ─────────── */
const TMP = join(realpathSync(tmpdir()), `kelly-selftest-${process.pid}-${Date.now()}`);
mkdirSync(TMP, { recursive: true });
// רווחים-ידועים-מראש (USD): +0.05 +0.03 +0.02 / −0.01 −0.02
// → wins=3, losses=2, p=3/5, avgWin=(0.1)/3, avgLoss=0.015, b=(0.1/3)/0.015=20/9, f*=3/5−(2/5)/(20/9)=3/5−9/50=21/50=0.42
const fixtureA = {
  version: 2,
  fills: [
    { key: "t1", at: "2026-01-01T00:00:00Z", side: "maker", direction: "sold-steem", paid: "1.000 SBD", received: "1 STEEM", paidUsd: 1.0, recvUsd: 1.05, edgeBps: 500, chain: "steem" },
    { key: "t2", at: "2026-01-01T00:01:00Z", side: "maker", direction: "sold-steem", paid: "1.000 SBD", received: "1 STEEM", paidUsd: 1.0, recvUsd: 1.03, edgeBps: 300, chain: "steem" },
    { key: "t3", at: "2026-01-01T00:02:00Z", side: "maker", direction: "sold-steem", paid: "1.000 SBD", received: "1 STEEM", paidUsd: 1.0, recvUsd: 1.02, edgeBps: 200, chain: "steem" },
    { key: "t4", at: "2026-01-01T00:03:00Z", side: "maker", direction: "bought-steem", paid: "1.000 SBD", received: "1 STEEM", paidUsd: 1.0, recvUsd: 0.99, edgeBps: -100, chain: "steem" },
    { key: "t5", at: "2026-01-01T00:04:00Z", side: "maker", direction: "bought-steem", paid: "1.000 SBD", received: "1 STEEM", paidUsd: 1.0, recvUsd: 0.98, edgeBps: -200, chain: "steem" },
    // מילוי-wash (selfCross) — לעולם לא ראיה (LAW-P1) — נספר כנה אך נשלל מהתוחלת
    { key: "w1", at: "2026-01-01T00:05:00Z", side: "maker", direction: "sold-steem", paid: "2.000 SBD", received: "2 STEEM", paidUsd: 2.0, recvUsd: 2.0, edgeBps: 0, chain: "steem", selfCross: true },
    // בלי נתוני-רווח — נספר כנה כ-noProfitFills
    { key: "x1", at: "2026-01-01T00:06:00Z", side: "maker", direction: "sold-steem", paid: "1.000 SBD", received: "1 STEEM", edgeBps: 10, chain: "steem" },
  ],
};
const pathA = join(TMP, "fixture-grid-ledger.json");
writeFileSync(pathA, JSON.stringify(fixtureA));
const statsA = readFillStats(pathA);
check("fixtureA verdict OK", statsA.verdict === "OK", statsA);
check("fixtureA rawFills=7 (counted honestly)", statsA.rawFills === 7, statsA.rawFills);
check("fixtureA washFills=1 (selfCross excluded per LAW-P1)", statsA.washFills === 1, statsA.washFills);
check("fixtureA noProfitFills=1", statsA.noProfitFills === 1, statsA.noProfitFills);
check("fixtureA wins=3 losses=2 trades=5", statsA.wins === 3 && statsA.losses === 2 && statsA.trades === 5, { w: statsA.wins, l: statsA.losses, t: statsA.trades });
check("fixtureA p=0.6 exact", near(statsA.p, 0.6, 1e-12), statsA.p);
check("fixtureA b=20/9 exact", near(statsA.b, 20 / 9, 1e-12), statsA.b);
check("fixtureA fullKelly = 21/50 = 0.42 exact", near(kellyFraction(statsA.p, statsA.b), 0.42, 1e-9), kellyFraction(statsA.p, statsA.b));
check("fixtureA sumProfitUsd = 0.07", near(statsA.sumProfitUsd, 0.07, 1e-9), statsA.sumProfitUsd);
check("fixtureA source documents file+field", typeof statsA.source?.file === "string" && statsA.source.file.includes("fixture-grid-ledger") && typeof statsA.source?.field === "string", statsA.source);

/* ── 5b. fixture-JSONL — שורות-פגומות נספרות-כנה ──────────────────────────── */
const pathB = join(TMP, "fixture-tape.jsonl");
writeFileSync(pathB, [
  JSON.stringify({ at: "t1", profit: 0.5 }),
  JSON.stringify({ at: "t2", profit: 0.3 }),
  "not-json-at-all{{{",
  JSON.stringify({ at: "t3", profit: -0.2 }),
  "", // שורה-ריקה — לא פגומה, לא נספרת
  JSON.stringify({ at: "t4" }), // בלי-רווח
].join("\n"));
const statsB = readFillStats(pathB);
check("fixtureB verdict OK", statsB.verdict === "OK", statsB);
check("fixtureB malformedLines=1 counted honestly", statsB.malformedLines === 1, statsB.malformedLines);
check("fixtureB wins=2 losses=1 trades=3", statsB.wins === 2 && statsB.losses === 1 && statsB.trades === 3, { w: statsB.wins, l: statsB.losses, t: statsB.trades });
check("fixtureB p=2/3, b=2 (profit-field extraction)", near(statsB.p, 2 / 3, 1e-12) && near(statsB.b, 2, 1e-9), { p: statsB.p, b: statsB.b });
check("fixtureB noProfitFills=1", statsB.noProfitFills === 1, statsB.noProfitFills);

/* ── 6. recommendSizing — היצמדות לתקרת-הפוליסה ───────────────────────────── */
const recOk = recommendSizing({ stats: statsA, policyCaps: { capBps: 10000 } });
// full=0.42 → quarter=0.105 → 1050bps
check("recOk verdict OK + fractionBps=1050 (quarter of 0.42)", recOk.verdict === "OK" && recOk.fractionBps === 1050, { v: recOk.verdict, f: recOk.fractionBps });
check("recOk fullKellyBps=4200", recOk.fullKellyBps === 4200, recOk.fullKellyBps);
const recClamp = recommendSizing({ stats: statsA, policyCaps: { capBps: 500 } });
check("recommendSizing clamps to policyCapBps=500 when raw 1050 exceeds", recClamp.verdict === "CLAMPED" && recClamp.fractionBps === 500, { v: recClamp.verdict, f: recClamp.fractionBps });
const recNoEdge = recommendSizing({ stats: { ...statsA, p: 0.414, b: 0.327 }, policyCaps: { capBps: 10000 } });
check("negative-edge stats → verdict NO-EDGE, fractionBps 0", recNoEdge.verdict === "NO-EDGE" && recNoEdge.fractionBps === 0, { v: recNoEdge.verdict, f: recNoEdge.fractionBps });
check("NO-EDGE keeps the honest negative fullKellyBps measurement", recNoEdge.fullKellyBps < 0, recNoEdge.fullKellyBps);

/* ── 7. INSUFFICIENT-DATA — פנקס-ריק/פגום/חסר ────────────────────────────── */
const pathEmptyFills = join(TMP, "empty-fills.json");
writeFileSync(pathEmptyFills, JSON.stringify({ version: 2, fills: [] }));
const statsEmpty = readFillStats(pathEmptyFills);
check("empty fills array → INSUFFICIENT-DATA", statsEmpty.verdict === "INSUFFICIENT-DATA", statsEmpty);
const pathCorrupt = join(TMP, "corrupt.json");
writeFileSync(pathCorrupt, "{not-valid-json");
const statsCorrupt = readFillStats(pathCorrupt);
check("corrupt JSON file → INSUFFICIENT-DATA (fail-honest)", statsCorrupt.verdict === "INSUFFICIENT-DATA", statsCorrupt);
const statsMissing = readFillStats(join(TMP, "does-not-exist.json"));
check("missing file → INSUFFICIENT-DATA (honest reason, no throw)", statsMissing.verdict === "INSUFFICIENT-DATA" && typeof statsMissing.reason === "string", statsMissing);
const recIns = recommendSizing({ stats: statsEmpty, policyCaps: { capBps: 10000 } });
check("recommendSizing on INSUFFICIENT-DATA stats → zero sizing, honest verdict",
  recIns.verdict === "INSUFFICIENT-DATA" && recIns.fractionBps === 0 && recIns.p === null && recIns.trades === 0, recIns);
const recNoStats = recommendSizing({ policyCaps: null });
check("recommendSizing with no stats at all → INSUFFICIENT-DATA (never invent)", recNoStats.verdict === "INSUFFICIENT-DATA" && recNoStats.fractionBps === 0);

/* ── 8. סכימת-פלט SAOS-KELLY/1 — שדות-מדויקים ────────────────────────────── */
const EXPECTED_KEYS = ["protocol", "verdict", "fractionBps", "fullKellyBps", "p", "b", "trades", "wins", "losses", "source", "measuredAt", "observability"].sort();
const recKeys = Object.keys(recOk).sort();
check("rec schema: exact SAOS-KELLY/1 top-level fields", JSON.stringify(recKeys) === JSON.stringify(EXPECTED_KEYS), recKeys);
check("rec protocol = SAOS-KELLY/1", recOk.protocol === KELLY_PROTOCOL && KELLY_PROTOCOL === "SAOS-KELLY/1", recOk.protocol);
check("rec observability declares observe-only enforcement (staged-enforcement doctrine)",
  typeof recOk.observability?.enforcement === "string" && recOk.observability.enforcement.includes("observe-only"), recOk.observability?.enforcement);
check("rec source carries file+field provenance", typeof recOk.source?.file === "string" && typeof recOk.source?.field === "string");
check("rec measuredAt is ISO-8601 parseable", !Number.isNaN(Date.parse(recOk.measuredAt)), recOk.measuredAt);
check("rec numbers: p,b finite; trades=wins+losses",
  Number.isFinite(recOk.p) && Number.isFinite(recOk.b) && recOk.trades === recOk.wins + recOk.losses);

/* ── 9. כתיבה-אטומית — tmp+rename, לא-נשאר-שרץ ───────────────────────────── */
const outDir = join(TMP, "out");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "kelly-sizing.json");
const writtenPath = writeRecommendation(recOk, outPath);
check("writeRecommendation returns dest and file parses back", writtenPath === outPath && JSON.parse(readFileSync(outPath, "utf8")).protocol === "SAOS-KELLY/1");
const leftovers = readdirSync(outDir).filter((f) => f.includes(".tmp-"));
check("atomic write leaves no tmp file behind", leftovers.length === 0, leftovers);
const recRe = JSON.parse(readFileSync(outPath, "utf8"));
check("round-trip preserves the measured numbers", recRe.fractionBps === recOk.fractionBps && recRe.trades === recOk.trades && recRe.p === recOk.p);

/* ── 10. בריאות-הפנקס-החי (מדידה-אמת — עדות-grid-beat) ───────────────────── */
const realLedger = DEFAULT_LEDGER_PATHS[0];
check("real fills ledger exists in repo (db/grid-ledger.json, git-tracked)", existsSync(realLedger), realLedger);
if (existsSync(realLedger)) {
  const real = readFillStats(realLedger);
  check("real ledger verdict OK (usable profit data)", real.verdict === "OK", real.verdict);
  check("real ledger material sample (≥100 determinate fills)", real.trades >= 100, real.trades);
  check("real ledger counts reconcile: raw = determinate + wash + noProfit + zero",
    real.rawFills === real.trades + real.washFills + real.noProfitFills + real.zeroProfitFills,
    { raw: real.rawFills, t: real.trades, wash: real.washFills, noP: real.noProfitFills, zero: real.zeroProfitFills });
  check("real ledger p in (0,1), b finite positive", real.p > 0 && real.p < 1 && real.b > 0, { p: real.p, b: real.b });
  const realRec = recommendSizing({ stats: real, policyCaps: { capBps: 10000 } });
  check("real rec: fractionBps clamped to [0,cap] and verdict sane",
    realRec.fractionBps >= 0 && realRec.fractionBps <= 10000 && ["NO-EDGE", "CLAMPED", "OK"].includes(realRec.verdict),
    { v: realRec.verdict, f: realRec.fractionBps });
}

/* ── ניקיון-וסיכום ────────────────────────────────────────────────────────── */
rmSync(TMP, { recursive: true, force: true });
console.log(`\nkelly-selftest: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log("kelly-selftest: FAIL");
  process.exitCode = 1;
} else {
  console.log("kelly-selftest: PASS");
  process.exitCode = 0;
}
