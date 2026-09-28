// CURATE (A-12 · T-7) — מסילת-הקיורציה: הון-ה-SP עובד גם-בהצבעה
// ═══════════════════════════════════════════════════════════════════════════
// הרוסט: דיברנו על "מסילות-הכנסה" ולא בנינו אף-אחד מעבר לספר. ה-SP של
// headcorner (מדוד: ~$4.4K הון כולל) מפיק דלק-SP — אבל קיורציה היא מסילה
// שנייה על אותו-הון, בלי-הון-חדש: הצבעה-על-תוכן-עולה מניבה חלק-מפול-הפרס.
//
// דוקטרינה (מיושר ל-C-1/C-3/C-6):
//   · posting-authority בלבד — אפס-מפתחות-פעילים בתהליך קיורציה.
//   · אפס-הצבעה-עצמית · דדופ-מחברים (מקס 2 פר-מחבר) · מכסה-יומית · משקל-קטן.
//   · המנוע חסר-מפתחות: קורא feed ציבורי, מתכנן הצבעות עם סיבות-גלויות.
//   · הביצוע דורש STEEM_POSTING_WIF בסביבה-בזמן-ריצה (אותה-משמעת של
//     Domain/agents) — בלי-מפתח: דילוג-כנה, אפס-שידור.
//   · אמת: התוכנית דטרמיניסטית (מיון-יציב לפי score→permlink) — ניתנת
//     לחישוב-מחדש מ-RPC ציבורי על-ידי כל-מאמת.

import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const STEEM_NODES = ["https://api.steemit.com", "https://api.justyy.com", "https://steem-rpc.publicnode.com"];
const ACCOUNT = process.env.SAOS_RELAY_AGENT_ACCOUNT || "headcorner";

/* נושאים-בית: היכן שהידע-שלנו הוא-יתרון-אמת (משקל-קיורציה לתוכן-שאנחנו
 * מבינים — סינון-איכות טוב יותר, לא-רק-אפיניטי). ניתן-לדריסה בסביבה. */
export const TOPICS = (process.env.CURATE_TOPICS || "crypto,defi,steem,blockchain,engineering,hebrew,israel").split(",").map((s) => s.trim().toLowerCase());

const r6 = (v) => Math.round(v * 1e6) / 1e6;
const hours = (iso, now) => (now - new Date(iso + (iso?.endsWith("Z") ? "" : "Z")).getTime()) / 3600e3;

/* ── טהור: ניקוד-פוסט — חלון-גיל + מעורבות + אפיניטי-נושא ────────────────── */
export function scorePost(post, { now = Date.now(), topics = TOPICS } = {}) {
  const ageH = hours(post.created ?? post.posted ?? "", now);
  if (!(ageH > 0) || ageH > 168) return { score: 0, reason: `age-outside-window (${Number.isFinite(ageH) ? Math.round(ageH) + "h" : "unparseable"})` };
  if (ageH > 120) return { score: 0, reason: `too-old ${Math.round(ageH)}h (curation window closing)` };

  /* חלון-מתכון: 6–30h השיא — מספיק-מוקדם לחלק-קיורציה, מספיק-מאוחר לסינון-זבל */
  const ageScore = ageH < 2 ? 0.4 : ageH < 6 ? 0.9 : ageH <= 30 ? 1.0 : ageH <= 72 ? 0.6 : 0.25;

  const votes = Math.max(post.active_votes?.length ?? 0, post.net_votes ?? 0);
  const comments = post.children ?? 0;
  const engagement = 1 + Math.log2(1 + votes) * 0.6 + Math.log2(1 + comments) * 0.4;
  /* עונש-רוויה: פוסט-ענק-כבר-התחלק — קיורציה-שלו זולה; מתונים שווים-יותר */
  const saturation = votes > 400 ? 0.5 : votes > 150 ? 0.75 : 1.0;

  const tags = [post.category, ...(post.json_metadata?.tags ?? [])].filter(Boolean).map((s) => String(s).toLowerCase());
  const topicHit = tags.some((t) => topics.includes(t));
  const affinity = topicHit ? 1.3 : 0.85;

  const score = r6(ageScore * engagement * saturation * affinity);
  const reasons = [`age=${Math.round(ageH)}h(band ${ageScore})`, `votes=${votes}`, `comments=${comments}`, topicHit ? "topic-hit×1.3" : "off-topic×0.85", saturation < 1 ? `saturated×${saturation}` : "fresh"];
  return { score, reason: reasons.join(" · ") };
}

/* ── טהור: תוכנית-הצבעות — מכסה, דדופ, אפס-הצבעה-עצמית, משקלי-רצועות ────── */
export function planVotes({ posts, account = ACCOUNT, dailyLimit = 8, maxWeightPct = 2, minScore = 1, now = Date.now(), topics = TOPICS } = {}) {
  const seen = {};
  const votes = [];
  for (const post of posts ?? []) {
    const author = post.author;
    const permlink = post.permlink;
    if (!author || !permlink) continue;
    if (author === account) continue; // אפס-הצבעה-עצמית — דוקטרינה
    if ((post.active_votes ?? []).some((v) => v.voter === account)) continue; // כבר-הצבענו
    if ((seen[author] ?? 0) >= 2) continue; // גיוון-מחברים: מקס 2 פר-מחבר
    const s = scorePost(post, { now, topics });
    if (s.score < minScore) continue;
    seen[author] = (seen[author] ?? 0) + 1;
    votes.push({ author, permlink, score: s.score, reason: s.reason });
  }
  /* מיון-יציב דטרמיניסטי: score יורד → permlink עולה (שובר-שוויון מוכח) */
  votes.sort((a, b) => b.score - a.score || (a.permlink < b.permlink ? -1 : 1));
  const capped = votes.slice(0, dailyLimit);
  for (const v of capped) {
    const pct = v.score >= 3 ? maxWeightPct : v.score >= 2 ? maxWeightPct * 0.6 : maxWeightPct * 0.4;
    v.weightPct = Math.round(pct * 100) / 100;
    v.weightSteemUnits = Math.round(pct * 100); // steem vote op: 10000 = 100%
    if (v.weightSteemUnits < 1) v.weightSteemUnits = 1;
    if (v.weightSteemUnits > maxWeightPct * 100) v.weightSteemUnits = Math.round(maxWeightPct * 100);
  }
  return { account, plannedAt: new Date(now).toISOString(), votes: capped, doctrine: { selfVote: false, maxPerAuthor: 2, dailyLimit, maxWeightPct, postingOnly: true } };
}

/* ── רשת: קריאת-מועמדים חסרת-מפתחות (created + trending, סולם-RPC) ───────── */
export async function fetchCandidates({ tags = TOPICS, limitPerTag = 25 } = {}) {
  const out = [];
  for (const tag of tags) {
    for (const sort of ["get_discussions_by_created", "get_discussions_by_trending"]) {
      const posts = await rpcAny("condenser_api." + sort, [{ tag, limit: limitPerTag }]);
      for (const p of posts ?? []) {
        let meta = {};
        try { meta = JSON.parse(p.json_metadata ?? "{}"); } catch { /* metadata פגום — כנה */ }
        out.push({ author: p.author, permlink: p.permlink, created: p.created, category: p.category, net_votes: p.net_votes, active_votes: p.active_votes, children: p.children, json_metadata: meta });
      }
    }
  }
  /* דדופ לפי author/permlink */
  const seen = new Set();
  return out.filter((p) => { const k = `${p.author}/${p.permlink}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

async function rpcAny(method, params) {
  let lastErr;
  for (const node of STEEM_NODES) {
    try {
      const r = await fetch(node, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(10000),
      });
      const j = await r.json();
      if (j.error) throw new Error(String(j.error.message ?? "rpc-error").slice(0, 80));
      return j.result;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("all-rpc-nodes-failed");
}

/* ── חסר-מפתחות: תוכנית מה-feed החי ──────────────────────────────────────── */
export async function planCurations({ account = ACCOUNT, dailyLimit = 8, maxWeightPct = 2 } = {}) {
  const candidates = await fetchCandidates();
  return planVotes({ posts: candidates, account, dailyLimit, maxWeightPct, now: Date.now() });
}

/* ── ביצוע — posting-WIF מהסביבה בלבד; אותו-נתיב-חתימה מוכח של mover.mjs ─── */
export async function executeVotes(plan, { wif } = {}) {
  if (!wif) throw new Error("posting WIF required for execution (fail-closed) — keyless plan only");
  const steem = (await import("steem")).default;
  const txids = [];
  let executed = 0;
  for (const v of plan.votes) {
    const ops = [["vote", { voter: plan.account, author: v.author, permlink: v.permlink, weight: v.weightSteemUnits }]];
    const dgp = await rpcAny("condenser_api.get_dynamic_global_properties", []);
    const tx = {
      ref_block_num: Number(dgp.head_block_number) & 0xffff,
      ref_block_prefix: Buffer.from(String(dgp.head_block_id), "hex").readUInt32LE(4),
      expiration: new Date(new Date(String(dgp.time) + "Z").getTime() + 60_000).toISOString().slice(0, 19),
      operations: ops,
      extensions: [],
    };
    const signed = steem.auth.signTransaction(tx, [wif]);
    const res = await rpcAny("condenser_api.broadcast_transaction_synchronous", [{ ...signed }]);
    if (!res?.id) throw new Error(`vote broadcast answered without id (${v.author}/${v.permlink}) (honest)`);
    txids.push({ author: v.author, permlink: v.permlink, txid: res.id, weight: v.weightSteemUnits });
    executed += 1;
  }
  return { executed, txids };
}

/* ── CLI: node grids/curate.mjs [--plan|--execute|--selftest] ─────────────── */
if (process.argv[1] && process.argv[1].endsWith("curate.mjs")) {
  if (process.argv.includes("--selftest")) {
    await import("./curate-selftest.mjs");
  } else {
    const plan = await planCurations();
    console.log(`[curate] planned ${plan.votes.length} votes (doctrine: posting-only, ≤${plan.doctrine.maxPerAuthor}/author, ≤${plan.doctrine.maxWeightPct}%):`);
    for (const v of plan.votes) console.log(`  ${v.weightSteemUnits >= 200 ? "●" : "○"} @${v.author}/${v.permlink.slice(0, 44)} score=${v.score} · ${v.reason}`);
    if (process.argv.includes("--execute")) {
      const res = await executeVotes(plan, { wif: process.env.STEEM_POSTING_WIF });
      console.log(`[curate] executed ${res.executed} votes · txids: ${res.txids.map((t) => t.txid.slice(0, 12) + "…").join(", ")}`);
    } else if (!process.env.STEEM_POSTING_WIF) {
      console.log("[curate] keyless plan only — STEEM_POSTING_WIF absent in environment (fail-closed, nothing signed)");
    }
  }
}
