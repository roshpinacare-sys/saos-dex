// VERIFY-VAULT-KEYS — אימות-כל-4-התפקידים של headcorner מהכספת-החיה מול-השרשרת.
// קריאה-בלבד · אפס-הדפסת-סודות.
import { readFileSync } from 'node:fs';
const bs58 = require('bs58');
const { secp256k1 } = require('@noble/curves/secp256k1');
const { ripemd160 } = require('@noble/hashes/ripemd160');
const pubOf = (wif: string) => {
  const dec = bs58.decode(wif);
  const body = Buffer.from(secp256k1.getPublicKey(dec.subarray(1, 33), true));
  return 'STM' + bs58.encode(Buffer.concat([body, Buffer.from(ripemd160(body).subarray(0, 4))]));
};
const hc = (JSON.parse(readFileSync('/home/z/my-project/zip/agent/keys/vault.json','utf8'))['accounts'] as any[]).find(a=>a.username==='headcorner');
const r = await fetch('https://api.steemit.com',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',method:'condenser_api.get_accounts',params:[['headcorner']],id:1})});
const A = (await r.json() as any).result[0];
const LIVE = { owner: A.owner.key_auths[0][0], active: A.active.key_auths[0][0], posting: A.posting.key_auths[0][0], memo: A.memo_key };
let m = 0;
for (const role of ['owner','active','posting','memo'] as const) {
  const ok = pubOf(hc.keys.steem[role].wif) === LIVE[role];
  if (ok) m++;
  console.log(`STEEM ${role}: ${ok ? 'MATCH' : 'no'}`);
}
console.log(`STEEM: ${m}/4 — ${m === 4 ? 'הכספת-החיה מאומתת-מלאה' : 'חוסר-התאמה'}`);
process.exit(m === 4 ? 0 : 1);
