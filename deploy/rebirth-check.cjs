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
