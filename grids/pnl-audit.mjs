// PNL-AUDIT — ביקורת-הרווח-האמת של הריבונות (SAOS-PNL-AUDIT/1)
// ═══════════════════════════════════════════════════════════════════════════════
// דבר-הבעלים (2026-10-19, trace 1a1533c25fd2cc69): "תבדוק רווח אמיתי · עשינו הרבה
// עסקאות · אין רווחים? למה 0? · הפסדים אמיתיים רווחים ובנוסף הסלמות לעוד ערך".
//
// התשובה-ההנדסית (נמדד-על-השרשרת 2026-10-19):
//   · 1440 מילויים-אמת (fill_order) בחלון-ההיסטוריה של הצי+אוצר.
//   · **1367 מהם — חצייה-עצמית headcorner↔headcorner** (הביד-שלנו חצה-את-האסק-שלנו
//     בלולאת-הריפרייס של mover — רווח=0, נזק=RC-בלבד). זו-הסיבה-המרכזית ל"למה 0".
//   · 66 מילויי-מדרגות-חיילים — רווח-מרק-שוק ≈ ±0.003 SBD (כמעט-שטוח — קנברי-אמת).
//   · ~12 מילויים-חוץ-אמת (coin-raffle/cashly/btsx/vfund) — זרימה-אמת-ראשונה.
//   · המונה-הישן-ב-self-deposit מדד רק תביעות+עמלות-בריכה — לא-כלל-מסחר. מעכשיו:
//     **הרווח-המדוד = fill_order-אמת, מודע-חצייה-עצמית, מרק-לשוק ב-mid-חי.**
//
// חוקים:
//   LAW-P0 · מקור-אמת-יחיד: fill_order וירטואלי על-השרשרת — לא-לוג-מקומי, לא-הערכה.
//   LAW-P1 · חצייה-עצמית = אפס-דלתא: current_owner==open_owner==acct → המילוי
//           מזיז-אפס-הון (שתי-הרגליים-שלנו) — נספר-כנפח-אך-לא-כרווח-ולא-כהפסד.
//   LAW-P2 · מרק-לשוק: ΔSBD + ΔSTEEM×mid-חי — מדוד-בכל-ריצה, לא-מומצא.
//   LAW-P3 · חלון-כנות: מדידה-על-חלון-ההיסטוריה-הנטען (10K-אופס-לחשבון) — החלון
//           מפורסם-בקבלה. עידן-המנוע (אחרי-2026-10-07) מדווח-בנפרד.
//   LAW-P4 · fail-honest: צומת-מת = קבלת-כישלון-כנה, לא-אפס-מזויף.
// ═══════════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rpcAny, num } from "./mover.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(HERE, "state");
const PUBLIC_PATH = join(STATE_DIR, "pnl-audit.json");
const RECEIPTS_PATH = join(STATE_DIR, "pnl-audit-receipts.jsonl");

export const AUDIT_ACCOUNTS = Object.freeze([
  "hcsoldier4", "hcsoldier5", "hcsoldier6", "israelnews", "tov", "haran",
  "lsa", "macrame", "wic", "wog", "woq", "cashmachine", "siq", "headcorner",
]);

const ENGINE_ERA_START = "2026-10-07T00:00:00"; // עידן-המנועים-הנוכחי (IGNITION-R1)

function normFill(acct, o) {
  const f = o.op[1];
  const self = f.current_owner === acct && f.open_owner === acct;
  const weAreCurrent = f.current_owner === acct;
  // שתי-הרגליים-שלנו: אפס-דלתא-נטו (LAW-P1)
  const gave = self ? null : (weAreCurrent ? f.current_pays : f.open_pays);
  const got = self ? null : (weAreCurrent ? f.open_pays : f.current_pays);
  return {
    acct, at: o.timestamp, self,
    gaveAsset: self ? null : String(gave).split(" ")[1], gaveAmt: self ? 0 : num(gave),
    gotAsset: self ? null : String(got).split(" ")[1], gotAmt: self ? 0 : num(got),
    counterparty: self ? acct : (weAreCurrent ? f.open_owner : f.current_owner),
  };
}

// ── דלתא-אגרגציה מודעת-חצייה-עצמית ──
export function aggregate(fills, mid) {
  const per = {};
  for (const f of fills) {
    const g = (per[f.acct] ??= { fills: 0, selfCrosses: 0, sbdIn: 0, sbdOut: 0, steemIn: 0, steemOut: 0 });
    g.fills++;
    if (f.self) { g.selfCrosses++; continue; } // LAW-P1
    if (f.gaveAsset === "SBD") g.sbdOut += f.gaveAmt;
    else if (f.gaveAsset === "STEEM") g.steemOut += f.gaveAmt;
    if (f.gotAsset === "SBD") g.sbdIn += f.gotAmt;
    else if (f.gotAsset === "STEEM") g.steemIn += f.gotAmt;
  }
  let estate = 0;
  const rows = {};
  for (const [acct, g] of Object.entries(per)) {
    const dSbd = g.sbdIn - g.sbdOut, dSteem = g.steemIn - g.steemOut;
    const pnl = dSbd + dSteem * mid; // LAW-P2
    estate += pnl;
    rows[acct] = { ...g, dSbd: Math.round(dSbd * 1e6) / 1e6, dSteem: Math.round(dSteem * 1e6) / 1e6, pnlSbd: Math.round(pnl * 1e6) / 1e6 };
  }
  return { rows, estatePnlSbd: Math.round(estate * 1e6) / 1e6 };
}

export function selftest() {
  const A = (c, m) => { if (!c) throw new Error("SELFTEST-FAIL: " + m); };
  const mid = 0.102073;
  // 1) חצייה-עצמית → אפס-דלתא
  const f1 = { acct: "h", at: "t", self: true, gaveAsset: null, gaveAmt: 0, gotAsset: null, gotAmt: 0, counterparty: "h" };
  // 2) מכירה-אמת: נתנו 2 STEEM, קיבלנו 0.207 SBD → ΔSBD=+0.207, ΔSTEEM=−2
  const f2 = { acct: "h", at: "t", self: false, gaveAsset: "STEEM", gaveAmt: 2, gotAsset: "SBD", gotAmt: 0.207, counterparty: "x" };
  // 3) קנייה-אמת: נתנו 0.06 SBD, קיבלנו 0.6 STEEM
  const f3 = { acct: "h", at: "t", self: false, gaveAsset: "SBD", gaveAmt: 0.06, gotAsset: "STEEM", gotAmt: 0.6, counterparty: "y" };
  const agg = aggregate([f1, f2, f3], mid);
  const r = agg.rows.h;
  A(r.fills === 3 && r.selfCrosses === 1, "fill counts + selfCross count");
  A(Math.abs(r.dSbd - 0.147) < 1e-9, `ΔSBD = +0.207−0.060 = 0.147 (got ${r.dSbd})`);
  A(Math.abs(r.dSteem - (-1.4)) < 1e-9, `ΔSTEEM = 0.6−2 = −1.4 (got ${r.dSteem})`);
  // רווח-מרק: 0.147 − 1.4×0.102073 = +0.0040978 (השוואה-מודעת-עיגול 1e-6 — אותו-חוזה של-האגרגטור)
  const expected = Math.round((0.147 - 1.4 * mid) * 1e6) / 1e6;
  A(Math.abs(r.pnlSbd - expected) < 1e-12, "mark-to-market formula (rounding-aware)");
  // 4) חצייה-עצמית-גרידא → אפס-מוחלט
  const agg2 = aggregate([f1], mid);
  A(agg2.rows.h.dSbd === 0 && agg2.rows.h.dSteem === 0 && agg2.rows.h.pnlSbd === 0, "self-cross alone = zero delta");
  A(agg2.estatePnlSbd === 0, "estate pnl zero for pure self-cross");
  // 5) אגרגציה-רבתי-חשבונות (מודע-עיגול)
  const agg3 = aggregate([f2, { ...f2, acct: "s2" }], mid);
  const exp3 = Math.round(2 * (0.207 - 2 * mid) * 1e6) / 1e6;
  A(Math.abs(agg3.estatePnlSbd - exp3) < 1e-12, "estate sums accounts");
  return { ok: true, tests: 6 };
}

// ── main ──
const args = process.argv.slice(2);
if (args.includes("--selftest")) {
  try { const r = selftest(); console.log(JSON.stringify({ selftest: "PASS", ...r })); process.exit(0); }
  catch (e) { console.error(e.message); process.exit(1); }
}

const receipt = { schema: "SAOS-PNL-AUDIT/1", at: new Date().toISOString(), laws: ["P0 fill_order-only-truth", "P1 self-cross=zero-delta", "P2 mark-to-market", "P3 window-published", "P4 fail-honest"] };
try {
  // mid חי — מקומי ועצמאי (אסור לייבא self-deposit — מודול-עם-main-רץ)
  const ob = await rpcAny("condenser_api.get_order_book", [10]).catch(() => null);
  let bestBid = null, bestAsk = null;
  if (ob?.bids?.[0]?.real_price) bestBid = num(ob.bids[0].real_price);
  if (ob?.asks?.[0]?.real_price) bestAsk = num(ob.asks[0].real_price);
  let mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;
  let midSource = bestBid != null ? "order-book" : null;
  if (!(mid > 0)) {
    const feed = await rpcAny("condenser_api.get_feed_history", []).catch(() => null);
    const b = num(feed?.current_median_history?.base), q = num(feed?.current_median_history?.quote);
    if (b > 0 && q > 0) { mid = b / q; midSource = "feed-history"; }
  }
  if (!(mid > 0)) throw new Error("no-mid-source — honest abort, no mid invention");
  receipt.mid = mid; receipt.midSource = midSource;

  let totalFills = 0, allFills = [], unreadable = [], windowIdx = null;
  for (const acct of AUDIT_ACCOUNTS) {
    const h = await rpcAny("condenser_api.get_account_history", [acct, -1, 10000]).catch(() => null);
    if (!h) { unreadable.push(acct); continue; }
    const arr = Array.isArray(h) ? h : [];
    if (arr.length) { windowIdx = { from: arr[0]?.[0], to: arr[arr.length - 1]?.[0] }; }
    for (const [i, o] of arr) if (o.op?.[0] === "fill_order") { allFills.push(normFill(acct, o)); totalFills++; }
  }
  receipt.window = { ops: "last-10000-per-account", idx: windowIdx, unreadable };
  receipt.totalFills = totalFills;
  const selfCrosses = allFills.filter((f) => f.self).length;
  receipt.selfCrosses = selfCrosses;
  receipt.realFills = totalFills - selfCrosses;
  // חלוקה-לתקופות: עידן-המנוע מול-כל-ההיסטוריה
  const eraFills = allFills.filter((f) => f.at >= ENGINE_ERA_START);
  const aggEra = aggregate(eraFills, mid);
  const aggAll = aggregate(allFills, mid);
  receipt.engineEra = { since: ENGINE_ERA_START, fills: eraFills.length, selfCrosses: eraFills.filter((f) => f.self).length, perAccount: aggEra.rows, estatePnlSbd: aggEra.estatePnlSbd };
  receipt.allHistory = { fills: allFills.length, estatePnlSbd: aggAll.estatePnlSbd, markToMarketCaveat: "all-history MTM spans inventory that moved via converts/transfers — engine-era is the honest trading verdict" };
  // עוקבי-חוץ-אמת (מילויים-מול-צדדים-שאינם-אנחנו)
  const external = eraFills.filter((f) => !f.self && !AUDIT_ACCOUNTS.includes(f.counterparty));
  const byCp = {};
  for (const f of external) byCp[f.counterparty] = (byCp[f.counterparty] ?? 0) + 1;
  receipt.externalFills = { count: external.length, counterparties: byCp };
  // פילוח-יומי-בעידן-המנוע
  const byDay = {};
  for (const f of eraFills) { const d = f.at.slice(0, 10); (byDay[d] ??= { fills: 0, self: 0 }); byDay[d].fills++; if (f.self) byDay[d].self++; }
  receipt.fillsByDay = byDay;
  receipt.verdict = selfCrosses > 0 ? "SELF-CROSS-LEAK-DETECTED (mover reprice crosses own legs — fix required)" : "CLEAN";
  receipt.remediation = selfCrosses > 0 ? "grids/mover.mjs self-gap iron law: refuse ask≤ownBestBid / bid≥ownBestAsk; cancel opposite-side before leg placement" : null;

  writeFileSync(PUBLIC_PATH, JSON.stringify(receipt, null, 1) + "\n");
  appendFileSync(RECEIPTS_PATH, JSON.stringify({ schema: "SAOS-PNL-AUDIT-RECEIPT/1", at: receipt.at, mid, totalFills, selfCrosses, realFills: receipt.realFills, eraPnlSbd: aggEra.estatePnlSbd, externalFills: external.length, verdict: receipt.verdict }) + "\n");
  console.log(JSON.stringify({ status: receipt.verdict, mid, totalFills, selfCrosses, realFills: receipt.realFills, eraPnlSbd: aggEra.estatePnlSbd, externalFills: external.length }, null, 1));
} catch (e) {
  receipt.verdict = "HONEST-FAIL"; receipt.error = String(e?.message ?? e).slice(0, 200);
  try { writeFileSync(PUBLIC_PATH, JSON.stringify(receipt, null, 1) + "\n"); } catch { /* כנות */ }
  console.error(JSON.stringify(receipt));
  process.exit(1);
}
