# DEPLOYMENT_CHECKLIST.md — SAOS-DEX Mainnet Launch Checklist
**Version:** 1.0 · **Generated:** 2026-09-07 · **Scope:** production mainnet launch gate

> עקרון-מנחה: כל-סעיף נבדק-מול-מציאות ולא-מול-כוונה. סעיף-חוסם (P0) שלא
> אומת = אין-השקה. כנות-כלכלית (גיבוי 1:1, אפס-הבטחות-תשואה) היא חוק-ברזל
> בכל-שלב — גם-כאן.

**Legend:** `[ ]` pending · `[x]` verified (date + initials) · **P0** launch blocker · **P1** pre-launch hardening · **P2** post-launch continuous

---

## Section A — Security (אבטחה)

### A1. Key custody — P0
- [ ] **A1.1** Steem ACTIVE WIF migrated to HSM or cold-storage signer; the DEX runtime either receives it via a local signer service (M2 roadmap: Signer/Executor separation) or is explicitly accepted as env-memory custody **by written operator sign-off**.
- [ ] **A1.2** Hive ACTIVE WIF — same treatment as A1.1 (independent verification of the anchor account identity: WIF→pub→authority match on public RPC).
- [ ] **A1.3** TRON identity funded **only** up to operational bandwidth floor (~0.3–1 TRX) until TRON anchoring is formally enabled; no treasury value in the hot identity beyond operational need.
- [ ] **A1.4** Zero key material in repo/logs/state files — re-run the secrets scan on the *final* production build (not just the source tree).
- [ ] **A1.5** Key-rotation procedure documented and rehearsed once (WIF compromise playbook: rotate authority, re-derive TRON identity, re-verify anchors).

### A2. Development credentials — P0
- [ ] **A2.1** All development/CI tokens (including the GitHub push token) revoked and re-issued from a scoped, least-privilege policy.
- [ ] **A2.2** `.env` files on production host: permissions `600`, owned by the service account, excluded from backups in plaintext.
- [ ] **A2.3** `vault.json` / `agent/keys/` artifacts confirmed absent from any deployment archive.

### A3. Host & access — P0
- [ ] **A3.1** SSH: key-only auth, no password, no root login; admin access limited to named operators.
- [ ] **A3.2** Firewall: only 443 (gateway) + SSH allowlisted; the DEX daemon binds to localhost/private interface, never public.
- [ ] **A3.3** Service runs under a dedicated unprivileged account; filesystem write access limited to `db/` and `state/`.
- [ ] **A3.4** Automatic security updates enabled OR a documented patch cadence exists.

### A4. Supply & economic safety — P0
- [ ] **A4.1** Wrap 1:1 discipline verified on live state: for every wrapped asset `circulating ≤ backing` (queried via `/api/dex/state` `backing` field).
- [ ] **A4.2** `harvest ≤ feeMeter` verified on live state (treasury profit never exceeds measured fees).
- [ ] **A4.3** Invariant fail-fast path validated in a staging run (deliberate invariant breach → chain HALT + ALERT observed).

---

## Section B — Infrastructure (תשתית)

### B1. RPC endpoints — P0
- [ ] **B1.1** Production anchoring uses pinned, allowlisted RPC endpoints (currently `api.steemit.com`, `api.justyy.com`, `api.hive.blog`, `api.deathwing.me`, `api.trongrid.io`); multi-node racing confirmed active in config.
- [ ] **B1.2** Endpoints monitored for latency/availability; a private/full node provisioned as the growth path (public RPC is the bootstrap posture, disclosed).
- [ ] **B1.3** Timeouts confirmed (12–20s with AbortController/timeout) — no unbounded network waits in the anchoring path.

### B2. Circuit breaker & verification alerting — P0
- [ ] **B2.1** External alert wired on **breaker OPEN** events (`[saos-relay][ALERT] circuit-breaker OPEN …` log lines → monitoring channel: webhook/Telegram/email — operational choice documented).
- [ ] **B2.2** External alert wired on **`verifyOnChain` mismatch** (`stateRoot verification FAILED` lines). Mismatch is the highest-severity signal the system emits.
- [ ] **B2.3** External alert wired on **chain HALT** (`INVARIANT VIOLATION — chain HALTED`) and on `halted: true` in `/api/dex/state`.
- [ ] **B2.4** Alert routing tested end-to-end (inject a test event in staging; confirm delivery).

### B3. Process & data resilience — P1
- [ ] **B3.1** Daemon supervised (systemd/similar): auto-restart on crash; restart drill performed — chain recovers from snapshot + anchor reconciliation (verified working: `restoreRecords` re-arms reconcile queue).
- [ ] **B3.2** `db/` (evidence DB + snapshot) and `state/` (public anchors evidence) included in encrypted backups; restore drill performed once.
- [ ] **B3.3** Disk space monitoring on `db/` (SQLite grows with evidence rows; GC/snapshot bounds state).
- [ ] **B3.4** Clock sync (NTP) confirmed — block times and backoff windows assume monotonic host time.

---

## Section C — Liquidity (נזילות) — per LIQUIDITY_STRATEGY.md

### C1. Phase L1 — initial seed — P0
- [ ] **C1.1** AMM pools seeded with the L1 budget allocation (60/40 base/quote per strategy), LP position records kept offline (treasury-locked, disclosed).
- [ ] **C1.2** Initial order book seeded around the reference price; **spread positive** (no crossed book at genesis).
- [ ] **C1.3** **1:1 backing funded and provable** before the first external user trade: every wrapped unit circulating has its locked native counterpart; proof query documented.
- [ ] **C1.4** Noise bots (arena simulation) **disabled in production** (`arena.enabled=false` via `/api/dex/arena`); the SIM book is retired with real liquidity — disclosed in the UI footer.

### C2. Phase L2 — incentivized market making — P1
- [ ] **C2.1** External MM program funded **exclusively from measured fee revenue** (feeMeter discipline — never from reserves/backing).
- [ ] **C2.2** MM program rules published: quote obligation, spread bands, measured-performance payout, no guarantee of returns.
- [ ] **C2.3** Lending-protocol integrations explicitly **behind the external audit gate** (L3) — not launched before audit sign-off.

---

## Section D — Monitoring & Observability (ניטור)

### D1. System Health — P0
- [ ] **D1.1** `/api/dex/state` long-poll live in the terminal: **TPS** (`opsPerSecRolling`), build ms, `dbOk`, `halted` visible in System Health panel.
- [ ] **D1.2** Relay panel live: per-chain status, breaker states, anchored/verified/mismatches counters, txid explorer links (`steemworld`/`hiveblocks`/`tronscan`).
- [ ] **D1.3** `0 mismatches` baseline recorded at launch; any future mismatch page-worthy (B2.2).

### D2. External monitoring — P1
- [ ] **D2.1** `/metrics` Prometheus endpoint deployed (roadmap M1) with chain height, TPS, breaker state, verify latency, evidence DB health.
- [ ] **D2.2** External uptime probe on the gateway URL (independent of the host itself).
- [ ] **D2.3** Log retention + rotation on the host (dev.log/logrotate), ALERT lines indexed for search.
- [ ] **D2.4** Weekly operational report template: chain height, anchor count, verified count, breaker trips, economic waits, treasury profit vs feeMeter.

---

## Section E — Go/No-Go gate

**Go requires ALL of:**
1. Every P0 item checked with date+initials.
2. External security audit scope delivered (this package) and **sign-off received**.
3. Live chain state: `halted=false`, all breakers `closed`, `mismatches=0`, height advancing, anchors verified via public RPC within the last hour.
4. Liquidity L1 executed and 1:1 backing proof attached to the launch record.
5. Honest-disclosure surfaces live in the UI (SIM vs real, no return promises, evidence links).

**Launch record:** `____________________` (height at launch, anchor txid, operator sign-off)

---

## Current live baseline (at checklist creation — 2026-09-07)

- Chain height: **h4729+** (advancing, 3s blocks) · seals every 12 blocks with public Steem anchoring per seal
- Anchors: **166 total · 164 verified · 0 mismatches** (Steem 165 anchored / 163 verified; Hive 1/1 — RC-rate-limited honest schedule; TRON 0 — funding-conditional, honest wait)
- Breakers: all `closed` · Chaos suite: **13/13 PASS** · Audit package: typecheck clean, byte-identical core (1 documented line)
