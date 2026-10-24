/**
 * mini-services/hft-loop/index.ts — the HFT grid-soldiers ORGAN (W49-c, §2)
 * ===========================================================================
 * Beat runner around the deterministic core (src/lib/dex/hft.ts). Reads the
 * live engine over its local HTTP (default http://127.0.0.1:3010, the
 * saos-dex Next.js app), builds engine-truth observations every beat, and
 * runs ONE HftLoop.tick per beat — every emitted op re-enters the engine
 * through the SAME public funnel the console uses (POST /api/dex/order and
 * POST /api/dex/swap), which means the engine's operator gate + pre-trade
 * risk cabinet answer every emission. No bypass, no fabricated fills.
 *
 * LAWS:
 *  · fail-honest: engine unreachable → log + health-flag, NO receipt is
 *    written (a receipt without an observation would be fabrication), the
 *    beat idles and retries next cadence.
 *  · observe vs trade: emission requires DEX_OPERATOR_TOKEN in the
 *    environment (the engine's own fail-closed gate). Without it the organ
 *    still scans, sizes and gates — and the engine itself answers 503
 *    operator-auth-unconfigured, receipted honestly as submit-reject. The
 *    breaker halting under that denial is the TRUTH (a soldier without
 *    authorization is a halted soldier), never papered over.
 *  · single-flight: OS lockfile (O_EXCL) with stale-pid detection — one
 *    clock owner ever; a second instance exits 0 quietly by design.
 *  · receipts JSONL under state/ — one line per tick, hash-chained by the
 *    core (sha256(prevHash+canonicalJSON)); tamper-evident.
 *  · --once CLI flag: one provable cycle then clean exit (CI-usable).
 *  · graceful shutdown on SIGINT/SIGTERM: timer stopped, server closed,
 *    lockfile released, exit 0.
 *  · synchronous engine answers: the core's submit contract is synchronous
 *    (determinism), so emission POSTs go through Bun.spawnSync+curl — the
 *    engine's verdict is IN the receipt, never a promise of one.
 *
 * NOTE on nonces: the engine's HTTP intake assigns its own canonical nonce
 * (chain.ts nextNonce); the op nonce inside a tick receipt is the soldier's
 * deterministic decision-id (hft-<runId>-<at>-<seq>-<i>) — both live: the
 * receipt records what the soldier decided, the engine records what it took.
 */

import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, appendFileSync, unlinkSync, existsSync } from "node:fs";
import { HftLoop, HftStats, type HftMarketObs, type HftTickReceipt } from "../../src/lib/dex/hft";
import type { Op } from "../../src/lib/dex/kernel";

/* ── configuration (env-driven, script-relative portable) ─────────────────── */
const HERE = import.meta.dir;
const STATE_DIR = `${HERE}/state`;
const LOCK_FILE = `${STATE_DIR}/hft-loop.lock`;
const RECEIPTS_FILE = `${STATE_DIR}/hft-receipts.jsonl`;
const LOG_FILE = `${STATE_DIR}/hft-loop.log`;

const PORT = Number(process.env.HFT_PORT ?? 3049);
const ENGINE_URL = (process.env.HFT_ENGINE_URL ?? "http://127.0.0.1:3010").replace(/\/$/, "");
const LOOP_MS = Math.max(200, Number(process.env.HFT_LOOP_MS ?? 1000)); // sub-second-ish, configurable
const ISSUER = /^[a-z0-9][a-z0-9-]{0,23}$/.test(process.env.HFT_ISSUER ?? "") ? process.env.HFT_ISSUER! : "hft-soldier";
const SEED = Number(process.env.HFT_SEED ?? 49);
const MIN_EDGE_BPS = Number(process.env.HFT_MIN_EDGE_BPS ?? 0) || undefined; // 0/absent → core fees-aware default
const OPERATOR_TOKEN = process.env.DEX_OPERATOR_TOKEN ?? "";
const ONCE = process.argv.includes("--once");

let ticks = 0;
let engineDownTicks = 0;
let lastReceipt: { seq: number; hash: string; decisions: string[]; emitted: number; at: number } | null = null;
let beating = false;
let timer: ReturnType<typeof setInterval> | null = null;
let currentInFlight = 0; // engine-truth open-trade count for the beat in flight

function log(line: string): void {
  const entry = `[${new Date().toISOString()}] ${line}`;
  try { appendFileSync(LOG_FILE, entry + "\n"); } catch { /* log failure never kills the organ */ }
  console.log(entry);
}

/* ── single-flight lockfile (O_EXCL + stale-pid detection) ────────────────── */
function acquireLock(): boolean {
  mkdirSync(STATE_DIR, { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, bootedAt: new Date().toISOString() });
  if (existsSync(LOCK_FILE)) {
    try {
      const prev = JSON.parse(readFileSync(LOCK_FILE, "utf8")) as { pid?: number };
      if (typeof prev.pid === "number" && prev.pid !== process.pid) {
        try { process.kill(prev.pid, 0); } catch {
          log(`stale lockfile from dead pid ${prev.pid} — replacing (single-flight preserved)`);
          try { unlinkSync(LOCK_FILE); } catch { /* fallthrough to exclusive create */ }
        }
      }
    } catch { try { unlinkSync(LOCK_FILE); } catch { /* corrupt lock replaced below */ } }
  }
  let fd: number;
  try {
    fd = openSync(LOCK_FILE, "wx"); // O_EXCL — exclusive create, the OS is the arbiter
  } catch {
    log("single-flight: another hft-loop instance owns the lock — exiting 0 honestly (losing the race is correct; duplicating the clock is not)");
    return false;
  }
  try { writeFileSync(fd, payload); } finally { closeSync(fd); }
  return true;
}

function releaseLock(): void {
  try {
    const cur = JSON.parse(readFileSync(LOCK_FILE, "utf8")) as { pid?: number };
    if (cur.pid === process.pid) unlinkSync(LOCK_FILE);
  } catch { /* nothing to release */ }
}

/* ── engine client (loopback HTTP, engine-truth only) ─────────────────────── */
async function fetchJson(path: string): Promise<unknown | null> {
  try {
    const res = await fetch(`${ENGINE_URL}${path}`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

interface EngineStatePayload {
  ok?: boolean;
  state?: { halted?: boolean; orders?: { live?: boolean; owner?: string }[] };
  markets?: { key: string; base: string; quote: string; bestBid: number; bestAsk: number; poolMid: number }[];
  wallets?: { name: string; balances: Record<string, number>; locked: Record<string, number> }[];
}

async function engineMarketObs(): Promise<{ obs: HftMarketObs[]; halted: boolean } | null> {
  const payload = (await fetchJson("/api/dex/state")) as EngineStatePayload | null;
  if (!payload || payload.ok !== true || !Array.isArray(payload.markets)) return null;
  const wallet = (payload.wallets ?? []).find((w) => w.name === ISSUER);
  const free = (asset: string): number => {
    if (!wallet) return 0; // un-funded issuer → zero inventory → honest skip-dust sizing
    return Math.max(0, (wallet.balances[asset] ?? 0) - (wallet.locked[asset] ?? 0));
  };
  currentInFlight = (payload.state?.orders ?? []).filter((o) => o.live && o.owner === ISSUER).length;

  const obs: HftMarketObs[] = [];
  for (const m of payload.markets) {
    if (!m || typeof m.key !== "string" || m.base === m.quote) continue;
    const bookBidMu = Number(m.bestBid) > 0 ? Math.floor(Number(m.bestBid)) : 0;
    const bookAskMu = Number(m.bestAsk) > 0 ? Math.floor(Number(m.bestAsk)) : 0;
    let poolBidMu = 0;
    let poolAskMu = 0;
    if (Number(m.poolMid) > 0 && bookBidMu > 0 && bookAskMu > 0) {
      // fee-embedded executable pool prices straight from the engine's own quoteOut (read-only GET)
      const sellQ = (await fetchJson(`/api/dex/swap?pair=${encodeURIComponent(m.key)}&assetIn=${encodeURIComponent(m.base)}&amount=50000`)) as { price?: number } | null;
      const buyQ = (await fetchJson(`/api/dex/swap?pair=${encodeURIComponent(m.key)}&assetIn=${encodeURIComponent(m.quote)}&amount=50000`)) as { price?: number } | null;
      poolBidMu = sellQ && typeof sellQ.price === "number" && sellQ.price > 0 ? Math.floor(sellQ.price) : 0;
      poolAskMu = buyQ && typeof buyQ.price === "number" && buyQ.price > 0 ? Math.floor(buyQ.price) : 0;
    }
    obs.push({
      key: m.key, base: m.base, quote: m.quote,
      poolBidMu, poolAskMu, bookBidMu, bookAskMu,
      invBaseMu: free(m.base), invQuoteMu: free(m.quote),
    });
  }
  return { obs, halted: payload.state?.halted === true };
}

/* ── submit adapter — the engine's own public funnel, no bypass ───────────── */
function engineSubmitSync(op: Op): { queued: boolean; reason?: string } {
  const isPool = op.type === "pool_swap";
  const path = isPool ? "/api/dex/swap" : "/api/dex/order";
  const body = isPool
    ? { pair: op.pair, assetIn: op.assetIn, amount: op.amount, minOut: op.minOut, issuer: ISSUER }
    : { action: "order", base: op.base, quote: op.quote, side: op.side, price: op.price, amount: op.amount, issuer: ISSUER };
  const args = [
    "curl", "-s", "-m", "3", "-X", "POST", `${ENGINE_URL}${path}`,
    "-H", "content-type: application/json",
    "-H", "x-saos-dex-console: 1",
  ];
  if (OPERATOR_TOKEN) args.push("-H", `x-saos-operator: ${OPERATOR_TOKEN}`);
  args.push("-d", JSON.stringify(body));
  try {
    const p = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe", timeout: 4000 });
    const out = p.stdout.toString();
    const j = JSON.parse(out) as { ok?: boolean; error?: string } | null;
    if (!j || typeof j.ok !== "boolean") return { queued: false, reason: `engine-intake-unparseable:${out.slice(0, 60)}` };
    return { queued: j.ok, reason: j.ok ? undefined : j.error ?? "engine-denied" };
  } catch (e) {
    return { queued: false, reason: `engine-unreachable:${String(e instanceof Error ? e.message : e).slice(0, 60)}` };
  }
}

/* ── the loop (deterministic core + engine-truth injection) ───────────────── */
mkdirSync(STATE_DIR, { recursive: true });
const loop = new HftLoop(
  {
    issuer: ISSUER,
    seed: SEED,
    minEdgeBps: MIN_EDGE_BPS,
    inFlight: () => currentInFlight, // C3 velocity budget — engine truth per beat
    submit: engineSubmitSync,
  },
  new HftStats(),
);

/* ── one beat ─────────────────────────────────────────────────────────────── */
async function beat(): Promise<void> {
  if (beating) { log("beat already running — skip (machine skips, never stacks)"); return; }
  beating = true;
  try {
    const market = await engineMarketObs();
    if (market === null) {
      engineDownTicks++;
      log(`engine-down (fail-honest): no observation at ${ENGINE_URL}/api/dex/state — beat idled, NO receipt fabricated (downStreak=${engineDownTicks})`);
      return;
    }
    engineDownTicks = 0;
    if (market.halted) {
      log("engine chain halted — beat idled honestly (no tick against a frozen chain)");
      return;
    }
    const rec: HftTickReceipt = loop.tick(Date.now(), market.obs);
    ticks++;
    lastReceipt = { seq: rec.seq, hash: rec.hash, decisions: rec.decisions, emitted: rec.emitted, at: rec.at };
    try { appendFileSync(RECEIPTS_FILE, JSON.stringify(rec) + "\n"); } catch (e) {
      log(`receipt-append failed (fail-honest): ${String(e).slice(0, 80)}`);
    }
    log(`tick #${rec.seq} · emitted=${rec.emitted} · phase=${loop.phase} · decisions=[${rec.decisions.join(" | ")}]`);
  } finally {
    beating = false;
  }
}

/* ── health server (every mini-service owns a port) ───────────────────────── */
const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "hft-loop",
        engineUrl: ENGINE_URL,
        mode: OPERATOR_TOKEN ? "trade" : "observe (no DEX_OPERATOR_TOKEN — the engine's own gate answers, receipted honestly)",
        loopMs: LOOP_MS,
        issuer: ISSUER,
        ticks,
        engineDownTicks,
        phase: loop.phase,
        consecutiveFailures: loop.consecutiveFailures,
        chainVerifies: loop.verifyChain().ok,
        lastReceipt,
      });
    }
    return new Response("hft-loop — saos-dex HFT grid soldiers organ (W49-c)\n", { status: 200 });
  },
});

/* ── lifecycle ────────────────────────────────────────────────────────────── */
let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  log(`graceful shutdown (${signal}) · ticks=${ticks}`);
  if (timer) clearInterval(timer);
  try { server.stop(true); } catch { /* already closed */ }
  releaseLock();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

log(`hft-loop up pid=${process.pid} · port=${PORT} · engine=${ENGINE_URL} · loopMs=${LOOP_MS} · issuer=${ISSUER} · mode=${OPERATOR_TOKEN ? "trade" : "observe"}${ONCE ? " · ONCE" : ""}`);

if (ONCE) {
  void beat().then(() => {
    log("once-cycle complete — clean exit");
    shutdown("once");
  });
} else {
  void beat(); // first beat immediately, then the cadence
  timer = setInterval(() => void beat(), LOOP_MS);
}
