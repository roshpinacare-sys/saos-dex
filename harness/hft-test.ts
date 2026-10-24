/**
 * harness/hft-test.ts — W49-c hft-grid-soldiers TDD proof (§2 MASTER DIRECTIVE)
 * ==============================================================================
 * Red-first harness for src/lib/dex/hft.ts (written BEFORE the implementation):
 *
 *   · Kelly sizing exact-fraction vectors (p=0.6/b=1.5 etc.), negative edge → 0,
 *     fractional-Kelly cap, µ-dust floor
 *   · seeded PRNG determinism
 *   · µ-unit micro-arb scanner: seeded profitable spread → correctly sized pair
 *     ops; sub-edge spread → no ops; executable-price integrity (pool bid<ask)
 *   · HFT loop state machine through the REAL pre-trade risk cabinet
 *     (risk.ts evaluatePreTrade — the same gate submitOp uses, no bypass):
 *     allow path hash-chained receipts, deny path receipted (C2 oversized
 *     notional), both-legs-or-nothing delta-neutrality, breaker halt/re-arm,
 *     max-ops-per-tick cap, inventory-cap conservation, byte-identical
 *     receipts for same seed + same clock
 *
 * Pure: zero network, zero DB (imports never touch chain.ts/Prisma).
 * Run: bun harness/hft-test.ts   (exit 0 = all green)
 */

import {
  KELLY_FRACTION,
  HFT_MAX_FRACTION,
  HFT_DUST_MU,
  HFT_MAX_OPS_PER_TICK,
  HFT_MIN_EDGE_BPS,
  mulberry32,
  kellyRawFraction,
  kellySizeMu,
  HftStats,
  scanArb,
  poolExecutableQuotes,
  bookTopOf,
  HftLoop,
  type HftMarketObs,
} from "../src/lib/dex/hft";
import { evaluatePreTrade } from "../src/lib/dex/risk";
import { canon } from "../src/lib/dex/canonical";
import { RAIL_DUST_MU, FEE_BPS, BOOK_TAKER_FEE_BPS } from "../src/lib/dex/kernel";
import type { Pool, DexState, Op } from "../src/lib/dex/kernel";

let pass = 0;
const fails: string[] = [];
function ok(name: string, cond: boolean): void {
  if (cond) pass++;
  else {
    fails.push(name);
    console.log(`FAIL ${name}`);
  }
}
function eq(name: string, got: unknown, want: unknown): void {
  ok(`${name} (got ${JSON.stringify(got)} want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want));
}

/* ── 1 · constants pinned ─────────────────────────────────────────────────── */
ok("1a KELLY_FRACTION=0.25 (fractional-Kelly cap)", KELLY_FRACTION === 0.25);
ok("1b HFT_MAX_FRACTION=0.5 (desk mandate kellyCap parity)", HFT_MAX_FRACTION === 0.5);
ok("1c HFT_MAX_OPS_PER_TICK=8", HFT_MAX_OPS_PER_TICK === 8);
ok("1d dust floor ≥ engine RAIL_DUST_MU", HFT_DUST_MU >= RAIL_DUST_MU);
eq("1e default min edge is fees-aware (pool 30 + book-taker 30 + 5)", HFT_MIN_EDGE_BPS, FEE_BPS + BOOK_TAKER_FEE_BPS + 5);

/* ── 2 · Kelly exact-fraction vectors ─────────────────────────────────────── */
// fStar(0.6, 1.5) = (0.6·2.5 − 1)/1.5 = 1/3 (exact float path identical to impl)
eq("2a kellyRawFraction(0.6,1.5)", kellyRawFraction(0.6, 1.5), (0.6 * (1.5 + 1) - 1) / 1.5);
eq("2b kellySizeMu p=0.6 b=1.5 equity=1_000_000 → floor(1e6/12)", kellySizeMu(0.6, 1.5, 1_000_000), 83_333);
eq("2c kellySizeMu p=0.55 b=2 equity=2_000_000 → floor(2e6·0.08125)", kellySizeMu(0.55, 2, 2_000_000), 162_500);
eq("2d kellySizeMu p=0.6 b=1.5 equity=8_000_000 → floor(8e6/12)", kellySizeMu(0.6, 1.5, 8_000_000), 666_666);
eq("2d' kellySizeMu p=0.9 b=2 equity=8_000_000 → floor(8e6·0.2125)", kellySizeMu(0.9, 2, 8_000_000), 1_700_000);

/* ── 3 · negative edge / bad inputs → 0 (never trade negative edge) ───────── */
eq("3a p=0.4 b=1.5 → fStar=0 → 0", kellySizeMu(0.4, 1.5, 1_000_000), 0);
eq("3b p=0.3 b=1.5 → fStar<0 → 0", kellySizeMu(0.3, 1.5, 1_000_000), 0);
eq("3c p=0 → 0", kellySizeMu(0, 1.5, 1_000_000), 0);
eq("3d b=0 → 0", kellySizeMu(0.6, 0, 1_000_000), 0);
eq("3e negative equity → 0", kellySizeMu(0.6, 1.5, -5), 0);
eq("3f NaN p → 0", kellySizeMu(NaN, 1.5, 1_000_000), 0);

/* ── 4 · fractional-Kelly cap respected ───────────────────────────────────── */
// raw 0.85 × 0.25 = 0.2125 unclamped; maxFraction 0.1 clamps → 100_000µ
eq("4a cap clamp to maxFraction", kellySizeMu(0.9, 2, 1_000_000, 0.1), 100_000);
eq("4b default cap HFT_MAX_FRACTION never exceeded", (() => {
  const s = kellySizeMu(0.999, 30, 10_000_000);
  return s <= Math.floor(10_000_000 * HFT_MAX_FRACTION) && s === Math.floor(10_000_000 * Math.min(((0.999 * 31 - 1) / 30) * KELLY_FRACTION, HFT_MAX_FRACTION));
})(), true);

/* ── 5 · dust floor (orders below dust rejected BEFORE emission) ──────────── */
eq("5a below dust → 0", kellySizeMu(0.6, 1.5, 11_999), 0);
eq("5b well below dust → 0", kellySizeMu(0.6, 1.5, 11_500), 0);
eq("5c above dust passes", kellySizeMu(0.6, 1.5, 12_001), 1_000);

/* ── 6 · seeded PRNG determinism ──────────────────────────────────────────── */
const rA = mulberry32(42), rB = mulberry32(42), rC = mulberry32(7);
const seqA = [rA(), rA(), rA(), rA(), rA()];
const seqB = [rB(), rB(), rB(), rB(), rB()];
const seqC = [rC(), rC(), rC(), rC(), rC()];
eq("6a same seed → identical stream", seqA, seqB);
ok("6b different seed → different stream", JSON.stringify(seqA) !== JSON.stringify(seqC));
ok("6c stream in [0,1)", seqA.every((v) => v >= 0 && v < 1));

/* ── 7 · executable AMM quotes (read-only amm.ts price fns) ───────────────── */
const POOL: Pool = {
  a: "WSTEEM", b: "USDS", ra: 10_000_000, rb: 54_000_000_000, lp: 1_000_000,
  feeAccruedTreasury: 0, swaps: 0,
};
const pq = poolExecutableQuotes(POOL, "WSTEEM", "USDS", 50_000);
ok("7a pool quotes exist", pq !== null);
if (pq) {
  ok("7b pool sell price (bid) below mid", pq.poolBidMu < 5_400_000 && pq.poolBidMu > 0);
  ok("7c pool buy price (ask) above mid", pq.poolAskMu > 5_400_000 && pq.poolAskMu > 0);
  ok("7d fee spread: bid < ask", pq.poolBidMu < pq.poolAskMu);
}
ok("7e dead pool → null", poolExecutableQuotes({ ...POOL, ra: 0 }, "WSTEEM", "USDS", 50_000) === null);

/* ── 8 · book top via read-only book.ts sortBook ──────────────────────────── */
const ST = {
  orders: [
    { seq: 1, id: 1, owner: "x", base: "WSTEEM", quote: "USDS", side: "buy", price: 5_390_000, amount: 5000, filled: 0, live: true, nonce: "n1", at: 0, lockMu: 0 },
    { seq: 2, id: 2, owner: "y", base: "WSTEEM", quote: "USDS", side: "buy", price: 5_395_000, amount: 5000, filled: 0, live: true, nonce: "n2", at: 0, lockMu: 0 },
    { seq: 3, id: 3, owner: "z", base: "WSTEEM", quote: "USDS", side: "sell", price: 5_410_000, amount: 5000, filled: 0, live: true, nonce: "n3", at: 0, lockMu: 0 },
    { seq: 4, id: 4, owner: "w", base: "WSTEEM", quote: "USDS", side: "sell", price: 5_405_000, amount: 5000, filled: 0, live: true, nonce: "n4", at: 0, lockMu: 0 },
  ],
} as unknown as DexState;
eq("8a bookTopOf best bid/ask", bookTopOf(ST, "WSTEEM", "USDS"), { bidMu: 5_395_000, askMu: 5_405_000 });
eq("8b empty book → zeros", bookTopOf({ orders: [] } as unknown as DexState, "WSTEEM", "USDS"), { bidMu: 0, askMu: 0 });

/* ── 9 · micro-arb scanner ────────────────────────────────────────────────── */
// Direction A: sell pool @5_500_000 / buy book @5_400_000 → floor(100_000·10⁴/5_400_000)=185bps
const sigA = scanArb({ poolBidMu: 5_500_000, poolAskMu: 5_505_000, bookBidMu: 5_395_000, bookAskMu: 5_400_000 }, 60);
ok("9a seeded profitable spread detected", sigA !== null);
if (sigA) {
  eq("9a.spread", sigA.spreadBps, 185);
  eq("9a.direction", sigA.direction, "pool-over-book");
  eq("9a.venues", [sigA.sellVenue, sigA.buyVenue], ["pool", "book"]);
  eq("9a.prices", [sigA.sellPriceMu, sigA.buyPriceMu], [5_500_000, 5_400_000]);
}
// Direction B: sell book @5_500_000 / buy pool @5_400_000
const sigB = scanArb({ poolBidMu: 5_395_000, poolAskMu: 5_400_000, bookBidMu: 5_500_000, bookAskMu: 5_505_000 }, 60);
ok("9b reverse direction detected", sigB !== null && sigB.direction === "book-over-pool" && sigB.spreadBps === 185);
// Sub-edge spread → no ops
eq("9c 18bps < 60bps minEdge → null", scanArb({ poolBidMu: 5_410_000, poolAskMu: 5_415_000, bookBidMu: 5_395_000, bookAskMu: 5_400_000 }, 60), null);
eq("9d missing leg → null", scanArb({ poolBidMu: 0, poolAskMu: 0, bookBidMu: 5_395_000, bookAskMu: 5_400_000 }, 60), null);

/* ── 10 · loop machinery — shared scenario builders ───────────────────────── */
// Market key m1: pool bid 550_000 / book ask 500_000 → 1000bps edge.
// Stats seeded to exactly p=0.6 (2W/1L Laplace) and b=1.5 (payoffMilli 1500 mean):
// kelly size for equity 8_000_000µ = floor(8e6·((0.6·2.5−1)/1.5)·0.25) = 666_666µ.
// Sell leg (pool, assetIn=base): floor(666_666·1000/550_000) = 1212 µ-base.
// Buy leg (book, price 500_000): floor(666_666·1000/500_000) = 1333 µ-base,
//   lock = floor(500_000·1333/1000) = 666_500µ ≤ C2 cap 1_500_000µ ✓
// Pool sell minOut: out=floor(1212·550_000/1000)=666_600 → floor(666_600·9900/10⁴)=659_934.
function seededStats(): HftStats {
  const s = new HftStats();
  s.recordFill(true, 1500);
  s.recordFill(true, 1500);
  s.recordFill(false, 1500);
  return s;
}
const M1 = (invBaseMu: number, invQuoteMu: number): HftMarketObs => ({
  key: "m1", base: "WSTEEM", quote: "USDS",
  poolBidMu: 550_000, poolAskMu: 551_000, bookBidMu: 499_000, bookAskMu: 500_000,
  invBaseMu, invQuoteMu,
});
const POOL_PAIR = "USDS/WSTEEM"; // poolKey sorts alphabetically, joins "/" (engine truth)

function makeLoop(opts: {
  submit?: (op: Op) => { queued: boolean; reason?: string };
  maxOps?: number; halt?: number; minEdge?: number; seed?: number;
}): { loop: HftLoop; submitted: Op[] } {
  const submitted: Op[] = [];
  const loop = new HftLoop({
    issuer: "hft-test",
    seed: opts.seed ?? 7,
    minEdgeBps: opts.minEdge ?? 60,
    maxOpsPerTick: opts.maxOps ?? 8,
    haltAfterConsecutive: opts.halt ?? 3,
    submit: opts.submit ?? ((op: Op) => {
      submitted.push(op);
      return { queued: true };
    }),
  }, seededStats());
  return { loop, submitted };
}

/* ── 11 · allow path: emission + hash-chained receipt ─────────────────────── */
{
  const { loop, submitted } = makeLoop({});
  const rec = loop.tick(1_000, [M1(10_000_000, 8_000_000)]);
  eq("11a exactly one pair emitted", submitted.length, 2);
  eq("11b receipt emitted count", rec.emitted, 2);
  eq("11c receipt ops recorded", rec.ops.length, 2);
  ok("11d sell leg is pool_swap on base", rec.ops[0]!.type === "pool_swap" && rec.ops[0]!.assetIn === "WSTEEM" && rec.ops[0]!.amount === 1212);
  eq("11e pool leg minOut (1% tolerance of 666_600)", rec.ops[0]!.minOut, 659_934);
  eq("11f pool leg pair canonical", rec.ops[0]!.pair, POOL_PAIR);
  ok("11g buy leg is limit order at book ask", rec.ops[1]!.type === "order" && rec.ops[1]!.side === "buy" && rec.ops[1]!.price === 500_000 && rec.ops[1]!.amount === 1333);
  ok("11h arb decision recorded with integer spread+size", rec.decisions.some((d) => d === "arb:m1:spread=1000:notional=666666"));
  eq("11i no denials — failures reset", loop.consecutiveFailures, 0);
  eq("11j phase running", loop.phase, "running");
  ok("11k receipt chain verifies", loop.verifyChain().ok);
  eq("11l receipt seq/prevHash genesis", [rec.seq, rec.prevHash], [1, null]);
  // nonces deterministic and namespaced
  ok("11m nonces hft-namespaced + unique", rec.ops.every((o) => String(o.nonce).startsWith("hft-")) && new Set(rec.ops.map((o) => o.nonce)).size === 2);
  // issuer carried
  ok("11n ops carry issuer", rec.ops.every((o) => o.issuer === "hft-test"));
}

/* ── 12 · gate parity: the loop uses THE engine cabinet (no bypass) ───────── */
{
  // Same-shaped oversized order op must fail C2 in the naked engine gate too.
  const big: Op = {
    type: "order", issuer: "hft-test", nonce: "n", base: "WSTEEM", quote: "USDS",
    side: "buy", price: 500_000, amount: 16_666, // notional 8_333_000µ > 1_500_000µ cap
  };
  const v = evaluatePreTrade(big, { inFlight: 0 });
  ok("12a engine gate denies oversized notional C2", v.allowed === false && v.fails[0] === "C2");
}

/* ── 13 · deny path: oversized notional → receipted denial, zero emission ─── */
{
  const { loop, submitted } = makeLoop({});
  // equity 100Mµ → kelly notional ≫ C2 cap 1.5Mµ → order leg denied C2
  const rec = loop.tick(2_000, [M1(10_000_000, 100_000_000)]);
  eq("13a zero emission on deny", submitted.length, 0);
  eq("13b emitted counter 0", rec.emitted, 0);
  ok("13c deny decision recorded", rec.decisions.some((d) => d === "deny:m1:C2"));
  eq("13d denied field carries reason", rec.denied, "C2");
  eq("13e breaker counter incremented", loop.consecutiveFailures, 1);
  ok("13f deny receipt chained too (cabinet law: allow AND deny receipted)", loop.verifyChain().ok && rec.ops.length === 0);
}

/* ── 14 · both-legs-or-nothing (delta-neutrality under partial denial) ────── */
{
  // Pool leg notional = amount (1212µ ≤ cap ✓) but order leg denied → NEITHER emitted
  const { loop, submitted } = makeLoop({});
  loop.tick(3_000, [M1(10_000_000, 100_000_000)]);
  const swapCount = submitted.filter((o) => o.type === "pool_swap").length;
  const orderCount = submitted.filter((o) => o.type === "order").length;
  eq("14a naked single leg never emitted", [swapCount, orderCount], [0, 0]);
}

/* ── 15 · circuit breaker: consecutive failures → halted, explicit re-arm ─── */
{
  const { loop, submitted } = makeLoop({ halt: 3 });
  loop.tick(100, [M1(10_000_000, 100_000_000)]); // deny 1
  loop.tick(200, [M1(10_000_000, 100_000_000)]); // deny 2
  loop.tick(300, [M1(10_000_000, 100_000_000)]); // deny 3 — threshold reached but not exceeded
  eq("15a not halted at threshold-equal", loop.phase, "running");
  const rec4 = loop.tick(400, [M1(10_000_000, 100_000_000)]); // deny 4 > 3 → halt
  eq("15b halted on threshold-exceeding tick", loop.phase, "halted");
  ok("15c halt decision receipted", rec4.decisions.some((d) => d.startsWith("halt:consecutive=")));
  const rec5 = loop.tick(500, [M1(10_000_000, 100_000_000)]);
  eq("15d halted tick emits nothing", [rec5.emitted, rec5.ops.length, submitted.length], [0, 0, 0]);
  ok("15e halted tick honestly receipted", rec5.decisions.includes("halted"));
  loop.rearm();
  eq("15f explicit re-arm restores running", loop.phase, "running");
  eq("15g re-arm resets failure counter", loop.consecutiveFailures, 0);
  const rec6 = loop.tick(600, [M1(100_000_000, 100_000_000)]);
  eq("15h post-rearm deny works again", rec6.denied, "C2");
}

/* ── 16 · max ops per tick cap (anti-runaway) ─────────────────────────────── */
{
  const { loop, submitted } = makeLoop({ maxOps: 2 });
  const rec = loop.tick(700, [M1(10_000_000, 8_000_000), M1(10_000_000, 8_000_000)]);
  eq("16a only cap-fitting pair emitted", submitted.length, 2);
  ok("16b cap decision recorded", rec.decisions.includes("cap-ops"));
  ok("16c ops never exceed cap", rec.ops.length <= 2);
}
{
  const { loop, submitted } = makeLoop({ maxOps: 3 }); // pair needs 2 slots; 1 leftover slot stays idle
  const rec = loop.tick(750, [M1(10_000_000, 8_000_000), M1(10_000_000, 8_000_000)]);
  eq("16d pairs-only law: 3 slots → 1 pair", submitted.length, 2);
  ok("16e ops ≤ cap", rec.ops.length <= 3);
}
{
  // Default cap 8 → 4 markets × 1 pair each = exactly 8 ops, cap binds cleanly.
  // Inventory tuned so every market's kelly pair clears dust AND the C2 cabinet:
  // equity 18Mµ → size floor(18e6/12)=1_499_999µ → buy lock 1_499_500µ ≤ 1_500_000µ ✓
  const { loop, submitted } = makeLoop({});
  const mkts = [1, 2, 3, 4].map((i) => ({ ...M1(100_000, 18_000_000), key: `m${i}` }));
  const rec = loop.tick(800, mkts);
  eq("16f default cap 8 ops", submitted.length, 8);
  eq("16g receipt ops 8", rec.ops.length, 8);
}

/* ── 17 · inventory-cap conservation ──────────────────────────────────────── */
{
  // Three markets trading the SAME assets (one shared account): in-tick
  // accounting must shrink later sizes and keep Σ emission inside the caps.
  const { loop, submitted } = makeLoop({});
  const rec = loop.tick(900, [M1(100_000, 8_000_000), { ...M1(100_000, 8_000_000), key: "m2" }, { ...M1(100_000, 8_000_000), key: "m3" }]);
  const soldBase = submitted.filter((o) => o.type === "pool_swap").reduce((s, o) => s + (o.amount ?? 0), 0);
  const boughtLock = submitted.filter((o) => o.type === "order").reduce((s, o) => s + Math.floor(((o.price ?? 0) * (o.amount ?? 0)) / 1000), 0);
  ok("17a Σ sold base ≤ inventory cap", soldBase <= 100_000);
  ok("17b Σ bought quote-lock ≤ inventory cap", boughtLock <= 8_000_000);
  ok("17c every emitted amount clears the dust floor", submitted.every((o) => (o.amount ?? 0) >= HFT_DUST_MU));
  const notionals = rec.decisions.filter((d) => d.startsWith("arb:")).map((d) => Number(d.split("notional=")[1]));
  ok("17d in-tick accounting shrinks later sizes", notionals.length === 3 && notionals[0]! > notionals[1]! && notionals[1]! > notionals[2]!);
  ok("17e chain verifies under multi-market tick", loop.verifyChain().ok);
  eq("17f three pairs emitted", submitted.length, 6);
}

/* ── 18 · dust rejection BEFORE emission ──────────────────────────────────── */
{
  const { loop, submitted } = makeLoop({});
  const rec = loop.tick(1_000_000, [M1(10_000_000, 1_000_000)]); // equity 1Mµ → size 83_333 → amounts < dust
  eq("18a zero emitted", submitted.length, 0);
  ok("18b skip-dust decision", rec.decisions.some((d) => d.startsWith("skip-dust:m1")));
  eq("18c dust skip is NOT a breaker failure", loop.consecutiveFailures, 0);
}

/* ── 19 · no-edge tick: neutral, receipted ────────────────────────────────── */
{
  const { loop, submitted } = makeLoop({});
  // 40bps edge < 60bps minEdge → scanner silent
  const rec = loop.tick(1_100_000, [{ ...M1(10_000_000, 8_000_000), poolBidMu: 502_000, poolAskMu: 503_000 }]);
  eq("19a below minEdge → no ops", submitted.length, 0);
  ok("19b no-edge decision", rec.decisions.includes("no-edge"));
  eq("19c failures unchanged", loop.consecutiveFailures, 0);
}

/* ── 20 · error tick: receipted, feeds breaker ────────────────────────────── */
{
  let boom = false;
  const submitted: Op[] = [];
  const loop = new HftLoop({
    issuer: "hft-test", seed: 7, minEdgeBps: 60, maxOpsPerTick: 8, haltAfterConsecutive: 3,
    inFlight: () => { if (boom) throw new Error("mempool-probe-down"); return 0; },
    submit: (op: Op) => { submitted.push(op); return { queued: true }; },
  }, seededStats());
  loop.tick(1_200_000, [M1(10_000_000, 8_000_000)]); // clean
  boom = true;
  const rec = loop.tick(1_300_000, [M1(10_000_000, 8_000_000)]);
  ok("20a error decision receipted", rec.decisions.some((d) => d.startsWith("error:")));
  eq("20b error increments breaker", loop.consecutiveFailures, 1);
  eq("20c no ops on error tick", rec.emitted, 0);
}

/* ── 21 · submit-adapter rejection is a receipted denial too ──────────────── */
{
  const loop = new HftLoop({
    issuer: "hft-test", seed: 7, minEdgeBps: 60, maxOpsPerTick: 8, haltAfterConsecutive: 3,
    submit: () => ({ queued: false, reason: "mempool-full" }),
  }, seededStats());
  const rec = loop.tick(1_400_000, [M1(10_000_000, 8_000_000)]);
  ok("21a submit-reject decision", rec.decisions.some((d) => d === "submit-reject:m1:mempool-full"));
  eq("21b denied carries engine reason", rec.denied, "mempool-full");
  eq("21c breaker fed by engine rejection", loop.consecutiveFailures, 1);
}

/* ── 22 · loop determinism: same seed + same clock → byte-identical receipts ─ */
{
  const script = (loop: HftLoop): string => {
    loop.tick(10, [M1(10_000_000, 8_000_000)]);
    loop.tick(20, [M1(10_000_000, 1_000_000)]);
    loop.tick(30, [{ ...M1(10_000_000, 100_000_000), key: "m2" }]);
    loop.tick(40, [M1(10_000_000, 8_000_000)]);
    return JSON.stringify(loop.receipts());
  };
  const l1 = makeLoop({ seed: 99 }).loop;
  const l2 = makeLoop({ seed: 99 }).loop;
  eq("22a byte-identical receipt streams", script(l1), script(l2));
  ok("22b both chains verify", l1.verifyChain().ok && l2.verifyChain().ok);
}

/* ── 23 · chain tamper-evidence ───────────────────────────────────────────── */
{
  const { loop } = makeLoop({});
  loop.tick(10, [M1(10_000_000, 8_000_000)]);
  loop.tick(20, [M1(10_000_000, 8_000_000)]);
  const tampered = loop.receipts();
  tampered[1]!.at = 99_999;
  const v = loop.verifyChain(tampered);
  ok("23a tamper located at exact index", v.ok === false && v.brokenAt === 1);
}

/* ── 24 · canonical discipline: receipts are canon()-safe (no floats) ─────── */
{
  const { loop } = makeLoop({});
  loop.tick(10, [M1(10_000_000, 8_000_000)]);
  loop.tick(20, [M1(10_000_000, 1_000_000)]);
  let canonSafe = true;
  for (const r of loop.receipts()) {
    try { canon(JSON.parse(JSON.stringify(r))); } catch { canonSafe = false; }
  }
  ok("24a every receipt canon()-round-trips", canonSafe);
}

console.log(`\n${pass}/${pass + fails.length} PASS${fails.length > 0 ? " — FAILURES: " + fails.join(", ") : ""}`);
process.exit(fails.length > 0 ? 1 : 0);
