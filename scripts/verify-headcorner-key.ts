/**
 * Corrected verification — READ-ONLY.
 * Blurt display form: strip leading 'P' (see master-key.ts normalizeKeyForm),
 * then verify standard graphene WIF (0x80, double-sha256 checksum) and compare
 * the derived public key against headcorner's on-chain authorities.
 */
import { readFileSync } from 'fs';
import { createHash } from 'crypto';

const lines = readFileSync('/home/z/my-project/upload/headcorner.txt', 'utf8').trim().split(/\r?\n/);
const account = lines[0].trim();
const raw = lines[1].trim();
const wif = raw.length >= 2 && raw[0] === 'P' && /^[5KL]/.test(raw[1]) ? raw.slice(1) : raw;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const bs58 = require('bs58');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { secp256k1 } = require('@noble/curves/secp256k1');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { sha256: nsha256, ripemd160 } = require('@noble/hashes/ripemd160');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { sha256 } = require('@noble/hashes/sha256');

const dec = bs58.decode(wif);
const payload = dec.slice(0, dec.length - 4);
const chk = dec.slice(dec.length - 4);
const calc = createHash('sha256').update(createHash('sha256').update(payload).digest()).digest().slice(0, 4);
const versionOk = payload[0] === 0x80;
const checksumOk = Buffer.compare(Buffer.from(chk), Buffer.from(calc)) === 0;
console.log('normalized WIF length:', wif.length, '· version 0x80:', versionOk, '· checksum:', checksumOk);
if (!versionOk || !checksumOk) { console.log('NOT a valid graphene WIF even after P-strip'); process.exit(0); }

const privBytes = payload.slice(1, 33);
const compressedPub = secp256k1.getPublicKey(privBytes, true);
const graphenePub = (prefix: string): string => {
  const body = Buffer.concat([Buffer.from([0x41]), Buffer.from(compressedPub)]);
  const csum = Buffer.from(ripemd160(sha256(body)).slice(0, 4));
  return prefix + bs58.encode(Buffer.concat([body, csum]));
};
const pubs = { STM: graphenePub('STM'), BLT: graphenePub('BLT') };
console.log('derived pub (STM form):', pubs.STM.slice(0, 12) + '…');
console.log('derived pub (BLT form):', pubs.BLT.slice(0, 12) + '…');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const steem = require('steem');

function check(acct: any, chain: string) {
  if (!acct) return console.log(chain + ': account not found');
  const roles: string[] = [];
  for (const role of ['owner', 'active', 'posting']) {
    const keys: string[] = (acct[role]?.key_auths ?? []).map((k: any) => String(k[0]));
    if (keys.includes(pubs.STM)) roles.push(role);
  }
  if (acct.memo_key === pubs.STM) roles.push('memo');
  console.log(`${chain}: @${acct.name} → match: [${roles.join(', ') || 'NONE'}]`);
}

async function getAccounts(url: string, names: string[]): Promise<any[]> {
  steem.api.setOptions({ url });
  return await new Promise((resolve, reject) =>
    steem.api.getAccounts(names, (err: any, r: any) => (err ? reject(err) : resolve(r)))
  );
}

(async () => {
  try { check((await getAccounts('https://api.steemit.com', [account]))[0], 'STEEM'); } catch (e: any) { console.log('STEEM rpc error:', e?.message ?? e); }
  try { check((await getAccounts('https://api.hive.blog', [account]))[0], 'HIVE'); } catch (e: any) { console.log('HIVE rpc error:', e?.message ?? e); }
  try { check((await getAccounts('https://rpc.blurt.blog', [account]))[0], 'BLURT'); } catch (e: any) { console.log('BLURT rpc error:', e?.message ?? e); }
})();
