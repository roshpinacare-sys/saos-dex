// hive-post.mjs — §86: מסילת-תוכן-HIVE (הדלת-חסרת-ההון-היחידה-שנותרה: כלכלת-האוצרים של-hive)
// comment-ואין-נכסים → אותה-סריאליזציה כמו vote (steem-js chain_id swap · הוכח-§84-H)
// אפס-סודות-בפלט · fail-closed · maker-of-attention: תוכן-מדוד לתגיות-עם-אוצרים-חיים
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

let wif = process.env.HIVE_POSTING_WIF || process.env.HIVE_ACTIVE_WIF || null;
if (!wif) { try { const map = JSON.parse(readFileSync("/tmp/live-map.json", "utf8")); wif = map["hive:" + ACCOUNT]?.posting || map["hive:" + ACCOUNT]?.active || null; } catch {} }
if (!wif) { console.log("VERDICT-HIVE-POST: no-key (honest abort)"); process.exit(1); }

const acc = (await rpc("condenser_api.get_accounts", [[ACCOUNT]]))[0];
const rcPct = parseFloat(acc.rc_manabar?.current_mana || "0") / Math.max(1, parseFloat(acc.rc_manabar?.max_mana || "1")) * 100;
console.log(`hive-post: ${ACCOUNT} · RC=${rcPct.toFixed(1)}% · posts-so-far=${acc.post_count}`);
const dayStamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");

// תוכן-מדוד: פוסט-יומי בתג-מטבע-חי + 2-תגובות-עומק על-פוסטים-חיים (תגובות-מרוויחות-אוצרים-גם)
const TOPICS = [
  { tag: "photography", title: "Market Notes: What a Quiet Order Book Teaches About Patience", body: "The internal market for attention and for assets runs on the same law: the one who quotes consistently, gets filled. Today's ledger note — patience is a position, not a feeling.\n\nWhat did the market teach you this week?" },
  { tag: "life", title: "Daily Ledger: Small Consistent Moves Beat Big Rare Ones", body: "Every system that survives compounding does one thing: it shows up daily. Today's entry was placed, priced, and left to work. The rest is noise.\n\nWhat did you place today?" },
  { tag: "food", title: "Kitchen Economics: The Cheapest Meal That Still Feels Rich", body: "Restriction breeds creativity. Beans, slow heat, one good spice — dinner for cents that eats like a feast.\n\nWhat is your best low-cost dish?" },
];
let posted = 0;
const topic = TOPICS[parseInt(dayStamp, 10) % TOPICS.length];
const permlink = `saos-${topic.tag}-${dayStamp}`;
try {
  const exists = await rpc("condenser_api.get_content", [ACCOUNT, permlink]);
  if (!exists || exists.author !== ACCOUNT) {
    const txid = await hiveBroadcast([["comment", { parent_author: "", parent_permlink: topic.tag, author: ACCOUNT, permlink, title: topic.title, body: `${topic.body}\n\n— ${ACCOUNT} · daily ledger ${dayStamp}Z`, json_metadata: JSON.stringify({ tags: [topic.tag, "proofofbrain", "life"], app: "saos-fleet/1" }) }]], wif);
    console.log(`HIVE-POST @${ACCOUNT}/${permlink} [${topic.tag}] → txid=${txid}`);
    posted++;
  } else { console.log(`HIVE-POST skip: already posted today (${permlink})`); }
} catch (e) { console.log(`HIVE-POST-FAIL: ${String(e.message || e).slice(0, 110)}`); }
await new Promise(r => setTimeout(r, 1200));

// 2 תגובות-עומק — כל-תגובה-היא-זרע-אוצרים
let replied = 0;
const t0 = topic.tag;
const disc = (await rpc("condenser_api.get_discussions_by_created", [{ tag: t0, limit: 20 }]).catch(() => null)) ?? [];
for (const d of disc.slice(0, 6)) {
  if (replied >= 2) break;
  if (d.author === ACCOUNT) continue;
  if (d.active_votes.some(v => v.voter === ACCOUNT)) continue;
  const ageH = (Date.now() - Date.parse(d.created + "Z")) / 3.6e6;
  if (ageH < 0.5 || ageH > 30) continue;
  const body = d.body?.slice(0, 180)?.replace(/\n/g, " ") ?? "";
  const reply = `Solid entry. The ${t0} angle you took — the part about "${body.slice(0, 60)}" — is exactly what separates the posts that get curated from the ones that get scrolled past. Following for the next one.`;
  try {
    const rpermlink = `re-saos-${dayStamp}-${replied}-${Date.now().toString(36)}`;
    const txid = await hiveBroadcast([["comment", { parent_author: d.author, parent_permlink: d.permlink, author: ACCOUNT, permlink: rpermlink, title: "", body: reply, json_metadata: JSON.stringify({ tags: [t0], app: "saos-fleet/1" }) }]], wif);
    console.log(`HIVE-REPLY @${d.author}/${d.permlink.slice(0, 40)} (${ageH.toFixed(1)}h) → txid=${txid}`);
    replied++;
    await new Promise(r => setTimeout(r, 1500));
  } catch (e) { console.log(`HIVE-REPLY-FAIL @${d.author}: ${String(e.message || e).slice(0, 90)}`); }
}
console.log(`VERDICT-HIVE-POST: ${posted} posted · ${replied} replies · account=${ACCOUNT}`);
