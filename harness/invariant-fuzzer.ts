/**
 * invariant-fuzzer.ts — THE ADVERSARIAL INVARIANT FUZZER · מלחך-אינוואריאנטות-אדיברסרי
 * ═══════════════════════════════════════════════════════════════════════════════
 * EXEC-CD-35: משוכתב-כעוטף-דק סביב harness/battery-core.ts (הסוללה-המוזרקת-
 * תלויות) — אותו-קוד-בדיקה רץ מול-הגרעין-החי ומול-גרסאות-מוטנטיות שלו בערכת
 * ה-mutation (ביקורת-המבקר). ה-CLI, הארטיפקט ואמת-החיים נשמרים; 4 אינוואריאנטות
 * חדשות נולדו: I9 FEE-TRUTH (חישוב-עמלה-עצמאי), I10 AUDITOR-CANARY, I11
 * CANON-CANONICALITY, I12 TRANSFER-EFFECT (+I13 פרימיטיבת-האסרט).
 *
 * רמת-הענקים: Uniswap/Maker רצים invariant-testing (Foundry/Echidna), Jepsen רץ
 * אדיברסרי-על-מסדי-נתונים, Stripe רץ deterministic-simulation. העיקרון:
 * **אף-טענה-עצמית אינה ראיה** — מכונה-תוקפת מנסה לשבור את הגרעין, ובדיקות-
 * בלתי-תלויות מודדות אחרי-כל-פעולה.
 *
 * מצב-הבדיקה: שיבוט-מוזן של מצב-העולם החי (ברירת-מחדל: צליבה-מול-המנוע-החי
 * ב-HTTP + סנאפשוט-קנוני; `--fixture`: בלי-רשת — ל-CI ולערכת-המוטציות).
 * אפס-כתיבה לשרשרת-החיה: applyOp רץ על structuredClone בלבד.
 *
 * ריצה: DATABASE_URL=file:/home/z/my-project/saos-dex/db/dex.db bun harness/invariant-fuzzer.ts [--seed N] [--fixture]
 * יציאה: exit 0 = PASS · exit 1 = הפרה/קריסה (artifact: audit-package/proof-pack/invariant-fuzz.json)
 */
import { applyOp } from "../src/lib/dex/kernel";
import { canon, stateRootOf } from "../src/lib/dex/canonical";
import { ledgerAudit, genesisTotals } from "../src/lib/dex/settle";
import { invariant, InvariantViolation } from "../src/lib/dex/invariant";
import { runBattery } from "./battery-core";
import type { DexState } from "../src/lib/dex/kernel";

/* ── PRNG-לא-בשימוש יותר כאן — הסוללה מגלגלת מטבעות משלה ───────────────────── */
const argv = process.argv;
const argSeedIdx = argv.indexOf("--seed");
const BASE_SEED = Number.isFinite(Number(argv[argSeedIdx + 1])) ? Number(argv[argSeedIdx + 1]) >>> 0 : (Number(new URL(import.meta.url).searchParams.get("seed")) || 0x5a15c0de);
const FIXTURE = argv.includes("--fixture");

/* ── מצב-חי: הסנאפשוט-הגולמי + צליבה-מול-המנוע-החי ─────────────────────────── */
const ENGINE = "http://127.0.0.1:3010/saos-dex/api/dex/state";
const SNAPSHOT = new URL("../db/state-snapshot.json", import.meta.url).pathname;
async function fetchLiveState(): Promise<{ state: DexState; height: number; root: string; engineHeight: number; freshness: number }> {
  let engineHeight = -1;
  if (!FIXTURE) {
    const engRes = await fetch(ENGINE, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json() as Promise<{ ok: boolean; state: { height: number } }>).catch(() => null);
    if (!engRes?.ok) throw new Error(`live-engine-unreachable (${ENGINE}) — המלחך רץ רק-מול-אמת (או --fixture)`);
    engineHeight = engRes.state.height;
  }
  const snapFile = Bun.file(SNAPSHOT);
  if (!(await snapFile.exists())) throw new Error("state-snapshot.json חסר — אין-ארטיפקט-מצב");
  const j = await snapFile.json() as { state: DexState };
  const st = j.state;
  if (!st?.height || !st.balances || !st.credits) throw new Error("bad-snapshot-shape");
  const freshness = engineHeight >= 0 ? engineHeight - st.height : 0; // ≤ seal-window = טרי
  if (!FIXTURE && freshness > 600) throw new Error(`snapshot stale: engine h${engineHeight} vs snapshot h${st.height} (Δ${freshness} > 600)`);
  return { state: st, height: st.height, root: stateRootOf(st), engineHeight, freshness };
}

/* ── הרצה ───────────────────────────────────────────────────────────────────── */
const SEQUENCES = Number(process.env.FUZZ_SEQS ?? 8);
const OPS_PER_SEQ = Number(process.env.FUZZ_OPS ?? 120);

async function main(): Promise<void> {
  console.log(`\n════ ADVERSARIAL INVARIANT FUZZER · seed=${BASE_SEED} · ${SEQUENCES}×${OPS_PER_SEQ} ops + probes + canary + golden-trace ${FIXTURE ? "· FIXTURE-MODE" : "· LIVE-CROSSCHECK"} ════`);
  const live = await fetchLiveState();
  console.log(`${FIXTURE ? "fixture" : "live"}: engine h=${live.engineHeight < 0 ? "n/a" : live.engineHeight} snapshot h=${live.height} (Δfresh=${live.freshness}) root=${live.root.slice(0, 12)}… · wallets=${Object.keys(live.state.balances).length} orders=${live.state.orders.length} pools=${Object.keys(live.state.pools).length}`);

  const out = await runBattery(live.state, { applyOp, canon, stateRootOf, ledgerAudit, genesisTotals, InvariantViolation, invariantFn: invariant }, { seed: BASE_SEED, seqs: SEQUENCES, opsPerSeq: OPS_PER_SEQ });

  const famRec = out.famCount;
  console.log(`\n── FAMILY ACCEPT/REJECT (הדלת מדברת) ──`);
  for (const [f, c] of Object.entries(famRec).sort()) console.log(`  ${f.padEnd(12)} ok=${c.ok} no=${c.no} thr=${c.thr}`);

  const invariants = {
    I1_rejectAtomicity: !out.violations.some((v) => v.code.includes("REJECT-MUTATED") || v.code === "THREW-BUT-MUTATED"),
    I2_creditIdentity: !out.violations.some((v) => v.code.startsWith("I2")),
    I3_transferConserve: !out.violations.some((v) => v.code.startsWith("I3")),
    I4_noNegativeNoFloat: !out.violations.some((v) => v.code.startsWith("I4")),
    I5_engineAuditorClean: out.auditFailures.length === 0,
    I6_determinism: out.determinismOk,
    I7_replayClosed: !out.violations.some((v) => v.code.startsWith("I7")),
    I8_defenseProbes: out.probes.filter((p) => p.pass).length === out.probes.length,
    I9_feeTruth: !out.violations.some((v) => v.code.startsWith("I9")),
    I10_auditorCanary: out.canaryOk,
    I11_canonCanonicality: out.canonPropsOk,
    I12_transferEffect: !out.violations.some((v) => v.code.startsWith("I12")),
    I13_invariantPrimitive: out.probes.some((p) => p.name === "I13 invariant-primitive" && p.pass),
  };

  const report = {
    instrument: "invariant-fuzzer",
    at: new Date().toISOString(),
    mode: FIXTURE ? "fixture" : "live-crosscheck",
    engineHeight: live.height,
    engineRoot: live.root,
    seed: BASE_SEED,
    sequences: SEQUENCES, opsPerSeq: OPS_PER_SEQ,
    totals: { ops: out.summary.ops, accepted: out.summary.accepted, rejected: out.summary.rejected, threw: out.summary.thrown, violations: out.violations.length },
    invariants,
    goldenTrace: out.golden,
    summary: out.summary,
    violations: out.violations.slice(0, 20),
    auditFailures: out.auditFailures.slice(0, 10),
    probesFailed: out.probes.filter((p) => !p.pass),
    verdict: out.verdict,
  };
  const outPath = new URL("../audit-package/proof-pack/invariant-fuzz.json", import.meta.url).pathname;
  const fsMod = await import("fs");
  fsMod.mkdirSync(new URL("../audit-package/proof-pack/", import.meta.url).pathname, { recursive: true });
  fsMod.writeFileSync(outPath, JSON.stringify(report, null, 2));

  if (out.verdict !== "PASS") {
    console.error(`\nVERDICT: FAIL — violations=${out.violations.length} auditFails=${out.auditFailures.length} probesFailed=${report.probesFailed.length}`);
    for (const v of out.violations.slice(0, 10)) console.error(`  ✗ ${v.code} [${v.opType}] ${v.detail.slice(0, 200)}`);
    console.error(`artifact: ${outPath}`);
    process.exit(1);
  }
  console.log(`\nVERDICT: PASS — 13/13 invariants green · artifact: ${outPath}`);
  process.exit(0);
}

await main();
