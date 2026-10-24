/**
 * harness/htlc-test.ts — W49-b HTLC bridge verification battery
 * ==============================================================
 * Deterministic, offline (fixed height clock, seeded LCG — zero Math.random,
 * zero Date.now in the vectors; the only wall clock is the throwaway db path
 * of the risk-gate section, mirroring harness/risk-gate-test.ts).
 *
 * Proves the W49-b delta over the landed §7.2 core (src/lib/dex/htlc.ts):
 *   A  lifecycle + gas discipline      (create→claim, GAS_TABLE pinned)
 *   B  refusal walls                   (typed denials, zero state/gas/nonce touch)
 *   C  refund-after-expiry exactness   (escrow returned to the µ)
 *   D  batch atomicity                 (one bad htlc sub-op denies the whole
 *                                       batch — nothing applied, no receipts)
 *   E  hash-chained receipts           (sha256(prevHash+canon(body)), canonical
 *                                       JSON sorted keys, verify + tamper at the
 *                                       exact index + chain-break detection)
 *   F  conservation storm              (240 seeded ops — htlcInvariant + Σ
 *                                       accounts constant + stateRoot replay)
 *   G  risk-gate sees htlc ops         (submitOp → evaluatePreTrade/recordRisk
 *                                       receipt trail fires — no bypass)
 *
 * Run: DATABASE_URL=file:/home/z/w49b-htlc-dex.db bun harness/htlc-test.ts
 * Exit 0 = all green; exit 1 = any failure (CI-usable).
 */

import { applyOp, genesisState, addBal, GAS_TABLE, type DexState, type Op } from "../src/lib/dex/kernel";
import { htlcInvariant, HTLC_ESCROW } from "../src/lib/dex/htlc";
import { sha256, canon, stateRootOf } from "../src/lib/dex/canonical";
import {
  htlcReceiptsOf,
  verifyHtlcReceipts,
  HTLC_RECEIPT_GENESIS,
  type HtlcReceipt,
} from "../src/lib/dex/htlc-receipts";
import { submitOp, nextNonce } from "../src/lib/dex/chain";
import { riskReceipts, verifyRiskChain, evaluatePreTrade } from "../src/lib/dex/risk";

let pass = 0;
const fails: string[] = [];
function ok(name: string, cond: boolean): void {
  if (cond) pass++;
  else {
    fails.push(name);
    console.log(`FAIL ${name}`);
  }
}

/* ── fixture ─────────────────────────────────────────────────────────── */

const SECRET = "w49b-atomic-preimage-8f3a9c1e";
const HLOCK = sha256(SECRET);

function fresh(): DexState {
  const st = genesisState();
  addBal(st, "alice", "SAOS", 1_000_000);
  addBal(st, "alice", "USDS", 500_000);
  addBal(st, "bob", "SAOS", 1_000_000);
  addBal(st, "bob", "USDS", 500_000);
  st.credits["alice"] = 500_000;
  st.credits["bob"] = 500_000;
  return st;
}

const mkCreate = (over: Partial<Op> = {}): Op => ({
  type: "htlc_create",
  issuer: "alice",
  nonce: "c1",
  to: "bob",
  asset: "SAOS",
  amount: 10_000,
  htlcId: "lock-1",
  hashlock: HLOCK,
  timeoutH: 100,
  ...over,
});
const mkClaim = (over: Partial<Op> = {}): Op => ({
  type: "htlc_claim",
  issuer: "bob",
  nonce: "m1",
  htlcId: "lock-1",
  preimage: SECRET,
  ...over,
});
const mkRefund = (over: Partial<Op> = {}): Op => ({
  type: "htlc_refund",
  issuer: "alice",
  nonce: "r1",
  htlcId: "lock-1",
  ...over,
});

const balOf = (st: DexState, who: string, a: string): number => st.balances[who]?.[a] ?? 0;
const sumAll = (st: DexState): number => {
  let s = 0;
  for (const who of Object.keys(st.balances)) {
    for (const a of Object.keys(st.balances[who] ?? {})) s += st.balances[who]?.[a] ?? 0;
  }
  return s;
};

/* ══ A · lifecycle + gas ═══════════════════════════════════════════════ */

function sectionLifecycle(): void {
  const st = fresh();
  const creditsBefore = st.credits["alice"] ?? 0;
  const rc = applyOp(st, mkCreate(), 0);
  ok("A1 create ok + gas 40", rc.ok === true && rc.ok && rc.gas === 40);
  ok("A2 escrow locked, sender debited", balOf(st, HTLC_ESCROW, "SAOS") === 10_000 && balOf(st, "alice", "SAOS") === 990_000);
  ok("A3 create receipt sealed (state=locked)", htlcReceiptsOf(st).length === 1 && htlcReceiptsOf(st)[0].body.state === "locked" && htlcReceiptsOf(st)[0].body.contractId === "lock-1");

  st.height = 50; // inside the claim window
  const rcl = applyOp(st, mkClaim(), 0);
  ok("A4 claim ok + gas 20", rcl.ok === true && rcl.ok && rcl.gas === 20);
  ok("A5 escrow→recipient exactly", balOf(st, "bob", "SAOS") === 1_010_000 && balOf(st, HTLC_ESCROW, "SAOS") === 0);
  const recs = htlcReceiptsOf(st);
  ok("A6 claim receipt carries the on-chain witness", recs.length === 2 && recs[1].body.state === "claimed" && recs[1].body.preimage === SECRET);
  ok("A7 create gas actually debited from issuer credits", (st.credits["alice"] ?? 0) === creditsBefore - 40);

  ok("A8 GAS_TABLE pinned 40/20/20", GAS_TABLE.htlc_create === 40 && GAS_TABLE.htlc_claim === 20 && GAS_TABLE.htlc_refund === 20);
}

/* ══ B · refusal walls (fail-closed: typed denial, zero mutation, zero gas) ══ */

function sectionRefusals(): void {
  // B1/B2 wrong preimage
  let st = fresh();
  applyOp(st, mkCreate(), 0);
  const credBob = st.credits["bob"] ?? 0;
  const noncesBefore = st.nonces.length;
  const recsBefore = htlcReceiptsOf(st).length;
  const rw = applyOp(st, mkClaim({ preimage: "wrong-secret" }), 0);
  ok("B1 wrong preimage denied hashlock-mismatch (gas 0)", rw.ok === false && !rw.ok && rw.err === "hashlock-mismatch" && rw.gas === 0);
  ok("B2 refusal: no gas, no nonce, no receipt, contract untouched", (st.credits["bob"] ?? 0) === credBob && st.nonces.length === noncesBefore && htlcReceiptsOf(st).length === recsBefore && st.htlcs?.["lock-1"]?.state === "locked");

  // B3/B4 claim after expiry
  st = fresh();
  applyOp(st, mkCreate(), 0);
  st.height = 101; // timeoutH=100 → claim window closed (inclusive boundary)
  const rl = applyOp(st, mkClaim(), 0);
  ok("B3 claim after expiry denied 'expired' (gas 0)", rl.ok === false && !rl.ok && rl.err === "expired" && rl.gas === 0);
  ok("B4 expired contract still locked + escrow intact", st.htlcs?.["lock-1"]?.state === "locked" && balOf(st, HTLC_ESCROW, "SAOS") === 10_000);

  // B5/B6 refund before expiry
  st = fresh();
  applyOp(st, mkCreate(), 0);
  st.height = 99;
  const rr = applyOp(st, mkRefund(), 0);
  ok("B5 refund before expiry denied 'not-expired' (gas 0)", rr.ok === false && !rr.ok && rr.err === "not-expired" && rr.gas === 0);
  ok("B6 early refund leaves escrow untouched", balOf(st, HTLC_ESCROW, "SAOS") === 10_000 && st.htlcs?.["lock-1"]?.state === "locked");

  // B7/B8 double claim
  st = fresh();
  applyOp(st, mkCreate(), 0);
  st.height = 10;
  applyOp(st, mkClaim({ nonce: "m1" }), 0);
  const rdc = applyOp(st, mkClaim({ nonce: "m2" }), 0);
  ok("B7 double claim denied 'not-locked'", rdc.ok === false && !rdc.ok && rdc.err === "not-locked");
  ok("B8 escrow paid exactly once", balOf(st, "bob", "SAOS") === 1_010_000 && balOf(st, HTLC_ESCROW, "SAOS") === 0);

  // B9/B10 double refund
  st = fresh();
  applyOp(st, mkCreate(), 0);
  st.height = 150;
  applyOp(st, mkRefund({ nonce: "r1" }), 0);
  const rdr = applyOp(st, mkRefund({ nonce: "r2" }), 0);
  ok("B9 double refund denied 'not-locked'", rdr.ok === false && !rdr.ok && rdr.err === "not-locked");
  ok("B10 sender refunded exactly once", balOf(st, "alice", "SAOS") === 1_000_000 && balOf(st, HTLC_ESCROW, "SAOS") === 0);

  // B11/B12 insufficient balance at create
  st = fresh();
  const rix = applyOp(st, mkCreate({ amount: 999_999_999 }), 0);
  ok("B11 over-balance create denied 'insufficient' (gas 0)", rix.ok === false && !rix.ok && rix.err === "insufficient" && rix.gas === 0);
  ok("B12 no escrow, no contract, no receipt on denial", balOf(st, HTLC_ESCROW, "SAOS") === 0 && st.htlcs?.["lock-1"] === undefined && htlcReceiptsOf(st).length === 0);

  // B13 fractional µ amount — TYPED denial (units law): the kernel prelude
  // rejects non-integer amounts before consume; never a throw past applyOp,
  // never a state touch (Roast-65-a L2 discipline)
  st = fresh();
  let threw = false;
  let rfrac: ReturnType<typeof applyOp> | null = null;
  try {
    rfrac = applyOp(st, mkCreate({ amount: 10.5 }), 0);
  } catch {
    threw = true;
  }
  const typedDenial = rfrac !== null && rfrac.ok === false && !rfrac.ok && rfrac.gas === 0 && (rfrac.err === "non-integer-amount" || rfrac.err === "bad-amount");
  ok("B13 fractional amount → typed denial (no throw, no state touch)", threw === false && typedDenial && balOf(st, HTLC_ESCROW, "SAOS") === 0 && st.htlcs?.["lock-1"] === undefined && htlcReceiptsOf(st).length === 0);
}

/* ══ C · refund after expiry returns escrow EXACTLY ════════════════════ */

function sectionRefundExact(): void {
  const st = fresh();
  const sumBefore = sumAll(st);
  applyOp(st, mkCreate({ amount: 77_777, asset: "USDS" }), 0);
  st.height = 300; // well past timeoutH=100
  const rr = applyOp(st, mkRefund({ htlcId: "lock-1" }), 0);
  ok("C1 refund after expiry ok + gas 20", rr.ok === true && rr.ok && rr.gas === 20);
  ok("C2 escrow returned to the µ", balOf(st, "alice", "USDS") === 500_000 && balOf(st, HTLC_ESCROW, "USDS") === 0);
  ok("C3 Σ-accounts constant across lock+refund", sumAll(st) === sumBefore);
  const recs = htlcReceiptsOf(st);
  ok("C4 refund receipt sealed (state=refunded)", recs.length === 2 && recs[1].body.state === "refunded" && recs[1].body.amount === 77_777);
}

/* ══ D · batch atomicity ═══════════════════════════════════════════════ */

function sectionBatch(): void {
  // D1/D2 — one bad htlc sub-op denies the WHOLE batch (nothing applied, no receipts)
  let st = fresh();
  const rb = applyOp(
    st,
    {
      type: "batch",
      issuer: "alice",
      nonce: "b1",
      ops: [
        mkCreate({ htlcId: "good-1", amount: 5_000, timeoutH: 100, nonce: "gd1" }),
        mkCreate({ htlcId: "bad-1", amount: 999_999_999, timeoutH: 100, nonce: "bd1" }), // insufficient
      ],
    } as unknown as Op,
    0,
  );
  ok("D1 bad sub-op denies whole batch", rb.ok === false && !rb.ok && rb.err === "batch-atomic-fail@1:insufficient" && rb.gas === 0);
  ok("D2 nothing applied: no escrow, no contracts, no receipts", balOf(st, HTLC_ESCROW, "SAOS") === 0 && st.htlcs?.["good-1"] === undefined && htlcReceiptsOf(st).length === 0);

  // D3-D6 — all-good htlc batch applies atomically, receipts chained in order
  st = fresh();
  st.height = 5;
  const rOK = applyOp(
    st,
    {
      type: "batch",
      issuer: "alice",
      nonce: "b2",
      ops: [
        mkCreate({ htlcId: "g-01", amount: 4_000, timeoutH: 100, nonce: "gd2" }),
        mkCreate({ htlcId: "g-02", amount: 6_000, timeoutH: 200, hashlock: sha256("second-secret"), nonce: "gd3" }),
      ],
    } as unknown as Op,
    0,
  );
  ok("D3 all-good htlc batch applied", rOK.ok === true && rOK.ok);
  ok("D4 both contracts locked + escrow 10_000", st.htlcs?.["g-01"]?.state === "locked" && st.htlcs?.["g-02"]?.state === "locked" && balOf(st, HTLC_ESCROW, "SAOS") === 10_000);
  ok("D5 batch receipts chained in sub-op order", htlcReceiptsOf(st).length === 2 && htlcReceiptsOf(st)[0].body.contractId === "g-01" && htlcReceiptsOf(st)[1].body.contractId === "g-02");
  ok("D6 batch receipt chain verifies", verifyHtlcReceipts(htlcReceiptsOf(st)).ok === true);
}

/* ══ E · hash-chained receipts — forensics ═════════════════════════════ */

function sectionReceipts(): void {
  const st = fresh();
  applyOp(st, mkCreate({ htlcId: "e-01" }), 0);
  st.height = 20;
  applyOp(st, mkClaim({ htlcId: "e-01" }), 0);
  applyOp(st, mkCreate({ htlcId: "e-02", nonce: "c2", timeoutH: 100, hashlock: sha256("e2-secret") }), 0);
  const chain = htlcReceiptsOf(st);

  ok("E1 three transitions → three receipts", chain.length === 3);
  ok("E2 genesis anchor on receipt #1", chain[0].prevHash === HTLC_RECEIPT_GENESIS && chain[0].seq === 1);
  ok("E3 seq continuity 1..n", chain[1].seq === 2 && chain[2].seq === 3);
  ok("E4 prevHash linkage", chain[1].prevHash === chain[0].hash && chain[2].prevHash === chain[1].hash);
  ok("E5 hash = sha256(prevHash+canon(body)) — recomputation", chain.every((r: HtlcReceipt) => r.hash === sha256(r.prevHash + canon(r.body))));
  ok("E6 verifyHtlcReceipts clean", verifyHtlcReceipts(chain).ok === true && verifyHtlcReceipts(chain).brokenAt === null);

  // tamper — flip one unit in a body field → detected at the EXACT index
  const tampered = structuredClone(chain);
  tampered[1].body.amount = 10_001; // one integer flipped
  const vt = verifyHtlcReceipts(tampered);
  ok("E7 tampered body detected at exact index 1", vt.ok === false && vt.brokenAt === 1);

  // tamper the hash field itself
  const tampered2 = structuredClone(chain);
  tampered2[0].hash = "f" + tampered2[0].hash.slice(1);
  ok("E8 tampered hash field detected at index 0", verifyHtlcReceipts(tampered2).ok === false && verifyHtlcReceipts(tampered2).brokenAt === 0);

  // chain break — a spliced-out row breaks linkage
  const spliced = structuredClone(chain);
  spliced.splice(1, 1);
  const vs = verifyHtlcReceipts(spliced);
  ok("E9 spliced row breaks the chain", vs.ok === false && vs.brokenAt !== null);

  // chain break — reordering breaks linkage
  const reordered = structuredClone(chain);
  const tmp = reordered[0];
  reordered[0] = reordered[1];
  reordered[1] = tmp;
  ok("E10 reordered rows break the chain", verifyHtlcReceipts(reordered).ok === false);

  // canonical JSON — sorted keys, order-independent hashing
  ok("E11 canon sorts keys recursively", canon({ b: 2, a: 1, z: { y: 2, x: 1 } }) === '{"a":1,"b":2,"z":{"x":1,"y":2}}');
  ok("E12 receipt hash is insertion-order independent", sha256("x" + canon({ op: "htlc_create", contractId: "k", amount: 5 })) === sha256("x" + canon({ amount: 5, contractId: "k", op: "htlc_create" })));
}

/* ══ F · conservation storm — seeded deterministic op sequence ═════════ */

function lcg(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface StormOut { st: DexState; successes: number; refusals: number; throws: number }
function runStorm(seed: number): StormOut {
  const rnd = lcg(seed);
  const st = fresh();
  st.height = 10;
  const sumBefore = sumAll(st);
  const secretOf = (id: string): string => SECRET + ":" + id;
  const active: { id: string; from: string; to: string; asset: string; timeoutH: number }[] = [];
  const usedIds = new Set<string>();
  let successes = 0;
  let refusals = 0;
  let throws = 0;
  let n = 0;
  const N = 240;
  for (let i = 0; i < N; i++) {
    if (i % 3 === 2) st.height += 2; // the block clock ticks
    const roll = rnd();
    n++;
    try {
      if (roll < 0.38) {
        // create — occasionally re-attempt an already-used id (single-use law)
        const id = i % 37 === 5 && usedIds.size > 0 ? usedIds.values().next().value as string : `s-${i}`;
        const asset = rnd() < 0.5 ? "SAOS" : "USDS";
        const amount = 100 + Math.floor(rnd() * 1_500);
        const timeoutH = st.height + 3 + Math.floor(rnd() * 25);
        const preimage = secretOf(`s-${i}`);
        const r = applyOp(
          st,
          { type: "htlc_create", issuer: "alice", nonce: `n${n}`, to: "bob", asset, amount, htlcId: id, hashlock: sha256(preimage), timeoutH } as Op,
          0,
        );
        if (r.ok) {
          usedIds.add(id);
          active.push({ id, from: "alice", to: "bob", asset, timeoutH });
          successes++;
        } else refusals++;
      } else if (roll < 0.68 && active.length > 0) {
        // claim (70% correct preimage, 30% wrong)
        const k = Math.floor(rnd() * active.length);
        const c = active[k];
        const good = rnd() < 0.7;
        const r = applyOp(
          st,
          { type: "htlc_claim", issuer: c.to, nonce: `n${n}`, htlcId: c.id, preimage: good ? secretOf(c.id) : "wrong" } as Op,
          0,
        );
        if (r.ok) {
          active.splice(k, 1);
          successes++;
        } else refusals++;
      } else if (roll < 0.86 && active.length > 0) {
        // refund the first expired contract (issuer = sender)
        const k = active.findIndex((c) => st.height > c.timeoutH);
        if (k >= 0) {
          const c = active[k];
          const r = applyOp(st, { type: "htlc_refund", issuer: c.from, nonce: `n${n}`, htlcId: c.id } as Op, 0);
          if (r.ok) {
            active.splice(k, 1);
            successes++;
          } else refusals++;
        }
      } // else: pure block-tick no-op
    } catch {
      throws++;
    }
    // after EVERY op — the two iron invariants
    if (!htlcInvariant(st).ok) {
      ok("F-invariant-mid-storm", false);
      return { st, successes, refusals, throws };
    }
    if (sumAll(st) !== sumBefore) {
      ok("F-conservation-mid-storm", false);
      return { st, successes, refusals, throws };
    }
  }
  ok("F1 storm ran clean (0 throws, mix exercised)", throws === 0 && successes > 40 && refusals > 10);
  ok("F2 escrow === Σ active locked (final)", htlcInvariant(st).ok);
  const recs = htlcReceiptsOf(st);
  ok("F3 one receipt per successful transition", recs.length === successes);
  ok("F4 receipt chain verifies after the storm", verifyHtlcReceipts(recs).ok === true && recs.length === successes);
  // ids generated by the storm must satisfy the single-use contract-id law
  ok("F6 storm contract ids all ≥4 chars (schema law)", Array.from(recs.reduce((m, r) => m.add(r.body.contractId), new Set<string>())).every((id) => id.length >= 4));
  return { st, successes, refusals, throws };
}

function sectionStorm(): void {
  const a = runStorm(0x5eed1234);
  const b = runStorm(0x5eed1234); // identical replay — determinism proof
  ok("F5 stateRoot replay identical (receipts in canonical state)", stateRootOf(a.st) === stateRootOf(b.st));
  ok("F6 storm engaged the height clock", a.st.height > 10);
}

/* ══ G · the pre-trade risk cabinet SEES htlc ops (no bypass) ══════════ */

function sectionRiskGate(): void {
  // pure classification: the cabinet evaluates every op — htlc is C0 (kernel
  // owns htlc validity; the cabinet records the verdict either way)
  const cls = evaluatePreTrade(mkCreate(), { inFlight: 0 });
  ok("G1 evaluatePreTrade classifies htlc_create C0-allow", cls.allowed === true && cls.verdicts[0].id === "C0");

  const before = riskReceipts().length;
  const opSent = mkCreate({ htlcId: "gate-1", nonce: "g-fixed-1" });
  const r1 = submitOp(opSent);
  const trail = riskReceipts();
  ok("G2 submitOp queues htlc_create", r1.queued === true);
  ok("G3 risk receipt recorded for the htlc op (no bypass)", trail.length === before + 1);
  ok("G4 trail row is bound to the exact htlc op digest", trail[trail.length - 1].opDigest === sha256(canon(opSent)));
  ok("G5 gate verdict allow recorded", trail[trail.length - 1].allowed === true && trail[trail.length - 1].reason === null);

  const r3 = submitOp(mkClaim({ htlcId: "gate-1", nonce: "g-fixed-2" }));
  ok("G6 submitOp queues htlc_claim", r3.queued === true && riskReceipts().length === before + 2);

  // batch of htlc sub-ops passes the cabinet gate (C0 each, batch queued)
  const r4 = submitOp({
    type: "batch",
    issuer: "alice",
    nonce: nextNonce("g"),
    ops: [mkCreate({ htlcId: "gate-b1", nonce: "gb1" }), mkClaim({ htlcId: "gate-b1", nonce: "gb2" })],
  } as unknown as Op);
  ok("G7 htlc batch passes the cabinet gate", r4.queued === true);

  ok("G8 risk receipt chain verifies", verifyRiskChain(riskReceipts()).ok === true);
}

/* ── run ─────────────────────────────────────────────────────────────── */

console.log("W49-b HTLC bridge battery — deterministic, offline (fixed height clock, seeded LCG)");
sectionLifecycle();
sectionRefusals();
sectionRefundExact();
sectionBatch();
sectionReceipts();
sectionStorm();
sectionRiskGate();
console.log(`\n${pass}/${pass + fails.length} PASS${fails.length > 0 ? " — FAILURES: " + fails.join(", ") : ""}`);
process.exit(fails.length > 0 ? 1 : 0);
