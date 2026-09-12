<!-- hardening:allow-file ALL reason=patch specification quoting the relay source it changes and a recommendation being withdrawn -->

# Relay Patch 2 - one real gap, and one recommendation withdrawn

Every line quoted below was read out of `saos-dex/src/lib/dex/relay.ts`
(71,027 chars) on 2026-09-11. This document does two things: it specifies the one
remaining patch that is clearly right, and it **withdraws a recommendation this
agent made earlier that was wrong.**

---

## First: what already landed, verified in source

The epoch specification published in `RELAY-EPOCH-PATCH.md` was adopted, and
adopted thoroughly:

    interface AnchorRecord {
      chain: ChainName;
      /** EPOCH-PATCH-SPEC: מזהה-גלגול-מונה-הגבהים — (epoch,height) ייחודי-חוצה-ריסטארטים */
      epoch: string;
      height: number;
      ...
    }

    interface SealJob { info: SealInfo; at: string;
      /** EPOCH-PATCH-SPEC: נקבע-פעם-אחת-לעבודה (לא-פר-שרשרת!) — שומר-על שוויון-בייטים */
      epoch: ... }

    // EPOCH-PATCH-SPEC §4: ה-epoch-הוקצה-כבר-ב-relaySeal (פעם-אחת-לעבודה) — כאן-רק-נצרך,
    // לפני-בניית-ה-payload ולפני-כל-רישום
    const epoch = job.epoch;

    // EPOCH-PATCH-SPEC: עיגוני-צי-ידניים מגיעים-מחוץ-למונה-האוטומטי — נושאים-את-ה-epoch-החי-של-הגובה
    chain: "fleet", epoch: assignEpoch(height), height, stateRoot, digest, txid, ...

`epoch` appears 63 times. It is assigned **once per job, not per chain**, which is
the property that keeps the cross-chain byte-equality intact - and the comment says
so explicitly. Manual fleet anchors get their own `assignEpoch(height)`.

**P-01 is closed.** The eight existing forks remain permanent and are recorded in
`forks.json`; no new one can be created.

### And a discrepancy this agent reported is now explained

`state/anchors.json` reported `hive anchored: 0` while 23 real anchors were on
chain. The cause is documented in the file itself:

> txid-אמת-על-Hive מעולם-לא-נרשמו-בפנקס-הציבורי-כי-נתיב-ה-route-עקף-את-rt.records.
> עתה: כל-עיגון-צי-מוצלח (ידני-או-אוטומטי-מ-milestone.ts) נרשם-כ-anchored

**The route path bypassed the ledger writer.** Fixed. This agent reported the
symptom and could not determine the cause; the cause was a missing call, not a
lying counter.

---

## WITHDRAWN: P-07, "drop `digest` and `at` from the payload"

This agent recommended removing both fields, on the reasoning that `digest` is
recomputable by anyone and `at` is the operator's own clock where the block
timestamp is the authority.

**Both halves of that reasoning are wrong, and acting on it would have broken the
strongest verified property in the estate.**

### `at` is what makes the cross-chain proof work

`docs/CROSS-CHAIN-PROOF.md` records that Ethereum block 25,929,672 and Solana slot
445,225,030 carry byte-identical commitments across all six fields:

    protocol · action · at · height · stateRoot · digest

`at` is one of the six. It is set **once per job** and shared across every chain -
which is exactly why the bytes match. The `SealJob` comment states the design:
`נקבע-פעם-אחת-לעבודה (לא-פר-שרשרת!)`.

Remove `at` and the two chains still agree - but a verifier can no longer confirm
that the same instant was committed to both. **The field is not redundant metadata;
it is one of the six things being proven equal.**

The block timestamp is indeed the authority for *when the anchor landed*. `at` is
the authority for *when the state was sealed*, and those are different facts. The
gap between them is itself informative.

### `digest` is part of the sealed commitment, not a convenience hash

`digest` travels inside `SealInfo` alongside `stateRoot`, and both appear in the
committed payload on all three chains. If `digest` were simply
`sha256(stateRoot)` computed at read time it would be redundant - but it is part of
what was sealed and what was verified identical across two independent mainnets.

Changing it now would mean the anchored commitment no longer matches the ones
already on Ethereum and Solana. **That is not a cleanup; it is a fork of the
commitment format, and it would orphan every existing anchor.**

### What survives of P-07

One thing, and it is small: the payload is 250 bytes against an 8,192-byte free
budget, so 3.04% is used. If compaction is ever wanted, the honest route is
`graphene.py`'s tier-E encoding (version, epoch, height, rootB64u), which
`packing.py` measures at 154 roots per operation. That is a **format change with a
version bump**, not a field deletion - and it is optional, since the budget is not
close to binding.

**P-07 is withdrawn. `digest` and `at` stay.**

---

## The one real remaining gap: P-08 is half done

`RelayChainState` carries the endpoint host:

    export interface RelayChainState {
      ...
      // FIX(CROSS-F-04, saos-jummper): הפנקס-הציבורי לא-העיד על-איזו-רשת/שער כל-עיגון
      // פגע — devnet-מול-mainnet היו בלתי-נבדלים. עתה: host בפועל (בדידורג/עודכן בשידור).
      endpointHost: string | null;
    }

**`AnchorRecord` does not.** Its fields, read from source:

    chain, epoch, height, stateRoot, digest, txid, account,
    status, at, attempt, verified, verifiedAt, error

So the *chain state* knows which endpoint it last used, but an individual *anchor
record* does not. If the endpoint changed between two anchors - a failover, a
config edit, a devnet test - the historical record cannot say which endpoint
produced which anchor.

That matters for exactly the question that could not be answered before: **is this
anchor on mainnet?** `docs/CROSS-CHAIN-PROOF.md` records that answering it for
Solana required reading the transaction off the chain, because the books carried no
network identifier. The state-level fix helps going forward; the record-level fix is
what makes history answerable.

### The patch

    interface AnchorRecord {
      chain: ChainName;
      epoch: string;
      height: number;
      stateRoot: string;
      digest: string;
      txid: string | null;
      account?: string;
      status: AnchorStatus;
      at: string;
      attempt: number;
      verified: boolean | null;
      verifiedAt: string | null;
      error?: string;
      // which endpoint actually served this anchor, and whether it was mainnet.
      // Recorded at broadcast time, not inferred later - the chain state can change
      // between anchors, so copying it at write time is the only honest record.
      endpointHost?: string | null;
      network?: "mainnet" | "testnet" | "devnet" | "unknown";
    }

Both fields optional, so existing records in `state/anchors.json` stay valid and no
migration is needed. A record without them is readable as "written before this
field existed", which is true and is better than a back-filled guess.

At the two write sites - the `rec: AnchorRecord` in the broadcast path and the one
in `recordFleetAnchor` - copy from the live chain state:

    endpointHost: cs.endpointHost ?? null,
    network: classifyNetwork(cs.endpointHost),

where `classifyNetwork` returns `unknown` rather than guessing. `src/jumpper/solana.py`
has `is_mainnet_endpoint()` which returns `None` for an unrecognisable host on
purpose, and `netattest.py` classifies hosts; either can be the model. **Do not
default to mainnet.** An endpoint that cannot be classified is `unknown`, and
`unknown` is a finding, not a value to paper over.

Effort: two interface fields and two object literals. No migration, no format
change, no risk to the cross-chain equality - these are ledger fields, not payload
fields.

---

## Scoreboard after this reading

| id | item | status |
|---|---|---|
| P-01 | epoch in the canonical payload | **PRESENT** - payload, AnchorRecord, SealJob and fleet anchors |
| P-02 | POSTING authority | **PRESENT** - `FIX(CROSS-F-01)` |
| P-03 | searchTransactionHistory true | **PRESENT** - `FIX(CROSS-F-02, saos-jummper)` |
| P-04 | RC manabar projection | **PRESENT** - `432000` and `Math.min` |
| P-05 | three-state verified | **PRESENT** - `boolean \| null` |
| P-06 | no silent devnet default | **PRESENT** - `FIX(SETTLE-7)` |
| P-07 | drop digest and at | **WITHDRAWN** - would break the cross-chain proof and orphan every existing anchor |
| P-08 | network and endpointHost per anchor | **PARTIAL** - on `RelayChainState`, not on `AnchorRecord` |
| P-09 | threshold in reconstructSecret | **PRESENT** |
| P-10 | audit hash binds source/occurredAt/reason/actionId | **ABSENT** - roshpina |
| P-11 | mandatory reference id in xlock | **ABSENT** |
| P-12 | vault passphrase out of committed state | **ABSENT** - still committed |
| - | hive anchored:0 versus 23 real anchors | **EXPLAINED AND FIXED** - the route path bypassed `rt.records` |

Six present, one withdrawn, one partial, three absent, one explained.

---

## What this says about the channel

A patch specification with exact quoted source, a worked example and migration
notes was adopted - including the subtlety about assigning the epoch once per job
rather than per chain, which was the one thing that could have broken the
cross-chain equality.

A recommendation stated as a cleanup, without reading how the field was used, would
have destroyed it.

**The difference is not effort. It is whether the recommendation was checked
against the code that consumes the field.** P-07 was not. It is withdrawn here
rather than quietly dropped from the list.

---

*Read-only throughout. No file outside saos-jummper was created, modified or
deleted. This document specifies a patch; it does not apply one.*
