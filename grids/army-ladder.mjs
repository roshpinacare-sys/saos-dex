// ARMY-LADDER — ספר-maker רב-חשבונות על השוק הפנימי (R323 · הפעלת-הדקס-כלי-ריבוני)
// ════════════════════════════════════════════════════════════════════════════════
// הבעלים (R323, תור-ה-DEX): "SBD-דמה→נזילות-אמת · שוק-maker-בהון-מוגבל · היפר-גריד +
// זוגות-חדשים · 13-חשבונות-הצי עם היצע-אמת על-השרשרת · VERIFIED-VS-CHAIN על-הווליום".
//
// מה-זה עושה באמת (כנות-לפני-הכל):
//   · כל-חשבון-עובד עם דלק-אמת (נמדד חי 00:3xZ: hcsoldier6 1.000 STEEM, hcsoldier4 0.400,
//     israelnews 0.235, tov 0.209, hcsoldier5 0.200) מציב רגלי-maker קנריות על SBD/STEEM.
//   · חשבונות-אבק (0.010 STEEM ×7) נכנסים ל-FUEL-STASIS כנה — לא נכשלים, שוקטים עם-ראיה.
//   · היפר-גריד = פיזור-עומק: חשבון-i מציב ב-edge + i×staggerBps — פני-הספר מראים
//     סולם-עומק על-פני רמות במקום ערימה ברמה-1. בלי הון-חדש; עומק-נוכחות בלבד.
//   · SBD→נזילות: רגל-קנייה נדלקת לחשבון שצבר ≥minSbdForBuyLeg ממילויים — ה-SBD-הנייר
//     חוזר על-הספר כנזילות-קנייה דו-צדדית.
//   · VERIFIED-VS-CHAIN — מנוע-נפרד (volume-verify.mjs); כאן נכתבות קבלות עם txid+block
//     שהוא מאמת מול-השרשרת.
//
// בטיחות (שרשרת-האכיפה המדודה של הבית: STASIS → POLICY → key-gate → book-law):
//   1. STASIS: stasisHalt("army-ladder") — כלי-לא-מוכר→general (fail-closed); תחת
//      staged-allow החי (R30 full lift) המסילה פתוחה; הידוק-עתידי של-STASIS עוצר-אותנו.
//   2. POLICY: policyCycleGate לכל-חשבון (lane 'grid', kinds limit_order_create/cancel,
//      notionalSbdUpper, opsEst) — HALT = אפס-חתימות-לחשבון-הזה, קבלה-כנה.
//   3. תקרות-קשיחות-בקוד לכל-חשבון: maxPerLeg ≤ 0.300 · maxOpen ≤ 0.600 (קנרית-לנצח;
//      הרחבה = מילת-בעלים + שינוי-הקבועים) + תקרת-אחוזה חדשה: Σ-open ≤ 3.000 STEEM
//      ("הון-מוגבל" — מילת-הבעלים של R323) + roster ≤ 13 (חוק-הצי).
//   4. אסורים-לצמיתון כסוחרים: headcorner/cornerstone (רשות-בעלים — גבול- custody).
//   5. key-gate: WIF-active מאומת מול הרשות-החיה לכל-חשבון בכל-ריצה.
//   6. maker בלבד: מכירה מעל best-bid; קנייה מתחת best-ask; חצייה = חסימה.
//   7. אידמפוטנטיות: orderid = hash(`army-ladder:${account}:${legId}`) — דטרמיניסטי,
//      ייחודי-לחשבון, בטוח-לריצה-כפולה; הצבות-זרות לעולם לא נוגעות.
//   8. חוק-הריגה: תזוזת-מיד > maxKillMidMovePct מ-anchorMid → ביטול-כל-הצבות-שלנו
//      בכל-החשבונות (מניעת-זומבים ברמת-האחוזה).
//   9. תפוגה: כל-הצבה ≤ expiryDays (רשת-בטיחות שרשרתית).
//  10. קריאה-אחרי-כתיבה לכל-txid · אפס-סודות בקבלה/לוג · מפתחות מקובץ-0600 בלבד.
//
// שימוש:
//   node grids/army-ladder.mjs --selftest
//   node grids/army-ladder.mjs --status
//   node grids/army-ladder.mjs --run --keys-file /tmp/fk.json
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { rpcAny, signAndBroadcast, num, dp3 } from "./mover.mjs";
import { stasisHalt } from "./brake.mjs";
import { activeAuthorityOk } from "./key-gate.mjs";
import { policyCycleGate, recordLadderReceipt } from "./policy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLAN_PATH = join(HERE, "state", "army-ladder-plan.json");
const RECEIPT_PATH = join(HERE, "state", "army-receipts.jsonl");
const PUBLIC_PATH = join(HERE, "state", "army-public.json");

/* קבוצת-צמתים-שנייה (אותו-דפוס בית כמו treasury-ladder — exec-20: מתודות לא שוות בין צמתים) */
const ALT_NODES = ["https://api.steemit.com", "https://api.justyy.com", "https://steem-rpc.publicnode.com"];
async function altRpc(method, params) {
  const errs = [];
  for (const node of ALT_NODES) {
    try {
      const r = await fetch(node, {
        method: "POST", headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const j = await r.json();
      if (j.result !== undefined) return j.result;
      errs.push(`${new URL(node).host}: no-result`);
    } catch (e) { errs.push(`${new URL(node).host}: ${String(e?.message ?? e).slice(0, 50)}`); }
  }
  throw new Error(`all-alt-nodes-failed · ${errs.join(" | ")}`);
}

/* ── תקרות-קשיחות (שינוי = מילת-בעלים + קומיט-מתועד) ────────────────────────────── */
/* W2-RAISE (2026-10-18, מילת-בעלים מפורשת — owner instruction: "כל-החשבונות מעורבים
 * בכמה-שיותר עוצמה" + אישור-downpower-1000-SP להזרמת-דלק): התקרות-הקנריות של R323
 * (0.3/0.6/3.0) היו-מתוכננות-להון-אבק-שנמדד-אז (חשבונות-ב-0.010-STEEM). עם-הזרמת-הדלק
 * (fleet-fuel) וה-downpower הן-היו-הופכות-לחסם-מלאכותי. ההרמה-מדורגת: תקרות-הקוד-נותנות
 * תקרה-אמיתית, ותקרות-התוכנית (army-ladder-plan.json) נשארות-החסם-החי-המתוכנן-לפי-דלק
 * שנחת-בפועל. חוקי-הברזל-לא-נגעו: maker-only · kill-law 5% · expiry ≤ 28 · אידמפוטנטיות. */
export const CAPS = {
  maxPerLegSteem: 1.0,   // לכל-חשבון (היה 0.3 — קנרית R323; W2-raise לפי-מילת-בעלים)
  maxOpenSteem: 2.0,     // לכל-חשבון (היה 0.6)
  maxKillMidMovePct: 5,
  maxLegs: 2,
  maxTraders: 13,        // חוק-הצי
  estateMaxOpenSteem: 30.0, // תקרת-אחוזה (היתה 3.0 — R323; W2-raise לפי-מילת-בעלים)
};
export const FORBIDDEN_TRADERS = new Set(["headcorner", "cornerstone"]);
const FUEL_RESERVE_STEEM = 0.1; // דלק-החזקה לכל-חשבון (דפוס-הבית מ-treasury-ladder)

const KILL_LAW = (midNow, midAnchor, maxMovePct) =>
  Math.abs(midNow - midAnchor) / midAnchor * 100 > maxMovePct;

/* ── תוכנית — validation קשוח ──────────────────────────────────────────────────── */
export function validatePlan(plan) {
  if (!plan || plan.protocol !== "SAOS-ARMY-LADDER-PLAN/1") return { ok: false, reason: "protocol foreign/missing — fail-closed" };
  if (!Array.isArray(plan.traders) || plan.traders.length === 0) return { ok: false, reason: "traders missing/empty" };
  if (plan.traders.length > CAPS.maxTraders) return { ok: false, reason: `roster ${plan.traders.length} > ${CAPS.maxTraders} (fleet law)` };
  const seen = new Set();
  for (const t of plan.traders) {
    if (!t || typeof t.account !== "string" || !t.account.trim()) return { ok: false, reason: "trader.account missing" };
    if (FORBIDDEN_TRADERS.has(t.account)) return { ok: false, reason: `owner-keyed account '${t.account}' forbidden as ladder trader (custody boundary)` };
    if (seen.has(t.account)) return { ok: false, reason: `duplicate trader '${t.account}'` };
    seen.add(t.account);
    const per = t.maxPerLegSteem != null ? num(t.maxPerLegSteem) : num(plan.maxPerLegSteem);
    const open = t.maxOpenSteem != null ? num(t.maxOpenSteem) : num(plan.maxOpenSteem);
    if (!(per > 0) || per > CAPS.maxPerLegSteem) return { ok: false, reason: `trader ${t.account}: maxPerLegSteem must be in (0, ${CAPS.maxPerLegSteem}] (canary cap)` };
    if (!(open > 0) || open > CAPS.maxOpenSteem) return { ok: false, reason: `trader ${t.account}: maxOpenSteem must be in (0, ${CAPS.maxOpenSteem}] (canary cap)` };
  }
  if (plan.estateMaxOpenSteem != null && num(plan.estateMaxOpenSteem) > CAPS.estateMaxOpenSteem) return { ok: false, reason: `estateMaxOpenSteem must be ≤ ${CAPS.estateMaxOpenSteem} (limited-capital law)` };
  if (!(num(plan.edgeBps) >= 50)) return { ok: false, reason: "edgeBps must be ≥ 50 (maker discipline)" };
  if (num(plan.staggerBps) < 0) return { ok: false, reason: "staggerBps must be ≥ 0 (hyper-grid spread)" };
  if (!(num(plan.expiryDays) > 0 && num(plan.expiryDays) <= 28)) return { ok: false, reason: "expiryDays must be in (0, 28] (no eternal orders)" };
  if (plan.anchorMid != null && !(num(plan.anchorMid) > 0)) return { ok: false, reason: "anchorMid must be > 0 when present" };
  return { ok: true };
}

/* ── מיד-חי (אמת בלבד; קבוצת-צמתים-שנייה כנפילה-כנה) ────────────────────────────── */
export async function measureMid() {
  let bestBid = null, bestAsk = null;
  try {
    const ob = await rpcAny("condenser_api.get_order_book", [10]);
    if (ob?.bids?.[0]?.real_price) bestBid = num(ob.bids[0].real_price);
    if (ob?.asks?.[0]?.real_price) bestAsk = num(ob.asks[0].real_price);
  } catch { /* הספר-ציבורי נפל — נמשיך לפיד */ }
  let feedMid = null;
  try {
    const feed = await rpcAny("condenser_api.get_feed_history", []);
    const cur = feed?.current_median_history;
    const b = num(cur?.base), q = num(cur?.quote);
    if (b > 0 && q > 0) feedMid = b / q;
  } catch { /* נפילה-כנה לקבוצת-הצמתים-השנייה */ }
  if (feedMid == null) {
    try {
      const feed2 = await altRpc("condenser_api.get_feed_history", []);
      const cur = feed2?.current_median_history;
      const b = num(cur?.base), q = num(cur?.quote);
      if (b > 0 && q > 0) feedMid = b / q;
    } catch { /* כנות: אין-פיד */ }
  }
  const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : feedMid;
  if (!(mid > 0)) return null;
  return { mid, feedMid, bestBid, bestAsk, source: bestBid != null ? "order-book" : "feed" };
}

/* ── orderid-דטרמיניסטי-לחשבון ─────────────────────────────────────────────────── */
export function legOrderId(account, legId) {
  const h = createHash("sha256").update(`army-ladder:${account}:${legId}`).digest();
  return (h.readUInt32LE(0) % 4000000000) + 1;
}

/* ── מרחב-הצבות-שלנו (רק-אלה ניגעים; זרים — לעולם לא) ──────────────────────────── */
export function myKnownOrderIds(plan) {
  const ids = new Map(); // id -> `${account}:${legId}`
  for (const t of (plan.traders || [])) {
    const legs = t.sellLegs || [{}, {}];
    for (const [j] of legs.entries()) {
      if (j >= CAPS.maxLegs) break;
      ids.set(legOrderId(t.account, `sell-${j + 1}`), `${t.account}:sell-${j + 1}`);
    }
    const buy = t.reinvestBuyLegs != null ? !!t.reinvestBuyLegs : !!plan.reinvestBuyLegs;
    if (buy) ids.set(legOrderId(t.account, "buy-1"), `${t.account}:buy-1`);
  }
  return ids;
}

/* ── הטיה-מה-arb (W4): סולם-הצבא נושם עם-ה-arb של-ה-DEX (owner: "ארביטרז' על המחיר") ──
 * קורא את counter-grid-plan.json (הפלט-השעתי של arb-grid) — אם-טרי (<90 דק') ותקין —
 * מחזיר tilt ∈ [-0.25,+0.25]: חיוב = הספר כבד-ביד → רגלי-מכירה גדולות-יותר (עד-cap),
 * קנייה קטנה-יותר. אפס-קובץ/ישן/שבור → 0 (סולם-סימטרי כתמיד). fail-open לחלוטין. */
export function computeArbTilt(planObj, nowMs = Date.now()) {
  try {
    if (!planObj || planObj.ok !== true) return 0;
    const age = nowMs - new Date(planObj.nowIso).getTime();
    if (!Number.isFinite(age) || age < 0 || age > 90 * 60_000) return 0;
    const bid = num(planObj?.bias?.bidShare);
    if (!(bid >= 0 && bid <= 1)) return 0;
    return Math.max(-0.25, Math.min(0.25, (bid - 0.5) * 0.5));
  } catch { return 0; }
}
export function readArbTilt() {
  try { return computeArbTilt(JSON.parse(readFileSync(join(HERE, "state", "counter-grid-plan.json"), "utf8"))); }
  catch { return 0; }
}

/* ── תכנון-רגליים לחשבון (היפר-גריד: stagger לפי-אינדקס-החשבון) ─────────────────── */
export function planAccountLegs({ plan, account, accountIndex, mid, traderSteem, traderSbd, lockedSteem }) {
  const t = plan.traders.find((x) => x.account === account) || {};
  const per = t.maxPerLegSteem != null ? num(t.maxPerLegSteem) : num(plan.maxPerLegSteem);
  const openCap = t.maxOpenSteem != null ? num(t.maxOpenSteem) : num(plan.maxOpenSteem);
  const edge = num(plan.edgeBps) + num(plan.staggerBps) * accountIndex; // היפר-גריד
  const estateCap = plan.estateMaxOpenSteem != null ? num(plan.estateMaxOpenSteem) : CAPS.estateMaxOpenSteem;
  const tilt = num(plan.__arbTilt || 0); // W4: הטיה-מה-arb — fail-open, תחום [-0.25,+0.25]
  const estateLocked = num(plan.__estateLockedSteem || 0);
  const estateRoom = Math.max(0, estateCap - estateLocked);
  let budget = Math.min(openCap, Math.max(0, (traderSteem + lockedSteem) - FUEL_RESERVE_STEEM), estateRoom);
  const legs = [];
  for (const [j, leg] of (t.sellLegs || [{}, {}]).entries()) {
    if (j >= CAPS.maxLegs) break;
    if (budget < 0.05) break;
    const size = Math.min(per * (1 + tilt), budget, num(leg?.sizeSteem) || per * (1 + tilt)); // tilt>0 → אסקים-גדולים (עד-cap; גם-ברירת-המחדל נושמת)
    const price = mid * (1 + (edge / 10000) * (j + 1));
    legs.push({ legId: `sell-${j + 1}`, side: "sell", sizeSteem: dp3(size), priceSbd: Number(price.toFixed(6)), edgeBps: Math.round(edge * (j + 1)) });
    budget -= size;
  }
  // SBD→נזילות: רגל-קנייה רק-מ-SBD שנצבר-ממילויים (לא-הון-חדש)
  const buyOn = t.reinvestBuyLegs != null ? !!t.reinvestBuyLegs : !!plan.reinvestBuyLegs;
  const minSbd = num(plan.minSbdForBuyLeg) > 0 ? num(plan.minSbdForBuyLeg) : 1.0;
  if (buyOn && traderSbd >= minSbd) {
    const buyPrice = mid * (1 - edge / 10000);
    legs.push({ legId: "buy-1", side: "buy", sizeSteem: dp3(Math.max(0, Math.min(per, (traderSbd * 0.9) / buyPrice)) * (1 - tilt)), priceSbd: Number(buyPrice.toFixed(6)), edgeBps: Math.round(edge) });
  }
  return legs;
}

/* ── מנוע-דיפ (אותם-חוקים של-הבית: replace בסטייה, cancel ליתום-שלנו, זרים-אסורים) ── */
export function diffOrders({ liveOrders, targetLegs, knownIds, priceTolBps = 50 }) {
  const actions = [];
  const liveMine = liveOrders.filter((o) => knownIds.has(Number(o.orderid)));
  const byId = new Map(liveMine.map((o) => [Number(o.orderid), o]));
  for (const l of targetLegs) {
    const o = byId.get(l.orderId);
    if (!o) { actions.push({ action: "create", leg: l }); continue; }
    const livePrice = num(o.real_price) || (num(o.order_price?.quote) > 0 ? num(o.order_price?.base) / num(o.order_price?.quote) : 0);
    if (livePrice > 0 && Math.abs(livePrice - l.priceSbd) / l.priceSbd * 10000 > priceTolBps) actions.push({ action: "replace", leg: l, stalePrice: livePrice });
  }
  const targetIds = new Set(targetLegs.map((l) => l.orderId));
  for (const o of liveMine) if (!targetIds.has(Number(o.orderid))) actions.push({ action: "cancel", orderId: Number(o.orderid) });
  return actions;
}

/* ── ריצה ──────────────────────────────────────────────────────────────────────── */
async function run(keysFile) {
  if (!existsSync(PLAN_PATH)) { console.log("[army] plan missing — fail-closed"); process.exit(1); }
  const plan = JSON.parse(readFileSync(PLAN_PATH, "utf8"));
  plan.__arbTilt = readArbTilt(); // W4: הסולם נושם עם-ה-arb (fail-open)
  const v = validatePlan(plan);
  if (!v.ok) { console.log(`[army] plan REJECTED: ${v.reason}`); process.exit(1); }
  if (stasisHalt("army-ladder")) { console.log("[army] STASIS/lane-gate active — capital lanes obey (fail-closed)"); process.exit(0); }

  const m = await measureMid();
  if (!m) { console.log("[army] no honest mid measurement — hands in pockets (by law)"); process.exit(0); }

  let fk = {};
  if (keysFile && existsSync(keysFile)) fk = JSON.parse(readFileSync(keysFile, "utf8")) || {};

  const accounts = plan.traders.map((t) => t.account);

  // מדידה-שרשרתית של-כל-החשבונות בקריאה-אחת (get_accounts מקבל מערך)
  let accts = [];
  try { accts = (await rpcAny("condenser_api.get_accounts", [accounts])) || []; } catch { /* נפילה-כנה לפר-חשבון */ }
  const acctBy = new Map((accts || []).map((a) => [a.name, a]));

  const knownIds = myKnownOrderIds(plan);
  const receipt = {
    schema: "SAOS-ARMY-LADDER-RECEIPT/1", at: new Date().toISOString(),
    mid: m.mid, source: m.source, anchorMid: plan.anchorMid ?? null,
    roster: accounts.length, results: [], executed: [], verdict: null,
  };
  let estateLocked = 0;
  let anyExecuted = false, anyActions = false, anyHalt = false;

  for (const [i, account] of accounts.entries()) {
    const res = { account, state: null, actions: [], txids: [] };
    try {
      const wif = fk?.[account]?.active || "";
      if (!wif) { res.state = "KEY-STASIS"; res.why = "no live active WIF for this account — honest sleep"; receipt.results.push(res); continue; }
      const gate = await activeAuthorityOk({ account, wif, rpc: rpcAny });
      if (!gate.ok) { res.state = "KEY-GATE-REFUSED"; res.why = String(gate.reason ?? "").slice(0, 120); receipt.results.push(res); continue; }

      const acct = acctBy.get(account);
      if (!acct) { res.state = "ACCOUNT-UNREADABLE"; res.why = "get_accounts returned nothing — honest abort for this account"; receipt.results.push(res); continue; }
      const traderSteem = num(acct.balance);
      const traderSbd = num(acct.sbd_balance);
      res.traderSteem = traderSteem; res.traderSbd = traderSbd;

      const liveOrders = await rpcAny("condenser_api.get_open_orders", [account]).catch(() => []);
      res.liveOrders = liveOrders.length;
      const myIds = new Set([...knownIds.entries()].filter(([, tag]) => tag.startsWith(`${account}:`)).map(([id]) => id));
      const lockedSteem = liveOrders.filter((o) => myIds.has(Number(o.orderid)) && Number(o.steem) > 0).reduce((s, o) => s + Number(o.steem) / 1000, 0);
      estateLocked += lockedSteem;

      // חוק-הריגה ברמת-האחוזה: מיד זז מעבר לרצועה → ביטול-כל-שלנו (בכל-החשבונות)
      let actions = [];
      if (plan.anchorMid && KILL_LAW(m.mid, num(plan.anchorMid), CAPS.maxKillMidMovePct)) {
        for (const o of liveOrders) if (myIds.has(Number(o.orderid))) actions.push({ action: "cancel", orderId: Number(o.orderid), why: "kill-law: mid moved beyond canary band" });
      } else {
        const legs = planAccountLegs({ plan, account, accountIndex: i, mid: m.mid, traderSteem, traderSbd, lockedSteem })
          .map((l) => ({ ...l, orderId: legOrderId(account, l.legId) }));
        for (const t of legs) {
          if (t.side === "sell" && m.bestBid != null && t.priceSbd <= m.bestBid) t.blocked = `crossing-forbidden (sell ${t.priceSbd} ≤ best-bid ${m.bestBid})`;
          if (t.side === "buy" && m.bestAsk != null && t.priceSbd >= m.bestAsk) t.blocked = `crossing-forbidden (buy ${t.priceSbd} ≥ best-ask ${m.bestAsk})`;
        }
        actions = diffOrders({ liveOrders, targetLegs: legs.filter((t) => !t.blocked), knownIds: myIds });
        if (legs.some((t) => t.blocked)) res.blocked = legs.filter((t) => t.blocked).map((t) => ({ legId: t.legId, why: t.blocked }));
      }

      if (!actions.length) { res.state = traderSteem + lockedSteem < FUEL_RESERVE_STEEM + 0.05 ? "FUEL-STASIS" : "AT-TARGET"; receipt.results.push(res); continue; }
      anyActions = true;

      // POLICY שער-מחזור (lane 'grid' — אותם-allowlist/caps של-הבית; HALT = אפס-חתימות)
      const notionalUpper = actions.reduce((s, a) => s + (a.leg ? a.leg.sizeSteem * a.leg.priceSbd : 0), 0);
      const pg = policyCycleGate({ tool: "army-ladder", lane: "grid", account, opsEst: actions.length, notionalSbdUpper: notionalUpper });
      if (!pg.allow) { res.state = "POLICY-HALT"; res.why = (pg.reasons || []).join(" ; ").slice(0, 200); anyHalt = true; receipt.results.push(res); continue; }

      const executed = [];
      for (const a of actions) {
        try {
          if (a.action === "cancel") {
            const r = await signAndBroadcast(wif, [["limit_order_cancel", { owner: account, orderid: a.orderId }]]);
            executed.push({ ...a, txid: r.txid, block: r.block }); anyExecuted = true;
          } else {
            const exp = new Date(Date.now() + num(plan.expiryDays) * 86400000).toISOString().slice(0, 19);
            const op = a.leg.side === "sell"
              ? ["limit_order_create", { owner: account, orderid: a.leg.orderId, amount_to_sell: `${a.leg.sizeSteem.toFixed(3)} STEEM`, min_to_receive: `${(a.leg.sizeSteem * a.leg.priceSbd).toFixed(3)} SBD`, fill_or_kill: false, expiration: exp }]
              : ["limit_order_create", { owner: account, orderid: a.leg.orderId, amount_to_sell: `${(a.leg.sizeSteem * a.leg.priceSbd).toFixed(3)} SBD`, min_to_receive: `${a.leg.sizeSteem.toFixed(3)} STEEM`, fill_or_kill: false, expiration: exp }];
            const r = await signAndBroadcast(wif, [op]);
            executed.push({ ...a, txid: r.txid, block: r.block }); anyExecuted = true;
            // קריאה-אחרי-כתיבה — נכשל-כנה בתוך-הרשומה-עצמה, לעולם לא שורה-כפולה (R323-תיקון-ביקורת-עצמית)
            try { await altRpc("condenser_api.get_transaction", [r.txid]); } catch (pv) { executed[executed.length - 1].postVerify = String(pv?.message ?? pv).slice(0, 80); }
          }
        } catch (e) {
          executed.push({ ...a, error: String(e?.message ?? e).slice(0, 120) });
        }
      }
      res.actions = actions.map((a) => ({ ...a, leg: a.leg ? { legId: a.leg.legId, side: a.leg.side, sizeSteem: a.leg.sizeSteem, priceSbd: a.leg.priceSbd, edgeBps: a.leg.edgeBps, blocked: a.leg.blocked } : undefined }));
      res.executed = executed; res.txids = executed.filter((e) => e.txid).map((e) => e.txid);
      res.state = executed.some((e) => e.txid) ? "ACTED" : (executed.length ? "ACTS-FAILED" : "AT-TARGET");
    } catch (e) {
      res.state = "ERROR"; res.why = String(e?.message ?? e).slice(0, 160); // כנות: כשל-חשבון לא מפיל את-האחוזה
    }
    receipt.results.push(res);
    if (res.executed) receipt.executed.push(...res.executed);
  }

  const estateOpenOrders = receipt.results.reduce((s, r) => s + (r.liveOrders ? r.liveOrders : 0), 0);
  receipt.verdict = anyExecuted ? "ARMY-ACTED" : anyHalt ? "ARMY-POLICY-HALTED" : anyActions ? "ARMY-ACTS-FAILED" : "ARMY-AT-TARGET";
  receipt.estateOpenOrders = estateOpenOrders;
  receipt.estateLockedSteem = dp3(estateLocked);
  appendFileSync(RECEIPT_PATH, JSON.stringify(receipt) + "\n");
  try { recordLadderReceipt("army", receipt.verdict); } catch (e) { console.log(`[GEARS] non-blocking: ${String(e?.message ?? e).slice(0, 80)}`); } // R329: gearbox never blocks the road
  writeFileSync(PUBLIC_PATH, JSON.stringify({
    schema: "SAOS-ARMY-LADDER-PUBLIC/1", at: receipt.at, mid: m.mid, source: m.source,
    roster: accounts.length, acted: receipt.results.filter((r) => r.state === "ACTED").length,
    stasis: receipt.results.filter((r) => r.state === "FUEL-STASIS" || r.state === "KEY-STASIS").length,
    halted: receipt.results.filter((r) => r.state === "POLICY-HALT" || r.state === "KEY-GATE-REFUSED").length,
    estateOpenOrders, estateLockedSteem: receipt.estateLockedSteem,
    estateCapSteem: plan.estateMaxOpenSteem ?? CAPS.estateMaxOpenSteem,
    verdict: receipt.verdict,
  }, null, 1) + "\n");
  const byState = {};
  for (const r of receipt.results) byState[r.state] = (byState[r.state] || 0) + 1;
  console.log(`[army] verdict=${receipt.verdict} · mid=${m.mid} (${m.source}) · states=${JSON.stringify(byState)} · executed=${receipt.executed.filter((e) => e.txid).length}`);
}

/* ── selftest (אופליין — וקטורים-כנים) ─────────────────────────────────────────── */
export async function selftest() {
  const assert = (c, msg) => { if (!c) { console.error("SELFTEST FAIL:", msg); process.exit(1); } };
  const basePlan = { protocol: "SAOS-ARMY-LADDER-PLAN/1", traders: [{ account: "hcsoldier4" }, { account: "tov" }], maxPerLegSteem: 0.15, maxOpenSteem: 0.3, edgeBps: 150, staggerBps: 40, expiryDays: 7, estateMaxOpenSteem: 3.0 };
  assert(validatePlan(basePlan).ok, "valid army plan accepted");
  assert(!validatePlan({ protocol: "OTHER/1" }).ok, "foreign protocol refused");
  assert(!validatePlan({ ...basePlan, traders: [{ account: "headcorner" }] }).ok, "owner-keyed trader refused (custody boundary)");
  assert(!validatePlan({ ...basePlan, traders: [{ account: "hcsoldier4" }, { account: "hcsoldier4" }] }).ok, "duplicate trader refused");
  assert(!validatePlan({ ...basePlan, maxPerLegSteem: 2.0 }).ok, "per-leg cap enforced (W2: cap 1.0)");
  assert(!validatePlan({ ...basePlan, maxOpenSteem: 3.0 }).ok, "open cap enforced (W2: cap 2.0)");
  assert(!validatePlan({ ...basePlan, estateMaxOpenSteem: 40.0 }).ok, "estate cap enforced (W2: cap 30.0)");
  assert(validatePlan({ ...basePlan, maxPerLegSteem: 1.0 }).ok, "per-leg cap allows exactly 1.0 (W4 raise)");
  assert(validatePlan({ ...basePlan, maxOpenSteem: 2.0 }).ok, "open cap allows exactly 2.0 (W4 raise)");
  assert(validatePlan({ ...basePlan, estateMaxOpenSteem: 30.0 }).ok, "estate cap allows exactly 30 (W4 raise)");
  assert(!validatePlan({ ...basePlan, edgeBps: 30 }).ok, "min edge enforced");
  assert(!validatePlan({ ...basePlan, staggerBps: -5 }).ok, "negative stagger refused");
  assert(!validatePlan({ ...basePlan, expiryDays: 30 }).ok, "expiry ceiling enforced");
  assert(!validatePlan({ ...basePlan, traders: Array.from({ length: 14 }, (_, i) => ({ account: `a${i}` })) }).ok, "roster cap enforced (fleet law)");
  assert(!validatePlan({ ...basePlan, anchorMid: 0 }).ok, "anchorMid must be positive when present");

  const oid = legOrderId("hcsoldier4", "sell-1");
  assert(Number.isInteger(oid) && oid >= 1 && oid <= 4000000000, "orderid in uint32 range");
  assert(oid === legOrderId("hcsoldier4", "sell-1"), "orderid deterministic");
  assert(legOrderId("tov", "sell-1") !== oid, "orderid namespace per-account");

  const known = myKnownOrderIds({ ...basePlan, reinvestBuyLegs: true });
  assert(known.size === 6, "known-id space = 2 accounts × (2 sell + buy)");

  // היפר-גריד: stagger אנכי לאורך-אינדקס-החשבון
  const l0 = planAccountLegs({ plan: basePlan, account: "hcsoldier4", accountIndex: 0, mid: 0.103, traderSteem: 0.4, traderSbd: 0, lockedSteem: 0 });
  const l1 = planAccountLegs({ plan: basePlan, account: "tov", accountIndex: 1, mid: 0.103, traderSteem: 0.209, traderSbd: 0, lockedSteem: 0 });
  assert(l0.length === 2, "hcsoldier4 0.4 STEEM → budget 0.3 = two 0.15 legs (open cap binds)");
  assert(l1.length === 1, "tov 0.209 → budget 0.109 = one budget-gated leg (fuel reserve respected)");
  assert(l1[0].priceSbd > l0[0].priceSbd, "hyper-grid: account-1 priced above account-0 (stagger)");
  assert(l0[0].sizeSteem <= 0.15 + 1e-9 && l1[0].sizeSteem <= 0.109 + 1e-9, "leg sizes respect per-leg cap and remaining budget");

  const dust = planAccountLegs({ plan: basePlan, account: "wic", accountIndex: 5, mid: 0.103, traderSteem: 0.01, traderSbd: 0, lockedSteem: 0 });
  assert(dust.length === 0, "dust account → zero legs (fuel reserve law)");

  const sbdAcc = planAccountLegs({ plan: { ...basePlan, reinvestBuyLegs: true, minSbdForBuyLeg: 1.0 }, account: "hcsoldier6", accountIndex: 2, mid: 0.103, traderSteem: 1.0, traderSbd: 1.2, lockedSteem: 0 });
  assert(sbdAcc.some((l) => l.side === "buy"), "SBD ≥ minSbdForBuyLeg → buy leg lights up (SBD→liquidity)");
  const noSbd = planAccountLegs({ plan: { ...basePlan, reinvestBuyLegs: true }, account: "hcsoldier6", accountIndex: 2, mid: 0.103, traderSteem: 1.0, traderSbd: 0.5, lockedSteem: 0 });
  assert(!noSbd.some((l) => l.side === "buy"), "SBD below threshold → no buy leg");

  const estate = planAccountLegs({ plan: { ...basePlan, __estateLockedSteem: 2.95 }, account: "hcsoldier6", accountIndex: 0, mid: 0.103, traderSteem: 1.0, traderSbd: 0, lockedSteem: 0 });
  assert(estate.length === 0, "estate cap nearly full → no new legs (limited-capital law)");

  // W4 — arb-tilt vectors (fail-open law)
  const NOW = 1_800_000_000_000;
  assert(computeArbTilt({ ok: true, nowIso: new Date(NOW).toISOString(), bias: { bidShare: 0.538 } }, NOW) > 0, "bid-heavy book → positive tilt (asks up)");
  assert(computeArbTilt({ ok: true, nowIso: new Date(NOW).toISOString(), bias: { bidShare: 0.2 } }, NOW) < 0, "ask-heavy book → negative tilt (asks down)");
  assert(computeArbTilt({ ok: true, nowIso: new Date(NOW - 91 * 60_000).toISOString(), bias: { bidShare: 0.9 } }, NOW) === 0, "stale plan (>90min) → tilt 0 (fail-open)");
  assert(computeArbTilt({ ok: false, nowIso: new Date(NOW).toISOString(), bias: { bidShare: 0.9 } }, NOW) === 0, "plan not-ok → tilt 0");
  assert(computeArbTilt({ ok: true, nowIso: new Date(NOW).toISOString(), bias: { bidShare: 2.0 } }, NOW) === 0, "impossible bidShare → tilt 0");
  assert(computeArbTilt(null, NOW) === 0, "null plan → tilt 0");
  const tiltUp = computeArbTilt({ ok: true, nowIso: new Date(NOW).toISOString(), bias: { bidShare: 0.9 } }, NOW); // +0.2
  const legT = planAccountLegs({ plan: { ...basePlan, __arbTilt: tiltUp }, account: "hcsoldier6", accountIndex: 0, mid: 0.103, traderSteem: 5.0, traderSbd: 0, lockedSteem: 0 });
  const leg0 = planAccountLegs({ plan: { ...basePlan }, account: "hcsoldier6", accountIndex: 0, mid: 0.103, traderSteem: 5.0, traderSbd: 0, lockedSteem: 0 });
  assert(legT[0].sizeSteem > leg0[0].sizeSteem, "positive tilt → bigger sell legs (within caps)");
  assert(legT[0].sizeSteem <= 1.0 + 1e-9, "tilt never exceeds code per-leg cap");
  const sym = planAccountLegs({ plan: { ...basePlan, __arbTilt: 0 }, account: "hcsoldier6", accountIndex: 0, mid: 0.103, traderSteem: 5.0, traderSbd: 0, lockedSteem: 0 });
  assert(sym[0].sizeSteem === leg0[0].sizeSteem, "tilt 0 → symmetric ladder unchanged");

  const d = diffOrders({ liveOrders: [{ orderid: oid, real_price: "0.100000" }], targetLegs: [{ legId: "sell-1", orderId: oid, priceSbd: 0.11 }], knownIds: new Set([oid]) });
  assert(d.some((a) => a.action === "replace"), "stale price → replace");
  const dSame = diffOrders({ liveOrders: [{ orderid: oid, real_price: "0.110000" }], targetLegs: [{ legId: "sell-1", orderId: oid, priceSbd: 0.11 }], knownIds: new Set([oid]) });
  assert(dSame.length === 0, "same price → no action");
  const dF = diffOrders({ liveOrders: [{ orderid: 777, real_price: "0.1" }], targetLegs: [], knownIds: new Set([oid]) });
  assert(dF.length === 0, "FOREIGN order → NEVER touched");
  const dO = diffOrders({ liveOrders: [{ orderid: oid, real_price: "0.1" }], targetLegs: [], knownIds: new Set([oid]) });
  assert(dO.some((a) => a.action === "cancel"), "own orphan → cancel");

  assert(KILL_LAW(0.11, 0.10, 5) === true, "kill law fires beyond band");
  assert(KILL_LAW(0.104, 0.10, 5) === false, "kill law silent inside band");

  // תאימות-מדידה חיה: יתרות-השרשרת שנמדדו 00:3xZ חייבות להניב את-תמונת-הציפיות
  const rota6 = planAccountLegs({ plan: { ...basePlan, reinvestBuyLegs: true }, account: "hcsoldier6", accountIndex: 2, mid: 0.103, traderSteem: 1.0, traderSbd: 0, lockedSteem: 0 });
  assert(rota6.length === 2, "hcsoldier6 (1.0 STEEM): two legs within caps");
  assert(rota6.every((l) => l.sizeSteem <= 0.15 + 1e-9), "hcsoldier6 legs respect per-leg cap");

  console.log("SELFTEST PASS: 30/30 vectors (army-ladder)");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--selftest")) { await selftest(); return; }
  if (args.includes("--status")) {
    const plan = existsSync(PLAN_PATH) ? JSON.parse(readFileSync(PLAN_PATH, "utf8")) : null;
    console.log("[army] plan:", plan ? `${plan.protocol} roster=${(plan.traders || []).length} edge=${plan.edgeBps} stagger=${plan.staggerBps}` : "missing");
    const m = await measureMid().catch(() => null);
    console.log("[army] mid:", m ? `${m.mid} (${m.source})` : "unmeasurable");
    return;
  }
  const kfIdx = args.indexOf("--keys-file");
  await run(kfIdx >= 0 ? args[kfIdx + 1] : null);
}
main().catch((e) => { console.error("[army] FATAL:", String(e?.message ?? e).slice(0, 160)); process.exit(1); });
