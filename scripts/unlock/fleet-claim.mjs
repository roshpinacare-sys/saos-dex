// fleet-claim.mjs — פתיחת-מסילת-הצי: claims-פנדינג + (אופציונלי) sweep-נזיל-מדוד ל-headcorner
// אפס-סודות-בפלט: רק-txids+שמות+סכומים. fail-closed לכל-חשבון.
import { readFileSync } from "node:fs";
import steem from "steem";

// §83 NODE-ROTATION (חוק-§78)
const NODES = ["https://api.steemitdev.com", "https://api.steemit.com", "https://steem.justyy.com", "https://api.steem.fans"];
let NODEI = 0;
const HEAD = "headcorner";
// §83: sweep-הכל (המבצעים מקבלים-RC-מהצמדת-SP של fleet-post · לא-צריכים-נזיל)
const KEEP = new Set((process.env.SWEEP_KEEP || "").split(",").map(s => s.trim()).filter(Boolean));
const SWEEP = process.env.SWEEP === "true";
const KEEP_AMT = 0.05;

async function rpc(method, params) {
  let last = null;
  for (let i = 0; i < NODES.length; i++) {
    const u = NODES[(NODEI + i) % NODES.length];
    try {
      const r = await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }), signal: AbortSignal.timeout(20000) });
      const j = await r.json(); if (j.error) throw new Error(String(j.error?.message || j.error).slice(0, 120)); NODEI = (NODEI + i) % NODES.length; return j.result;
    } catch (e) { last = e; }
  }
  throw last;
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
  // §83: fallback-wif — try active then posting (fix-82: cashmachine/siq/woq)
  try {
    if (pend > 0) {
      const wifs = [activeWif, wif, roles.owner].filter(Boolean).filter((w, i, arr) => arr.indexOf(w) === i); // §83: owner-פותר-הכל (הוכח-ריצה-6)
      let txid = null, lastErr = null;
      for (const w of wifs) {
        try { txid = await broadcast([["claim_reward_balance", { account: a.name, reward_steem: a.reward_steem_balance, reward_sbd: a.reward_sbd_balance, reward_vests: a.reward_vesting_balance }]], w); break; }
        catch (e) { lastErr = e; }
      }
      if (txid) { console.log(`CLAIM ${a.name} vests=${a.reward_vesting_balance} steem=${a.reward_steem_balance} sbd=${a.reward_sbd_balance} → txid=${txid}`); claims++; }
      else console.log(`CLAIM-FAIL ${a.name}: ${String(lastErr?.message || lastErr).slice(0, 100)}`);
    }
  } catch (e) { console.log(`CLAIM-FAIL ${a.name}: ${String(e.message || e).slice(0, 100)}`); }
  try {
    // §85: transfer-דומיין-active — owner-פותר-הכל (הוכח: fleet-cancel «owner-גם-עובד» + POST owner-ריצות)
    const wifs = [roles.active, roles.owner].filter(Boolean).filter((w, i, arr) => arr.indexOf(w) === i);
    if (SWEEP && wifs.length && !KEEP.has(a.name)) {
      const st = parseFloat(a.balance || "0") - KEEP_AMT, sb = parseFloat(a.sbd_balance || "0") - KEEP_AMT;
      const ops = [];
      if (st >= 0.05) ops.push(["transfer", { from: a.name, to: HEAD, amount: st.toFixed(3) + " STEEM", memo: "fleet-sweep-83" }]);
      if (sb >= 0.05) ops.push(["transfer", { from: a.name, to: HEAD, amount: sb.toFixed(3) + " SBD", memo: "fleet-sweep-83" }]);
      if (ops.length) {
        let txid = null, lastErr = null;
        for (const w of wifs) {
          try { txid = await broadcast(ops, w); break; } catch (e) { lastErr = e; }
        }
        if (txid) { console.log(`SWEEP ${a.name} ${ops.map(o => o[1].amount).join("+")} → headcorner txid=${txid}`); sweeps++; sweepSteem += Math.max(0, st); sweepSbd += Math.max(0, sb); }
        else console.log(`SWEEP-FAIL ${a.name}: ${String(lastErr?.message || lastErr).slice(0, 100)}`);
      }
    }
  } catch (e) { console.log(`SWEEP-FAIL ${a.name}: ${String(e.message || e).slice(0, 100)}`); }
}
console.log(`VERDICT-CLAIMS: ${claims} claimed · VERDICT-SWEEP: ${sweeps} swept (Σ≈${sweepSteem.toFixed(3)} STEEM + ${sweepSbd.toFixed(3)} SBD)`);
