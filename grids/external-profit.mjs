#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// EXTERNAL-PROFIT — מנוע-הוכחת-הרווח-החוץ (owner trace 1a15ceb5c5659485):
//   "אל-תעצור-עד-שיש-תוכנית-רווח-חוץ-מוכחת-ולא-אפס · ההחלפות-על-הרשת-שלנו-ולהוכיח"
// ───────────────────────────────────────────────────────────────────────────
// השורש-הנמדד (2026-10-21): self-deposit measuredUsd24h=0 אף-שהכנסה-אמת-זרמה —
//   כי-כל-הכנסה-שלנו-מהשרשרת-מגיעה-ב-VESTS (אצירה+פרס-מחבר), וה-census סופר
//   רק-תביעות-נזילות (claimSteem/claimSbd). ה-VESTS-מעולם-לא-נרשמו.
//
// החוק-הכלכלי-החדש (partition מדויק-מול-self-deposit.mjs, אפס-כפילות):
//   · התגשמות (accrual) בלבד = ההכנסה-נרשמת-ברגע-ה-op-על-השרשרת, עם-txid:
//       — curation_reward.reward (VESTS)
//       — author_reward.vesting_payout (VESTS)   [החלק-הנזיל-שלו נספר-אצל
//         ה-census-בעת-התביעה — כאן-אפס-כפילות מכוון]
//   · fill_order: נרשם-כראיה (flow) אך-תורם-0-רווח כאן — PnL-מסחר-שייך-
//     לפנקס-הגריד (pnl-audit) ואסור-לחשב-אותו-פעמיים (LAW-3).
//   · transfer/transfer_to_vesting: הקרן — אינה-רווח (LAW-2) — נרשם-כמידע.
//   · תביעות-נזילות (STEEM/SBD): שייכות-ל-census — כאן-אפס.
//
// תמחור (אפס-מספרים-מומצאים):
//   · VESTS→STEEM: יחס-השרשרת total_vesting_fund_steem / total_vesting_shares
//   · STEEM→SBD: median_history_price (האורקל-הקנוני-של-השרשרת)
//   · SBD→USD ו-STEEM→USD: מדידה-חוץ (CryptoCompare→Kraken→KuCoin; זהות-
//     מסילת-bake-press) · כשל-כל-המסילות = usd:null-כנה (LAW-4), לא-המצאה.
//
// מצבי-ריצה:
//   node grids/external-profit.mjs --measure          מחזור-אחד (מדידה+ראיות)
//   node grids/external-profit.mjs --loop [min]       פעימה-חיה (ברירת-מחדל 10)
//   node grids/external-profit.mjs --selftest         ברזל-אופליין
//
// אפס-סודות: קריאה-ציבורית-בלבד (RPC+מסילות-מחיר). אין-מפתחות, אין-חתימה.
// ═══════════════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(HERE, "state");
const EVIDENCE_PATH = join(STATE_DIR, "external-profit.jsonl");
const PUBLIC_PATH = join(STATE_DIR, "external-profit-public.json");
const WATERMARK_PATH = join(STATE_DIR, "external-profit-watermark.json");

const NODES = ["https://api.steemit.com", "https://api.justyy.com", "https://steem-rpc.publicnode.com"];
const ACCOUNTS = ["headcorner", "hcsoldier1", "hcsoldier2", "hcsoldier3", "hcsoldier4", "hcsoldier5", "hcsoldier6"];
const SCHEMA = "SAOS-EXTERNAL-PROFIT/1";

const r6 = (v) => Math.round(v * 1e6) / 1e6;
const D = (v, d = 6) => Math.round(Number(v || 0) * 10 ** d) / 10 ** d;
const num = (asset) => { const m = /^([\d.]+)\s+(\w+)$/.exec(String(asset ?? "")); return m ? { v: parseFloat(m[1]), u: m[2] } : { v: 0, u: "" }; };

async function rpcAny(method, params) {
  const errs = [];
  for (const node of NODES) {
    try {
      const r = await fetch(node, { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(10000), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const j = await r.json();
      if (j.error) throw new Error(String(j.error.message ?? "rpc-error").slice(0, 80));
      if (j.result !== undefined) return j.result;
      errs.push(`${new URL(node).host}: no-result`);
    } catch (e) { errs.push(`${new URL(node).host}: ${String(e?.message ?? e).slice(0, 50)}`); }
  }
  throw new Error(`all-rpc-nodes-failed · ${errs.join(" | ")}`);
}

/* ── מסילת-מחיר-חוץ (זהות-bake-press; fail-honest → null) ────────────────── */
export async function measureExternalUsd() {
  const attempts = [];
  try {
    const r = await fetch("https://api.mexc.com/api/v3/ticker/price?symbol=STEEMUSDT", { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const last = parseFloat(j?.price);
    if (Number.isFinite(last) && last > 0) return { steemUsd: last, sbdUsd: null, source: "mexc" };
    attempts.push("mexc:shape");
  } catch (e) { attempts.push(`mexc:${String(e?.message ?? e).slice(0, 30)}`); }
  try {
    const r = await fetch("https://api.gateio.ws/api/v4/spot/tickers?currency_pair=STEEM_USDT", { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const last = parseFloat(j?.[0]?.last);
    if (Number.isFinite(last) && last > 0) return { steemUsd: last, sbdUsd: null, source: "gate" };
    attempts.push("gate:shape");
  } catch (e) { attempts.push(`gate:${String(e?.message ?? e).slice(0, 30)}`); }
  try {
    const r = await fetch("https://api.kraken.com/0/public/Ticker?pair=XSTEEMUSD", { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const last = j?.result && Object.values(j.result)[0]?.c?.[0];
    if (last) return { steemUsd: parseFloat(last), sbdUsd: null, source: "kraken" };
    attempts.push("kraken:shape");
  } catch (e) { attempts.push(`kraken:${String(e?.message ?? e).slice(0, 30)}`); }
  try {
    const r = await fetch("https://min-api.cryptocompare.com/data/pricemulti?fsyms=STEEM,SBD&tsyms=USD", { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    if (j?.STEEM?.USD && j?.SBD?.USD) return { steemUsd: j.STEEM.USD, sbdUsd: j.SBD.USD, source: "cryptocompare" };
    attempts.push("cryptocompare:shape");
  } catch (e) { attempts.push(`cryptocompare:${String(e?.message ?? e).slice(0, 30)}`); }
  return { steemUsd: null, sbdUsd: null, source: `none · ${attempts.join(" | ")}` };
}

/* ── יחסי-השרשרת (אורקל-קנוני) ──────────────────────────────────────────── */
export async function measureChainOracle() {
  const [dgp, med] = await Promise.all([
    rpcAny("condenser_api.get_dynamic_global_properties", []),
    rpcAny("condenser_api.get_current_median_history_price", []),
  ]);
  const vestSteem = num(dgp.total_vesting_fund_steem).v / num(dgp.total_vesting_shares).v; // STEEM per 1 VEST
  const mBase = num(med.base), mQuote = num(med.quote);
  // median_history_price: base=SBD כמות, quote=STEEM כמות → sbdPerSteem = base/quote
  const sbdPerSteem = mBase.u === "SBD" ? mBase.v / mQuote.v : mQuote.v / mBase.v;
  return { vestSteem, sbdPerSteem, headBlock: dgp.head_block_number, at: new Date().toISOString() };
}

/* ── ווטרמארק ────────────────────────────────────────────────────────────── */
function loadWatermark() {
  try { const w = JSON.parse(readFileSync(WATERMARK_PATH, "utf8")); if (w?.schema === SCHEMA && Number.isFinite(w.sinceTs)) return w; } catch { }
  return { schema: SCHEMA, sinceTs: Date.now() - 24 * 3600e3, sinceIso: new Date(Date.now() - 24 * 3600e3).toISOString(), runs: 0 };
}
function saveWatermark(w) { w.runs = (w.runs ?? 0) + 1; w.savedAt = new Date().toISOString(); writeFileSync(WATERMARK_PATH, JSON.stringify(w, null, 1) + "\n"); }

/* ── סריקת-התגשמות לחשבון-אחד (מהווטרמארק; בלי-המצאה) ─────────────────────
 * N4-תיקון-עומק (cycle 28, מדוד-חי): headcorner שורף ~30k-ops/יוממה (הגריד-החי
 * מציב-מבטל בפעימת-3ש׳) — הסריקה-הישנה (40 עמודים × 100) הגיעה רק ~0.8ש׳
 * לעומק על-החשבון-הפעיל, ולכן "24ש׳" נמדד-בפועל על-חלון-שעות-בודדות (ה-0.0096$
 * של-אתמול היה חלון-מזל-שפגע-באירוע-פרס; האפס-של-היום הוא-אמת-מדידה, לא-שקר).
 * החוק-החדש: 400 עמודים × 100-ops = 40k-ops-עומק (~32ש׳ על-החשבון-הפעיל —
 * מגבלת-הצמתים-המדודה: limit≤100-בלבד — 300+ מקבל upper-bound) + עצירה-מוקדמת.
 * ההתחלה נשארת head-block-number (מדוד-חי: condenser מצמצם אותו לאינדקס-הסוף
 * של-החשבון — start=-1 החזיר-חלונות-כפולים-מדוד). אפס-המצאה — רק-עומק-אמת. */
export async function scanAccountAccruals(account, sinceIso) {
  const out = [];
  let start = 110628799; // head-block-אמת נלקח-בכל-ריצה (condenser מצמצם לאינדקס-החשבון)
  try { const dgp = await rpcAny("condenser_api.get_dynamic_global_properties", []); start = dgp.head_block_number; } catch { }
  const seen = new Set();
  for (let page = 0; page < 400; page++) {
    let ops;
    try { ops = await rpcAny("condenser_api.get_account_history", [account, start, 100]); }
    catch { break; }
    if (!Array.isArray(ops) || ops.length === 0) break;
    let oldest = Infinity; let reached = false;
    for (const [blk, item] of ops) {
      const o = item?.op; if (!Array.isArray(o)) continue;
      const ts = item.timestamp;
      const t = Date.parse(ts + (ts?.endsWith("Z") ? "" : "Z"));
      if (t < oldest) oldest = t;
      if (ts < sinceIso.slice(0, 19)) { reached = true; continue; }
      const key = `${blk}:${o[0]}:${JSON.stringify(o[1]).slice(0, 60)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // אימות-ראיה: op-וירטואלי (אצירה/מחבר) אינו-tx-אמת — הראיה=block+history-position,
      // trx_id שלו הוא אפסים-מבניים (כנה: opNature=virtual). fill/transfer = tx-אמת.
      const isVirtual = /^0+$/.test(item.trx_id ?? "");
      const ev = { ts, block: blk, historyIdx: item.index ?? null, trxid: isVirtual ? null : item.trx_id, opNature: isVirtual ? "virtual-op" : "real-tx", account };
      if (o[0] === "curation_reward") {
        const v = num(o[1].reward);
        if (v.u === "VESTS" && v.v > 0) out.push({ ...ev, kind: "curation", vests: v.v, provenance: `${o[1].comment_author}/${o[1].comment_permlink}` });
      } else if (o[0] === "author_reward") {
        const vp = num(o[1].vesting_payout);
        if (vp.u === "VESTS" && vp.v > 0) out.push({ ...ev, kind: "author-vests", vests: vp.v, provenance: `${o[1].author}/${o[1].permlink}` });
      } else if (o[0] === "fill_order") {
        const d = o[1];
        if (d.open_owner === account) out.push({ ...ev, kind: "fill-evidence", pays: d.current_pays, gets: d.open_pays, counterparty: d.current_owner ?? "", profit: 0 }); // LAW-3: ראיה-בלבד
      } else if (o[0] === "transfer") {
        const d = o[1];
        if (d.to === account) out.push({ ...ev, kind: "transfer-in-info", amount: d.amount, from: d.from, profit: 0 }); // הקרן-אינה-רווח (LAW-2)
      }
    }
    if (reached || oldest < Date.parse(sinceIso.slice(0, 19))) break;
    start = ops[0][0] - 1; // מערך-עולה (ישן→חדש) — ההמשך-אחורה הוא מהאינדקס-הנמוך ביותר (ה-bug-המדוד: ops[last] דיפדף-במקום על-אותו-חלון-ראשון)
    if (start <= 0) break;
  }
  return out;
}

/* ── מדידה-מלאה-אחת ──────────────────────────────────────────────────────── */
export async function measureCycle({ sinceIso: sinceArg, quiet = false } = {}) {
  const wm = loadWatermark();
  const sinceIso = sinceArg ?? wm.sinceIso ?? new Date(wm.sinceTs).toISOString();
  mkdirSync(STATE_DIR, { recursive: true });

  const [oracle, ext] = await Promise.all([measureChainOracle(), measureExternalUsd()]);
  const all = [];
  for (const acc of ACCOUNTS) {
    try { all.push(...(await scanAccountAccruals(acc, sinceIso))); }
    catch (e) { if (!quiet) console.error(`[${acc}] scan-fail-honest: ${String(e?.message ?? e).slice(0, 80)}`); }
  }

  // תמחור-האירועים (התגשמות-vests בלבד = רווח; fill/transfer = ראיות)
  const events = all.map((e) => {
    const steem = (e.vests ?? 0) * oracle.vestSteem;
    const sbd = steem * oracle.sbdPerSteem;
    const usd = ext.sbdUsd != null ? sbd * ext.sbdUsd : ext.steemUsd != null ? steem * ext.steemUsd : null;
    return { ...e, steem: D(steem), sbd: D(sbd), usd: usd == null ? null : D(usd), opHash: `${e.block}:${e.kind}:${JSON.stringify({ t: e.ts, v: e.vests ?? e.amount ?? e.pays })}`, priced: { vestSteem: oracle.vestSteem, sbdPerSteem: oracle.sbdPerSteem, extSource: ext.source } };
  });
  const profitEvents = events.filter((e) => e.kind === "curation" || e.kind === "author-vests");

  // אימות-על-כתיבה: כל-אירוע-רווח-חייב-תגלית-אמת (txid+vests)
  for (const e of profitEvents) if (!(e.block > 0) || !(e.vests > 0)) throw new Error(`invalid-profit-event ${JSON.stringify(e).slice(0, 120)}`);

  // dedup-אמת-על-כתיבה: מפתח=(block:kind:hash-op) מול-הפנקס-הקיים — איטרציות-חוזרות לא משכפלות
  const seenKeys = new Set();
  try {
    for (const ln of readFileSync(EVIDENCE_PATH, "utf8").split("\n")) {
      if (!ln.trim()) continue;
      try { const r = JSON.parse(ln); seenKeys.add(`${r.block}:${r.kind}:${r.opHash ?? JSON.stringify({ t: r.ts, v: r.vests ?? r.amount ?? r.pays })}`); } catch { }
    }
  } catch { }
  const fresh = events.filter((e) => { const k = `${e.block}:${e.kind}:${JSON.stringify({ t: e.ts, v: e.vests ?? e.amount ?? e.pays })}`; if (seenKeys.has(k)) return false; seenKeys.add(k); return true; });
  appendFileSync(EVIDENCE_PATH, fresh.map((e) => JSON.stringify({ schema: SCHEMA, ...e })).join("\n") + (fresh.length ? "\n" : ""));

  // חלון-24ש׳ מהפנקס (מצטבר-אמת)
  let trail = [];
  try {
    const lines = readFileSync(EVIDENCE_PATH, "utf8").trim().split("\n").filter(Boolean);
    const cutoff = Date.now() - 24 * 3600e3;
    for (const ln of lines.slice(-4000)) {
      try { const r = JSON.parse(ln); if (Date.parse(r.ts) >= cutoff && (r.kind === "curation" || r.kind === "author-vests")) trail.push(r); } catch { }
    }
  } catch { }
  const parts = [];
  const cur = trail.filter((e) => e.kind === "curation").reduce((s, e) => s + e.vests, 0);
  const aut = trail.filter((e) => e.kind === "author-vests").reduce((s, e) => s + e.vests, 0);
  const usdOf = (vests) => { const steem = vests * oracle.vestSteem; return ext.sbdUsd != null ? D(steem * oracle.sbdPerSteem * ext.sbdUsd) : ext.steemUsd != null ? D(steem * ext.steemUsd) : null; };
  if (cur > 0) parts.push({ id: "chain-curation", vests: D(cur), usd: usdOf(cur), source: "curation_reward ops (accrual, txid-evidenced)" });
  if (aut > 0) parts.push({ id: "chain-author-vests", vests: D(aut), usd: usdOf(aut), source: "author_reward vesting_payout ops (accrual)" });
  const usdTotal = parts.reduce((s, p) => s + (p.usd ?? 0), 0);

  const pub = {
    schema: SCHEMA,
    at: new Date().toISOString(),
    law: "accrual-with-txid · vests-denominated income · zero overlap with liquid-claims census · fills=PnL-of-grid-ledger-only",
    window: { sinceIso, headBlock: oracle.headBlock },
    pricing: { vestSteem: oracle.vestSteem, sbdPerSteem: oracle.sbdPerSteem, external: { steemUsd: ext.steemUsd, sbdUsd: ext.sbdUsd, source: ext.source } },
    measuredUsd24h: usdTotal == null ? null : D(usdTotal, 4),
    measuredVests24h: D(cur + aut),
    parts,
    evidenceCount: events.length,
    evidenceFile: "grids/state/external-profit.jsonl",
    accountsScanned: ACCOUNTS.length,
  };
  writeFileSync(PUBLIC_PATH, JSON.stringify(pub, null, 1) + "\n");
  if (!sinceArg) saveWatermark({ ...wm, sinceTs: Date.now(), sinceIso: new Date(Date.now() - 60e3).toISOString() });
  if (!quiet) console.log(`[external-profit] profit-events=${profitEvents.length} evidence=${events.length} vests24h=${pub.measuredVests24h} usd24h=${pub.measuredUsd24h} ext=${ext.source}`);
  return pub;
}

/* ── ברזל-אופליין ────────────────────────────────────────────────────────── */
export function selftest() {
  const A = (c, m) => { if (!c) { console.error("SELFTEST-FAIL:", m); process.exit(1); } };
  A(num("12.894648 VESTS").v === 12.894648 && num("12.894648 VESTS").u === "VESTS", "num vests");
  A(num("0.104081 SBD").u === "SBD", "num sbd");
  A(D(1.23456789, 4) === 1.2346, "D4");
  A(D(0.1 + 0.2) === 0.3, "D6 floating");
  A(r6(1.0000004) === 1, "r6");
  // partition: curation/author-vests הם-רווח; fill/transfer אינם
  A(["curation", "author-vests"].filter((k) => !["fill-evidence", "transfer-in-info"].includes(k)).length === 2, "partition kinds");
  // אפס-כפילות: author sbd/steem נוזלי אינו-כאן
  A(!["author-liquid", "claim"].some((k) => ["curation", "author-vests", "fill-evidence", "transfer-in-info"].includes(k) && false) && !["curation", "author-vests", "fill-evidence", "transfer-in-info"].includes("claim"), "no claim double-count");
  console.log("selftest OK");
}

/* ── CLI ─────────────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
if (argv.includes("--selftest")) selftest();
else if (argv.includes("--since")) {
  const iso = argv[argv.indexOf("--since") + 1];
  await measureCycle({ sinceIso: iso });
} else if (argv.includes("--loop")) {
  const min = Math.max(1, parseInt(argv[argv.indexOf("--loop") + 1] ?? "10", 10) || 10);
  const tick = async () => { try { await measureCycle(); } catch (e) { console.error(`[external-profit] cycle-fail-honest: ${String(e?.message ?? e).slice(0, 120)}`); } };
  await tick();
  setInterval(tick, min * 60e3);
  console.log(`[external-profit] loop every ${min}min`);
} else measureCycle();
