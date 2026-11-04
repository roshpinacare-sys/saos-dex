#!/usr/bin/env bash
# beat-loop.sh — sovereign grid beat (restored post-wipe#4, same contract as pre-wipe).
# 1) local judge (custody-vault vs chain)  2) if ALIVE: dispatch Domain dex-grid twin.
# Prints: beat=start judge=[...] dispatch=Domain-dex-grid(HTTP <code>, last=<c> <age>h-old) takeover=<0|1>
# Verdict: ARMED-LIVE / ARMED-WAITING / DISARMED (last line). Never prints key material.
set -uo pipefail
STEEM=/home/z/fleet/steem
ENG="$STEEM/mini-services/saos-engine"
TOKEN_FILE=/home/z/my-project/upload/Titi.secret

JOUT=$(cd "$ENG" && node master-judge.mjs 2>&1 | tail -3)
JUDGE=$(printf '%s' "$JOUT" | grep -o 'VERDICT: CUSTODY-[A-Z]*' | cut -d' ' -f2)
echo "beat=start judge=[$(printf '%s' "$JOUT" | tr '\n' ' ' | cut -c1-200)]"

if [ "$JUDGE" != "CUSTODY-ALIVE" ]; then
  echo "DISARMED"
  exit 1
fi

TOKEN=$(head -1 "$TOKEN_FILE" | tr -d ' \n\r')
# last successful dex-grid run on Domain (age in hours)
LAST=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.github.com/repos/roshpinacare-sys/Domain/actions/workflows/dex-grid.yml/runs?per_page=6&status=success" \
  | python3 -c "
import json,sys,datetime
d=json.load(sys.stdin).get('workflow_runs',[])
print(d[0]['created_at'] if d else 'None')")
if [ "$LAST" = "None" ]; then
  AGE=999
else
  python3 - "$LAST" <<'EOF' > /tmp/beat_age
import sys, datetime
t = datetime.datetime.fromisoformat(sys.argv[1].replace('Z','+00:00'))
print(round((datetime.datetime.now(datetime.timezone.utc)-t).total_seconds()/3600, 2))
EOF
  AGE=$(cat /tmp/beat_age)
fi

HTTP=$(curl -s -o /tmp/beat_disp.out -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/roshpinacare-sys/Domain/actions/workflows/dex-grid.yml/dispatches" \
  -d '{"ref":"main"}')

TAKEOVER=0
python3 - "$AGE" <<'EOF' > /tmp/beat_takeover
import sys
print(1 if float(sys.argv[1]) >= 2 else 0)
EOF
TAKEOVER=$(cat /tmp/beat_takeover)

echo "dispatch=Domain-dex-grid(HTTP $HTTP, last=$LAST ${AGE}h-old) takeover=$TAKEOVER"
if [ "$HTTP" = "204" ]; then
  # R363 · DISPATCH POST-VERIFICATION (2026-11-05, owner execution order):
  # HTTP 204 only means "accepted" — verify a run actually materialized,
  # honest DISPATCH-UNVERIFIED otherwise (never assume, never fabricate).
  VERIFY=DISPATCH-UNVERIFIED
  for i in 1 2 3 4 5 6; do
    sleep 8
    NEW=$(curl -s -H "Authorization: Bearer $TOKEN" \
      "https://api.github.com/repos/roshpinacare-sys/Domain/actions/workflows/dex-grid.yml/runs?per_page=3" \
      | python3 -c "
import json,sys,datetime
d=json.load(sys.stdin).get('workflow_runs',[])
if d:
    t=datetime.datetime.fromisoformat(d[0]['created_at'].replace('Z','+00:00'))
    age=(datetime.datetime.now(datetime.timezone.utc)-t).total_seconds()
    print(d[0]['status'] if age < 300 else 'STALE')" 2>/dev/null)
    case "$NEW" in
      queued|in_progress) VERIFY="DISPATCH-VERIFIED($NEW)"; break ;;
    esac
  done
  echo "verify=$VERIFY"
  echo "ARMED-LIVE"
  TS=$(date -u +%FT%TZ)
  echo "{\"ts\":\"$TS\",\"beat\":\"grid\",\"verdict\":\"ARMED-LIVE\",\"dispatch\":204,\"verify\":\"$VERIFY\",\"takeover\":$TAKEOVER}" \
    >> "$STEEM/receipts/grid-beat.jsonl"
else
  echo "ARMED-WAITING (dispatch HTTP $HTTP)"
  exit 2
fi

# R366 · RECEIPTS PERIODIC PUSH (2026-11-05, owner execution order): receipts
# lived only in the sandbox — a wipe erased the audit trail. Push at most once
# per hour (guard file), FF-only, receipts/state only, never key material.
GUARD=/tmp/.receipts-last-push
NOWS=$(date +%s); LASTS=$(cat "$GUARD" 2>/dev/null || echo 0)
if [ $((NOWS - LASTS)) -ge 3600 ]; then
  date +%s > "$GUARD"
  cd "$STEEM" || exit 0
  if ! git diff --quiet -- receipts/ mini-services/saos-engine/receipts/ mini-services/saos-engine/state/ 2>/dev/null || [ -n "$(git status --porcelain receipts/ mini-services/saos-engine/receipts/ mini-services/saos-engine/state/ 2>/dev/null)" ]; then
    git add receipts/ mini-services/saos-engine/receipts/ mini-services/saos-engine/state/ 2>/dev/null
    git -c user.email=sovereign@fleet -c user.name=sovereign-patrol \
      commit -q -m "patrol receipts sync (R366, hourly) [skip ci]" 2>/dev/null && \
    git push -q "https://x-access-token:$TOKEN@github.com/roshpinacare-sys/steem.git" saos-cockpit 2>/dev/null \
      && echo "receipts=PUSHED" || echo "receipts=COMMITTED-PUSH-DEFERRED"
  else
    echo "receipts=CLEAN"
  fi
fi
