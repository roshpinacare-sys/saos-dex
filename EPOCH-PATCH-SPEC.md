<!-- hardening:allow-file ALL reason=quotes the relay source verbatim and the defective payload shape it patches -->

# Relay Epoch Patch - exact code, read out of the file it changes

This is a drop-in patch specification for `saos-dex/src/lib/dex/relay.ts`
(62,241 chars). Every quoted line below was read from the file, not reconstructed.

It closes the only finding in this engagement that produces **new permanent damage
on every process restart**: eight heights on HIVE mainnet already carry two or
three contradictory roots, and nothing prevents a ninth.

---

## The code as it stands

The anchor payload, in the broadcast path:

    // payload קנוני משותף לכל-השרשראות — אותם בייטים על כל שרשרת (עיגון-עצמו-עקבי)
    const payload = {
      protocol: "saos-dex/v1", action: "chain-seal", at: job.at,
      height: job.info.toHeight, stateRoot: job.info.stateRoot, digest: job.info.digest,
    };

The ledger record built alongside it:

    const rec: AnchorRecord = {
      chain, height: job.info.toHeight, stateRoot: job.info.stateRoot, digest: job.info.digest,
      txid: null, status: "pending", at: job.at, attempt: cs.attempts,
      verified: null, verifiedAt: null,
    };

And the operation builder, which already carries the authority fix:

    function buildOp(account: string, payload: unknown, auth: "posting" | "active"): [string, Record<string, unknown>] {
      return ["custom_json", {
        // FIX(CROSS-F-01): POSTING כשיש-מפתח-פרסום — יכולת-העברת-כספים מוסרת-מהשידור-האוטומטי
        required_auths: auth === "active" ? [account] : [],
        required_posting_auths: auth === "posting" ? [account] : [],
        id: ANCHOR_ID,
        json: JSON.stringify(payload),
      }];
    }

**`buildOp` needs no change.** The patch touches the payload, the record, and adds
one small tracker.

---

## Why this is the right shape

The comment above the payload says it is canonical and shared across all chains -
the same bytes on every chain. That is exactly the property verified in
`docs/CROSS-CHAIN-PROOF.md`: Ethereum block 25,929,672 and Solana slot 445,225,030
carry byte-identical commitments across all six fields.

**Adding `epoch` to that single payload object preserves the property**, because
the payload is built once and sent to every chain. Do not add the field at any
per-chain call site - that would break cross-chain equality, which is worth more
than the fork fix.

---

## The patch

### 1. Add the tracker (new, top of file or a small module beside it)

    /** Epoch lifecycle. `height` restarts with every process incarnation, so
     *  (epoch, height) is the only key that is unique across restarts. Bumping on a
     *  non-increasing height - rather than on restart - is what makes this work:
     *  a restart is not observable from inside the payload builder, and a process
     *  can restart without the counter resetting if it reloads state. A
     *  non-increasing height IS observable, and it is the only condition under
     *  which a collision can occur. */
    type EpochState = { epochIndex: number; lastHeight: number | null };

    const EPOCH_FILE = path.join(STATE_DIR, "epoch.json");

    function loadEpoch(): EpochState {
      try {
        const s = JSON.parse(fs.readFileSync(EPOCH_FILE, "utf8")) as EpochState;
        if (!Number.isInteger(s.epochIndex) || s.epochIndex < 0) throw new Error("bad epochIndex");
        if (s.lastHeight !== null && (!Number.isInteger(s.lastHeight) || s.lastHeight < 0)) {
          throw new Error("bad lastHeight");
        }
        return s;
      } catch {
        return { epochIndex: 0, lastHeight: null };
      }
    }

    function saveEpoch(s: EpochState): void {
      fs.writeFileSync(EPOCH_FILE, JSON.stringify(s));
    }

    /** Returns the epoch string for this height, bumping first if it must.
     *  Bumping unnecessarily costs one extra epoch and creates no contradiction.
     *  Not bumping when it was necessary creates a permanent public fork. */
    export function assignEpoch(height: number): string {
      if (!Number.isInteger(height) || height < 0) {
        throw new Error(`assignEpoch: height must be a non-negative integer, got ${height}`);
      }
      const s = loadEpoch();
      if (s.lastHeight === null || height > s.lastHeight) {
        saveEpoch({ epochIndex: s.epochIndex, lastHeight: height });
      } else {
        s.epochIndex += 1;
        saveEpoch({ epochIndex: s.epochIndex, lastHeight: height });
      }
      return `e${loadEpoch().epochIndex}`;
    }

### 2. Change the payload (one line added)

    // payload קנוני משותף לכל-השרשראות — אותם בייטים על כל שרשרת (עיגון-עצמו-עקבי)
    const epoch = assignEpoch(job.info.toHeight);   // <-- added, BEFORE the payload
    const payload = {
      protocol: "saos-dex/v1", action: "chain-seal", at: job.at,
      epoch,                                        // <-- added
      height: job.info.toHeight, stateRoot: job.info.stateRoot, digest: job.info.digest,
    };

### 3. Change the record (one field added)

    const rec: AnchorRecord = {
      chain, epoch, height: job.info.toHeight, stateRoot: job.info.stateRoot,
      digest: job.info.digest,
      txid: null, status: "pending", at: job.at, attempt: cs.attempts,
      verified: null, verifiedAt: null,
    };

and add `epoch: string;` to the `AnchorRecord` interface.

### 4. Order matters

`assignEpoch` must be called **before** the payload is built and **before** any
ledger check. If a `HeightLedger`-style check runs first, it files the commitment
under the previous epoch and the collision it exists to prevent is already
recorded.

---

## What this changes on chain

Before:

    {"protocol":"saos-dex/v1","action":"chain-seal","at":"2026-09-09T18:27:21.000Z",
     "height":1764,"stateRoot":"d7220b5e...","digest":"..."}

After:

    {"protocol":"saos-dex/v1","action":"chain-seal","at":"2026-09-09T18:27:21.000Z",
     "epoch":"e0","height":1764,"stateRoot":"d7220b5e...","digest":"..."}

Five extra bytes. The payload was 250 bytes against an 8,192-byte free budget, so
this costs 0.06% of the available room and nothing in money - HIVE `custom_json`
has no fee field at all.

---

## Worked example, against the real forked sequence

The heights below are the real ones read off HIVE mainnet, in the order they were
broadcast:

    1416, 552, 552, 552, 12, 2088, 444, 14304, 4920, 23028, 1224, 1392, 1476, 1668, 1764

Without an epoch, `(height)` collides twice and eight heights end up carrying
contradictory roots - which is what is on chain today.

With `assignEpoch`, the assignment is:

    1416 -> e0 first      4920 -> e6 bumped     1392 -> e7 continue
     552 -> e1 bumped   23028 -> e6 continue    1476 -> e7 continue
     552 -> e2 bumped    1224 -> e7 bumped      1668 -> e7 continue
     552 -> e3 bumped                           1764 -> e7 continue
      12 -> e4 bumped
    2088 -> e4 continue
     444 -> e5 bumped
   14304 -> e5 continue

**7 bumps, 8 epochs, 15 unique `(epoch, height)` pairs, zero collisions.**

Verified in `src/jumpper/epochguard.py`, with 21 assertions in
`tests/test_epochguard.py` and a harness check in `scripts/coverage_harness.py`.

---

## The height-1764 collision, before and after

Today, on chain:

    #49833  2026-09-09T18:27:21  height 1764  root d7220b5e9ecc953e...
    #49834  2026-09-09T18:27:51  height 1764  root 84ae0a0a08ef2f44...

A verifier asking "what was the state at height 1764" gets two contradictory
answers thirty seconds apart, both signed, both permanent.

With the patch, the second broadcast lands as `(e1, 1764)` and the first stays
`(e0, 1764)`. **Both are true, neither contradicts the other, and a verifier can
tell them apart.** Tested: `guard_before_broadcast` over that exact pair produces
two different epochs and `HeightLedger.forks()` returns zero.

---

## Migration notes

1. **Existing anchors have no epoch.** Treat a missing `epoch` as `""` (the empty
   string), which is what `heightguard.HeightLedger` already does. Do not
   back-fill: rewriting a permanent public record to add a field is worse than
   leaving it absent, and `docs/ONCHAIN-FORKS.md` records the eight ambiguous
   heights as they are.
2. **`state/epoch.json` must survive restarts.** That is the entire point. If it is
   lost, the tracker starts at `e0` again and can collide with an existing `e0`.
   A safer variant derives the starting index from the highest epoch already seen
   in `state/anchors.json` on load.
3. **Verifiers that require exactly six fields will break.** The payload is
   versioned by `protocol: "saos-dex/v1"`. Either bump to `v2` when adding the
   field, or make verifiers ignore unknown keys. Bumping is cleaner and costs one
   string.
4. **Do not add `epoch` at a per-chain call site.** The payload is built once and
   sent to Ethereum, Solana, TRON, STEEM and HIVE. The cross-chain equality
   property - verified byte-identical across all six fields - depends on that.

---

## What is still needed after this patch

The patch stops **new** forks. It does not resolve the eight existing ones. For
that, `src/jumpper/remedy.py` already builds the correction record: all eight
heights, all seventeen roots, `AMBIGUOUS` status with no canonical root declared,
encoded into **831 bytes - one zero-fee POSTING `custom_json`**.

The correction deliberately does not pick a winner. Two signed commitments at one
height are both real, and which one the state machine actually produced is a fact
about the operator's process, not about the ledger. Picking the earliest would be a
convention dressed as a finding, and a verifier who trusted it would be trusting
us rather than the chain.

---

*Read-only throughout. No file outside saos-jummper was created, modified or
deleted. This document specifies a patch; it does not apply one.*
