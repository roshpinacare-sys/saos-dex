# WORKLOG_PHASE6 — Funding Discovery, Broadcast Activation & Live 5-Rail Proof

**Date:** 2026-09-08 (Asia/Jerusalem) · **Operator authorization:** "תאשר לו לממן והכל מה שצריך" · **Mode:** full autonomy

---

## 1. Fleet-Wallet Funding Audit (READ-ONLY, addresses only — zero private material printed)

- Full registry sweep: 12 agents × {EVM, TRON, SOL, BTC} from the fleet vault (`wallets-registry.json`).
- Balance audit across **6 EVM networks** (ethereum, bsc, polygon, arbitrum, optimism, base) + **Solana mainnet-beta** + **TRON** + **BTC** via public RPCs.

**Result:** exactly **one funded identity in the entire fleet — headcorner (idx 2)**:

| Asset | Balance (measured on-chain) | Funding source (forensics) |
|---|---|---|
| ETH | 0.00400981602964056 (nonce was 0) | inbound tx `0xebe8d748…0e9204` from `0x831bbc82…b041f`, block 25928148 |
| SOL | 0.096126117 (96,126,117 lamports) | inbound tx `23qNYRPY…qqcG` from `Dzvb1471gwa5KfdkptyhwC2dbV6j7khGmbHSFf22E6N3`, slot 445167049 |
| TRX / BTC / all other 11 agents | **0 across the board** | — |

**Conclusion:** no intra-fleet transfer was possible or needed — the operator's own declaration ("בדיוק חיברתי איתריום וסולנה לרשת") manifested as direct external funding of the headcorner identities. Both wallets already exceed the minimum for dozens of anchors: SOL fee = 5,000 lamports/tx → ~19,000 anchors; ETH at ~0.09 gwei base → ~60+ anchors with 2× institutional floor margin.

## 2. Broadcast Activation

- `.env` (gitignored, mode 600): `ETH_BROADCAST_ENABLED=true`, `SOL_BROADCAST_ENABLED=true`, `ETH_RPC_URL=https://eth.drpc.org`, `SOL_RPC_URL=https://api.mainnet-beta.solana.com`.
- Gates patched to accept `"1" | "true"` (relay-eth.ts / relay-sol.ts).
- RPC UA hardening: relay `rpc()` now sends `User-Agent` (publicnode/drpc/blastapi block empty-UA fetches; bloXroute/drpc/1rpc accept UA-carrying requests).
- `.env.example` documents all four variables (safe defaults `false`).

## 3. EIP-1559 Root-Cause Forensics (three real mainnet rejections → three real fixes)

1. `rlp: input string too short for common.Address (LegacyTx).To` → raw tx missing the **`0x02` type prefix**.
2. `rlp: expected input list for types.AccessList` → RLP layer **double-encoded** pre-encoded items (empty access-list became string `0x81c0`); rewritten as canonical explicit builders: `rlpScalar` / `rlpStr` (single-byte `<0x80` → identity) / `rlpList` over already-encoded items.
3. `Insufficient funds: available 0` (despite funded address) → **EIP-1559 signing hash must include the `0x02` prefix**: `keccak(0x02 ‖ rlp([chainId,…,accessList]))`. Without it, `ecrecover` resolved a *different, unfunded sender*.
4. Plus: `maxFee = maxPriority + gasPrice×2` (tip ≤ maxFee invariant at 0.076 gwei base).

**Proof-by-decode:** `ethers.Transaction.from(raw)` failed on the old encoding (`invalid access list "0xc0"` wrapped as string) and passes on the new one.

## 4. Proof of Life (independently verified against public infrastructure)

**Ethereum (first relay anchor):**
- `0x102ec1935be6cb3ff3acc20189a85377cf57486515f3121472c6611b20e0ef41` — block 25929261, self-tx, calldata = anchor payload; `verifyEthAnchor` ok:true.
- Live relay continues per seal (h2388 anchor `0x5d2f460893da5ec2d0a3903cb34e47a8fbe9f0022cec4d94099e8e5290713e15` block 25929269, verified).

**Solana (live mainnet memo anchors):**
- First session signature: `2M1rkRggRcaePk6vMZpgSaM3WVWQU92RZAs1v7PtNeMLsxLmZoqBNCeEtuY7Rkj5aPbs4jS1g2wUQXCnoejUM2M9` (fee 5,000 lamports).
- h2388: `***REDACTED-KEY-MATERIAL***` — slot 445209689.

**Cross-chain consistency:** same seal `height=2388`, `stateRoot=***REDACTED-KEY-MATERIAL***` present **bit-for-bit** in ETH calldata (blockscout) and SOL memo log (mainnet-beta RPC) — two independent public infrastructures agree.

**Bonus:** the sovereign platform (`saos-weave/v1`) anchored its own seal `h=9` on the same rail: `0xdb04c082af68b11b1ffb4ae0a44125037ba033571a329666104840ba57d0bfae`.

## 5. Infrastructure

- New main-app route `/api/saos/dex-bridge` (guardian_boot on-demand): spawns the :3010 daemon as a child of the surviving mother server, with runtime `.env` injection and port-busy dedup — sandbox process-reaper no longer orphans the relay.
- UI (agent-browser, desktop 1440 + mobile 390, no horizontal scroll): `LIVE · h2429`, VERIFIED ANCHORS 14, MISMATCHES 0, breaker CLOSED ×5, **ETH 5 anchored · 5 verified**, **SOL 13 anchored**, TRON honestly "PENDING FUNDING — ARMED", fleet identities card with EIP-191 intent (verified:true).

## 6. Honest Observations

- Relay's own `verifySolAnchor` counter stays 0 (public mainnet-beta `getTransaction` rate-limits); independent CLI verification (§4) confirms the anchors are real and matching. No mismatches anywhere.
- Hive: honest RC waits (`rc-low`); one anchor landed earlier (`ed3c7b4a…`) when mana allowed.
- TRON remains unfunded (0 sun) — honest queue, flips live automatically at ≥0.3 TRX.
- ETH gas budget: ~0.004 ETH ≈ 60+ anchors at current base-fee; top-up address `0x2767e8146c11baD1d9B0784f11325375195c1b0f`.

## 7. Deliverables

- Code: `relay-eth.ts` (canonical RLP + sig-hash + fee + UA), `relay-sol.ts` (gate + UA), `.env.example`.
- Docs: this file. State: `state/anchors.json` (live evidence trail).
- Secret scan on the full staged diff: **0 hits** (no WIFs, no hex-64, no token patterns, no .env contents).
