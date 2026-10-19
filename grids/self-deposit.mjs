// SELF-DEPOSIT — מנוע-ההפקדה-העצמית של הריבונות (SAOS-SELF-DEPOSIT/1)
// ═══════════════════════════════════════════════════════════════════════════════
// דבר-הבעלים (2026-10-19, trace 1a1530e43b512305): "הפקדות אם אתה צריך אז הריבונות
// צריכה לייצר ולהפקיד בעצמה · אין הפקדות חוץ · הארכיטקטורה הריבונית האוטונומית היא
// כלכלית וצריכה לדאוג לעצמה ללא תלות חיצונית במימון. להפך היא צריכה לממן אותי
// ב1000$ ליום בהקדם ולא הפוך. וודא את זה".
//
// החוקים המקודדים (ברזל — אין-משא-ומתן):
//   LAW-0 · אין-הפקדות-חוץ: אף-הון-חוץ אינו נספר ואינו נדרש. עובד-הון נולד רק
//           מייצור-פנימי (תשואות-שרשרת, עמלות-בריכה, רווחי-מדרגה, קונברטים) ומניתוב
//           פנימי בין-חשבונות-הצי. הריבונות מפקידה לעצמה — לאף-אחד-אחר, ולא-הפוך.
//   LAW-1 · הפקדה-עצמית: יתרה-עצלה (מעל-כונס-שימור) בחשבון-צי נשטפת פנימה:
//           חיילים→cashmachine (קופת-הריבונות)→payroll לסוחרים-פעילים. העברות
//           בין-חשבונות-צי בלבד — headcorner/cornerstone נאסרים כחתימות (owner-keyed).
//   LAW-2 · דיבידנד-בעלים: יעד $1000/יום משולם **רק מרווח-מדוד** (רווח-נטו מרווחי-
//           מדרגה/עמלות/תשואות — לעולם לא מהקרן). קצב-השחרור קנברי-מדורג עם רצף-
//           קבלות-ירוקות; הפער-הכנה מול-היעד מפורסם בכל-קבלה — אף-סיפור-שקר.
//   LAW-3 · הוכח-ואז-דבר: כל-טענת-הכנסה מצטטת קבלה-מדודה (דלתא-מדרגות, עמלות-בריכה,
//           דלתא-custody). אין-רווח בלי-קבלה. אין-יעד בלי-פער-מפורסם.
//   LAW-4 · fail-honest: בלי-מפתחות → census + תוכנית-ניתוב + חישוב-דיבידנד (קריאה-
//           בלבד, ערך-אמת). עם-מפתחות (keys-file חיצוני, אפס-סודות-בגיט) → + ביצוע
//           רגלי-השטיפה הפנימיות דרך key-gate + policyGate, אותו-משטר-בית של army-ladder.
//   LAW-5 · תקרות-ברזל בקוד: כונס-שימור 2.0 STEEM/חייל · רגל-שטיפה ≤ 10 STEEM ·
//           פעימה ≤ 50 STEEM · דיבידנד-קנברי מתחיל 1.00 $/יום ומוגבל-שיפוע (+25%
//           מרצף-ירוק, תקרת-מדרגה מוצהרת) — עד-שיעד-$1000 מכסה-רווח-מדוד אמת.
//
// ריצה:
//   node grids/self-deposit.mjs                      → census + plan + dividend (קריאה-בלבד)
//   node grids/self-deposit.mjs --run --keys-file /tmp/fk.json → + ביצוע-שטיפה פנימית
//   node grids/self-deposit.mjs --selftest           → בדיקות-ברזל
// ═══════════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rpcAny, signAndBroadcast, num, dp3 } from "./mover.mjs";
import { activeAuthorityOk } from "./key-gate.mjs";
import { policyGate } from "./policy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(HERE, "state");
const PUBLIC_PATH = join(STATE_DIR, "self-deposit-public.json");
const RECEIPTS_PATH = join(STATE_DIR, "self-deposit-receipts.jsonl");
const DIVIDEND_PATH = join(STATE_DIR, "dividend-lane.json");

// ── תקרות-ברזל (LAW-5) ──
export const CAPS = Object.freeze({
  keeperKeepSteem: 2.0,     // כונס-שימור לכל-חייל (עומד-למדרגות/עזרה)
  perSweepLegSteem: 10.0,   // רגל-שטיפה-יחידה
  perBeatSteem: 50.0,       // סה"כ-פעימה
  treasuryKeepSteem: 100.0, // כונס-שימור ל-cashmachine (קופת-הריבונות)
  dividend: Object.freeze({
    targetUsdPerDay: 1000.0,   // יעד-הבעלים (מילולי, 2026-10-19)
    startRateUsdPerDay: 1.0,   // קנברי-ראשון
    escStep: 1.25,             // ×1.25 לכל-מדרגה
    escGreenRuns: 3,           // רצף-ירוק למדרגה
    maxRateUsdPerDay: 1000.0,  // תקרת-הסלמה = היעד עצמו
  }),
});

// איסורי-חתימה (LAW-1): חשבונות owner-keyed — אף-רגל לא יוצאת מהם דרך-המנוע
export const FORBIDDEN_SIGNERS = Object.freeze(["headcorner", "cornerstone"]);

// קופת-הריבונות: יעד-השטיפה-הפנימי
export const SOVEREIGN_COFER = "cashmachine";

export const FLEET = Object.freeze([
  "hcsoldier4", "hcsoldier6", "israelnews", "tov", "hcsoldier5", "haran",
  "lsa", "macrame", "wic", "wog", "woq", "cashmachine", "siq",
]);

const D = (v, p = 3) => Number(Number(v).toFixed(p));

function nowIso() { return new Date().toISOString(); }

// ── מדידת-מחיר-אמת: mid מהספר-החי (אותו-מקור ואותם-שדות של treasury-ladder.measureMid) ──
const ALT_NODES = ["https://api.steemit.com", "https://api.justyy.com", "https://steem-rpc.publicnode.com"];
async function altRpc(method, params) {
  for (const node of ALT_NODES) {
    try {
      const r = await fetch(node, { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(8000), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const j = await r.json();
      if (j.result !== undefined) return j.result;
    } catch { /* צומת-הבא */ }
  }
  throw new Error("all-alt-nodes-failed");
}
export async function measureMid() {
  // real_price (SBD/STEEM) — שדה-האמת של condenser (לא price — שדה-זה-לא-קיים)
  let bestBid = null, bestAsk = null;
  try {
    const ob = await rpcAny("condenser_api.get_order_book", [10]);
    if (ob?.bids?.[0]?.real_price) bestBid = num(ob.bids[0].real_price);
    if (ob?.asks?.[0]?.real_price) bestAsk = num(ob.asks[0].real_price);
  } catch { /* הספר-הציבורי נפל — נמשיך לפיד */ }
  // פיד-חלופי: get_feed_history על-שתי-קבוצות-צמתים (אותו-משטר של treasury-ladder)
  let feedMid = null;
  try {
    const feed = await rpcAny("condenser_api.get_feed_history", []);
    const cur = feed?.current_median_history;
    const b = num(cur?.base), q = num(cur?.quote);
    if (b > 0 && q > 0) feedMid = b / q;
  } catch { /* נפילה-כנה לקבוצה-השנייה */ }
  if (feedMid == null) {
    try {
      const feed2 = await altRpc("condenser_api.get_feed_history", []);
      const cur = feed2?.current_median_history;
      const b = num(cur?.base), q = num(cur?.quote);
      if (b > 0 && q > 0) feedMid = b / q;
    } catch { /* כנות */ }
  }
  const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : feedMid;
  if (!(mid > 0)) throw new Error("no-mid-source (book empty AND feed unreadable) — honest abort, no mid invention");
  return { mid, bestBid, bestAsk, feedMid, source: bestBid != null ? "order-book" : "feed-history" };
}

// ── census חי: יתרות + תביעות-תשואה של כל-הצי ──
export async function census() {
  const accts = (await rpcAny("condenser_api.get_accounts", [FLEET])) || [];
  const byName = new Map(accts.map((a) => [a.name, a]));
  const rows = FLEET.map((name) => {
    const a = byName.get(name);
    if (!a) return { account: name, state: "UNREADABLE", steem: 0, sbd: 0, claimSteem: 0, claimSbd: 0 };
    return {
      account: name,
      state: "OK",
      steem: dp3(num(a.balance)),
      sbd: dp3(num(a.sbd_balance)),
      claimSteem: dp3(num(a.reward_steem_balance)),
      claimSbd: dp3(num(a.reward_sbd_balance)),
      claimVest: dp3(num(a.reward_vesting_balance)),
    };
  });
  const t = (k) => D(rows.reduce((s, r) => s + (r.state === "OK" ? r[k] : 0), 0));
  return {
    at: nowIso(), rows,
    totals: { steem: t("steem"), sbd: t("sbd"), claimSteem: t("claimSteem"), claimSbd: t("claimSbd") },
    source: "condenser_api.get_accounts",
  };
}

// ── תוכנית-ההפקדה-העצמית: idle → cashmachine → (payroll למדרגות על-ידי-הלב-הקיים) ──
export function planSweep(cen, mid) {
  const legs = [];
  let beatTotal = 0;
  for (const r of cen.rows) {
    if (r.state !== "OK") continue;
    if (FORBIDDEN_SIGNERS.includes(r.account)) continue;          // LAW-1: אף-רגל מ-owner-keyed
    if (r.account === SOVEREIGN_COFER) continue;                   // הקופה עצמה אינה נשטפת
    const idle = r.steem - CAPS.keeperKeepSteem;
    if (idle < 0.5) continue;                                      // מתחת-אבק — לא-שווה-עמלה
    const amt = Math.min(D(idle), CAPS.perSweepLegSteem, D(CAPS.perBeatSteem - beatTotal));
    if (amt < 0.5) break;
    beatTotal = D(beatTotal + amt);
    legs.push({ from: r.account, to: SOVEREIGN_COFER, amountSteem: amt, reason: "self-deposit: idle keeper surplus → sovereign coffer", asset: "STEEM" });
  }
  return { legs, beatTotalSteem: D(beatTotal), note: "coffer→traders payroll rides the existing escrow/ladder engines — this engine only consolidates idle into the coffer" };
}

// ── נתיב-הדיבידנד (LAW-2/LAW-3): רווח-מדוד → פער-מפורסם מול $1000/יום ──
export function loadDividendLane() {
  try {
    const raw = JSON.parse(readFileSync(DIVIDEND_PATH, "utf8"));
    if (raw?.schema === "SAOS-DIVIDEND-LANE/1") return raw;
  } catch { /* ראשוני */ }
  return {
    schema: "SAOS-DIVIDEND-LANE/1", createdAt: nowIso(),
    greenStreak: 0, rateUsdPerDay: CAPS.dividend.startRateUsdPerDay,
    paidUsdTotal: 0, lastPaidAt: null, escalations: [],
  };
}

// רווח-מדוד 24h: דלתא-מקורות-הכנסה-המדודים-בלבד (קבלות-מדרגה + עמלות-בריכה-מ-STATUS)
// כנות: מה שאין-לו-קבלה = 0. הקרן (יתרות) אינה רווח — LAW-2.
export function measureDailyProfitUsd({ cen, prevCen, mid, poolFeesUsd24h }) {
  const parts = [];
  // קרן אסורה: דלתא-יתרות-גולמיות אינה רווח (העברות-פנימיות מתאפסות) — נמדוד רק
  // תביעות-תשואה (מדוד מהשרשרת) + עמלות-בריכה (קבלת-feeMeter) + רווחי-מדרגה (מדוד חוץ-מהחישוב-הזה, נכנס דרך-הקבלות).
  const claimSteem = cen.totals.claimSteem - (prevCen?.totals?.claimSteem ?? 0); // שלילי=נתבע-המחזור-קודם → רווח-הפוך
  const claims = { source: "chain rewards claimed (net of reserve)", usd: D(Math.max(0, -(claimSteem)) * mid + Math.max(0, -(cen.totals.claimSbd - (prevCen?.totals?.claimSbd ?? 0)))), steem: D(Math.max(0, -(claimSteem))) };
  if (claims.usd > 0) parts.push({ id: "chain-claims", ...claims });
  if (Number(poolFeesUsd24h) > 0) parts.push({ id: "dex-pool-fees", usd: D(poolFeesUsd24h), source: "feeMeter receipts (evidence: sweep-ledger/flow24)" });
  const total = D(parts.reduce((s, p) => s + p.usd, 0), 4);
  return { measuredUsd24h: total, parts, fundExcluded: "principal deltas excluded by LAW-2 (transfers net to zero; balances are not profit)" };
}

export function advanceDividendLane(lane, daily) {
  const c = CAPS.dividend;
  const laneOut = { ...lane };
  if (daily.measuredUsd24h > 0) laneOut.greenStreak = (lane.greenStreak ?? 0) + 1;
  else laneOut.greenStreak = 0;
  // הסלמה-קנברית: רק רצף-ירוק מרים את תקרת-הקצב — לעולם לא הפוך-ללא-ריצה
  if (laneOut.greenStreak > 0 && laneOut.greenStreak % c.escGreenRuns === 0) {
    const next = Math.min(D(laneOut.rateUsdPerDay * c.escStep, 4), c.maxRateUsdPerDay);
    if (next > laneOut.rateUsdPerDay) {
      laneOut.escalations = [...(laneOut.escalations ?? []), { at: nowIso(), from: laneOut.rateUsdPerDay, to: next, cause: `${laneOut.greenStreak} green receipts` }];
      laneOut.rateUsdPerDay = next;
    }
  }
  // שחרור-דיבידנד: מינימום(רווח-מדוד, תקרת-קצב) — רווח-חסר = פער-מפורסם, לא-שקר
  const releasable = D(Math.min(daily.measuredUsd24h, laneOut.rateUsdPerDay), 4);
  laneOut.pendingReleaseUsd = releasable;
  laneOut.gapToTargetUsd = D(Math.max(0, c.targetUsdPerDay - daily.measuredUsd24h), 4);
  laneOut.targetUsdPerDay = c.targetUsdPerDay;
  laneOut.at = nowIso();
  return laneOut;
}

// ── ביצוע-השטיפה (רק עם keys-file — LAW-4) ──
async function executeSweep(plan, fk) {
  const results = [];
  for (const leg of plan.legs) {
    const res = { ...leg, state: null };
    try {
      const wif = fk?.[leg.from]?.active || "";
      if (!wif) { res.state = "KEY-STASIS"; res.why = "no live active WIF — honest sleep"; results.push(res); continue; }
      const gate = await activeAuthorityOk({ account: leg.from, wif, rpc: rpcAny });
      if (!gate.ok) { res.state = "KEY-GATE-REFUSED"; res.why = String(gate.reason ?? "").slice(0, 120); results.push(res); continue; }
      const fresh = await rpcAny("condenser_api.get_accounts", [[leg.from]]).catch(() => []);
      const fAcct = (fresh || [])[0];
      const fBal = fAcct ? num(fAcct.balance) : 0;
      if (fBal < leg.amountSteem) { res.state = "STALE-BALANCE"; res.fresh = dp3(fBal); results.push(res); continue; }
      const notional = leg.amountSteem; // USD-ערך בקירוב mid יצטרף בקבלה
      const pg = policyGate({ tool: "self-deposit", lane: "general", kind: "transfer", account: leg.from, opsEst: 1, notionalSbd: notional });
      if (!pg.allow) { res.state = "POLICY-HALT"; res.why = (pg.reasons || []).join(" ; ").slice(0, 160); results.push(res); continue; }
      const r = await signAndBroadcast(wif, [["transfer", {
        from: leg.from, to: leg.to,
        amount: `${leg.amountSteem.toFixed(3)} STEEM`,
        memo: `saos self-deposit/1 · owner directive 2026-10-19 (אין-הפקדות-חוץ) · internal idle consolidation — sovereignty deposits to itself`,
      }]]);
      res.txid = r.txid; res.block = r.block; res.state = "DEPOSITED";
    } catch (e) { res.state = "SWEEP-FAILED"; res.error = String(e?.message ?? e).slice(0, 120); }
    results.push(res);
  }
  return results;
}

// ── selftest ברזל ──
export function selftest() {
  const A = (cond, msg) => { if (!cond) throw new Error("SELFTEST-FAIL: " + msg); };
  // LAW-5: תקרות
  A(CAPS.dividend.targetUsdPerDay === 1000, "dividend target is owner's $1000/day");
  A(CAPS.dividend.startRateUsdPerDay <= 1.0, "canary start ≤ $1/day");
  A(CAPS.dividend.maxRateUsdPerDay === 1000, "escalation ceiling equals target");
  A(CAPS.perSweepLegSteem <= 10 && CAPS.perBeatSteem <= 50, "sweep caps");
  // LAW-1: איסורי-חתימה
  A(FORBIDDEN_SIGNERS.includes("headcorner") && FORBIDDEN_SIGNERS.includes("cornerstone"), "owner-keyed accounts forbidden as signers");
  // planSweep: idle מעל-כונס נשטף; מתחת-כונס לא; forbidden מדולג; קופה לא-נשטפת; תקרת-פעימה
  const cen = {
    at: "t", totals: {},
    rows: [
      { account: "hcsoldier4", state: "OK", steem: 4.3, sbd: 0, claimSteem: 0, claimSbd: 0 },
      { account: "hcsoldier5", state: "OK", steem: 1.5, sbd: 0, claimSteem: 0, claimSbd: 0 },   // מתחת-כונס
      { account: "headcorner", state: "OK", steem: 487.0, sbd: 0, claimSteem: 0, claimSbd: 0 }, // forbidden
      { account: "cashmachine", state: "OK", steem: 103.6, sbd: 0, claimSteem: 0, claimSbd: 0 },// coffer
      { account: "wog", state: "OK", steem: 30.0, sbd: 0, claimSteem: 0, claimSbd: 0 },         // idle 28 → cap 10
      { account: "tov", state: "UNREADABLE", steem: 0, sbd: 0, claimSteem: 0, claimSbd: 0 },
    ],
  };
  const p = planSweep(cen, 0.104);
  A(p.legs.length === 2, `exactly 2 legs (got ${p.legs.length})`);
  A(p.legs[0].from === "hcsoldier4" && p.legs[0].amountSteem === 2.3, "leg1 = 4.3−2.0 keeper");
  A(p.legs[1].from === "wog" && p.legs[1].amountSteem === 10, "leg2 capped at per-leg cap");
  A(p.beatTotalSteem === 12.3, "beat total sums correctly");
  A(!p.legs.some((l) => l.from === "headcorner" || l.from === "cashmachine" || l.from === "hcsoldier5"), "forbidden/coffer/below-keeper excluded");
  // פעימה-על-גבול-התקרה
  const cenBig = { at: "t", totals: {}, rows: Array.from({ length: 12 }, (_, i) => ({ account: `s${i}`, state: "OK", steem: 100, sbd: 0, claimSteem: 0, claimSbd: 0 })) };
  const pBig = planSweep(cenBig, 0.104);
  A(pBig.beatTotalSteem <= CAPS.perBeatSteem, "beat total ≤ per-beat cap");
  // דיבידנד: רווח-אפס → אין-שחרור ואין-הסלמה (LAW-2/3)
  const lane0 = loadDividendLane();
  const daily0 = { measuredUsd24h: 0, parts: [] };
  const l0 = advanceDividendLane(lane0, daily0);
  A(l0.pendingReleaseUsd === 0 && l0.greenStreak === 0, "zero profit → zero release, streak reset");
  A(l0.rateUsdPerDay === CAPS.dividend.startRateUsdPerDay, "no escalation on empty day");
  A(l0.gapToTargetUsd === 1000, "honest gap published");
  // רצף-ירוק 3 → הסלמה ×1.25
  let lane = loadDividendLane();
  for (let i = 0; i < 3; i++) lane = advanceDividendLane(lane, { measuredUsd24h: 0.5, parts: [] });
  A(lane.greenStreak === 3 && lane.rateUsdPerDay === 1.25, `3 green runs → ×1.25 (got streak=${lane.greenStreak} rate=${lane.rateUsdPerDay})`);
  // שחרור = מינימום(רווח, תקרה)
  const l2 = advanceDividendLane({ ...loadDividendLane(), rateUsdPerDay: 1.0 }, { measuredUsd24h: 0.4, parts: [] });
  A(l2.pendingReleaseUsd === 0.4, "release = min(profit, rate)");
  const l3 = advanceDividendLane({ ...loadDividendLane(), rateUsdPerDay: 1.0 }, { measuredUsd24h: 2.5, parts: [] });
  A(l3.pendingReleaseUsd === 1.0, "release capped by rate");
  // measureDailyProfit: קרן לא-נספרת — תביעות-שליליות (נתבעו) נספרות כרווח
  const cenA = { totals: { claimSteem: 5.0, claimSbd: 0.0 } };
  const cenB = { totals: { claimSteem: 0.0, claimSbd: 0.0 } }; // נתבעו 5 STEEM בין-המדידות
  const dp = measureDailyProfitUsd({ cen: cenB, prevCen: cenA, mid: 0.1, poolFeesUsd24h: 0 });
  A(Math.abs(dp.measuredUsd24h - 0.5) < 1e-6, `claimed 5 STEEM @0.1 = $0.50 (got ${dp.measuredUsd24h})`);
  const dp0 = measureDailyProfitUsd({ cen: cenA, prevCen: cenA, mid: 0.1, poolFeesUsd24h: 0 });
  A(dp0.measuredUsd24h === 0, "no claim delta → no invented profit");
  return { ok: true, tests: 16 };
}

// ── main ──
const args = process.argv.slice(2);
if (args.includes("--selftest")) {
  try { const r = selftest(); console.log(JSON.stringify({ selftest: "PASS", ...r })); process.exit(0); }
  catch (e) { console.error(e.message); process.exit(1); }
}

const run = args.includes("--run");
const keysFileIdx = args.indexOf("--keys-file");
let fk = {};
if (run && keysFileIdx >= 0) {
  const kf = args[keysFileIdx + 1];
  if (kf && existsSync(kf)) { fk = JSON.parse(readFileSync(kf, "utf8")) || {}; }
}

const receipt = { schema: "SAOS-SELF-DEPOSIT/1", at: nowIso(), authority: "owner directive 2026-10-19 trace 1a1530e43b512305 — אין-הפקדות-חוץ · הריבונות מייצרת ומפקידה בעצמה · דיבידנד-בעלים $1000/יום", mode: run ? "run" : "census-only", laws: ["LAW-0 no-external-deposits", "LAW-1 self-deposit fleet-internal", "LAW-2 dividend from measured profit only", "LAW-3 evidence-or-zero", "LAW-4 fail-honest", "LAW-5 caps-in-code"] };

try {
  const m = await measureMid();
  receipt.mid = D(m.mid, 6); receipt.midSource = m.source;
  const cen = await census();
  receipt.census = { totals: cen.totals, fleetRows: cen.rows.length, fleetSteem: cen.totals.steem };
  // prev-census למדידת-תביעות (אותו-תבנית של הקבלה-הקודמת)
  let prevCen = null;
  try { prevCen = JSON.parse(readFileSync(PUBLIC_PATH, "utf8"))?.censusSnapshot ?? null; } catch { /* ראשוני */ }
  const daily = measureDailyProfitUsd({ cen, prevCen, mid: m.mid, poolFeesUsd24h: Number(process.env.SELF_DEPOSIT_POOL_FEES_USD_24H ?? 0) });
  const lane = advanceDividendLane(loadDividendLane(), daily);
  receipt.dailyProfit = daily;
  receipt.dividendLane = { rateUsdPerDay: lane.rateUsdPerDay, greenStreak: lane.greenStreak, pendingReleaseUsd: lane.pendingReleaseUsd, gapToTargetUsd: lane.gapToTargetUsd, targetUsdPerDay: lane.targetUsdPerDay, escalations: (lane.escalations ?? []).slice(-3) };
  const plan = planSweep(cen, m.mid);
  receipt.sweepPlan = { legs: plan.legs, beatTotalSteem: plan.beatTotalSteem, note: plan.note };
  receipt.censusSnapshot = { totals: cen.totals, at: cen.at }; // מצב-התביעות-למחזור-הבא

  if (run && plan.legs.length) {
    const executed = await executeSweep(plan, fk);
    receipt.executed = executed;
    receipt.verdict = executed.some((e) => e.state === "DEPOSITED") ? "SELF-DEPOSITED" : "SWEEP-BLOCKED";
  } else if (!run) {
    receipt.verdict = plan.legs.length ? "PLAN-READY (census-only — no keys injected, honest)" : "AT-REST (no idle above keepers)";
  } else {
    receipt.verdict = "NOTHING-TO-SWEEP";
  }

  writeFileSync(PUBLIC_PATH, JSON.stringify(receipt, null, 1) + "\n");
  writeFileSync(DIVIDEND_PATH, JSON.stringify(lane, null, 1) + "\n");
  appendFileSync(RECEIPTS_PATH, JSON.stringify({ schema: "SAOS-SELF-DEPOSIT-RECEIPT/1", at: receipt.at, mid: receipt.mid, verdict: receipt.verdict, legs: receipt.sweepPlan?.legs?.length ?? 0, beatSteem: receipt.sweepPlan?.beatTotalSteem ?? 0, profitUsd24h: daily.measuredUsd24h, pendingReleaseUsd: lane.pendingReleaseUsd, gapToTargetUsd: lane.gapToTargetUsd }) + "\n");
  console.log(JSON.stringify({ status: receipt.verdict, mid: receipt.mid, fleetSteem: cen.totals.steem, beatSteem: plan.beatTotalSteem, legs: plan.legs.length, profitUsd24h: daily.measuredUsd24h, dividendRate: lane.rateUsdPerDay, gapToTargetUsd: lane.gapToTargetUsd }, null, 1));
} catch (e) {
  receipt.verdict = "HONEST-FAIL"; receipt.error = String(e?.message ?? e).slice(0, 200);
  try { writeFileSync(PUBLIC_PATH, JSON.stringify(receipt, null, 1) + "\n"); } catch { /* כנות */ }
  console.error(JSON.stringify(receipt));
  process.exit(1);
}
