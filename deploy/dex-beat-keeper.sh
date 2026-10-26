#!/bin/bash
# [agent-zai/W1.2, git-resident since W1.4] one dex beat — mirrors the canonical
# cloud-beat contract: FF-pull the chain home, run deterministic ticks, commit
# machine churn (dex-beat[bot] identity), push FF-only, honest skip on contention.
# GIT-FIRST LAW (owner, 2026-10-17 after the audit-wipe): this script lives IN
# the saos-dex repo (deploy/) — the sandbox may vanish, the chain home cannot.
set -u
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1  # portable: repo root = script parent (W25 anti-hardcode law)

# 0) one beat at a time — any caller, any layer (measured 17.10 20:53:00.011Z:
#    hot-reload double-arm fired two keepers in the same millisecond and the
#    git index.lock race made one "pull failed" honestly skip a clock slot)
exec 9>/tmp/dex-beat-keeper.lock
flock -n 9 || { echo "[dex-beat-keeper] another keeper holds the lock — honest skip"; exit 0; }

# 0.5) [W4-E branch-hardening, agent-z9 2026-10-18] the beat lands on MAIN only.
# Measured: a checkout left on a lane branch (agent/z9/w4-volume) made the beat
# commit into the side branch while `git push origin main` no-oped silently —
# the 05:53Z beat never reached origin, the cloud twin saw no fresh beat and
# double-executed → fork at h501765 → the integrity gate bricked the chain.
# Honest refusal if main cannot be made the current branch.
if [ "$(git branch --show-current)" != "main" ]; then
  if ! git checkout main -q 2>/dev/null; then
    echo "[dex-beat-keeper] HEAD is not main and checkout refused — honest skip (branch-hardening W4-E)"
    exit 0
  fi
fi

# 0.9) UU pre-pull guard [E13, 2026-10-26]: a recurring UU db/state-snapshot.json
#      (leftover conflict while the engine rewrites the snapshot continuously — a
#      stale conflicted blob carries zero truth) bricks BOTH pulls of the W38
#      ladder ("unmerged files" / "not concluded your merge") and the beat
#      honest-skips forever. Resolve --ours + stage, conclude any unfinished
#      merge, and let the ladder below run. All failures stay honest: the
#      existing fail-closed skips remain the last resort.
if git status --porcelain | grep -q '^UU'; then
  git checkout --ours db/state-snapshot.json && git add db/state-snapshot.json \
    && echo "[dex-beat-keeper] UU guard: db/state-snapshot.json resolved (--ours) + staged (E13)" \
    || echo "[dex-beat-keeper] UU guard: resolve failed — pull may honest-skip (E13)"
fi
if [ -f .git/MERGE_HEAD ]; then
  git commit --no-edit -q \
    && echo "[dex-beat-keeper] UU guard: concluded unfinished merge (E13)" \
    || echo "[dex-beat-keeper] UU guard: merge conclude failed — pull may honest-skip (E13)"
fi

# 1) the home is the repo — start from canonical state, never a stale tree
#    W38 (trace 1a1619c722f4fd59) RACE-RECONCILE LADDER: measured this day —
#    local unpushed receipts (own beat, push lost to the fleet pacemaker)
#    made every later `pull --ff-only` diverge → the ENTIRE clock slot was
#    burned on "honest skip" while the chain starved. The step-5 doctrine
#    (rebase favoring incoming, the chain home is canonical) now runs BEFORE
#    the beat too: autostash the dirty runtime state, rebase ours onto
#    origin with -X theirs, retry ff once. Force is still forbidden; if even
#    the ladder loses, the honest skip remains the last resort.
if ! git pull --ff-only -q origin main 2>/dev/null; then
  if git pull --rebase -X theirs --autostash -q origin main 2>/dev/null && git pull --ff-only -q origin main 2>/dev/null; then
    echo "[dex-beat-keeper] ff race — reconciled via rebase -X theirs (W38: the clock never skips for a race)"
  else
    echo "[dex-beat-keeper] pull failed — skipping beat (honest, no force)"
    exit 0
  fi
fi

# 1.2) integrity gate (W1.5; measured a6d7806-class outage 17.10 17:31→20:00Z:
#      conflict markers reached db/state-snapshot.json and red-x4 the beat for
#      4.5h before any diagnosis). Law: the boot arbiter must parse BEFORE we
#      spend a beat. Fail-closed + attach the evidence of the last writer.
if ! bun -e "JSON.parse(require('node:fs').readFileSync('db/state-snapshot.json','utf8'))" >/dev/null 2>&1; then
  echo "[dex-beat-keeper] INTEGRITY-GATE FAIL: db/state-snapshot.json unparseable — beat refused (fail-closed). last commit touching it: $(git log -1 --format='%h %ad %s' --date=iso -- db/state-snapshot.json)"
  exit 2
fi

# 1.5) standby guard (W1.4 cloud-twin law): if a fresh beat already landed
#      (<10min) the cloud twin (saos-runtime dex-beat.yml) or a sibling writer
#      is alive — this layer honestly stands down. git-only check, no API.
LAST=$(git log -1 --format=%ct --grep='^dex-beat:' 2>/dev/null || echo 0)
NOW=$(date +%s)
if [ $((NOW - LAST)) -lt 600 ]; then
  echo "[dex-beat-keeper] fresh beat exists ($(( (NOW-LAST)/60 ))min old) — standby skip (cloud-first law)"
  exit 0
fi

# 2) dependencies (a fresh clone has no node_modules — measured W1.4: the beat
#    died silently in a fresh clone because bun cloud-beat.ts couldn't import)
if [ ! -d node_modules ]; then
  bun install --frozen-lockfile >/dev/null 2>&1 || bun install >/dev/null 2>&1 || { echo "[dex-beat-keeper] bun install failed — skipping beat"; exit 0; }
fi

# 3) evidence schema must exist (Roast-65) before the kernel boots
export DATABASE_URL="file:$PWD/db/dex.db"
if ! bunx prisma db push --skip-generate >/dev/null 2>&1; then
  echo "[dex-beat-keeper] prisma push failed — skipping beat (fail-closed boot will refuse anyway)"
  exit 0
fi

# 3.5) stale-tip rebirth law (W2.0; measured 17.10 23:53Z: the local twin ADOPTED
#      the cloud-advanced canonical snapshot (h452425) while its own evidence tail
#      stopped at h436101 — loadSnapshot demanded LOCAL corroboration for a height
#      the local DB had never seen, priorCount=3609>0 so corroboration-birth was
#      unreachable, and the twin bricked itself after every wipe/outage.
#      Law: the git-committed snapshot IS the canonical truth (cloud-first); when
#      it is strictly ahead of the local evidence tail, the local tail is a dead
#      branch — ARCHIVED (never deleted), a fresh empty DB is born, and the chain's
#      own corroboration-birth doctrine (Roast-65/Z-22) does the honest bounded
#      acceptance. Strict guards: snapshot must be git-CLEAN (came from origin,
#      not a hand-edit) and local tip must be strictly BEHIND the snapshot.
#      (logic lives in deploy/rebirth-check.cjs — quotable, reviewable, tested)
if [ -f db/state-snapshot.json ] && [ -z "$(git status --porcelain -- db/state-snapshot.json)" ]; then
  REBIRTH=$(DATABASE_URL="file:$PWD/db/dex.db" bun deploy/rebirth-check.cjs || echo "rebirth-check failed")
  echo "[dex-beat-keeper] 3.5 rebirth-check: $REBIRTH"
  if echo "$REBIRTH" | grep -q "REBIRTH:"; then
    bunx prisma db push --skip-generate >/dev/null 2>&1 || { echo "[dex-beat-keeper] rebirth push failed — skipping beat"; exit 0; }
  fi
fi

# 4) the beat: deterministic ticks + claims + commit (kernel self-gates the rest)
export GIT_AUTHOR_NAME="dex-beat[bot]"
export GIT_AUTHOR_EMAIL="dex-beat[bot]@agents.roshpinacare-sys"
export GIT_COMMITTER_NAME="dex-beat[bot]"
export GIT_COMMITTER_EMAIL="dex-beat[bot]@agents.roshpinacare-sys"
bun cloud-beat.ts 2>&1 | tail -4
BEAT_RC=${PIPESTATUS[0]}   # the beat's own rc — tail's rc lies (measured W1.4)

# 5) push churn FF-only; on contention, rebase favoring incoming (the chain home
#    is canonical) and retry once — same law as the engine's beat-keeper
if ! git push -q origin main 2>/dev/null; then
  git pull --rebase -q -X theirs origin main 2>/dev/null || exit 0
  git push -q origin main 2>/dev/null || exit 0
fi
echo "[dex-beat-keeper] beat done rc=$BEAT_RC $(date -u +%Y-%m-%dT%H:%M:%SZ)"
exit "$BEAT_RC"   # W2.0 honesty: the service's lastBeat.rc must tell the truth (a halted chain is not a clean beat)
