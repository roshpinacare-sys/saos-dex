# AUDIT_SCOPE.md — SAOS-DEX External Security Audit Package
**Version:** 1.0 · **Generated:** 2026-09-07 · **Chain:** `saos-dex.anchor.v1` · **Repo:** `roshpinacare-sys/saos-dex` (main)

> מטרת-החבילה: לאפשר לצוות-ביקורת חיצוני (למשל OpenZeppelin / Trail of Bits)
> לבחון את ליבת-SAOS-DEX בלי רעש-רקע — בלי UI, בלי מסד-נתונים מקומי, בלי
> סקריפטי-פיתוח. החבילה self-contained ו-Typechecks עצמאית (`bun install && bun run typecheck`).

---

## 1. Scope — מה נכלל בביקורת

### 1.1 Primary audit focus (security-critical core)

| File (package) | Production path | Role | Audit weight |
|---|---|---|---|
| `src/kernel.ts` | `src/lib/dex/kernel.ts` | Deterministic state machine: 21 ops, GAS table, integer-only state, hard nonce dedupe, escrow placement, wrap 1:1, bounded harvest | **Critical** |
| `src/book.ts` | `src/lib/dex/book.ts` | Order book + `matchBook` (all escrowed funds move only through this function): maker-price fills, limit/market taker, no self-fill, fail-fast invariants | **Critical** |
| `src/chain.ts` | `src/lib/dex/chain.ts` | Block production (3s), `seal()` every 12 blocks (merkle root over block hashes + canonical stateRoot), fail-fast HALT on invariant violation | **Critical** |
| `src/relay.ts` | `src/lib/dex/relay.ts` | Public-chain anchoring (Steem/Hive custom_json, TRON conditional): `verifyOnChain` read-back, circuit breakers, exponential backoff+jitter, reconciliation, zero secrets in logs | **Critical** |
| `src/canonical.ts` | `src/lib/dex/canonical.ts` | Canonical JSON serialization (recursive key sort, no whitespace), sha256, merkle root (odd-fold), integer guard | **Critical** |
| `src/invariant.ts` | `src/lib/dex/invariant.ts` | Formal assertion primitive (`invariant()` → `InvariantViolation`); fail-fast semantics | **Critical** |
| `src/amm.ts` | `src/lib/dex/amm.ts` | Constant-product pools (integer x·y=k), 30bps fee split (70% LP / 30% treasury), value-preservation check per swap, `minOut` fail-closed | High |

### 1.2 Included for compile-completeness (context, not primary focus)

| File (package) | Production path | Role | Note |
|---|---|---|---|
| `src/mm.ts` | `src/lib/dex/mm.ts` | Autonomous market-maker arena + noise bots (simulation layer) | Generates ops into the mempool; deterministic; excluded from consensus-critical review but included so `chain.ts` compiles and is reviewed in its real runtime shape |
| `src/chaos.ts` | `src/lib/dex/chaos.ts` | Fault-injection port (chaos engineering) | **Inert by construction in production:** `chaosPartitioned()` returns `false` unless an external test tool arms it via `globalThis` in a separate process. Zero keys, zero network, zero `.env` access. Included so auditors can verify the injection surface is read-only and self-expiring |
| `src/evidence-port.ts` | *(no production counterpart — see §4 Fidelity)* | Standalone no-op stub replacing the Prisma DB import | Evidence storage is out of scope; the port proves no consensus path depends on storage return values |
| `src/steem.d.ts` | `src/types/steem.d.ts` | Ambient module declaration (`declare module "steem"`) | Type surface only |

### 1.3 Explicitly OUT of scope

- **UI layer** — React console (`src/app`, `src/components`): presentation only; no authority over state or keys.
- **Local evidence DB** — Prisma/SQLite (`@/lib/db`, `prisma/`): storage of receipts/block headers; wrapped in try/catch, failure-marked (`dbOk`), never blocks consensus.
- **Dev/test tooling** — `scripts/chaos-test.ts`, faucet/reset/bench routes: non-authoritative utilities.
- **Wallet custody layer** — `.env` loading (`loadKeys()` reads `process.env` only; see §2 Assumptions).

---

## 2. Cryptographic & Trust Assumptions (what the audit should take as given)

1. **Key custody (operator responsibility):** the Steem/Hive ACTIVE WIFs used by the relay are assumed to be held in an **HSM or cold-storage signer** in the production deployment; the runtime receives them via environment (`process.env`) in memory only. The audit should verify the *code path* never logs, persists, or transmits key material (we assert it does not — zero secrets in logs/files/state), not the custody itself.
2. **Hash function:** SHA-256 is collision- and preimage-resistant (standard assumption). `stateRoot = sha256(canonicalJSON(state))`; `digest = sha256(canonical(sealInfo))`.
3. **Canonical serialization:** recursive lexicographic key ordering, no whitespace, integers only (`Number.isSafeInteger` enforced at balance mutation). Floats cannot enter state.
4. **Merkle tree:** odd-fold construction (`sha256(a+b)`; unpaired last leaf duplicated). The auditor must verify the odd-fold is implemented identically in all verification tooling (documented in `chain.ts` / `canonical.ts`).
5. **Signing primitive:** `steem.auth.signTransaction` (graphene/secp256k1) with `chain_id` = zeros (Steem) / `beeab0de…` (Hive). TRON identity derived from the same scalar (keccak+0x41 prefix, base58check).
6. **Verification channel:** `verifyOnChain` reads back via **independent public RPC** (Steem: `api.steemit.com`/`api.justyy.com`; Hive: `api.hive.blog`/`api.deathwing.me`; TRON: `api.trongrid.io`). Assumption: the public RPC is not colluding to present a false transaction history. Multi-node racing mitigates single-node compromise.
7. **`custom_json` id:** `saos-dex.anchor.v1` is treated as the protocol namespace; only ops under this id are considered anchors.
8. **Filesystem atomicity:** anchor evidence persistence uses write-to-temp + `rename` (atomic on POSIX). Crash between temp-write and rename loses at most the last unrenamed record (honest loss, never corrupt state).
9. **Time:** `Date.now()` stamps block times/seal timestamps but **never enters state hash inputs** beyond `journal`/`at` fields which are themselves part of state; determinism claim (§3-I7) covers *replay from identical op sequence*, where `nowMs` is supplied by the block builder as a single `t0` per block.

---

## 3. Invariants — what the audit MUST verify (the iron laws)

These are stated in code (`invariant()` calls) and must be verified by review **and** by adversarial reasoning. Violation of any of these at runtime throws `InvariantViolation` and the chain HALTS (fail-fast).

### I1 — Funds conservation (zero-sum per leg)
Every fill/swap moves value only between the named counterparties (plus the explicit 30bps fee split: 70% implicitly to the counterparty-reserves pool in AMM, 30% to `treasury`). No op creates or destroys value outside `wrap_mint` (which is 1:1-backed by locking the native asset — see I6) and `harvest` (bounded by measured fees — see I8).
**Audit target:** `matchBook`, `poolSwap`, `wrap_mint/burn`, `transfer/pay`.

### I2 — Escrow integrity: no negative balances, no lock underflow
For every account and asset, at every state transition: `balances >= 0` and `locked >= 0`, and `avail = bal − locked >= 0` is checked *before* every debit. Placements lock the full obligation upfront (limit); markets check per-fill (fail-closed).
**Audit target:** `kernel.ts` (`addBal/addLock/avail/chargeGas`), `book.ts` invariant `escrow-underflow:*`, `negative-balance:*`.

### I3 — Fills never execute at a price worse than the taker's limit
A limit buy fills only against `maker.price <= limitPx`; a limit sell only against `maker.price >= limitPx`. Enforced by `crosses()` (loop break) **and** by a redundant fail-fast assertion inside the loop (`fill-worse-than-limit`). Makers are always filled at their own quoted price (`maker.price`), exactly — no artificial slippage is inserted by the engine.
**Audit target:** `book.ts` `matchBook`.

### I4 — Maker overfill is impossible
`remaining(maker) >= qty` for every fill leg (`maker-overfill` invariant); maker order closes exactly at `filled == amount`.
**Audit target:** `book.ts`.

### I5 — No self-fill / no wash-trading
A taker never fills their own resting order (`maker.owner === op.issuer` → skip). Order cap (24 live orders per issuer) bounds book pollution.
**Audit target:** `book.ts` (and `kernel.ts` `order`).

### I6 — 1:1 backing of wrapped assets
`wrap_mint(native → wrapped)` locks the native asset and increments `backing[wrapped]`; `wrap_burn` reverses both. Invariant: for every wrapped asset, **`circulating(wrapped) <= backing[wrapped]`**, and burned amount can never exceed backing (`backing-shortfall`).
**Audit target:** `kernel.ts` wrap ops; `DexState.backing`.

### I7 — Determinism / replayability
State transitions are a pure function of (state, op, block-time): integers only, no randomness in `applyOp`/`matchBook`/`poolSwap` (the only randomness — `sysNonce` tags — is mempool-internal and never affects money flow beyond dedupe identity). Replaying the same op sequence produces the same `stateRoot` bit-for-bit. Dedupe: `issuer:nonce` is rejected on replay (hard window, `replay-rejected`).
**Audit target:** `kernel.ts` `applyOp`, `canonical.ts`.

### I8 — Treasury harvest is measured-bounded (no value minting by decree)
`harvest` is treasury-only and capped by `feeMeter` (accumulated *measured* fees); `treasuryProfit` is monotonically non-decreasing; the value ladder lifts `refPrice ≤ 0.5%` per step and is funded **only** from measured fees.
**Audit target:** `kernel.ts` `harvest`, `chain.ts` `ladderCheck`.

### I9 — Seal is a self-consistent cryptographic commitment
Before any seal is published (memory/DB/relay), four fail-closed assertions must hold: (1) window contiguity — `toHeight − fromHeight + 1 == leaves`; (2) `merkleRoot(blockHashes) == root`; (3) `stateRoot` recomputed from current state; (4) `digest == sha256(canonical(sealInfo))`. A failed assertion publishes **nothing** and preserves the window (self-healing next seal).
**Audit target:** `chain.ts` `seal()`.

### I10 — Trust-zero-self verification of anchors
Every broadcast `txid` is read back from independent public RPC and compared bit-for-bit (`height` + `stateRoot`). Mismatch → never counted as verified, recorded with detail in the public evidence file, `ALERT` logged. **"not indexed" is honestly distinct from mismatch** (stays `null`, re-enters reconciliation; never silently "verified").
**Audit target:** `relay.ts` `verifyOnChain`, `verifyRecord`, reconciliation loop.

### I11 — Relay can never harm the chain
`seal()` invokes the relay non-blocking, never throws into the chain (failures are caught; DB/relay failures mark observability flags only). Economic budget conditions (`rc-low`, `unfunded`) are honest waits — they never count as hard failures and never trip circuit breakers. Hard failures trip the per-chain breaker (threshold 4 → OPEN → half-open probe → CLOSED) with exponential backoff + ±20% jitter.
**Audit target:** `chain.ts` `seal()` relay hook; `relay.ts` `relaySeal`, `attemptChain`, breaker functions.

### I12 — Fail-fast on undefined state
Any violated invariant anywhere in `matchBook` or `seal` throws `InvariantViolation`; the tick loop detects it and **halts the chain** (timer cleared, `halted=true` exposed via `/api/dex/state`). The system refuses to continue in an undefined state — operational failures (network/DB) are treated fundamentally differently (degrade, never halt).
**Audit target:** `invariant.ts`, `chain.ts` `tick()`, `book.ts`, `chain.ts` `seal()`.

### I13 — Accounted-supply bound (the auditor's global check)
For every asset: `sum(account balances) + sum(locked) == genesis supply + net wrap_mint − net wrap_burn + net treasury fee accrual`. In particular, no fill/swap path can increase the sum. This is the "sum(user_balances) <= total_escrow" style global conservation check the audit is asked to attempt to break.
**Audit target:** all of `kernel.ts`/`book.ts`/`amm.ts`.

---

## 4. Fidelity — how this package relates to production

- **All audit files are byte-identical to production** (`MANIFEST.sha256` pins exact hashes) with **exactly one exception**: `chain.ts` line 13 — the production import `import { db } from "@/lib/db"` (Prisma evidence storage) is replaced by the standalone `./evidence-port` stub. The exact unified diff is committed as `FIDELITY.diff`.
- The evidence port's call surface matches the production DB models; every call site in `chain.ts` is wrapped in try/catch and cannot affect consensus. Auditors are invited to verify that no consensus path depends on storage return values.
- `scripts/chaos-test.ts` (dev-only) is excluded; the injection gate it uses (`src/chaos.ts`) is included and provably inert in production (§1.2). The chaos suite's results (13/13 PASS, two real bugs caught and fixed pre-production) are documented in `CHAOS_TEST_RESULTS.md` at the repo root.

## 5. Reproduction

```bash
cd audit-package
bun install        # or npm/pnpm install
bun run typecheck  # tsc --noEmit — strict, standalone, zero app deps
```

Verification of fidelity from the repo root:

```bash
diff -u src/lib/dex/chain.ts audit-package/src/chain.ts   # exactly the one import line
sha256sum -c audit-package/MANIFEST.sha256                # (paths are package-relative)
```

## 6. Known limitations (disclosed honestly)

1. **Single-operator anchoring:** anchors are signed by one operator identity (`@headcorner` on Steem; configurable Hive anchor account). Decentralization of signing authority is future work (roadmap M2: Signer/Executor separation + HSM).
2. **Local ledger simulation:** genesis wallets are sovereign bookkeeping (SIM), disclosed as such in the UI and README; wrap 1:1 applies within the ledger. The 1:1 backing discipline governs how real reserves map to wrapped supply when bridges go live.
3. **Hive/TRON rate discipline:** Hive anchors the newest seal only (RC economics); TRON is funding-conditional (0.3 TRX bandwidth floor). Both behaviors are honest-wait, not silent failure.
4. **TRON extra_data verification** depends on node surfacing `extra_data` in read-back; when absent, the result is `confirmed in block · extra_data not surfaced by node` (partial, disclosed) rather than a false "verified".
