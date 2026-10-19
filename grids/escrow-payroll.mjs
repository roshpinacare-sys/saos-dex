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
// W12c: תקרת-מילוי-קשה למחזור — המסילה מממנת-את-עצמה מהאוצר באבק בלבד (ראה refillAmountSbd)
const REFILL_CAP_SBD = 0.1;
const TREASURY_ACCOUNT = "headcorner";
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

/* ── מצב-ה-escrow הישיר-מהשרשרת (W12) ──────────────────────────────────────────── */
/* W12 נמדד-חי (3 ריצות אדומות 10-18T12:01 → 10-19T01:51, כולן legs:[]): האידמפוטנציה
 * נשענה על get_account_history[-100,100] — חלון-ה-100-הפעולות-האחרונות של חשבון-אוצר
 * חי קובר את ה-ops-המקוריים תוך-שעות → transferDone/approveDone מתחלפים-ל-false
 * על-אותו-escrow_id בדיוק → המחזור מסיק-מסקנות-שגויות-מהיסטוריה ונזרק על-ידי
 * assert-השחרור של השרשרת (e.to_approved && e.agent_approved). המקור-האמיתי
 * למצב-ה-escrow הוא condenser_api.get_escrow — קריאה-ישירה, לא-היסטוריה: */
async function escrowStateOf(from, escrowId) {
  let e;
  try {
    e = await rpcAny("condenser_api.get_escrow", [from, escrowId]);
  } catch (err) {
    throw new Error(`escrowStateOf(${from}/${escrowId}) failed — refusing to broadcast on unreadable escrow state (fail-closed): ${String(err?.message ?? err).slice(0, 120)}`);
  }
  if (!e || typeof e !== "object" || Array.isArray(e) || Object.keys(e).length === 0) return null;
  return e;
}

/* W12c: יתרת-SBD חיה (לרגל-המימון-העצמי) — fail-closed על-קריאה-לא-קריאה */
async function sbdBalanceOf(account) {
  let a;
  try {
    a = await rpcAny("condenser_api.get_accounts", [[account]]);
  } catch (err) {
    throw new Error(`sbdBalanceOf(${account}) failed — refusing to broadcast on unreadable balance (fail-closed): ${String(err?.message ?? err).slice(0, 120)}`);
  }
  const acc = Array.isArray(a) ? a[0] : null;
  if (!acc) throw new Error(`sbdBalanceOf(${account}) — account absent from chain (fail-closed)`);
  return parseFloat(String(acc.sbd_balance ?? "0").split(" ")[0]) || 0;
}

/* החלטת-רגליים טהורה (נבדקת-ב-selftest): מצב-השרשרת → מה-המחזור צריך-לעשות */
export function planLegsFromState(st) {
  // st === null → אין-escrow על-השרשרת → חייב transfer
  if (st === null) return { doTransfer: true, needApprove: [], doRelease: false, complete: false };
  const toOk = st.to_approved === true;
  const agentOk = st.agent_approved === true;
  const balanceZero = /^0(\.0+)? SBD$/.test(String(st.sbd_balance ?? "")) && /^0(\.0+)? STEEM$/.test(String(st.steem_balance ?? ""));
  if (balanceZero) return { doTransfer: false, needApprove: [], doRelease: false, complete: true }; // שוחרר/הוחזר — המחזור הושלם-בעבר
  return { doTransfer: false, needApprove: [!toOk, !agentOk], doRelease: toOk && agentOk, complete: false };
}
export function planApproveWhos(st, lane) {
  const p = planLegsFromState(st);
  const whos = [];
  if (p.needApprove[0] === true) whos.push(lane.to);
  if (p.needApprove[1] === true) whos.push(lane.agent);
  return whos;
}

/* W12c: חישוב-מילוי טהור (נבדק-ב-selftest): המסילה מממנת-את-עצמה מהאוצר —
 * אבק-בלבד: בדיוק-המחסור + 0.001 מרווח, תקרה-קשה 0.100 SBD. מעל-התקרה = null
 * (fail-closed — האוצר לעולם לא נשפך-למסילה בלי-תקרה). */
export function refillAmountSbd(bal, need, cap = REFILL_CAP_SBD) {
  if (bal >= need) return 0;
  const raw = Math.ceil((need - bal + 0.001) * 1000) / 1000;
  return raw > cap ? null : raw;
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

/* קריאת-מצב-ממתינה-לתנאי (W12e): הבלוק הקרוב-ביותר עשוי-להתאחר ~3 שנ׳/בלוק — קריאה-בודדת
 * תופסת-מצב-טרם-בלוק (נמדד-חי ריצות 02:05-02:19Z). מחכים-עד-שהתנאי-מתקיים במצב-השרשרת:
 * transfer → קיום · approve → הדגל-הספציפי. null אחרי-המתנה = התנאי-מעולם-לא-התקיים. */
async function stateAwaiting(from, escrowId, cond, tries = 10) {
  for (let i = 0; i < tries; i++) {
    await sleep(2500);
    try {
      const st = await escrowStateOf(from, escrowId);
      if (st === null) return null; // האובייקט-נעלם (שוחרר/פג) — זה-גם-מצב-סופי
      if (cond(st)) return st;
    } catch { continue; }
  }
  return null;
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
  // וקטור 8-11 (W12): החלטות-רגליים-ממצב-השרשרת-הישיר (planLegsFromState)
  assert(JSON.stringify(planLegsFromState(null)) === JSON.stringify({ doTransfer: true, needApprove: [], doRelease: false, complete: false }), "absent escrow → transfer leg");
  const unrat = { to_approved: false, agent_approved: false, sbd_balance: "0.050 SBD", steem_balance: "0.000 STEEM" };
  const pUnrat = planLegsFromState(unrat);
  assert(pUnrat.doTransfer === false && pUnrat.doRelease === false && pUnrat.complete === false, "unratified escrow → no transfer/release");
  assert(JSON.stringify(planApproveWhos(unrat, lane)) === JSON.stringify(["hcsoldier4", "hcsoldier5"]), "unratified → both whos approve");
  const half = { to_approved: true, agent_approved: false, sbd_balance: "0.050 SBD", steem_balance: "0.000 STEEM" };
  assert(JSON.stringify(planApproveWhos(half, lane)) === JSON.stringify(["hcsoldier5"]), "half-ratified → only the missing who");
  const ready = { to_approved: true, agent_approved: true, sbd_balance: "0.050 SBD", steem_balance: "0.000 STEEM" };
  assert(planLegsFromState(ready).doRelease === true, "fully ratified + funded → release leg");
  const emptied = { to_approved: true, agent_approved: true, sbd_balance: "0.000 SBD", steem_balance: "0.000 STEEM" };
  assert(planLegsFromState(emptied).complete === true, "zero balance → cycle already complete");
  // וקטור 12-14 (W12c): מימון-עצמי — בדיוק-המחסור + מרווח, תקרה-קשה
  assert(refillAmountSbd(0.06, 0.06) === 0, "funded lane → no refill");
  assert(refillAmountSbd(0.005, 0.06) === 0.056, "shortfall + 0.001 margin, exactly");
  assert(refillAmountSbd(0, 0.25) === null, "shortfall above the hard cap → refuse");
  console.log("SELFTEST PASS: 15/15 vectors");
}

/* ── מחזור-מלא אידמפוטנטי על-מסלול ──────────────────────────────────────────── */
async function runLane(lane, keys, receipt) {
  const escrowId = escrowIdFor(lane.id);
  const legs = [];
  receipt.legs = legs; // W12: attach BEFORE running — a mid-cycle throw keeps the leg evidence (was: legs lost on every hardFail)
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

  // W12: ההחלטות מהמצב-הישיר-מהשרשרת (get_escrow) — לא מחלון-היסטוריה-שנקבר.
  // ההיסטוריה נשארת רק-כראיה משלימה בקבלות. כל-רגל: שער-מפתח → שידור → קריאת-מצב-חוזרת.
  let st = await escrowStateOf(lane.from, escrowId);
  let plan = planLegsFromState(st);
  console.log(`escrow-payroll: lane=${lane.id} escrowId=${escrowId} chain-state=${st ? `exists(to_approved=${st.to_approved} agent_approved=${st.agent_approved} sbd=${st.sbd_balance})` : "absent"} → plan=${JSON.stringify(plan)}`);

  // רגל 0 (W12c): מימון-עצמי-כן של המסילה — הפרימיטיב-המקורי "אוצר→עובד".
  // נמדד-חי (ריצת 02:11Z): הקנרית שילמה-את-המחזור-הראשון בפועל → cashmachine 0.005 SBD →
  // ה-transfer-הבא נזרק (available >= -delta). מסילה-חיה מתממנת-מהאוצר: בדיוק-המחסור,
  // תקרה-קשה 0.100 SBD, שער-מפתח-מלא על-האוצר, readback-יתרה, רישום-מלא בקבלה.
  if (plan.doTransfer) {
    const need = lane.amountSbd + lane.feeSbd;
    const bal = await sbdBalanceOf(lane.from);
    const refill = refillAmountSbd(bal, need);
    if (refill === null) throw new Error(`lane ${lane.from} holds ${bal} SBD, needs ${need} — shortfall exceeds the hard refill cap ${REFILL_CAP_SBD} SBD (fail-closed; owner word required)`);
    if (refill > 0) {
      const wif = keys[TREASURY_ACCOUNT];
      if (!wif) throw new Error(`refill refused: no ${TREASURY_ACCOUNT} key in the runner-held material (fail-closed)`);
      const gate = await activeAuthorityOk({ account: TREASURY_ACCOUNT, wif, rpc: rpcAny });
      if (!gate.ok) throw new Error(`refill refused by key gate (${TREASURY_ACCOUNT}): ${gate.reason}`);
      await leg(`refill:${TREASURY_ACCOUNT}→${lane.from}`, async () => {
        const r = await signAndBroadcast(wif, [["transfer", { from: TREASURY_ACCOUNT, to: lane.from, amount: SBD(refill), memo: "SAOS-ESCROW-PAYROLL/1 canary lane self-funding (dust, hard-capped)" }]]);
        let funded = 0;
        for (let i = 0; i < 8; i++) {
          await sleep(2500);
          funded = await sbdBalanceOf(lane.from).catch(() => 0);
          if (funded >= need) break;
        }
        if (funded < need) throw new Error(`refill broadcast ${r?.txid ?? "?"} but the lane balance never showed the funds (fail-closed)`);
        console.log(`escrow-payroll: refill ${TREASURY_ACCOUNT}→${lane.from} ${SBD(refill)} txid=${r.txid} chain-readback=OK (balance ${funded} SBD)`);
        return { ok: true, txid: r.txid, readback: true, amount: SBD(refill) };
      });
    }
  }

  // רגל 1: transfer (from) — רק-אם-השרשרת אינה-מכירה-את-ה-escrow
  if (plan.complete) {
    legs.push({ leg: "transfer", ok: true, skipped: "escrow already released/expired (chain balance zero)" });
  } else if (!plan.doTransfer) {
    legs.push({ leg: "transfer", ok: true, skipped: `escrow exists on chain (created ${st?.ratification_deadline ? "deadline " + st.ratification_deadline : "earlier"})` });
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
        // אילוץ-ייחודיות/קיים = ה-escrow עלה-בינתיים — מאמתים-מול-המצב-הישיר, לא-מההיסטוריה
        const stNow = await escrowStateOf(lane.from, escrowId).catch(() => null);
        if (stNow) {
          console.log(`escrow-payroll: transfer — broadcast refused but chain-state shows the escrow exists (to_approved=${stNow.to_approved} agent_approved=${stNow.agent_approved}); treated as done`);
          return { ok: true, recovered: "escrow-exists-on-chain" };
        }
        throw e;
      }
      const stNow = await stateAwaiting(lane.from, escrowId, () => true);
      if (!stNow) throw new Error(`transfer broadcast ${r?.txid ?? "?"} but get_escrow never materialized the escrow (fail-closed)`);
      console.log(`escrow-payroll: transfer txid=${r.txid} chain-readback=OK (to_approved=${stNow.to_approved} agent_approved=${stNow.agent_approved})`);
      st = stNow; plan = planLegsFromState(st);
      return { ok: true, txid: r.txid, readback: true };
    });
  }

  // רגל 2+3: approvals (to + agent) — מהמצב-החי: מאשר-רק-את-מי-שעוד-לא-אישר
  if (!plan.complete) {
    for (const who of planApproveWhos(st, lane)) {
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
          const stNow = await escrowStateOf(lane.from, escrowId).catch(() => null);
          if (stNow && ((who === lane.to && stNow.to_approved === true) || (who === lane.agent && stNow.agent_approved === true))) {
            console.log(`escrow-payroll: approve(${who}) — broadcast refused but chain-state shows the approval landed; treated as done`);
            return { ok: true, recovered: "approval-on-chain" };
          }
          throw e;
        }
        const stNow = await stateAwaiting(lane.from, escrowId, (s) => (who === lane.to ? s.to_approved === true : s.agent_approved === true));
        if (!stNow) throw new Error(`approve(${who}) broadcast ${r?.txid ?? "?"} but chain-state never showed the ratification (fail-closed)`);
        console.log(`escrow-payroll: approve(${who}) txid=${r.txid} chain-readback=OK`);
        st = stNow; plan = planLegsFromState(st);
        return { ok: true, txid: r.txid, readback: true };
      });
    }
  }

  // רגל 4: release (from → to) — רק-כשהשרשרת עצמה מראה-שני-האשרורים (לעולם לא מניחים)
  if (plan.complete) {
    legs.push({ leg: "release", ok: true, skipped: "escrow balance already zero (released/expired)" });
  } else if (!plan.doRelease) {
    legs.push({ leg: "release", ok: false, hardFail: false, skipped: "awaiting ratification", state: { to_approved: st?.to_approved ?? null, agent_approved: st?.agent_approved ?? null, ratification_deadline: st?.ratification_deadline ?? null } });
    console.log(`escrow-payroll: release skipped honestly — chain still awaits ratification (to_approved=${st?.to_approved} agent_approved=${st?.agent_approved}); next cycle completes it`);
  } else {
    const wif = keys[lane.from];
    const gate = await activeAuthorityOk({ account: lane.from, wif, rpc: rpcAny });
    if (!gate.ok) throw new Error(`release refused by key gate (${lane.from}): ${gate.reason}`);
    await leg("release", async () => {
      let r;
      try {
        r = await signAndBroadcast(wif, [["escrow_release", { from: lane.from, to: lane.to, agent: lane.agent, who: lane.from, receiver: lane.to, escrow_id: escrowId, sbd_amount: SBD(lane.amountSbd), steem_amount: STEEM0 }]]);
      } catch (e) {
        const stNow = await escrowStateOf(lane.from, escrowId).catch(() => null);
        if (stNow && planLegsFromState(stNow).complete) {
          console.log(`escrow-payroll: release — broadcast refused but chain-state shows balance zero (already released); treated as done`);
          return { ok: true, recovered: "release-on-chain" };
        }
        throw e;
      }
      // W12d: readback-ממתין — ה-release דורש-בלוק-עד-שניים-להיחתם; קריאה-בודדת-מיד-אחרי-
      // השידור תופסת-מצב-טרם-בלוק (נמדד-חי ריצת 02:16Z: כל-הרגליים-ירוקות, ה-release-על-
      // השרשרת, וה-verdict-עדיין-זרק). לולאה: ממתינים-ל-null (האובייקט-נצרך) או-ליתרה-אפס.
      let readback = null; // null = still waiting | "complete" | "gone" | "funded"
      for (let i = 0; i < 8; i++) {
        await sleep(2500);
        const stNow = await escrowStateOf(lane.from, escrowId).catch(() => "err");
        if (stNow === "err") continue;
        if (!stNow) { readback = "gone"; break; }
        if (planLegsFromState(stNow).complete) { readback = "complete"; break; }
      }
      if (readback === "gone") {
        const tx = await rpcAny("condenser_api.get_transaction", [r.txid]).catch(() => null);
        const onChain = !!tx?.operations?.some(([t]) => t === "escrow_release");
        if (!onChain) throw new Error(`release broadcast ${r.txid} and the escrow object vanished, but the release tx is NOT on chain (fail-closed)`);
        console.log(`escrow-payroll: release txid=${r.txid} chain-readback=OK (escrow object consumed by the chain) — הקנרית השלימה מחזור-שכר-מלא על-השרשרת`);
        return { ok: true, txid: r.txid, readback: true, consumed: "escrow-object-removed-after-release" };
      }
      if (readback === "complete") {
        console.log(`escrow-payroll: release txid=${r.txid} chain-readback=OK (balance zero) — הקנרית השלימה מחזור-שכר-מלא על-השרשרת`);
        return { ok: true, txid: r.txid, readback: true };
      }
      throw new Error(`release broadcast ${r.txid} but chain-state still shows a funded escrow after 20s (fail-closed)`);
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
    // W12: מחזור-חלקי-כן — אם-השרשרת עוד-ממתינה-לאשרור (למשל-ריצה-הופסקה-בין-רגליים)
    // המחזור-הבא ישלים: זה-מצב-מדיד, לא-כשל.
    const awaiting = receipt.legs.some((l) => l.skipped === "awaiting ratification");
    receipt.cycle = awaiting ? "AWAITING-RATIFICATION" : "COMPLETE";
    console.log(`escrow-payroll: המסלול ${lane.id} — ${receipt.cycle} (${receipt.legs.length} רגליים, כל-החתימות-מאומתות-מול-הרשויות-החיות)`);
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
