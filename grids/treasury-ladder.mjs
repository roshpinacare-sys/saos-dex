// TREASURY-LADDER — מסילת-הכנסה של-האוצר על-הספר הציבורי (R16-b · owner trace 1a12defa20399391)
// ══════════════════════════════════════════════════════════════════════════════════════════════
// הבעלים: "כבר-שלחתי-מיליון-פעמים-את-המפתחות · תמצא · תצית" + (trace 1a12de036c1159b5) "אם-יש-לך-
// owner יש-לך-active · אין-מצב-כזה-שהוא-לא-עובד". המדידה: סריקה-ממצה (18-כרוכים + כל-היסטוריית-הגיט
// + כל-גזירה-אפשרית) מוכיחה שה-active של-headcorner (רוטציית-10-08) אינו-בשום-חומר-שהמכונה-מחזיקה —
// אבל המכונה מחזיקה שליטה-מלאה-חיה ב-13-חשבונות-עובדים. מסילת-האוצר רצה על חשבון-עובד-אוצרתי
// (hcsoldier4 — סוכן-מסילת-ה-escrow, מפתחות-חיים ב-GEN-2, נזילות נמדדה 1.000 STEEM + 0.050 SBD):
// סולם-maker על SBD/STEEM — רק-הצבות-מייצרות, בלי-חציית-הספר, בלי-לשרוף-כסף.
//
// בטיחות (כל-השכבות; כל-כשל = עצירה-כנה בלי-נגיעה):
//   1. STASIS: stasisHalt("general") — fail-closed.
//   2. תוכנית-חתומה בלבד: SAOS-TREASURY-LADDER-PLAN/1 (קובץ-זר = fail-closed).
//   3. תקרות-קשיחות-בקוד: maxOpenSteem ≤ 0.600 · maxPerLegSteem ≤ 0.300 (קנרית-לנצח;
//      הרחבה = מילת-בעלים + שינוי-הקבועים-בקוד עם-רישום).
//   4. שער-מפתח: ה-WIF של-הסוחר מאומת מול רשות-ה-active החיה (key-gate — אותו-משטר-בית).
//   5. maker בלבד: מכירה מעל המיד ב-edgeBps לפחות; אסור לחצות (מחיר-מכירה ≤ best-bid = דחייה).
//   6. אידמפוטנטיות-מהשרשרת: find_limit_orders לפני-כל-צעד; orderid דטרמיניסטי מ-id-הרגל;
//      הפרש-מול-היעד = ביטול/הצבה מדויק בלבד. בטוח לריצה-כפולה.
//   7. חוק-הריגה: תזוזת-מיד >5% מאוגן-התוכנית → ביטול-כל-הצבות-הסוחר (מניעת-זומבים; לקח-14-a).
//   8. תפוגה: כל-הצבה עם expiration ≤ expiryDays (רשת-בטיחות שרשרתית — אין-זומבים-נצחיים).
//   9. קריאה-אחרי-כתיבה: get_transaction לכל-txid.
//  10. אפס-סודות בקבלה/לוג; מפתחות מקובץ-0600-זמני (resolve-keys) או env — לעולם לא מודפסים.
//
// שימוש:
//   node grids/treasury-ladder.mjs --status                    (קריאה-בלבד)
//   node grids/treasury-ladder.mjs --run --keys-file /tmp/fk.json
//   node grids/treasury-ladder.mjs --selftest
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { rpcAny, signAndBroadcast, num, dp3, orderSteemLocked, orderLivePrice } from "./mover.mjs";
import { stasisHalt } from "./brake.mjs";
import { activeAuthorityOk } from "./key-gate.mjs";
import { recordLadderReceipt } from "./policy.mjs"; // R329: the receipt IS the upshift — gearbox fed at verdict time

const HERE = dirname(fileURLToPath(import.meta.url));
const PLAN_PATH = join(HERE, "state", "treasury-ladder-plan.json");
const RECEIPT_PATH = join(HERE, "state", "treasury-receipts.jsonl");
const PUBLIC_PATH = join(HERE, "state", "treasury-public.json");

/* קבוצת-צמתים-שנייה למדידות (exec-20: צמתים-שונים מחזיקים-מתודות-שונות) */
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

/* ── תקרות-קשיחות (קנרית-לנצח — שינוי = מילת-בעלים + קומיט-מתועד) ─────────────── */
export const CAPS = { maxOpenSteem: 3.0, maxPerLegSteem: 1.5, maxKillMidMovePct: 5, maxLegs: 2 };
/* W5-raise 2026-10-19 (מנדט-בעלים W13: "כל-הצי באותו-ווליום... הרבה-יותר ווליום ורווח"):
 * היה 0.6/0.3 (W2). המדידה: hcsoldier4 — סוחר-מסילת-ההכנסה — 9 מילויים/24h, החלק
 * הפעיל-ביותר בצי, והתקרה היתה החסם-המלאכותי-היחיד שלו. */

const KILL_LAW = (midNow, midAnchor, maxMovePct) =>
  Math.abs(midNow - midAnchor) / midAnchor * 100 > maxMovePct;

/* ── תוכנית — validation קשוח ──────────────────────────────────────────────────── */
export function validatePlan(plan) {
  if (!plan || plan.protocol !== "SAOS-TREASURY-LADDER-PLAN/1") return { ok: false, reason: "protocol foreign/missing — fail-closed" };
  if (typeof plan.trader !== "string" || !plan.trader) return { ok: false, reason: "trader missing" };
  if (plan.trader === "headcorner" || plan.trader === "cornerstone") return { ok: false, reason: "owner-keyed accounts are forbidden as ladder traders (custody boundary)" };
  const per = num(plan.maxPerLegSteem), open = num(plan.maxOpenSteem);
  if (!(per > 0) || per > CAPS.maxPerLegSteem) return { ok: false, reason: `maxPerLegSteem must be in (0, ${CAPS.maxPerLegSteem}] (canary cap)` };
  if (!(open > 0) || open > CAPS.maxOpenSteem) return { ok: false, reason: `maxOpenSteem must be in (0, ${CAPS.maxOpenSteem}] (canary cap)` };
  if (!(num(plan.edgeBps) >= 50)) return { ok: false, reason: "edgeBps must be ≥ 50 (maker discipline — no crossing, no dust-chasing)" };
  if (!(num(plan.expiryDays) > 0 && num(plan.expiryDays) <= 28)) return { ok: false, reason: "expiryDays must be in (0, 28] (no eternal orders)" };
  if (plan.sellLegs !== undefined && (!Array.isArray(plan.sellLegs) || plan.sellLegs.length > CAPS.maxLegs)) return { ok: false, reason: `sellLegs length must be ≤ ${CAPS.maxLegs} (canary)` };
  return { ok: true };
}

/* ── מדידות-שוק (אמת בלבד — אין-מחירים-מומצאים) ───────────────────────────────── */
export async function measureMid() {
  // מיד-חי מהספר: real_price (SBD/STEEM) — שדה-האמת של condenser (נמדד 03:3xZ: bid 0.1026 < ask 0.1028)
  let bestBid = null, bestAsk = null;
  try {
    const ob = await rpcAny("condenser_api.get_order_book", [10]);
    if (ob?.bids?.[0]?.real_price) bestBid = num(ob.bids[0].real_price);
    if (ob?.asks?.[0]?.real_price) bestAsk = num(ob.asks[0].real_price);
  } catch { /* הספר-ציבורי נפל — נמשיך לפיד */ }
  // פיד-חלופי: get_feed_history — על-שתי-קבוצות-צמתים (exec-20: המתודה חסרה-על-חלק-מהצמתים)
  let feedMid = null;
  try {
    const feed = await rpcAny("condenser_api.get_feed_history", []);
    const cur = feed?.current_median_history;
    const b = num(cur?.base), q = num(cur?.quote);
    if (b > 0 && q > 0) feedMid = b / q;
  } catch { /* נפילה-כנה לקבוצת-הצמתים-השנייה */ }
  if (feedMid == null) {
    try {
      // קבוצת-צמתים-שנייה (אותם-צמתים של-key-census-probe — justyy/publicnode מחזיקים-feed_history)
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

/* ── סוחר-מזהה-הצבות-שלו: orderid = hash(id-הרגל) תחום ל-uint32 ────────────────── */
export function legOrderId(legId) {
  const h = createHash("sha256").update(`treasury-ladder:${legId}`).digest();
  return (h.readUInt32LE(0) % 4000000000) + 1;
}

/* ── דיפ-ההצבות: ניהול-הצבות-שלנו בלבד (orderid שנגזר מ-id-רגל-מהתוכנית;
 *    הצבות-זרות של-הסוחר — לעולם לא נוגעים בהן) ─────────────────────────── */
export function myKnownOrderIds(plan) {
  const ids = new Set();
  for (const [i] of (plan.sellLegs || []).entries()) ids.add(legOrderId(`sell-${i + 1}`));
  if (plan.reinvestBuyLegs) ids.add(legOrderId("buy-1"));
  return ids;
}
export function diffOrders({ liveOrders, targetLegs, knownIds, priceTolBps = 50 }) {
  const actions = [];
  const liveMine = liveOrders.filter((o) => knownIds.has(Number(o.orderid)));
  const byId = new Map(liveMine.map((o) => [Number(o.orderid), o]));
  for (const l of targetLegs) {
    const o = byId.get(l.orderId);
    if (!o) { actions.push({ action: "create", leg: l }); continue; }
    // W12-fix: real_price קורא אפסים על-הצמתים-החיים ואין order_price — הצורה-החיה = sell_price (orderLivePrice)
    const livePrice = orderLivePrice(o); // W12-fix: real_price קורא אפסים על-צמתים-חיים + אין order_price — הצורה-החיה = sell_price
    if (livePrice > 0 && Math.abs(livePrice - l.priceSbd) / l.priceSbd * 10000 > priceTolBps) actions.push({ action: "replace", leg: l, stalePrice: livePrice });
  }
  const targetIds = new Set(targetLegs.map((l) => l.orderId));
  for (const o of liveMine) if (!targetIds.has(Number(o.orderid))) actions.push({ action: "cancel", orderId: Number(o.orderid) });
  return actions;
}
export function planLadder({ plan, mid, traderSteem, lockedSteem = 0 }) {
  const legs = [];
  const per = num(plan.maxPerLegSteem);
  const openCap = num(plan.maxOpenSteem);
  // התקציב סופר גם את מה שכבר מונח-על-הספר (locked) — אחרת הריצה-השנייה רואה-את-הרגליים-הפועלות-כיתומות (באג-שנמדד-חי ב-run 38200441621)
  let budget = Math.min(openCap, Math.max(0, (traderSteem + lockedSteem) - 0.1)); // 0.1 STEEM דלק-החזקה
  for (const [i, leg] of (plan.sellLegs || []).entries()) {
    if (budget < 0.05) break;
    const size = Math.min(per, budget, num(leg.sizeSteem) || per);
    const price = mid * (1 + num(plan.edgeBps) / 10000 * (i + 1));
    legs.push({ legId: `sell-${i + 1}`, side: "sell", sizeSteem: dp3(size), priceSbd: Number(price.toFixed(6)) });
    budget -= size;
  }
  return legs;
}

/* ── ריצה ──────────────────────────────────────────────────────────────────────── */
async function run(keysFile) {
  if (!existsSync(PLAN_PATH)) { console.log("[ladder] plan missing — fail-closed"); process.exit(1); }
  const plan = JSON.parse(readFileSync(PLAN_PATH, "utf8"));
  const v = validatePlan(plan);
  if (!v.ok) { console.log(`[ladder] plan REJECTED: ${v.reason}`); process.exit(1); }
  if (stasisHalt("general")) { console.log("[ladder] STASIS active — capital lanes obey (fail-closed)"); process.exit(0); }

  const trader = plan.trader;
  let wif = process.env.TREASURY_WIF || "";
  if (!wif && keysFile) {
    const fk = JSON.parse(readFileSync(keysFile, "utf8"));
    wif = fk?.[trader]?.active || "";
  }
  if (!wif) { console.log(`[ladder] no live active WIF for ${trader} — honest exit (nothing signed)`); process.exit(0); }
  const gate = await activeAuthorityOk({ account: trader, wif, rpc: rpcAny });
  if (!gate.ok) { console.log(`[ladder] key-gate REFUSED for ${trader}: ${gate.reason} — fail-closed, zero chain contact`); process.exit(0); }

  const m = await measureMid();
  if (!m) { console.log("[ladder] no honest mid measurement — hands in pockets (by law)"); process.exit(0); }

  let acct = null;
  try { acct = (await rpcAny("condenser_api.get_accounts", [[trader]]))[0]; } catch { /* נפילה-כנה למטה */ }
  if (!acct) { console.log("[ladder] trader account unreadable — honest abort (nothing signed)"); process.exit(1); }
  const traderSteem = num(acct.balance);
  const traderSbd = num(acct.sbd_balance);

  // condenser_api.get_open_orders (נמדד חי 03:3xZ — find_limit_orders אינו-קיים-בקונדנסר-על-הצמתים-החיים)
  const liveOrders = await rpcAny("condenser_api.get_open_orders", [trader]).catch(() => []);
  // ה-locked שלנו = סכום-הרגליים-המוכרות-המונחות (W12-fix: for_sale+sell_price — o.steem אינו-קיים-בצמתים-החיים)
  const knownIds0 = myKnownOrderIds(plan);
  const lockedSteem = liveOrders.filter((o) => knownIds0.has(Number(o.orderid))).reduce((s, o) => s + orderSteemLocked(o), 0); // W12-fix: o.steem לא-קיים-בצמתים-חיים — for_sale+sell_price הוא-האמת (הריצות-הקודמות מדדו תמיד 0)

  const actions = [];
  const knownIds = myKnownOrderIds(plan);
  // חוק-הריגה: רק-ההצבות-שלנו
  if (plan.anchorMid && KILL_LAW(m.mid, num(plan.anchorMid), CAPS.maxKillMidMovePct)) {
    for (const o of liveOrders) if (knownIds.has(Number(o.orderid))) actions.push({ action: "cancel", orderId: Number(o.orderid), why: "kill-law: mid moved beyond canary band" });
  } else {
    const targets = planLadder({ plan, mid: m.mid, traderSteem, lockedSteem }).map((l) => ({ ...l, orderId: legOrderId(l.legId) }));
    // מנוע-maker: דחיית-חצייה
    for (const t of targets) if (m.bestBid != null && t.priceSbd <= m.bestBid) { t.blocked = `crossing-forbidden (price ${t.priceSbd} ≤ best-bid ${m.bestBid})`; }
    actions.push(...diffOrders({ liveOrders, targetLegs: targets.filter((t) => !t.blocked), knownIds }));
    // רגל-קנייה: רק-מ-SBD-שנצבר-ממילויים (השקעה-מחדש — לא-הון-חדש)
    if (traderSbd >= 1.0 && (plan.reinvestBuyLegs || false)) {
      const buyPrice = m.mid * (1 - num(plan.edgeBps) / 10000);
      const leg = { legId: "buy-1", side: "buy", sizeSteem: dp3(Math.min(num(plan.maxPerLegSteem), traderSbd / buyPrice * 0.9)), priceSbd: Number(buyPrice.toFixed(6)), orderId: legOrderId("buy-1") };
      if (m.bestAsk == null || leg.priceSbd >= m.bestAsk) actions.push({ action: "create", leg });
    }
  }

  const receipt = { schema: "SAOS-TREASURY-LADDER-RECEIPT/1", at: new Date().toISOString(), trader, mid: m.mid, source: m.source, traderSteem, traderSbd, liveOrders: liveOrders.length, actions: actions.map(a => ({ ...a, leg: a.leg ? { legId: a.leg.legId, side: a.leg.side, sizeSteem: a.leg.sizeSteem, priceSbd: a.leg.priceSbd, blocked: a.leg.blocked } : undefined })) };
  const executed = [];
  for (const a of actions) {
    try {
      if (a.action === "cancel") {
        const r = await signAndBroadcast(wif, [["limit_order_cancel", { owner: trader, orderid: a.orderId }]]);
        executed.push({ ...a, txid: r.txid, block: r.block });
      } else if (a.action === "create" || a.action === "replace") {
        const exp = new Date(Date.now() + num(plan.expiryDays) * 86400000).toISOString().slice(0, 19);
        const op = a.leg.side === "sell"
          ? ["limit_order_create", { owner: trader, orderid: a.leg.orderId, amount_to_sell: `${a.leg.sizeSteem.toFixed(3)} STEEM`, min_to_receive: `${(a.leg.sizeSteem * a.leg.priceSbd).toFixed(3)} SBD`, fill_or_kill: false, expiration: exp }]
          : ["limit_order_create", { owner: trader, orderid: a.leg.orderId, amount_to_sell: `${(a.leg.sizeSteem * a.leg.priceSbd).toFixed(3)} SBD`, min_to_receive: `${a.leg.sizeSteem.toFixed(3)} STEEM`, fill_or_kill: false, expiration: exp }];
        const r = await signAndBroadcast(wif, [op]);
        executed.push({ ...a, txid: r.txid, block: r.block });
        await altRpc("condenser_api.get_transaction", [r.txid]); // קריאה-אחרי-כתיבה
      }
    } catch (e) {
      executed.push({ ...a, error: String(e?.message ?? e).slice(0, 120) });
    }
  }
  receipt.executed = executed;
  receipt.verdict = executed.length ? "LADDER-ACTED" : (actions.length ? "ACTS-FAILED" : "LADDER-AT-TARGET");
  appendFileSync(RECEIPT_PATH, JSON.stringify(receipt) + "\n");
  writeFileSync(PUBLIC_PATH, JSON.stringify({ schema: "SAOS-TREASURY-LADDER-PUBLIC/1", at: receipt.at, trader, mid: m.mid, source: m.source, openOrders: liveOrders.length, acted: executed.filter(e => e.txid).length, verdict: receipt.verdict }, null, 1) + "\n");
  try { recordLadderReceipt("treasury", receipt.verdict); } catch (e) { console.log(`[GEARS] non-blocking: ${String(e?.message ?? e).slice(0, 80)}`); } // R329: gearbox never blocks the road
  console.log(`[ladder] verdict=${receipt.verdict} · mid=${m.mid} (${m.source}) · actions=${actions.length} · executed=${executed.filter(e => e.txid).length}`);
}

/* ── selftest (אופליין) ────────────────────────────────────────────────────────── */
export async function selftest() {
  const assert = (c, msg) => { if (!c) { console.error("SELFTEST FAIL:", msg); process.exit(1); } };
  assert(validatePlan({ protocol: "SAOS-TREASURY-LADDER-PLAN/1", trader: "hcsoldier4", maxPerLegSteem: 1.5, maxOpenSteem: 3.0, edgeBps: 800, expiryDays: 7, sellLegs: [] }).ok, "valid plan accepted (W5 caps)");
  assert(!validatePlan({ protocol: "OTHER/1" }).ok, "foreign protocol refused");
  assert(!validatePlan({ protocol: "SAOS-TREASURY-LADDER-PLAN/1", trader: "headcorner", maxPerLegSteem: 1.5, maxOpenSteem: 3.0, edgeBps: 800, expiryDays: 7 }).ok, "owner-keyed trader refused");
  assert(!validatePlan({ protocol: "SAOS-TREASURY-LADDER-PLAN/1", trader: "hcsoldier4", maxPerLegSteem: 2.0, maxOpenSteem: 3.0, edgeBps: 800, expiryDays: 7 }).ok, "per-leg cap enforced (W5: 1.5)");
  assert(!validatePlan({ protocol: "SAOS-TREASURY-LADDER-PLAN/1", trader: "hcsoldier4", maxPerLegSteem: 1.5, maxOpenSteem: 4.0, edgeBps: 800, expiryDays: 7 }).ok, "open cap enforced (W5: 3.0)");
  assert(!validatePlan({ protocol: "SAOS-TREASURY-LADDER-PLAN/1", trader: "hcsoldier4", maxPerLegSteem: 1.5, maxOpenSteem: 3.0, edgeBps: 30, expiryDays: 7 }).ok, "min edge enforced");
  assert(KILL_LAW(0.11, 0.10, 5) === true, "kill law fires beyond band");
  assert(KILL_LAW(0.104, 0.10, 5) === false, "kill law silent inside band");
  const legs = planLadder({ plan: { maxPerLegSteem: 0.3, maxOpenSteem: 0.6, edgeBps: 150, sellLegs: [{}, {}] }, mid: 0.1028, traderSteem: 1.0 });
  assert(legs.length === 2, "two legs planned");
  assert(legs[1].priceSbd > legs[0].priceSbd, "ladder prices ascend with leg index");
  assert(legs.every((l) => l.sizeSteem <= 0.3 + 1e-9), "leg sizes respect cap");
  const oid = legOrderId("sell-1");
  assert(Number.isInteger(oid) && oid >= 1 && oid <= 4000000000, "orderid in uint32 range");
  const oid2 = legOrderId("sell-1");
  assert(oid === oid2, "orderid deterministic");
  const known = myKnownOrderIds({ sellLegs: [{}, {}], reinvestBuyLegs: true });
  assert(known.size === 3, "known-id space = plan legs");
  const d = diffOrders({ liveOrders: [{ orderid: oid, real_price: "0.100000" }], targetLegs: [{ legId: "sell-1", orderId: oid, priceSbd: 0.11 }], knownIds: known });
  assert(d.some((a) => a.action === "replace"), "stale price → replace");
  const dSame = diffOrders({ liveOrders: [{ orderid: oid, real_price: "0.110000" }], targetLegs: [{ legId: "sell-1", orderId: oid, priceSbd: 0.11 }], knownIds: known });
  assert(dSame.length === 0, "same price → no action (object-shape sell_price immunity)");
  const d2 = diffOrders({ liveOrders: [{ orderid: oid, real_price: "0.1" }], targetLegs: [], knownIds: known });
  assert(d2.some((a) => a.action === "cancel"), "own orphan → cancel");
  const d3 = diffOrders({ liveOrders: [{ orderid: 777, real_price: "0.1" }], targetLegs: [], knownIds: known });
  assert(d3.length === 0, "FOREIGN order (unknown orderid) → NEVER touched");
  const l2 = planLadder({ plan: { maxPerLegSteem: 0.3, maxOpenSteem: 0.6, edgeBps: 150, sellLegs: [{}, {}] }, mid: 0.1028, traderSteem: 0.4, lockedSteem: 0.6 });
  assert(l2.length === 2, "locked funds count toward the ladder budget (no orphan-cancels on re-runs)");
  // W12-fix (2026-10-19): צורת-get_open_orders החיה — אין o.steem · real_price=אפסים · אין order_price
  assert(orderSteemLocked({ for_sale: 2900, sell_price: { base: "2.900 STEEM", quote: "0.306 SBD" } }) === 2.9, "live-shape sell order → STEEM locked");
  assert(orderSteemLocked({ for_sale: 306, sell_price: { base: "0.306 SBD", quote: "2.900 STEEM" } }) === 0, "live-shape buy order → zero STEEM locked");
  const lpStale = orderLivePrice({ real_price: "0.00000000000000000", sell_price: { base: "2.900 STEEM", quote: "0.300 SBD" } });
  assert(lpStale > 0.103 && lpStale < 0.104, "live-shape price derivation (replace engine alive on real nodes)");
  const dLiveStale = diffOrders({ liveOrders: [{ orderid: oid, real_price: "0.00000000000000000", sell_price: { base: "2.900 STEEM", quote: "0.300 SBD" }, for_sale: 2900 }], targetLegs: [{ legId: "sell-1", orderId: oid, priceSbd: 0.11 }], knownIds: known });
  assert(dLiveStale.some((a) => a.action === "replace"), "live-shape stale order → replace (real_price-zeros no longer blinds the diff)");
  console.log("SELFTEST PASS: 23/23 vectors");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--selftest")) { await selftest(); return; }
  if (args.includes("--status")) {
    const plan = existsSync(PLAN_PATH) ? JSON.parse(readFileSync(PLAN_PATH, "utf8")) : null;
    console.log("[ladder] plan:", plan ? `${plan.protocol} trader=${plan.trader} caps=${plan.maxPerLegSteem}/${plan.maxOpenSteem}` : "missing");
    const m = await measureMid().catch(() => null);
    console.log("[ladder] mid:", m ? `${m.mid} (${m.source})` : "unmeasurable");
    return;
  }
  const kfIdx = args.indexOf("--keys-file");
  await run(kfIdx >= 0 ? args[kfIdx + 1] : null);
}
main().catch((e) => { console.error("[ladder] FATAL:", String(e?.message ?? e).slice(0, 160)); process.exit(1); });
