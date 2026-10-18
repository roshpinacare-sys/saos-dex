/**
 * [agent-zai/W2.0] stale-tip rebirth check — the operator-reset doctrine,
 * automated and honest. Measured 2026-10-17T23:53Z: the local twin ADOPTED the
 * cloud-advanced canonical snapshot (h452425) while its own evidence tail had
 * stopped at h436101 — loadSnapshot demands LOCAL corroboration for the exact
 * snapshot height, priorCount=3609>0 made corroboration-birth unreachable, and
 * the twin bricked itself after every wipe/outage. Law: the git-committed
 * snapshot IS the canonical truth (cloud-first); when it is strictly ahead of
 * the local evidence tail, the local tail is a dead branch — ARCHIVED (never
 * deleted), a fresh empty DB is born, and the chain's own corroboration-birth
 * doctrine (Roast-65 / Z-22) performs the bounded-trust acceptance.
 * Guards: the snapshot must be git-CLEAN (came from origin, not a hand-edit —
 * the caller checks that) and the local tip must be strictly BEHIND it.
 * Output: one line; contains "REBIRTH:" iff the caller must re-push the schema.
 * Exit is always 0 — this check must never itself fail a beat (fail-open to
 * the chain's own fail-closed boot, which is the deeper law).
 */
const { PrismaClient } = require("@prisma/client");
const fs = require("node:fs");

async function main() {
  const snap = JSON.parse(fs.readFileSync("db/state-snapshot.json", "utf8"));
  const snapH = snap?.state?.height ?? 0;
  if (!snapH) { console.log("no-snapshot-height — no rebirth"); return; }

  const db = new PrismaClient();
  let localMax = -1, count = -1;
  try {
    count = await db.blockHeader.count();
    if (count > 0) {
      localMax = (await db.blockHeader.aggregate({ _max: { height: true } }))._max.height ?? -1;
    }
  } catch { localMax = -1; } // no tables = nothing to corroborate with
  try { await db.$disconnect(); } catch { /* already gone */ }

  if (snapH <= localMax) {
    // [W4-E fork-gap, agent-z9 2026-10-18] EQUAL-HEIGHT FORK — measured today:
    // the cloud twin (memory-chain, its dex.db writes never landed) and the local
    // keeper both built h501765 with different stateRoots; the boot integrity
    // gate refused (fail-closed, correct) and the chain bricked. Signal (git-only):
    // the commit that last wrote the canonical snapshot did NOT include db/dex.db
    // → the snapshot-writer had zero durable db evidence → any local evidence at
    // the same height is a dead fork branch by definition. Law unchanged: the
    // git-committed snapshot IS canonical; archive the fork (never delete), fresh
    // DB, corroboration-birth does bounded acceptance — identical to stale-tip.
    if (snapH === localMax) {
      const { execSync } = require("node:child_process");
      let writerHasDb = null;
      try {
        const c = execSync("git log -1 --format=%H -- db/state-snapshot.json", { encoding: "utf8" }).trim();
        if (c) {
          const files = execSync(`git diff-tree --no-commit-id --name-only -r ${c}`, { encoding: "utf8" });
          writerHasDb = files.split("\n").includes("db/dex.db");
        }
      } catch { writerHasDb = null; }
      if (writerHasDb === false) {
        const stamp2 = new Date().toISOString().replace(/[:.]/g, "-");
        const arch2 = `db/dex.db.pre-fork-${stamp2}`;
        let archived2 = "no-local-db-file";
        try {
          fs.renameSync("db/dex.db", arch2);
          archived2 = `archived fork tip h${localMax} (${count} headers) -> ${arch2}`;
        } catch (e) {
          if (e.code !== "ENOENT") { console.log(`fork archive failed (${e.message}) — refusing rebirth, human decision`); return; }
        }
        console.log(`REBIRTH: fork-at-tip — snapshot h${snapH} (writer committed NO dex.db evidence) ≠ local evidence h${localMax} — ${archived2}; fresh DB born, corroboration-birth will accept the canonical line (bounded trust)`);
        return;
      }
    }
    console.log(`behind-or-equal (snapshot h${snapH} <= local tip h${localMax}) — no rebirth, human decision`);
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const arch = `db/dex.db.pre-rebirth-${stamp}`;
  let archived = "no-local-db-file";
  try {
    fs.renameSync("db/dex.db", arch);
    archived = `archived stale tip h${localMax} (${count} headers) -> ${arch}`;
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.log(`archive failed (${e.message}) — refusing rebirth`);
      return;
    }
  }
  console.log(`REBIRTH: snapshot h${snapH} > local tip h${localMax} — ${archived}; fresh DB born, corroboration-birth will accept (bounded trust)`);
}

main().catch((e) => console.log(`rebirth-check error: ${String(e).slice(0, 140)}`));
