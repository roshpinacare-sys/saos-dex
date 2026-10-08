/**
 * restore-drill.ts — INSTRUMENT #19 · תרגיל-שחזור-אמת: RTO/RPO מדוד (EXEC-CD-37)
 * ═══════════════════════════════════════════════════════════════════════════════
 * הענקים לא מסתפקים בגיבוי — הם מבצעים **חזרות-שחזור** (restore rehearsals).
 * EXEC-CD-34 תיעד חומה-כנה: "RPO ≤ 48s הוא חוזה-קדנס, הזנב-הבלתי-נשטף בין-
 * שטיפות עוד לא נמדד" — המכשיר הזה סוגר אותה במדידה-אמת:
 *
 *   1. מעתיק state-snapshot.json + tape.jsonl + dex.db → תיקיית-שחזור טרייה (אף-
 *      נגיעה במקור — קריאה-בלבד).
 *   2. שלמות-DB: PRAGMA integrity_check על-העותק + מספר-שורות-ב-blockHeader.
 *   3. קשר-צופן↔DB: stateRoot(snapshot.state) === blockHeader.stateRoot בגובה-
 *      ה-snapshot (בדיוק-הבדיקה fail-closed של loadSnapshot — כאן ככלי-צד-שלישי).
 *   4. חי-פרובה מול-המנוע (127.0.0.1:3010/saos-dex/api/dex/state — קריאה): פער-
 *      גבהים = הזנב-שהיה-אובד-לו-הדיסק-מת-עכשיו (RPO-זנב במדידה), גיל-ה-snapshot.
 *   5. RTO = זמן-מודד מהעתקה ועד-אימות-אחרון.
 *
 * יציאה: 0=PASS · 1=FAIL. ארטיפקט: audit-package/proof-pack/restore-drill.json
 * ריצה: bun scripts/restore-drill.ts [--quiet]
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { stateRootOf } from "../src/lib/dex/canonical";

const ROOT = new URL("..", import.meta.url).pathname; // saos-dex/
const ARTIFACT = path.join(ROOT, "audit-package/proof-pack/restore-drill.json");
const QUIET = process.argv.includes("--quiet");
const ENGINE = "http://127.0.0.1:3010/saos-dex/api/dex/state";

const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
const check = (name: string, ok: boolean, detail: string): void => {
  checks.push({ name, ok, detail });
  if (!QUIET) console.log(`  ${ok ? "✓" : "✗"} ${name} — ${detail}`);
};

async function main(): Promise<void> {
  const t0 = Date.now();
  const restoreDir = `/tmp/saos-restore-drill-${Date.now()}`;
  fs.mkdirSync(restoreDir, { recursive: true });

  /* 1. העתקה-קרה (המקור קריאה-בלבד) */
  const snapSrc = path.join(ROOT, "db/state-snapshot.json");
  const dbSrc = path.join(ROOT, "db/dex.db");
  const tapeSrc = path.join(ROOT, "db/tape.jsonl");
  check("source-exists", fs.existsSync(snapSrc) && fs.existsSync(dbSrc), `snapshot=${fs.existsSync(snapSrc)} db=${fs.existsSync(dbSrc)} tape=${fs.existsSync(tapeSrc)}`);
  if (!fs.existsSync(snapSrc) || !fs.existsSync(dbSrc)) process.exit(1);
  fs.copyFileSync(snapSrc, path.join(restoreDir, "state-snapshot.json"));
  if (fs.existsSync(tapeSrc)) fs.copyFileSync(tapeSrc, path.join(restoreDir, "tape.jsonl"));
  fs.copyFileSync(dbSrc, path.join(restoreDir, "dex.db"));

  /* 2. פרק-ה-snapshot + שלמות-צורה */
  const raw = JSON.parse(fs.readFileSync(snapSrc, "utf8")) as { version: number; savedAt: string; state: { height: number; balances: Record<string, Record<string, number>>; pools: unknown } };
  const st = raw.state;
  check("snapshot-shape", typeof raw.version === "number" && st.height > 0 && !!st.pools && !!st.balances, `version=${raw.version} height=${st.height}`);
  const savedAtMs = Date.parse(raw.savedAt);
  const ageSec = Math.round((Date.now() - savedAtMs) / 1000);

  /* 3. stateRoot מחושב מה-DB-עותק — הקשר-צופן↔DB */
  let dbRoot: string | null = null, integrity = "not-run", headerRows = -1;
  try {
    const db = new Database(path.join(restoreDir, "dex.db"), { readonly: true });
    integrity = (db.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
    headerRows = (db.query("SELECT COUNT(*) c FROM blockHeader").get() as { c: number }).c;
    const hdr = db.query("SELECT stateRoot FROM blockHeader WHERE height = ?").get(st.height) as { stateRoot?: string } | undefined;
    dbRoot = hdr?.stateRoot ?? null;
    db.close();
  } catch (e) {
    check("db-open", false, String(e).slice(0, 120));
  }
  check("db-integrity", integrity === "ok", `integrity_check=${integrity} · blockHeader rows=${headerRows}`);
  const computedRoot = stateRootOf(st);
  const rootMatch = dbRoot !== null && dbRoot === computedRoot;
  check("stateRoot-snapshot-vs-dbHeader", rootMatch, `height=${st.height} · db=${dbRoot?.slice(0, 16) ?? "absent"}… vs computed=${computedRoot.slice(0, 16)}…`);

  /* 4. פרובה-חי למנוע — RPO-זנב במדידה */
  let engineReachable = false, engineHeight = -1, tailOpsAtRisk = -1;
  try {
    const r = await fetch(ENGINE, { signal: AbortSignal.timeout(5_000) });
    if (r.ok) {
      const j = (await r.json()) as { state?: { height?: number }; height?: number };
      engineHeight = j.state?.height ?? j.height ?? -1;
      engineReachable = engineHeight > 0;
    }
  } catch { /* engine down — honest */ }
  if (engineReachable) {
    tailOpsAtRisk = engineHeight - st.height;
    check("engine-live-probe", true, `engine h=${engineHeight} · snapshot h=${st.height} · זנב-אובד-לו-הדיסק-מת-עכשיו=${tailOpsAtRisk} ops`);
    check("rpo-tail-bounded", tailOpsAtRisk >= 0 && tailOpsAtRisk <= 200, `tail=${tailOpsAtRisk} ops (חוזה-קדנס ≤48s ⇒ צפי ≤ ~40 ops)`);
    check("snapshot-fresh", ageSec <= 600, `savedAt-גיל=${ageSec}s (חוזה ≤48s · סייג-מדידה 10min)`);
  } else {
    check("engine-live-probe", false, "engine unreachable — RPO-זנב לא נמדד חי (ה-DB-קשר בפסקה-3 עומד בפני-עצמו)");
  }

  const rtoMs = Date.now() - t0;
  const verdict = checks.every((c) => c.ok) ? "PASS" : "FAIL";
  const outcome = {
    instrument: "restore-drill.ts", ts: new Date().toISOString(), verdict, rtoMs,
    snapshot: { height: st.height, savedAt: raw.savedAt, ageSec, stateRoot: computedRoot },
    db: { integrity, headerRows, dbRootMatch: rootMatch },
    engine: { reachable: engineReachable, height: engineHeight, tailOpsAtRisk },
    restoreDir, checks,
  };
  fs.mkdirSync(path.dirname(ARTIFACT), { recursive: true });
  fs.writeFileSync(ARTIFACT, JSON.stringify(outcome, null, 2) + "\n");
  fs.rmSync(restoreDir, { recursive: true, force: true });
  if (!QUIET) {
    console.log(`\n${verdict === "PASS" ? "✅" : "❌"} RESTORE-DRILL verdict=${verdict} · RTO=${rtoMs}ms · snapshot h=${st.height} · age=${ageSec}s · tail=${tailOpsAtRisk}ops`);
  }
  process.exit(verdict === "PASS" ? 0 : 1);
}
main().catch((e) => { console.error("restore-drill crash:", e); process.exit(1); });
