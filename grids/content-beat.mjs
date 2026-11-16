#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// CONTENT-BEAT — מסילת-התוכן-המקורי · צרכן-ההכנסה הראשון של גשר-ה-LLM (§51)
// פקודת-בעלים: «בצע הכל ויותר ודחוף · אל-תסתמך-על-טענות-של-מחר»
// ───────────────────────────────────────────────────────────────────────────
// מה-זו: פעימת-תוכן ריבונית — כל-פעימה אוספת-נתוני�-חיים-נמדדים מהשרשרת
// (מחיר-מזין, מאזני-עמדות, המרות-בטיסה, סטטיסטיקות-צי) ← גשר-ה-LLM של-הצי
// (llm-call.mjs · ספק-הסטים-NIM ראשון-בסדר) כותב-תוכן-מקורי דו-לשוני ←
// חתימה-במפתח-הפרסום-הייעודי (key-gate מול-רשות-הפרסום-החיה) ← פוסט-אמת
// על-השרשרת ← קבלה-נאטמת-לגיט (content-receipts.jsonl).
//
// דוקטרינה:
//   · posting-authority בלבד — אפס-מפתחות-אחרים בתהליך.
//   · עמוד-שדרה-של-נתונים: הטבלה-הספרתית נבנית-מהמדידה-בלבד (ה-LLM כותב
//     נרטיב — הנתונים-הסמכותיים מוצמדים-ע"י-הסקריפט, לא-ע"י-המודל).
//   · דדופ: מרווח-מינימלי 10ש' בין-פוסטים · מכסה 2/יום · permlink ייחודי.
//   · הצבעת-מחבר (author-lane): משקל 10% קבוע — תיעוד-גלוי בקבלה. מסלול
//     הקיורציה (curate.mjs) נשאר-אפס-הצבעה-עצמית על-תוכן-של-אחרים; כאן
//     המחבר-ממחזר-את-כוח-ההצבעה-של-עצמו-על-תוכן-של-עצמו (נוהג-מחברים
//     חוקי-במלוא-בשרשרת). כוח-ההצבעה-הנותר נשמר-למסלול-הקיורציה.
//   · fail-closed מלא: אין-LLM → HOLD כן (אין-פוסט-פנטום) · אין-מפתח →
//     KEYLESS-PLAN-ONLY · שער-מפתח-נכשל → אף-שידור.
//   · אפס-סודות-בפלט: שמות-משתני-סביבה-בלבד · redact על-כל-שגיאה.
// שימוש: node grids/content-beat.mjs --once | --plan (preview בלבד) | --selftest
// ═══════════════════════════════════════════════════════════════════════════
import { readFileSync, appendFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const RECEIPTS = join(HERE, "state", "content-receipts.jsonl");
const STATE = join(HERE, "state", "state.json");
const CURATE_RECEIPTS = join(HERE, "state", "curate-receipts.jsonl");
const KEYS = ["/home/z/.secrets/steem-posting-headcorner", "/home/z/my-project/.secrets/steem-posting-headcorner"];
const ACCOUNT = process.env.SAOS_CONTENT_ACCOUNT || "headcorner";
const MIN_GAP_MS = 10 * 3600 * 1000; // מרווח-מינימלי בין-פוסטים
const AUTHOR_VOTE_WEIGHT = 1000; // 10% — תיעוד-גלוי, קבוע
const STEEM_NODES = [
  "https://api.steemit.com",
  "https://api.justyy.com",
  "https://steem-rpc.publicnode.com",
  "https://api.steem.buzz",
];
const ALLOWED_TAGS = ["steem", "crypto", "market", "trading", "data", "hebrew", "israel", "blockchain", "defi"];

async function rpcAny(method, params) {
  let lastErr;
  for (let pass = 0; pass < 2; pass++) {
    for (const node of STEEM_NODES) {
      try {
        const r = await fetch(node, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(10000),
        });
        const text = await r.text();
        if (!text || !text.trim()) throw new Error("empty-body (transient node)");
        const j = JSON.parse(text);
        if (j.error) throw new Error(String(j.error.message ?? "rpc-error").slice(0, 80));
        return j.result;
      } catch (e) { lastErr = e; }
    }
    if (pass === 0) await new Promise((res) => setTimeout(res, 2000));
  }
  throw lastErr ?? new Error("all-rpc-nodes-failed");
}

/* ── 1 · איסוף-נתונים-חיים (חסר-מפתחות — כל-מספר נמדד-מהשרשרת) ──────────── */
export async function collectData() {
  const dgp = await rpcAny("condenser_api.get_dynamic_global_properties", []);
  const feed = await rpcAny("condenser_api.get_feed_history", []);
  const accs = await rpcAny("condenser_api.get_accounts", [[ACCOUNT]]);
  const a = accs?.[0];
  if (!a) throw new Error(`account ${ACCOUNT} not found on chain`);
  const conv = await rpcAny("condenser_api.get_conversion_requests", [ACCOUNT]).catch(() => []);

  const feedBase = parseFloat(String(feed?.current_median_history?.base ?? "0"));
  const feedQuote = parseFloat(String(feed?.current_median_history?.quote ?? "0"));
  const price = feedQuote > 0 ? feedBase / feedQuote : null; // SBD per STEEM

  const vestsPerSteem = Number(String(dgp.total_vesting_shares).split(" ")[0]) / Number(String(dgp.total_vesting_fund_steem).split(" ")[0]);
  const sp = Math.round((parseFloat(String(a.vesting_shares)) / vestsPerSteem) * 10) / 10;

  /* סטטיסטיקות-צי (fail-soft — המדידה-השרשרתית עומדת-גם-בלעדיהן) */
  let grid = null;
  try {
    const s = JSON.parse(readFileSync(STATE, "utf8"));
    grid = {
      runCount: s.runCount ?? null,
      realFills: s.feeMeter?.realFills ?? null,
      realizedSbd: typeof s.feeMeter?.realPnl?.realizedSbd === "number" ? Math.round(s.feeMeter.realPnl.realizedSbd * 1000) / 1000 : null,
      positionSteem: typeof s.feeMeter?.realPnl?.positionSteem === "number" ? Math.round(s.feeMeter.realPnl.positionSteem * 1000) / 1000 : null,
    };
  } catch { /* אמת-כנה: אין-state-מקומי (ריצת-ענן) */ }
  let curate = null;
  try {
    const lines = readFileSync(CURATE_RECEIPTS, "utf8").split("\n").filter((l) => l.trim().startsWith("{"));
    let votes24 = 0;
    const cutoff = Date.now() - 24 * 3600e3;
    for (const ln of lines) { try { const r = JSON.parse(ln); if (Date.parse(r.at) >= cutoff) votes24 += r.executed ?? 0; } catch {} }
    curate = { beatsTotal: lines.length, votes24 };
  } catch { /* אמת-כנה */ }

  return {
    at: new Date().toISOString(),
    headBlock: dgp.head_block_number,
    chainTime: String(dgp.time),
    priceSbdPerSteem: price ? Math.round(price * 10000) / 10000 : null,
    sbdPrintRate: dgp.sbd_print_rate,
    account: {
      name: ACCOUNT,
      steem: Math.round(parseFloat(String(a.balance)) * 1000) / 1000,
      sbd: Math.round(parseFloat(String(a.sbd_balance)) * 1000) / 1000,
      sp, votingPowerPct: Math.round(a.voting_power ?? 0) / 100,
    },
    conversionsInFlight: (conv ?? []).map((c) => ({ amount: c.amount, lands: c.conversion_date })),
    grid, curate,
  };
}

/* ── 2 · עמוד-השדרה-הספרתי (נבנה-מהמדידה — לא-מהמודל) ────────────────────── */
export function dataSpine(d) {
  const rows = [
    ["head block", String(d.headBlock)],
    ["feed price (SBD/STEEM)", d.priceSbdPerSteem === null ? "n/a" : String(d.priceSbdPerSteem)],
    ["SBD print rate", `${d.sbdPrintRate} / 10000`],
    [`${d.account.name} SP`, String(d.account.sp)],
    ["voting power", `${d.account.votingPowerPct}%`],
    ["liquid (STEEM / SBD)", `${d.account.steem} / ${d.account.sbd}`],
  ];
  if (d.grid) rows.push(["desk real fills (lifetime)", String(d.grid.realFills)], ["desk position (STEEM)", String(d.grid.positionSteem)]);
  if (d.curate) rows.push(["curation votes (24h)", String(d.curate.votes24)]);
  for (const c of d.conversionsInFlight) rows.push(["conversion in flight", `${c.amount} → lands ${c.lands}`]);
  const table = ["| metric | value |", "|---|---|", ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join("\n");
  return `## 📊 Measured on-chain data · נתונים נמדדים\n\n${table}\n\n*Measured directly from the Steem blockchain at ${d.at} by the SAOS sovereign data desk. Not financial advice.*`;
}

/* ── 3 · יצירת-התוכן דרך-גשר-ה-LLM של-הצי ────────────────────────────────── */
export async function generateDraft(d) {
  const { callLLM } = await import("./llm/llm-call.mjs");
  const { redact } = await import("./llm/llm-providers.mjs");
  const system = [
    "You are the editor of the SAOS Data Desk — a sovereign, measured-data publication on the Steem blockchain.",
    "You write an original daily market digest in TWO languages: Hebrew first, then English.",
    "Hard rules: (1) Only use the measured numbers provided — never invent numbers. (2) Original prose, no plagiarism, no boilerplate. (3) No financial advice, no price predictions — describe and analyze what is measured. (4) Hebrew section ~120-180 words, English section ~120-180 words. (5) Be concrete, calm, professional; a reader should learn something real about the Steem ecosystem today.",
    "Return STRICT JSON only, no markdown fences: {\"title\": string (bilingual, ≤95 chars), \"bodyHe\": string (markdown), \"bodyEn\": string (markdown), \"tags\": array of 3-5 tags from this list: steem, crypto, market, trading, data, hebrew, israel, blockchain, defi}",
  ].join("\n");
  const user = [
    `Today's measured data (all from the Steem chain, UTC ${d.at}):`,
    `head_block=${d.headBlock}, feed_price=${d.priceSbdPerSteem} SBD per STEEM, sbd_print_rate=${d.sbdPrintRate}`,
    `desk account ${d.account.name}: ${d.account.steem} STEEM liquid, ${d.account.sbd} SBD liquid, ${d.account.sp} SP, voting power ${d.account.votingPowerPct}%`,
    d.grid ? `market desk: ${d.grid.realFills} real on-chain fills lifetime, position ${d.grid.positionSteem} STEEM` : "",
    d.curate ? `curation desk: ${d.curate.votes24} votes in the last 24h across ${d.curate.beatsTotal} recorded beats` : "",
    d.conversionsInFlight.length ? `conversions in flight: ${d.conversionsInFlight.map((c) => c.amount + " lands " + c.lands).join("; ")}` : "no conversions in flight",
    "Write today's digest now (JSON).",
  ].filter(Boolean).join("\n");
  let lastErr;
  /* §51-לקח-ריצה-ראשונה (run 43876932429): דור-תוכן אינו-בדיקת-9-תווים — 30ש'
   * ברירת-המחדל של-הגשר קצרים-מדי לנמ-טרון-מייצר (פסק-זמן-כפול-מדוד).
   * החוק-החדש: 120ש' לדור-תוכן + מודל-גיבוי-שני באותו-ספק (gpt-oss-20b)
   * — שרשרת-ניסיונות מתועדת, HOLD כן רק-אחרי-כולם. */
  const tries = [
    { timeoutMs: 120_000 },
    { model: "nim/openai/gpt-oss-20b", timeoutMs: 120_000 },
  ];
  let raw = null;
  const notes = [];
  for (const t of tries) {
    try {
      const r = await callLLM({ messages: [{ role: "system", content: system }, { role: "user", content: user }], timeoutMs: t.timeoutMs, ...(t.model ? { model: t.model } : {}) });
      if (r?.content && String(r.content).trim().length > 0) { raw = r; break; }
    } catch (e) {
      notes.push(redact(String(e?.message ?? e)).slice(0, 90));
      lastErr = e;
    }
  }
  if (!raw) {
    throw new Error(`content-LLM-HOLD after ${tries.length} attempts: ${notes.join(" | ") || String(lastErr?.message ?? lastErr).slice(0, 120)}`);
  }
  let txt = String(raw.content ?? "").trim();
  txt = txt.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""); // הסרת-גדרות-אם-נכפו
  let j;
  try { j = JSON.parse(txt); } catch { throw new Error(`LLM-OUTPUT-NOT-JSON (len=${txt.length}, head=${txt.slice(0, 60).replace(/\s+/g, " ")})`); }
  const title = String(j.title ?? "").trim();
  const bodyHe = String(j.bodyHe ?? "").trim();
  const bodyEn = String(j.bodyEn ?? "").trim();
  let tags = Array.isArray(j.tags) ? j.tags.map((t) => String(t).toLowerCase().trim()).filter((t) => ALLOWED_TAGS.includes(t)) : [];
  tags = [...new Set(tags)].slice(0, 5);
  if (title.length < 8 || title.length > 120) throw new Error(`title-shape-invalid (len=${title.length})`);
  if (bodyHe.length < 200 || bodyEn.length < 200) throw new Error(`body-shape-invalid (he=${bodyHe.length}, en=${bodyEn.length} — מינימום-200 לכל-שפה)`);
  if (tags.length < 3) throw new Error(`tags-shape-invalid (${tags.length}/3)`);
  return { title, bodyHe, bodyEn, tags, provider: raw.provider, model: raw.model };
}

/* ── 4 · פתיחת-מפתח-הפרסום (env ← קבצי-מפתח-מקומיים — אותו-חוק-של-curate) ── */
export function loadPostingWif() {
  const env = String(process.env.STEEM_POSTING_WIF ?? "").trim();
  if (env.length === 51 && (env[0] === "5" || env[0] === "6")) return { wif: env, path: "env:STEEM_POSTING_WIF" };
  for (const p of KEYS) { try { const w = readFileSync(p, "utf8").trim(); if (w.length === 51 && (w[0] === "5" || w[0] === "6")) return { wif: w, path: p }; } catch {} }
  return null;
}

async function postingAuthorityOk(wif) {
  const steem = (await import("steem")).default;
  const pub = steem.auth.wifToPublic(wif);
  for (const node of STEEM_NODES) {
    try {
      const r = await fetch(node, { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(9000), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "condenser_api.get_accounts", params: [[ACCOUNT]] }) });
      const j = await r.json();
      const a = j?.result?.[0]; if (!a) continue;
      const posting = typeof a.posting === "string" ? JSON.parse(a.posting) : a.posting;
      const pubs = (posting.key_auths ?? []).map((k) => k[0]);
      return { ok: pubs.includes(pub), pub };
    } catch {}
  }
  return { ok: false, pub, reason: "all-nodes-failed" };
}

/* ── 5 · שידור-הפוסט (comment-op שורשי) + הצבעת-מחבר — אותו-נתיב-חתימה ──── */
async function permlinkFree(permlink) {
  try {
    const c = await rpcAny("condenser_api.get_content", [ACCOUNT, permlink]);
    return !(c && c.id !== 0 && c.author === ACCOUNT);
  } catch { return true; /* כשל-צומת — ה-broadcast ייתפס-שם בכנות */ }
}

async function signAndBroadcast(ops, wif) {
  let lastWhy = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const dgp = await rpcAny("condenser_api.get_dynamic_global_properties", []);
    const tx = {
      ref_block_num: Number(dgp.head_block_number) & 0xffff,
      ref_block_prefix: Buffer.from(String(dgp.head_block_id), "hex").readUInt32LE(4),
      expiration: new Date(new Date(String(dgp.time) + "Z").getTime() + 60_000).toISOString().slice(0, 19),
      operations: ops,
      extensions: [],
    };
    const steem = (await import("steem")).default;
    const signed = steem.auth.signTransaction(tx, [wif]);
    try {
      const res = await rpcAny("condenser_api.broadcast_transaction_synchronous", [{ ...signed }]);
      if (res?.id) return { txid: res.id, block: res.block_num ?? null };
      lastWhy = "broadcast answered without id";
    } catch (e) {
      lastWhy = String(e?.message ?? e).slice(0, 140);
      if (/duplicate/i.test(lastWhy)) return { txid: "duplicate-on-chain", block: null, duplicate: true };
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
  throw new Error(`broadcast failed after 3 attempts: ${lastWhy || "unknown"}`);
}

async function contentBeatOnce({ dryRun = false } = {}) {
  /* דדופ: מרווח-מינימלי בין-פוסטים */
  let lastPostAt = null; let posts24 = 0;
  try {
    const lines = readFileSync(RECEIPTS, "utf8").split("\n").filter((l) => l.trim().startsWith("{"));
    const cutoff = Date.now() - 24 * 3600e3;
    for (const ln of lines) {
      try {
        const r = JSON.parse(ln);
        if (r.verdict !== "POSTED-LIVE") continue;
        if (Date.parse(r.at) >= cutoff) posts24++;
        if (!lastPostAt || Date.parse(r.at) > Date.parse(lastPostAt)) lastPostAt = r.at;
      } catch {}
    }
  } catch { /* קבלות-ראשונות — אין-היסטוריה */ }
  if (lastPostAt && Date.now() - Date.parse(lastPostAt) < MIN_GAP_MS) {
    return { schema: "SAOS-CONTENT-BEAT/1", at: new Date().toISOString(), verdict: "GAP-SKIP", why: `last post ${lastPostAt} < ${MIN_GAP_MS / 3600e3}h ago`, posts24 };
  }
  if (posts24 >= 2) {
    return { schema: "SAOS-CONTENT-BEAT/1", at: new Date().toISOString(), verdict: "QUOTA-SKIP", why: "2 posts in 24h already", posts24 };
  }

  /* 1 · נתונים-חיים */
  const d = await collectData();

  /* 2 · טיוטת-LLM */
  const draft = await generateDraft(d);
  const spine = dataSpine(d);
  const body = `${draft.bodyHe}\n\n---\n\n${draft.bodyEn}\n\n---\n\n${spine}`;

  if (dryRun) {
    return { schema: "SAOS-CONTENT-BEAT/1", at: d.at, verdict: "PLAN-ONLY", title: draft.title, tags: draft.tags, provider: draft.provider, model: draft.model, bodyLenHe: draft.bodyHe.length, bodyLenEn: draft.bodyEn.length, spineLen: spine.length };
  }

  /* 3 · מפתח + שער */
  const k = loadPostingWif();
  if (!k) {
    return { schema: "SAOS-CONTENT-BEAT/1", at: new Date().toISOString(), verdict: "KEYLESS-PLAN-ONLY", title: draft.title, provider: draft.provider, note: "STEEM_POSTING_WIF absent — nothing signed (fail-closed)" };
  }
  const gate = await postingAuthorityOk(k.wif);
  if (!gate.ok) {
    const rec = { schema: "SAOS-CONTENT-BEAT/1", at: new Date().toISOString(), verdict: "KEY-GATE-REFUSED", why: gate.reason ?? "posting authority mismatch" };
    appendReceipt(rec); return rec;
  }

  /* 4 · permlink ייחודי + שידור */
  const day = new Date().toISOString().slice(0, 10);
  let permlink = `saos-data-digest-${day}`;
  if (!(await permlinkFree(permlink))) permlink = `saos-data-digest-${day}-${new Date().toISOString().slice(11, 13)}${new Date().toISOString().slice(14, 16)}`;
  const jsonMeta = { tags: draft.tags, app: "saos-data-desk/1.0", format: "markdown", generated_by: "saos-content-beat/1", model: `${draft.provider}/${draft.model}` };
  const post = await signAndBroadcast([["comment", {
    parent_author: "", parent_permlink: draft.tags[0] || "steem",
    author: ACCOUNT, permlink, title: draft.title, body, json_metadata: JSON.stringify(jsonMeta),
  }]], k.wif);

  /* 5 · הצבעת-מחבר (author-lane · 10% · תיעוד-גלוי) — fail-soft: כישלון-הצבעה
   *     אינו-פוסל-את-הפוסט (הקבלה-תעיד-בכנות) */
  let vote = null;
  try {
    vote = await signAndBroadcast([["vote", { voter: ACCOUNT, author: ACCOUNT, permlink, weight: AUTHOR_VOTE_WEIGHT }]], k.wif);
  } catch (e) { vote = { error: String(e?.message ?? e).slice(0, 120) }; }

  /* 6 · קבלה */
  const rec = {
    schema: "SAOS-CONTENT-BEAT/1", at: new Date().toISOString(), verdict: "POSTED-LIVE",
    account: ACCOUNT, permlink, title: draft.title,
    txid: post.txid, block: post.block, authorVoteTxid: vote?.txid ?? null, authorVoteError: vote?.error ?? null,
    authorVoteWeightPct: AUTHOR_VOTE_WEIGHT / 100, doctrine: "author-lane self-vote 10% (curate lane stays zero-self-vote on others' content)",
    llm: { provider: draft.provider, model: draft.model },
    dataFingerprint: { headBlock: d.headBlock, price: d.priceSbdPerSteem, at: d.at },
    bodyLen: body.length, posts24: posts24 + 1,
  };
  appendReceipt(rec);
  return rec;
}

function appendReceipt(rec) {
  try {
    if (!existsSync(dirname(RECEIPTS))) mkdirSync(dirname(RECEIPTS), { recursive: true });
    if (!existsSync(RECEIPTS)) writeFileSync(RECEIPTS, "", { mode: 0o644 });
    appendFileSync(RECEIPTS, JSON.stringify(rec) + "\n");
  } catch (e) { console.error("receipt-append-failed (honest):", String(e?.message ?? e).slice(0, 80)); }
}

/* ── CLI ─────────────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
if (process.argv[1] && process.argv[1].endsWith("content-beat.mjs")) {
if (argv.includes("--selftest")) {
  const A = (c, m) => { if (!c) { console.error("SELFTEST-FAIL:", m); process.exit(1); } };
  const d = { at: "2026-11-16T00:00:00Z", headBlock: 111375916, priceSbdPerSteem: 0.1041, sbdPrintRate: 0, account: { name: "x", steem: 1, sbd: 2, sp: 100, votingPowerPct: 50 }, conversionsInFlight: [], grid: null, curate: null };
  const spine = dataSpine(d);
  A(spine.includes("111375916") && spine.includes("0.1041"), "spine carries measured numbers");
  A(MIN_GAP_MS === 10 * 3600e3, "min-gap law");
  A(AUTHOR_VOTE_WEIGHT === 1000, "author-vote weight fixed 10%");
  A(KEYS.every((p) => !p.includes("upload/")), "never reads owner files");
  console.log("content-beat selftest OK");
} else if (argv.includes("--once") || argv.includes("--plan")) {
  const dryRun = argv.includes("--plan");
  const attempt = async () => { const r = await contentBeatOnce({ dryRun }); console.log(JSON.stringify(r)); return r; };
  try {
    const r = await attempt();
    if (r.verdict === "KEY-GATE-REFUSED") process.exitCode = 1; // אדום-כן — שער-מפתח-הוא-חוק
  } catch (e1) {
    console.error(`[content-beat] attempt-1 failed (${String(e1?.message ?? e1).slice(0, 140)}) — waiting 45s, one retry (§㊿ law)`);
    await new Promise((res) => setTimeout(res, 45_000));
    try { await attempt(); }
    catch (e2) { console.error(`[content-beat] fail-honest (2 attempts): ${String(e2?.message ?? e2).slice(0, 180)}`); process.exit(1); }
  }
} else {
  console.log("usage: node grids/content-beat.mjs --once | --plan | --selftest");
}
}
