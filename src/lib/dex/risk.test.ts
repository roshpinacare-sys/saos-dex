/**
 * src/lib/dex/risk.test.ts — pre-trade risk cabinet gate (directive §7C)
 * =======================================================================
 * TDD spec for the saos-dex enforcement side of the saos-desk cabinet
 * policy (saos-desk PR feat/dex-risk-cabinet-policy). Mirrors the desk
 * contract: mandate@4-derived limits, riskGate verdict shape, hash-chained
 * receipts. Zero network, zero vault reads, all material in-test.
 */

import { describe, it, expect } from "bun:test";

import {
  CABINET_SCHEMA,
  DEX_TRADE_OPS,
  CABINET_BASE_CAPITAL_MU,
  SLIPPAGE_GUARD_FRACTION,
  MANDATE_SIG,
  RISK_LIMITS,
  evaluatePreTrade,
  recordRiskReceipt,
  riskReceipts,
  verifyRiskChain,
  isTradeOp,
} from "./risk";
import type { Op } from "./kernel";

const op = (over: Partial<Op> = {}): Op => ({
  type: "order",
  issuer: "desk-agent",
  nonce: "n-1",
  base: "WSTEEM",
  quote: "USDS",
  side: "buy",
  price: 5_400_000,
  amount: 200,
  ...over,
} as Op);

describe("risk cabinet — mandate binding (law 3: the mandate is hard law)", () => {
  it("limits mirror the desk derivation exactly", () => {
    expect(RISK_LIMITS.maxNotionalMu).toBe(
      Math.floor((CABINET_BASE_CAPITAL_MU * 15) / 100),
    );
    expect(RISK_LIMITS.maxTradesPerIssuerInFlight).toBe(5);
    expect(RISK_LIMITS.minOutRequiredAboveMu).toBe(
      Math.floor((CABINET_BASE_CAPITAL_MU * 15 * SLIPPAGE_GUARD_FRACTION) / 100),
    );
    expect(RISK_LIMITS.schema).toBe(CABINET_SCHEMA);
  });

  it("mandateSig pins the sourced mandate@4 fields — parity with saos-desk cabinet", () => {
    // Computed by saos-desk cabinetLimitsFromMandate(mandate.json) — the two
    // cabinets must bind the SAME mandate version or one of them is lying.
    expect(MANDATE_SIG).toBe("82163e76");
  });

  it("trade ops scope frozen v1", () => {
    expect(DEX_TRADE_OPS).toEqual(["order", "fill", "pool_swap"]);
    expect(isTradeOp("order") && isTradeOp("fill") && isTradeOp("pool_swap")).toBe(true);
    expect(isTradeOp("asset_price")).toBe(false);
  });
});

describe("risk cabinet — C1..C4 verdicts (fail-closed)", () => {
  it("C1: float / NaN / negative units are denied (law 13 integers-only)", () => {
    expect(evaluatePreTrade(op({ amount: 200.5 }), { inFlight: 0 }).fails).toContain("C1");
    expect(evaluatePreTrade(op({ price: NaN }), { inFlight: 0 }).fails).toContain("C1");
    expect(evaluatePreTrade(op({ amount: -5 }), { inFlight: 0 }).fails).toContain("C1");
  });

  it("C1: unknown type wearing trade shape fails closed; clean admin op passes as C0", () => {
    expect(evaluatePreTrade(op({ type: "nuclear_launch" as never }), { inFlight: 0 }).fails).toContain("C1");
    const admin = { type: "asset_price", issuer: "treasury", nonce: "n", asset: "WSTEEM", refPrice: 1 } as unknown as Op;
    const v = evaluatePreTrade(admin, { inFlight: 0 });
    expect(v.allowed).toBe(true);
    expect(v.verdicts[0].id).toBe("C0");
  });

  it("C2: notional mirrors dex kernel floor(price×amount/1000); over-cap denied, at-cap passes", () => {
    // 5_400_000 × 278 / 1000 = 1_501_200 > 1_500_000
    expect(evaluatePreTrade(op({ amount: 278 }), { inFlight: 0 }).fails).toContain("C2");
    // 1_000_000 × 1_500 / 1000 = 1_500_000 = cap exactly
    const atCap = evaluatePreTrade(op({ price: 1_000_000, amount: 1_500 }), { inFlight: 0 });
    expect(atCap.allowed).toBe(true);
    expect(atCap.fails).toEqual([]);
  });

  it("C3: per-issuer in-flight velocity cap enforced via ctx", () => {
    expect(evaluatePreTrade(op(), { inFlight: RISK_LIMITS.maxTradesPerIssuerInFlight }).fails).toContain("C3");
    expect(
      evaluatePreTrade(op(), { inFlight: RISK_LIMITS.maxTradesPerIssuerInFlight - 1 }).allowed,
    ).toBe(true);
  });

  it("C4: pool_swap above guard tier requires minOut≥1 (SETTLE-9 defense-in-depth)", () => {
    // swap factory WITHOUT order fields (no leaked price — µ-base notional = amount)
    const swap = (over: Partial<Op> = {}): Op => ({
      type: "pool_swap",
      issuer: "desk-agent",
      nonce: "n-2",
      pair: "WSTEEM-USDS",
      assetIn: "WSTEEM",
      ...over,
    } as Op);
    const big = RISK_LIMITS.minOutRequiredAboveMu + 1;
    expect(evaluatePreTrade(swap({ amount: big }), { inFlight: 0 }).fails).toContain("C4");
    expect(
      evaluatePreTrade(swap({ amount: big, minOut: 1 }), { inFlight: 0 }).allowed,
    ).toBe(true);
    expect(
      evaluatePreTrade(swap({ amount: RISK_LIMITS.minOutRequiredAboveMu - 1 }), { inFlight: 0 }).allowed,
    ).toBe(true);
    expect(evaluatePreTrade(swap({ amount: big, minOut: 0 }), { inFlight: 0 }).fails).toContain("C4");
  });

  it("verdict shape parity with boardroom.riskGate: {id,label,passed,measured,limit} and allowed iff no fails", () => {
    const v = evaluatePreTrade(op({ amount: NaN }), { inFlight: 0 });
    expect(v.verdicts.length).toBeGreaterThan(0);
    for (const x of v.verdicts) {
      expect(typeof x.id).toBe("string");
      expect(typeof x.label).toBe("string");
      expect(typeof x.passed).toBe("boolean");
      expect("measured" in x).toBe(true);
      expect("limit" in x).toBe(true);
    }
    expect(v.fails.length).toBeGreaterThan(0);
    expect(v.allowed).toBe(v.fails.length === 0);
  });
});

describe("risk receipts — hash-chained immutable audit (directive §3)", () => {
  it("deny + allow verdicts chain with sha256 linkage; tamper located at exact index", () => {
    const bad = op({ amount: NaN });
    recordRiskReceipt(bad, evaluatePreTrade(bad, { inFlight: 0 }), { seq: 1, at: 1 });
    const good = op({ nonce: "n-2" });
    recordRiskReceipt(good, evaluatePreTrade(good, { inFlight: 0 }), { seq: 2, at: 2 });

    const chain = riskReceipts();
    expect(chain.length).toBe(2);
    expect(chain[0].allowed).toBe(false);
    expect(chain[0].reason).toContain("C1"); // NaN notional also trips C2 — defense-in-depth is correct
    expect(chain[1].allowed).toBe(true);
    expect(verifyRiskChain(chain).ok).toBe(true);

    const tampered = chain.map((r, i) => (i === 1 ? { ...r, allowed: !r.allowed } : r));
    const vt = verifyRiskChain(tampered);
    expect(vt.ok).toBe(false);
    expect(vt.brokenAt).toBe(1);
  });
});
