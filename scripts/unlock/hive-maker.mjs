// hive-maker.mjs — §84 מסילת-maker-צד-שני: ביד+אסק-maker-only-על-ספר-HIVE-הפנימי (HBD/HIVE)
// §84c: dhive-לא-steem-js — סריאליזציה-של-נכסי-HIVE/HBD-אמת (steem-js-העתיק-שבר-digest-על-נכסים: votes-עברו, נכסים-נדחו-missing-authority)
// Z-80-maker-only: ask>bestAsk · bid<bestBid · אפס-סודות-בפלט.
import { readFileSync } from "node:fs";
import d from "@hiveio/dhive";
const { Client, PrivateKey } = d;

const ACCOUNT = process.env.HIVE_ACCOUNT || "headcorner";
const client = new Client(["https://api.hive.blog", "https://api.openhive.network"]);

// אסלת-מפתחות (env + live-map) בלי-כפילויות
const cands = [];
if (process.env.HIVE_ACTIVE_WIF) cands.push({ tag: "env-active", wif: process.env.HIVE_ACTIVE_WIF });
if (process.env.HIVE_POSTING_WIF) cands.push({ tag: "env-posting", wif: process.env.HIVE_POSTING_WIF });
try { const map = JSON.parse(readFileSync("/tmp/live-map.json", "utf8")); const h = map["hive:" + ACCOUNT]; if (h?.active) cands.push({ tag: "map-active", wif: h.active }); if (h?.posting) cands.push({ tag: "map-posting", wif: h.posting }); if (h?.owner) cands.push({ tag: "map-owner", wif: h.owner }); } catch {}
const keys = [];
for (const c of cands) { try { const k = PrivateKey.fromString(c.wif.trim()); const pub = k.createPublic().toString().slice(4, 12); if (!keys.some(x => x.pub === pub)) keys.push({ ...c, key: k, pub }); } catch {} }
if (!keys.length) { console.log("VERDICT-HIVE-MAKER: no-decodable-key honest-abort"); process.exit(1); }
console.log(`hive-maker: key-ladder=${keys.map(w => w.tag + ":" + w.pub).join(" ")}`);

const acc = (await client.database.getAccounts([ACCOUNT]))[0];
const ob = await client.call("condenser_api", "get_order_book", [1]);
const bestBid = parseFloat(ob.bids?.[0]?.real_price || "0"), bestAsk = parseFloat(ob.asks?.[0]?.real_price || "0");
if (!(bestBid > 0) || !(bestAsk > 0)) { console.log("VERDICT-HIVE-MAKER: book-unreadable honest-skip"); process.exit(0); }
console.log(`hive-maker: ${ACCOUNT} liquid=${acc.balance}/${acc.hbd_balance} · book bestBid=${bestBid.toFixed(6)} bestAsk=${bestAsk.toFixed(6)}`);

const hiveLiquid = parseFloat(acc.balance), hbdLiquid = parseFloat(acc.hbd_balance);
const nowSec = Math.floor(Date.now() / 1000);
const exp = new Date(Date.now() + 15 * 864e5).toISOString().slice(0, 19);
const ops = [];
if (hiveLiquid > 0.005) {
  const amt = (hiveLiquid - 0.001).toFixed(3), px = bestAsk * 1.004;
  ops.push({ label: `ASK ${amt}-HIVE→${(parseFloat(amt) * px).toFixed(3)}-HBD @${px.toFixed(6)} (bestAsk+0.4%)`, op: ["limit_order_create", { owner: ACCOUNT, orderid: nowSec, amount_to_sell: `${amt} HIVE`, min_to_receive: `${(parseFloat(amt) * px).toFixed(3)} HBD`, fill_or_kill: false, expiration: exp }] });
}
if (hbdLiquid >= 0.001) {
  const amt = hbdLiquid.toFixed(3), px = bestBid * 0.996;
  ops.push({ label: `BID ${amt}-HBD→${(parseFloat(amt) / px).toFixed(3)}-HIVE @${px.toFixed(6)} (bestBid−0.4%)`, op: ["limit_order_create", { owner: ACCOUNT, orderid: nowSec + 1, amount_to_sell: `${amt} HBD`, min_to_receive: `${(parseFloat(amt) / px).toFixed(3)} HIVE`, fill_or_kill: false, expiration: exp }] });
}
if (!ops.length) { console.log("VERDICT-HIVE-MAKER: no-fuel honest-skip"); process.exit(0); }

try {
  const res = await client.broadcast.sendOperations(ops.map(o => o.op), keys.map(k => k.key));
  console.log(`HIVE-QUOTES ${ops.map(o => o.label).join(" · ")} → txid=${res?.id ?? "no-id"}`);
  console.log(`VERDICT-HIVE-MAKER: ${ops.length} quotes placed (dhive-serialization · maker-only · Z-80 kept)`);
} catch (e) {
  console.log(`HIVE-MAKER-FAIL: ${String(e?.jse_shortmsg || e?.message || e).slice(0, 150)}`);
  const acct = (await client.database.getAccounts([ACCOUNT]))[0];
  console.log(`diagnostic-chain-auth: active=${JSON.stringify(acct.active.key_auths.map(k => [k[0].toString().slice(4, 12), k[1]]))} thr=${acct.active.weight_threshold}`);
  console.log("VERDICT-HIVE-MAKER: 0 quotes (fail-closed, honest)");
  process.exit(2);
}
