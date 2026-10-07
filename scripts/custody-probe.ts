import fs from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import bs58 from "bs58";
import crypto from "node:crypto";

// parse .env (names never printed with values)
const env: Record<string, string> = {};
for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
console.log("env keys present:", Object.keys(env).filter(k => /KEY|WIF|SECRET|TOKEN/i.test(k)).join(", "));

function tronAddrFromPrivHex(pkHex: string): string {
  const clean = pkHex.replace(/^0x/, "");
  const pk = Buffer.from(clean, "hex");
  const pub = secp256k1.getPublicKey(pk, false).slice(1);
  const h = Buffer.from(keccak_256(pub)).subarray(12);
  const payload = Buffer.concat([Buffer.from([0x41]), h]);
  const chk = crypto.createHash("sha256").update(crypto.createHash("sha256").update(payload).digest()).digest().subarray(0, 4);
  return bs58.encode(Buffer.concat([payload, chk]));
}
function evmAddrFromPrivHex(pkHex: string): string {
  const clean = pkHex.replace(/^0x/, "");
  const pk = Buffer.from(clean, "hex");
  const pub = secp256k1.getPublicKey(pk, false).slice(1);
  return "0x" + Buffer.from(keccak_256(pub)).subarray(12).toString("hex");
}

const CUSTODY = "TYVwwuvdDmfy3shxT3cb3RKLrRCshaZxTy";
const VAULT_TRON = "TPFmkfW6CbnPTSMaMkSS6xPgh7aRDE4zjH";

const tronKey = env.TRON_PRIVATE_KEY?.replace(/^0x/, "");
const ethKey = env.ETH_PRIVATE_KEY?.replace(/^0x/, "");
let custodyControls = false, vaultControls = false, tronAddr = "";
if (tronKey && /^[0-9a-fA-F]{64}$/.test(tronKey)) {
  tronAddr = tronAddrFromPrivHex(tronKey);
  custodyControls = tronAddr === CUSTODY;
  vaultControls = tronAddr === VAULT_TRON;
  console.log(`TRON key derives: ${tronAddr.slice(0,8)}…${tronAddr.slice(-6)} == custody(${CUSTODY.slice(0,8)}…): ${custodyControls} == vault: ${vaultControls}`);
} else console.log("TRON key: not 64-hex (len=" + (tronKey?.length ?? 0) + ")");

if (ethKey && /^[0-9a-fA-F]{64}$/.test(ethKey)) {
  const a = evmAddrFromPrivHex(ethKey);
  console.log(`ETH key derives: ${a}`);
} else console.log("ETH key: not 64-hex (len=" + (ethKey?.length ?? 0) + ")");

// live custody balance
if (custodyControls) {
  const r = await fetch(`https://api.trongrid.io/v1/accounts/${CUSTODY}`, { signal: AbortSignal.timeout(15000) });
  const j: any = await r.json();
  const acc = j?.data?.[0];
  const trx = acc ? (acc.balance ?? 0) / 1e6 : 0;
  const bw = acc ? acc.free_bandwidth ?? 0 : 0;
  let usdt = 0;
  if (acc?.trc20?.length) for (const t of acc.trc20) if (t["TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"] !== undefined) usdt = parseFloat(t["TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"]) / 1e6;
  console.log(`CUSTODY LIVE: ${trx} TRX, USDT=${usdt}, freeBandwidth=${bw}, activated=${!!acc}`);
}
// vault tron balance
{
  const r = await fetch(`https://api.trongrid.io/v1/accounts/${VAULT_TRON}`, { signal: AbortSignal.timeout(15000) });
  const j: any = await r.json();
  const acc = j?.data?.[0];
  console.log(`VAULT TRON: ${(acc ? (acc.balance ?? 0) / 1e6 : 0)} TRX, activated=${!!acc}`);
}
