# SAOS-DEX — Isolated External Audit Package

Self-contained slice of the SAOS-DEX core prepared for an external security audit.
**Zero UI. Zero local DB. Zero dev scripts.** Standalone typecheck:

```bash
bun install        # or npm install / pnpm install
bun run typecheck  # tsc --noEmit (strict)
```


> **FIX(Roast-63 · H7) — חותמת-קפיאה כנה:** החבילה-הזו **קפואה** בקומיט `d977a46`
> (SETTLE-7, 2026-09-08). עץ-הייצור **התקדם מאז** (Task 58: CoW/launchpad/protorev;
> Task 61: truth/rail/WBLURT; Roast-63: cow-refund/SOL-verify/bridge-proof) —
> **אל תחשבו-את-החבילה-כנציגת-הייצור-הנוכחי**. אודיט-על-הקוד-החי = מול-`../src/lib/dex/`
> בקומיט-ה-HEAD-של-הריפו (MANIFEST-מקורי של-החבילה נשמר-לראיה-בלבד).

> **SETTLE-7 (2026-09-08) — אריזה-מחדש-מלאה.** החבילה-הקודמת-הכילה-קוד-ישן
> (7/12-קבצים-סטו, כולל-bug-ה-escrow-שעצר-ייצור). מעכשיו: **כל-קובץ-זהה-ביט-מול-ביט**
> לעץ-הייצור פרט-לעיבוד-אחד-מתועד (chain.ts-שורת-הייבוא). ראה `FIDELITY.diff`
> (נעוץ-SHA של-קומיט-האריזה) ו-`MANIFEST.sha256`.

## File map

| File | Production path (`../src/lib/dex/`) | Status |
|---|---|---|
| `src/kernel.ts` | `kernel.ts` | byte-identical |
| `src/book.ts` | `book.ts` | byte-identical |
| `src/amm.ts` | `amm.ts` | byte-identical |
| `src/canonical.ts` | `canonical.ts` | byte-identical |
| `src/invariant.ts` | `invariant.ts` | byte-identical |
| `src/chain.ts` (`seal`) | `chain.ts` | **1-line adaptation** (DB → evidence-port) |
| `src/mm.ts` | `mm.ts` | byte-identical (simulation context) |
| `src/relay.ts` (`verifyOnChain`) | `relay.ts` | byte-identical |
| `src/relay-eth.ts` | `relay-eth.ts` | byte-identical (EIP-1559 live broadcast) |
| `src/relay-sol.ts` | `relay-sol.ts` | byte-identical (SPL-memo anchoring) |
| `src/settle.ts` | `settle.ts` | byte-identical (settlement desk — NEW in SETTLE-7) |
| `src/showcase.ts` | `showcase.ts` | byte-identical (attack-harness proofs — NEW in SETTLE-7) |
| `src/chaos.ts` | `chaos.ts` | byte-identical (inert fault-injection port) |
| `src/evidence-port.ts` | — | standalone no-op stub |
| `src/steem.d.ts` | `../src/types/steem.d.ts` | byte-identical |

The single production delta is `chain.ts` line 13 — see `FIDELITY.diff`.

## Reading order for auditors

1. `AUDIT_SCOPE.md` — scope, assumptions, the invariants to attack.
2. `src/canonical.ts` → `src/kernel.ts` → `src/book.ts` — the deterministic money core (23 ops, escrow-exact).
3. `src/settle.ts` — the three-layer proof (ledger audit / agent exam / real-money).
4. `src/chain.ts` (`seal`) — the cryptographic commitment layer.
5. `src/relay.ts` + `relay-eth.ts` + `relay-sol.ts` (`verifyOnChain`, breakers) — the trust-zero-self anchoring layer over 5 public rails (Steem/Hive/TRON/ETH/SOL).
6. `MANIFEST.sha256` / `FIDELITY.diff` — fidelity proof against the production tree.

Companion documents at repo root: `CHAOS_TEST_RESULTS.md` (coverage now arms all 5 rails),
`LIQUIDITY_STRATEGY.md`, `ARCHITECTURE_ROADMAP.md`, `DEPLOYMENT_CHECKLIST.md`,
`SAOS_BREAKTHROUGH_PROOF.md` (§12 = SETTLE-7 internal-audit round).
