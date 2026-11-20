// hive-savings.mjs — §84 מסילת-ריבית-HBD: הפקדה-ל-savings בריבית-10% (hbd_interest_rate=1000bps מדיד 2026-11-20)
// §84b חוזק: אסלת-מפתחות + verify_authority-על-הצומת-לפני-שידור + אבחון-required-signatures-אם-נכשל.
// משיכה-אפשרית-תוך-3-ימים — לא-נעילה. אפס-סודות-בפלט.
import { readFileSync } from "node:fs";
import steem from "steem";

const HIVE = "https://api.hive.blog";
const HIVE_CHAIN_ID = "beeab0de00000000000000000000000000000000000000000000000000000000";
const ACCOUNT = process.env.HIVE_ACCOUNT || "headcorner";

async function rpc(method, params) {
  const r = await fetch(HIVE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }), signal: AbortSignal.timeout(20000) });
  const j = await r.json(); if (j.error) throw new Error(String(j.error?.message || j.error).slice(0, 140)); return j.result;
}
function txShell(dgp, ops) {
  return { ref_block_num: dgp.head_block_number & 0xffff, ref_block_prefix: Buffer.from(dgp.head_block_id, "hex").readUInt32LE(4), expiration: new Date(new Date(dgp.time + "Z").getTime() + 60000).toISOString().slice(0, 19), operations: ops, extensions: [] };
}
function signWith(tx, wifs) {
  const prev = steem.config.get("chain_id");
  steem.config.set("chain_id", HIVE_CHAIN_ID);
  try { return steem.auth.signTransaction(JSON.parse(JSON.stringify(tx)), wifs); } finally { try { steem.config.set("chain_id", prev || "0000000000000000000000000000000000000000000000000000000000000000"); } catch {} }
}

const cands = [];
if (process.env.HIVE_ACTIVE_WIF) cands.push({ tag: "env-active", wif: process.env.HIVE_ACTIVE_WIF });
if (process.env.HIVE_POSTING_WIF) cands.push({ tag: "env-posting", wif: process.env.HIVE_POSTING_WIF });
try { const map = JSON.parse(readFileSync("/tmp/live-map.json", "utf8")); const h = map["hive:" + ACCOUNT]; if (h?.active) cands.push({ tag: "map-active", wif: h.active }); if (h?.posting) cands.push({ tag: "map-posting", wif: h.posting }); if (h?.owner) cands.push({ tag: "map-owner", wif: h.owner }); } catch {}
const uniq = new Map();
for (const c of cands) { try { const pub = steem.auth.wifToPublic(c.wif); const short = pub.slice(3, 11); if (!uniq.has(short)) uniq.set(short, { ...c, pub: short }); } catch {} }
const wifs = [...uniq.values()];
if (!wifs.length) { console.log("VERDICT-HIVE-SAVINGS: no-decodable-key honest-abort"); process.exit(1); }

const acc = (await rpc("condenser_api.get_accounts", [[ACCOUNT]]))[0];
const dgp = await rpc("condenser_api.get_dynamic_global_properties", []);
const aprBps = dgp.hbd_interest_rate;
const liquid = parseFloat(acc.hbd_balance);
console.log(`hive-savings: ${ACCOUNT} liquid=${acc.hbd_balance} savings=${acc.savings_hbd_balance} · APR=${(aprBps / 100).toFixed(1)}% · key-ladder=${wifs.map(w => w.tag + ":" + w.pub).join(" ")}`);

if (!(liquid >= 0.001)) { console.log("VERDICT-HIVE-SAVINGS: liquid<0.001-HBD honest-skip (rail armed, no fuel)"); process.exit(0); }
const amt = `${liquid.toFixed(3)} HBD`;
const tx = txShell(dgp, [["transfer_to_savings", { from: ACCOUNT, to: ACCOUNT, amount: amt, memo: "saos84 hbd savings interest rail" }]]);

let ok = null;
for (const combo of [wifs.map(w => w.wif), wifs.filter(w => /active|owner/.test(w.tag)).map(w => w.wif)]) {
  if (!combo.length) continue;
  const signed = signWith(tx, combo);
  const v = await rpc("condenser_api.verify_authority", [{ ...signed }]).catch(e => ({ err: String(e.message).slice(0, 80) }));
  console.log(`verify_authority(combo=${combo.length}-keys): ${JSON.stringify(v).slice(0, 80)}`);
  if (v === true) { ok = signed; break; }
}
if (!ok) {
  try { const req = await rpc("condenser_api.get_required_signatures", [{ ...tx }, wifs.map(w => w.pub)]).catch(() => null); console.log(`diagnostic-required: ${JSON.stringify(req).slice(0, 140)}`); } catch {}
  const acct = (await rpc("condenser_api.get_accounts", [[ACCOUNT]]))[0];
  console.log(`diagnostic-chain-auth: active=${JSON.stringify(acct.active.key_auths.map(k => [k[0].slice(3, 11), k[1]]))} thr=${acct.active.weight_threshold} · our-pubs=${wifs.map(w => w.pub).join(",")}`);
  console.log("VERDICT-HIVE-SAVINGS: chain-rejects-all-signatures (fail-closed, honest)");
  process.exit(2);
}
try {
  const res = await rpc("condenser_api.broadcast_transaction_synchronous", [{ ...ok }]);
  const yearly = liquid * (aprBps / 10000);
  console.log(`HIVE-SAVINGS-DEPOSIT ${amt} → txid=${res?.id ?? "no-id"} · expected-interest≈${yearly.toFixed(5)}-HBD/year (real on-chain APR ${aprBps}bps)`);
  console.log("VERDICT-HIVE-SAVINGS: SUCCESS (10% APR rail armed · withdrawal-possible-3d)");
} catch (e) { console.log(`VERDICT-HIVE-SAVINGS: broadcast-fail ${String(e.message || e).slice(0, 130)}`); process.exit(2); }
