/**
 * src/lib/dex/hft.ts — HFT grid soldiers (directive §2, claim W49-c)
 * ===================================================================
 * Continuous high-frequency market-making core: deterministic Kelly-criterion
 * sizing + µ-unit micro-arbitrage between the internal AMM pools and the
 * internal order book, with EVERY emitted op routed through the engine's
 * pre-trade risk cabinet (risk.ts evaluatePreTrade — the exact gate submitOp
 * calls; no bypass exists in this module) and a hash-chained per-tick receipt
 * trail (allow AND deny both receipted — the cabinet law).
 *
 * DETERMINISM: injected clock (tick `now` param), seeded PRNG (mulberry32),
 * integer-µ math. Same seed + same clock + same observations → byte-identical
 * receipt streams (proven in harness/hft-test.ts §22). Zero network, zero DB,
 * zero deps beyond the engine's own pure modules.
 *
 * LAWS:
 *   · Kelly-safe: fStar(p,b) = (p·(b+1)−1)/b, fractional-Kelly KELLY_FRACTION
 *     = 0.25 (quarter-Kelly — documented survival haircut, not full Kelly),
 *     clamped to [0, HFT_MAX_FRACTION] (desk mandate kellyCap=0.5 parity).
 *     Guards: p≤0 ‖ b≤0 ‖ fStar≤0 ‖ non-finite → size 0 — never trades a
 *     negative edge, never trades without evidence (empty stats → b=0 → 0).
 *   · Dust floor: orders below HFT_DUST_MU µ are rejected BEFORE emission
 *     (≥ engine RAIL_DUST_MU so the kernel never dust-retires our legs).
 *   · Delta-neutrality: an arb is emitted as a PAIR (sell-high leg + buy-low
 *     leg) or not at all — the cabinet denying one leg denies the pair.
 *   · Conservation: per-tick in-tick accounting across markets sharing an
 *     asset — emitted legs never exceed the measured inventory (obs caps).
 *   · Anti-runaway: max HFT_MAX_OPS_PER_TICK ops per tick; circuit breaker
 *     halts after consecutive denied/error ticks (explicit re-arm only).
 *   · canonicalJSON receipts: sorted keys, integers/strings only (canon()),
 *     hash = sha256(prevHash + canonicalJSON) — engine receipt style.
 *   · Clock-free sizing: stats are event-driven; `now` only stamps receipts
 *     and nonces (deterministically replayable inputs).
 */

import { canon, sha256 } from "./canonical";
import { evaluatePreTrade } from "./risk";
import { quoteOut } from "./amm";
import { sortBook } from "./book";
import { poolKey, FEE_BPS, BOOK_TAKER_FEE_BPS } from "./kernel";
import type { Op, Pool, DexState, Asset } from "./kernel";

/* ── constants (pinned by harness/hft-test.ts §1) ──────────────────────────── */

/** Fractional-Kelly haircut: deploy fStar × 0.25, never full Kelly. */
export const KELLY_FRACTION = 0.25;
/** Upper clamp on the deployed fraction — desk mandate kellyCap=0.5 parity (risk.ts MANDATE_SIG). */
export const HFT_MAX_FRACTION = 0.5;
/** Dust floor in µ — orders below this are rejected before emission. ≥ kernel RAIL_DUST_MU (300). */
export const HFT_DUST_MU = 1000;
/** Cold-start bootstrap size in µ (§1 anti-paralysis, trace 1a173c66121fa1f5): with ZERO
 * fill evidence the Kelly guard would refuse forever (b=0 → size 0 → no trades → no
 * evidence — a deadlock measured live 2026-10-25: 2976 ticks, emitted=0). Until the
 * first fill lands, a REAL arb signal (spread ≥ minEdge after fees — measured, not
 * assumed) sizes at this conservative fixed notional (≪ HFT_MAX_FRACTION of any
 * funded equity), receipted as `bootstrap-size:<market>:<µ>`. Evidence arrives →
 * Kelly takes over automatically. Never a bypass of the risk cabinet: every bootstrap
 * leg still passes evaluatePreTrade (C1–C4) and the engine's own operator funnel. */
export const HFT_BOOTSTRAP_SIZE_MU = 25_000;
/** Anti-runaway: max ops emitted per tick (each arb pair = 2 ops). */
export const HFT_MAX_OPS_PER_TICK = 8;
/** Default minimum edge in bps — fees-aware: pool leg 30bps (inside quoteOut) + book taker 30bps (in-kind, NOT inside maker price) + 5bps buffer. */
export const HFT_MIN_EDGE_BPS = FEE_BPS + BOOK_TAKER_FEE_BPS + 5;
/** Circuit breaker: strictly more than this many consecutive denied/error ticks → halted. */
export const HFT_HALT_THRESHOLD = 3;
/** Slippage tolerance for pool-leg minOut derivation (1% — mirrors amm.ts passive default). */
export const HFT_SLIPPAGE_TOL_BPS = 100;
/** Probe size (µ) for read-only executable pool quotes via amm.ts quoteOut. */
export const HFT_POOL_PROBE_MU = 50_000;

/* ── deterministic primitives ─────────────────────────────────────────────── */

/** mulberry32 — tiny seeded PRNG (deterministic, no deps). Used for the
 * per-loop run-id (nonce namespace) and deterministic tie-breaking when
 * several markets show the exact same spread. Never used for sizing. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ── Kelly sizing (deterministic, integer µ) ──────────────────────────────── */

/** Raw Kelly fraction fStar(p,b) = (p·(b+1)−1)/b. No guards here — see kellySizeMu. */
export function kellyRawFraction(p: number, b: number): number {
  return (p * (b + 1) - 1) / b;
}

/**
 * Kelly-safe integer size in µ.
 *   raw   = fStar(p, b)
 *   frac  = clamp(raw · KELLY_FRACTION, 0, maxFraction)
 *   size  = floor(equityMu · frac), then 0 if size < HFT_DUST_MU.
 * Guards: non-finite/p≤0/b≤0/equity≤0/raw≤0 → 0 (never trade a negative edge;
 * empty stats give b=0 → 0 — no evidence, no trade).
 */
export function kellySizeMu(p: number, b: number, equityMu: number, maxFraction: number = HFT_MAX_FRACTION): number {
  if (!Number.isFinite(p) || !Number.isFinite(b) || !Number.isFinite(equityMu)) return 0;
  if (p <= 0 || b <= 0 || equityMu <= 0) return 0;
  const raw = kellyRawFraction(p, b);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const frac = Math.min(Math.max(raw * KELLY_FRACTION, 0), maxFraction);
  const size = Math.floor(equityMu * frac);
  if (size < HFT_DUST_MU) return 0; // dust floor — rejected before emission
  return size;
}

/* ── rolling fill/spread stats (deterministic, integer bookkeeping) ───────── */

/**
 * Rolling fill + spread statistics feeding the Kelly inputs.
 *  · winProb   = Laplace-smoothed win rate (wins+1)/(fills+2) — never 0/1 extremes.
 *  · winLossRatio = mean observed payoff ratio (payoffMilli = win/loss ×1000,
 *    integer). 0 fills → 0 → kelly guard → size 0 (no evidence, no trade).
 *  · spreadEwmaBps = integer EWMA (÷10 decay) of observed arb spreads.
 */
export class HftStats {
  private wins = 0;
  private losses = 0;
  private payoffSumMilli = 0;
  private spreadEwma = 0;

  recordFill(won: boolean, payoffMilli = 1000): void {
    if (won) this.wins++;
    else this.losses++;
    if (Number.isFinite(payoffMilli) && payoffMilli > 0) this.payoffSumMilli += Math.floor(payoffMilli);
  }

  recordSpread(bps: number): void {
    if (!Number.isFinite(bps) || bps < 0) return;
    this.spreadEwma = Math.floor((this.spreadEwma * 9 + Math.floor(bps)) / 10);
  }

  winProb(): number {
    return (this.wins + 1) / (this.wins + this.losses + 2);
  }

  winLossRatio(): number {
    const n = this.wins + this.losses;
    return n > 0 ? this.payoffSumMilli / n / 1000 : 0;
  }

  spreadEwmaBps(): number {
    return this.spreadEwma;
  }

  fillCount(): number {
    return this.wins + this.losses;
  }
}

/* ── µ-unit micro-arb scanner (read-only engine price fns) ────────────────── */

export interface ArbQuote {
  /** Executable sell-into-pool price (µ-quote per 1 base unit) — organ derives via amm.ts quoteOut. 0 = absent. */
  poolBidMu?: number;
  /** Executable buy-from-pool price (µ-quote per 1 base unit). 0 = absent. */
  poolAskMu?: number;
  /** Best book bid (µ-quote per 1 base unit) — organ derives via book.ts sortBook. 0 = absent. */
  bookBidMu?: number;
  /** Best book ask. 0 = absent. */
  bookAskMu?: number;
}

export interface ArbSignal {
  direction: "pool-over-book" | "book-over-pool";
  spreadBps: number;
  sellVenue: "pool" | "book";
  buyVenue: "book" | "pool";
  sellPriceMu: number;
  buyPriceMu: number;
}

/**
 * Pure scanner: computes both crossing edges in bps from EXECUTABLE prices
 * (pool prices must already embed the AMM fee — quoteOut does; book maker
 * prices do NOT embed the taker fee, which is why the default minEdgeBps is
 * fees-aware). Returns the best strictly-profitable signal or null.
 */
export function scanArb(q: ArbQuote, minEdgeBps: number): ArbSignal | null {
  const poolBid = q.poolBidMu ?? 0;
  const poolAsk = q.poolAskMu ?? 0;
  const bookBid = q.bookBidMu ?? 0;
  const bookAsk = q.bookAskMu ?? 0;
  let best: ArbSignal | null = null;
  // A — sell into the pool, buy off the book
  if (poolBid > 0 && bookAsk > 0 && poolBid > bookAsk) {
    const edge = Math.floor(((poolBid - bookAsk) * 10_000) / bookAsk);
    if (edge > minEdgeBps) {
      best = { direction: "pool-over-book", spreadBps: edge, sellVenue: "pool", buyVenue: "book", sellPriceMu: poolBid, buyPriceMu: bookAsk };
    }
  }
  // B — sell onto the book, buy from the pool
  if (bookBid > 0 && poolAsk > 0 && bookBid > poolAsk) {
    const edge = Math.floor(((bookBid - poolAsk) * 10_000) / poolAsk);
    if (edge > minEdgeBps && (best === null || edge > best.spreadBps)) {
      best = { direction: "book-over-pool", spreadBps: edge, sellVenue: "book", buyVenue: "pool", sellPriceMu: bookBid, buyPriceMu: poolAsk };
    }
  }
  return best;
}

/** Read-only executable pool quotes via amm.ts quoteOut (fee-embedded, probe-sized). */
export function poolExecutableQuotes(p: Pool, base: string, quote: string, probeMu: number = HFT_POOL_PROBE_MU): { poolBidMu: number; poolAskMu: number } | null {
  const sell = quoteOut(p, base, probeMu); // sell base → price µ-quote/base (bid side)
  const buy = quoteOut(p, quote, probeMu); // buy base with quote → price µ-quote/base (ask side)
  if (!sell || !buy || sell.price <= 0 || buy.price <= 0) return null;
  return { poolBidMu: sell.price, poolAskMu: buy.price };
}

/** Read-only book top via book.ts sortBook (price-time priority). */
export function bookTopOf(st: DexState, base: string, quote: string): { bidMu: number; askMu: number } {
  const bid = sortBook(st, base, quote, "buy")[0]?.price ?? 0;
  const ask = sortBook(st, base, quote, "sell")[0]?.price ?? 0;
  return { bidMu: bid, askMu: ask };
}

/* ── HFT loop state machine ───────────────────────────────────────────────── */

export interface HftMarketObs {
  key: string;
  base: string;
  quote: string;
  poolBidMu?: number;
  poolAskMu?: number;
  bookBidMu?: number;
  bookAskMu?: number;
  /** Measured FREE inventory (µ) of each asset for the issuer — engine truth, organ-measured. */
  invBaseMu: number;
  invQuoteMu: number;
}

export type HftSubmitResult = { queued: boolean; reason?: string };
export type HftSubmit = (op: Op) => HftSubmitResult;

export interface HftLoopConfig {
  issuer: string;
  seed: number;
  minEdgeBps?: number;
  maxOpsPerTick?: number;
  haltAfterConsecutive?: number;
  /** minOut tolerance for pool legs (bps). Default HFT_SLIPPAGE_TOL_BPS. */
  slippageTolBps?: number;
  /** Cold-start fixed notional (µ) while the stats hold zero fills. 0 disables. Default HFT_BOOTSTRAP_SIZE_MU. */
  bootstrapSizeMu?: number;
  /** Open-trade count for the cabinet's C3 velocity budget — organ wires the engine's mempool count. */
  inFlight?: () => number;
  /** The engine funnel: production wires submitOp (chain.ts) or the HTTP order/swap routes; tests inject a recorder. */
  submit: HftSubmit;
}

export type HftPhase = "running" | "halted";

export interface HftTickReceipt {
  seq: number;
  at: number;
  phase: HftPhase;
  decisions: string[];
  ops: Op[];
  emitted: number;
  denied: string | null;
  prevHash: string | null;
  hash: string;
}

const GENESIS_PREV = "GENESIS";

export class HftLoop {
  phase: HftPhase = "running";
  consecutiveFailures = 0;
  readonly stats: HftStats;
  private readonly cfg: Required<Pick<HftLoopConfig, "issuer" | "seed" | "minEdgeBps" | "maxOpsPerTick" | "haltAfterConsecutive" | "slippageTolBps" | "bootstrapSizeMu" | "submit">> &
    Pick<HftLoopConfig, "inFlight">;
  private readonly prng: () => number;
  private readonly runId: string;
  private readonly chain: HftTickReceipt[] = [];
  private seq = 0;

  constructor(cfg: HftLoopConfig, stats: HftStats = new HftStats()) {
    if (typeof cfg.issuer !== "string" || cfg.issuer.length === 0) throw new Error("hft: issuer required");
    if (typeof cfg.submit !== "function") throw new Error("hft: submit adapter required");
    this.cfg = {
      issuer: cfg.issuer,
      seed: cfg.seed >>> 0,
      minEdgeBps: cfg.minEdgeBps ?? HFT_MIN_EDGE_BPS,
      maxOpsPerTick: cfg.maxOpsPerTick ?? HFT_MAX_OPS_PER_TICK,
      haltAfterConsecutive: cfg.haltAfterConsecutive ?? HFT_HALT_THRESHOLD,
      slippageTolBps: cfg.slippageTolBps ?? HFT_SLIPPAGE_TOL_BPS,
      bootstrapSizeMu: Math.max(0, Math.floor(cfg.bootstrapSizeMu ?? HFT_BOOTSTRAP_SIZE_MU)),
      inFlight: cfg.inFlight,
      submit: cfg.submit,
    };
    this.stats = stats;
    this.prng = mulberry32(this.cfg.seed);
    this.runId = Math.floor(this.prng() * 0xffffffff).toString(16);
  }

  /** Explicit re-arm after a halt — the breaker never self-heals. */
  rearm(): void {
    this.phase = "running";
    this.consecutiveFailures = 0;
  }

  receipts(): HftTickReceipt[] {
    return JSON.parse(JSON.stringify(this.chain)) as HftTickReceipt[];
  }

  /** Zero-trust verification: per-row hash recomputation + prevHash linkage + seq monotonicity. */
  verifyChain(chain: HftTickReceipt[] = this.receipts()): { ok: boolean; brokenAt: number | null } {
    let prev: HftTickReceipt | null = null;
    for (let i = 0; i < chain.length; i++) {
      const r = chain[i]!;
      const { hash, ...body } = r;
      if (typeof hash !== "string" || hash !== this.receiptHash(body)) return { ok: false, brokenAt: i };
      const wantPrev = prev ? prev.hash : null;
      if (body.prevHash !== wantPrev) return { ok: false, brokenAt: i };
      if (prev && !(body.seq > prev.seq)) return { ok: false, brokenAt: i };
      prev = r;
    }
    return { ok: true, brokenAt: null };
  }

  private receiptHash(body: Omit<HftTickReceipt, "hash">): string {
    return sha256((body.prevHash ?? GENESIS_PREV) + canon(body));
  }

  private pushReceipt(at: number, decisions: string[], ops: Op[], emitted: number, denied: string | null): HftTickReceipt {
    this.seq += 1;
    const prevHash = this.chain.length > 0 ? this.chain[this.chain.length - 1]!.hash : null;
    const body = {
      seq: this.seq,
      at,
      phase: this.phase,
      decisions,
      ops,
      emitted,
      denied,
      prevHash,
    };
    const rec: HftTickReceipt = { ...body, hash: this.receiptHash(body) };
    this.chain.push(rec);
    return JSON.parse(JSON.stringify(rec)) as HftTickReceipt;
  }

  private nonce(at: number, i: number): string {
    return `hft-${this.runId}-${at}-${this.seq + 1}-${i}`;
  }

  /**
   * One HFT tick: observe (markets param — the organ's engine-truth snapshot)
   * → size (kelly from rolling stats) → gate (risk.ts evaluatePreTrade — the
   * engine's own cabinet) → emit via the injected submit funnel → receipt.
   * Denials, rejections, dust skips, errors and halts are ALL receipted.
   */
  tick(now: number, markets: HftMarketObs[]): HftTickReceipt {
    const decisions: string[] = [];
    const emittedOps: Op[] = [];
    let emitted = 0;
    let denied: string | null = null;

    if (this.phase === "halted") {
      return this.pushReceipt(now, ["halted"], [], 0, null);
    }

    try {
      // Observe → scan all markets. PRNG provides deterministic tie-breaking
      // among equal spreads (seeded shuffle before the stable spread sort).
      const signals: { m: HftMarketObs; sig: ArbSignal }[] = [];
      for (const m of markets) {
        const sig = scanArb({ poolBidMu: m.poolBidMu, poolAskMu: m.poolAskMu, bookBidMu: m.bookBidMu, bookAskMu: m.bookAskMu }, this.cfg.minEdgeBps);
        if (sig) signals.push({ m, sig });
      }
      const shuffled = signals.map((s) => ({ s, r: this.prng() }));
      shuffled.sort((a, b) => b.s.sig.spreadBps - a.s.sig.spreadBps || a.r - b.r);
      // Per-asset in-tick consumption (markets may share the issuer's account).
      const usedBase = new Map<string, number>();
      const usedQuote = new Map<string, number>();

      const p = this.stats.winProb();
      const b = this.stats.winLossRatio();
      let capped = false;

      for (const { s: { m, sig } } of shuffled) {
        if (emittedOps.length + 2 > this.cfg.maxOpsPerTick) {
          capped = true; // a pair needs 2 slots — pairs-only law leaves odd slots idle
          break;
        }
        const availBase = Math.max(0, Math.floor(m.invBaseMu) - (usedBase.get(m.base) ?? 0));
        const availQuote = Math.max(0, Math.floor(m.invQuoteMu) - (usedQuote.get(m.quote) ?? 0));
        const baseValueMu = Math.floor((availBase * sig.sellPriceMu) / 1000);
        const equityMu = Math.min(availQuote, baseValueMu);
        const size0 = kellySizeMu(p, b, equityMu);
        let size: number;
        if (size0 > 0) {
          size = size0;
        } else if (this.stats.fillCount() === 0 && this.cfg.bootstrapSizeMu > 0) {
          // §1 anti-paralysis bootstrap (trace 1a173c66121fa1f5): a live arb signal with
          // zero fill history — Kelly's b=0 guard would freeze the loop forever. Size the
          // FIRST trades at the conservative fixed notional, receipted. Still gated by
          // evaluatePreTrade + the engine funnel below; evidence → Kelly resumes.
          size = Math.min(this.cfg.bootstrapSizeMu, equityMu);
          if (size < HFT_DUST_MU) {
            decisions.push(`skip-dust:${m.key}`);
            continue;
          }
        } else {
          decisions.push(`skip-dust:${m.key}`); // kelly guard or dust floor — never trade negative/no evidence
          continue;
        }

        // µ amounts per leg from the SAME kelly notional (pair stays ≈neutral).
        let sellAmtMu = Math.floor((size * 1000) / sig.sellPriceMu); // µ-base
        let buyAmtMu = Math.floor((size * 1000) / sig.buyPriceMu); // µ-base
        let buyQuoteMu = size; // pool buy spends quote µ directly

        // Inventory clamps (conservation law).
        sellAmtMu = Math.min(sellAmtMu, availBase);
        if (sig.buyVenue === "book") {
          const lock = Math.floor((sig.buyPriceMu * buyAmtMu) / 1000);
          if (lock > availQuote) {
            buyAmtMu = Math.floor((availQuote * 1000) / sig.buyPriceMu);
          }
        } else if (buyQuoteMu > availQuote) {
          buyQuoteMu = availQuote;
        }

        // Dust gate on FINAL amounts — rejected before emission.
        const sellFinal = sig.buyVenue === "pool" && sig.sellVenue === "pool" ? sellAmtMu : sellAmtMu;
        const buyFinal = sig.buyVenue === "book" ? buyAmtMu : buyQuoteMu;
        if (sellFinal < HFT_DUST_MU || buyFinal < HFT_DUST_MU) {
          decisions.push(`skip-dust:${m.key}`);
          continue;
        }

        const tol = this.cfg.slippageTolBps;
        const minOutFrom = (expectedOutMu: number): number => Math.max(1, Math.floor((expectedOutMu * (10_000 - tol)) / 10_000));

        let sellOp: Op;
        if (sig.sellVenue === "pool") {
          sellOp = {
            type: "pool_swap",
            issuer: this.cfg.issuer,
            nonce: this.nonce(now, emittedOps.length),
            pair: poolKey(m.base as Asset, m.quote as Asset),
            assetIn: m.base as Asset,
            amount: sellAmtMu,
            minOut: minOutFrom(Math.floor((sellAmtMu * sig.sellPriceMu) / 1000)),
          };
        } else {
          sellOp = {
            type: "order",
            issuer: this.cfg.issuer,
            nonce: this.nonce(now, emittedOps.length),
            base: m.base as Asset,
            quote: m.quote as Asset,
            side: "sell",
            price: sig.sellPriceMu,
            amount: sellAmtMu,
          };
        }
        let buyOp: Op;
        if (sig.buyVenue === "book") {
          buyOp = {
            type: "order",
            issuer: this.cfg.issuer,
            nonce: this.nonce(now, emittedOps.length + 1),
            base: m.base as Asset,
            quote: m.quote as Asset,
            side: "buy",
            price: sig.buyPriceMu,
            amount: buyAmtMu,
          };
        } else {
          buyOp = {
            type: "pool_swap",
            issuer: this.cfg.issuer,
            nonce: this.nonce(now, emittedOps.length + 1),
            pair: poolKey(m.base as Asset, m.quote as Asset),
            assetIn: m.quote as Asset,
            amount: buyQuoteMu,
            minOut: minOutFrom(Math.floor((buyQuoteMu * 1000) / sig.buyPriceMu)),
          };
        }

        // THE GATE — same evaluatePreTrade the engine's submitOp calls. Both
        // legs evaluated BEFORE any emission: one deny denies the pair
        // (delta-neutrality; no naked legs).
        const inFlight = this.cfg.inFlight ? this.cfg.inFlight() : 0;
        const vSell = evaluatePreTrade(sellOp, { inFlight });
        const vBuy = evaluatePreTrade(buyOp, { inFlight });
        const fail = !vSell.allowed ? vSell.fails[0] ?? "denied" : !vBuy.allowed ? vBuy.fails[0] ?? "denied" : null;
        if (fail !== null) {
          decisions.push(`deny:${m.key}:${fail}`);
          denied = fail;
          this.consecutiveFailures++;
          continue;
        }

        // Emit through the same funnel the engine exposes.
        let pairOk = 0;
        for (const op of [sellOp, buyOp]) {
          const res = this.cfg.submit(op);
          if (!res.queued) {
            const reason = res.reason ?? "denied";
            decisions.push(`submit-reject:${m.key}:${reason}`);
            denied = reason;
            this.consecutiveFailures++;
            break;
          }
          emittedOps.push(op);
          emitted++;
          pairOk++;
        }
        if (pairOk === 2) {
          decisions.push(`arb:${m.key}:spread=${sig.spreadBps}:notional=${size}${size0 <= 0 ? ":bootstrap" : ""}`);
          this.consecutiveFailures = 0;
          this.stats.recordSpread(sig.spreadBps);
          if (sig.sellVenue === "pool" || sig.sellVenue === "book") {
            usedBase.set(m.base, (usedBase.get(m.base) ?? 0) + sellAmtMu);
          }
          if (sig.buyVenue === "book") {
            usedQuote.set(m.quote, (usedQuote.get(m.quote) ?? 0) + Math.floor((sig.buyPriceMu * buyAmtMu) / 1000));
          } else {
            usedQuote.set(m.quote, (usedQuote.get(m.quote) ?? 0) + buyQuoteMu);
          }
        }
      }

      if (decisions.length === 0) decisions.push("no-edge");
      if (capped) decisions.push("cap-ops");
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e).slice(0, 120);
      decisions.push(`error:${msg}`);
      denied = msg;
      this.consecutiveFailures++;
    }

    // Circuit breaker — honest halt, explicit re-arm only.
    if (this.consecutiveFailures > this.cfg.haltAfterConsecutive) {
      this.phase = "halted";
      decisions.push(`halt:consecutive=${this.consecutiveFailures}`);
    }

    return this.pushReceipt(now, decisions, emittedOps, emitted, denied);
  }
}
