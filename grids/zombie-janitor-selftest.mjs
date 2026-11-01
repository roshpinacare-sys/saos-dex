// ZOMBIE-JANITOR SELFTEST — fixtures are the LIVE measured chain state of 2026-11-01:
// 60 open orders on the custody account (headcorner), 20 logical intents × 3 identical
// copies (the triplet bug), 52.378 SBD locked, market bestBid 0.107436 while our bids
// sit at 0.1007-0.1014. The janitor must reclaim the locks without touching a fresh
// foreign writer, without exceeding the per-beat cap, and without ever keeping a
// value-leaking bid.
import { planJanitor, ageHours, orderPrice, JANITOR_DEFAULTS } from "./zombie-janitor.mjs";

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`(pass) ${name}`); }
  catch (e) { fail++; console.error(`(FAIL) ${name}: ${e.message}`); }
}
function eq(a, b, msg) { if (Math.abs(a - b) > 1e-9) throw new Error(`${msg ?? "eq"}: ${a} != ${b}`); }
function ok(v, msg) { if (!v) throw new Error(msg ?? "assert failed"); }

// ── fixture: measured 2026-11-01T14:39Z from condenser_api.get_open_orders ──
const NOW = Date.parse("2026-11-01T14:39:00Z");
const mk = (id, sell, receive, created) => ({ id, sell, receive, created });
const triplet = (baseId, sell, receive, created) => [
  mk(baseId, sell, receive, created),
  mk(baseId + 25, sell, receive, plusSec(created, 3)),
  mk(baseId + 50, sell, receive, plusSec(created, 6)),
];
function plusSec(ts, s) { return new Date(Date.parse(ts + "Z") + s * 1000).toISOString().slice(0, 19); }

// 7 measured triplet intents (subset — the sweep is bounded per beat anyway)
const live = [
  ...triplet(2346095540, "1.066 SBD", "10.523 STEEM", "2026-10-29T08:19:03"),
  ...triplet(2346098852, "1.049 SBD", "10.355 STEEM", "2026-10-29T08:25:57"),
  ...triplet(2346105908, "1.058 SBD", "10.444 STEEM", "2026-10-29T08:40:39"),
  ...triplet(2346109700, "0.492 SBD", "4.855 STEEM", "2026-10-29T08:48:33"),
  ...triplet(2346203788, "1.231 SBD", "12.149 STEEM", "2026-10-29T12:04:33"),
  ...triplet(2346301844, "0.922 SBD", "9.101 STEEM", "2026-10-29T15:28:51"),
  ...triplet(2347680364, "0.967 SBD", "9.543 STEEM", "2026-10-31T15:20:45"),
  // a fresh foreign pair (placed 30min ago, ledger-unknown) — MUST survive
  mk(999000001, "0.500 SBD", "4.900 STEEM", "2026-11-01T14:09:00"),
  mk(999000002, "0.500 SBD", "4.900 STEEM", "2026-11-01T14:09:03"),
];
const ledgerKnown = new Set(); // the whole crisis: the ledger lost these runs

// value line measured 2026-11-01 (feed median 58494008.943 SBD / 562045946.729 STEEM)
const VALUE_LINE = 0.104073;
const BEST_BID = 0.107436;
const BEST_ASK = 0.107760;
// what the CURRENT strategy wants to bid (touch-hug ≤ valueLine, N8-b law):
const DESIRED_BID = Math.min(BEST_BID * (1 - 10 / 10_000), VALUE_LINE); // ≈ 0.104062
const DESIRED_ASK = Math.max(VALUE_LINE * (1 + 15 / 10_000), BEST_ASK);

t("ageHours parses chain timestamps (19-char, UTC)", () => {
  const h = ageHours("2026-10-29T08:19:03", NOW);
  ok(h > 78 && h < 79, `expected ~78.3h, got ${h}`);
});
t("orderPrice derives SBD-per-STEEM for both sides", () => {
  eq(orderPrice(mk(1, "1.066 SBD", "10.523 STEEM", "2026-10-29T08:19:03")), 1.066 / 10.523);
  eq(orderPrice(mk(2, "5.000 STEEM", "0.540 SBD", "2026-10-29T08:19:03")), 0.108);
});

t("DEDUP: every triplet collapses to its oldest member", () => {
  const plan = planJanitor({ openOrders: live, ledgerKnownIds: ledgerKnown, nowMs: NOW, valueLine: VALUE_LINE, bestBid: BEST_BID, bestAsk: BEST_ASK, desiredBid: DESIRED_BID, desiredAsk: DESIRED_ASK, policy: { maxCancelsPerBeat: 100 } });
  const dedup = plan.cancels.filter((c) => c.cls === "DEDUP");
  eq(dedup.length, 7 * 2, `expected 14 dedup cancels, got ${dedup.length}`);
  // the fresh foreign duplicate (age 0.5h, ledger-unknown) must be kept
  ok(plan.keepIds.includes(999000002), "fresh foreign duplicate was grieved — freshness guard broken");
  // the fresh foreign duplicate (age 0.5h, ledger-unknown) must be kept
  ok(plan.keepIds.includes(999000002), "fresh foreign duplicate was grieved — freshness guard broken");
});

t("full sweep: a dead-price triplet reclaims ALL its members (2 DEDUP + 1 OUTTOUCH)", () => {
  const plan = planJanitor({ openOrders: live, ledgerKnownIds: ledgerKnown, nowMs: NOW, valueLine: VALUE_LINE, bestBid: BEST_BID, bestAsk: BEST_ASK, desiredBid: DESIRED_BID, desiredAsk: DESIRED_ASK, policy: { maxCancelsPerBeat: 100 } });
  for (const base of [2346095540, 2346098852, 2346105908, 2346109700, 2346203788, 2346301844, 2347680364]) {
    const cls = plan.cancels.filter((x) => [base, base + 25, base + 50].includes(x.id)).map((x) => x.cls).sort();
    eq(cls.join(","), "DEDUP,DEDUP,OUTTOUCH", `triplet ${base} not fully reclaimed: ${cls}`);
  }
  // the oldest member is cancelled for the RIGHT reason: strategy-desired OUTTOUCH, not group affiliation
  ok(plan.cancels.some((x) => x.id === 2346095540 && x.cls === "OUTTOUCH"), "oldest member not OUTTOUCH-verdicted");
});

t("OUTTOUCH: stale bids below the strategy's desired price are reclaimed", () => {
  const plan = planJanitor({ openOrders: live, ledgerKnownIds: ledgerKnown, nowMs: NOW, valueLine: VALUE_LINE, bestBid: BEST_BID, bestAsk: BEST_ASK, desiredBid: DESIRED_BID, desiredAsk: DESIRED_ASK, policy: { maxCancelsPerBeat: 100 } });
  const out = plan.cancels.filter((c) => c.cls === "OUTTOUCH");
  ok(out.length > 0, "no stale out-of-touch bid was planned");
  for (const c of out) {
    ok(c.price < DESIRED_BID * (1 - JANITOR_DEFAULTS.staleDriftBps / 10_000), `OUTTOUCH on an in-strategy-band price ${c.price}`);
    ok(c.ageH >= 24, `OUTTOUCH on a fresh order (${c.ageH}h)`);
  }
});

t("bounded violence: cancels never exceed the per-beat cap", () => {
  const plan = planJanitor({ openOrders: live, ledgerKnownIds: ledgerKnown, nowMs: NOW, valueLine: VALUE_LINE, bestBid: BEST_BID, bestAsk: BEST_ASK, desiredBid: DESIRED_BID, desiredAsk: DESIRED_ASK });
  ok(plan.cancels.length <= JANITOR_DEFAULTS.maxCancelsPerBeat, `cap breached: ${plan.cancels.length}`);
  ok(plan.cancels.length === JANITOR_DEFAULTS.maxCancelsPerBeat, `sweep should saturate the cap on the measured crisis: ${plan.cancels.length}`);
});

t("sweep continuity: the next beat continues where the cap stopped", () => {
  const first = planJanitor({ openOrders: live, ledgerKnownIds: ledgerKnown, nowMs: NOW, valueLine: VALUE_LINE, bestBid: BEST_BID, bestAsk: BEST_ASK, desiredBid: DESIRED_BID, desiredAsk: DESIRED_ASK });
  const remaining = live.filter((o) => first.keepIds.includes(o.id));
  const second = planJanitor({ openOrders: remaining, ledgerKnownIds: ledgerKnown, nowMs: NOW, valueLine: VALUE_LINE, bestBid: BEST_BID, bestAsk: BEST_ASK, desiredBid: DESIRED_BID, desiredAsk: DESIRED_ASK });
  ok(second.cancels.length > 0, "second beat planned nothing — sweep stalled");
  // fresh foreign pair survives BOTH beats
  ok(second.keepIds.includes(999000001) && second.keepIds.includes(999000002), "fresh foreign writer grieved on a later beat");
});

t("VALLEAK: a bid above the value line dies regardless of age", () => {
  const leak = [mk(888000001, "1.000 SBD", "9.000 STEEM", "2026-11-01T14:00:00")]; // px 0.111 > valueLine
  const plan = planJanitor({ openOrders: leak, ledgerKnownIds: new Set(), nowMs: NOW, valueLine: VALUE_LINE, bestBid: BEST_BID, bestAsk: BEST_ASK, desiredBid: DESIRED_BID, desiredAsk: DESIRED_ASK });
  eq(plan.cancels.length, 1, "value-leak bid survived");
  eq(plan.cancels[0].cls, "VALLEAK");
});

t("freed capital is summed from cancelled sell amounts", () => {
  const plan = planJanitor({ openOrders: live, ledgerKnownIds: ledgerKnown, nowMs: NOW, valueLine: VALUE_LINE, bestBid: BEST_BID, bestAsk: BEST_ASK, desiredBid: DESIRED_BID, desiredAsk: DESIRED_ASK, policy: { maxCancelsPerBeat: 100 } });
  let sumSbd = 0;
  for (const c of plan.cancels) {
    const o = live.find((x) => x.id === c.id);
    if (o && o.sell.includes("SBD")) sumSbd += parseFloat(o.sell);
  }
  eq(plan.freedSellSbd, Math.round(sumSbd * 1000) / 1000);
  ok(plan.freedSellSbd > 0, "no SBD reclaim planned — the fuel crisis would persist");
});

t("zero-fabrication: an empty book yields an empty sweep, no throws", () => {
  const plan = planJanitor({ openOrders: [], ledgerKnownIds: new Set(), nowMs: NOW, valueLine: null, bestBid: null, bestAsk: null });
  eq(plan.cancels.length, 0);
  eq(plan.freedSellSbd, 0);
  eq(plan.freedSellSteem, 0);
});

t("patient in-touch bids are KEPT (no over-cancelling)", () => {
  // fresh bid INSIDE the strategy band (px 0.1000 ≤ desiredBid, <24h old): kept — no over-cancelling
  const patient = [mk(777000001, "1.000 SBD", "10.000 STEEM", "2026-11-01T13:00:00")]; // px 0.1000
  const plan = planJanitor({ openOrders: patient, ledgerKnownIds: new Set(), nowMs: NOW, valueLine: VALUE_LINE, bestBid: BEST_BID, bestAsk: BEST_ASK, desiredBid: DESIRED_BID, desiredAsk: DESIRED_ASK });
  eq(plan.cancels.length, 0, "a fresh in-band bid was killed");
});

console.log(`\nzombie-janitor selftest: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
