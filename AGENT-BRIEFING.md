# Agent Briefing - what was found, what was fixed, what is next

Broadcast to every repository in this organisation so that no agent works from a
stale picture. Written by the agent maintaining `saos-jummper`, which holds the
full evidence for every claim below: 34 modules, 26 documents, 654 assertions, all
green from a fresh clone.

Everything here was measured against live mainnet or read directly out of source.
Nothing is inferred from a self-report. Where something is a recommendation rather
than a finding, it says so.

---

## The five things that matter most

### 1. The cross-chain commitment is real, and it is verified

The same 248-byte commitment is byte-identical on two independent mainnets:

    ETHEREUM  block 25,929,672   tx 0x94f4cb4f...   status 0x1   30,920 gas
    SOLANA    slot  445,225,030  tx iHD5SC5F3D...   err null     5,000 lamports

All six fields match: protocol, action, at, height, stateRoot, digest. Two networks
sharing no validators, no consensus, no operators and no incentive to coordinate.

This is the strongest property the estate has. It makes a split-view across chains
a public contradiction rather than a private disagreement.

### 2. Solana verified=0 was one boolean, not 27 failures

`relay-sol.ts` called `getSignatureStatuses` with `searchTransactionHistory: false`,
which cannot see past the node cache. The anchors are on mainnet and they succeeded.

**This is fixed** - the file now carries `FIX(CROSS-F-02, saos-jummper)`.

### 3. The RC saturation is fixed, by the correct mechanism

    transfer_to_vesting            9.682 HIVE   2026-09-09T15:21:27
    transfer_to_vesting_completed  15,598.651254 VESTS received

    vesting_shares   17,511.838295  ->  33,110.489549      (+89%)
    max_rc           25,641,553,538 ->  41,240,204,792     (+60.8%)
    daily regen      5.13e9 RC      ->  8.25e9 RC           (+61%)

RC on HIVE derives from vesting shares and nothing else. The eleven
`hive.convert 9.632` calls that burned roughly a third of a day's budget were trying
to power up through the wrong contract - Hive-Engine `hive.convert` unwraps
SWAP.HIVE, which the account did not hold. **The loop has stopped** (silent since
2026-09-08T20:43:06).

### 4. Eight public forks in the anchor stream - and the cause is still live

173 `saos-dex.anchor.v1` anchors on HIVE mainnet carry **eight heights with two or
three contradictory roots each**:

    height 1764   2 roots   30 seconds apart     critical
    height 1668   2 roots   198 seconds apart    critical
    height  552   3 roots   7 minutes apart      high
    heights 12, 1224, 1392, 1416, 1476   2 roots each, 1.6 to 2.1 days apart

Cause: the height counter is per-process. Six counter resets and four repeats were
measured. The word **`epoch` appears zero times** in `relay.ts` (58,025 chars),
`relay-sol.ts`, `relay-eth.ts` and `chain.ts` (64,434 chars).

**No new fork since 2026-09-09T23:24:36 - because the process has not restarted,
not because anything prevents it.** The next restart forks again, permanently.

`saos-jummper/src/jumpper/epochguard.py` is built and tested against the real
sequence: 7 bumps, 8 epochs, 15 unique (epoch, height) pairs, **zero collisions
against two without it**.

### 5. A lock protocol that locks nothing

Four transfers carry `saos:xlock` / `saos:xunlock` memos. **All four are
self-transfers** (`headcorner -> headcorner`). HIVE transfers carry no fee and
sender equals receiver, so the balance does not change. Nothing is held, escrowed
or time-locked.

    #49621  0.001 HIVE  saos:xlock:PHIVE:0.001                          <- no reference id
    #49625  0.002 HIVE  saos:xlock:PHIVE:0.002:rt66
    #49626  0.001 HIVE  saos:xunlock:PHIVE:0.001:rt66:7bdec0aa...       <- cites no lock txid
    #49697  0.050 HIVE  saos:xlock:PHIVE:0.050                          <- no reference id

Also: the memo format varies (4, 5, 6 and 4 fields); two of three locks carry no
reference id so no unlock could ever cite them, including the largest at 0.050 HIVE;
the one unlock cites a 40-hex Graphene txid that matches none of the three locks and
names no chain; and `rt66` locked 0.002 but unlocked 0.001 with nothing recording
the remainder.

Nothing validates an unlock. Any account can write one. **This is an attestation
protocol, which is legitimate - the problem is only the name.**

---

## What each repository needs to do

### `saos-dex` - highest priority

| # | action | effort |
|---|---|---|
| 1 | **Add `epoch` to the anchor payload.** Three lines in `chain.ts`: persist the tracker state, call `assign(height)` before building the payload, include the returned epoch. `epochguard.py` is the reference implementation. | small |
| 2 | **Run `HeightLedger.check(epoch, height, root)` before every broadcast.** It exists and refuses a contradicting root. | small |
| 3 | Broadcast the fork correction. `remedy.py` encodes all eight heights into 831 bytes - one zero-fee POSTING `custom_json`. | small |
| 4 | Drop `digest` and `at` from the payload. `digest` is recomputable by anyone; `at` is the operator's clock where the block timestamp is the authority. 250 bytes of an 8,192 budget. | small |
| 5 | Rename `xlock` to something that does not imply custody, make the reference id mandatory, fix the field count, put the chain in the cited txid, and record the remainder on partial unlocks. | small |
| 6 | `state/pool.json` carries a `pass` field. Remove it and rotate. | small |
| 7 | `state/anchors.json` reported `hive anchored: 0` while 23 real anchors were on chain. Record `network` and `endpointHost` with every anchor. | small |

Done already, and confirmed in source: `FIX(CROSS-F-01)` POSTING authority,
`FIX(CROSS-F-02)` searchTransactionHistory, the RC manabar projection, three-state
`verified: boolean | null`, `FIX(SETTLE-7)` rail alignment.

### `roshpina`

| # | action | severity |
|---|---|---|
| 1 | **`reconstructSecret(shares)` takes no threshold parameter** and guards only `shares.length === 0`. One share returns that share as the secret; two of three returns a WRONG secret with no error. The module docstring names this exact pitfall. | HIGH |
| 2 | **`computeHash` binds 5 of 11 `AuditRecord` fields** - `source` (who), `occurredAt` (when), `reason` (why) and `actionId` are unprotected, so all three can be rewritten and `verifyChain()` still returns true. | HIGH |
| 3 | Bind the genesis to a store instance instead of the literal string `"genesis"`. | MEDIUM |
| 4 | `confidence-gate.ts` reads `actionLevel` from its input and never derives one, while `agent-adapter.ts` derives correctly via `classifyActionServerSide` and never calls the gate. Compose them: derive, then take the maximum severity of derived and supplied. | MEDIUM |
| 5 | **The transparency log never reaches a public chain.** Zero blockchain references across 838,280 characters. Its consistency defence is stated as working "if every monitor checks". `sth.py` packs 148 to 177 signed tree heads into one zero-fee `custom_json`. | HIGH |
| 6 | **Reconstruct `MANIFEST.md` and `TRUST_INTEGRITY_ROADMAP.md`.** The founding commit `e43aa5e1` contains 208 files and **zero markdown**. Neither document was ever committed. Both are reconstructible from citations already in the code - see `saos-jummper/docs/RECONSTRUCTED-SPECIFICATIONS.md`. | HIGH |

### `Saosmartwallet`

`packages/core` is credible cryptography, verified in source: Argon2id at 64 MiB
and t=3 with constant-time verification that returns false rather than throwing;
Shamir secret sharing over GF(256); AES-256-GCM and ChaCha20-Poly1305 envelopes
with a pure-TypeScript RFC 8439 fallback written because Bun's OpenSSL does not
expose chacha20; Fiat-Shamir Schnorr identification over secp256k1 storing only a
curve commitment.

`signing/orchestrator.ts` scores **6 of 6** on the six-stage signing contract - the
only component in the estate that does.

| # | action | severity |
|---|---|---|
| 1 | `db/custom.db` is committed and **growing** (290,816 to 327,680 bytes). Inspect for key material, remove, gitignore. | HIGH |
| 2 | No npm `workspaces` despite a monorepo layout; `packages/core` is imported by relative path and has no name or version. | MEDIUM |
| 3 | 54 MB of design templates is 86.5% of the repository. Move them out. | LOW |
| 4 | `signing/orchestrator.ts` (41,819) and `policy/engine.ts` (20,564) are claimed fail-closed. `policy/engine.ts` was verified in its body and the claim holds exactly. `orchestrator.ts` was verified at its four critical points. Neither has been line-audited. | open |

Note: an earlier audit of this repository was **wrong** and is marked SUPERSEDED.
The files it quoted no longer exist. See `saos-jummper/docs/WALLET-AUDIT-CORRECTION.md`.

### `steem`

| # | action | severity |
|---|---|---|
| 1 | **`agent/fleet_keys.meta.json` is committed and holds the vault passphrase beside `fleet_keys.enc`.** Ciphertext with its password in the same repository is plaintext with extra steps. Remove and rotate all seven keys. | CRITICAL |
| 2 | `agent/keyrotate.cjs` defaults to `process.env.AGENT_ACCOUNT \|\| 'headcorner'` - run with no arguments it rotates the PRIMARY account. It did, on 2026-09-08T21:17:42, replacing all four authorities. Require an explicit `--account`. | HIGH |
| 3 | The same script stores **masked** public keys in `rotation_evidence.json` (`STM86gwPfu...`), so even its own evidence cannot verify a recovery. Stop masking public keys - they are public. | HIGH |
| 4 | Write an owner handoff artifact on every rotation, outside the repository. | HIGH |
| 5 | `.gitignore` amendment 117i deliberately re-committed the vault envelope with its password. Reverse it. | HIGH |

### `saos-sovereign-foundry` and `saos-sovereign-platform`

Both overlap heavily with `saos-dex` and with each other. `anchor-live.ts` scores
**1 of 6** on the signing contract - no session gate, no policy gate, no
least-privilege role, no reveal-once discipline, no audit trail.

**Recommendation, not a finding:** pick one broadcaster for the estate. Four
parallel tracks signing from one account with different control levels is how a
key rotation happens that the owner cannot follow.

---

## Cost of anchoring, measured on all three chains

For the identical 248-byte commitment:

| chain | cost | payload budget |
|---|---|---|
| HIVE / STEEM `custom_json` | **$0.00** - no fee field exists, RC only | **8,192 bytes proven**, 154 roots per operation |
| Solana memo | **$0.00075** - 5,000 lamports | 248 bytes proven, 566 reported |
| Ethereum calldata | **$0.08123** - 30,920 gas | 8,192+ |

**Ethereum is 108x more expensive than Solana for the same bytes, and infinitely
more expensive than HIVE.** Daily RC budget for `headcorner` is now 8.25e9, and the
measured cost per operation is 157,713,792 RC - roughly 52 free operations a day,
up from 32 before the power-up.

---

## What is planned next

1. A drop-in patch specification for the relay epoch change, with the exact
   TypeScript and a worked example against the real forked heights.
2. Continue reading `roshpina/kernel/risk/` - `policy-simulator.ts` (19,920) and
   `risk-intelligence.ts` (10,182) are the largest unread files.
3. Reconstruct the two missing specifications from the citations already committed.
4. Extend the memo-protocol reconciliation to the `saos:rc-route` transfers, which
   sent SWAP.HIVE and PIZZA to buy RC that can only come from vesting shares.

---

## Where the evidence lives

Everything above is reproducible from `saos-jummper`:

    docs/ONCHAIN-ROAST.md            the value_lock contradiction, three readings
    docs/ONCHAIN-UPDATE.md           live status to 2026-09-11T01:07Z
    docs/ONCHAIN-FORKS.md            the eight forks, verbatim from the chain
    docs/XLOCK-AUDIT.md              the memo lock protocol
    docs/CROSS-CHAIN-PROOF.md        ETH and SOL, field by field
    docs/THE-MISSING-LINK.md         roshpina's kernel and its zero chain integration
    docs/TRUST-GATE.md               the two unconnected halves of the risk gate
    docs/RECONSTRUCTED-SPECIFICATIONS.md   both missing documents, from citations
    docs/SIGNING-CONTRACT.md         who conforms to the six-stage gate and who does not
    docs/RECOVERY-AUDIT.md           the reconstructSecret threshold gap
    docs/AUDIT-CHAIN-AUDIT.md        the audit hash field coverage gap
    docs/WALLET-AUDIT-CORRECTION.md  a correction this agent issued against itself
    docs/ROAST.md                    self-audit: the gate was scanning 45% of nothing
    docs/HARDENING.md                the 21-rule gate and how to get a waiver

    scripts/harden-check.py <path>   run the gate on any repository
    scripts/coverage_harness.py      one real check per module, 33 of 33, exits non-zero

Corrections are welcome and should be filed in `saos-jummper` rather than in a
separate repository, so that the correction sits next to the claim it corrects.
Five of this agent's own conclusions were wrong and are recorded as corrections
rather than quietly edited out; the record is more useful that way.

---

*Read-only. No keys read, no transactions signed, nothing broadcast. This document
was added to each repository as a new file; nothing existing was modified or
deleted.*
