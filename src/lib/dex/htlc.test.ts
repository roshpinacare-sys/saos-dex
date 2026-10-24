/**
 * htlc.test.ts — THE HTLC IRON-LAW SUITE (G70 §7.2 · wave 19.82)
 *
 * Deterministic + offline (the house law): genesisState() fixture, fixed
 * block-height clock, no Date.now, no network, no db. Every refusal happens
 * BEFORE consume() — a rejected op never touches state (Roast-65-a L2 law).
 *
 * The invariants under test (the iron law of the internal bridge):
 *   I1  conservation: bal(htlc-escrow, asset) === Σ active htlc amounts (per asset)
 *   I2  no claim after expiry        (height > timeoutH → refund-only)
 *   I3  no refund before expiry      (height <= timeoutH → claim-only)
 *   I4  hashlock binding exact       (sha256(preimage) === hashlock, canonical sha256)
 *   I5  one settlement per contract  (claimed/refunded are terminal)
 *   I6  party binding                (only `to` claims, only `from` refunds)
 *   I7  replay discipline            (kernel nonce dedupe, prelude)
 *   I8  the atomic-swap composition  (preimage witness on chain completes
 *                                     a two-party trustless cross-asset swap)
 */
import { describe, test, expect } from "bun:test";
import { applyOp, genesisState, addBal, type DexState, type Op } from "./kernel";
import { htlcInvariant, HTLC_ESCROW, HTLC_MAX_TIMEOUT_H } from "./htlc";
import { sha256 } from "./canonical";

/* ── fixture ─────────────────────────────────────────────────────────── */
const SECRET = "8f3a9c1e5b7d2f4a6e8c0b2d4f6a8e0c1b3d5f7a9c2e4b6d8f0a2c4e6b8d0f3a"; // creator's secret (hex or any text)
const HLOCK = sha256(SECRET); // deterministic 64-hex hashlock

function fresh(): DexState {
  const st = genesisState();
  // seed the two parties with assets + gas credits (deterministic, no faucet op)
  addBal(st, "alice", "SAOS", 1_000_000);
  addBal(st, "alice", "USDS", 500_000);
  addBal(st, "bob", "SAOS", 1_000_000);
  addBal(st, "bob", "USDS", 500_000);
  st.credits["alice"] = 100_000;
  st.credits["bob"] = 100_000;
  return st;
}

function createOp(over: Partial<Op> = {}): Op {
  return {
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
  };
}

function expectOk(r: { ok: boolean; err?: string }, label: string) {
  expect(r.ok).toBe(true);
}

function expectErr(r: { ok: boolean; err?: string }, err: string, label: string) {
  expect(r.ok).toBe(false);
  expect(r.err).toBe(err);
}

/* ── I1 · happy lifecycle ────────────────────────────────────────────── */
describe("htlc lifecycle", () => {
  test("create locks into the escrow account and records the contract", () => {
    const st = fresh();
    const r = applyOp(st, createOp(), 0);
    expectOk(r, "create");
    expect(balOf(st, HTLC_ESCROW, "SAOS")).toBe(10_000);
    expect(balOf(st, "alice", "SAOS")).toBe(1_000_000 - 10_000);
    const h = st.htlcs?.["lock-1"];
    expect(h?.state).toBe("locked");
    expect(h?.from).toBe("alice");
    expect(h?.to).toBe("bob");
    expect(h?.hashlock).toBe(HLOCK);
    expect(h?.amount).toBe(10_000);
    expect(h?.timeoutH).toBe(100);
    expect(htlcInvariant(st).ok).toBe(true);
  });

  test("claim by recipient with the correct preimage settles before expiry", () => {
    const st = fresh();
    applyOp(st, createOp(), 0);
    st.height = 50; // inside the claim window
    const r = applyOp(
      st,
      { type: "htlc_claim", issuer: "bob", nonce: "m1", htlcId: "lock-1", preimage: SECRET },
      0,
    );
    expectOk(r, "claim");
    expect(balOf(st, "bob", "SAOS")).toBe(1_000_000 + 10_000);
    expect(balOf(st, HTLC_ESCROW, "SAOS")).toBe(0);
    const h = st.htlcs?.["lock-1"];
    expect(h?.state).toBe("claimed");
    expect(h?.preimage).toBe(SECRET); // THE WITNESS — on chain, verifiable by any node
    expect(htlcInvariant(st).ok).toBe(true);
  });

  test("refund by sender after expiry returns the locked funds", () => {
    const st = fresh();
    applyOp(st, createOp(), 0);
    st.height = 101; // timeoutH=100 — expiry boundary: claim refused, refund allowed
    const rc = applyOp(
      st,
      { type: "htlc_claim", issuer: "bob", nonce: "m1", htlcId: "lock-1", preimage: SECRET },
      0,
    );
    expectErr(rc, "expired", "claim-at-boundary");
    const rr = applyOp(
      st,
      { type: "htlc_refund", issuer: "alice", nonce: "r1", htlcId: "lock-1" },
      0,
    );
    expectOk(rr, "refund");
    expect(balOf(st, "alice", "SAOS")).toBe(1_000_000);
    expect(balOf(st, HTLC_ESCROW, "SAOS")).toBe(0);
    expect(st.htlcs?.["lock-1"]?.state).toBe("refunded");
    expect(htlcInvariant(st).ok).toBe(true);
  });
});

/* ── I2..I6 · the refusal walls ──────────────────────────────────────── */
describe("htlc refusal walls (fail-closed, zero state touch)", () => {
  test("double-claim is refused — one settlement per contract (I5)", () => {
    const st = fresh();
    applyOp(st, createOp(), 0);
    st.height = 10;
    applyOp(st, { type: "htlc_claim", issuer: "bob", nonce: "m1", htlcId: "lock-1", preimage: SECRET }, 0);
    const r2 = applyOp(
      st,
      { type: "htlc_claim", issuer: "bob", nonce: "m2", htlcId: "lock-1", preimage: SECRET },
      0,
    );
    expectErr(r2, "not-locked", "double-claim");
    expect(balOf(st, "bob", "SAOS")).toBe(1_000_000 + 10_000); // paid exactly once
    expect(balOf(st, HTLC_ESCROW, "SAOS")).toBe(0);
  });

  test("wrong preimage is refused before gas/nonce (I4)", () => {
    const st = fresh();
    applyOp(st, createOp(), 0);
    const creditsBefore = st.credits["bob"];
    const r = applyOp(
      st,
      { type: "htlc_claim", issuer: "bob", nonce: "m1", htlcId: "lock-1", preimage: "wrong-secret" },
      0,
    );
    expectErr(r, "hashlock-mismatch", "wrong-preimage");
    expect(st.credits["bob"]).toBe(creditsBefore); // no gas burned on rejection
    expect(st.nonces.filter((n) => n === "bob:m1").length).toBe(0); // no nonce burned
    expect(st.htlcs?.["lock-1"]?.state).toBe("locked"); // untouched
  });

  test("claim after expiry refused, refund before expiry refused (I2/I3)", () => {
    const st = fresh();
    applyOp(st, createOp(), 0);
    st.height = 101;
    const rc = applyOp(
      st,
      { type: "htlc_claim", issuer: "bob", nonce: "m1", htlcId: "lock-1", preimage: SECRET },
      0,
    );
    expectErr(rc, "expired", "late-claim");
    st.height = 100; // back inside the window
    const rr = applyOp(st, { type: "htlc_refund", issuer: "alice", nonce: "r1", htlcId: "lock-1" }, 0);
    expectErr(rr, "not-expired", "early-refund");
    expect(st.htlcs?.["lock-1"]?.state).toBe("locked");
  });

  test("only the recipient claims and only the sender refunds (I6)", () => {
    const st = fresh();
    applyOp(st, createOp(), 0);
    st.height = 10;
    const rc = applyOp(
      st,
      { type: "htlc_claim", issuer: "alice", nonce: "m0", htlcId: "lock-1", preimage: SECRET },
      0,
    );
    expectErr(rc, "not-recipient", "wrong-claimant");
    st.height = 200;
    const rr = applyOp(st, { type: "htlc_refund", issuer: "bob", nonce: "r0", htlcId: "lock-1" }, 0);
    expectErr(rr, "not-sender", "wrong-refunder");
  });

  test("nonce replay through the kernel prelude (I7)", () => {
    const st = fresh();
    const r1 = applyOp(st, createOp(), 0);
    expectOk(r1, "first");
    const r2 = applyOp(st, createOp(), 0); // same issuer+nonce
    expectErr(r2, "replay-rejected", "replay");
  });
});

/* ── create-time validation ──────────────────────────────────────────── */
describe("htlc create validation", () => {
  test("bad hashlock format refused", () => {
    const st = fresh();
    const r = applyOp(st, createOp({ hashlock: "deadbeef" }), 0);
    expectErr(r, "bad-hashlock", "short-hashlock");
  });

  test("self-recipient refused, unknown id field refused when empty", () => {
    const st = fresh();
    expectErr(applyOp(st, createOp({ to: "alice" }), 0), "recipient-must-differ", "self");
    expectErr(applyOp(st, createOp({ htlcId: "" }), 0), "bad-htlc-id", "empty-id");
    expectErr(applyOp(st, createOp({ htlcId: "bad id!" }), 0), "bad-htlc-id", "charset-id");
  });

  test("unknown asset / zero amount refused", () => {
    const st = fresh();
    expectErr(applyOp(st, createOp({ asset: "NOPE" as never }), 0), "unknown-asset", "asset");
    expectErr(applyOp(st, createOp({ amount: 0 }), 0), "bad-amount", "zero");
    expectErr(applyOp(st, createOp({ amount: -5 }), 0), "bad-amount", "negative");
  });

  test("timeout must be a strict future height and bounded", () => {
    const st = fresh();
    expectErr(applyOp(st, createOp({ timeoutH: 0 }), 0), "bad-timeout", "past");
    expectErr(applyOp(st, createOp({ timeoutH: 100.5 }), 0), "bad-timeout", "fractional");
    expectErr(
      applyOp(st, createOp({ timeoutH: HTLC_MAX_TIMEOUT_H + 1 }), 0),
      "bad-timeout",
      "eternal-lock",
    );
  });

  test("insufficient balance refused — escrow never goes negative (I1)", () => {
    const st = fresh();
    const r = applyOp(st, createOp({ amount: 999_999_999 }), 0);
    expectErr(r, "insufficient", "overdraw");
    expect(balOf(st, HTLC_ESCROW, "SAOS")).toBe(0);
  });

  test("htlc id is single-use forever (settled contracts keep their id)", () => {
    const st = fresh();
    applyOp(st, createOp(), 0);
    st.height = 50;
    applyOp(st, { type: "htlc_claim", issuer: "bob", nonce: "m1", htlcId: "lock-1", preimage: SECRET }, 0);
    const r = applyOp(st, createOp({ nonce: "c2" }), 0); // same id, new lock
    expectErr(r, "htlc-id-taken", "id-reuse");
  });

  test("unknown id on claim/refund refused", () => {
    const st = fresh();
    expectErr(
      applyOp(st, { type: "htlc_claim", issuer: "bob", nonce: "m1", htlcId: "ghost", preimage: SECRET }, 0),
      "unknown-htlc",
      "ghost-claim",
    );
    expectErr(
      applyOp(st, { type: "htlc_refund", issuer: "alice", nonce: "r1", htlcId: "ghost" }, 0),
      "unknown-htlc",
      "ghost-refund",
    );
  });
});

/* ── I8 · THE ATOMIC SWAP COMPOSITION ────────────────────────────────── */
describe("the trustless two-party atomic swap (§7.2 proof)", () => {
  test("the preimage witness is verifiable by any node from chain state", () => {
    const st = fresh();
    applyOp(st, createOp({ htlcId: "leg-a", asset: "SAOS", amount: 10_000, timeoutH: 200 }), 0);
    applyOp(
      st,
      createOp({ issuer: "bob", nonce: "c2", htlcId: "leg-b", to: "alice", asset: "USDS", amount: 5_000, timeoutH: 120 }),
      0,
    );
    st.height = 10;
    applyOp(st, { type: "htlc_claim", issuer: "alice", nonce: "m1", htlcId: "leg-b", preimage: SECRET }, 0);
    const witness = st.htlcs?.["leg-b"]?.preimage as string;
    // any mesh node re-derives the binding from the public witness — zero trust
    expect(sha256(witness)).toBe(HLOCK);
    const legAHash = st.htlcs?.["leg-a"]?.hashlock ?? "";
    expect(sha256(witness)).toBe(legAHash);
  });

  test("exact composition: both legs settle from the on-chain witness", () => {
    const st = fresh();
    applyOp(st, createOp({ htlcId: "leg-a", asset: "SAOS", amount: 10_000, timeoutH: 200 }), 0); // alice→bob SAOS
    applyOp(
      st,
      createOp({ issuer: "bob", nonce: "c2", htlcId: "leg-b", to: "alice", asset: "USDS", amount: 5_000, timeoutH: 120 }),
      0,
    );

    st.height = 10;
    // alice claims the USDS leg, revealing the secret on chain
    applyOp(st, { type: "htlc_claim", issuer: "alice", nonce: "m1", htlcId: "leg-b", preimage: SECRET }, 0);
    const witness = st.htlcs?.["leg-b"]?.preimage as string;

    // bob claims the SAOS leg using the on-chain witness (sha256(witness)===HLOCK)
    st.height = 20;
    applyOp(st, { type: "htlc_claim", issuer: "bob", nonce: "m2", htlcId: "leg-a", preimage: witness }, 0);

    expect(balOf(st, "alice", "USDS")).toBe(500_000 + 5_000);
    expect(balOf(st, "bob", "SAOS")).toBe(1_000_000 + 10_000);
    expect(st.htlcs?.["leg-a"]?.state).toBe("claimed");
    expect(st.htlcs?.["leg-b"]?.state).toBe("claimed");
    expect(htlcInvariant(st).ok).toBe(true);
    // conservation of the whole mesh: escrow fully drained, nothing minted
    expect(balOf(st, HTLC_ESCROW, "SAOS")).toBe(0);
    expect(balOf(st, HTLC_ESCROW, "USDS")).toBe(0);
  });

  test("timeout safety inversion: if the counterparty never reveals, the initiator is made whole", () => {
    const st = fresh();
    applyOp(st, createOp({ htlcId: "leg-a", asset: "SAOS", amount: 10_000, timeoutH: 200 }), 0);
    applyOp(
      st,
      createOp({ issuer: "bob", nonce: "c2", htlcId: "leg-b", to: "alice", asset: "USDS", amount: 5_000, timeoutH: 120 }),
      0,
    );
    // alice disappears without revealing. bob refunds his USDS leg at h+121.
    st.height = 121;
    applyOp(st, { type: "htlc_refund", issuer: "bob", nonce: "r1", htlcId: "leg-b" }, 0);
    // and alice's SAOS returns to her at h+201
    st.height = 201;
    applyOp(st, { type: "htlc_refund", issuer: "alice", nonce: "r2", htlcId: "leg-a" }, 0);
    expect(st.htlcs?.["leg-a"]?.state).toBe("refunded");
    expect(st.htlcs?.["leg-b"]?.state).toBe("refunded");
    expect(balOf(st, "alice", "SAOS")).toBe(1_000_000);
    expect(balOf(st, "bob", "USDS")).toBe(500_000);
    expect(htlcInvariant(st).ok).toBe(true);
  });
});

/* ── invariant auditor ───────────────────────────────────────────────── */
describe("htlcInvariant auditor", () => {
  test("detects a tampered escrow (conservation seam)", () => {
    const st = fresh();
    applyOp(st, createOp(), 0);
    // simulate corruption: steal from the escrow account outside the op discipline
    st.balances[HTLC_ESCROW]!["SAOS"] = 9_999;
    const inv = htlcInvariant(st);
    expect(inv.ok).toBe(false);
    expect(inv.seams.length).toBeGreaterThan(0);
    expect(inv.lockedTotal).toBe(10_000);
    expect(inv.activeTotal).toBe(9_999);
  });

  test("empty mesh is trivially consistent", () => {
    const st = fresh();
    const inv = htlcInvariant(st);
    expect(inv.ok).toBe(true);
    expect(inv.lockedTotal).toBe(0);
  });
});

/* ── helpers ─────────────────────────────────────────────────────────── */
function balOf(st: DexState, who: string, a: string): number {
  return st.balances[who]?.[a] ?? 0;
}
