# SAOS-DEX — Isolated External Audit Package

Self-contained slice of the SAOS-DEX core prepared for an external security audit.
**Zero UI. Zero local DB. Zero dev scripts.** Standalone typecheck:

```bash
bun install        # or npm install / pnpm install
bun run typecheck  # tsc --noEmit (strict)
```

## File map

| File | Production path (`../src/lib/dex/`) | Status |
|---|---|---|
| `src/kernel.ts` | `kernel.ts` | byte-identical |
| `src/book.ts` (`matchBook`) | `book.ts` | byte-identical |
| `src/chain.ts` (`seal`) | `chain.ts` | **1-line adaptation** (DB → evidence-port) |
| `src/relay.ts` (`verifyOnChain`) | `relay.ts` | byte-identical |
| `src/canonical.ts` | `canonical.ts` | byte-identical |
| `src/invariant.ts` | `invariant.ts` | byte-identical |
| `src/amm.ts` | `amm.ts` | byte-identical |
| `src/mm.ts` | `mm.ts` | byte-identical (simulation context) |
| `src/chaos.ts` | `chaos.ts` | byte-identical (inert fault-injection port) |
| `src/evidence-port.ts` | — | standalone no-op stub |
| `src/steem.d.ts` | `../src/types/steem.d.ts` | byte-identical |

The single production delta is `chain.ts` line 13 — see `FIDELITY.diff`.

## Reading order for auditors

1. `AUDIT_SCOPE.md` — scope, assumptions, the 13 invariants to attack.
2. `src/canonical.ts` → `src/kernel.ts` → `src/book.ts` — the deterministic money core.
3. `src/chain.ts` (`seal`) — the cryptographic commitment layer.
4. `src/relay.ts` (`verifyOnChain`, breakers) — the trust-zero-self anchoring layer.
5. `MANIFEST.sha256` / `FIDELITY.diff` — fidelity proof against the production tree.

Companion documents at repo root: `CHAOS_TEST_RESULTS.md` (13/13 PASS),
`LIQUIDITY_STRATEGY.md`, `ARCHITECTURE_ROADMAP.md`, `DEPLOYMENT_CHECKLIST.md`.
