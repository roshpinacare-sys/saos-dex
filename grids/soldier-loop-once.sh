#!/bin/bash
# soldier-loop-once.sh <account> — one honest soldier beat (Task 36-f)
# ─────────────────────────────────────────────────────────────────────
# Sources the sovereign key env at runtime only (0600, never printed/committed),
# then runs grids/soldier-loop.ts which:
#   · maps account→WIF env with the SAME mapping the house code uses
#     (headcorner→STEEM_ACTIVE_WIF_A/STEEM_POSTING_WIF_A per local-beat-once.sh law);
#   · a soldier with NO available WIF exits 0 writing a BLOCKER receipt — honest, zero fabrication.
# Receipts: grids/state/soldier-<account>.jsonl (hash-chained, secrets-free).
set -u
DEX=/home/z/work/saos-dex
ENVF=/home/z/.secrets/.env.local
ACC="${1:?usage: soldier-loop-once.sh <account> [--dry]}"; shift || true

cd "$DEX" || exit 1
[ -f "$ENVF" ] && { set -a; . "$ENVF"; set +a; }
export SAOS_RELAY_AGENT_ACCOUNT="$ACC"

exec bun run "$DEX/grids/soldier-loop.ts" "$ACC" --once "$@"
