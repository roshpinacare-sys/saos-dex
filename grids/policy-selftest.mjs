// POLICY-ENGINE SELFTEST — מוכיח את חוקי SAOS-POLICY-ENGINE/1 על מדינה-מבודדת (tmp)
// ════════════════════════════════════════════════════════════════════════════════════════
// הדוקטרינה: fail-closed לכל-אורך השרשרת (קובץ-חסר/פגום/זר = HALT), תקרות-הון,
// מגבלות-קצב מה-ledger, שער-הבעלים (policy-arm), ומצב-observe שמודד-ולא-עוצר.
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0, failed = 0;
const t = (name, ok) => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}`); }
};

const m = await import("./policy.mjs");

const tmp = mkdtempSync(join(tmpdir(), "saos-policy-selftest-"));
const stateDir = join(tmp, "state");
mkdirSync(stateDir, { recursive: true });
m.setPaths(stateDir);

const writePolicy = (obj) => writeFileSync(join(stateDir, "policy.json"), typeof obj === "string" ? obj : JSON.stringify(obj, null, 1));
const writeArm = (obj) => writeFileSync(join(stateDir, "policy-arm.json"), typeof obj === "string" ? obj : JSON.stringify(obj, null, 1));

const validPolicy = {
  protocol: "SAOS-POLICY-ENGINE/1",
  mode: "enforce",
  rateMode: "enforce",
  lanes: {
    grid: { kinds: ["grid_cycle_refresh", "limit_order_create", "limit_order_cancel"], maxNotionalPerOpSbd: 25, maxCycleNotionalSbd: 120, maxOpsPerCycle: 96, maxOpsPerHour: 400 },
    general: { kinds: ["convert", "agent_swap"], maxNotionalPerOpSbd: 25, maxCycleNotionalSbd: 120, maxOpsPerCycle: 24, maxOpsPerHour: 48 },
  },
  ownerGate: { notionalSbd: 100 },
};

const cycleIntent = (over = {}) => ({ tool: "grid-beat:steem", lane: "grid", kind: "grid_cycle_refresh", account: "headcorner", opsEst: 12, notionalSbd: 12, ...over });
const opIntent = (over = {}) => ({ tool: "mover", lane: "grid", kind: "limit_order_create", account: "headcorner", amount: 3, price: 0.104, notionalSbd: 0.312, ...over });

console.log("═ POLICY-ENGINE SELFTEST — fail-closed first ═");

/* 1. קובץ-חסר = HALT */
t("missing policy file halts", m.policyGate(cycleIntent()).allow === false);
t("missing policy file = fail-closed reason", m.policyGate(cycleIntent()).reasons[0].includes("fail-closed"));

/* 2. קובץ-פגום = HALT */
writePolicy("{ this is not json");
t("corrupt policy file halts", m.policyGate(cycleIntent()).allow === false);

/* 3. פרוטוקול-זר = HALT */
writePolicy({ protocol: "SOME-OTHER/9", lanes: {} });
t("foreign policy protocol halts", m.policyGate(cycleIntent()).allow === false);

/* 4. פוליסה-תקינה + כוונה-תקינה = ALLOW */
writePolicy(validPolicy);
t("valid cycle intent under caps = ALLOW", m.policyCycleGate({ tool: "grid-beat:steem", account: "headcorner", opsEst: 12, notionalSbdUpper: 12 }).allow === true);
t("valid per-op intent = ALLOW", m.policyGate(opIntent()).allow === true);

/* 5. תקרת-הוצאה לכל-פעולה */
t("per-op above cap halts", m.policyGate(opIntent({ notionalSbd: 30, amount: 30, price: 1 })).allow === false);
t("per-op exactly at cap allows", m.policyGate(opIntent({ notionalSbd: 25, amount: 25, price: 1 })).allow === true);

/* 6. תקרת-מחזור */
t("cycle notional above cap halts", m.policyCycleGate({ tool: "grid-beat:steem", account: "headcorner", opsEst: 12, notionalSbdUpper: 121 }).allow === false);
t("cycle ops above cap halts", m.policyCycleGate({ tool: "grid-beat:steem", account: "headcorner", opsEst: 97, notionalSbdUpper: 12 }).allow === false);

/* 7. שער-הבעלים — בלי-arm = HALT, עם-arm = ALLOW
 * (lane-עליות-מיוחד: תקרת-פעולה 200 מעל-שער-הבעלים 100, כדי לבדוק את שער-הבעלים בנפרד —
 *  ברירת-המחדל של ה-grid תקרת-הפעולה 25 נוקשת ממנו ונכנסת-קודם = הגנה-לעומק) */
writePolicy({ ...validPolicy, lanes: { ...validPolicy.lanes, grid: { ...validPolicy.lanes.grid, maxNotionalPerOpSbd: 200, maxCycleNotionalSbd: 200 } } });
t("op above owner-gate without arm halts", m.policyGate(opIntent({ notionalSbd: 150, amount: 150, price: 1 })).allow === false);
t("owner-gate reason mentions arm file", m.policyGate(opIntent({ notionalSbd: 150, amount: 150, price: 1 })).reasons.join(" ").includes("SAOS-POLICY-ARM/1"));
writeArm({ protocol: "SAOS-POLICY-ARM/1", armed: true });
t("op above owner-gate WITH valid arm allows", m.policyGate(opIntent({ notionalSbd: 150, amount: 150, price: 1 })).allow === true);
writeArm({ protocol: "SAOS-POLICY-ARM/1", armed: false });
t("arm file present but armed=false → still halts", m.policyGate(opIntent({ notionalSbd: 150, amount: 150, price: 1 })).allow === false);
writeArm("{ corrupt");
t("corrupt arm file = closed (fail-closed)", m.policyGate(opIntent({ notionalSbd: 150, amount: 150, price: 1 })).allow === false);
rmSync(join(stateDir, "policy-arm.json"));
writePolicy(validPolicy);

/* 8. מסילה-זרה + סוג-פעולה-זר */
t("unknown lane halts (fail-closed)", m.policyGate(opIntent({ lane: "mystery" })).allow === false);
t("kind not in lane allowlist halts", m.policyGate(opIntent({ kind: "drain_treasury" })).allow === false);

/* 9. סכמת-כוונה פגומה */
t("negative amount halts (schema)", m.policyGate(opIntent({ amount: -5, notionalSbd: -5 })).allow === false);
t("non-finite notional halts (schema)", m.policyGate(opIntent({ notionalSbd: Number.NaN })).allow === false);
t("missing tool halts (schema)", m.policyGate({ lane: "grid", kind: "limit_order_create", account: "headcorner" }).allow === false);
t("zero price halts (schema)", m.policyGate(opIntent({ price: 0 })).allow === false);

/* 10. מגבלת-קצב מה-ledger (enforce) — ה-ledger כבר נושא ALLOW-ים מהבדיקות לעיל */
const ledgerBefore = m.readLedger().filter((e) => e.verdict === "ALLOW").length;
t("ledger accumulated verdicts (receipts live)", ledgerBefore > 0);
for (let i = 0; i < 400; i++) {
  const r = m.policyGate(opIntent({ notionalSbd: 0.001, amount: 0.001, price: 1 }));
  if (!r.allow) { break; }
}
t("rate cap trips from ledger receipts (enforce)", m.policyGate(opIntent({ notionalSbd: 0.001, amount: 0.001, price: 1 })).allow === false);
t("rate halt reason mentions rate", m.policyGate(opIntent({ notionalSbd: 0.001, amount: 0.001, price: 1 })).reasons.join(" ").includes("rate"));

/* 11. observe — מודד ולא עוצר */
writePolicy({ ...validPolicy, rateMode: "observe" });
m.setPaths(join(tmp, "state2"));
mkdirSync(join(tmp, "state2"), { recursive: true });
writeFileSync(join(tmp, "state2", "policy.json"), JSON.stringify({ ...validPolicy, rateMode: "observe" }));
t("rateMode=observe allows despite rate", m.policyGate(opIntent({ notionalSbd: 0.001, amount: 0.001, price: 1 })).allow === true);
t("observe still enforces per-op caps", m.policyGate(opIntent({ notionalSbd: 30, amount: 30, price: 1 })).allow === false);

/* 12. HALT לא נספר בקצב (רק ALLOW-ים) */
const halts = m.readLedger().filter((e) => e.verdict === "HALT").length;
t("HALT verdicts recorded in ledger (receipts)", halts > 0);
const verdictsHaveEngine = m.readLedger().every((e) => typeof e.engine === "string" && e.engine.includes("policy-engine"));
t("every verdict carries engine receipt", verdictsHaveEngine);

/* 13. ה-ledger append-only — אין-קובץ-policy-arm שנוצר סתם */
t("no accidental arm file created", !m.ownerArmOk());

/* ══ R329 §14 — תיבת-ההילוכים (SAOS-POLICY-GEARS/1): הכביש-הסלול ══ */
// isolated state3: policy + gears table; the receipt IS the upshift.
const state3 = join(tmp, "state3");
mkdirSync(state3, { recursive: true });
m.setPaths(state3);
writeFileSync(join(state3, "policy.json"), JSON.stringify(validPolicy));
const writeGears = (obj) => writeFileSync(join(state3, "policy-gears.json"), typeof obj === "string" ? obj : JSON.stringify(obj, null, 1));
const gearsTable = (state) => ({
  protocol: "SAOS-POLICY-GEARS/1",
  gears: [
    { gear: 1, require: { greenStreak: 0 },  laneOverrides: { grid: { maxNotionalPerOpSbd: 25,  maxCycleNotionalSbd: 120 } } },
    { gear: 2, require: { greenStreak: 3 },  laneOverrides: { grid: { maxNotionalPerOpSbd: 50,  maxCycleNotionalSbd: 240 } } },
    { gear: 3, require: { greenStreak: 6 },  laneOverrides: { grid: { maxNotionalPerOpSbd: 100, maxCycleNotionalSbd: 480 } } },
  ],
  state: state ?? { gear: 1, greenStreak: 0, lastVerdict: null, lastKind: null, history: [] },
});
const gridIntent = (notionalSbd) => ({ tool: "t", lane: "grid", kind: "limit_order_create", account: "a", notionalSbd, amount: notionalSbd, price: 1 });

/* 14.1 fail-closed: no gear file = gear 1, static caps bind */
t("gears fail-closed (missing file → gear 1)", m.currentGear().gear === 1 && m.currentGear().why !== null);
t("missing gears = static caps bind (30 SBD blocked)", m.policyGate(gridIntent(30)).allow === false);

/* 14.2 valid table, gear 1: caps unchanged */
writeGears(gearsTable());
t("gear1 baseline: 30 SBD blocked", m.policyGate(gridIntent(30)).allow === false);
t("gear1 baseline: 20 SBD allowed", m.policyGate(gridIntent(20)).allow === true);

/* 14.3 the receipt IS the upshift — slow up, instant down */
m.recordLadderReceipt("treasury", "LADDER-ACTED");
m.recordLadderReceipt("army", "ARMY-ACTED");
m.recordLadderReceipt("treasury", "LADDER-ACTED");
t("3 green receipts → streak 3, gear 2", m.currentGear().gear === 2 && m.currentGear().greenStreak === 3);
t("gear2 re-prices caps: 30 SBD now allowed, 60 blocked", m.policyGate(gridIntent(30)).allow === true && m.policyGate(gridIntent(60)).allow === false);

/* 14.4 red receipt = instant downshift to gear 1 + streak reset */
m.recordLadderReceipt("army", "ARMY-ACTS-FAILED");
t("red receipt → gear 1, streak 0", m.currentGear().gear === 1 && m.currentGear().greenStreak === 0);
t("downshift restores conservative caps: 30 blocked again", m.policyGate(gridIntent(30)).allow === false);

/* 14.5 neutral verdicts neither grow nor reset */
m.recordLadderReceipt("treasury", "LADDER-ACTED"); // streak 1
m.recordLadderReceipt("treasury", "LADDER-AT-TARGET");
t("neutral verdict keeps streak", m.currentGear().greenStreak === 1);
m.recordLadderReceipt("treasury", "KEYLESS-STASIS");
t("stasis verdict keeps streak", m.currentGear().greenStreak === 1);

/* 14.6 foreign protocol = inert gearbox (gear 1), road continues */
writeGears({ protocol: "OTHER/1", gears: [], state: { gear: 3 } });
t("foreign gears protocol → fail-closed gear 1", m.currentGear().gear === 1 && m.currentGear().why !== null);
t("inert gearbox = static caps bind", m.policyGate(gridIntent(30)).allow === false);

/* 14.7 ownerGate untouched at top gear: 100 SBD needs no arm (== gate), 120 needs arm */
writeGears(gearsTable({ gear: 3, greenStreak: 6, lastVerdict: "LADDER-ACTED", lastKind: "treasury", history: [] }));
t("gear3 reachable from state", m.currentGear().gear === 3);
t("gear3: 100 SBD allowed (top gear tops out AT owner gate)", m.policyGate(gridIntent(100)).allow === true);
t("gear3: 120 SBD still needs owner arm (gate intact)", m.policyGate(gridIntent(120)).allow === false && m.policyGate(gridIntent(120)).reasons.join(" ").includes("owner-gate"));

/* 14.8 malformed table = fail-closed */
writeGears({ protocol: "SAOS-POLICY-GEARS/1", gears: "garbage", state: {} });
t("malformed gear table → gear 1", m.currentGear().gear === 1);

/* ══ R330 §15 — מסנן-הקלי (SAOS-KELLY-CAP/1, DECISIONS #18): תוחלת-ממומשת מתמחרת-את-המהירות ══ */
// isolated state4: policy + gears table WITH kelly; beats come from synthetic git-format receipts.
const { performanceCap, calculatePerformanceCap, kellyStats, extractBeats, resetKellyCache } = await import("./alpha-performance-math.mjs");
const state4 = join(tmp, "state4");
mkdirSync(state4, { recursive: true });
m.setPaths(state4);
writeFileSync(join(state4, "policy.json"), JSON.stringify(validPolicy));
const writeGears4 = (state, kelly) => writeFileSync(join(state4, "policy-gears.json"), JSON.stringify({
  protocol: "SAOS-POLICY-GEARS/1",
  gears: [
    { gear: 1, require: { greenStreak: 0 },  laneOverrides: { grid: { maxNotionalPerOpSbd: 25,  maxCycleNotionalSbd: 120 } } },
    { gear: 2, require: { greenStreak: 6 },  laneOverrides: { grid: { maxNotionalPerOpSbd: 50,  maxCycleNotionalSbd: 240 } } },
    { gear: 3, require: { greenStreak: 12 }, laneOverrides: { grid: { maxNotionalPerOpSbd: 100, maxCycleNotionalSbd: 480 } } },
  ],
  ...(kelly === undefined ? {} : { kelly }),
  state: state ?? { gear: 1, greenStreak: 0, lastVerdict: null, lastKind: null, history: [] },
}, null, 1));
const writeReceipts = (name, lines) => { writeFileSync(join(state4, name), lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : "")); resetKellyCache(); };

const kellyOn = {
  enabled: true, receipts: ["t.jsonl", "a.jsonl"],
  minBeats: 10, probationFactor: 0.5, halfKelly: 0.5, maxFraction: 0.25, minFraction: 0.01, scale: 4, fallbackCapSbd: 25, epsSbd: 0.000001,
};
// treasury-format receipt (single trader) / army-format receipt (results roster)
const tRec = (at, sbd) => ({ schema: "SAOS-TREASURY-LADDER-RECEIPT/1", at, trader: "hcsoldier4", traderSbd: sbd, verdict: "LADDER-ACTED" });
const aRec = (at, roster) => ({ schema: "SAOS-ARMY-LADDER-RECEIPT/1", at, results: roster.map(([account, sbd]) => ({ account, state: "ACTED", traderSbd: sbd })), verdict: "ARMY-ACTED" });

/* 15.1 kelly block missing from table = inert throttle (table caps stand) */
writeGears4(undefined, undefined);
writeReceipts("t.jsonl", []); writeReceipts("a.jsonl", []);
t("kelly missing = inert: gear1 caps unchanged (20 allowed)", m.policyGate(gridIntent(20)).allow === true);
t("kelly missing = inert: 30 still blocked by table", m.policyGate(gridIntent(30)).allow === false);
t("kelly missing = currentGear reports no kelly", m.currentGear().kelly === null);

/* 15.2 disabled kelly = inert */
writeGears4(undefined, { ...kellyOn, enabled: false });
t("kelly disabled = inert", m.policyGate(gridIntent(20)).allow === true && m.currentGear().kelly === null);

/* 15.3 no receipts at all = probation (no data = measured suspicion, half cap) */
writeGears4(undefined, kellyOn);
t("no receipts → probation: gear1 25→12 (20 blocked)", m.policyGate(gridIntent(20)).allow === false);
t("no receipts → probation: small intents still flow (10 allowed)", m.policyGate(gridIntent(10)).allow === true);
t("probation halt carries kelly-cap note", m.policyGate(gridIntent(20)).reasons.join(" ").includes("kelly-cap"));
t("currentGear reports probation", m.currentGear().kelly?.mode === "probation");

/* 15.4 probation at gear 2: 50 → 25 */
writeGears4({ gear: 2, greenStreak: 6, lastVerdict: "LADDER-ACTED", lastKind: "treasury", history: [] }, kellyOn);
t("probation gear2: 30 blocked (25 cap)", m.policyGate(gridIntent(30)).allow === false);
t("probation gear2: cycle re-priced too (cycle 240→120: intent 200 blocked)", m.policyCycleGate({ tool: "t", account: "a", opsEst: 5, notionalSbdUpper: 200 }).allow === false);

/* 15.5 young sample < minBeats = probation even with rising SBD */
writeReceipts("t.jsonl", [tRec("2026-10-14T01:00:00Z", 0.05), tRec("2026-10-14T02:00:00Z", 0.08), tRec("2026-10-14T03:00:00Z", 0.12)]);
t("3 informative beats < 10 = probation (30 blocked at gear2)", m.policyGate(gridIntent(30)).allow === false);

/* 15.6 full sample, perfect expectancy = exactly the table cap, never above (winRate=1 → safe=0.25 → ×4=1.0) */
const rising = Array.from({ length: 12 }, (_, i) => tRec(new Date(Date.parse("2026-10-14T00:00:00Z") + (i + 1) * 3600_000).toISOString(), (0.05 + i * 0.01).toFixed(3) * 1));
writeReceipts("t.jsonl", rising);
t("12 rising fills → kelly full cap: 30 allowed at gear2", m.policyGate(gridIntent(30)).allow === true);
t("kelly never exceeds the table (60 blocked at gear2)", m.policyGate(gridIntent(60)).allow === false);
t("kelly mode reported by currentGear", m.currentGear().kelly?.mode === "kelly" && m.currentGear().kelly?.cap === 50);

/* 15.7 mediocre expectancy throttles: 6 wins +0.01 / 4 losses -0.01 → winRate 0.6, WLR 1, kelly 0.2, safe 0.1 → cap 50×0.4=20 */
const mixed = [];
for (let i = 0; i < 7; i++) mixed.push(tRec(new Date(Date.parse("2026-10-14T00:00:00Z") + (i + 1) * 3600_000).toISOString(), 0.05 + (i + 1) * 0.01));
for (let i = 0; i < 4; i++) mixed.push(tRec(new Date(Date.parse("2026-10-14T09:00:00Z") + (i + 1) * 3600_000).toISOString(), 0.12 - (i + 1) * 0.01));
writeReceipts("t.jsonl", mixed);
t("mediocre expectancy: 30 blocked (cap 20)", m.policyGate(gridIntent(30)).allow === false);
t("mediocre expectancy: 15 allowed", m.policyGate(gridIntent(15)).allow === true);
const mixedStats = kellyStats(extractBeats([join(state4, "t.jsonl")]).beats, kellyOn);
t("mediocre stats honest: winRate=0.6 sampled=true", mixedStats.sampled === true && Math.abs(mixedStats.winRate - 0.6) < 1e-9 && mixedStats.totalBeats === 10);

/* 15.8 all-loss sample → negative kelly → floor shadow (safe=0.01 → cap 50×0.04=2; canary legs flow, exposure dies) */
const falling = Array.from({ length: 11 }, (_, i) => tRec(new Date(Date.parse("2026-10-14T00:00:00Z") + (i + 1) * 3600_000).toISOString(), 0.5 - (i + 1) * 0.03));
writeReceipts("t.jsonl", falling);
t("all-loss: 5 blocked", m.policyGate(gridIntent(5)).allow === false);
t("all-loss: 1 SBD allowed (maker alive to measure recovery)", m.policyGate(gridIntent(1)).allow === true);

/* 15.9 idle beats (no fill) excluded from the sample, counted in total */
const idle = rising.concat(Array.from({ length: 15 }, (_, i) => tRec(new Date(Date.parse("2026-10-14T13:00:00Z") + (i + 1) * 60_000).toISOString(), (0.05 + 11 * 0.01).toFixed(3) * 1)));
writeReceipts("t.jsonl", idle);
t("idle beats excluded: still full cap (30 allowed)", m.policyGate(gridIntent(30)).allow === true);
const idleExt = extractBeats([join(state4, "t.jsonl")]);
t("idle beats counted in total, not in informative", idleExt.beats.length === 26 && idleExt.informative === 11);

/* 15.10 army-format roster receipts feed per-account beats too */
writeReceipts("t.jsonl", rising);
const armySeries = [];
for (let i = 0; i < 11; i++) armySeries.push(aRec(new Date(Date.parse("2026-10-14T00:00:00Z") + (i + 1) * 1800_000).toISOString(), [["israelnews", 0.12 + i * 0.005], ["static-acct", 0.156]]));
writeReceipts("a.jsonl", armySeries);
t("army roster beats merge into the sample (30 allowed)", m.policyGate(gridIntent(30)).allow === true);
const merged = extractBeats([join(state4, "t.jsonl"), join(state4, "a.jsonl")]);
t("merged beats: treasury 11 + army israelnews 10 (static excluded from informative)", merged.beats.length >= 21 && merged.informative === 21);

/* 15.11 corrupt receipt lines are skipped honestly (probation, not crash) */
writeFileSync(join(state4, "t.jsonl"), "{ torn line\nnot json at all\n");
writeReceipts("a.jsonl", []);
resetKellyCache();
t("corrupt receipts → probation (30 blocked at gear2)", m.policyGate(gridIntent(30)).allow === false);

/* 15.12 metrics-fault mode: malformed paths → floor min(base, 25) */
const fault = performanceCap({ baseGearCap: 50, receiptPaths: "not-an-array" });
t("metrics-fault: mode=fault, cap=min(50,25)=25", fault.mode === "metrics-fault" && fault.cap === 25);
t("calculatePerformanceCap parity: fault path returns 25", calculatePerformanceCap("/nonexistent/path.jsonl", 100) === 25);
t("calculatePerformanceCap parity: rising sample at base 100 stays ≤ 100", (() => { writeReceipts("t.jsonl", rising); const c = calculatePerformanceCap(join(state4, "t.jsonl"), 100); return typeof c === "number" && c <= 100 && c >= 25; })());
t("invalid baseGearCap → fallback floor", performanceCap({ baseGearCap: 0, receiptPaths: [] }).mode === "invalid-base");

/* 15.13 ownerGate intact under kelly: top gear + perfect stats → cap 100; 120 still needs the arm */
writeGears4({ gear: 3, greenStreak: 12, lastVerdict: "LADDER-ACTED", lastKind: "treasury", history: [] }, kellyOn);
writeReceipts("t.jsonl", rising); writeReceipts("a.jsonl", []);
t("gear3 + full expectancy: 100 allowed (tops AT the gate)", m.policyGate(gridIntent(100)).allow === true);
t("gear3 + kelly: 120 still blocked by owner-gate (gate intact)", m.policyGate(gridIntent(120)).reasons.join(" ").includes("owner-gate"));

/* 15.14 sanitizeParams: broken fields fall to decision defaults (code invents nothing) */
const { sanitizeParams: sp } = await import("./alpha-performance-math.mjs");
const bad = sp({ minBeats: -5, probationFactor: 7, halfKelly: "x", scale: 0 });
t("broken params fall to defaults (minBeats=10, probation=0.5)", bad.minBeats === 10 && bad.probationFactor === 0.5 && bad.halfKelly === 0.5 && bad.scale === 4);

console.log(`\n═ RESULT: ${passed} passed · ${failed} failed ═`);
rmSync(tmp, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
