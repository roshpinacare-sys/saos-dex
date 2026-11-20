// hive-savings.mjs — §84 מסילת-ריבית-HBD: הפקדת-כל-ה-HBD-הנזיל-ל-savings (hbd_interest_rate=1000bps=10%-APR מדיד)
// §84c: dhive — סריאליזציה-אמת-של-נכסי-HBD (steem-js-העתיק-שבר-digest). משיכה-אפשרית-3-ימים. אפס-סודות-בפלט.
import { sha256 } from "@noble/hashes/sha2";
import d from "@hiveio/dhive";

// WIF-נרמול: 52-תו-דחוס (K/L) → 51-תו-לא-דחוס — dhive-מקבל-רק-לא-דחוס (steem-js-השתמש-בשניהם)
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s) { let n = 0n; for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error("bad-char"); n = n * 58n + BigInt(i); } const bytes = []; while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; } for (const c of s) { if (c === "1") bytes.unshift(0); else break; } return Uint8Array.from(bytes); }
function b58encode(bytes) { let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b); let s = ""; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const b of bytes) { if (b === 0) s = "1" + s; else break; } return s; }
function b58checkDecode(s) { const raw = b58decode(s); if (raw.length < 5) throw new Error("short"); const payload = raw.slice(0, -4), chk = raw.slice(-4); const h = sha256(sha256(payload)); for (let i = 0; i < 4; i++) if (h[i] !== chk[i]) throw new Error("bad-checksum"); return payload; }
function b58checkEncode(payload) { const h = sha256(sha256(payload)); return b58encode(Uint8Array.from([...payload, ...h.slice(0, 4)])); }
function toUncompressedWif(wif) { const p = b58checkDecode(wif.trim()); if (p[0] !== 0x80) throw new Error("not-mainnet-0x80"); let key; if (p.length === 34 && p[33] === 0x01) key = p.slice(1, 33); else if (p.length === 33) key = p.slice(1); else throw new Error("bad-payload-len-" + p.length); return b58checkEncode(Uint8Array.from([0x80, ...key])); }

import { readFileSync } from "node:fs";
const { Client, PrivateKey } = d;

const ACCOUNT = process.env.HIVE_ACCOUNT || "headcorner";
const client = new Client(["https://api.hive.blog", "https://api.openhive.network"]);

const cands = [];
if (process.env.HIVE_ACTIVE_WIF) cands.push({ tag: "env-active", wif: process.env.HIVE_ACTIVE_WIF });
if (process.env.HIVE_POSTING_WIF) cands.push({ tag: "env-posting", wif: process.env.HIVE_POSTING_WIF });
try { const map = JSON.parse(readFileSync("/tmp/live-map.json", "utf8")); const h = map["hive:" + ACCOUNT]; if (h?.active) cands.push({ tag: "map-active", wif: h.active }); if (h?.posting) cands.push({ tag: "map-posting", wif: h.posting }); if (h?.owner) cands.push({ tag: "map-owner", wif: h.owner }); } catch {}
const keys = [];
for (const c of cands) { try { const k = PrivateKey.fromString(toUncompressedWif(c.wif)); const pub = k.createPublic().toString().slice(4, 12); if (!keys.some(x => x.pub === pub)) keys.push({ ...c, key: k, pub }); } catch (e) { console.log(`key-decode-FAIL ${c.tag}: len=${(c.wif || "").trim().length} err=${String(e?.message || e).slice(0, 120)}`); } }
if (!keys.length) { console.log(`VERDICT-HIVE-SAVINGS: no-decodable-key honest-abort (node=${process.version} candTags=${cands.map(c => c.tag).join(",")} hasPK=${typeof PrivateKey})`); process.exit(1); }

const acc = (await client.database.getAccounts([ACCOUNT]))[0];
const dgp = await client.database.getDynamicGlobalProperties();
const aprBps = dgp.hbd_interest_rate;
const liquid = parseFloat(acc.hbd_balance);
console.log(`hive-savings: ${ACCOUNT} liquid=${acc.hbd_balance} savings=${acc.savings_hbd_balance} · APR=${(aprBps / 100).toFixed(1)}% · key-ladder=${keys.map(w => w.tag + ":" + w.pub).join(" ")}`);

if (!(liquid >= 0.001)) { console.log("VERDICT-HIVE-SAVINGS: liquid<0.001-HBD honest-skip (rail armed, no fuel)"); process.exit(0); }
const amt = `${liquid.toFixed(3)} HBD`;
try {
  const res = await client.broadcast.sendOperations([["transfer_to_savings", { from: ACCOUNT, to: ACCOUNT, amount: amt, memo: "saos84 hbd savings interest rail" }]], keys.map(k => k.key));
  const yearly = liquid * (aprBps / 10000);
  console.log(`HIVE-SAVINGS-DEPOSIT ${amt} → txid=${res?.id ?? "no-id"} · expected-interest≈${yearly.toFixed(5)}-HBD/year (real on-chain APR ${aprBps}bps)`);
  console.log("VERDICT-HIVE-SAVINGS: SUCCESS (10% APR rail armed · withdrawal-possible-3d)");
} catch (e) {
  console.log(`HIVE-SAVINGS-FAIL: ${String(e?.jse_shortmsg || e?.message || e).slice(0, 150)}`);
  const acct = (await client.database.getAccounts([ACCOUNT]))[0];
  console.log(`diagnostic-chain-auth: active=${JSON.stringify(acct.active.key_auths.map(k => [k[0].toString().slice(4, 12), k[1]]))} thr=${acct.active.weight_threshold}`);
  console.log("VERDICT-HIVE-SAVINGS: fail-closed, honest");
  process.exit(2);
}
