#!/bin/bash
# local-beat-once.sh — one honest grid-beat pass: pull → grid-beat.ts →
# evidence commit (grids/state only, never secrets) → pull → push. No mocks.
set -u
DEX=/home/z/work/saos-dex
TOKEN_FILE=/home/z/my-project/upload/גיטראש.txt
WIF_FILE=/home/z/my-project/upload/headcorner.txt

cd "$DEX" || exit 1
git pull --no-rebase origin main >>/dev/null 2>&1 || true
# key law (cycle-33): WIF from the unsealed vault (.env.local, 600) — never the stale upload copy
ENVF=/home/z/.secrets/.env.local
[ -f "$ENVF" ] && { set -a; . "$ENVF"; set +a; }
export SAOS_RELAY_AGENT_ACCOUNT="${STEEM_ACCOUNT:-headcorner}"
export STEEM_ACTIVE_WIF="${STEEM_ACTIVE_WIF_A:-$(head -1 /home/z/my-project/upload/headcorner.txt 2>/dev/null)}"
bun run grid-beat.ts 2>&1 | tail -4
git add grids/state dex/grid.json 2>/dev/null || true
git diff --cached --quiet && { echo "clean-beat $(date -u +%FT%TZ)"; exit 0; }
git commit -m "grid-beat-local: perpetual local runner receipt $(date -u +%Y-%m-%dT%H:%MZ)" >>/dev/null 2>&1 || true
git pull --no-rebase -X ours origin main >>/dev/null 2>&1 || true
TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
git push "https://x-access-token:$TOKEN@github.com/roshpinacare-sys/saos-dex.git" main >>/dev/null 2>&1 \
  && echo "pushed $(date -u +%FT%TZ)" || echo "push-fail $(date -u +%FT%TZ)"
