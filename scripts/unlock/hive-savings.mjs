// hive-savings.mjs — §84 מסילת-ריבית-HBD: הפקדת-כל-ה-HBD-הנזיל-ל-savings (hbd_interest_rate=1000bps=10%-APR מדיד)
// §84c: dhive — סריאליזציה-אמת-של-נכסי-HBD (steem-js-העתיק-שבר-digest). משיכה-אפשרית-3-ימים. אפס-סודות-בפלט.
import d from "@hiveio/dhive";
import { readFileSync } from "node:fs";
const { Client, PrivateKey } = d;

const ACCOUNT = process.env.HIVE_ACCOUNT || "headcorner";
const client = new Client(["https://api.hive.blog", "https://api.openhive.network"]);

const cands = [];
if (process.env.HIVE_ACTIVE_WIF) cands.push({ tag: "env-active", wif: process.env.HIVE_ACTIVE_WIF });
if (process.env.HIVE_POSTING_WIF) cands.push({ tag: "env-posting", wif: process.env.HIVE_POSTING_WIF });
try { const map = JSON.parse(readFileSync("/tmp/live-map.json", "utf8")); const h = map["hive:" + ACCOUNT]; if (h?.active) cands.push({ tag: "map-active", wif: h.active }); if (h?.posting) cands.push({ tag: "map-posting", wif: h.posting }); if (h?.owner) cands.push({ tag: "map-owner", wif: h.owner }); } catch {}
const keys = [];
for (const c of cands) { try { const k = PrivateKey.fromString(c.wif.trim()); const pub = k.createPublic().toString().slice(4, 12); if (!keys.some(x => x.pub === pub)) keys.push({ ...c, key: k, pub }); } catch (e) { console.log(`key-decode-FAIL ${c.tag}: len=${(c.wif || "").trim().length} err=${String(e?.message || e).slice(0, 120)}`); } }
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
