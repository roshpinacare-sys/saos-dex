// hive-maker.mjs — §84 מסילת-maker-צד-שני: הצבת-ביד+אסק-אמת-על-ספר-HIVE-הפנימי (HBD/HIVE)
// הספר-החי: touch≈0.5bps (עמוק!) · מלאי-אבק-אמת (0.034-HIVE/0.003-HBD) — רואים-מסילה, לא-מצפים-גודל.
// Z-80-maker-only: אף-הצבה-לא-חוצה-את-הטאץ' (ask>bestAsk · bid<bestBid) · fail-closed-active-authority.
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

const wifCands = [];
if (process.env.HIVE_ACTIVE_WIF) wifCands.push({ tag: "env-active", wif: process.env.HIVE_ACTIVE_WIF });
try { const map = JSON.parse(readFileSync("/tmp/live-map.json", "utf8")); const h = map["hive:" + ACCOUNT]; if (h?.active) wifCands.push({ tag: "map-active", wif: h.active }); } catch {}
if (!wifCands.length) { console.log("VERDICT-HIVE-MAKER: no-key (honest abort)"); process.exit(1); }

const acc = (await rpc("condenser_api.get_accounts", [[ACCOUNT]]))[0];
const activePubs = (acc.active?.key_auths || []).map(k => k[0]);
let wif = null, wifTag = "";
for (const c of wifCands) {
  let pub = "";
  try { pub = steem.auth.wifToPublic(c.wif); } catch { continue; }
  if (activePubs.includes(pub)) { wif = c.wif; wifTag = c.tag; break; }
}
if (!wif) { console.log("VERDICT-HIVE-MAKER: no-active-authority-match fail-closed"); process.exit(2); }
console.log(`hive-maker: ${ACCOUNT} liquid=${acc.balance}/${acc.hbd_balance} · active-match TRUE via ${wifTag}`);

const ob = await rpc("condenser_api.get_order_book", [1]);
const bestBid = parseFloat(ob.bids?.[0]?.real_price || "0"), bestAsk = parseFloat(ob.asks?.[0]?.real_price || "0");
if (!(bestBid > 0) || !(bestAsk > 0)) { console.log("VERDICT-HIVE-MAKER: book-unreadable honest-skip"); process.exit(0); }
console.log(`HIVE-book: bestBid=${bestBid.toFixed(6)} bestAsk=${bestAsk.toFixed(6)}`);

const hiveLiquid = parseFloat(acc.balance), hbdLiquid = parseFloat(acc.hbd_balance);
const asksHive = hiveLiquid > 0.005 ? (hiveLiquid - 0.001).toFixed(3) : "";
const bidsHbd = hbdLiquid >= 0.001 ? hbdLiquid.toFixed(3) : "";
const nowSec = Math.floor(Date.now() / 1000);
const exp = new Date(Date.now() + 15 * 864e5).toISOString().slice(0, 19);
let done = 0;

if (asksHive) {
  const px = bestAsk * 1.004; // מעל-הטאץ' — maker-only
  const recv = (parseFloat(asksHive) * px).toFixed(3);
  try {
    const txid = await hiveBroadcast([["limit_order_create", { owner: ACCOUNT, orderid: nowSec, amount_to_sell: `${asksHive} HIVE`, min_to_receive: `${recv} HBD`, fill_or_kill: false, expiration: exp }]], wif);
    console.log(`HIVE-ASK ${asksHive}-HIVE→${recv}-HBD @${px.toFixed(6)} (bestAsk+0.4%) orderid=${nowSec} → txid=${txid}`); done++;
  } catch (e) { console.log(`HIVE-ASK-FAIL: ${String(e.message || e).slice(0, 110)}`); }
  await new Promise(r => setTimeout(r, 1200));
}
if (bidsHbd) {
  const px = bestBid * 0.996; // מתחת-הטאץ' — maker-only
  const recv = (parseFloat(bidsHbd) / px).toFixed(3);
  try {
    const txid = await hiveBroadcast([["limit_order_create", { owner: ACCOUNT, orderid: nowSec + 1, amount_to_sell: `${bidsHbd} HBD`, min_to_receive: `${recv} HIVE`, fill_or_kill: false, expiration: exp }]], wif);
    console.log(`HIVE-BID ${bidsHbd}-HBD→${recv}-HIVE @${px.toFixed(6)} (bestBid−0.4%) orderid=${nowSec + 1} → txid=${txid}`); done++;
  } catch (e) { console.log(`HIVE-BID-FAIL: ${String(e.message || e).slice(0, 110)}`); }
}
console.log(`VERDICT-HIVE-MAKER: ${done} quotes placed (maker-only · Z-80 kept)`);
