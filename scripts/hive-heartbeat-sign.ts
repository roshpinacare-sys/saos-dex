// hive-heartbeat-sign.ts — custody-verify + sign (fail-closed). Secrets NEVER printed.
// Output: signed-tx.b64 = base64(JSON(signed tx)) — PUBLIC material (sig is public).
import fs from "fs";
import { wifNormalized, pubOfWif, signGrapheneTx } from "../src/lib/dex/signer";

const HIVE_CHAIN_ID = "beeab0de00000000000000000000000000000000000000000000000000000000";
const NODES = ["https://api.hive.blog", "https://api.hive.dev"];
const ACCOUNT = "headcorner";

const rawPost = process.env.HIVE_POSTING_WIF ?? "";
const rawActive = process.env.HIVE_ACTIVE_WIF ?? "";
const candidates: Array<{ label: string; raw: string }> = [
  { label: "HIVE_POSTING_WIF", raw: rawPost },
  { label: "HIVE_ACTIVE_WIF", raw: rawActive },
].filter((c) => c.raw.trim().length >= 40);
if (!candidates.length) { console.log(JSON.stringify({ ok: false, error: "secrets-missing" })); process.exit(1); }
const liveAll = { posting: "", active: "" };
{
  const [acct] = await rpc("condenser_api.get_accounts", [[ACCOUNT]]);
  liveAll.posting = acct?.posting?.key_auths?.[0]?.[0] ?? "";
  liveAll.active = acct?.active?.key_auths?.[0]?.[0] ?? "";
}
let wif: string | null = null; let role: "posting" | "active" | null = null;
const fp2 = (s: string) => require("crypto").createHash("sha256").update(s).digest("hex").slice(0, 8);
for (const c of candidates) {
  const w = await wifNormalized(c.raw);
  if (!w) continue;
  const p = pubOfWif(w);
  if (!p) continue;
  console.log(JSON.stringify({ step: "probe", secret: c.label, pubFp: fp2(p), postingMatch: p === liveAll.posting, activeMatch: p === liveAll.active }));
  if (p === liveAll.posting && !wif) { wif = w; role = "posting"; }
  if (p === liveAll.active && !wif) { wif = w; role = "active"; }
}
if (!wif) { console.log(JSON.stringify({ ok: false, error: "fail-closed: no secret holds any live HIVE authority" })); process.exit(1); }
const pub = pubOfWif(wif)!;
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

console.log(JSON.stringify({ step: "custody", pubFp: fp2(pub), role }));

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
const opBody = role === "posting"
  ? { required_auths: [], required_posting_auths: [ACCOUNT], id: "saos.weave.v1", json: JSON.stringify(payload) }
  : { required_auths: [ACCOUNT], required_posting_auths: [], id: "saos.weave.v1", json: JSON.stringify(payload) };
const tx = {
  ref_block_num: head & 0xffff,
  ref_block_prefix: prefix,
  expiration: new Date(expSec * 1000).toISOString().slice(0, 19),
  operations: [["custom_json", opBody]],
  extensions: [] as unknown[],
};
const signed = signGrapheneTx(tx as any, HIVE_CHAIN_ID, wif);
const sigs = (signed as any).signatures ?? [];
if (!sigs.length) { console.log(JSON.stringify({ ok: false, error: "no-signature-produced" })); process.exit(1); }
fs.writeFileSync("signed-tx.b64", Buffer.from(JSON.stringify(signed), "utf8").toString("base64"));
console.log(JSON.stringify({ ok: true, step: "signed", ops: 1, sigs: sigs.length, expiration: tx.expiration, artifact: "signed-tx.b64" }));
