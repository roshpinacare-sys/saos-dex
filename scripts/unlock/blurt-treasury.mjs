// blurt-treasury.mjs — מסילת-ה-blurt (מטבע-שלישי): סריקה + claim-אם-יש-פנדינג
// אפס-סודות-בפלט · fail-closed מלא
import steem from "steem";
const BLURT = "https://api.blurt.world";
const BLURT_CHAIN_ID = process.env.BLURT_CHAIN_ID || "cdfddd8e534c5c0d1297cdf55dbfdcef9e83f541b176bf3cae4c2f3eb"; // ציבורי-ברשת
const ROSTER = ["headcorner", "cashmachine", "haran", "israelnews", "lsa", "macrame", "siq", "tov", "wic", "wog", "woq", "hcsoldier4", "hcsoldier5", "hcsoldier6"];

async function rpc(method, params) {
  const r = await fetch(BLURT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }), signal: AbortSignal.timeout(20000) });
  const j = await r.json(); if (j.error) throw new Error(String(j.error?.message || j.error).slice(0, 120)); return j.result;
}
async function blurtBroadcast(ops, wif) {
  const dgp = await rpc("condenser_api.get_dynamic_global_properties", []);
  const tx = { ref_block_num: dgp.head_block_number & 0xffff, ref_block_prefix: Buffer.from(dgp.head_block_id, "hex").readUInt32LE(4), expiration: new Date(new Date(dgp.time + "Z").getTime() + 60000).toISOString().slice(0, 19), operations: ops, extensions: [] };
  const prev = steem.config.get("chain_id");
  steem.config.set("chain_id", BLURT_CHAIN_ID);
  let signed;
  try { signed = steem.auth.signTransaction(tx, [wif]); } finally { try { steem.config.set("chain_id", prev || "0000000000000000000000000000000000000000000000000000000000000000"); } catch {} }
  return (await rpc("condenser_api.broadcast_transaction_synchronous", [{ ...signed }]))?.id ?? "no-id";
}

const wif = process.env.BLURT_ACTIVE_WIF || process.env.BLURT_POSTING_WIF || null;
if (!wif) { console.log("VERDICT-BLURT: no-key (honest)"); process.exit(0); }
const accs = await rpc("condenser_api.get_accounts", [ROSTER]).catch(() => null);
if (!accs) { console.log("VERDICT-BLURT: rpc-unreachable (honest)"); process.exit(0); }
let claims = 0;
for (const a of accs) {
  const pend = parseFloat(a.reward_vesting_balance || "0") + parseFloat(a.reward_steem_balance || "0") + parseFloat(a.reward_sbd_balance || "0");
  if (pend > 0) {
    try {
      const txid = await blurtBroadcast([["claim_reward_balance", { account: a.name, reward_steem: a.reward_steem_balance, reward_sbd: a.reward_sbd_balance, reward_vests: a.reward_vesting_balance }]], wif);
      console.log(`BLURT-CLAIM ${a.name} vests=${a.reward_vesting_balance} blurt=${a.reward_steem_balance} → txid=${txid}`); claims++;
    } catch (e) { console.log(`BLURT-CLAIM-FAIL ${a.name}: ${String(e.message || e).slice(0, 100)}`); }
  } else console.log(`BLURT ${a.name}: bal=${a.balance} vest=${a.vesting_shares} pending=0`);
}
console.log(`VERDICT-BLURT: ${claims} claims`);
