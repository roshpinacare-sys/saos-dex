/**
 * probe-v2.ts — Roast-74 · עומק-אמת-שני (אפס-סודות-בפלט: מפתחות-ציבוריים-בלבד)
 * 1) STEEM: למי שייך STEEM_ACTIVE_WIF באמת (headcorner / headcorner-archive / אף-אחד) — כל-3-הרשויות
 * 2) BLURT: הצלבת-pubKey-מהכספת-האם מול-השרשרת (BLT5HhJD…) + גזירה-מה-WIF-אם-יש-בסביבה
 * 3) קרנן-הגרעין: אוצר/feeMeter/בריכות — עבור-העמקת-בריכות
 */
import steemLibRaw from "steem";
import { PrismaClient } from "@prisma/client";

interface SteemAuth { auth: { wifToPublic(wif: string): string } }
const steemLib = steemLibRaw as unknown as SteemAuth;
const STEEM_NODES = ["https://api.steemit.com", "https://api.justyy.com"];
const ACCOUNT = (process.env.HIVE_ANCHOR_ACCOUNT || "headcorner").toLowerCase().trim();

async function steemAuths(account: string): Promise<{ active: string[]; posting: string[]; owner: string[] } | null> {
  for (const node of STEEM_NODES) {
    try {
      const r = await fetch(node, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "condenser_api.get_accounts", params: [[account]], id: 1 }) });
      const j = (await r.json()) as { result?: Record<string, unknown>[] };
      const a = j.result?.[0];
      if (!a) return null;
      const pick = (x: unknown) => (((x as { key_auths?: [string, number][] })?.key_auths ?? []).map((k) => k[0]));
      return { active: pick(a.active), posting: pick(a.posting), owner: pick(a.owner) };
    } catch { /* צומת-הבא */ }
  }
  return null;
}

async function main() {
  console.log("== 1) STEEM-identity ==");
  const wifActive = (process.env.STEEM_ACTIVE_WIF || "").trim();
  if (wifActive) {
    let pub = "";
    try { pub = steemLib.auth.wifToPublic(wifActive); } catch { console.log("derive-failed"); }
    if (pub) {
      console.log(`derived pub: ${pub}`);
      for (const acc of [ACCOUNT, "headcorner-archive"]) {
        const auths = await steemAuths(acc);
        if (!auths) { console.log(`${acc}: unreachable`); continue; }
        console.log(`${acc}: active=${auths.active.includes(pub)} posting=${auths.posting.includes(pub)} owner=${auths.owner.includes(pub)}`);
      }
    }
  } else console.log("STEEM_ACTIVE_WIF missing");

  console.log("== 2) BLURT-vault-cross ==");
  const p = new PrismaClient({ datasources: { db: { url: "file:" + process.cwd().replace(/\/saos-dex$/, "") + "/db/custom.db" } } });
  try {
    const rows = await p.$queryRawUnsafe(`SELECT account, role, pubKey, fingerprint FROM VaultKey WHERE chain = 'blurt' AND role = 'active'`);
    for (const r of rows as { account: string; role: string; pubKey: string | null; fingerprint: string }[]) {
      console.log(`vault: ${r.account}/${r.role} pub=${r.pubKey ?? "-"} fp=${r.fingerprint.slice(0, 8)}`);
    }
  } catch (e) { console.log("vault-err:", String(e).slice(0, 120)); }
  await p.$disconnect();
  // אם-BLURT_ACTIVE_WIF-כבר-בסביבה — נגזור-ונצליב
  const bw = (process.env.BLURT_ACTIVE_WIF || "").trim();
  if (bw) {
    try {
      const body = steemLib.auth.wifToPublic(bw).replace(/^STM/, "");
      console.log(`BLURT_ACTIVE_WIF present → body-match BLT5HhJD…? ${body === "5HhJD5WUXu8vPhDmLaC2fTuuJYkwxF62Rt17HZ5G2PbnBvuHXF"} · derived-pub(BLT): BLT${body}`);
    } catch { console.log("BLURT_ACTIVE_WIF derive-failed"); }
  } else console.log("BLURT_ACTIVE_WIF: absent in env");

  console.log("== 3) kernel-state (מקומי — קריאת-API-בלבד) ==");
  const res = await fetch("http://127.0.0.1:3010/saos-dex/api/dex/kernel");
  const j = (await res.json()) as Record<string, unknown>;
  const s = (j.state ?? {}) as Record<string, unknown>;
  const bal = (s.balances ?? {}) as Record<string, Record<string, number>>;
  const treasury = bal["treasury"] ?? {};
  console.log("treasury:", JSON.stringify(treasury));
  console.log("feeMeter:", JSON.stringify((s as { feeMeter?: unknown }).feeMeter));
  const pools = (s.pools ?? {}) as Record<string, unknown>;
  console.log("pools:", Object.keys(pools).join(", "));
  for (const [k, v] of Object.entries(pools)) console.log(`  ${k}:`, JSON.stringify(v));
}
main().catch((e) => { console.log("fatal:", String(e).slice(0, 150)); });
