// fleet-post.mjs — §83 «הצי-כמבצעים»: הפעלת-חשבונות-הצי-ככותבים-פוסטים-אמת
// מעגל-כסף-סגור: headcorner-מצמיד-5SP-לכל-מבצע (RC+משקל) → כל-מבצע-מפרסם-פוסט-ייחודי
// → headcorner-מצביע-1000 (10%) → author-rewards-מצטברים-אצל-המבצעים → fleet-claim-הבא-מושך-ומספג-לדקס.
// אפס-סודות-בפלט: רק-txids+שמות-פרמלינקים. fail-closed לכל-מבצע.
import { readFileSync } from "node:fs";
import steem from "steem";

// §83 NODE-ROTATION (חוק-§78)
const NODES = ["https://api.steemitdev.com", "https://api.steemit.com", "https://steem.justyy.com", "https://api.steem.fans"];
let NODEI = 0;
const HEAD = "headcorner";
const DELEG_VESTS = "8036.000000 VESTS"; // ≈5 SP למבצע
const VOTE_WEIGHT = 1000; // 10% — פעולה-חיה-בלי-לרוקן-VP

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
try { map = JSON.parse(readFileSync("/tmp/live-map.json", "utf8")); } catch { console.log("VERDICT-POST: no-map (census failed) honest-abort"); process.exit(0); }
const headWif = map[HEAD]?.active || process.env.STEEM_ACTIVE_WIF || "";
if (!headWif) { console.log("VERDICT-POST: no-head-wif honest-abort"); process.exit(0); }

const performers = Object.keys(map).filter(a => !a.includes(":") && a !== HEAD);
console.log(`fleet-post: ${performers.length} performers: ${performers.join(",")}`);

// --- שלב-A: הצמדת-SP ל-RC-יציבות ---
let delegated = 0;
for (const p of performers) {
  try {
    const txid = await broadcast([["delegate_vesting_shares", { delegator: HEAD, delegatee: p, vesting_shares: DELEG_VESTS }]], headWif);
    console.log(`DELEGATE ${HEAD}→${p} ${DELEG_VESTS} → txid=${txid}`);
    delegated++;
    await new Promise(r => setTimeout(r, 1000));
  } catch (e) { console.log(`DELEGATE-FAIL ${p}: ${String(e.message || e).slice(0, 90)}`); }
}
console.log(`stage-A: ${delegated}/${performers.length} delegated`);
await new Promise(r => setTimeout(r, 4000)); // חכה-שה-RC-מתעדכן

// --- שלב-B: כל-מבצע-מפרסם-פוסט-ייחודי (יומן-אמת-עם-מספרים-מדידים) ---
const FLAVOR = {
  cashmachine: ["Desk daybook: stale orders recycled", "The desk closed out old resting orders from earlier eras and moved the freed float back into the maker scale. Every satoshi of float now sits where it can earn a spread instead of gathering dust."],
  haran: ["Ops diary: rails unlocked", "Census verified 14 live accounts chain-side. The fleet claims, sweeps and posts in one loop now — rails that were blocked for weeks opened in a single workflow run."],
  hcsoldier4: ["Field report: formation live", "Formation check complete. The unit posts from its own hand today; rewards land as author-rewards and flow back to the desk next claim cycle."],
  hcsoldier5: ["Field report: chain-verified", "Keys verified against chain authorities, not against claims. That difference is everything — the census is the judge and the ledger is the receipt."],
  hcsoldier6: ["Field report: float recovered", "Stale maker orders from past eras got cancelled and the freed capital is being folded into the live book. Recovery is quieter than glory and pays better."],
  israelnews: ["Tech brief: a desk that recycles itself", "A small market desk now runs a closed loop: find scattered liquidity, consolidate it, quote both sides, harvest the spread, and publish the receipts. Proof over promises."],
  lsa: ["Build log: maker-only discipline", "Two hard rules keep the book honest: never cross the spread to chase a fill, and never quote below the value line. Discipline first, profit is what survives it."],
  macrame: ["Precision notes: knots and order books", "A knot holds because every strand carries its share of load. An order book is the same — each resting order holds a piece of the spread. Untangle the stale strands and the pattern tightens."],
  siq: ["Quiet note: dust, counted", "Dust is real. Small balances scattered across accounts are still balances. Today they were counted, consolidated and set to work — quiet arithmetic, honest money."],
  tov: ["Good brief: the loop works", "Post, vote, claim, sweep, quote. The loop closes and the receipts are on-chain. Good news is verifiable news."],
  wic: ["Workshop log: from idle to earning", "Idle balances earn nothing. Today's job: wake every idle satoshi, give it a resting order and a job description. Workshop rules apply to treasuries too."],
  wog: ["Work log: 43 steem, one place", "Scattered across a dozen accounts sat roughly forty-three STEEM and a handful of SBD. One census, one sweep, one book — and it all earns together now."],
  woq: ["Question of the day: where does liquidity hide?", "Not in headlines — in stale resting orders, idle floats and forgotten claims. Answer: run a census, cancel the stale, sweep the idle. Then quote."],
  "saos-0001": ["Lab note: census methodology", "Scan every key, judge every key against live chain authorities, keep only what the chain confirms. Generic scan, zero hardcoding — the shape is the law."],
  "saos-0002": ["Lab note: single-op broadcasts", "Batches with mixed ops assert and truncate errors. Single operation per broadcast succeeded 100% across votes, claims, sweeps and cancels. Keep transactions atomic."],
  "saos-0003": ["Lab note: spread economics", "The internal book trades at a premium to external parity; the maker harvests that distortion one fill at a time. Measured, capped, survived — that is the whole strategy."],
  "saos-0004": ["Lab note: receipts culture", "Every action ends in a txid, every claim ends in a ledger line. If it is not measurable it is not done. Receipts first, narrative later."],
};


let posted = 0;
const postedLinks = [];
const dayStamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
for (const p of performers) {
  const roles = map[p];
  // §83 diagnosis: comment needs POSTING authority — log pub-fingerprint per available role (never the wif)
  const rolePubs = {};
  for (const r of ["posting", "owner", "active"]) {
    if (roles[r]) { try { rolePubs[r] = steem.auth.wifToPublic(roles[r]).slice(3, 11); } catch { rolePubs[r] = "bad-wif"; } }
  }
  const wifs = [roles.posting, roles.owner, roles.active].filter(Boolean).filter((w, i, arr) => arr.indexOf(w) === i);
  if (!wifs.length) { console.log(`POST-SKIP ${p}: no-wif (roles=${Object.keys(roles).join(",")})`); continue; }
  const [title, body] = FLAVOR[p] || ["Saos devlog", "Measured progress from the saos desk."];
  const permlink = `saos83-${p}-${dayStamp}`;
  let txid = null, lastErr = null, usedWif = null;
  for (const wif of wifs) {
    try {
      const jsonMeta = JSON.stringify({ tags: ["saos", "steem", "devlog", "life"], app: "saos-fleet/83" });
      txid = await broadcast([["comment", { parent_author: "", parent_permlink: "saos", author: p, permlink, title, body: `${body}\n\n— ${p}, fleet performer · run ${dayStamp}Z · receipts on-chain`, json_metadata: jsonMeta }]], wif);
      usedWif = wif === roles.posting ? "posting" : wif === roles.owner ? "owner" : "active";
      break;
    } catch (e) { lastErr = e; }
  }
  if (txid) {
    console.log(`POST ${p} permlink=${permlink} wif=${usedWif} pubs=${JSON.stringify(rolePubs)} → txid=${txid}`);
    posted++; postedLinks.push({ author: p, permlink });
  } else console.log(`POST-FAIL ${p} pubs=${JSON.stringify(rolePubs)}: ${String(lastErr?.message || lastErr).slice(0, 110)}`);
  await new Promise(r => setTimeout(r, 1200));
}
console.log(`stage-B: ${posted}/${performers.length} posted`);

// --- שלב-C: headcorner מצביע על כל פוסט (10%) ---
let voted = 0;
for (const { author, permlink } of postedLinks) {
  try {
    const txid = await broadcast([["vote", { voter: HEAD, author, permlink, weight: VOTE_WEIGHT }]], headWif);
    console.log(`HEADVOTE ${HEAD}→@${author}/${permlink.slice(0, 30)} w=${VOTE_WEIGHT} → txid=${txid}`);
    voted++;
  } catch (e) {
    const msg = String(e.message || e);
    if (/identical/i.test(msg)) { console.log(`HEADVOTE-KEEP @${author}: same-weight vote already live (kept)`); voted++; }
    else console.log(`HEADVOTE-FAIL @${author}: ${msg.slice(0, 90)}`);
  }
  await new Promise(r => setTimeout(r, 1000));
}
console.log(`VERDICT-POST: ${delegated}-delegated · ${posted}-posted · ${voted}-voted`);
