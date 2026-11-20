// hive-maker.mjs — §84 מסילת-maker-צד-שני: ביד+אסק-maker-only-על-ספר-HIVE-הפנימי (HBD/HIVE)
// §84c: dhive-לא-steem-js — סריאליזציה-של-נכסי-HIVE/HBD-אמת (steem-js-העתיק-שבר-digest-על-נכסים: votes-עברו, נכסים-נדחו-missing-authority)
// Z-80-maker-only: ask>bestAsk · bid<bestBid · אפס-סודות-בפלט.
import { readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha2";
import d from "@hiveio/dhive";

// WIF-נרמול: 52-תו-דחוס (K/L) → 51-תו-לא-דחוס — dhive-מקבל-רק-לא-דחוס (steem-js-השתמש-בשניהם)
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s) { let n = 0n; for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error("bad-char"); n = n * 58n + BigInt(i); } const bytes = []; while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; } for (const c of s) { if (c === "1") bytes.unshift(0); else break; } return Uint8Array.from(bytes); }
function b58encode(bytes) { let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b); let s = ""; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const b of bytes) { if (b === 0) s = "1" + s; else break; } return s; }
function b58checkDecode(s) { const raw = b58decode(s); if (raw.length < 5) throw new Error("short"); const payload = raw.slice(0, -4), chk = raw.slice(-4); const h = sha256(sha256(payload)); for (let i = 0; i < 4; i++) if (h[i] !== chk[i]) throw new Error("bad-checksum"); return payload; }
function b58checkEncode(payload) { const h = sha256(sha256(payload)); return b58encode(Uint8Array.from([...payload, ...h.slice(0, 4)])); }
function toUncompressedWif(wif) { const p = b58checkDecode(wif.trim()); if (p[0] !== 0x80) throw new Error("not-mainnet-0x80"); let key; if (p.length === 34 && p[33] === 0x01) { // מפתח-דחוס: הפומבי-הרשום-בשרשרת = pub((key||0x01)-mod-n) — משחזרים-את-הסקלר-הרשום-בדיוק
 const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n; const D = (BigInt("0x" + Buffer.from(p.slice(1, 33)).toString("hex") + "01")) % N; key = Buffer.from(D.toString(16).padStart(64, "0"), "hex"); } else if (p.length === 33) key = p.slice(1); else throw new Error("bad-payload-len-" + p.length); return b58checkEncode(Uint8Array.from([0x80, ...key])); }

const { Client, PrivateKey } = d;

const ACCOUNT = process.env.HIVE_ACCOUNT || "headcorner";
const client = new Client(["https://api.hive.blog", "https://api.openhive.network"]);

// אסלת-מפתחות (env + live-map) בלי-כפילויות
const cands = [];
if (process.env.HIVE_ACTIVE_WIF) cands.push({ tag: "env-active", wif: process.env.HIVE_ACTIVE_WIF });
if (process.env.HIVE_POSTING_WIF) cands.push({ tag: "env-posting", wif: process.env.HIVE_POSTING_WIF });
try { const map = JSON.parse(readFileSync("/tmp/live-map.json", "utf8")); const h = map["hive:" + ACCOUNT]; if (h?.active) cands.push({ tag: "map-active", wif: h.active }); if (h?.posting) cands.push({ tag: "map-posting", wif: h.posting }); if (h?.owner) cands.push({ tag: "map-owner", wif: h.owner }); } catch {}
const keys = [];
for (const c of cands) { try { const k = PrivateKey.fromString(toUncompressedWif(c.wif)); const pub = k.createPublic().toString().slice(4, 12); if (!keys.some(x => x.pub === pub)) keys.push({ ...c, key: k, pub }); } catch (e) { console.log(`key-decode-FAIL ${c.tag}: len=${(c.wif || "").trim().length} err=${String(e?.message || e).slice(0, 120)}`); } }
if (!keys.length) { console.log(`VERDICT-HIVE-MAKER: no-decodable-key honest-abort (node=${process.version} candTags=${cands.map(c => c.tag).join(",")} hasPK=${typeof PrivateKey})`); process.exit(1); }
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
