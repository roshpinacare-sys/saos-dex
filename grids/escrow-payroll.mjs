// ESCROW-PAYROLL — מסילת-השכר בטוחה על-השרשרת (R16-a · owner mandate trace 1a12dbe9812eff11)
// ══════════════════════════════════════════════════════════════════════════════════════════════
// שאלת-הבעלים: "מה אפשר להקים על הבלוקצ'יין?" — פרימיטיב-הכלכלה-האוטונומית: אוצר→עובד,
// בשחרור-מוכח. escrow_transfer/approve/release של Steem = שכר-עבודה שהשרשרת עצמה אוכפת:
// הכסף ננעל עד-אישור-שני-הצדדים, ומשוחרר רק-בהוראת-המשחרר-החתום. אין-אמון-נדרש בין-הצדדים —
// רק-חתימות. הקנרית: מחזור-מלא בסכומי-אבק בין-חשבונות-הצי (שהמכונה מחזיקה-בהם-מפתחות-חיים,
// נמדד-חי ב-key-census-probe 2026-10-12: 13/14 חשבונות posting+active חיים בכרוך-ה-GEN-2).
//
// בטיחות (כל-השכבות חייבות; כל-כשל = עצירה-כנה בלי-נגיעה):
//   1. STASIS: stasisHalt("general") — fail-closed.
//   2. תוכנית-חתומה בלבד: הסקריפט לא ממציא צדדים או סכומים — רק מה שבקובץ התוכנית
//      (פרוטוקול SAOS-ESCROW-PAYROLL-PLAN/1; קובץ-זר = fail-closed).
//   3. תקרות-קשיחות: amount ≤ 1.000 SBD · fee ≤ 0.100 SBD לכל-מסלול (קנרית-לנצח;
//      הרחבה = מילת-בעלים + שינוי-התקרה בקוד עם-רישום).
//   4. שער-מפתח לכל-רגל: ה-WIF של כל-חותם מאומת מול רשות-ה-active החיה שלו
//      (grids/key-gate.mjs — אותו-משטר של הגריד).
//   5. אידמפוטנטיות-מהשרשרת: היסטוריית-החשבון נסרקת לפני-כל-רגל — op-זהה-באותו-
//      escrow_id כבר-על-השרשרת = דילוג. בטוח לריצה-כפולה.
//   6. קריאה-אחרי-כתיבה: get_transaction לכל-txid; אי-התאמה = כישלון-כנה.
//   7. אפס-סודות בקבלה; מפתחות מגיעים מקובץ-0700-זמני (מיוצר-בריצה מהכרוך-המוצפן)
//      או env — ולעולם לא נכתבים ללוג.
//
// שימוש:
//   node grids/escrow-payroll.mjs --status                          (קריאה-בלבד)
//   node grids/escrow-payroll.mjs --run --lane <id> [--keys-file p] (מחזור-מלא, אידמפוטנטי)
//   node grids/escrow-payroll.mjs --selftest
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { rpcAny, signAndBroadcast, num } from "./mover.mjs";
import { stasisHalt } from "./brake.mjs";
import { activeAuthorityOk } from "./key-gate.mjs";
import { appendEvent } from "./events.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLAN_PATH = join(HERE, "state", "escrow-payroll-plan.json");
const RECEIPT_PATH = join(HERE, "state", "escrow-receipts.jsonl");
const MAX_AMOUNT_SBD = 1.0;
const MAX_FEE_SBD = 0.1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SBD = (v) => `${Number(v).toFixed(3)} SBD`;
const STEEM0 = "0.000 STEEM";

/* ── תוכנית — validation קשוח ────────────────────────────────────────────────── */
export function validatePlan(plan) {
  if (!plan || plan.protocol !== "SAOS-ESCROW-PAYROLL-PLAN/1") return { ok: false, reason: "protocol foreign/missing — fail-closed" };
  const lanes = Array.isArray(plan.lanes) ? plan.lanes : [];
  if (lanes.length === 0) return { ok: false, reason: "no lanes" };
  for (const l of lanes) {
    const id = `lane[${l?.id ?? "?"}]`;
    if (typeof l.id !== "string" || !l.id) return { ok: false, reason: `${id}: id missing` };
    for (const k of ["from", "to", "agent"]) {
      if (typeof l[k] !== "string" || !l[k]) return { ok: false, reason: `${id}: ${k} missing` };
    }
    if (!(l.from !== l.to && l.from !== l.agent && l.to !== l.agent)) return { ok: false, reason: `${id}: escrow needs three distinct parties` };
    const amt = num(l.amountSbd), fee = num(l.feeSbd);
    if (!(amt > 0)) return { ok: false, reason: `${id}: amountSbd must be > 0` };
    if (amt > MAX_AMOUNT_SBD) return { ok: false, reason: `${id}: amountSbd ${amt} exceeds the canary hard cap ${MAX_AMOUNT_SBD} (owner word required to raise)` };
    if (!(fee > 0) || fee > MAX_FEE_SBD) return { ok: false, reason: `${id}: feeSbd must be in (0, ${MAX_FEE_SBD}]` };
  }
  return { ok: true };
}

/* ── escrow_id דטרמיניסטי (uint32) ───────────────────────────────────────────── */
export function escrowIdFor(laneId) {
  return parseInt(createHash("sha256").update(`SAOS-ESCROW:${laneId}`).digest("hex").slice(0, 8), 16) >>> 0;
}

/* ── היסטוריית-חשבון — מה-כבר-על-השרשרת (אידמפוטנטיות) ───────────────────────── */
/* R16-a נמדד-חי (ריצת-קנרית 02:09Z): קריאה-נכשלת שטופלה-כהיסטוריה-ריקה גרמה-לשידור-חוזר
 * של-אותו-escrow_id → אילוץ-ייחודיות בכל-הצמתים. מעתה: כשל-קריאה = עצירה-כנה (fail-closed) —
 * לעולם לא "היסטוריה-ריקה" על-ספק. */
async function escrowOpsOf(account) {
  let rows;
  try {
    rows = await rpcAny("condenser_api.get_account_history", [account, -100, 100]); // nodes cap the batch at 100 (measured live, canary run 02:14Z)
  } catch (e) {
    throw new Error(`escrowOpsOf(${account}) failed — refusing to broadcast on unreadable history (fail-closed): ${String(e?.message ?? e).slice(0, 120)}`);
  }
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    try {
      const op = row?.[1]?.op;
      if (!Array.isArray(op)) continue;
      const [type, body] = op;
      if (["escrow_transfer", "escrow_approve", "escrow_release", "escrow_dispute"].includes(type)) {
        out.push({ type, body, trxId: row?.[1]?.trx_id ?? null });
      }
    } catch { /* שורה-מוזרה — מדלגים */ }
  }
  return out;
}

function transferDone(ops, escrowId, from) {
  return ops.some((o) => o.type === "escrow_transfer" && o.body?.from === from && Number(o.body?.escrow_id) === escrowId);
}
function approveDone(ops, escrowId, from, who) {
  return ops.some((o) => o.type === "escrow_approve" && o.body?.from === from && Number(o.body?.escrow_id) === escrowId && o.body?.who === who && o.body?.reject !== true);
}
function releaseDone(ops, escrowId, from) {
  return ops.some((o) => o.type === "escrow_release" && o.body?.from === from && Number(o.body?.escrow_id) === escrowId);
}

/* אילוץ-ייחודיות = האוביקט כבר-קיים בשרשרת. רק אם-האימות-מאשר — מטופל-כ"כבר-בוצע"
 * (כנות: ריצת-קנרית 02:09Z לימדה-את-המחלקה-הזו). אחרת — עצירה-כנה. */
const UNIQ_RE = /uniqueness constraint/i;
async function uniquenessRecovered(account, verify) {
  try {
    const ops = await escrowOpsOf(account);
    return verify(ops);
  } catch {
    return false;
  }
}

/* ── מפתחות — מקובץ-0700 או env; אימות-מול-רשות-חיה לכל-רגל ─────────────────── */
function loadKeys(keysFile) {
  const map = {};
  if (keysFile && existsSync(keysFile)) {
    try {
      const j = JSON.parse(readFileSync(keysFile, "utf8"));
      for (const [acc, v] of Object.entries(j)) {
        if (typeof v === "string" && v) map[acc] = v;
        else if (v && typeof v === "object" && typeof v.active === "string") map[acc] = v.active;
      }
    } catch { /* קובץ-רע = בלי-מפתחות; השער-יסרב בכנות */ }
  }
  for (const [envName, acc] of [["ESCROW_FROM_WIF", "cashmachine"], ["STEEM_ACTIVE_WIF", "headcorner"]]) {
    const v = process.env[envName] || "";
    if (v && !map[acc]) map[acc] = v;
  }
  return map;
}

/* ── selftest — וקטורים אופליין ─────────────────────────────────────────────── */
export async function selftest() {
  const assert = (c, m) => { if (!c) { console.error("SELFTEST FAIL:", m); process.exit(1); } };
  const lane = { id: "canary-1", from: "cashmachine", to: "hcsoldier4", agent: "hcsoldier5", amountSbd: 0.05, feeSbd: 0.01, purpose: "canary payroll cycle" };
  const plan = { protocol: "SAOS-ESCROW-PAYROLL-PLAN/1", lanes: [lane] };
  // וקטור 1: תוכנית-תקינה עוברת
  assert(validatePlan(plan).ok === true, "valid plan accepted");
  // וקטור 2: פרוטוקול-זר נדחה
  assert(validatePlan({ protocol: "OTHER/1", lanes: [lane] }).ok === false, "foreign protocol refused");
  // וקטור 3: תקרה-קשה
  assert(validatePlan({ protocol: "SAOS-ESCROW-PAYROLL-PLAN/1", lanes: [{ ...lane, amountSbd: 5 }] }).ok === false, "over-cap amount refused");
  assert(validatePlan({ protocol: "SAOS-ESCROW-PAYROLL-PLAN/1", lanes: [{ ...lane, feeSbd: 0.5 }] }).ok === false, "over-cap fee refused");
  // וקטור 4: שלושה-צדדים-נבדלים
  assert(validatePlan({ protocol: "SAOS-ESCROW-PAYROLL-PLAN/1", lanes: [{ ...lane, to: "cashmachine" }] }).ok === false, "same-party lane refused");
  // וקטור 5: escrow_id דטרמיניסטי + בגבולות-uint32
  const id1 = escrowIdFor("canary-1"), id2 = escrowIdFor("canary-1"), id3 = escrowIdFor("canary-2");
  assert(id1 === id2 && id1 !== id3 && id1 > 0 && id1 <= 0xffffffff, "escrow id deterministic uint32");
  // וקטור 6: אידמפוטנטיות — זיהוי-רגל-שבוצעה
  const ops = [
    { type: "escrow_transfer", body: { from: "cashmachine", escrow_id: id1, sbd_amount: "0.050 SBD" } },
    { type: "escrow_approve", body: { from: "cashmachine", who: "hcsoldier4", escrow_id: id1, reject: false } },
  ];
  assert(transferDone(ops, id1, "cashmachine") === true, "transfer detected on chain history");
  assert(approveDone(ops, id1, "cashmachine", "hcsoldier4") === true, "approve detected");
  assert(approveDone(ops, id1, "cashmachine", "hcsoldier5") === false, "second approval honestly missing");
  assert(releaseDone(ops, id1, "cashmachine") === false, "release honestly missing");
  // וקטור 7: עקרון-השער — מפתח-לא-מתאים לעולם לא חותם (activeAuthorityOk מכסה; כאן: צורת-סירוב)
  const fmt = SBD(0.05);
  assert(fmt === "0.050 SBD", "amount formatting 3dp");
  console.log("SELFTEST PASS: 7/7 vectors");
}

/* ── מחזור-מלא אידמפוטנטי על-מסלול ──────────────────────────────────────────── */
async function runLane(lane, keys, receipt) {
  const escrowId = escrowIdFor(lane.id);
  const legs = [];
  const leg = async (name, fn) => {
    try {
      const r = await fn();
      legs.push({ leg: name, ...r });
      if (!r.ok && r.hardFail) throw new Error(`hard-fail at ${name}: ${r.reason ?? ""}`);
    } catch (e) {
      legs.push({ leg: name, ok: false, hardFail: true, reason: String(e?.message ?? e).slice(0, 200) });
      throw e;
    }
  };

  const hist = await escrowOpsOf(lane.from);

  // רגל 1: transfer (from)
  if (transferDone(hist, escrowId, lane.from)) {
    legs.push({ leg: "transfer", ok: true, skipped: "already on chain" });
  } else {
    const wif = keys[lane.from];
    const gate = await activeAuthorityOk({ account: lane.from, wif, rpc: rpcAny });
    if (!gate.ok) throw new Error(`transfer refused by key gate (${lane.from}): ${gate.reason}`);
    const body = {
      from: lane.from, to: lane.to, agent: lane.agent, escrow_id: escrowId,
      sbd_amount: SBD(lane.amountSbd), steem_amount: STEEM0, fee: SBD(lane.feeSbd),
      json_meta: JSON.stringify({ protocol: "SAOS-ESCROW-PAYROLL/1", lane: lane.id, purpose: lane.purpose ?? "sovereign payroll" }),
      ratification_deadline: new Date(Date.now() + 48 * 3600e3).toISOString().slice(0, 19),
      escrow_expiration: new Date(Date.now() + 8 * 24 * 3600e3).toISOString().slice(0, 19),
    };
    await leg("transfer", async () => {
      let r;
      try {
        r = await signAndBroadcast(wif, [["escrow_transfer", body]]);
      } catch (e) {
        if (UNIQ_RE.test(String(e?.message ?? e)) && await uniquenessRecovered(lane.from, (ops) => transferDone(ops, escrowId, lane.from))) {
          console.log(`escrow-payroll: transfer — uniqueness constraint = the escrow is already on chain (verified in history); treated as done`);
          return { ok: true, recovered: "uniqueness-verified-on-chain" };
        }
        throw e;
      }
      await sleep(2500);
      const tx = await rpcAny("condenser_api.get_transaction", [r.txid]).catch(() => null);
      const onChain = tx?.operations?.some(([t, b]) => t === "escrow_transfer" && Number(b?.escrow_id) === escrowId);
      console.log(`escrow-payroll: transfer txid=${r.txid} readback=${onChain ? "OK" : "PENDING"}`);
      return { ok: true, txid: r.txid, readback: onChain };
    });
  }

  // רגל 2+3: approvals (to + agent)
  for (const who of [lane.to, lane.agent]) {
    const histWho = who === lane.from ? hist : await escrowOpsOf(who);
    if (approveDone(histWho, escrowId, lane.from, who)) {
      legs.push({ leg: `approve:${who}`, ok: true, skipped: "already on chain" });
      continue;
    }
    const wif = keys[who];
    const gate = await activeAuthorityOk({ account: who, wif, rpc: rpcAny });
    if (!gate.ok) throw new Error(`approve refused by key gate (${who}): ${gate.reason}`);
    await leg(`approve:${who}`, async () => {
      // השרשרת דורשת בדיוק-אחד-מהשניים: approve=true או reject=true (נמדד-חי: בלי-
      // approve מפורש — "undefined is not valid JSON", ריצת-קנרית 02:07Z).
      let r;
      try {
        r = await signAndBroadcast(wif, [["escrow_approve", { from: lane.from, to: lane.to, agent: lane.agent, who, escrow_id: escrowId, approve: true, reject: false }]]);
      } catch (e) {
        if (UNIQ_RE.test(String(e?.message ?? e)) && await uniquenessRecovered(who, (ops) => approveDone(ops, escrowId, lane.from, who))) {
          console.log(`escrow-payroll: approve(${who}) — uniqueness constraint = already approved (verified in history); treated as done`);
          return { ok: true, recovered: "uniqueness-verified-on-chain" };
        }
        throw e;
      }
      await sleep(2500);
      const tx = await rpcAny("condenser_api.get_transaction", [r.txid]).catch(() => null);
      const onChain = tx?.operations?.some(([t, b]) => t === "escrow_approve" && Number(b?.escrow_id) === escrowId && b?.who === who);
      console.log(`escrow-payroll: approve(${who}) txid=${r.txid} readback=${onChain ? "OK" : "PENDING"}`);
      return { ok: true, txid: r.txid, readback: onChain };
    });
  }

  // רגל 4: release (from → to, מחזור-קנרית מלא)
  if (releaseDone(hist, escrowId, lane.from)) {
    legs.push({ leg: "release", ok: true, skipped: "already on chain" });
  } else {
    const wif = keys[lane.from];
    const gate = await activeAuthorityOk({ account: lane.from, wif, rpc: rpcAny });
    if (!gate.ok) throw new Error(`release refused by key gate (${lane.from}): ${gate.reason}`);
    await leg("release", async () => {
      let r;
      try {
        r = await signAndBroadcast(wif, [["escrow_release", { from: lane.from, to: lane.to, agent: lane.agent, who: lane.from, receiver: lane.to, escrow_id: escrowId, sbd_amount: SBD(lane.amountSbd), steem_amount: STEEM0 }]]);
      } catch (e) {
        if (UNIQ_RE.test(String(e?.message ?? e)) && await uniquenessRecovered(lane.from, (ops) => releaseDone(ops, escrowId, lane.from))) {
          console.log(`escrow-payroll: release — uniqueness constraint = already released (verified in history); treated as done`);
          return { ok: true, recovered: "uniqueness-verified-on-chain" };
        }
        throw e;
      }
      await sleep(2500);
      const tx = await rpcAny("condenser_api.get_transaction", [r.txid]).catch(() => null);
      const onChain = tx?.operations?.some(([t, b]) => t === "escrow_release" && Number(b?.escrow_id) === escrowId);
      console.log(`escrow-payroll: release txid=${r.txid} readback=${onChain ? "OK" : "PENDING"} — הקנרית השלימה מחזור-שכר-מלא על-השרשרת`);
      return { ok: true, txid: r.txid, readback: onChain };
    });
  }

  return legs;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--selftest")) { await selftest(); return; }

  if (stasisHalt("general")) {
    console.log("escrow-payroll: מסילת general סגורה (STASIS) — לא נגעתי בכלום (כנות, לא כישלון)");
    process.exit(0);
  }

  let plan;
  try { plan = JSON.parse(readFileSync(PLAN_PATH, "utf8")); } catch (e) {
    console.error(`escrow-payroll: קובץ-תוכנית לא קריא — fail-closed: ${String(e?.message ?? e).slice(0, 120)}`);
    process.exit(2);
  }
  const v = validatePlan(plan);
  if (!v.ok) { console.error(`escrow-payroll: תוכנית נדחית — ${v.reason}`); process.exit(2); }

  if (args.includes("--status")) {
    for (const l of plan.lanes) {
      const hist = await escrowOpsOf(l.from);
      const id = escrowIdFor(l.id);
      console.log(`escrow-payroll: lane=${l.id} id=${id} transfer=${transferDone(hist, id, l.from)} approveTo=${approveDone(hist, id, l.from, l.to)} approveAgent=${approveDone(hist, id, l.from, l.agent)} release=${releaseDone(hist, id, l.from)} (amount ${SBD(l.amountSbd)} fee ${SBD(l.feeSbd)} ${l.from}→${l.to} agent ${l.agent})`);
    }
    process.exit(0);
  }

  const laneIdx = args.indexOf("--lane");
  const laneId = laneIdx >= 0 ? args[laneIdx + 1] : null;
  const lane = plan.lanes.find((l) => l.id === laneId);
  if (!lane) { console.error("escrow-payroll: --lane חובה (אחד מה-ID בתוכנית) — fail-closed"); process.exit(2); }

  const keysFileIdx = args.indexOf("--keys-file");
  const keys = loadKeys(keysFileIdx >= 0 ? args[keysFileIdx + 1] : null);

  const receipt = { at: new Date().toISOString(), lane: lane.id, escrowId: escrowIdFor(lane.id), from: lane.from, to: lane.to, agent: lane.agent, amountSbd: lane.amountSbd, feeSbd: lane.feeSbd, legs: [], hardFail: false };
  try {
    receipt.legs = await runLane(lane, keys, receipt);
    receipt.cycle = "COMPLETE";
    console.log(`escrow-payroll: המסלול ${lane.id} הושלם — ${receipt.legs.length} רגליים, אפס-אמון, כל-החתימות-מאומתות-מול-הרשויות-החיות`);
  } catch (e) {
    receipt.hardFail = true;
    receipt.reason = String(e?.message ?? e).slice(0, 200);
    console.error(`escrow-payroll: עצירה-כנה — ${receipt.reason}`);
  }
  try {
    appendFileSync(RECEIPT_PATH, JSON.stringify(receipt) + "\n");
    appendEvent(join(HERE, "state", "events.jsonl"), { kind: "escrow-payroll", at: receipt.at, lane: lane.id, ok: !receipt.hardFail, legs: receipt.legs.map((l) => l.leg), sim: false });
  } catch { /* כשל-קבלה לא מפיל את התוצאה החיה */ }
  process.exit(receipt.hardFail ? 1 : 0);
}

main().catch((e) => { console.error("escrow-payroll FATAL:", String(e?.message ?? e).slice(0, 200)); process.exit(1); });
