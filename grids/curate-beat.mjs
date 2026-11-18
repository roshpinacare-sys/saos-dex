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
  /* N4 (cycle 28): מסלול-env לרצי-ענן — secrets.STEEM_POSTING_WIF ב-workflow.
   * אותו-בדיקת-צורה fail-closed (WIF-טעון = 51 תווים, מתחיל ב-5/6). אפס-סוד-בלוג. */
  const env = String(process.env.STEEM_POSTING_WIF ?? "").trim();
  if (env.length === 51 && (env[0] === "5" || env[0] === "6")) return { wif: env, path: "env:STEEM_POSTING_WIF" };
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

export async function curateBeatOnce({ dailyLimit = 20, maxWeightPct = 10 } = {}) {
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
  const fresh = plan.votes.filter((v) => !votedToday.has(`${v.author}/${v.permlink}`));
  /* §51 · דירוג-אוצרות-LLM (צרכן-ההכנסה-השני-של-הגשר): הצי-מדרג-את-המועמדים
   * לפי-איכות-תוכן-אמיתית (מקוריות · מהות · רלוונטיות) — לא-רק-מטריקות-מעורבות.
   * חוקים: fail-soft מלא (כישלון-LLM → הסדר-הדטרמיניסטי-נשאר-כהלכה) ·
   * הדירוג-רק-מסדר-מחדש מועמדים-שכבר-עברו-את-כל-המסננות-הדוקטרינריות ·
   * הקבלה-מתעדת-את-הפסק (provider/model/applied) — מדיד-לכל-אורך-הדרך. */
  const llm = await llmReRank(fresh);
  const ranked = llm.applied ? llm.votes : fresh;
  const deduped = { ...plan, votes: ranked.slice(0, dailyLimit) };
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
  const rec = { schema: "SAOS-CURATE-BEAT/1", at: new Date().toISOString(), verdict: r.executed > 0 ? "VOTED-LIVE" : "NOTHING-TO-VOTE", executed: r.executed, planned: deduped.votes.length, pub: gate.pub, llmRank: { applied: llm.applied, provider: llm.provider ?? null, model: llm.model ?? null, why: llm.why ?? null }, votes: r.txids };
  appendFileSync(RECEIPTS, JSON.stringify(rec) + "\n");
  return rec;
}

/* ── דירוג-אוצרות-LLM (§51) — fail-soft מלא, הפיך-ומתועד ───────────────────── */
async function llmReRank(votes) {
  if (process.env.CURATE_LLM_RANK !== "1") return { applied: false, why: "off" };
  if (!Array.isArray(votes) || votes.length < 3) return { applied: false, why: "too-few-candidates" };
  const pool = votes.slice(0, 30); // חלון-דירוג: 30-המובילים-הדטרמיניסטיים
  try {
    const { callLLM } = await import("./llm/llm-call.mjs");
    const system = [
      "You are the curation quality ranker of a sovereign Steem curation desk.",
      "You receive candidate posts that already passed deterministic filters (age-window, engagement, topic, dedup, no-self-vote).",
      "Your job: order them BEST-FIRST for curation value — original substantive content over low-effort templates, spam, reposts, or clickbait. Consider: originality, depth, community value, relevance to crypto/blockchain/data topics.",
      "Return STRICT JSON only: {\"order\": [array of candidate indices, best first]} — every index 0-" + (pool.length - 1) + " exactly once.",
    ].join("\n");
    const user = pool.map((v, i) => `[${i}] @${v.author} · score=${v.score} · ${v.title || "(no title)"}`).join("\n");
    /* §51-לקח-ריצה-43878123982: ברירת-המחדל 30ש' קצרה-גם-לדירוג — נמ-טרון-בעומס
     * עונה-ב-30-120ש' (נמדד: דור-תוכן הצליח-ב-120ש' באותו-יום). 90ש' + תיעוד-סיבה-מלא. */
    const raw = await callLLM({ messages: [{ role: "system", content: system }, { role: "user", content: user }], timeoutMs: 90_000 });
    let txt = String(raw.content ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
    const j = JSON.parse(txt);
    if (!Array.isArray(j.order)) throw new Error("order-missing");
    const seen = new Set();
    const ordered = [];
    for (const idx of j.order) {
      const i = Number(idx);
      if (!Number.isInteger(i) || i < 0 || i >= pool.length || seen.has(i)) continue;
      seen.add(i); ordered.push(pool[i]);
    }
    if (ordered.length < Math.min(3, pool.length)) throw new Error(`order-too-thin (${ordered.length})`);
    for (let i = 0; i < pool.length; i++) if (!seen.has(i)) ordered.push(pool[i]); // זנב-שמור-מהסדר-הדטרמיניסטי
    return { applied: true, provider: raw.provider, model: raw.model, votes: ordered };
  } catch (e) {
    const { redact } = await import("./llm/llm-providers.mjs").catch(() => ({ redact: (s) => String(s ?? "") }));
    return { applied: false, why: redact(String(e?.message ?? e)).slice(0, 220) };
  }
}

export function selftest() {
  const A = (c, m) => { if (!c) { console.error("SELFTEST-FAIL:", m); process.exit(1); } };
  A(loadPostingWif() === null || loadPostingWif().wif.length === 51, "wif shape if present");
  A(KEYS.every((p) => !p.includes("upload/")), "beat never reads owner files");
  // N4: defaults-המגבר נאטמים — 20 הצבות × 10% = 16% כוח-הצבעה/יום מול-רגנרציה 20% (קיימות 1.25×)
  console.log("curate-beat selftest OK");
}

const argv = process.argv.slice(2);
if (argv.includes("--selftest")) selftest();
else if (argv.includes("--once")) {
  /* §㊿ (2026-11-16): ניסיון-חוזר-אחד ברמת-הפעימה — מדידת-הכישלון של-06:21Z הראתה
   * סערת-רשת-חולפת שהפילה את-כל-הצמתים-בו-זמנית מה-runner. 45-שניות-המתנה
   * וניסיון-שני קולטות-את-רוב-הסערות; אחרי-שני-כישלונות — כישלון-כן (fail-closed). */
  const attempt = async () => { const r = await curateBeatOnce(); console.log(JSON.stringify({ verdict: r.verdict, executed: r.executed ?? 0, planned: r.planned ?? 0 })); return r; };
  try { await attempt(); }
  catch (e1) {
    console.error(`[curate-beat] ניסיון-ראשון-נכשל (${String(e1?.message ?? e1).slice(0, 120)}) — המתנה-45שנ' וניסיון-חוזר אחד (§㊿)`);
    await new Promise((res) => setTimeout(res, 45_000));
    try { await attempt(); }
    catch (e2) {
      console.error(`[curate-beat] ניסיון-שני-נכשל (${String(e2?.message ?? e2).slice(0, 120)}) — §68: המתנה-120שנ' וניסיון-שלישי (סערות-רשת ארוכות-מנמדד)`);
      await new Promise((res) => setTimeout(res, 120_000));
      try { await attempt(); }
      catch (e3) { console.error(`[curate-beat] fail-honest (3-ניסיונות): ${String(e3?.message ?? e3).slice(0, 160)}`); process.exit(1); }
    }
  }
} else {
  const hours = Math.max(1, parseFloat(argv[argv.indexOf("--loop") + 1] ?? "24") || 24);
  const tick = async () => { try { const r = await curateBeatOnce(); console.log(new Date().toISOString(), r.verdict, r.executed ?? 0); } catch (e) { console.error(`[curate-beat] fail-honest: ${String(e?.message ?? e).slice(0, 120)}`); } };
  await tick();
  setInterval(tick, hours * 3600e3);
  console.log(`[curate-beat] loop every ${hours}h`);
}
