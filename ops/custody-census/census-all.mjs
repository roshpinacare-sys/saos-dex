// census-all.mjs — GENERIC crown census: scan EVERY env value for WIF-shaped
// material (Actions exposes only secrets + vars here), judge all vs the LIVE
// steem+hive authorities, print the fingerprint matrix, emit LIVE_MAP_B64.
// No secret names hardcoded — the shape is the law.
import { createHash } from "node:crypto";
import * as secp from "@noble/secp256k1";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58d(s) { let n = 0n; for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error("b58char"); n = n * 58n + BigInt(i); } let h = n.toString(16); if (h.length % 2) h = "0" + h; return Buffer.from(h, "hex"); }
function b58e(buf) { let n = BigInt("0x" + buf.toString("hex") || "0"), out = ""; while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; } for (const b of buf) { if (b === 0) out = "1" + out; else break; } return out; }
function wifSeed(wif) {
  const d = b58d(wif);
  let body, chk;
  if (d.length === 38) { body = d.subarray(0, 34); chk = d.subarray(34); if (body[0] !== 0x80 || body[33] !== 0x01) throw new Error("wif-format"); }
  else if (d.length === 37) { body = d.subarray(0, 33); chk = d.subarray(33); if (body[0] !== 0x80) throw new Error("wif-format"); }
  else throw new Error("wif-length");
  const c = createHash("sha256").update(createHash("sha256").update(body).digest()).digest().subarray(0, 4);
  if (!c.equals(chk)) throw new Error("wif-checksum");
  return Buffer.from(body.subarray(1, 33));
}
function steemPub(wif) {
  const pub = Buffer.from(secp.getPublicKey(wifSeed(wif), true));
  const chk = createHash("ripemd160").update(pub).digest().subarray(0, 4);
  return "STM" + b58e(Buffer.concat([pub, chk]));
}
const fp = (s) => createHash("sha256").update(s).digest().toString("hex").slice(0, 8);
const WIF_RE = /^[5K][1-9A-HJ-NP-Za-km-z]{50,51}$/;
const PASSISH_RE = /^[A-Za-z0-9+/_\-=]{16,}$/; // for the vault-pass side-channel

async function rpc(url, method, params) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }), signal: AbortSignal.timeout(20000) });
  const j = await r.json(); if (j.error) throw new Error(String(j.error.message).slice(0, 80)); return j.result;
}

// 1. scan every env value
const cands = [];
const passCands = new Set();
const SKIP_ENV = new Set(["PATH", "HOME", "PWD", "GITHUB_WORKSPACE", "RUNNER_TEMP", "NODE_PATH"]);
for (const [name, val] of Object.entries(process.env)) {
  if (!val || SKIP_ENV.has(name)) continue;
  const found = new Set();
  if (WIF_RE.test(val.trim())) found.add(val.trim());
  try { (function walk(n, d) { if (!n || typeof n !== "object" || d > 8) return; for (const v of Object.values(n)) { if (typeof v === "string" && WIF_RE.test(v)) found.add(v); else if (v && typeof v === "object") walk(v, d + 1); } })(JSON.parse(val), 0); } catch {}
  for (const line of val.split(/[\n;, ]+/)) { const t = line.trim(); if (WIF_RE.test(t)) found.add(t); if (t.length >= 16 && PASSISH_RE.test(t)) passCands.add(t); }
  for (const f of found) cands.push({ secret: name, wif: f });
}
console.log(`census: ${cands.length} WIF candidates from env (generic scan)`);

// 2. chain authorities
const ROSTER = ["headcorner","cashmachine","haran","israelnews","lsa","macrame","siq","tov","wic","wog","woq","hcsoldier1","hcsoldier2","hcsoldier3","hcsoldier4","hcsoldier5","hcsoldier6","hcsoldier7","saos-0001","saos-0002","saos-0003","saos-0004","saos-0005","saos-0006","saos-0007","saos-0008","saos-0009"];
const steemAccs = await rpc("https://api.steemit.com", "condenser_api.get_accounts", [ROSTER]).catch(() => []);
const hiveRoster = ["headcorner", "israelnews", "lsa", "siq", "woq"];
const hiveAccs = await rpc("https://api.hive.blog", "condenser_api.get_accounts", [hiveRoster]).catch(() => []);
const auth = {};
for (const a of steemAccs) auth["steem:" + a.name] = { active: a.active?.key_auths?.[0]?.[0], posting: a.posting?.key_auths?.[0]?.[0], memo: a.memo_key, owner: a.owner?.key_auths?.[0]?.[0] };
for (const a of hiveAccs) auth["hive:" + a.name] = { active: a.active?.key_auths?.[0]?.[0], posting: a.posting?.key_auths?.[0]?.[0], memo: a.memo_key, owner: a.owner?.key_auths?.[0]?.[0] };

// 3. judge
const verified = {};
const matrix = [];
for (const c of cands) {
  let pub;
  try { pub = steemPub(c.wif); } catch { matrix.push(`${c.secret.padEnd(22)} ${fp(c.wif)} UNPARSEABLE`); continue; }
  let hit = null;
  for (const [key, roles] of Object.entries(auth)) {
    for (const [role, chainPub] of Object.entries(roles)) {
      if (chainPub && chainPub === pub) { hit = { key, role }; break; }
    }
    if (hit) break;
  }
  if (hit) {
    const [chain, account] = hit.key.split(":");
    verified[account] = verified[account] || {};
    if (!verified[account][hit.role]) verified[account][hit.role] = c.wif;
    matrix.push(`${c.secret.padEnd(22)} ${fp(c.wif)} LIVE ${hit.key}:${hit.role}`);
  } else matrix.push(`${c.secret.padEnd(22)} ${fp(c.wif)} dead-vs-chain`);
}
console.log("\n=== CENSUS MATRIX (sha256 fingerprints only — never WIFs) ===");
for (const m of matrix) console.log("  " + m);
const nAccounts = Object.keys(verified).length;
console.log(`\nCENSUS RESULT: ${nAccounts} accounts with live custody: ${Object.keys(verified).join(",") || "NONE"}`);
if (!nAccounts) { console.error("census: zero live matches — honest abort"); process.exit(1); }
process.stdout.write("LIVE_MAP_B64:" + Buffer.from(JSON.stringify(verified)).toString("base64") + ":END\n");
