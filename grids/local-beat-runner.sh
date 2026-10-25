#!/bin/bash
# local-beat-runner.sh — perpetual loop shell (§2+§5): single-flight beat every interval.
set -u
BEAT_INTERVAL_S=${BEAT_INTERVAL_S:-240}
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG=/tmp/dex-beat.log
echo "runner-armed $(date -u +%FT%TZ) interval=${BEAT_INTERVAL_S}s pid=$$" >> "$LOG"
while true; do
  flock -n /tmp/dex-beat.instance.lock bash "$DIR/local-beat-once.sh" >>"$LOG" 2>&1 || true
  sleep "$BEAT_INTERVAL_S"
done
