// hive-savings.mjs — §84 מסילת-ריבית-HBD: הפקדה-ל-savings בריבית-10% (hbd_interest_rate=1000bps מדיד 2026-11-20)
// fail-closed: wif→pub חייב-להופיע ב-active-authority על-הצומת-החי (משיכה-אפשרית-תוך-3-ימים — לא-נעילה).
// אפס-סודות-בפלט: רק-txid+סכומים+טביעות-אצבע-פומביות.
import { readFileSync } from "node:fs";
import steem from "steem";

const HIVE = "https://api.hive.blog";
const HIVE_CHAIN_ID = "beeab0de00000000000000000000000000000000000000000000000000000000";
const ACCOUNT = process.env.HIVE_ACCOUNT || "headcorner";

async function rpc(method, params) {
  const r = await fetch(HIVE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }), signal: AbortSignal.timeout(20000) });
  const j = await r.json(); if (j.error) throw new Error(String(j.error?.message || j.error).slice(0, 120)); return j.result;
}
async function hiveBroadcast(ops, wif) {
  const dgp = await rpc("condenser_api.get_dynamic_global_properties", []);
  const tx = { ref_block_num: dgp.head_block_number & 0xffff, ref_block_prefix: Buffer.from(dgp.head_block_id, "hex").readUInt32LE(4), expiration: new Date(new Date(dgp.time + "Z").getTime() + 60000).toISOString().slice(0, 19), operations: ops, extensions: [] };
  const prev = steem.config.get("chain_id");
  steem.config.set("chain_id", HIVE_CHAIN_ID);
  let signed;
  try { signed = steem.auth.signTransaction(tx, [wif]); } finally { try { steem.config.set("chain_id", prev || "0000000000000000000000000000000000000000000000000000000000000000"); } catch {} }
  return (await rpc("condenser_api.broadcast_transaction_synchronous", [{ ...signed }]))?.id ?? "no-id";
}

// מקורות-מפתח: env-מפורש → live-map של-ה-census (מאומת-מול-השרשרת) → כשל-כנה
const wifCands = [];
if (process.env.HIVE_ACTIVE_WIF) wifCands.push({ tag: "env-active", wif: process.env.HIVE_ACTIVE_WIF });
try { const map = JSON.parse(readFileSync("/tmp/live-map.json", "utf8")); const h = map["hive:" + ACCOUNT]; if (h?.active) wifCands.push({ tag: "map-active", wif: h.active }); } catch {}
if (!wifCands.length) { console.log("VERDICT-HIVE-SAVINGS: no-key (honest abort)"); process.exit(1); }

const acc = (await rpc("condenser_api.get_accounts", [[ACCOUNT]]))[0];
const dgp = await rpc("condenser_api.get_dynamic_global_properties", []);
const aprBps = dgp.hbd_interest_rate;
const liquid = parseFloat(acc.hbd_balance);
const activePubs = (acc.active?.key_auths || []).map(k => k[0]);
console.log(`hive-savings: ${ACCOUNT} liquid=${acc.hbd_balance} savings=${acc.savings_hbd_balance} · APR=${(aprBps / 100).toFixed(1)}%`);

// המרת-WIF→pub היא-בלי-chain-id · אימות-mut-החי
let wif = null, wifTag = "";
for (const c of wifCands) {
  let pub = "";
  try { pub = steem.auth.wifToPublic(c.wif); } catch { continue; }
  if (activePubs.includes(pub)) { wif = c.wif; wifTag = c.tag; break; }
}
if (!wif) { console.log(`VERDICT-HIVE-SAVINGS: no-active-authority-match (${wifCands.length} candidates, pubs ${activePubs.map(p => p.slice(3, 11)).join(",")}) fail-closed`); process.exit(2); }
console.log(`active-authority-match: TRUE via ${wifTag} (pub ${steem.auth.wifToPublic(wif).slice(3, 11)}…)`);

if (!(liquid >= 0.001)) { console.log("VERDICT-HIVE-SAVINGS: liquid<0.001-HBD honest-skip (rail armed, no fuel)"); process.exit(0); }
const amt = `${liquid.toFixed(3)} HBD`;
try {
  const txid = await hiveBroadcast([["transfer_to_savings", { from: ACCOUNT, to: ACCOUNT, amount: amt, memo: "saos84 hbd savings 10apr rail" }]], wif);
  const yearly = liquid * (aprBps / 10000);
  console.log(`HIVE-SAVINGS-DEPOSIT ${amt} → txid=${txid} · expected-interest≈${yearly.toFixed(5)}-HBD/year (real on-chain APR ${aprBps}bps)`);
  console.log("VERDICT-HIVE-SAVINGS: SUCCESS (10% APR rail armed · withdrawal-possible-3d)");
} catch (e) { console.log(`VERDICT-HIVE-SAVINGS: FAIL ${String(e.message || e).slice(0, 120)}`); process.exit(2); }
