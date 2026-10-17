#!/bin/bash
# [agent-zai/W1.2, git-resident since W1.4] one dex beat — mirrors the canonical
# cloud-beat contract: FF-pull the chain home, run deterministic ticks, commit
# machine churn (dex-beat[bot] identity), push FF-only, honest skip on contention.
# GIT-FIRST LAW (owner, 2026-10-17 after the audit-wipe): this script lives IN
# the saos-dex repo (deploy/) — the sandbox may vanish, the chain home cannot.
set -u
cd /home/z/audit/saos-dex || exit 1

# 1) the home is the repo — start from canonical state, never a stale tree
if ! git pull --ff-only -q origin main 2>/dev/null; then
  echo "[dex-beat-keeper] pull failed — skipping beat (honest, no force)"
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
