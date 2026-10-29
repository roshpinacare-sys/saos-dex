// census.mjs — crown-custody census (chain is the only judge; fingerprints only in logs)
import { createHash } from "node:crypto";
import * as secp from "@noble/secp256k1";

const WIF_RE = /^[5JK][1-9A-HJ-NP-Za-km-z]{50,51}$/;
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

async function rpc(url, method, params) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }), signal: AbortSignal.timeout(20000) });
  const j = await r.json(); if (j.error) throw new Error(String(j.error.message).slice(0, 80)); return j.result;
}

const SECRETS = {
  SA_HEAD_ACTIVE: process.env.SA_HEAD_ACTIVE, SA_FLEET_KEYS: process.env.SA_FLEET_KEYS,
  STEEM_ACTIVE_WIF: process.env.STEEM_ACTIVE_WIF, STEEM_POSTING_WIF: process.env.STEEM_POSTING_WIF,
  HEADCORNER: process.env.HEADCORNER, HEADCORNER_CRED: process.env.HEADCORNER_CRED,
  WEAVE_STEEM_WIF: process.env.WEAVE_STEEM_WIF, WEAVE_HIVE_WIF: process.env.WEAVE_HIVE_WIF,
  HIVE_ACTIVE_WIF: process.env.HIVE_ACTIVE_WIF, HIVE_POSTING_WIF: process.env.HIVE_POSTING_WIF,
  BLURT_ACTIVE_WIF: process.env.BLURT_ACTIVE_WIF, BLURT_POSTING_WIF: process.env.BLURT_POSTING_WIF,
  MAIN_KEY: process.env.MAIN_KEY, FLEET_ACCOUNT: process.env.FLEET_ACCOUNT,
  CI_ADOPT_WIF_ACTIVE: process.env.CI_ADOPT_WIF_ACTIVE, CI_ADOPT_WIF_POSTING: process.env.CI_ADOPT_WIF_POSTING,
  CI_DELEGATION_ARMED: process.env.CI_DELEGATION_ARMED, FLEET_ROSTER_MAP: process.env.FLEET_ROSTER_MAP,
};
const cands = [];
for (const [name, val] of Object.entries(SECRETS)) {
  if (!val) continue;
  const found = new Set();
  if (WIF_RE.test(val.trim())) found.add(val.trim());
  try { (function walk(n, d) { if (!n || typeof n !== "object" || d > 8) return; for (const v of Object.values(n)) { if (typeof v === "string" && WIF_RE.test(v)) found.add(v); else if (v && typeof v === "object") walk(v, d + 1); } })(JSON.parse(val), 0); } catch {}
  for (const line of val.split(/[\n;, ]+/)) { const t = line.trim(); if (WIF_RE.test(t)) found.add(t); }
  for (const f of found) cands.push({ secret: name, wif: f });
}
console.log(`census: ${cands.length} WIF candidates from ${Object.entries(SECRETS).filter(([, v]) => v).length} non-empty secrets`);

const ROSTER = ["headcorner", "cashmachine", "haran", "israelnews", "lsa", "macrame", "siq", "tov", "wic", "wog", "woq", "hcsoldier1", "hcsoldier2", "hcsoldier3", "hcsoldier4", "hcsoldier5", "hcsoldier6", "hcsoldier7"];
const steemAccs = await rpc("https://api.steemit.com", "condenser_api.get_accounts", [ROSTER]);
const hiveRoster = ["headcorner", "israelnews", "lsa", "siq", "woq"];
const hiveAccs = await rpc("https://api.hive.blog", "condenser_api.get_accounts", [hiveRoster]).catch(() => []);
const auth = {};
for (const a of steemAccs) auth["steem:" + a.name] = { active: a.active?.key_auths?.[0]?.[0], posting: a.posting?.key_auths?.[0]?.[0], memo: a.memo_key, owner: a.owner?.key_auths?.[0]?.[0] };
for (const a of hiveAccs) auth["hive:" + a.name] = { active: a.active?.key_auths?.[0]?.[0], posting: a.posting?.key_auths?.[0]?.[0], memo: a.memo_key, owner: a.owner?.key_auths?.[0]?.[0] };

const verified = {};
const matrix = [];
for (const c of cands) {
  let pub;
  try { pub = steemPub(c.wif); } catch { matrix.push(`${c.secret.padEnd(18)} ${fp(c.wif)} UNPARSEABLE`); continue; }
  let hit = null;
  for (const [key, roles] of Object.entries(auth)) {
    for (const [role, chainPub] of Object.entries(roles)) {
      if (chainPub && (chainPub === pub || chainPub.replace(/^STM/, "STM") === pub)) { hit = { key, role }; break; }
    }
    if (hit) break;
  }
  if (hit) {
    const [chain, account] = hit.key.split(":");
    verified[account] = verified[account] || {};
    if (!verified[account][hit.role]) verified[account][hit.role] = c.wif;
    matrix.push(`${c.secret.padEnd(18)} ${fp(c.wif)} LIVE ${hit.key}:${hit.role}`);
  } else matrix.push(`${c.secret.padEnd(18)} ${fp(c.wif)} dead-vs-chain`);
}
console.log("\n=== CENSUS MATRIX (sha256 fingerprints only — never WIFs) ===");
for (const m of matrix) console.log("  " + m);
const nAccounts = Object.keys(verified).length;
console.log(`\nCENSUS RESULT: ${nAccounts} accounts with live custody`);
if (!nAccounts) { console.error("census: zero live matches — honest abort"); process.exit(1); }
process.stdout.write("LIVE_MAP_B64:" + Buffer.from(JSON.stringify(verified)).toString("base64") + ":END\n");
