import { readFileSync } from 'fs';
import { createHash } from 'crypto';

const lines = readFileSync('/home/z/my-project/upload/headcorner.txt', 'utf8').trim().split(/\r?\n/);
const raw = lines[1].trim();
const wif = raw[0] === 'P' && /^[5KL]/.test(raw[1]) ? raw.slice(1) : raw;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const bs58 = require('bs58');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { secp256k1 } = require('@noble/curves/secp256k1');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ripemd160 } = require('@noble/hashes/ripemd160');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { sha256 } = require('@noble/hashes/sha256');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const steem = require('steem');

const dec = bs58.decode(wif);
const payload = dec.slice(0, dec.length - 4);
const privBytes = payload.slice(1, 33);
const pub = Buffer.from(secp256k1.getPublicKey(privBytes, true));
const body = Buffer.concat([Buffer.from([0x41]), pub]);
const pubStr = 'STM' + bs58.encode(Buffer.concat([body, Buffer.from(ripemd160(sha256(body)).slice(0, 4))]));

const accounts = ['headcorner','tov','ynet','israelnews','haran','woq','wic','siq','hcsoldier1','hcsoldier2','hcsoldier3','hcsoldier4','hcsoldier5','hcsoldier6','cashmachine'];

async function sweep(url: string, chain: string) {
  steem.api.setOptions({ url });
  const accts: any[] = await new Promise((res, rej) =>
    steem.api.getAccounts(accounts, (e: any, r: any) => (e ? rej(e) : res(r))));
  const hits: string[] = [];
  for (const a of accts) {
    if (!a) continue;
    for (const role of ['owner','active','posting']) {
      const keys: string[] = (a[role]?.key_auths ?? []).map((k: any) => String(k[0]));
      if (keys.includes(pubStr)) hits.push(`${a.name}:${role}`);
    }
    if (a.memo_key === pubStr) hits.push(`${a.name}:memo`);
  }
  console.log(`${chain}: ${hits.length ? hits.join(' ') : 'no match among fleet accounts'}`);
}

(async () => {
  await sweep('https://api.steemit.com', 'STEEM').catch((e) => console.log('STEEM err', e.message));
  await sweep('https://api.hive.blog', 'HIVE').catch((e) => console.log('HIVE err', e.message));
  await sweep('https://rpc.blurt.blog', 'BLURT').catch((e) => console.log('BLURT err', e.message));
})();
