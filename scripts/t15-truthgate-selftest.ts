/**
 * t15-truthgate-selftest.ts — הוכחת-פעולה לחוקים-המתוארים (T15 2026-10-11)
 * =============================================================================
 * הרשת מאמתת את המנוע: לא טענות — מדידה. ההרצה מקימה את השרשרת האמיתית על
 * DB-טרי עם תמונת-המצב הקנונית המקומית (db/state-snapshot.json), ומודדת:
 *
 *   P1 (A38 · R46-b): בטעינת תמונה שבה treasuryProfitEver=72000µ (< השיא
 *      הגיט-מוכח 213752µ) — רצפת-הזרע חייבת להיאכף בפועל: המצב החי יציג
 *      ≥213752µ מיד-אחרי-הטעינה, לפני-כל-טיק.
 *   P2 (A43 · SETTLE-17-b/c): אחרי טיקים — הספר דו-צדדי בשני-השווקים:
 *      SAOS/USDS bestBid ≥ 1 ו- USDS/WSTEEM bestAsk ≥ 1. אפס-הטבעה: כל-ציטוט
 *      ממלאי-אמת; אסור שיהיו פקודות-אבק (< RAIL_DUST_MU).
 *   P3 (שימור): האינווריאנטה Σcredits+gasUsed−feeMinted === ג'נזיס נשמרת
 *      במדויק מטעינה ועד סוף-הטיקים (אפס-כסף-מאין).
 *
 * אפס-רשת: האורקל נכשל-שקט-כנה (fail-soft מובנה) — המדידות דטרמיניסטיות
 * על גבי תמונת-המצב. יציאה 0 = כל-ההוכחות עמדו; אחרת 1.
 */
import fs from "fs";
import path from "path";
import os from "os";

const ROOT = path.resolve(import.meta.dir, "..");

// DB טרי בכל-הרצה — נתיב-הפעלה-עצמאית (אותו-נתיב של הרצה-עננית טרייה).
// שומר-ה-db (db.ts) מקבל רק dex.db — קובץ-ה-DB בשמו-הקנוני בתיקיית-זמן.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "t15-selftest-"));
const tmpDb = path.join(tmpDir, "dex.db");
process.env.DATABASE_URL = `file:${tmpDb}`;
// FIX(T15 · repo-hygiene): המנוע שומר-מצב-חי-חזרה-אל SAOS_DEX_STATE_DIR —
// ההרצה-המקומית חייבת לעבוד על **עותק** של תמונת-המצב הקנונית ולא על תיקיית-
// ה-db-של-הריפו (התקדמות-השרשרת הקנונית שייכת-רק-לפעימה-העננית שמצהירה
// עליה בקומיט-משלה; ריצת-בדיקה שתדחוף מצב-מתקדם-בשקט = זיוף-רצף).
for (const f of ["state-snapshot.json", "rail-lifetime.json", "book-gas.json", "dex-credits.json", "klines.json"]) {
  const src = path.join(ROOT, "db", f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmpDir, f));
}
process.env.SAOS_DEX_STATE_DIR = tmpDir;

// דחיפת-סכמה ל-DB-הטרי — בדיוק-כמו-הרצה-עננית (Roast-65: בלי-זה הטבלות חסרות
// והמנוע מסרב-טעינה fail-closed). סנכרוני, לפני-כל-ייבוא-של-המנוע.
import { execSync } from "child_process";
execSync("bunx prisma db push --skip-generate --accept-data-loss", {
  cwd: ROOT, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"],
});

const results: { id: string; ok: boolean; details: string }[] = [];
const record = (id: string, ok: boolean, details: string): void => {
  results.push({ id, ok, details });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} — ${details}`);
};

async function main(): Promise<void> {
  const { ensureChain, stopLoops, stepOnce, getLiveState, getMarkets } = await import("../src/lib/dex/chain");
  const { RAIL_DUST_MU } = await import("../src/lib/dex/rail");

  const rt = ensureChain();
  const t0 = Date.now();
  while (rt.pendingLoad && Date.now() - t0 < 90_000) await new Promise((r) => setTimeout(r, 200));
  if (rt.halted) {
    record("boot", false, `chain HALTED: ${rt.haltReason ?? "?"}`);
    finish();
    return;
  }
  record("boot", true, `loaded h${rt.st.height}`);

  // ── P1 · A38 — רצפת-הזרע נאכפת בטעינה (לפני-כל-טיק) ──
  const HISTORIC_HIGH_WATER = 213752; // git-proven (Console@4ac9369, 2026-09-17)
  const everNow = rt.st.treasuryProfitEver ?? 0;
  record(
    "P1-A38-seed-at-load",
    everNow >= HISTORIC_HIGH_WATER,
    `treasuryProfitEver=${everNow}µ ≥ ${HISTORIC_HIGH_WATER}µ (snapshot carries 72000µ — the floor-seed must have fired at load)`,
  );

  // ── בסיס-שימור לפני-הטיקים ──
  const sumCredits = (st: ReturnType<typeof getLiveState>): number =>
    Object.values(st.credits).reduce((s, c) => s + (c ?? 0), 0);
  const invariantOf = (st: ReturnType<typeof getLiveState>): number =>
    sumCredits(st) + (st.gasUsed ?? 0) - (st.feeMinted ?? 0);
  const genesisConst = invariantOf(rt.st);

  // ── טיקים (אפס-טיימרי-קיר — צעדים-סנכרוניים כמו-הרצה-עננית) ──
  stopLoops();
  const TICKS = 48;
  let halted = false;
  for (let i = 0; i < TICKS; i++) {
    await stepOnce();
    if (rt.halted) { halted = true; break; }
  }
  record("ticks", !halted, halted ? `HALTED at tick: ${rt.haltReason}` : `${TICKS} ticks advanced, h${rt.st.height}`);

  // ── P2 · A43 — הספר דו-צדדי (פעולה, לא תיאור) ──
  const mkts = getMarkets();
  const saos = mkts.find((m) => m.key === "SAOS/USDS");
  const wst = mkts.find((m) => m.key === "USDS/WSTEEM");
  record(
    "P2-A43-two-sided",
    (saos?.bestBid ?? 0) >= 1 && (wst?.bestAsk ?? 0) >= 1,
    `SAOS/USDS bestBid=${saos?.bestBid} · USDS/WSTEEM bestAsk=${wst?.bestAsk} (both must be ≥1)`,
  );

  // אפס-אבק: כל-פקודה-חיה ≥ רצפת-האבק (הצפת-ממפול אסורה)
  const st2 = getLiveState();
  const dustOrders = st2.orders.filter((o) => o.live && o.amount - o.filled < RAIL_DUST_MU);
  record("P2-no-dust-orders", dustOrders.length === 0, `live orders below ${RAIL_DUST_MU}µ: ${dustOrders.length}`);

  // ── P3 · שימור — אפס-כסף-מאין ──
  const after = invariantOf(st2);
  record("P3-conservation", after === genesisConst, `Σcredits+gasUsed−feeMinted: genesis=${genesisConst} after=${after} (must be exact)`);

  finish();
}

function finish(): void {
  const passed = results.filter((r) => r.ok).length;
  console.log(`\nT15-TRUTHGATE-SELFTEST: ${passed}/${results.length} ${passed === results.length ? "ALL-PASS" : "HAS-FAILURES"}`);
  fs.writeFileSync(path.join(ROOT, "t15-selftest-results.json"), JSON.stringify({ format: "t15-truthgate-selftest/1", at: new Date().toISOString(), results, verdict: passed === results.length ? "ALL-PASS" : "HAS-FAILURES" }, null, 2));
  // היגיינה-קנונית: ריצת-בדיקה לא משאירה-אחריה מצב-שרשרת-מתקדם בריפו —
  // הפעימה-העננית (dex-beat) היא-הבעלים-היחיד של קידום-הקנון והיא מצהירה
  // עליו בקומיט-משלה. מחזירים את קבצי-הריצה ל-HEAD (אפס-זיהום-גיט).
  try { execSync("git checkout -- db/", { cwd: ROOT, stdio: "ignore" }); } catch { /* אין-git — דלג-כנה */ }
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error("selftest crashed:", e); process.exit(1); });
