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
  echo "ARMED-LIVE"
  TS=$(date -u +%FT%TZ)
  echo "{\"ts\":\"$TS\",\"beat\":\"grid\",\"verdict\":\"ARMED-LIVE\",\"dispatch\":204,\"takeover\":$TAKEOVER}" \
    >> "$STEEM/receipts/grid-beat.jsonl"
else
  echo "ARMED-WAITING (dispatch HTTP $HTTP)"
  exit 2
fi
