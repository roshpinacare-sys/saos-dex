#!/bin/bash
# soldier-loop.sh <account> — perpetual soldier loop (Task 36-f)
# flock /tmp/soldier-<account>.lock · interval SOLDIER_BEAT_INTERVAL_S (default 900s)
# Liveness law: does NOT touch /tmp/dex-beat.instance.lock (owned by local-beat-runner) and kills nothing.
set -u
ACC="${1:?usage: soldier-loop.sh <account>}"
DIR="$(cd "$(dirname "$0")" && pwd)"
INTERVAL="${SOLDIER_BEAT_INTERVAL_S:-900}"
LOG="/tmp/soldier-${ACC}.log"
echo "soldier-runner-armed $(date -u +%FT%TZ) account=${ACC} interval=${INTERVAL}s pid=$$" >> "$LOG"
while true; do
  flock -n "/tmp/soldier-${ACC}.lock" bash "$DIR/soldier-loop-once.sh" "$ACC" >>"$LOG" 2>&1 || true
  sleep "$INTERVAL"
done
