// ZOMBIE-JANITOR (2026-11-01 · measured crisis: 60 open orders on the custody
// account, ~52.378 SBD locked = 79% of the treasury SBD, all placed 2026-10-29→10-31
// at prices 0.1007-0.1014 while the live market bids 0.1074 — out-of-touch dead capital.
// The 9-c law only PUBLISHED the zombies; nobody ever reclaimed them — the grid starved
// ("sell-side waiting for fuel: 0.000 STEEM commitable") while its own capital sat locked.
//
// WHAT CHANGES: the janitor is the reclaim arm of the same law. Three verdict classes,
// each measurable from chain facts alone:
//   DEDUP    — identical (sell, receive) placed multiple times (the measured triplet bug:
//              collapsed level spread fired 3 identical orders 3s apart). Keep the oldest,
//              cancel the rest. Freshness guard: only when the group's oldest is older
//              than dedupMinAgeHours OR all members are ledger-known — never grieves a
//              fresh parallel writer (R-GRID-WAR law preserved).
//   VALLEAK  — a bid priced ABOVE the value line (buying STEEM above measured value =
//              real bleed; the ladder law already forbids placing one — the janitor
//              also retires one that exists). Any age — it is wrong the moment it exists.
//   OUTTOUCH — older than staleMaxAgeHours AND drifted beyond staleDriftBps from the
//              price the CURRENT strategy actually wants (desiredBid/desiredAsk when the
//              caller derives them from the live law — value-line hug; else the raw touch).
//              Measured 2026-11-01: our stale bids @0.1013 sit 2.7% below the strategy's
//              desired 0.1040 (touch-hug ≤ valueLine) and 5.7% below the raw touch — the
//              market left them behind; they will never fill; their capital is hostage.
//              Cancel + reclaim so the CURRENT strategy deploys it.
// Bounded violence: at most maxCancelsPerBeat cancels per beat, priority DEDUP →
// VALLEAK → OUTTOUCH. Zero fabrication: every decision cites chain facts (age, price,
// touch, ledger membership) and every cancel is executed+logged by the caller with txid.
//
// Pure module — no network, no secrets. Caller (grid-beat.ts) owns execution.

export const JANITOR_DEFAULTS = {
  dedupMinAgeHours: 6,     // a parallel writer's fresh order is never deduped
  staleMaxAgeHours: 24,    // older than a day = not a live quote anymore
  staleDriftBps: 150,      // >1.5% away from the strategy's desired price = it would never place this today
                           // (measured 2026-11-01: stale bids @0.1013 sit 2.6% below the desired 0.1040)
  maxCancelsPerBeat: 12,   // bounded per beat; the next beat continues the sweep
};

const dp3 = (v) => Math.round(v * 1000) / 1000;

function amtOf(s) {
  const v = parseFloat(String(s ?? "").replace(/[A-Za-z ]+/g, ""));
  return Number.isFinite(v) ? v : 0;
}

/** order age in hours, chain `created` ("2026-10-29T08:19:03", UTC) */
export function ageHours(created, nowMs) {
  const t = Date.parse(String(created).length === 19 ? String(created) + "Z" : String(created));
  if (Number.isNaN(t)) return null;
  return (nowMs - t) / 3_600_000;
}

/** order price in SBD-per-STEEM (ask: receive/sell · bid: sell/receive) */
export function orderPrice(o) {
  const sell = amtOf(o.sell), recv = amtOf(o.receive);
  if (sell <= 0 || recv <= 0) return null;
  return o.sell.includes("STEEM") ? recv / sell : sell / recv;
}

/**
 * plan the janitor sweep.
 * @param {object} args
 * @param {Array<{id:number, sell:string, receive:string, created:string}>} args.openOrders — live chain snapshot
 * @param {Set<number>} args.ledgerKnownIds — order ids the local ledger claims
 * @param {number} args.nowMs
 * @param {number} args.valueLine — measured SBD-per-STEEM value line (N8)
 * @param {number|null} args.bestBid — live book touch
 * @param {number|null} args.bestAsk
 * @param {number|null} [args.desiredBid] — the price the CURRENT strategy wants to bid (touch-hug ≤ valueLine)
 * @param {number|null} [args.desiredAsk] — the price the CURRENT strategy wants to ask (value-line+step ≥ touch ≥ cost floor)
 * @param {object} [args.policy] — overrides of JANITOR_DEFAULTS
 * @returns {{cancels:Array<{id:number,why:string,cls:string,ageH:number|null,price:number|null}>, keepIds:number[], freedSellSbd:number, freedSellSteem:number, groups:Array<{key:string,count:number,keepId:number,ids:number[]}>}}
 */
export function planJanitor({ openOrders, ledgerKnownIds, nowMs, valueLine, bestBid, bestAsk, desiredBid, desiredAsk, policy }) {
  const P = { ...JANITOR_DEFAULTS, ...(policy ?? {}) };
  const known = ledgerKnownIds instanceof Set ? ledgerKnownIds : new Set(ledgerKnownIds ?? []);
  const orders = (openOrders ?? []).filter((o) => o && Number.isFinite(o.id));
  const verdict = [];

  // group by identical economic intent (same sell amount + same receive amount, 3dp)
  const groups = new Map();
  for (const o of orders) {
    const key = `${o.sell}|${dp3(amtOf(o.receive))}|${o.sell.includes("STEEM") ? "ASK" : "BID"}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }

  for (const [key, grp] of groups) {
    if (grp.length < 2) continue;
    grp.sort((a, b) => String(a.created).localeCompare(String(b.created)));
    const oldest = grp[0];
    const oldestAge = ageHours(oldest.created, nowMs);
    const allKnown = grp.every((o) => known.has(o.id));
    // freshness guard: our own bug pattern (all ledger-known) or an old echo — never a fresh foreign writer
    if (!(allKnown || (oldestAge != null && oldestAge >= P.dedupMinAgeHours))) continue;
    for (const dup of grp.slice(1)) {
      verdict.push({ id: dup.id, why: `DEDUP: identical intent with #${oldest.id} (${key}) — triplet capital lock`, cls: "DEDUP", ageH: ageHours(dup.created, nowMs), price: orderPrice(dup) });
    }
  }

  for (const o of orders) {
    if (verdict.some((v) => v.id === o.id)) continue;
    const px = orderPrice(o);
    const age = ageHours(o.created, nowMs);
    const isAsk = o.sell.includes("STEEM");
    if (!isAsk && px != null && valueLine > 0 && px > valueLine) {
      verdict.push({ id: o.id, why: `VALLEAK: bid @${px.toFixed(6)} buys STEEM above the value line ${valueLine.toFixed(6)} — real bleed`, cls: "VALLEAK", ageH: age, price: px });
      continue;
    }
    if (age != null && age >= P.staleMaxAgeHours) {
      // measure against the price the CURRENT strategy wants, not just the raw touch —
      // an old quote the strategy itself would no longer place is dead capital by definition
      const refBid = Number.isFinite(desiredBid) && desiredBid > 0 ? desiredBid : bestBid;
      const refAsk = Number.isFinite(desiredAsk) && desiredAsk > 0 ? desiredAsk : bestAsk;
      if (!isAsk && refBid && px != null && px < refBid * (1 - P.staleDriftBps / 10_000)) {
        verdict.push({ id: o.id, why: `OUTTOUCH: bid @${px.toFixed(6)} is ${(100 * (refBid - px) / refBid).toFixed(2)}% below the strategy's desired bid ${refBid.toFixed(6)} for ${age.toFixed(1)}h — dead capital, reclaiming`, cls: "OUTTOUCH", ageH: age, price: px });
      } else if (isAsk && refAsk && px != null && px > refAsk * (1 + P.staleDriftBps / 10_000)) {
        verdict.push({ id: o.id, why: `OUTTOUCH: ask @${px.toFixed(6)} is ${(100 * (px - refAsk) / refAsk).toFixed(2)}% above the strategy's desired ask ${refAsk.toFixed(6)} for ${age.toFixed(1)}h — dead capital, reclaiming`, cls: "OUTTOUCH", ageH: age, price: px });
      }
    }
  }

  const clsRank = { DEDUP: 0, VALLEAK: 1, OUTTOUCH: 2 };
  verdict.sort((a, b) => (clsRank[a.cls] - clsRank[b.cls]) || ((b.ageH ?? 0) - (a.ageH ?? 0)));
  const cancels = verdict.slice(0, P.maxCancelsPerBeat);
  const cancelIds = new Set(cancels.map((c) => c.id));
  const keepIds = orders.map((o) => o.id).filter((id) => !cancelIds.has(id));

  let freedSellSbd = 0, freedSellSteem = 0;
  for (const c of cancels) {
    const o = orders.find((x) => x.id === c.id);
    if (!o) continue;
    if (o.sell.includes("STEEM")) freedSellSteem += amtOf(o.sell);
    else freedSellSbd += amtOf(o.sell);
  }

  const groupRows = [];
  for (const [key, grp] of groups) {
    if (grp.length < 2) continue;
    groupRows.push({ key, count: grp.length, keepId: grp[0].id, ids: grp.map((g) => g.id) });
  }

  return { cancels, keepIds, freedSellSbd: dp3(freedSellSbd), freedSellSteem: dp3(freedSellSteem), groups: groupRows };
}

export default planJanitor;
