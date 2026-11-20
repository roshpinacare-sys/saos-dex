// fleet-cancel.mjs — §83: ביטול-פקודות-ישנות-של-הצי בספר-הפנימי (נזילות-פזורה-נעולה)
// מדיד-§83: 13-חשבונות-צי מחזיקים ~28.9-STEEM+0.58-SBD בפקודות-מהעידנים-קודמים.
// FIX-83: שם-ה-op הנכון = limit_order_cancel (cancel_order אינו-op-בשרשרת!) · cancel=דומיין-active (owner-גם-עובד).
// אפס-סודות-בפלט: רק-שמות+orderids+txids. fail-closed לכל-חשבון.
import { readFileSync } from "node:fs";
import steem from "steem";

// §83 NODE-ROTATION (חוק-§78)
const NODES = ["https://api.steemitdev.com", "https://api.steemit.com", "https://steem.justyy.com", "https://api.steem.fans"];
let NODEI = 0;
const HEAD = "headcorner"; // אסור-לגעת — סולם-המנוע-החי

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
try { map = JSON.parse(readFileSync("/tmp/live-map.json", "utf8")); } catch { console.log("VERDICT-CANCEL: no-map (census failed) honest-abort"); process.exit(0); }
const entries = Object.entries(map).filter(([acc]) => !acc.includes(":") && acc !== HEAD);
console.log(`fleet-cancel: scanning ${entries.length} accounts for stale orders (op=limit_order_cancel)`);

let cancelled = 0, freed = 0;
for (const [acc, roles] of entries) {
  const wifs = [roles.active, roles.owner].filter(Boolean).filter((w, i, a) => a.indexOf(w) === i);
  if (!wifs.length) { console.log(`CANCEL-SKIP ${acc}: no-active-domain-wif`); continue; }
  try {
    const oo = await rpc("condenser_api.get_open_orders", [acc]);
    if (!oo?.length) continue;
    for (const o of oo) {
      let done = false, lastErr = null;
      for (const wif of wifs) {
        try {
          const txid = await broadcast([["limit_order_cancel", { owner: acc, orderid: o.orderid }]], wif);
          console.log(`CANCEL ${acc} orderid=${o.orderid} base=${o.sell_price.base} → txid=${txid}`);
          cancelled++; done = true;
          try { freed += parseFloat(o.sell_price.base.split(" ")[0]); } catch {}
          break;
        } catch (e) { lastErr = e; }
      }
      if (!done) console.log(`CANCEL-FAIL ${acc} orderid=${o.orderid}: ${String(lastErr?.message || lastErr).slice(0, 90)}`);
      await new Promise(r => setTimeout(r, 1200));
    }
  } catch (e) { console.log(`SCAN-FAIL ${acc}: ${String(e.message || e).slice(0, 90)}`); }
}
console.log(`VERDICT-CANCEL: ${cancelled} orders cancelled · freed-Σbase≈${freed.toFixed(3)} (STEEM/SBD mixed)`);
