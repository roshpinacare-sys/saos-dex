// soldier-loop.ts — SAOS-SOLDIER-BEAT/1 — per-soldier fleet beat: CURATION + GRID, hash-chained receipts
// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// Task 36-f (all-soldier parallel loops, cycle 36). One beat per account:
//   (a) CURATION — fresh top-post votes via the KEYLESS planner (grids/curate.mjs) + posting-authority
//       execution with that account's posting WIF (small weight, own daily cap). Reuses the proven
//       N2 broadcast-recovery law of executeVotes (duplicate → chain-inclusion recovery, ×4 backoff).
//   (b) GRID — ONE small maker order on the internal STEEM market (SBD:STEEM) via mover.signAndBroadcast,
//       behind the full house guard ladder, in order:
//         STASIS brake → key-gate (active-authority bit-vs-bit) → custody ban (army-ladder L92) →
//         dust law (grid-beat min levels) → grid-lane ownership (single-flight with local-beat-runner) →
//         policy gate (SAOS-POLICY-ENGINE/1, lane 'grid') → maker-only pricing → sign.
//
// SECRETS LAW (absolute): key material is loaded at RUNTIME from /home/z/.secrets/.env.local (0600) or the
//   process env. Never logged, never receipted, never printed. Receipts carry account names, tx ids,
//   public fingerprints and honest error strings only.
//
// KEY MAPPING LAW (same mapping the existing code uses — local-beat-once.sh / curate-beat.mjs):
//   headcorner   → STEEM_ACTIVE_WIF_A / STEEM_POSTING_WIF_A   (A-set; verified vs chain 2026-10-26:
//                  active pub STM5HhJD5WUX… = headcorner/active, posting pub STM8m3rBLd8CA2… = headcorner/posting)
//   saos-0001..4 → NO mapping — honest BLOCKER. The vault's B-set (STEEM_*_WIF_B) is UNBOUND: measured
//                  2026-10-26, its derived public fingerprints match NO on-chain authority across 20 fleet
//                  accounts — signing with a key you cannot bind to the account is forbidden (key-gate law).
//
// Receipts: grids/state/soldier-<account>.jsonl — {at, action, result, txId?, error?, detail?, prevSha, sha256}
//   prevSha = previous line's sha256 (GENESIS at file start); every beat is verifiable bit-vs-bit.
//
// Usage:
//   bun run grids/soldier-loop.ts <account> --once            # one beat
//   bun run grids/soldier-loop.ts <account> --once --dry      # guards + plan only, zero broadcast
//   bun run grids/soldier-loop.ts --selftest                  # offline vectors
import { readFileSync, existsSync, appendFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = "/home/z/.secrets/.env.local";
const SCHEMA = "SAOS-SOLDIER-BEAT/1";

/* ── key law: mapping + runtime loading (names only outside process memory) ─────────────────────────── */
const KEY_ENV_MAP: Record<string, { active: string; posting: string }> = {
  headcorner: { active: "STEEM_ACTIVE_WIF_A", posting: "STEEM_POSTING_WIF_A" },
};

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* absent → empty; callers fail-closed honestly */ }
  return out;
}

function loadWif(envName: string | undefined): string | null {
  if (!envName) return null;
  const fileEnv = parseEnvFile(ENV_FILE);
  const w = String(process.env[envName] ?? fileEnv[envName] ?? "").trim();
  // shape gate only (curate-beat pattern): a loaded WIF is 51 chars starting 5/6 — never echo it
  return w.length === 51 && (w[0] === "5" || w[0] === "6") ? w : null;
}

/* ── custody ban: parity-checked against the canonical army-ladder law (L92) ────────────────────────── */
export const CUSTODY_FORBIDDEN_TRADERS = ["headcorner", "cornerstone"];

function custodyBanParity(): { ok: boolean; onChainSet: string[]; err?: string } {
  try {
    const src = readFileSync(join(HERE, "army-ladder.mjs"), "utf8");
    const m = src.match(/FORBIDDEN_TRADERS\s*=\s*new Set\(\[([^\]]*)\]\)/);
    if (!m) return { ok: false, onChainSet: [], err: "FORBIDDEN_TRADERS not found in army-ladder.mjs" };
    const names = m[1].split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    const same = names.length === CUSTODY_FORBIDDEN_TRADERS.length && names.every(n => CUSTODY_FORBIDDEN_TRADERS.includes(n));
    return { ok: same, onChainSet: names, err: same ? undefined : `mismatch: army-ladder=${names.join("|")} vs soldier-loop=${CUSTODY_FORBIDDEN_TRADERS.join("|")}` };
  } catch (e) { return { ok: false, onChainSet: [], err: String(e?.message ?? e).slice(0, 120) }; }
}

/* ── hash-chained receipts ───────────────────────────────────────────────────────────────────────────── */
function receiptPath(account: string) { return join(HERE, "state", `soldier-${account}.jsonl`); }

function lastSha(account: string): string {
  try {
    const lines = readFileSync(receiptPath(account), "utf8").split("\n").filter(l => l.trim());
    if (!lines.length) return "GENESIS";
    const last = JSON.parse(lines[lines.length - 1]);
    return String(last.sha256 ?? "GENESIS");
  } catch { return "GENESIS"; }
}

export function appendReceipt(account: string, body: Record<string, unknown>): Record<string, unknown> {
  const at = new Date().toISOString();
  const prevSha = lastSha(account);
  const core = { schema: SCHEMA, account, at, ...body, prevSha };
  const sha256 = createHash("sha256").update(prevSha + "|" + JSON.stringify(core)).digest("hex");
  const rec = { ...core, sha256 };
  appendFileSync(receiptPath(account), JSON.stringify(rec) + "\n");
  return rec;
}

/* ── votes-per-day cap (house doctrine: small weight, capped count; N4 amp law respected) ────────────── */
function votesToday(account: string): number {
  try {
    const cutoff = Date.now() - 24 * 3600e3;
    let n = 0;
    for (const ln of readFileSync(receiptPath(account), "utf8").split("\n")) {
      if (!ln.trim()) continue;
      try {
        const r = JSON.parse(ln);
        if (r.action !== "curation" || r.result !== "VOTED") continue;
        if (Date.parse(r.at) >= cutoff) n += Array.isArray(r.votes) ? r.votes.length : 0;
      } catch { }
    }
    return n;
  } catch { return 0; }
}

/* ── posting-authority gate (same pattern as curate-beat.postingAuthorityOk) ─────────────────────────── */
async function postingAuthorityOk(account: string, wif: string): Promise<{ ok: boolean; pub: string | null; why?: string }> {
  const steem = (await import("steem")).default;
  let pub: string | null = null;
  try { pub = steem.auth.wifToPublic(wif); } catch { return { ok: false, pub: null, why: "WIF malformed — cannot derive public key" }; }
  const nodes = ["https://api.steemit.com", "https://api.justyy.com", "https://steem-rpc.publicnode.com"];
  for (const node of nodes) {
    try {
      const r = await fetch(node, { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(9000), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "condenser_api.get_accounts", params: [[account]] }) });
      const j = await r.json();
      const a = j?.result?.[0];
      if (!a) continue;
      const posting = typeof a.posting === "string" ? JSON.parse(a.posting) : a.posting;
      const pubs = (posting.key_auths ?? []).map((k: unknown[]) => String(k[0]));
      return { ok: pubs.includes(pub), pub, why: pubs.includes(pub) ? undefined : "derived posting key not in live posting authority (fail-closed)" };
    } catch { /* next node */ }
  }
  return { ok: false, pub, why: "all-rpc-nodes-failed" };
}

/* ── inventory (public chain read) ────────────────────────────────────────────────────────────────────── */
async function getBalances(account: string): Promise<{ steem: number; sbd: number; vp: number } | null> {
  const nodes = ["https://api.steemit.com", "https://api.justyy.com", "https://steem-rpc.publicnode.com"];
  for (const node of nodes) {
    try {
      const r = await fetch(node, { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(9000), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "condenser_api.get_accounts", params: [[account]] }) });
      const a = (await r.json())?.result?.[0];
      if (!a) continue;
      return { steem: parseFloat(a.balance), sbd: parseFloat(a.sbd_balance), vp: a.voting_power };
    } catch { /* next node */ }
  }
  return null;
}

/* ── dust law (grid-beat.ts constants, validated grid-params override) ───────────────────────────────── */
function dustLaw(): { minLevelSteem: number; minLevelSbd: number } {
  const defaults = { minLevelSteem: 1.0, minLevelSbd: 0.05 }; // grid-beat.ts MIN_LEVEL_STEEM / MIN_LEVEL_SBD
  try {
    const doc = JSON.parse(readFileSync(join(HERE, "state", "grid-params.json"), "utf8"));
    if (doc?.steem?.minLevelSteem != null) defaults.minLevelSteem = Number(doc.steem.minLevelSteem);
    if (doc?.steem?.minLevelSbd != null) defaults.minLevelSbd = Number(doc.steem.minLevelSbd);
  } catch { /* defaults are the measured law */ }
  return defaults;
}

/* ── grid-lane ownership: the headcorner grid lane is single-flight owned by local-beat-runner ───────── */
function gridLaneOwnedByRunner(account: string): boolean {
  const beatAccount = String(process.env.STEEM_ACCOUNT || "headcorner");
  if (account !== beatAccount) return false;
  try { if (!existsSync("/tmp/dex-beat.instance.lock")) return false; } catch { return false; }
  try {
    const out = execSync("pgrep -f local-beat-runner.sh || true", { encoding: "utf8" });
    return out.trim().length > 0;
  } catch { return false; }
}

/* ── CURATION lane ───────────────────────────────────────────────────────────────────────────────────── */
async function curationBeat(account: string, opts: { votesPerBeat: number; weightPct: number; dailyCap: number; dry: boolean }): Promise<Record<string, unknown>> {
  const postingWif = loadWif(KEY_ENV_MAP[account]?.posting);
  if (!postingWif) {
    return appendReceipt(account, { action: "curation", result: "BLOCKER-NO-POSTING-KEY", error: `no posting WIF env mapped for ${account} (KEY_ENV_MAP; B-set unbound — measured 2026-10-26) · fail-closed, zero fabrication` });
  }
  const gate = await postingAuthorityOk(account, postingWif);
  if (!gate.ok) {
    return appendReceipt(account, { action: "curation", result: "BLOCKER-KEY-GATE", error: gate.why ?? "posting authority mismatch", pub: gate.pub });
  }
  if (opts.dailyCap > 0) {
    const used = votesToday(account);
    if (used >= opts.dailyCap) {
      return appendReceipt(account, { action: "curation", result: "SKIP-DAILY-CAP", detail: `votes today=${used} ≥ cap ${opts.dailyCap} (small-weight doctrine; VP regen respected)` });
    }
  }
  const { planCurations, executeVotes } = await import("./curate.mjs");
  const plan = await planCurations({ account, dailyLimit: opts.votesPerBeat, maxWeightPct: opts.weightPct });
  if (!plan.votes.length) {
    return appendReceipt(account, { action: "curation", result: "NOTHING-TO-VOTE", detail: "planner found no fresh qualifying posts (age/engagement/topic filters)" });
  }
  if (opts.dry) {
    return appendReceipt(account, { action: "curation", result: "DRY-PLAN", detail: `planned=${plan.votes.length} (dry — zero broadcast)`, votes: plan.votes.map((v: { author: string; permlink: string; weightSteemUnits: number }) => ({ author: v.author, permlink: v.permlink, weight: v.weightSteemUnits })) });
  }
  try {
    const r = await executeVotes(plan, { wif: postingWif });
    return appendReceipt(account, {
      action: "curation", result: r.executed > 0 ? "VOTED" : "NOTHING-TO-VOTE", txId: r.txids[0]?.txid ?? undefined,
      votes: r.txids.map((t: { author: string; permlink: string; txid: string; weight: number; recovered: boolean }) => ({ author: t.author, permlink: t.permlink, txid: t.txid, weight: t.weight, recovered: t.recovered })),
    });
  } catch (e) {
    return appendReceipt(account, { action: "curation", result: "ERROR", error: String(e?.message ?? e).slice(0, 220) });
  }
}

/* ── GRID lane ───────────────────────────────────────────────────────────────────────────────────────── */
async function gridBeat(account: string, opts: { dry: boolean }): Promise<Record<string, unknown>> {
  const activeWif = loadWif(KEY_ENV_MAP[account]?.active);
  if (!activeWif) {
    return appendReceipt(account, { action: "grid", result: "BLOCKER-NO-ACTIVE-KEY", error: `no active WIF env mapped for ${account} (KEY_ENV_MAP; B-set unbound — measured 2026-10-26) · fail-closed, zero fabrication` });
  }
  const { activeAuthorityOk } = await import("./key-gate.mjs");
  const { rpcAny } = await import("./mover.mjs");
  const kg = await activeAuthorityOk({ account, wif: activeWif, rpc: (m: string, p: unknown[]) => rpcAny(m, p) });
  if (!kg.ok) {
    return appendReceipt(account, { action: "grid", result: "BLOCKER-KEY-GATE", error: kg.reason ?? "active authority mismatch", pub: kg.livePub ?? undefined });
  }
  const parity = custodyBanParity();
  if (!parity.ok) {
    return appendReceipt(account, { action: "grid", result: "ERROR", error: `custody-ban parity check failed: ${parity.err}` });
  }
  if (CUSTODY_FORBIDDEN_TRADERS.includes(account)) {
    return appendReceipt(account, { action: "grid", result: "BLOCKER-CUSTODY-BAN", error: `${account} is a forever-forbidden trader (army-ladder.mjs L92 FORBIDDEN_TRADERS — owner custody boundary; parity-verified in code) · refusal IS the law, not a failure` });
  }
  const bal = await getBalances(account);
  if (!bal) return appendReceipt(account, { action: "grid", result: "ERROR", error: "inventory unreadable (all rpc nodes failed)" });
  const dust = dustLaw();
  if (bal.steem < dust.minLevelSteem && bal.sbd < dust.minLevelSbd) {
    return appendReceipt(account, { action: "grid", result: "BLOCKER-BELOW-DUST", detail: `inventory ${bal.steem} STEEM / ${bal.sbd} SBD below grid-beat dust law (minLevelSteem=${dust.minLevelSteem}, minLevelSbd=${dust.minLevelSbd}) — placing dust orders is RC-burn noise` });
  }
  if (gridLaneOwnedByRunner(account)) {
    return appendReceipt(account, { action: "grid", result: "SKIP-GRID-LANE-OWNED", detail: `${account}'s grid lane is single-flight owned by local-beat-runner (flock /tmp/dex-beat.instance.lock) — a second signer would be cancelled by the next atomic refresh and burn RC; honest skip, no interference` });
  }
  const { stasisHalt } = await import("./brake.mjs");
  if (stasisHalt("soldier-loop")) {
    return appendReceipt(account, { action: "grid", result: "BLOCKER-STASIS", error: "STASIS capital gate active for lane grid (fail-closed)" });
  }
  /* maker leg — ONE small order, maker-only, policy-capped */
  const book = await rpcAny("condenser_api.get_order_book", [1]) as { bids?: { price: number }[]; asks?: { price: number }[] };
  const bestBid = Number(book?.bids?.[0]?.price ?? 0);
  const bestAsk = Number(book?.asks?.[0]?.price ?? 0);
  if (!(bestBid > 0) || !(bestAsk > 0) || bestAsk < bestBid) {
    return appendReceipt(account, { action: "grid", result: "ERROR", error: `book unmeasurable (bid=${bestBid} ask=${bestAsk}) — refuse to price blind` });
  }
  const POLICY_CAP_SBD = 25;      // policy.json lanes.grid.maxNotionalPerOpSbd
  const COMMIT_PCT = 0.9;         // grid-beat law: never commit >90% of inventory
  const STEP_BPS = 50;            // maker step off the touch
  const notionalSbd = Math.min(POLICY_CAP_SBD, Math.max(bal.steem * bestBid, bal.sbd) * COMMIT_PCT);
  const { policyGate } = await import("./policy.mjs");
  const gate = policyGate({ tool: "soldier-loop", lane: "grid", kind: "limit_order_create", account, opsEst: 1, notionalSbd } as never);
  if (gate?.verdict && gate.verdict !== "ALLOW") {
    return appendReceipt(account, { action: "grid", result: "BLOCKER-POLICY", error: `policy gate ${gate.verdict}: ${(gate.reasons ?? []).join(" | ").slice(0, 180)}` });
  }
  const day = new Date().toISOString().slice(0, 10);
  const orderId = parseInt(createHash("sha256").update(`soldier-loop:${account}:${day}`).digest("hex").slice(0, 8), 16) % 4294967295;
  const expiration = new Date(Date.now() + 27 * 86400e3).toISOString().slice(0, 19);
  const op = bal.sbd >= dust.minLevelSbd && bal.sbd >= bal.steem * bestBid
    ? (() => { // SELL SBD → STEEM at price ≥ bestAsk×(1+step) — maker above the touch (SBD per STEEM)
      const price = +(bestAsk * (1 + STEP_BPS / 10000)).toFixed(6);
      const sellSbd = +Math.min(bal.sbd * COMMIT_PCT, POLICY_CAP_SBD).toFixed(3);
      if (sellSbd < 0.001) return null;
      return ["limit_order_create", { owner: account, orderid: orderId, amount_to_sell: `${sellSbd.toFixed(3)} SBD`, min_to_receive: `${(sellSbd * price).toFixed(3)} STEEM`, fill_or_kill: false, expiration }] as unknown;
    })()
    : (() => { // BUY SBD with STEEM at price ≤ bestBid×(1−step) — maker below the touch
      const price = +(bestBid * (1 - STEP_BPS / 10000)).toFixed(6);
      const sellSteem = +Math.min(bal.steem * COMMIT_PCT, POLICY_CAP_SBD / price).toFixed(3);
      if (sellSteem < 0.001) return null;
      return ["limit_order_create", { owner: account, orderid: orderId, amount_to_sell: `${sellSteem.toFixed(3)} STEEM`, min_to_receive: `${(sellSteem * price).toFixed(3)} SBD`, fill_or_kill: false, expiration }] as unknown;
    })();
  if (!op) {
    return appendReceipt(account, { action: "grid", result: "BLOCKER-BELOW-DUST", detail: "post-rounding order size < 0.001 — dust law refuses" });
  }
  if (opts.dry) {
    return appendReceipt(account, { action: "grid", result: "DRY-PLAN", detail: `op=${JSON.stringify(op).slice(0, 160)} (dry — zero broadcast)`, notionalSbd: Math.round(notionalSbd * 1000) / 1000 });
  }
  const { signAndBroadcast } = await import("./mover.mjs");
  try {
    const r = await signAndBroadcast(activeWif, [op]);
    return appendReceipt(account, { action: "grid", result: "ORDER-PLACED", txId: r.txid, block: r.block ?? undefined, detail: JSON.stringify(op).slice(0, 160) });
  } catch (e) {
    return appendReceipt(account, { action: "grid", result: "ERROR", error: String(e?.message ?? e).slice(0, 220) });
  }
}

/* ── one beat ─────────────────────────────────────────────────────────────────────────────────────────── */
export async function beatOnce(account: string, opts: { votesPerBeat?: number; weightPct?: number; dailyCap?: number; dry?: boolean } = {}): Promise<{ account: string; results: Record<string, unknown>[] }> {
  const o = {
    votesPerBeat: opts.votesPerBeat ?? Number(process.env.SOLDIER_VOTES_PER_BEAT ?? 1),
    weightPct: opts.weightPct ?? Number(process.env.SOLDIER_VOTE_WEIGHT_PCT ?? 2),
    dailyCap: opts.dailyCap ?? Number(process.env.SOLDIER_VOTES_DAILY ?? 20),
    dry: opts.dry ?? false,
  };
  if (!KEY_ENV_MAP[account]) {
    const b = appendReceipt(account, { action: "boot", result: "BLOCKER-NO-KEY-MAPPING", error: `no key env mapping for ${account} (vault B-set unbound — derived fingerprints match no on-chain authority; measured 2026-10-26) · honest blocker, zero fabrication` });
    const c = await curationBeat(account, o);
    const g = await gridBeat(account, o);
    return { account, results: [b, c, g] };
  }
  const c = await curationBeat(account, o);
  const g = await gridBeat(account, o);
  return { account, results: [c, g] };
}

/* ── selftest (offline, deterministic — no network, no secrets) ──────────────────────────────────────── */
function selftest() {
  const A = (c: boolean, m: string) => { if (!c) { console.error("SELFTEST-FAIL:", m); process.exit(1); } };
  // 1. custody-ban parity with the canonical army-ladder law
  const parity = custodyBanParity();
  A(parity.ok, `custody ban parity: ${parity.err ?? "ok"}`);
  // 2. key mapping is exhaustive & names-only (no values in source)
  A(KEY_ENV_MAP.headcorner.active === "STEEM_ACTIVE_WIF_A" && KEY_ENV_MAP.headcorner.posting === "STEEM_POSTING_WIF_A", "headcorner maps to the A-set env names (same mapping as local-beat-once.sh)");
  const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
  A(!/STM[0-9a-zA-Z]{20,}/.test(src.replace(/STM5HhJD5WUX|STM8m3rBLd8CA2/g, "")), "no public keys beyond documented fingerprints in source");
  // 3. receipt chain: append → prevSha links (temp account name, real file under state/)
  const probe = `selftest-probe-${Date.now()}`;
  const r1 = appendReceipt(probe, { action: "selftest", result: "A" });
  const r2 = appendReceipt(probe, { action: "selftest", result: "B" });
  A(r2.prevSha === r1.sha256, "receipt chain links prev→sha256");
  // 4. hash determinism
  const h1 = createHash("sha256").update("x|{}").digest("hex");
  const h2 = createHash("sha256").update("x|{}").digest("hex");
  A(h1 === h2 && h1.length === 64, "sha256 chain deterministic 64-hex");
  // 5. dust law defaults match grid-beat measured law
  const d = dustLaw();
  A(d.minLevelSteem > 0 && d.minLevelSbd > 0, "dust law loads with positive floors");
  rmSync(receiptPath(probe));
  console.log("soldier-loop selftest OK (custody-parity, mapping, chain-link, determinism, dust-law)");
}

/* ── CLI ──────────────────────────────────────────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
if (argv.includes("--selftest")) {
  selftest();
} else {
  const account = argv.find(a => !a.startsWith("--"));
  if (!account) { console.error("usage: bun run grids/soldier-loop.ts <account> --once [--dry]"); process.exit(2); }
  try {
    const r = await beatOnce(account, { dry: argv.includes("--dry") });
    // summary only: results carry account/action/result/txId/error — never key material
    console.log(JSON.stringify(r.results.map(x => ({ action: x.action, result: x.result, txId: x.txId, error: x.error }))));
  } catch (e) {
    console.error(`[soldier-loop] fail-honest: ${String(e?.message ?? e).slice(0, 200)}`);
    process.exit(1);
  }
}
