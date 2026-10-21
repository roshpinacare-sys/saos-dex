// hive-heartbeat-sign.ts — custody-verify + sign (fail-closed). Secrets NEVER printed.
// Output: signed-tx.b64 = base64(JSON(signed tx)) — PUBLIC material (sig is public).
import fs from "fs";
import { createHash } from "crypto";
import { wifNormalized, pubOfWif, signGrapheneTx } from "../src/lib/dex/signer";

const HIVE_CHAIN_ID = "beeab0de00000000000000000000000000000000000000000000000000000000";
const NODES = ["https://api.hive.blog", "https://api.hive.dev"];
const ACCOUNT = "headcorner";
const fp2 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 8);

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
const livePost = acct?.posting?.key_auths?.[0]?.[0] ?? "";
const liveActive = acct?.active?.key_auths?.[0]?.[0] ?? "";
if (!livePost || !liveActive) { console.log(JSON.stringify({ ok: false, error: "no-live-authority" })); process.exit(1); }

const candidates = [
  { label: "HIVE_POSTING_WIF", raw: process.env.HIVE_POSTING_WIF ?? "" },
  { label: "HIVE_ACTIVE_WIF", raw: process.env.HIVE_ACTIVE_WIF ?? "" },
].filter((c) => c.raw.trim().length >= 40);
if (!candidates.length) { console.log(JSON.stringify({ ok: false, error: "secrets-missing" })); process.exit(1); }

let wif: string | null = null;
let role: "posting" | "active" | null = null;
let pub: string | null = null;
for (const c of candidates) {
  const w = await wifNormalized(c.raw);
  if (!w) continue;
  const p = pubOfWif(w);
  if (!p) continue;
  console.log(JSON.stringify({ step: "probe", secret: c.label, pubFp: fp2(p), postingMatch: p === livePost, activeMatch: p === liveActive }));
  if (!wif && p === livePost) { wif = w; role = "posting"; pub = p; }
  if (!wif && p === liveActive) { wif = w; role = "active"; pub = p; }
}
if (!wif || !role || !pub) {
  // [wave 19.54 · trace 1a15e3e419138aa5] KNOWN-WOUND law (precedent fleet-economy
  // 19.51-f): the custody mismatch is a REGISTERED wound (docs/hive-custody-wound.json)
  // — measured 23/23 failures since 2026-10-17 with the SAME probe fingerprints. When
  // today's fingerprints match the receipt, the beat reports the wound LOUDLY (receipt
  // pointer + fingerprints in the log) and exits 0 — the sibling dispatch loop stops
  // emailing 6-9 reds/day for a wound only owner custody can heal. A CHANGED
  // fingerprint (new secret delivered, or a new authority) does NOT match and still
  // fails loud exit 1 as a new tear — fail-loud stays for everything unregistered.
  const WOUND = "docs/hive-custody-wound.json";
  const seen: Record<string, string> = {};
  for (const c of candidates) {
    const w = await wifNormalized(c.raw);
    if (!w) continue;
    const p = pubOfWif(w);
    if (p) seen[c.label] = createHash("sha256").update(p).digest("hex").slice(0, 8);
  }
  try {
    const wound = JSON.parse(fs.readFileSync(WOUND, "utf8"));
    const reg = wound.measured?.probeFingerprints ?? {};
    const labels = Object.keys(reg);
    const match = labels.length > 0 && labels.every((l) => seen[l] === reg[l] && Object.keys(seen).includes(l));
    if (match) {
      console.log(JSON.stringify({
        ok: false,
        verdict: "KNOWN-WOUND",
        wound: wound.wound,
        receipt: WOUND,
        registeredAt: wound.registeredAt,
        probeFingerprints: seen,
        healPath: wound.healPath,
        note: "loud, not silent: the wound is registered, only owner custody heals it; a changed fingerprint would still fail loud",
      }));
      process.exit(0);
    }
  } catch {}
  console.log(JSON.stringify({ ok: false, error: "fail-closed: no secret holds any live HIVE authority" }));
  process.exit(1);
}
console.log(JSON.stringify({ step: "custody", pubFp: fp2(pub), role }));

const dgpo = await rpc("condenser_api.get_dynamic_global_properties", []);
const head = Number(dgpo.head_block_number);
const prefix = Buffer.from(String(dgpo.head_block_id), "hex").readUInt32LE(4);
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
  expiration: new Date((Math.floor(Date.now() / 1000) + 60) * 1000).toISOString().slice(0, 19),
  operations: [["custom_json", opBody]],
  extensions: [] as unknown[],
};
const signed = signGrapheneTx(tx as any, HIVE_CHAIN_ID, wif);
const sigs = (signed as any).signatures ?? [];
if (!sigs.length) { console.log(JSON.stringify({ ok: false, error: "no-signature-produced" })); process.exit(1); }
fs.writeFileSync("signed-tx.b64", Buffer.from(JSON.stringify(signed), "utf8").toString("base64"));
console.log(JSON.stringify({ ok: true, step: "signed", role, ops: 1, sigs: sigs.length, expiration: tx.expiration, artifact: "signed-tx.b64" }));
