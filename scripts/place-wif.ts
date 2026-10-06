// PLACE-WIF r210b — headcorner.active (מהכספת-החיה) → ~/.sovereign/vault/secrets
// קידום-Steem: STM + base58(body ‖ ripemd160(body)[0:4]) — נמדד-EXACT
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
const bs58 = require('bs58');
const { secp256k1 } = require('@noble/curves/secp256k1');
const { ripemd160 } = require('@noble/hashes/ripemd160');
function pubOf(wif: string): string {
  const dec = bs58.decode(wif);
  const body = Buffer.from(secp256k1.getPublicKey(dec.subarray(1, 33), true));
  return 'STM' + bs58.encode(Buffer.concat([body, Buffer.from(ripemd160(body).subarray(0, 4))]));
}
const vault = JSON.parse(readFileSync('/home/z/my-project/zip/agent/keys/vault.json', 'utf8'));
const hc = (vault['accounts'] as any[]).find((a) => a.username === 'headcorner');
const wif: string = String(hc.keys.steem.active.wif).trim();
const resp = await fetch('https://api.steemit.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'condenser_api.get_accounts', params: [['headcorner']], id: 1 }) });
const live: string = (await resp.json() as any).result[0].active.key_auths[0][0];
const derived = pubOf(wif);
if (derived !== live) { console.log('ABORT: derived=' + derived.slice(-8) + ' live=' + live.slice(-8)); process.exit(1); }
mkdirSync('/home/z/.sovereign/vault/secrets', { recursive: true });
writeFileSync('/home/z/.sovereign/vault/secrets/STEEM_ACTIVE_WIF', wif + '\n', { mode: 0o600 });
chmodSync('/home/z/.sovereign/vault/secrets/STEEM_ACTIVE_WIF', 0o600);
chmodSync('/home/z/.sovereign/vault/secrets', 0o700);
chmodSync('/home/z/.sovereign/vault', 0o750);
const back = readFileSync('/home/z/.sovereign/vault/secrets/STEEM_ACTIVE_WIF', 'utf8').trim();
console.log(back === wif && pubOf(back) === live ? 'PLACED+VERIFIED: STEEM_ACTIVE_WIF (0600) — pub תואם-הרשות-החיה' : 'WRITE-MISMATCH');
