// fleet-claim.mjs — פתיחת-מסילת-הצי: claims-פנדינג + (אופציונלי) sweep-נזיל-מדוד ל-headcorner
// אפס-סודות-בפלט: רק-txids+שמות+סכומים. fail-closed לכל-חשבון.
import { readFileSync } from "node:fs";
import steem from "steem";

const NODE = "https://api.steemit.com";
const HEAD = "headcorner";
const KEEP = new Set((process.env.SWEEP_KEEP || "hcsoldier4,hcsoldier5,hcsoldier6,tov,israelnews,saos-0001,saos-0002,saos-0003,saos-0004").split(",").map(s => s.trim()));
const SWEEP = process.env.SWEEP === "true";
const KEEP_AMT = 0.05;

async function rpc(method, params) {
  const r = await fetch(NODE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }), signal: AbortSignal.timeout(20000) });
  const j = await r.json(); if (j.error) throw new Error(String(j.error?.message || j.error).slice(0, 120)); return j.result;
}
async function broadcast(ops, wif) {
  const dgp = await rpc("condenser_api.get_dynamic_global_properties", []);
  const tx = { ref_block_num: dgp.head_block_number & 0xffff, ref_block_prefix: Buffer.from(dgp.head_block_id, "hex").readUInt32LE(4), expiration: new Date(new Date(dgp.time + "Z").getTime() + 60000).toISOString().slice(0, 19), operations: ops, extensions: [] };
  const signed = steem.auth.signTransaction(tx, [wif]);
  const res = await rpc("condenser_api.broadcast_transaction_synchronous", [{ ...signed }]);
  return res?.id ?? "no-id";
}

let map = {};
try { map = JSON.parse(readFileSync("/tmp/live-map.json", "utf8")); } catch { console.log("VERDICT-CLAIMS: no-map (census failed) honest-abort"); process.exit(0); }
const entries = Object.entries(map).filter(([acc]) => !acc.includes(":"));
console.log(`fleet-claim: ${entries.length} accounts in live map: ${entries.map(([a]) => a).join(",")}`);
const names = entries.map(([a]) => a);
const accs = await rpc("condenser_api.get_accounts", [names]).catch(() => []);
let claims = 0, sweeps = 0, sweepSteem = 0, sweepSbd = 0;
for (const a of accs ?? []) {
  const roles = map[a.name] || {};
  const wif = roles.posting || roles.active;
  const activeWif = roles.active;
  const pend = parseFloat(a.reward_vesting_balance || "0") + parseFloat(a.reward_steem_balance || "0") + parseFloat(a.reward_sbd_balance || "0");
  try {
    if (pend > 0 && wif) {
      const txid = await broadcast([["claim_reward_balance", { account: a.name, reward_steem: a.reward_steem_balance, reward_sbd: a.reward_sbd_balance, reward_vests: a.reward_vesting_balance }]], wif);
      console.log(`CLAIM ${a.name} vests=${a.reward_vesting_balance} steem=${a.reward_steem_balance} sbd=${a.reward_sbd_balance} → txid=${txid}`);
      claims++;
    }
  } catch (e) { console.log(`CLAIM-FAIL ${a.name}: ${String(e.message || e).slice(0, 100)}`); }
  try {
    if (SWEEP && activeWif && !KEEP.has(a.name)) {
      const st = parseFloat(a.balance || "0") - KEEP_AMT, sb = parseFloat(a.sbd_balance || "0") - KEEP_AMT;
      const ops = [];
      if (st >= 0.05) ops.push(["transfer", { from: a.name, to: HEAD, amount: st.toFixed(3) + " STEEM", memo: "fleet-sweep-82" }]);
      if (sb >= 0.05) ops.push(["transfer", { from: a.name, to: HEAD, amount: sb.toFixed(3) + " SBD", memo: "fleet-sweep-82" }]);
      if (ops.length) {
        const txid = await broadcast(ops, activeWif);
        console.log(`SWEEP ${a.name} ${ops.map(o => o[1].amount).join("+")} → headcorner txid=${txid}`);
        sweeps++; sweepSteem += Math.max(0, st); sweepSbd += Math.max(0, sb);
      }
    }
  } catch (e) { console.log(`SWEEP-FAIL ${a.name}: ${String(e.message || e).slice(0, 100)}`); }
}
console.log(`VERDICT-CLAIMS: ${claims} claimed · VERDICT-SWEEP: ${sweeps} swept (Σ≈${sweepSteem.toFixed(3)} STEEM + ${sweepSbd.toFixed(3)} SBD)`);
