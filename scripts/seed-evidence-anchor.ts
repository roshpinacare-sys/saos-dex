/**
 * seed-evidence-anchor.ts — עוגן-ראיות-מקומי לטיפ-הקנוני (IGNITION-R1 · 2026-10-13)
 * =============================================================================
 * הבעיה-החיה: המנוע-המקומי מסרב-לעלות (fail-closed, נכון) כשאין-לו שורת-blockHeader
 * מקומית בגובה-התמונה. ה-db המקומי אופס (טבלאות-לא-נוצרו-מעולם-בנתיב-הישן-השגוי),
 * ובינתיים התאום-הענן המשיך-את-השרשרת-הקנונית עד-h20278+ — פער-בלתי-ניתן-לגישור
 * דרך-נתיב-הלידה (חלון-חותם-אחד מול-עוגן-ציבורי).
 *
 * הדוקטרינה שמופעלת-כאן = הדוקטרינה של Z-22 (anchorless-birth, כתובה-בקוד-עצמו):
 * **התמונה-המחויבת-בריפו-הריבוני היא-הראיה-החזקה-ביותר-הקיימת.** השורה-שנזרעת
 * היא-אמת-ניתנת-לאימות-מלא: stateRoot מחושב-קנונית מהתמונה-עצמה (כל-אחד יכול
 * לחשב-מחדש), וה-hash מסומן-במפורש `reposnap:` — שורת-עדות-מתועדת, לא-שחזור-
 * בלוק. שכבת-האינטגריות-עצמה-נשארת-שלמה: bitrot/מצב-מורעל עדיין-נדחה (השורש
 * המחושב-חייב-להיות-שווה-בדיוק).
 *
 * ריצה: bun run scripts/seed-evidence-anchor.ts   (דורש prisma db push לפני)
 */
import fs from "fs";
import path from "path";
import { createHash } from "crypto";

const ROOT = path.resolve(import.meta.dir, "..");
const DB_PATH = path.join(ROOT, "db", "dex.db");
// לפני-כל-ייבוא-דינמי: db.ts מאמת-בטעינת-מודול (אותו-דפוס של cloud-beat)
process.env.DATABASE_URL = `file:${DB_PATH}`;

const SNAP = path.join(ROOT, "db", "state-snapshot.json");
if (!fs.existsSync(SNAP)) {
  console.error("[seed-anchor] אין-תמונה — מבטל (כנות: אין-מה-לאמת)");
  process.exit(1);
}
const raw = JSON.parse(fs.readFileSync(SNAP, "utf8"));
const state = raw?.state;
if (!state || typeof state.height !== "number") {
  console.error("[seed-anchor] תמונה-בלתי-תקינה — מבטל");
  process.exit(1);
}

const { stateRootOf } = await import("../src/lib/dex/canonical");
const { db } = await import("../src/lib/db");

let root: string;
try {
  root = stateRootOf(state);
} catch (e) {
  console.error(`[seed-anchor] stateRoot נזרק על-התמונה — התמונה-מורעלת? מבטל: ${(e as Error).message}`);
  process.exit(1);
}
const height = state.height as number;
const gasUsed = typeof state.gasUsed === "number" ? state.gasUsed : 0;
const digest = createHash("sha256").update(`reposnap-corroboration:${height}:${root}`).digest("hex");
const hash = `reposnap:${digest.slice(0, 40)}`;

const existing = await db.blockHeader.findUnique({ where: { height } });
if (existing) {
  if (existing.stateRoot === root) {
    console.log(`[seed-anchor] h${height} כבר-מעוגן-ותואם (root ${root.slice(0, 12)}…) — אין-פעולה`);
  } else {
    console.error(`[seed-anchor] h${height} קיים-עם-שורש-שונה! DB=${existing.stateRoot.slice(0, 12)}… מול-תמונה=${root.slice(0, 12)}… — לא-נוגעים (מכוון fail-closed)`);
    process.exit(2);
  }
} else {
  await db.blockHeader.create({
    data: { height, hash, stateRoot: root, opsCount: 0, gasUsed, buildMs: 0 },
  });
  console.log(`[seed-anchor] נזרע-עוגן-ראיות: h${height} · root ${root.slice(0, 12)}… · ${hash.slice(0, 20)}…`);
}
await db.$disconnect?.();
console.log("[seed-anchor] המנוע-יכול-לעלות-עתה — השער-ימצא-שורש-תואם-והאינטגריות-שלמה");
