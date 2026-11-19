// hive-vote.mjs — פתיחת-מסילת-ה-hive: קורצרציה-אמיתית-על-hive עם המפתחות-של-ה-runner
// chain_id=פורמט-ציבורי (beeab0de… genesis) · חתימה-מקומית · אפס-סודות-בפלט
import { readFileSync } from "node:fs";
import steem from "steem";

const HIVE = "https://api.hive.blog";
const HIVE_CHAIN_ID = "beeab0de00000000000000000000000000000000000000000000000000000000";
const ACCOUNT = process.env.HIVE_ACCOUNT || "headcorner";
const LIMIT = parseInt(process.env.HIVE_VOTE_LIMIT || "4", 10);

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

let wif = process.env.HIVE_POSTING_WIF || process.env.HIVE_ACTIVE_WIF || null;
if (!wif) { try { const map = JSON.parse(readFileSync("/tmp/live-map.json", "utf8")); wif = map["hive:" + ACCOUNT]?.posting || map["hive:" + ACCOUNT]?.active || null; } catch {} }
if (!wif) { console.log("VERDICT-HIVE: no-key (honest abort)"); process.exit(1); }

const acc = (await rpc("condenser_api.get_accounts", [[ACCOUNT]]))[0];
console.log(`hive-vote: ${ACCOUNT} · VP=${(acc.voting_power / 100).toFixed(1)}% · HP vests=${acc.vesting_shares}`);
const now = Date.now();
const cands = [];
for (const tag of ["photography", "travel", "life", "food", "nature", "proofofbrain"]) {
  for (const meth of ["condenser_api.get_discussions_by_pending_payouts", "condenser_api.get_discussions_by_created"]) {
    const arr = (await rpc(meth, [{ tag, limit: 15 }]).catch(() => null)) ?? [];
    for (const d of arr) {
      if (d.active_votes.some(v => v.voter === ACCOUNT)) continue;
      const ageH = (now - Date.parse(d.created + "Z")) / 3.6e6;
      if (ageH < 0.3 || ageH > 60) continue;
      const pend = parseFloat(d.pending_payout_value || "0");
      if (pend < 0.05) continue;
      const sumR = d.active_votes.reduce((s, v) => s + Number(BigInt(v.rshares)), 0);
      cands.push({ author: d.author, permlink: d.permlink, pend, votes: d.active_votes.length, sumR, ageH: +ageH.toFixed(1) });
    }
  }
}
cands.sort((a, b) => (b.pend / (b.sumR + 1)) - (a.pend / (a.sumR + 1)));
console.log(`candidates: ${cands.length} → top ${LIMIT}`);
let done = 0;
for (const c of cands.slice(0, LIMIT)) {
  try {
    const txid = await hiveBroadcast([["vote", { voter: ACCOUNT, author: c.author, permlink: c.permlink, weight: 10000 }]], wif);
    console.log(`HIVE-VOTE @${c.author}/${c.permlink.slice(0, 45)} · pending=$${c.pend.toFixed(2)} · ${c.votes}-votes · ${c.ageH}h → txid=${txid}`);
    done++;
    await new Promise(r => setTimeout(r, 1200));
  } catch (e) { console.log(`HIVE-VOTE-FAIL @${c.author}: ${String(e.message || e).slice(0, 100)}`); }
}
console.log(`VERDICT-HIVE: ${done}/${LIMIT} votes broadcast`);
