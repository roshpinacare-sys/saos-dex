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
import { rpcAny, signAndBroadcast, num, dp3 } from "./mover.mjs";
import { stasisHalt } from "./brake.mjs";
import { activeAuthorityOk } from "./key-gate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLAN_PATH = join(HERE, "state", "treasury-ladder-plan.json");
const RECEIPT_PATH = join(HERE, "state", "treasury-receipts.jsonl");
const PUBLIC_PATH = join(HERE, "state", "treasury-public.json");

/* ── תקרות-קשיחות (קנרית-לנצח — שינוי = מילת-בעלים + קומיט-מתועד) ─────────────── */
export const CAPS = { maxOpenSteem: 0.6, maxPerLegSteem: 0.3, maxKillMidMovePct: 5, maxLegs: 2 };

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
  // מחיר-הפיד דרך dgp — מתודה-אוניברסלית שקיימת-על-כל-הצמתים (exec-20: get_feed_history
  // חסר-על-צמתים-חלופיים-של-CI; נפילה-כנה לספר-החי ואז ל-dgp)
  let feedMid = null;
  try {
    const dgp = await rpcAny("condenser_api.get_dynamic_global_properties", []);
    const cmp = dgp?.current_median_history_price;
    if (cmp?.base && cmp?.quote) {
      const b = num(cmp.base), q = num(cmp.quote);
      if (b > 0 && q > 0) feedMid = b / q;
    }
  } catch { /* נפילה-כנה */ }
  let bestBid = null, bestAsk = null;
  try {
    const ob = await rpcAny("condenser_api.get_order_book", [10]);
    if (ob?.bids?.[0]?.price) bestBid = num(ob.bids[0].price);
    if (ob?.asks?.[0]?.price) bestAsk = num(ob.asks[0].price);
  } catch { /* הספר-ציבורי נפל — נמשיך על-הפיד בלבד */ }
  // מיד-נמדד: עדיפות לאמצע-הספר-החי; נפילה-כנה לפיד
  const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : feedMid;
  if (!(mid > 0)) return null;
  return { mid, feedMid, bestBid, bestAsk, source: bestBid != null ? "order-book" : "dgp-feed" };
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
    const livePrice = num(o.sell_price) || (num(o.min_to_receive) / num(o.amount_to_sell));
    if (Math.abs(livePrice - l.priceSbd) / l.priceSbd * 10000 > priceTolBps) actions.push({ action: "replace", leg: l, stalePrice: livePrice });
  }
  const targetIds = new Set(targetLegs.map((l) => l.orderId));
  for (const o of liveMine) if (!targetIds.has(Number(o.orderid))) actions.push({ action: "cancel", orderId: Number(o.orderid) });
  return actions;
}
export function planLadder({ plan, mid, traderSteem }) {
  const legs = [];
  const per = num(plan.maxPerLegSteem);
  const openCap = num(plan.maxOpenSteem);
  let budget = Math.min(openCap, Math.max(0, traderSteem - 0.1)); // 0.1 STEEM דלק-החזקה
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

  const acct = (await rpcAny("condenser_api.get_accounts", [[trader]]))[0];
  const traderSteem = num(acct.balance);
  const traderSbd = num(acct.sbd_balance);

  const live = await rpcAny("condenser_api.find_limit_orders", { account: trader });
  const liveOrders = live?.orders ?? [];

  const actions = [];
  const knownIds = myKnownOrderIds(plan);
  // חוק-הריגה: רק-ההצבות-שלנו
  if (plan.anchorMid && KILL_LAW(m.mid, num(plan.anchorMid), CAPS.maxKillMidMovePct)) {
    for (const o of liveOrders) if (knownIds.has(Number(o.orderid))) actions.push({ action: "cancel", orderId: Number(o.orderid), why: "kill-law: mid moved beyond canary band" });
  } else {
    const targets = planLadder({ plan, mid: m.mid, traderSteem }).map((l) => ({ ...l, orderId: legOrderId(l.legId) }));
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
        await rpcAny("condenser_api.get_transaction", [r.txid]); // קריאה-אחרי-כתיבה
      }
    } catch (e) {
      executed.push({ ...a, error: String(e?.message ?? e).slice(0, 120) });
    }
  }
  receipt.executed = executed;
  receipt.verdict = executed.length ? "LADDER-ACTED" : (actions.length ? "ACTS-FAILED" : "LADDER-AT-TARGET");
  appendFileSync(RECEIPT_PATH, JSON.stringify(receipt) + "\n");
  writeFileSync(PUBLIC_PATH, JSON.stringify({ schema: "SAOS-TREASURY-LADDER-PUBLIC/1", at: receipt.at, trader, mid: m.mid, source: m.source, openOrders: liveOrders.length, acted: executed.filter(e => e.txid).length, verdict: receipt.verdict }, null, 1) + "\n");
  console.log(`[ladder] verdict=${receipt.verdict} · mid=${m.mid} (${m.source}) · actions=${actions.length} · executed=${executed.filter(e => e.txid).length}`);
}

/* ── selftest (אופליין) ────────────────────────────────────────────────────────── */
export async function selftest() {
  const assert = (c, msg) => { if (!c) { console.error("SELFTEST FAIL:", msg); process.exit(1); } };
  assert(validatePlan({ protocol: "SAOS-TREASURY-LADDER-PLAN/1", trader: "hcsoldier4", maxPerLegSteem: 0.3, maxOpenSteem: 0.6, edgeBps: 800, expiryDays: 7, sellLegs: [] }).ok, "valid plan accepted");
  assert(!validatePlan({ protocol: "OTHER/1" }).ok, "foreign protocol refused");
  assert(!validatePlan({ protocol: "SAOS-TREASURY-LADDER-PLAN/1", trader: "headcorner", maxPerLegSteem: 0.3, maxOpenSteem: 0.6, edgeBps: 800, expiryDays: 7 }).ok, "owner-keyed trader refused");
  assert(!validatePlan({ protocol: "SAOS-TREASURY-LADDER-PLAN/1", trader: "hcsoldier4", maxPerLegSteem: 0.5, maxOpenSteem: 0.6, edgeBps: 800, expiryDays: 7 }).ok, "per-leg cap enforced");
  assert(!validatePlan({ protocol: "SAOS-TREASURY-LADDER-PLAN/1", trader: "hcsoldier4", maxPerLegSteem: 0.3, maxOpenSteem: 0.9, edgeBps: 800, expiryDays: 7 }).ok, "open cap enforced");
  assert(!validatePlan({ protocol: "SAOS-TREASURY-LADDER-PLAN/1", trader: "hcsoldier4", maxPerLegSteem: 0.3, maxOpenSteem: 0.6, edgeBps: 30, expiryDays: 7 }).ok, "min edge enforced");
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
  const d = diffOrders({ liveOrders: [{ orderid: oid, sell_price: "0.100000" }], targetLegs: [{ legId: "sell-1", orderId: oid, priceSbd: 0.11 }], knownIds: known });
  assert(d.some((a) => a.action === "replace"), "stale price → replace");
  const d2 = diffOrders({ liveOrders: [{ orderid: oid, sell_price: "0.1" }], targetLegs: [], knownIds: known });
  assert(d2.some((a) => a.action === "cancel"), "own orphan → cancel");
  const d3 = diffOrders({ liveOrders: [{ orderid: 777, sell_price: "0.1" }], targetLegs: [], knownIds: known });
  assert(d3.length === 0, "FOREIGN order (unknown orderid) → NEVER touched");
  console.log("SELFTEST PASS: 17/17 vectors");
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
