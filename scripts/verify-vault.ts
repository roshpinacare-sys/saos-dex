/* VERIFY-VAULT — אימות-כספת-חיה מול-השרשרת (קריאה-בלבד · אפס-הדפסת-סודות)
 * שימוש: bun scripts/verify-vault.ts [נתיב-vault.json] [שם-חשבון=headcorner]
 * משווה מפתחות-ציבוריים נגזרים (owner/active/posting/memo) מול-הרשויות-החיות. */
import { readFileSync } from 'fs';
const bs58 = require('bs58');
const { secp256k1 } = require('@noble/curves/secp256k1');
const { ripemd160 } = require('@noble/hashes/ripemd160');
const { sha256 } = require('@noble/hashes/sha256');

const [,, vaultPath = '/home/z/my-project/zip/agent/keys/vault.json', want = 'headcorner'] = process.argv;
const vault = JSON.parse(readFileSync(vaultPath, 'utf8'));
const list = vault.accounts ?? vault;
const entry = (Array.isArray(list) ? list : Object.entries(list).map(([username, v]) => ({ username, ...(v as object) }))).find((a: any) => (a.username ?? a.name ?? '').toLowerCase() === want);
if (!entry) { console.log(`${want}: NOT-IN-VAULT`); process.exit(2); }
const flat: Array<[string,string]> = [];
(function walk(o: any, pre: string){ if (o && typeof o === 'object') { for (const [k,v] of Object.entries(o)) walk(v, pre+pre?pre+'.':k); } else if (typeof o === 'string' && /^[5KP][1-9A-HJ-NP-Za-km-z]{49,51}$/.test(o)) flat.push([pre||'key', o]); })(entry.keys ?? entry, '');
const roles = flat;
function pub(wifRaw: string): string {
  let wif = (wifRaw as string).replace(/\s+/g, ''); if (wif[0] === 'P' && /^[5KL]/.test(wif[1])) wif = wif.slice(1);
  const dec = bs58.decode(wif); const priv = dec.slice(1, 33);
  const body = Buffer.concat([Buffer.from([0x41]), Buffer.from(secp256k1.getPublicKey(priv, true))]);
  return 'STM' + bs58.encode(Buffer.concat([body, Buffer.from(ripemd160(sha256(body)).slice(0, 4))]));
}
async function auth(url: string, name: string) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'condenser_api.get_accounts', params: [[name]], id: 1 }) });
  return (await r.json() as any).result?.[0] ?? null;
}
let verdict = 0;
for (const [chain, url] of [['STEEM', 'https://api.steemit.com'], ['HIVE', 'https://api.hive.blog']] as const) {
  const a = await auth(url, want); if (!a) { console.log(`${chain}: no-account`); continue; }
  const on = { owner: a.owner?.key_auths?.[0]?.[0] ?? '', active: a.active?.key_auths?.[0]?.[0] ?? '', posting: a.posting?.key_auths?.[0]?.[0] ?? '', memo: a.memo_key ?? '' };
  let m = 0, t = 0;
  for (const [role, wif] of roles) { const d = pub(wif as string); t++; const ok = Object.values(on).some(x => x === d); if (ok) m++; console.log(`${chain} ${role}: ${ok ? 'MATCH' : 'no'}`); }
  console.log(`${chain}: ${m}/${t}`); verdict = Math.max(verdict, m);
}
process.exit(verdict >= 4 ? 0 : 1);
