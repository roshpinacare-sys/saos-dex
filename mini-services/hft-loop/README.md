# hft-loop — HFT grid-soldiers organ (W49-c, directive §2)

Continuous high-frequency beat runner around the deterministic core
`src/lib/dex/hft.ts`: Kelly-criterion sizing (fractional, capped), µ-unit
micro-arbitrage between the internal AMM pools and the internal order book,
every op re-entering the engine through its **own public funnel**
(`POST /api/dex/order`, `POST /api/dex/swap`) — so the engine's operator gate
and pre-trade risk cabinet (`src/lib/dex/risk.ts evaluatePreTrade` at
`submitOp`) answer every emission. **No bypass exists in this organ.**

## Run

```sh
bun mini-services/hft-loop/index.ts            # beat loop (default every 1000ms)
bun mini-services/hft-loop/index.ts --once     # one provable cycle, clean exit
curl 127.0.0.1:3049/health                     # honesty panel
```

Health server owns port **3049** (3040 engine · 3045/3046/3048 sister organs).

## Configuration (env)

| var | default | meaning |
| --- | --- | --- |
| `HFT_PORT` | `3049` | health-server port |
| `HFT_ENGINE_URL` | `http://127.0.0.1:3010` | saos-dex Next.js app base URL |
| `HFT_LOOP_MS` | `1000` | beat cadence (≥200ms floor) |
| `HFT_ISSUER` | `hft-soldier` | on-chain identity the soldier trades as (must be funded by the operator — an unfunded issuer sizes to honest `skip-dust`, never fakes capital) |
| `HFT_SEED` | `49` | deterministic PRNG seed (nonce namespace + tie-breaks) |
| `HFT_MIN_EDGE_BPS` | core default (65) | minimum edge; default is fees-aware (pool 30 + book-taker 30 + 5) |
| `DEX_OPERATOR_TOKEN` | *(absent)* | **presence switches observe→trade mode** |

## Modes (the honest two)

* **trade** — token present: emissions POST to the engine with the operator
  header; the engine's own verdict (`ok`/`error`) is what the receipt records.
* **observe** — no token: scanning, sizing and gating still run every beat,
  and the engine itself answers `503 operator-auth-unconfigured`, receipted as
  `submit-reject:*`. If arbs persist the breaker **halts the soldier** — that
  is the truth (an unauthorized soldier is a halted soldier); providing the
  token and calling `rearm` semantics (restart) is the explicit re-arm.

## Fail-honest guarantees

* Engine unreachable / chain halted → the beat idles, health flags it
  (`engineDownTicks`), and **no receipt is written** — a receipt without an
  observation would be fabrication.
* Receipts (one JSON line per tick, `state/hft-receipts.jsonl`) are
  hash-chained by the core: `hash = sha256(prevHash + canonicalJSON)`,
  integers/strings only, allow **and** deny receipted.
* Inventory comes from the engine's wallet truth (balances − locks); emitted
  ops can never exceed it (in-tick conservation in the core).
* Single-flight via O_EXCL lockfile (`state/hft-loop.lock`) with stale-pid
  detection; graceful shutdown releases it.

## Nonce note

The engine intake assigns its own canonical nonce at submit; the op nonce in
a tick receipt is the soldier's deterministic decision-id
(`hft-<runId>-<at>-<seq>-<i>`). Both live: the receipt proves what the
soldier decided, the engine chain proves what it took.
