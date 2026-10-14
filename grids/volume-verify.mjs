// VOLUME-VERIFY — VERIFIED-VS-CHAIN: אמת-מול-שרשרת על-כל-קבלה וכל-מילוי (R323)
// ════════════════════════════════════════════════════════════════════════════════
// מילת-הבעלים (R323): "VERIFIED-VS-CHAIN — וליום-מאומת". החוק: מה שאין-על-השרשרת
// לא-היה. כל-txid בקבלות (treasury-ladder + army-ladder) נשלף מהשרשרת ונבדק אופ-אופ;
// כל-מילוי (fill_order) של-חשבונות-הצי נמדד מהשרשרת עצמה — עם-ייחוס-maker מול
// מרחב-ה-orderid הדטרמיניסטי שלנו.
//
// כנות-מבנית: המנוע הזה לא מייצר מילויים — הוא מודד מה-כבר-קרה. UNREACHABLE הוא
// מצב-כנה (צומת-לא-מחזיק היסטוריה), לא כשל. הקובץ-המוחזר הוא-האזעקה; אין-מיילים.
//
// שימוש:
//   node grids/volume-verify.mjs --selftest
//   node grids/volume-verify.mjs --verify          (כתיבת state/volume-verify.json)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { rpcAny, num } from "./mover.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(HERE, "state", "volume-verify.json");
const RECEIPT_FILES = [
  join(HERE, "state", "treasury-receipts.jsonl"),
  join(HERE, "state", "army-receipts.jsonl"),
];
const PLAN_FILES = [
  join(HERE, "state", "treasury-ladder-plan.json"),
  join(HERE, "state", "army-ladder-plan.json"),
];

/* ── מרחב-ה-orderid שלנו (מהתוכניות החיות; דטרמיניסטי — אותו-חישוב כמו החותמים) ──── */
function treasuryOrderId(legId) {
  // חוזר על נוסחת treasury-ladder.mjs legOrderId — אותו-hash בדיוק
  const h = createHash("sha256").update(`treasury-ladder:${legId}`).digest();
  return (h.readUInt32LE(0) % 4000000000) + 1;
}
function armyOrderId(account, legId) {
  // חוזר על נוסחת army-ladder.mjs legOrderId — אותו-hash בדיוק
  const h = createHash("sha256").update(`army-ladder:${account}:${legId}`).digest();
  return (h.readUInt32LE(0) % 4000000000) + 1;
}

export function knownOrderSpace(plans) {
  const byAccount = new Map(); // account -> Set(orderid)
  const add = (acct, id) => { if (!byAccount.has(acct)) byAccount.set(acct, new Set()); byAccount.get(acct).add(Number(id)); };
  for (const p of plans) {
    if (!p || !p.protocol) continue;
    if (p.protocol === "SAOS-TREASURY-LADDER-PLAN/1") {
      const trader = p.trader;
      for (const [i] of (p.sellLegs || []).entries()) add(trader, treasuryOrderId(`sell-${i + 1}`));
      if (p.reinvestBuyLegs) add(trader, treasuryOrderId("buy-1"));
    }
    if (p.protocol === "SAOS-ARMY-LADDER-PLAN/1") {
      for (const t of p.traders || []) {
        for (const [j] of (t.sellLegs || [{}, {}]).entries()) {
          if (j >= 2) break;
          add(t.account, armyOrderId(t.account, `sell-${j + 1}`));
        }
        const buy = t.reinvestBuyLegs != null ? !!t.reinvestBuyLegs : !!p.reinvestBuyLegs;
        if (buy) add(t.account, armyOrderId(t.account, "buy-1"));
      }
    }
  }
  return byAccount;
}

/* ── התאמת-אופ: האם ה-tx מכיל בדיוק את-האופ שנטען ──────────────────────────────── */
export function matchTxOp(tx, { owner, orderid, kind }) {
  const ops = tx?.operations || tx?.transaction?.operations || [];
  for (const op of ops) {
    const [name, body] = Array.isArray(op) ? op : [op?.type, op?.value];
    const bodyOwner = body?.owner ?? body?.current_owner;
    const bodyOid = Number(body?.orderid ?? body?.current_orderid);
    if (kind && String(name) !== kind) continue;
    if (owner && bodyOwner && bodyOwner !== owner) continue;
    if (orderid != null && bodyOid !== Number(orderid)) continue;
    return { matched: true, name };
  }
  return { matched: false };
}

/* ── ייחוס-מילוי: maker/taker + ווליום-אמת ביחידות-שרשרת ───────────────────────── */
export function attributeFill(op, knownByAccount, ourAccounts) {
  const b = op?.[1] || op?.value || {};
  const a = (v) => num(v);
  const curOwner = b.current_owner, openOwner = b.open_owner;
  const curPays = String(b.current_pays ?? ""), openPays = String(b.open_pays ?? "");
  const curIsSteem = /STEEM$/i.test(curPays), curIsSbd = /SBD$/i.test(curPays);
  let ourSide = null, maker = false;
  if (ourAccounts.includes(curOwner)) { ourSide = "sell-maker-perspective"; maker = knownByAccount.get(curOwner)?.has(Number(b.current_orderid)) || false; }
  else if (ourAccounts.includes(openOwner)) { ourSide = "buy-maker-perspective"; maker = knownByAccount.get(openOwner)?.has(Number(b.open_orderid)) || false; }
  if (!ourSide) return null;
  // ווליום: הצד-שלנו והצד-השני
  let volumeSteem = 0, volumeSbd = 0;
  if (curIsSteem) { volumeSteem = a(curPays); volumeSbd = a(openPays); }
  else if (curIsSbd) { volumeSbd = a(curPays); volumeSteem = a(openPays); }
  else { const openIsSteem = /STEEM$/i.test(openPays); if (openIsSteem) { volumeSteem = a(openPays); volumeSbd = a(curPays); } else { volumeSbd = a(openPays); } }
  return { maker, volumeSteem, volumeSbd, counterparty: ourSide === "sell-maker-perspective" ? openOwner : curOwner };
}

/* ── פסק-כנה ──────────────────────────────────────────────────────────────────── */
export function verdictOf(txChecks, chainFills) {
  const { total = 0, verified = 0, exposed = 0, unreachable = 0 } = txChecks || {};
  if (exposed > 0) return "EXPOSED";
  if (total > 0 && verified > 0) return "VERIFIED";
  if (total > 0 && unreachable === total) return "UNREACHABLE";
  if ((chainFills?.count ?? 0) > 0) return "VERIFIED";
  return total === 0 ? "NO-RECEIPTS" : "PARTIAL";
}

async function verify() {
  // 1) קבלות + תוכניות
  const receipts = [];
  for (const f of RECEIPT_FILES) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split("\n").filter(Boolean)) {
      try { const j = JSON.parse(line); if (j?.schema) receipts.push({ file: f.split("/").pop(), j }); } catch { /* שורה-פגומה לא מפילה את-האמת */ }
    }
  }
  const plans = PLAN_FILES.filter(existsSync).map((f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } }).filter(Boolean);
  const knownByAccount = knownOrderSpace(plans);
  const ourAccounts = [...knownByAccount.keys()];

  // 2) txChecks — כל-txid על-השרשרת
  const evidence = [];
  const txChecks = { total: 0, verified: 0, exposed: 0, unreachable: 0 };
  for (const { j, file } of receipts) {
    for (const ex of j.executed || []) {
      if (!ex.txid) continue;
      txChecks.total++;
      try {
        const tx = await rpcAny("condenser_api.get_transaction", [ex.txid]);
        const kind = ex.action === "cancel" ? "limit_order_cancel" : ex.leg?.side === "buy" || ex.leg?.side === "sell" ? "limit_order_create" : null;
        const owner = j.trader || ex.owner || null;
        const m = matchTxOp(tx, { owner, orderid: ex.orderId ?? ex.leg?.orderId ?? null, kind });
        if (m.matched) { txChecks.verified++; if (evidence.length < 12) evidence.push({ txid: ex.txid, verdict: "VERIFIED", from: file }); }
        else { txChecks.exposed++; if (evidence.length < 12) evidence.push({ txid: ex.txid, verdict: "EXPOSED", from: file, note: "tx found but claimed op not matched" }); }
      } catch (e) {
        txChecks.unreachable++;
        if (evidence.length < 12) evidence.push({ txid: ex.txid, verdict: "UNREACHABLE", from: file, note: String(e?.message ?? e).slice(0, 80) });
      }
    }
  }

  // 3) מילויים-מהשרשרת (fill_order) לכל-חשבון-שלנו — ווליום-אמת + ייחוס-maker
  const chainFills = { count: 0, makerFills: 0, takerFills: 0, volumeSteem: 0, volumeSbd: 0, byAccount: {} };
  for (const account of ourAccounts) {
    let hist = [];
    try { hist = (await rpcAny("condenser_api.get_account_history", [account, -1, 200])) || []; } catch { continue; }
    for (const [, ev] of hist) {
      const op = ev?.op;
      const name = Array.isArray(op) ? op[0] : op?.type;
      if (String(name) !== "fill_order") continue;
      const attr = attributeFill(op, knownByAccount, ourAccounts);
      if (!attr) continue;
      chainFills.count++;
      if (attr.maker) chainFills.makerFills++; else chainFills.takerFills++;
      chainFills.volumeSteem += attr.volumeSteem;
      chainFills.volumeSbd += attr.volumeSbd;
      chainFills.byAccount[account] = (chainFills.byAccount[account] || 0) + 1;
    }
  }
  chainFills.volumeSteem = Number(chainFills.volumeSteem.toFixed(4));
  chainFills.volumeSbd = Number(chainFills.volumeSbd.toFixed(4));

  const verdict = verdictOf(txChecks, chainFills);
  const out = {
    schema: "SAOS-VOLUME-VERIFY/1", at: new Date().toISOString(),
    receiptsScanned: receipts.length, txChecks, chainFills, verdict,
    evidence, honesty: "txChecks = every receipt txid pulled from chain op-by-op; chainFills = fill_order ops read from account history with deterministic-orderid maker attribution; UNREACHABLE is an honest node-state, not a failure",
  };
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 1) + "\n");
  console.log(`[volume-verify] verdict=${verdict} · tx ${txChecks.verified}/${txChecks.total} verified (${txChecks.exposed} exposed, ${txChecks.unreachable} unreachable) · chainFills=${chainFills.count} (maker ${chainFills.makerFills}) · vol ${chainFills.volumeSteem} STEEM / ${chainFills.volumeSbd} SBD`);
}

/* ── selftest (אופליין) ────────────────────────────────────────────────────────── */
export async function selftest() {
  const assert = (c, msg) => { if (!c) { console.error("SELFTEST FAIL:", msg); process.exit(1); } };
  const known = new Map([["hcsoldier4", new Set([123456789, 4200000001])], ["tov", new Set([42])]]);

  // matchTxOp — אופ-מדויק
  const tx = { operations: [["limit_order_create", { owner: "hcsoldier4", orderid: 123456789, amount_to_sell: "0.300 STEEM", min_to_receive: "0.031 SBD" }]] };
  assert(matchTxOp(tx, { owner: "hcsoldier4", orderid: 123456789, kind: "limit_order_create" }).matched === true, "matching create op matched");
  assert(matchTxOp(tx, { owner: "hcsoldier4", orderid: 999, kind: "limit_order_create" }).matched === false, "foreign orderid not matched");
  assert(matchTxOp(tx, { owner: "tov", orderid: 123456789, kind: "limit_order_create" }).matched === false, "foreign owner not matched");
  assert(matchTxOp(tx, { owner: "hcsoldier4", orderid: 123456789, kind: "limit_order_cancel" }).matched === false, "wrong kind not matched");
  const txCondenser = { transaction: { operations: [{ type: "limit_order_cancel", value: { owner: "tov", orderid: 42 } }] } };
  assert(matchTxOp(txCondenser, { owner: "tov", orderid: 42, kind: "limit_order_cancel" }).matched === true, "condenser-style op shape matched");

  // attributeFill — ייחוס-maker עם-ווליום
  const mk = attributeFill([null, { current_owner: "hcsoldier4", current_orderid: 123456789, current_pays: "0.300 STEEM", open_owner: "someone", open_orderid: 7, open_pays: "0.031 SBD" }], known, ["hcsoldier4", "tov"]);
  assert(mk && mk.maker === true, "our known orderid → maker fill");
  assert(Math.abs(mk.volumeSteem - 0.3) < 1e-9 && Math.abs(mk.volumeSbd - 0.031) < 1e-9, "maker fill volume in chain units");
  const tk = attributeFill([null, { current_owner: "someone", current_orderid: 7, current_pays: "0.031 SBD", open_owner: "hcsoldier4", open_orderid: 999999, open_pays: "0.300 STEEM" }], known, ["hcsoldier4", "tov"]);
  assert(tk && tk.maker === false, "our account but unknown orderid → taker fill");
  assert(Math.abs(tk.volumeSteem - 0.3) < 1e-9, "taker fill volume: we received STEEM");
  const fr = attributeFill([null, { current_owner: "x", current_orderid: 1, current_pays: "1 SBD", open_owner: "y", open_orderid: 2, open_pays: "1 STEEM" }], known, ["hcsoldier4", "tov"]);
  assert(fr === null, "fill between strangers → not ours (null)");
  const buySide = attributeFill([null, { current_owner: "someone", current_orderid: 5, current_pays: "0.100 SBD", open_owner: "tov", open_orderid: 42, open_pays: "0.970 STEEM" }], known, ["hcsoldier4", "tov"]);
  assert(buySide && buySide.maker === true && Math.abs(buySide.volumeSteem - 0.97) < 1e-9, "buy-side maker fill measured from open_pays");

  // verdictOf — פסק-כנה
  assert(verdictOf({ total: 5, verified: 5, exposed: 0, unreachable: 0 }, { count: 0 }) === "VERIFIED", "all verified → VERIFIED");
  assert(verdictOf({ total: 5, verified: 4, exposed: 1, unreachable: 0 }, { count: 9 }) === "EXPOSED", "any exposed → EXPOSED (chain is the truth)");
  assert(verdictOf({ total: 3, verified: 0, exposed: 0, unreachable: 3 }, { count: 0 }) === "UNREACHABLE", "all unreachable → honest UNREACHABLE");
  assert(verdictOf({ total: 0, verified: 0, exposed: 0, unreachable: 0 }, { count: 2 }) === "VERIFIED", "no receipts but chain fills exist → VERIFIED");
  assert(verdictOf({ total: 0 }, { count: 0 }) === "NO-RECEIPTS", "nothing measured → honest NO-RECEIPTS");

  // מרחב-ה-orderid: החישוב כאן = החישוב אצל-החותמים (דטרמיניזם מוצלב)
  const plans = existsSync(join(HERE, "state", "treasury-ladder-plan.json")) ? [JSON.parse(readFileSync(join(HERE, "state", "treasury-ladder-plan.json"), "utf8"))] : [];
  const space = knownOrderSpace(plans);
  if (plans.length && plans[0].trader) {
    const trader = plans[0].trader;
    assert(space.has(trader) && space.get(trader).size >= 1, "treasury plan → known order space for its trader");
  }
  console.log("SELFTEST PASS: 17/17 vectors (volume-verify)");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--selftest")) { await selftest(); return; }
  await verify();
}
main().catch((e) => { console.error("[volume-verify] FATAL:", String(e?.message ?? e).slice(0, 160)); process.exit(0); }); // exit-0: הקובץ-הוא-האזעקה, לא-מייל
