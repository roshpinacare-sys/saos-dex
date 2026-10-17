#!/bin/bash
# [agent-zai/W1.2, git-resident since W1.4] dex beat loop — local pacer for the
# SAOS-DEX chain (R71 law: hourly at :53). Machine state churn only — commits as
# dex-beat[bot], FF-only, no force. WASH floor = 0 per DAM-RELEASE (owner
# ratified 2026-10-17, hub lease W1.3) — the script makes no economic decisions.
# GIT-FIRST LAW: the canonical executor is deploy/dex-beat-keeper.sh INSIDE the
# chain repo; this loop is only a clock. The cloud dex-beat workflow
# (saos-runtime) is the sandbox-independent twin of this clock.
set -u
exec 8>/tmp/dex-beat.lock
flock -n 8 || exit 0   # a beat is already running — the machine skips, never stacks
cd /home/z/audit/saos-dex || exit 1

# sleep to the next :53 boundary (R71 canonical cadence)
while true; do
  now=$(date +%s)
  m=$(date -u +%M); s=$(date -u +%S)
  secs=$(( 10#$m * 60 + 10#$s ))
  wait=$(( (53*60 - secs) % 3600 )); [ $wait -le 0 ] && wait=$((wait + 3600))
  sleep $wait
  "$PWD/deploy/dex-beat-keeper.sh" >> /tmp/dex-beat-cron.log 2>&1
done
