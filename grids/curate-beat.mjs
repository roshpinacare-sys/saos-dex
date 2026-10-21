#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// CURATE-BEAT — פעימת-האצירה-החיה (owner trace 1a15ceb5c5659485 · המגבר)
// ───────────────────────────────────────────────────────────────────────────
// תפקיד: פעם-ביום — תכנון-אצירה (curate.mjs, deterministic, חסר-מפתחות)
//   + ביצוע-חי עם מפתח-הפרסום-הייעודי (סביבת-ריצה בלבד; fail-closed).
// ראיות: כל-הצבעה = txid על-השרשרת → grids/state/curate-receipts.jsonl.
// אימות: מפתח-הפרסום מאומת מול רשות-הפרסום-החיה לפני-כל-שידור (key-gate).
// שימוש: node grids/curate-beat.mjs --once  |  --loop [hours=24]  |  --selftest
// ═══════════════════════════════════════════════════════════════════════════
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const RECEIPTS = join(HERE, "state", "curate-receipts.jsonl");
const KEYS = ["/home/z/.secrets/steem-posting-headcorner", "/home/z/my-project/.secrets/steem-posting-headcorner"];
const PUBS = ["/home/z/.secrets/steem-posting-headcorner.pub", "/home/z/my-project/.secrets/steem-posting-headcorner.pub"];
const ACCOUNT = "headcorner";

function loadPostingWif() {
  for (const p of KEYS) { try { const w = readFileSync(p, "utf8").trim(); if (w.length === 51 && (w[0] === "5" || w[0] === "6")) return { wif: w, path: p }; } catch { } }
  return null;
}

/* key-gate: המפתח-הנגזר חייב-להיות-ברשות-הפרסום-החיה-של-החשבון (ביט-מול-ביט) */
async function postingAuthorityOk(wif) {
  const steem = (await import("steem")).default;
  const pub = steem.auth.wifToPublic(wif);
  const nodes = ["https://api.steemit.com", "https://api.justyy.com", "https://steem-rpc.publicnode.com"];
  for (const node of nodes) {
    try {
      const r = await fetch(node, { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(9000), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "condenser_api.get_accounts", params: [[ACCOUNT]] }) });
      const j = await r.json();
      const a = j?.result?.[0]; if (!a) continue;
      const posting = typeof a.posting === "string" ? JSON.parse(a.posting) : a.posting;
      const pubs = (posting.key_auths ?? []).map((k) => k[0]);
      return { ok: pubs.includes(pub), pub, keysOnChain: pubs.length };
    } catch { }
  }
  return { ok: false, pub, reason: "all-nodes-failed" };
}

export async function curateBeatOnce({ dailyLimit = 8, maxWeightPct = 2 } = {}) {
  const { planCurations, executeVotes } = await import("./curate.mjs");
  const k = loadPostingWif();
  const plan = await planCurations({ account: ACCOUNT, dailyLimit: dailyLimit * 2, maxWeightPct });
  // נגד-כפילות: הצבעה-חוזרת על אותו פוסט אינה מוסיפה rshares — מסננים מול הקבלות-היום
  const votedToday = new Set();
  try {
    const cutoff = Date.now() - 24 * 3600e3;
    for (const ln of readFileSync(RECEIPTS, "utf8").split("\n")) {
      if (!ln.trim()) continue;
      try {
        const r = JSON.parse(ln);
        if (Date.parse(r.at) >= cutoff) for (const v of r.votes ?? []) votedToday.add(`${v.author}/${v.permlink}`);
      } catch { }
    }
  } catch { }
  const fresh = plan.votes.filter((v) => !votedToday.has(`${v.author}/${v.permlink}`)).slice(0, dailyLimit);
  const deduped = { ...plan, votes: fresh };
  if (!k) {
    const rec = { schema: "SAOS-CURATE-BEAT/1", at: new Date().toISOString(), verdict: "KEYLESS-PLAN-ONLY", planned: plan.votes.length, why: "no posting WIF in environment (fail-closed honest)" };
    appendFileSync(RECEIPTS, JSON.stringify(rec) + "\n");
    return rec;
  }
  const gate = await postingAuthorityOk(k.wif);
  if (!gate.ok) {
    const rec = { schema: "SAOS-CURATE-BEAT/1", at: new Date().toISOString(), verdict: "KEY-GATE-REFUSED", planned: deduped.votes.length, pub: gate.pub, why: gate.reason ?? "posting authority mismatch" };
    appendFileSync(RECEIPTS, JSON.stringify(rec) + "\n");
    return rec;
  }
  if (deduped.votes.length === 0) {
    const rec = { schema: "SAOS-CURATE-BEAT/1", at: new Date().toISOString(), verdict: "ALL-DUP-SKIPPED", executed: 0, planned: 0, pub: gate.pub, votes: [] };
    appendFileSync(RECEIPTS, JSON.stringify(rec) + "\n");
    return rec;
  }
  const r = await executeVotes(deduped, { wif: k.wif });
  const rec = { schema: "SAOS-CURATE-BEAT/1", at: new Date().toISOString(), verdict: r.executed > 0 ? "VOTED-LIVE" : "NOTHING-TO-VOTE", executed: r.executed, planned: deduped.votes.length, pub: gate.pub, votes: r.txids };
  appendFileSync(RECEIPTS, JSON.stringify(rec) + "\n");
  return rec;
}

export function selftest() {
  const A = (c, m) => { if (!c) { console.error("SELFTEST-FAIL:", m); process.exit(1); } };
  A(loadPostingWif() === null || loadPostingWif().wif.length === 51, "wif shape if present");
  A(KEYS.every((p) => !p.includes("upload/")), "beat never reads owner files");
  console.log("curate-beat selftest OK");
}

const argv = process.argv.slice(2);
if (argv.includes("--selftest")) selftest();
else if (argv.includes("--once")) {
  try { const r = await curateBeatOnce(); console.log(JSON.stringify({ verdict: r.verdict, executed: r.executed ?? 0, planned: r.planned ?? 0 })); }
  catch (e) { console.error(`[curate-beat] fail-honest: ${String(e?.message ?? e).slice(0, 160)}`); process.exit(1); }
} else {
  const hours = Math.max(1, parseFloat(argv[argv.indexOf("--loop") + 1] ?? "24") || 24);
  const tick = async () => { try { const r = await curateBeatOnce(); console.log(new Date().toISOString(), r.verdict, r.executed ?? 0); } catch (e) { console.error(`[curate-beat] fail-honest: ${String(e?.message ?? e).slice(0, 120)}`); } };
  await tick();
  setInterval(tick, hours * 3600e3);
  console.log(`[curate-beat] loop every ${hours}h`);
}
