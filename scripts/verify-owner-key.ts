/* VERIFY-OWNER-KEY — אימות-מצב-אב של מקור-המפתח (upload/headcorner.txt)
 * ההסכם (src/lib/owner-key.ts r137): שורה-1 = חשבון, שורה-2 = סיסמת-אב.
 * גזירה קנונית: WIF(role) = base58check(0x80 ‖ sha256(account+role+password))
 * ואז השוואת הפומבי-הנגזר מול-הרשויות-החיות. קריאה-בלבד · אפס-הדפסת-סודות.
 * שימוש: bun scripts/verify-owner-key.ts [חשבון=headcorner] */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const bs58 = require('bs58');
const { secp256k1 } = require('@noble/curves/secp256k1');
const { ripemd160 } = require('@noble/hashes/ripemd160');
const { sha256 } = require('@noble/hashes/sha256');

const OWNER_FILE = '/home/z/my-project/upload/headcorner.txt';
const [,, want = 'headcorner'] = process.argv;
const lines = readFileSync(OWNER_FILE, 'utf8').trim().split(/\r?\n/);
const account = lines[0].trim(), password = lines[1].trim();
if (account.toLowerCase() !== want.toLowerCase()) { console.log(`file-account=${account} ≠ ${want}`); process.exit(3); }
const toWif = (role: string) => {
  const h = createHash('sha256').update(account + role + password).digest();
  const body = Buffer.concat([Buffer.from([0x80]), h]);
  const chk = createHash('sha256').update(createHash('sha256').update(body).digest()).digest().subarray(0, 4);
  return bs58.encode(Buffer.concat([body, chk]));
};
// r210-fix: קידום-Steem האמיתי — checksum = ripemd160(body)[0:4] (נמדד-EXACT מול-השרשרת),
// הישן (0x41+sha256 כפול) היה קידום-Bitcoin — הצמיד פסק-0/4 מדומה.
const pubOf = (wif: string) => {
  const dec = bs58.decode(wif); const priv = dec.subarray(1, 33);
  const body = Buffer.from(secp256k1.getPublicKey(priv, true));
  return 'STM' + bs58.encode(Buffer.concat([body, Buffer.from(ripemd160(body).subarray(0, 4))]));
};
async function auth(url: string, name: string) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'condenser_api.get_accounts', params: [[name]], id: 1 }) });
  return (await r.json() as any).result?.[0] ?? null;
}
let best = 0;
for (const [chain, url] of [['STEEM', 'https://api.steemit.com'], ['HIVE', 'https://api.hive.blog']] as const) {
  const a = await auth(url, account);
  if (!a) { console.log(`${chain}: no-account`); continue; }
  const on = [a.owner?.key_auths?.[0]?.[0], a.active?.key_auths?.[0]?.[0], a.posting?.key_auths?.[0]?.[0], a.memo_key].filter(Boolean);
  let m = 0;
  for (const role of ['owner', 'active', 'posting', 'memo']) {
    const ok = on.includes(pubOf(toWif(role)));
    if (ok) m++;
    console.log(`${chain} ${role}: ${ok ? 'MATCH' : 'no'}`);
  }
  console.log(`${chain}: ${m}/4`);
  best = Math.max(best, m);
}
process.exit(best >= 4 ? 0 : 1);
