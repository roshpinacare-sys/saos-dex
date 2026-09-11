<!-- hardening:allow-file ALL reason=maps live defects to existing controls, quoting both sides -->

# Controls That Already Exist - every live defect has a solution somewhere in the estate

Read out of four previously unread kernel files on this pass:

    kernel/risk/policy-simulator.ts          19,854 chars / 481 lines
    kernel/risk/risk-intelligence.ts         10,129 chars / 222 lines
    kernel/escrow/threshold-approval.ts      15,372 chars / 390 lines
    kernel/orchestrator/execution-workflow.ts 13,171 chars / 411 lines

The conclusion is now strong enough to state flatly: **almost nothing in this
estate is missing a control. What is missing is the wiring.** Every live defect
measured on mainnet has a working implementation somewhere in the same set of
repositories, written by the same author, and none of them is connected to the code
that broadcasts.

---

## The mapping

| live defect, measured on chain | control that already exists | where |
|---|---|---|
| weave seal broadcast **10 times** (same net/seq/root); convert loop **11 times** over 31 hours, ~1.73e9 RC | **Lease / heartbeat**: a worker claims a workflow, and if the lease expires another can claim it. Prevents duplicate processing **without an external scheduler**. Plus chain-aware failure counting across the full retry ancestry | `execution-workflow.ts`, `retry-policy.ts`, `execution-scheduler.ts` |
| 8 heights carrying contradictory roots because the counter restarts per process | **Durable state machine**: planned -> approved -> running -> evidence_collected -> settled -> proved, with every transition appending an immutable hash-linked run-log entry, and `validateAllExecutionChains()` returning false if ANY chain is broken | `execution-workflow.ts` |
| `confidence-gate.ts` trusts a caller-supplied risk level | **Three independent server-side derivations** - see below | `risk-intelligence.ts`, `policy-simulator.ts`, `agent-adapter.ts` |
| `value_lock` attested "LP locked permanently, fees keep flowing" while its own state file said `lpLocked: false` | **Signed single-use short-lived approval tokens** with a nonce set, replay rejected fail-closed, and a multi-party N-of-M validator that is implemented rather than stubbed | `threshold-approval.ts` |
| anchor ledger reported `hive anchored: 0` while 23 real anchors were on chain | **Per-policy visibility**: each policy's decision captured separately so a caller sees WHICH policy denied, not just "denied somewhere"; plus `compareScenarios()` for governance drift | `policy-simulator.ts` |
| no public timestamp on any receipt or log head | **nothing** - this is the one genuine gap | `saos-jummper/sth.py`, `witnessbridge.py`, `pipeline.py` fill it |

Five of the six have a working implementation in the estate. The sixth is what this
repository was built for.

---

## The escalation-only rule is implemented three times, and missing once

This settles the question raised in `docs/TRUST-GATE.md`. It is not a design choice
that `confidence-gate.ts` trusts its input - it is an outlier.

### 1. `risk-intelligence.ts` - monotonic by construction

Its header, verbatim:

> `effectiveApprovalClass` - **MONOTONIC: it can only escalate above the static
> floor, never below it. A trusted actor lowers the informational score but can
> NEVER weaken the gate.**

The join is `maxApproval()`, and the file cites **`§2.C-8`** of
`TRUST_INTEGRITY_ROADMAP.md` for it. That is a roadmap section recovered for the
first time in this pass - see the reconstruction note below.

Four signal families are fused: static floor from the taxonomy, behavioural from
`scoreContextualRisk`, reputation from the track-record score, and optional drift
from `scoreRiskDrift`. The output is a reproducible 0-100 `riskScore` plus
`factors[]` giving the explainable contribution of every signal.

> Real intelligence is not a bigger black box; it is FUSING multiple independent
> signals into one coherent, explainable judgement.

### 2. `policy-simulator.ts` - ignores the client's claim outright

Its header, verbatim:

> **SERVER-SIDE CLASSIFICATION: the client's claimed riskClass is ignored; the
> server re-classifies from toolId via `classifyActionServerSide` (same chokepoint
> as the live path).**
>
> **FAIL-CLOSED: invalid intent -> throws; policy throw -> treated as deny; unknown
> risk class -> deny.**

And it is PURE: zero side-effects, no audit writes, no workflow creation, no store
mutation. Which means an agent can ask "will this pass?" before doing it, and the
answer comes from the same classification path the live decision uses.

### 3. `agent-adapter.ts` - derives and overrides

Imports and calls `classifyActionServerSide` (2 references). Its invariants state
that an undefined or unmapped risk class resolves to deny.

### The outlier

`confidence-gate.ts` reads `input.actionLevel` and never derives one.
`classifyAction` appears exactly once in that file, inside a comment showing the
intended caller usage. And `agent-adapter.ts` never calls the gate - `confidenceGate`
appears zero times in it.

**So three components derive server-side and one trusts its input, and the three are
not connected to the one.** `src/jumpper/riskgate.py` implements the composition:
derive, then take the maximum severity of derived and supplied, so a caller can
escalate but never de-escalate. That is `maxApproval()` applied at the gate
boundary, and it is 32 assertions of work rather than a redesign.

---

## A recovered roadmap section

`risk-intelligence.ts` cites **`§2.C-8`** for the monotonic `maxApproval()` join.

`docs/RECONSTRUCTED-SPECIFICATIONS.md` previously established §2.A (cross-log
federation and trust mesh, sub-steps 3-A-1 and 3-A-2), §2.B (selective disclosure,
item 2), §2.D (witnesses, at least 12 items, of which 10 and 12 are identified), and
§4 of the MANIFEST (primitives, item 4 being cost arbitrage).

**§2.C was entirely unknown.** It is now known to exist, and item 8 is the monotonic
approval join. Given that §2.A is federation, §2.B is disclosure and §2.D is
witnesses, §2.C is most plausibly the risk-assessment section - which is consistent
with `risk-intelligence.ts`, `contextual-risk.ts`, `risk-drift.ts` and
`actor-baseline.ts` all existing and none of them citing any other section.

That is an inference, and it is labelled as one. The established fact is narrower:
§2.C exists and item 8 is the monotonic join.

---

## `threshold-approval.ts` - the control the value_lock claim needed

    THRESHOLD_TOKEN_TTL_MS = 10 * 60 * 1000

Safe-style N-of-M authority approval before large value moves. In v142 it is 1-of-1:
the settlement authority pre-authorises a specific release amount for a specific
agreement via a signed HMAC token, single-use with the nonce tracked in a store, and
short-lived.

    1. generateApproval(agreementId, tenantId, maxAmount, approvedBy, signer)
    2. caller includes the token in the release / partialRelease call
    3. SettlementService calls validateAndConsumeApproval(token, store) before executing
    4. consumed tokens go into a nonce set - replay is rejected, fail-closed

And `validateMultiPartyApprovals` plus `MultiPartyThresholdConfig` and
`MultiPartyThresholdError` are exported, so the N-of-M path is implemented rather
than sketched. The extension path is stated: swap `InMemoryThresholdApprovalStore`
for `PgThresholdApprovalStore`.

**Contrast with what happened on chain.** The `value_lock` attestation published
"LP locked permanently - fees keep flowing" with `lockedSaos: 0.166` and
`depthBefore: 106.868`, while `state/pool.json` said `lpLocked: false`,
`lockedAt: null`, `tvlMicroUsd: 0` and `feesGeneratedMicroUsd: 0`, and the live
Hive-Engine balance was 0.19776475 SAOS against a claimed depth 540 times larger.

There was no token, no authority, no nonce, no TTL and nothing comparing the claim
to the state before signing. `src/jumpper/attestation.py` now refuses that exact
attestation on eight contradictions - but the kernel already had the stronger
pattern, and it was not used.

---

## `execution-workflow.ts` - the control the loops needed

    planned -> approved -> running -> evidence_collected -> settled -> proved
    planned -> rejected   approved -> rejected
    running -> failed     evidence_collected -> failed   settled -> failed

`VALID_TRANSITIONS` and `VALID_TRANSITION_SET` are exported and frozen, so an
illegal transition cannot be expressed. `TERMINAL_STATUSES` is exported. Every
transition appends an immutable hash-linked run-log entry, `verifyRunLog()`
recomputes the chain, and `validateAllExecutionChains(store)` returns false if any
single chain is broken.

**The lease and heartbeat mechanism is the specific control that was missing on
2026-09-07 and 09-08.** A worker claims a workflow; if the lease expires another
worker can claim it; duplicate processing is prevented without an external
scheduler.

Meanwhile, on mainnet: one `saos.weave.v1` seal with net `saos-net/0`, seq 2 and
root `a62ba761...` was broadcast **ten times** over 22 hours, and `hive.convert`
with quantity 9.632 was broadcast **eleven times** over 31 hours at a measured
157,713,792 RC each. Neither had a lease, a claim, a nonce, or a cumulative budget.

`src/jumpper/budget.py` now stops that class of defect - replaying the real
eleven-call loop allows one and denies ten, recovering 1,577,137,920 RC. But the
kernel already had the durable-workflow version of the same control, with state
transitions and a run-log, and it was not in the broadcast path.

---

## What to do with this

The recommendation is not to build anything new. It is to import what exists.

| # | action | effort |
|---|---|---|
| 1 | Put `execution-workflow.ts` lease and heartbeat semantics in front of the relay broadcast path, or port `budget.py`'s repeat guard. Either stops the loop class permanently | medium |
| 2 | Compose `confidence-gate.ts` with `classifyActionServerSide` the way `policy-simulator.ts` already does, or apply `risk-intelligence.ts`'s `maxApproval()` at the gate boundary | small |
| 3 | Require a `threshold-approval.ts` token before any value-bearing attestation is signed, and derive the attestation text from the state it describes (`attestation.py` is the reference) | medium |
| 4 | Use `validateAllExecutionChains()` at startup. A relay that begins with a broken run-log should refuse to broadcast | small |
| 5 | Add `epoch` to the anchor payload - `docs/RELAY-EPOCH-PATCH.md`, exact lines | small |
| 6 | Anchor the audit head and the transparency-log signed tree heads publicly. This is the one gap with no existing kernel control | small, and already built |

Items 2, 4 and 5 are small. Item 6 is already implemented and tested in this
repository.

---

*Read-only throughout. No file outside saos-jummper was created, modified or
deleted. No keys read, no transactions signed, nothing broadcast.*
