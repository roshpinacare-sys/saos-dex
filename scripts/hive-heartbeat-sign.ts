// hive-heartbeat-sign.ts — custody-verify + sign (fail-closed). Secrets NEVER printed.
// Output: signed-tx.b64 = base64(JSON(signed tx)) — PUBLIC material (sig is public).
import fs from "fs";
import { wifNormalized, pubOfWif, signGrapheneTx } from "../src/lib/dex/signer";

const HIVE_CHAIN_ID = "beeab0de00000000000000000000000000000000000000000000000000000000";
const NODES = ["https://api.hive.blog", "https://api.hive.dev"];
const ACCOUNT = "headcorner";

const raw = process.env.HIVE_POSTING_WIF ?? "";
if (raw.trim().length < 40) { console.log(JSON.stringify({ ok: false, error: "secret-missing" })); process.exit(1); }
const wif = await wifNormalized(raw);
if (!wif) { console.log(JSON.stringify({ ok: false, error: "wif-normalize-failed" })); process.exit(1); }
const pub = pubOfWif(wif);
if (!pub) { console.log(JSON.stringify({ ok: false, error: "pub-derive-failed" })); process.exit(1); }

async function rpc(method: string, params: unknown): Promise<any> {
  let last = "no-node";
  for (const host of NODES) {
    try {
      const r = await fetch(host, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }), signal: AbortSignal.timeout(12000) });
      const d = await r.json() as any;
      if (d.error) { last = d.error.message ?? "rpc"; continue; }
      return d.result;
    } catch (e) { last = String(e); }
  }
  throw new Error("all nodes failed: " + last);
}

const [acct] = await rpc("condenser_api.get_accounts", [[ACCOUNT]]);
const live = acct?.posting?.key_auths?.[0]?.[0];
if (!live) { console.log(JSON.stringify({ ok: false, error: "no-live-authority" })); process.exit(1); }
const fp = (s: string) => require("crypto").createHash("sha256").update(s).digest("hex").slice(0, 8);
console.log(JSON.stringify({ step: "custody", pubFp: fp(pub), liveFp: fp(live), match: pub === live }));
if (pub !== live) { console.log(JSON.stringify({ ok: false, error: "fail-closed: secret does not hold the live posting authority" })); process.exit(1); }

const dgpo = await rpc("condenser_api.get_dynamic_global_properties", []);
const head = Number(dgpo.head_block_number);
const prefix = Buffer.from(String(dgpo.head_block_id), "hex").readUInt32LE(4);
const expSec = Math.floor(Date.now() / 1000) + 60;
const payload = {
  protocol: "saos.weave.v1",
  kind: "hive-custody-live",
  note: "first HIVE treasury-signed op — Actions-held custody verified against live authority, signed on-runner, relayed via public non-custodial relay (dex-relay:3030)",
  authorizedBy: "owner 2026-10-17",
  t: Math.floor(Date.now() / 1000),
};
const tx = {
  ref_block_num: head & 0xffff,
  ref_block_prefix: prefix,
  expiration: new Date(expSec * 1000).toISOString().slice(0, 19),
  operations: [["custom_json", { required_auths: [], required_posting_auths: [ACCOUNT], id: "saos.weave.v1", json: JSON.stringify(payload) }]],
  extensions: [] as unknown[],
};
const signed = signGrapheneTx(tx as any, HIVE_CHAIN_ID, wif);
const sigs = (signed as any).signatures ?? [];
if (!sigs.length) { console.log(JSON.stringify({ ok: false, error: "no-signature-produced" })); process.exit(1); }
fs.writeFileSync("signed-tx.b64", Buffer.from(JSON.stringify(signed), "utf8").toString("base64"));
console.log(JSON.stringify({ ok: true, step: "signed", ops: 1, sigs: sigs.length, expiration: tx.expiration, artifact: "signed-tx.b64" }));
