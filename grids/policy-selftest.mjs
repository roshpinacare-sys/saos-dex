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

console.log(`\n═ RESULT: ${passed} passed · ${failed} failed ═`);
rmSync(tmp, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
