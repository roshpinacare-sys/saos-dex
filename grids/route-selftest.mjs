/**
 * route-selftest.mjs — שער-ברזל למנוע-נתיבי-ההמרה (route-graph.mjs).
 * דטרמיניסטי לגמרי — אפס-רשת: כל-הקלטות fixtures סינתטיים-מסומנים + נתוני-עומק מוקלטים.
 * כיסוי: בריכה (x·y=k + עמלה) · ספר-פנימי (µ→float, מיון-צדדים) · דלת-1:1 ·
 * עומק-ספר-חוץ · k-נתיבים-טובים (מדורג, רב-קפיצה) · מעגל-ארביטראז שנבנה-במתכוון ·
 * אין-שקר-שלילי (שוק-נקי → אפס-מעגלים) · fail-closed skips · realness=הרגל-החלשה ·
 * determinism (ביט-ביט). אפס-תלות; רץ על node טהור.
 */

import { buildRouteGraph, bestRoutes, arbCandidates, quotePool, quoteBook, quoteEdge, buildRouteMap, HUB_QUERIES } from "./route-graph.mjs";

let pass = 0, fail = 0;
const ok = (cond, name, extra = "") => {
  if (cond) { pass++; console.log(`  ok ${name}`); }
  else { fail++; console.error(`FAIL ${name} ${extra}`); }
};

/* ── fixtures סינתטיים-מסומנים ─────────────────────────────────────────────────────────────────────── */
const POOLS = [
  // SAOS/USDS: 1 SAOS ≈ 1.017 USDS (ra=98.78M µ-SAOS? לא — הערכים כאן יחידות-אנושיות של-מקור-אמת)
  { key: "SAOS/USDS", a: "SAOS", b: "USDS", ra: 98_781_685, rb: 100_566_281, feeBps: 30, realness: "ONCHAIN_REAL" },
  { key: "USDS/WSTEEM", a: "USDS", b: "WSTEEM", ra: 449_373, rb: 9_169_764, feeBps: 88, realness: "ONCHAIN_REAL" },
  { key: "USDS/WSBD", a: "USDS", b: "WSBD", ra: 11_937, rb: 1, feeBps: 1404, realness: "ONCHAIN_REAL" }, // כמעט-מתה — חייבת-להיכשל-בציטוט-עומק-גדול
];
const ORDERS = [
  // הספר-הפנימי: SAOS/USDS — prices ב-µ (1001 = 1.001 USDS/SAOS)
  { base: "SAOS", quote: "USDS", side: "buy", price: 1001, amount: 10000, filled: 24, live: true, owner: "yarden" },
  { base: "SAOS", quote: "USDS", side: "buy", price: 1001, amount: 10000, filled: 0, live: true, owner: "tamar" },
  { base: "SAOS", quote: "USDS", side: "sell", price: 1020, amount: 5000, filled: 0, live: true, owner: "aluf" },
  { base: "SAOS", quote: "USDS", side: "buy", price: 990, amount: 2000, filled: 0, live: false, owner: "dead" }, // לא-חי — חייב-להיפסח
];
const DOORS = [
  { from: "STEEM", to: "WSTEEM", rate: 1, feeBps: 0, realness: "DOOR_MEASURED", venue: "wrap-door", note: "wrap_mint/wrap_burn 1:1 אפס-עמלה (kernel)" },
  { from: "SBD", to: "WSBD", rate: 1, feeBps: 0, realness: "DOOR_MEASURED", venue: "wrap-door" },
];
const EXTBOOK = [{
  pair: "WSTEEM/USDT", venue: "steem-market-proxy", realness: "L2_REAL", feeBps: 0,
  bids: [{ price: 0.0491, qty: 400 }, { price: 0.0490, qty: 600 }],
  asks: [{ price: 0.0495, qty: 500 }, { price: 0.0496, qty: 800 }],
}];
const REFS = [{ pair: "WSTEEM/USDT", rate: 0.0492, venue: "oracle-median", realness: "REF" }, { pair: "USDT/USDS", rate: 1, venue: "canonical-parity", realness: "REF" }];

/* ── 1. בריכה ───────────────────────────────────────────────────────────────────────────────────────── */
console.log("[1] pool quotes");
const p1 = quotePool(POOLS[0], "SAOS", 1000);
ok(p1 && p1.out > 0 && p1.out < 1000 * 1.02 && p1.out > 1000 * 1.0, "pool SAOS→USDS out in-band", JSON.stringify(p1));
ok(p1.feeBps === 30, "pool fee=30 carried");
const pRev = quotePool(POOLS[0], "USDS", 1017);
ok(pRev && pRev.out > 900 && pRev.out < 1017, "pool reverse USDS→SAOS", JSON.stringify(pRev));
ok(quotePool(POOLS[2], "USDS", 100) === null || quotePool(POOLS[2], "USDS", 100).out < 100, "near-dead pool cannot mint value", JSON.stringify(quotePool(POOLS[2], "USDS", 100)));

/* ── 2. ספר-פנימי ───────────────────────────────────────────────────────────────────────────────────── */
console.log("[2] internal book");
const g = buildRouteGraph({ pools: POOLS, orders: ORDERS, doors: DOORS, extBooks: EXTBOOK, refs: REFS, skips: [] });
const inner = g.book["SAOS/USDS"];
ok(inner && inner.bids.length === 1 && inner.asks.length === 1, "live orders grouped+aggregated, dead skipped", JSON.stringify(g.book["SAOS/USDS"]));
ok(inner.bids[0].price === 1.001 && inner.bids[0].qty === 19976, "µ→float conversion + same-price aggregation", JSON.stringify(inner.bids[0]));
ok(inner.bids.length === 1 || inner.bids[0].price > inner.bids[1].price, "bids sorted best-first");

/* ── 3. דלתות ───────────────────────────────────────────────────────────────────────────────────────── */
console.log("[3] doors");
const door = g.edges.find((e) => e.kind === "DOOR");
ok(door && door.from === "STEEM" && door.to === "WSTEEM", "door edge built");
const dq = quoteEdge(door, 10, "fwd");
ok(dq && dq.out === 10 && dq.feeBps === 0, "wrap door 1:1 zero-fee", JSON.stringify(dq));

/* ── 4. עומק-ספר-חוץ ───────────────────────────────────────────────────────────────────────────────── */
console.log("[4] external book depth");
const sell100 = quoteBook(EXTBOOK[0].bids, 100, "sell");
ok(sell100 && Math.abs(sell100.out - (100 * 0.0491)) < 1e-9, "sell 100 hits best bid fully", JSON.stringify(sell100));
const sell1000 = quoteBook(EXTBOOK[0].bids, 1000, "sell");
ok(sell1000 && Math.abs(sell1000.out - (400 * 0.0491 + 600 * 0.0490)) < 1e-9, "depth walk across levels", JSON.stringify(sell1000));
const sell2000 = quoteBook(EXTBOOK[0].bids, 2000, "sell");
ok(sell2000 && sell2000.unfilled === 1000, "over-depth leaves honest unfilled", JSON.stringify(sell2000));

/* ── 5. נתיבים-טובים ───────────────────────────────────────────────────────────────────────────────── */
console.log("[5] best routes");
const r1 = bestRoutes(g, "STEEM", "USDS", 100, { maxHops: 4, k: 5 });
ok(r1.length >= 1, "STEEM→USDS has a route", JSON.stringify(r1[0] ?? null));
ok(r1[0].legs[0].venue === "wrap-door", "first leg is the wrap door", JSON.stringify(r1[0]?.legs));
ok(r1[0].realness === "ONCHAIN_REAL" || r1[0].realness === "DOOR_MEASURED" || r1[0].realness === "L2_REAL", "realness carried");
const rHive = bestRoutes(g, "HIVE", "USDS", 100);
ok(rHive.length === 0, "no fabricated path for unconnected asset (fail-closed)");
const rSaos = bestRoutes(g, "SAOS", "USDS", 5000, { k: 5 });
ok(rSaos.length >= 2, "multiple SAOS→USDS venues (pool + book)", JSON.stringify(rSaos.map((r) => r.legs.map((l) => l.venue))));
ok(rSaos[0].amountOut >= rSaos[1].amountOut - 1e-9, "ranked by out");

/* ── 6. ארביטראז — מעגל-מזויף-חייב-להימצא, שוק-נקי-חייב-להיות-ריק ───────────────────────────────────── */
console.log("[6] arb detection");
// מעגל-מזויף: ספר-חוץ שמתאר WSTEEM ב-0.0495 (asks) מול-בריכה שנותנת ~0.0491 → קנה-בריכה מכור-בספר?
// מעגל-מזויף: דלת STEEM→WSTEEM 1:1 + בריכת WSTEEM/USDS ב-~0.0492 + ספר STEEM/USDS שמתאר STEEM ב-0.5
const arbGraph = buildRouteGraph({
  pools: [{ key: "USDS/WSTEEM", a: "USDS", b: "WSTEEM", ra: 1_000_000, rb: 49_200, feeBps: 10, realness: "ONCHAIN_REAL" }], // 1 WSTEEM = 0.492 USDS
  doors: [{ from: "STEEM", to: "WSTEEM", rate: 1, feeBps: 0, realness: "DOOR_MEASURED" }],
  extBooks: [{ pair: "STEEM/USDS", venue: "synthetic-fixture", realness: "L2_REAL", feeBps: 0, bids: [{ price: 0.5, qty: 1000 }], asks: [{ price: 0.501, qty: 1000 }] }], // STEEM = 0.5 USDS
  refs: [], skips: [],
});
const cycles = arbCandidates(arbGraph, { maxCycleLen: 3 });
ok(cycles.length >= 1, "planted arbitrage cycle found", JSON.stringify(cycles[0] ?? null));
ok(cycles[0].profitBps > 0 && cycles[0].executable === true, "cycle positive + executable", `profitBps=${cycles[0]?.profitBps}`);
// שוק-נקי: אותו-מחיר בכל-מקום → אין-מעגל
const cleanGraph = buildRouteGraph({
  pools: [{ key: "USDS/WSTEEM", a: "USDS", b: "WSTEEM", ra: 1_000_000, rb: 49_000, feeBps: 0, realness: "ONCHAIN_REAL" }],
  extBooks: [{ pair: "STEEM/USDT", venue: "clean", realness: "L2_REAL", feeBps: 0, bids: [{ price: 0.049, qty: 1000 }], asks: [{ price: 0.049, qty: 1000 }] }],
  doors: [{ from: "STEEM", to: "WSTEEM", rate: 1, feeBps: 0, realness: "DOOR_MEASURED" }],
  refs: [], skips: [],
});
const cleanCycles = arbCandidates(cleanGraph, { maxCycleLen: 3 });
ok(cleanCycles.length === 0, "clean market yields zero false cycles", JSON.stringify(cleanCycles));

/* ── 7. fail-closed skips ───────────────────────────────────────────────────────────────────────────── */
console.log("[7] fail-closed");
const gSkip = buildRouteGraph({ pools: [{ key: "DEAD/X", a: "DEAD", b: "X", ra: 0, rb: 0 }], doors: [{ from: "", to: "X" }], extBooks: [{ pair: "Y/Z" }], refs: [{ pair: "NO/RATE", rate: 0 }], skips: [] });
ok(gSkip.skips.length >= 4, "every invalid source becomes an honest skip", JSON.stringify(gSkip.skips));
ok(!gSkip.edges.some((e) => e.kind === "POOL" && e.from === "DEAD"), "dead pool not in edges");

/* ── 8. realness=הרגל-החלשה + חוק-REF ──────────────────────────────────────────────────────────────── */
console.log("[8] realness + REF law");
const refGraph = buildRouteGraph({ refs: [{ pair: "SAOS/USDS", rate: 1.017, venue: "oracle" }], pools: POOLS, doors: [], extBooks: [], skips: [] });
const refRoutes = bestRoutes(refGraph, "SAOS", "USDS", 100);
ok(refRoutes.length >= 1 && refRoutes.every((r) => !r.legs.some((l) => l.kind === "REF")), "REF edges NEVER route legs (sanity-only)", JSON.stringify(refRoutes.map((r) => r.legs.map((l) => l.kind))));
ok(refRoutes[0].realness === "ONCHAIN_REAL", "executable realness carried");

/* ── 9. buildRouteMap + דטרמיניזם ──────────────────────────────────────────────────────────────────── */
console.log("[9] route map + determinism");
const now = 1793000000000;
const map1 = buildRouteMap({ pools: POOLS, orders: ORDERS, doors: DOORS, extBooks: EXTBOOK, refs: REFS, skips: [] }, { now, amountIn: 100 });
const map2 = buildRouteMap({ pools: POOLS, orders: ORDERS, doors: DOORS, extBooks: EXTBOOK, refs: REFS, skips: [] }, { now, amountIn: 100 });
ok(map1.schema === "SAOS-ROUTE-MAP/1", "schema stamped");
ok(map1.routes.length === HUB_QUERIES.length, `all ${HUB_QUERIES.length} hub queries answered`);
ok(map1.routes.filter((r) => r.verdict === "ROUTED").length >= 3, "hub routes actually found", JSON.stringify(map1.routes.filter((r) => r.verdict === "ROUTED").map((r) => `${r.from}->${r.to}`)));
ok(JSON.stringify(map1) === JSON.stringify(map2), "bit-for-bit determinism");
ok(map1.skips.length === 0, "clean inputs → zero skips");

/* ── summary ────────────────────────────────────────────────────────────────────────────────────────── */
console.log(`\nroute-selftest: ${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
