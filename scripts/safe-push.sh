#!/usr/bin/env bash
# safe-push.sh - bounded retry push with rebase recovery. Never force. Fail-honest.
# Usage: bash scripts/safe-push.sh [max_attempts] [branch]
# Exit codes: 0 pushed | 1 fetch/setup failure | 2 rebase conflict | 3 attempts exhausted
# Law: a rejected push must never be swallowed and never be forced. Recover or report red.
set -u
MAX="${1:-5}"
BRANCH="${2:-main}"
ATTEMPT=1
while [ "$ATTEMPT" -le "$MAX" ]; do
  if git push origin "HEAD:$BRANCH" 2>&1; then
    echo "safe-push attempt ${ATTEMPT} OK -> ${BRANCH}"
    exit 0
  fi
  echo "safe-push attempt ${ATTEMPT} rejected - fetch + rebase + backoff"
  sleep $((ATTEMPT * 3))
  if ! git fetch origin "$BRANCH"; then
    echo "safe-push fetch failed - exit 1"
    exit 1
  fi
  if ! git -c rebase.autoStash=true rebase "origin/${BRANCH}"; then
    git rebase --abort 2>/dev/null || true
    echo "safe-push rebase conflict - no force - exit 2"
    exit 2
  fi
  ATTEMPT=$((ATTEMPT + 1))
done
echo "safe-push exhausted ${MAX} attempts - exit 3"
exit 3
