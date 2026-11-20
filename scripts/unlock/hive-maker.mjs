// hive-maker.mjs — §84 מסילת-maker-צד-שני: ביד+אסק-maker-only-על-ספר-HIVE-הפנימי (HBD/HIVE)
// §84b חוזק: אימות-חתימה-על-הצומת-שמשדר (verify_authority) לפני-שידור + אסלת-חתימות-מרובות-wif
// + get_required_signatures אבחון-אמת-אם-כל-האסלה-נכשלת. Z-80-maker-only: ask>bestAsk · bid<bestBid.
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

// אסלת-מפתחות: כל-ה-candidates-הפעילים (env + live-map) — בלי-כפילויות
const cands = [];
if (process.env.HIVE_ACTIVE_WIF) cands.push({ tag: "env-active", wif: process.env.HIVE_ACTIVE_WIF });
if (process.env.HIVE_POSTING_WIF) cands.push({ tag: "env-posting", wif: process.env.HIVE_POSTING_WIF });
try { const map = JSON.parse(readFileSync("/tmp/live-map.json", "utf8")); const h = map["hive:" + ACCOUNT]; if (h?.active) cands.push({ tag: "map-active", wif: h.active }); if (h?.posting) cands.push({ tag: "map-posting", wif: h.posting }); if (h?.owner) cands.push({ tag: "map-owner", wif: h.owner }); } catch {}
const uniq = new Map();
for (const c of cands) { try { const pub = steem.auth.wifToPublic(c.wif); const short = pub.slice(3, 11); if (!uniq.has(short)) uniq.set(short, { ...c, pub: short }); } catch {} }
const wifs = [...uniq.values()];
if (!wifs.length) { console.log("VERDICT-HIVE-MAKER: no-decodable-key honest-abort"); process.exit(1); }
console.log(`hive-maker: key-ladder=${wifs.map(w => w.tag + ":" + w.pub).join(" ")}`);

const acc = (await rpc("condenser_api.get_accounts", [[ACCOUNT]]))[0];
const ob = await rpc("condenser_api.get_order_book", [1]);
const bestBid = parseFloat(ob.bids?.[0]?.real_price || "0"), bestAsk = parseFloat(ob.asks?.[0]?.real_price || "0");
if (!(bestBid > 0) || !(bestAsk > 0)) { console.log("VERDICT-HIVE-MAKER: book-unreadable honest-skip"); process.exit(0); }
console.log(`hive-maker: ${ACCOUNT} liquid=${acc.balance}/${acc.hbd_balance} · book bestBid=${bestBid.toFixed(6)} bestAsk=${bestAsk.toFixed(6)}`);

const hiveLiquid = parseFloat(acc.balance), hbdLiquid = parseFloat(acc.hbd_balance);
const asksHive = hiveLiquid > 0.005 ? (hiveLiquid - 0.001).toFixed(3) : "";
const bidsHbd = hbdLiquid >= 0.001 ? hbdLiquid.toFixed(3) : "";
const nowSec = Math.floor(Date.now() / 1000);
const exp = new Date(Date.now() + 15 * 864e5).toISOString().slice(0, 19);
const dgp = await rpc("condenser_api.get_dynamic_global_properties", []);
const ops = [];
if (asksHive) { const px = bestAsk * 1.004; ops.push({ px, label: `ASK ${asksHive}-HIVE→${(parseFloat(asksHive) * px).toFixed(3)}-HBD @${px.toFixed(6)}`, op: ["limit_order_create", { owner: ACCOUNT, orderid: nowSec, amount_to_sell: `${asksHive} HIVE`, min_to_receive: `${(parseFloat(asksHive) * px).toFixed(3)} HBD`, fill_or_kill: false, expiration: exp }] }); }
if (bidsHbd) { const px = bestBid * 0.996; ops.push({ px, label: `BID ${bidsHbd}-HBD→${(parseFloat(bidsHbd) / px).toFixed(3)}-HIVE @${px.toFixed(6)}`, op: [["limit_order_create", { owner: ACCOUNT, orderid: nowSec + 1, amount_to_sell: `${bidsHbd} HBD`, min_to_receive: `${(parseFloat(bidsHbd) / px).toFixed(3)} HIVE`, fill_or_kill: false, expiration: exp }]][0] }); }
if (!ops.length) { console.log("VERDICT-HIVE-MAKER: no-fuel honest-skip"); process.exit(0); }

// כל-הפקודות-בטרנזקציה-אחת-מאומתת-מראש (אימות-על-הצומת → שידור-רק-אם-verify=TRUE)
const tx = txShell(dgp, ops.map(o => o.op));
let ok = null;
for (const combo of [wifs.map(w => w.wif), wifs.filter(w => /active/.test(w.tag)).map(w => w.wif), wifs.filter(w => !/posting/.test(w.tag)).map(w => w.wif)]) {
  if (!combo.length) continue;
  const signed = signWith(tx, combo);
  const sigPubs = (signed.signatures || []).map((s: string) => s.slice(0, 8) + "…");
  const v = await rpc("condenser_api.verify_authority", [{ ...signed }]).catch(e => ({ err: String(e.message).slice(0, 80) }));
  console.log(`verify_authority(combo=${combo.length}-keys sigs=${sigPubs.length}): ${JSON.stringify(v).slice(0, 80)}`);
  if (v === true) { ok = signed; break; }
}
if (!ok) {
  try { const req = await rpc("condenser_api.get_required_signatures", [{ ...tx }], ).catch(() => null); console.log(`diagnostic-get_required_signatures: ${JSON.stringify(req).slice(0, 120)}`); } catch {}
  const acct = (await rpc("condenser_api.get_accounts", [[ACCOUNT]]))[0];
  console.log(`diagnostic-chain-auth: active=${JSON.stringify(acct.active.key_auths.map(k => [k[0].slice(3, 11), k[1]]))} thr=${acct.active.weight_threshold}`);
  console.log("VERDICT-HIVE-MAKER: 0 quotes — chain-rejects-all-signatures (fail-closed, honest)");
  process.exit(2);
}
try {
  const res = await rpc("condenser_api.broadcast_transaction_synchronous", [{ ...ok }]);
  console.log(`HIVE-QUOTES-BROADCAST ${ops.map(o => o.label).join(" · ")} → txid=${res?.id ?? "no-id"}`);
  console.log(`VERDICT-HIVE-MAKER: ${ops.length} quotes placed (maker-only · verify-authority-first · Z-80 kept)`);
} catch (e) { console.log(`VERDICT-HIVE-MAKER: broadcast-fail ${String(e.message || e).slice(0, 130)}`); process.exit(2); }
