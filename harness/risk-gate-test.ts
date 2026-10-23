/**
 * harness/risk-gate-test.ts — §7C pre-trade risk cabinet integration proof
 * ==========================================================================
 * Boots the REAL chain runtime against a THROWAWAY dex.db (the db-scope-guard
 * law: DATABASE_URL must end in dex.db and never custom.db — we comply with a
 * temp path) and proves submitOp-level wiring:
 *
 *   1. clean order → queued, receipt allowed
 *   2. over-cap order → rejected `risk:C2`
 *   3. unguarded pool_swap above tier → rejected `risk:C4`
 *   4. admin op (treasury asset_price) → queued untouched (C0)
 *   5. batch carrying one bad sub-op → rejected `risk:batch[i]:C1`
 *   6. receipt chain verifies (sha256, tamper-evident)
 *
 * Run: DATABASE_URL=file:/tmp/risk-gate-dex.db bun harness/risk-gate-test.ts
 * Exit 0 = all green; exit 1 = any failure (CI-usable).
 */

import { submitOp, nextNonce } from "../src/lib/dex/chain";
import { riskReceipts, verifyRiskChain, RISK_LIMITS } from "../src/lib/dex/risk";
import type { Op } from "../src/lib/dex/kernel";

let pass = 0;
const fails: string[] = [];
function ok(name: string, cond: boolean): void {
  if (cond) pass++;
  else {
    fails.push(name);
    console.log(`FAIL ${name}`);
  }
}

const order = (over: Partial<Op> = {}): Op => ({
  type: "order",
  issuer: "harness-agent",
  nonce: nextNonce("h"),
  base: "WSTEEM",
  quote: "USDS",
  side: "buy",
  price: 5_400_000,
  amount: 200, // notional 1_080_000µ ≤ cap 1_500_000µ
  ...over,
} as Op);

// 1 — clean order sails through the cabinet
const r1 = submitOp(order());
ok("1 clean order queued", r1.queued === true && r1.reason === undefined);

// 2 — over-cap denied (5_400_000 × 278 / 1000 = 1_501_200µ > 1_500_000µ)
const r2 = submitOp(order({ nonce: nextNonce("h"), amount: 278 }));
ok("2 over-cap denied C2", r2.queued === false && r2.reason === "risk:C2");

// 3 — unguarded swap above the slippage tier denied (µ-base notional = amount)
const r3 = submitOp({
  type: "pool_swap",
  issuer: "harness-agent",
  nonce: nextNonce("h"),
  pair: "WSTEEM-USDS",
  assetIn: "WSTEEM",
  amount: RISK_LIMITS.minOutRequiredAboveMu + 1,
} as Op);
ok("3 unguarded swap denied C4", r3.queued === false && r3.reason === "risk:C4");

// 4 — guarded swap below tier passes
const r4 = submitOp({
  type: "pool_swap",
  issuer: "harness-agent",
  nonce: nextNonce("h"),
  pair: "WSTEEM-USDS",
  assetIn: "WSTEEM",
  amount: RISK_LIMITS.minOutRequiredAboveMu - 1,
} as Op);
ok("4 small swap queued", r4.queued === true);

// 5 — admin op untouched by the cabinet (C0)
const r5 = submitOp({ type: "asset_price", issuer: "treasury", nonce: nextNonce("ap"), asset: "WSTEEM", refPrice: 1 } as unknown as Op);
ok("5 admin op queued (C0)", r5.queued === true);

// 6 — batch carrying one bad sub-op: whole batch denied atomically
const r6 = submitOp({
  type: "batch",
  issuer: "harness-agent",
  nonce: nextNonce("h"),
  ops: [
    order({ nonce: "b-1" }), // clean
    order({ nonce: "b-2", amount: -5 }), // C1 units-law violation
  ],
} as unknown as Op);
ok("6 bad batch denied at sub-op", r6.queued === false && /^risk:batch\[1\]:C1$/.test(r6.reason ?? ""));

// 7 — receipt chain: one row per submission (6 submitOp calls), sha256-linked
const chain = riskReceipts();
ok("7a receipt per verdict", chain.length === 6);
ok("7b deny rows carry reason", chain.filter((r) => !r.allowed).length === 3);
ok("7c chain verifies clean", verifyRiskChain(chain).ok === true);

// 8 — limits pinned against the desk derivation
ok("8 mandate sig parity", RISK_LIMITS.mandateSig === "82163e76");

console.log(`\n${pass}/${pass + fails.length} PASS${fails.length > 0 ? " — FAILURES: " + fails.join(", ") : ""}`);
process.exit(fails.length > 0 ? 1 : 0);
