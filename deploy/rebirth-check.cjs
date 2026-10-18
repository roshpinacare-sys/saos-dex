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
    // [W4-E2 fork-signal, agent-z9 2026-10-18 · refined] EQUAL-HEIGHT FORK —
    // measured today: the cloud twin and the local keeper both built h501765 with
    // DIFFERENT stateRoots (oracle-env divergence), boot gate refused, chain bricked.
    // Signal: the exact one the boot gate uses — stateRoot(snapshot) vs the root
    // signed in the local DB header at the snapshot height. Mismatch at equal
    // height = fork: the git-committed snapshot IS canonical (cloud-first law);
    // archive the local fork branch (never delete), fresh DB, corroboration-birth
    // accepts the canonical line (bounded trust). Equal + matching roots = the
    // healthy continuous line — no rebirth, no churn. (W4-E1's writer-has-db
    // signal is superseded: db/*.db is gitignored BY DESIGN, so the writer never
    // carries it in a commit and that signal would fire hourly.)
    if (snapH === localMax) {
      try {
        const { stateRoot } = require("../src/lib/dex/kernel.ts");
        const hdr = await db.blockHeader.findUnique({ where: { height: snapH }, select: { stateRoot: true } });
        if (hdr?.stateRoot) {
          const claimed = stateRoot(snap.state);
          if (claimed !== hdr.stateRoot) {
            const stamp2 = new Date().toISOString().replace(/[:.]/g, "-");
            const arch2 = `db/dex.db.pre-fork-${stamp2}`;
            let archived2 = "no-local-db-file";
            try {
              fs.renameSync("db/dex.db", arch2);
              archived2 = `archived fork tip h${localMax} (${count} headers, root ${hdr.stateRoot.slice(0, 10)}...) -> ${arch2}`;
            } catch (e) {
              if (e.code !== "ENOENT") { console.log(`fork archive failed (${e.message}) — refusing rebirth, human decision`); return; }
            }
            console.log(`REBIRTH: fork-at-tip — snapshot h${snapH} root ${String(claimed).slice(0, 10)}... != local evidence root ${hdr.stateRoot.slice(0, 10)}... — ${archived2}; fresh DB born, corroboration-birth will accept the canonical line (bounded trust)`);
            return;
          }
          console.log(`healthy line (snapshot h${snapH} root == local header root) — no rebirth`);
          return;
        }
      } catch (e) {
        console.log(`fork-check unavailable (${String(e).slice(0, 80)}) — falling through, human decision`);
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
