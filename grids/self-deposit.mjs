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
import { tmpdir } from "node:os";
import { rpcAny, signAndBroadcast, num, dp3 } from "./mover.mjs";
import { activeAuthorityOk } from "./key-gate.mjs";
import { policyGate } from "./policy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(HERE, "state");
const PUBLIC_PATH = join(STATE_DIR, "self-deposit-public.json");
const RECEIPTS_PATH = join(STATE_DIR, "self-deposit-receipts.jsonl");
const DIVIDEND_PATH = join(STATE_DIR, "dividend-lane.json");
const INTERNAL_PNL_PATH = join(STATE_DIR, "internal-pnl.json"); // גשר-ה-P&L-הפנימי (grids/internal-pnl.mjs)

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

// ── P&L-אמת מהביקורת (LAW-3: קבלה-או-אפס) — pnl-audit.json טרי ≤26ש׳ ──
export function readLatestPnl(publicPath = join(STATE_DIR, "pnl-audit.json")) {
  try {
    const raw = JSON.parse(readFileSync(publicPath, "utf8"));
    if (raw?.schema !== "SAOS-PNL-AUDIT/1" || typeof raw.engineEra?.estatePnlSbd !== "number") return null;
    const ageMs = Date.now() - Date.parse(raw.at);
    if (!(ageMs >= 0) || ageMs > 26 * 3600 * 1000) return null; // ישן = לא-אמון
    return { eraPnlSbd: raw.engineEra.estatePnlSbd, at: raw.at, selfCrosses: raw.selfCrosses ?? null };
  } catch { return null; }
}

// ── P&L-אמת-מהכלכלה-הפנימית (LAW-3): internal-pnl.json טרי ≤4ש׳ (מופק-שעתית) ──
// קורא-את-הראצ'ט treasuryProfitEverMu — Σקציר-עמלות-מונוטוני ממילויים-אמת ב-DEX
// (1 USDS = 1000µ מאומת-מקבלת-הפקדה — ראה grids/internal-pnl.mjs).
export function readLatestInternalPnl(path = INTERNAL_PNL_PATH, maxAgeMs = 4 * 3600 * 1000) {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (raw?.schema !== "SAOS-INTERNAL-PNL/1" || !Number.isFinite(raw.treasuryProfitEverMu) || raw.treasuryProfitEverMu < 0) return null;
    const ageMs = Date.now() - Date.parse(raw.at);
    if (!(ageMs >= 0) || ageMs > maxAgeMs) return null; // ישן = לא-אמון (LAW-4)
    if (raw.ratchetSuspect) return null; // מונה-שיורד = תמונה-זרה — נדחה בכנות
    return { treasuryProfitEverMu: raw.treasuryProfitEverMu, muPerUsds: raw.muPerUsds ?? 1000, at: raw.at, fills: raw.engineSnapshot?.fills ?? null, height: raw.engineSnapshot?.height ?? null };
  } catch { return null; }
}


// ── רווח-חוץ-מהוכח (external-profit.mjs): התגשמות-vests עם-ראיות-שרשרת ──
// partition-אנטי-כפילות: כאן-רק-הכנסה-המדודה-ב-external-profit-public.json
// (curation + author-vests accrual); תביעות-נזילות נשארות-ב-chain-claims למעלה.
export function readLatestExternalProfit(path = join(STATE_DIR, "external-profit-public.json"), maxAgeMs = 26 * 3600 * 1000) {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (raw?.schema !== "SAOS-EXTERNAL-PROFIT/1") return null;
    const ageMs = Date.now() - Date.parse(raw.at);
    if (!(ageMs >= 0) || ageMs > maxAgeMs) return null; // ישן = לא-אמון (LAW-4)
    const usd = Number(raw.measuredUsd24h);
    if (!Number.isFinite(usd) || usd <= 0) return null; // אפס-או-חסר = אין-חלק (כנות)
    return { usd: D(usd, 4), vests: raw.measuredVests24h ?? null, parts: raw.parts ?? [], at: raw.at, pricing: raw.pricing ?? null };
  } catch { return null; }
}

// רווח-מדוד 24h: (א) תביעות-תשואה מהשרשרת (ב) עמלות-בריכה מקבלות-feeMeter
// (ג) **רווח-מסחר-אמת מהביקורת** (pnl-audit — מילויים-אמת, מודע-חצייה-עצמית, דלתא-בין-ריצות).
// (ד) **עמלות-ה-DEX-הפנימי** (internal-pnl — דלתא-ראצ'ט treasuryProfitEver, 1 USDS=1000µ).
// כנות: מה שאין-לו-קבלה = 0. הקרן (יתרות) אינה רווח — LAW-2. דלתא-שלילית = 0-הכנסה
// (ההפסד-כבר-משתקף-במלאי — לא-ממציאים-הכנסה-שלילית-לנתיב-הדיבידנד).
export function measureDailyProfitUsd({ cen, prevCen, mid, poolFeesUsd24h, pnlNow, pnlPrev, sbdUsd = 1, ipNow, ipPrev, xpNow }) {
  const parts = [];
  const claimSteem = cen.totals.claimSteem - (prevCen?.totals?.claimSteem ?? 0); // שלילי=נתבע-המחזור-קודם → רווח-הפוך
  const claims = { source: "chain rewards claimed (net of reserve)", usd: D(Math.max(0, -(claimSteem)) * mid + Math.max(0, -(cen.totals.claimSbd - (prevCen?.totals?.claimSbd ?? 0)))), steem: D(Math.max(0, -(claimSteem))) };
  if (claims.usd > 0) parts.push({ id: "chain-claims", ...claims });
  if (Number(poolFeesUsd24h) > 0) parts.push({ id: "dex-pool-fees", usd: D(poolFeesUsd24h), source: "feeMeter receipts (evidence: sweep-ledger/flow24)" });
  if (pnlNow != null) {
    const delta = pnlNow.eraPnlSbd - (pnlPrev?.eraPnlSbd ?? pnlNow.eraPnlSbd); // אין-קודם = דלתא-0 (כנות — הצבירה-הקיימת-אינה-הכנסת-היום)
    const usd = D(Math.max(0, delta) * sbdUsd, 6);
    if (usd > 0) parts.push({ id: "trading-pnl", usd, source: `pnl-audit ${pnlNow.at} (eraPnlSbd ${pnlNow.eraPnlSbd}, selfCrosses ${pnlNow.selfCrosses ?? "?"})`, note: "fill_order truth, self-cross-aware, mark-to-market" });
  }
  if (ipNow != null && ipNow.muPerUsds > 0) {
    const deltaMu = ipPrev?.treasuryProfitEverMu == null ? 0 : Math.max(0, ipNow.treasuryProfitEverMu - ipPrev.treasuryProfitEverMu); // ראצ'ט-מגולל
    const usd = D(deltaMu / ipNow.muPerUsds, 6);
    if (usd > 0) parts.push({ id: "internal-dex-fees", usd, source: `internal-pnl ${ipNow.at} (ΔtreasuryProfitEver +${deltaMu}µ @${ipNow.muPerUsds}µ/USDS, fills ${ipNow.fills ?? "?"})`, note: "monotonic Σ-harvest of real DEX fills (kernel.ts:2288 ratchet)" });
  }
  if (xpNow != null && xpNow.usd > 0) parts.push({ id: "chain-yield", usd: xpNow.usd, vests: xpNow.vests, source: `external-profit ${xpNow.at} (curation+author-vests accrual, txid/block-evidenced)`, note: "vests-denominated income — never counted by liquid-claims census (zero overlap)" });
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
  // דיבידנד: רווח-אפס → אין-שחרור ואין-הסלמה (LAW-2/3) — בסיס-דטרמיניסטי (לא-הנתיב-החי)
  const lane0 = { ...loadDividendLane(), greenStreak: 0, rateUsdPerDay: CAPS.dividend.startRateUsdPerDay, escalations: [] };
  const daily0 = { measuredUsd24h: 0, parts: [] };
  const l0 = advanceDividendLane(lane0, daily0);
  A(l0.pendingReleaseUsd === 0 && l0.greenStreak === 0, "zero profit → zero release, streak reset");
  A(l0.rateUsdPerDay === CAPS.dividend.startRateUsdPerDay, "no escalation on empty day");
  A(l0.gapToTargetUsd === 1000, "honest gap published");
  // רצף-ירוק 3 → הסלמה ×1.25 (בסיס-דטרמיניסטי)
  let lane = { ...loadDividendLane(), greenStreak: 0, rateUsdPerDay: CAPS.dividend.startRateUsdPerDay, escalations: [] };
  for (let i = 0; i < 3; i++) lane = advanceDividendLane(lane, { measuredUsd24h: 0.5, parts: [] });
  A(lane.greenStreak === 3 && lane.rateUsdPerDay === 1.25, `3 green runs → ×1.25 (got streak=${lane.greenStreak} rate=${lane.rateUsdPerDay})`);
  // שחרור = מינימום(רווח, תקרה)
  // [wave 19.55 · trace 1a15f267e3a06a41] determinism cure: the seed used to spread
  // the LIVE lane file in — its greenStreak accumulator (live: 2 since the lane went
  // live 10-19) + one advance = streak 3 = escalation ×1.25 → rate 1.25 → release
  // 1.25 ≠ 1.0 — the selftest red-ed hourly (runs 13:47Z…15:55Z) on a HEALTHY law.
  // A deterministic test seeds a deterministic base: accumulators zeroed explicitly,
  // exactly like the lane0/3-green cases above. The cap law is isolated here; the
  // escalation law has its own case (3 green → ×1.25).
  const l2 = advanceDividendLane({ ...loadDividendLane(), greenStreak: 0, rateUsdPerDay: 1.0, escalations: [], pendingReleaseUsd: 0 }, { measuredUsd24h: 0.4, parts: [] });
  A(l2.pendingReleaseUsd === 0.4, "release = min(profit, rate)");
  const l3 = advanceDividendLane({ ...loadDividendLane(), greenStreak: 0, rateUsdPerDay: 1.0, escalations: [], pendingReleaseUsd: 0 }, { measuredUsd24h: 2.5, parts: [] });
  A(l3.pendingReleaseUsd === 1.0, "release capped by rate");
  // readLatestInternalPnl: טרי-עובר · ישן-נדחה · ראצ'ט-חשוד-נדחה · סכימה-שגויה-נדחית
  const ipTmp = mkTmp("internal-pnl.json", JSON.stringify({ schema: "SAOS-INTERNAL-PNL/1", at: nowIso(), treasuryProfitEverMu: 18393971, muPerUsds: 1000, ratchetSuspect: false, engineSnapshot: { fills: 119413, height: 722115 } }));
  A(readLatestInternalPnl(ipTmp)?.treasuryProfitEverMu === 18393971, "fresh internal-pnl accepted");
  const ipOld = mkTmp("internal-pnl-old.json", JSON.stringify({ schema: "SAOS-INTERNAL-PNL/1", at: "2026-10-01T00:00:00Z", treasuryProfitEverMu: 5, muPerUsds: 1000 }));
  A(readLatestInternalPnl(ipOld) === null, "stale internal-pnl refused (>4h)");
  const ipSus = mkTmp("internal-pnl-sus.json", JSON.stringify({ schema: "SAOS-INTERNAL-PNL/1", at: nowIso(), treasuryProfitEverMu: 5, muPerUsds: 1000, ratchetSuspect: true }));
  A(readLatestInternalPnl(ipSus) === null, "ratchet-suspect refused");
  A(readLatestInternalPnl(join(STATE_DIR, "no-such-internal.json")) === null, "missing internal-pnl → null (honest)");
  // measureDailyProfit: קרן לא-נספרת — תביעות-שליליות (נתבעו) נספרות כרווח
  const cenA = { totals: { claimSteem: 5.0, claimSbd: 0.0 } };
  const cenB = { totals: { claimSteem: 0.0, claimSbd: 0.0 } }; // נתבעו 5 STEEM בין-המדידות
  const dp = measureDailyProfitUsd({ cen: cenB, prevCen: cenA, mid: 0.1, poolFeesUsd24h: 0 });
  A(Math.abs(dp.measuredUsd24h - 0.5) < 1e-6, `claimed 5 STEEM @0.1 = $0.50 (got ${dp.measuredUsd24h})`);
  const dp0 = measureDailyProfitUsd({ cen: cenA, prevCen: cenA, mid: 0.1, poolFeesUsd24h: 0 });
  A(dp0.measuredUsd24h === 0, "no claim delta → no invented profit");
  // P&L-מסחר-אמת: דלתא-חיובית-נספרת · שלילית-אינה-ממציאה-הכנסה · חסר-קודם = 0
  const pn = { eraPnlSbd: 1.5, at: "t", selfCrosses: 0 };
  const pp = { eraPnlSbd: 1.0, at: "t", selfCrosses: 0 };
  const dpP = measureDailyProfitUsd({ cen: cenA, prevCen: cenA, mid: 0.1, poolFeesUsd24h: 0, pnlNow: pn, pnlPrev: pp });
  A(dpP.measuredUsd24h === 0.5, `trading pnl delta +0.5 (got ${dpP.measuredUsd24h})`);
  const dpN = measureDailyProfitUsd({ cen: cenA, prevCen: cenA, mid: 0.1, poolFeesUsd24h: 0, pnlNow: { ...pn, eraPnlSbd: 0.8 }, pnlPrev: pp });
  A(dpN.measuredUsd24h === 0, "negative pnl delta = zero income (losses live in inventory)");
  const dpF = measureDailyProfitUsd({ cen: cenA, prevCen: cenA, mid: 0.1, poolFeesUsd24h: 0, pnlNow: pn, pnlPrev: null });
  A(dpF.measuredUsd24h === 0, "no previous pnl receipt = zero delta (honest)");
  // P&L-פנימי: דלתא-ראצ'ט-חיובית-נספרת (5000µ→8000µ @1000µ/USDS = $3) · אין-קודם=0 · שלילי=מגולל
  const ipN = { treasuryProfitEverMu: 8000, muPerUsds: 1000, at: "t", fills: 10 };
  const ipP = { treasuryProfitEverMu: 5000, muPerUsds: 1000, at: "t" };
  const dpI = measureDailyProfitUsd({ cen: cenA, prevCen: cenA, mid: 0.1, poolFeesUsd24h: 0, ipNow: ipN, ipPrev: ipP });
  A(dpI.measuredUsd24h === 3, `internal dex fees delta 3000µ = $3 (got ${dpI.measuredUsd24h})`);
  const dpI0 = measureDailyProfitUsd({ cen: cenA, prevCen: cenA, mid: 0.1, poolFeesUsd24h: 0, ipNow: ipN, ipPrev: null });
  A(dpI0.measuredUsd24h === 0, "no prev internal = zero (הצבירה-הקיימת-אינה-הכנסת-היום)");
  const dpIx = measureDailyProfitUsd({ cen: cenA, prevCen: cenA, mid: 0.1, poolFeesUsd24h: 0, ipNow: { ...ipN, treasuryProfitEverMu: 4000 }, ipPrev: ipP });
  A(dpIx.measuredUsd24h === 0, "falling ratchet clamped → zero (suspect images never pay)" );
  // readLatestPnl: טרי-עובר · ישן-נדחה · סכימה-שגויה-נדחית
  const tmp = mkTmp("pnl-audit.json", JSON.stringify({ schema: "SAOS-PNL-AUDIT/1", at: nowIso(), engineEra: { estatePnlSbd: 1.23 }, selfCrosses: 0 }));
  A(readLatestPnl(tmp)?.eraPnlSbd === 1.23, "fresh pnl accepted");
  const old = mkTmp("pnl-audit-old.json", JSON.stringify({ schema: "SAOS-PNL-AUDIT/1", at: "2026-10-01T00:00:00Z", engineEra: { estatePnlSbd: 9 } }));
  A(readLatestPnl(old) === null, "stale pnl refused (>26h)");
  const bad = mkTmp("pnl-audit-bad.json", JSON.stringify({ schema: "OTHER/1", at: nowIso(), engineEra: { estatePnlSbd: 9 } }));
  A(readLatestPnl(bad) === null, "wrong schema refused");
  A(readLatestPnl(join(STATE_DIR, "no-such-pnl.json")) === null, "missing file → null (honest)");
  return { ok: true, tests: 21 };
}

function mkTmp(name, content) {
  const p = join(tmpdir(), `saos-sd-${Date.now()}-${name}`);
  writeFileSync(p, content);
  return p;
}

// ── סולם-ההסלמות (דבר-הבעלים 2026-10-19: "הסלמות לעוד ערך · עוד דרכים שיפתחו צעד צעד · פוטנציאל רחב מעבר ל-steem") ──
// כל-מדרגה: מצב-אמת מדוד + תנאי-פתיחה. אין-הבטחות — רק-דלתות-ממוספרות.
export function escalationLadder({ pnl, cen }) {
  const selfCrossLeak = (pnl?.selfCrosses ?? 0) > 0;
  return [
    { id: "ESC-1", name: "תיקון-חצייה-עצמית (self-cross guard ב-mover)", state: selfCrossLeak ? "SHIPPED — guard live, leak drains as old legs expire (27d max)" : "CLEAN", value: "סתימת-הדליפה ששרפה RC + נפח-מזויף; מאפשר-רווח-אמת", evidence: pnl ? `selfCrosses=${pnl.selfCrosses}` : null },
    { id: "ESC-2", name: "P&L-אמת → נתיב-הדיבידנד", state: "SHIPPED", value: "המונה-מוזן-ממילויים-אמת (fill_order, מודע-חצייה-עצמית) — רווח-אמת-בלבד נכנס-למדידה", evidence: pnl ? `eraPnlSbd=${pnl.eraPnlSbd}` : null },
    { id: "ESC-3", name: "הגדלת-רגלי-המדרגות לפי-רצף-ירוק", state: "ARMED — W13 caps 1.5/3.0 live; next tier = 3 green receipts (auto ×1.25)", value: "אותו-מבנה-מילויים, רגליים-גדולות — הרווח-נסקל-ליניארית-עד-תקרת-הסלמה", evidence: "treasury-ladder CAPS + dividend escalation" },
    { id: "ESC-4", name: "הפעלת-עובד-הון-האוצר (487 STEEM נזיל ב-headcorner)", state: "BLOCKED — owner key (REQ-0008): המפתח-ב-upload אינו-סמכות-החיה", value: "×5-עובד-הון = ×5-קנבס-מילויים-על-אותו-מנוע", evidence: "self-deposit census 2026-10-19: headcorner 487.086 STEEM" },
    { id: "ESC-5", name: "העמקת-מילויים-חוץ-אמת (84 מילויים-מול-צדדים-חוץ נמדדו)", state: "GROWING — depth + spread-tightening on the internal book", value: "כל-מילוי-חוץ = רווח-מרק-אמת (לא-wash)", evidence: "pnl-audit externalFills=84 (coin-raffle/cashly/btsx/vfund...)" },
    { id: "ESC-6", name: "מסילת-בלרט (57.97 BLURT נזיל · ציטוט-חסר-מפתחות קיים)", state: "READY-TO-PLAN — venues/blurt-quote.mjs live; execution needs Blurt key census", value: "שוק-שני-בלגרפיה-אחת — אותם-חוקי-מדרגה, ספר-דק-יותר", evidence: "custody.json blurt-liquid 57.972 ONCHAIN_REAL" },
    { id: "ESC-7", name: "תשואות-קורציון (צי-13 מצביע-ומפרסם כבר)", state: "ALIVE-LOW — claims flow into census; scale = more voting power via SP", value: "הכנסה-פסיבית-אמת-על-השרשרת; מחוברת-לדיבידנד דרך-התביעות", evidence: "grids/curate.mjs + chain-claims part in dailyProfit" },
    { id: "ESC-8", name: "דלגציית SP — תשואה-פסיבית על 2.35M VESTS-האוצר", state: "BLOCKED — owner key (REQ-0007/0008) + החלטת-מטריצה", value: "APR-מדוד ~24% (אומדן-לא-הבטחה) — ההכנסה-הפסיבית-הגדולה-ביותר-הזמינה", evidence: "REQ-0007 SP matrix + headcorner 2,349,020 VESTS delegated" },
    { id: "ESC-9", name: "ARB-מעבר-ל-STEEM: CEX (HTX/binance) מול-הספר-הפנימי", state: "MEASURED — arb-scan live (paperPnl −426 naive / +1.79 strategy); real execution = הכרעת-בעלים על-venue", value: "פוטנציאל-רחב-מעבר-ל-steem: פערים-אמת בין-ה-CEX-לספר-הפנימי", evidence: "grids/arb-ledger.json cumulative + arb-scan.mjs CEX feeds" },
    { id: "ESC-10", name: "עמלות-בריכות-דקס (treasuryProfitEver) → P&L-מפורסם", state: "WIRED-2026-10-19 — גשר internal-pnl.mjs מפרסם-את-הראצ'ט; המנוע-מודד-דלתא-לנתיב-הדיבידנד", value: "הרווח-האמת-מהמסחר-הפנימי נראה-לבעלים: $18,393.97 מצטבר (ראצ'ט) · 119,413 מילויים אמת", evidence: "grids/state/internal-pnl.json · kernel.ts:2288 monotonic Σ-harvest" },
    { id: "ESC-11", name: "קציר-עמלות-מתוזמן + מסילת-תשלום-דיבידנד (µ→STEEM→בעלים)", state: "RAIL-LIVE-2026-10-19 — dividend-sweep.mjs חי (selftest 10/10 · CI ציבורי) · לולאת-30-דק: קציר-עמלות (fee-harvest H-1..H-5) + Δראצ'ט-treasuryProfitEver → xfer_free treasury→owner-dividend (אפס-גז · רצפת-דלק 200Kµ · תקרה 2Mµ) · קציר-שני בנק: 2,152µ (19:20Z) · הרגל-החוץ (STEEM→בעלים) נשארת-נעולה-לאישור-מפעיל (bridge.ts כנות-מבנית) · מתוזמן-מקומית (resurrect-fleet) — בלי-תלות-Actions", value: "המסילה-זורמת: עמלות-נמדדות → רווח-אוצר → דיבידנד-בעלים-פנימי → קנברי-READY-FOR-RELEASE למשיכה-חוץ-מאושרת", evidence: "grids/state/dividend-sweep.jsonl · grids/state/dividend-watermark.json · kernel.ts:1571 xfer_free (SETTLE-12)" },
    { id: "ESC-12", name: "פוטנציאל-רחב-מעבר-ל-STEEM (עורקי-תשתית-מוכחים)", state: "MAPPED — 4/4 עורקי-ענן חיים (gitlab/supabase/vercel/render אומתו 200) · סריקת-שווקים-ARB מדודה (arb-scan CEX-מול-ספר)", value: "דרכי-ערך-מעבר-לשרשרת: פריסת-שירותים-מניבים על-העורקים-הקיימים · ARB-אמת בין-venues", evidence: "state/keys/REGISTRY.json + worklog Task19 key-probe 4/4 · grids/arb-ledger.json" },
  ];
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
  // prev-census למדידת-תביעות + prev-pnl לדלתא-רווח-מסחר (אותו-תבנית snapshot)
  let prevCen = null, pnlPrev = null, ipPrev = null;
  try { const prev = JSON.parse(readFileSync(PUBLIC_PATH, "utf8")); prevCen = prev?.censusSnapshot ?? null; pnlPrev = prev?.pnlSnapshot ?? null; ipPrev = prev?.internalPnlSnapshot ?? null; } catch { /* ראשוני */ }
  const pnlNow = readLatestPnl();
  const ipNow = readLatestInternalPnl();
  const xpNow = readLatestExternalProfit();
  const daily = measureDailyProfitUsd({ cen, prevCen, mid: m.mid, poolFeesUsd24h: Number(process.env.SELF_DEPOSIT_POOL_FEES_USD_24H ?? 0), pnlNow, pnlPrev, ipNow, ipPrev, xpNow });
  const lane = advanceDividendLane(loadDividendLane(), daily);
  receipt.dailyProfit = daily;
  receipt.dividendLane = { rateUsdPerDay: lane.rateUsdPerDay, greenStreak: lane.greenStreak, pendingReleaseUsd: lane.pendingReleaseUsd, gapToTargetUsd: lane.gapToTargetUsd, targetUsdPerDay: lane.targetUsdPerDay, escalations: (lane.escalations ?? []).slice(-3) };
  receipt.pnlSource = pnlNow ? { at: pnlNow.at, eraPnlSbd: pnlNow.eraPnlSbd, selfCrosses: pnlNow.selfCrosses } : null; // כנות: אין-ביקורת-טרייה = אין-מקור
  receipt.internalPnl = ipNow ? { at: ipNow.at, treasuryProfitEverMu: ipNow.treasuryProfitEverMu, treasuryProfitEverUsd: D(ipNow.treasuryProfitEverMu / ipNow.muPerUsds, 2), fills: ipNow.fills, height: ipNow.height, source: "grids/internal-pnl.mjs → SAOS-INTERNAL-PNL/1" } : null; // הרווח-הפנימי-המצטבר-רואה-אור
  receipt.externalProfit = xpNow ? { at: xpNow.at, usd24h: xpNow.usd, vests24h: xpNow.vests, pricing: xpNow.pricing, source: "grids/external-profit.mjs → SAOS-EXTERNAL-PROFIT/1" } : null; // הרווח-החוץ-המדוד-רואה-אור (owner trace 1a15ceb5c5659485)
  receipt.escalationLadder = escalationLadder({ pnl: pnlNow, cen });
  const plan = planSweep(cen, m.mid);
  receipt.sweepPlan = { legs: plan.legs, beatTotalSteem: plan.beatTotalSteem, note: plan.note };
  receipt.censusSnapshot = { totals: cen.totals, at: cen.at }; // מצב-התביעות-למחזור-הבא
  receipt.pnlSnapshot = pnlNow ? { eraPnlSbd: pnlNow.eraPnlSbd, at: pnlNow.at } : null; // דלתא-למחזור-הבא
  receipt.internalPnlSnapshot = ipNow ? { treasuryProfitEverMu: ipNow.treasuryProfitEverMu, at: ipNow.at } : null; // ראצ'ט-למחזור-הבא

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
