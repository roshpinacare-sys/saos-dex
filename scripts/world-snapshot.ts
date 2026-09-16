/**
 * world-snapshot.ts (Task 35) — הפקה מקומית של dex/world.json + dex/relay.json
 * מהשרשרת המקומית, לפריסה-הראשונה של המראה הציבורית ב-Pages.
 *
 * משתמש באותו בונה-משותף (src/lib/dex/world-snapshot.ts) ש cloud-beat מריץ
 * בענן — הצורה זהה במדויק, ומהפעימה הבאה הענן ממשיך לרענן את הקבצים לבד.
 *
 * שימוש: bun run scripts/world-snapshot.ts <outDir>   (ברירת-מחדל: .)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* הסקריפט תמיד מכוון ל-dex.db של הריפו — גם אם הסביבה נושאת את DATABASE_URL
 * של האם (custom.db); שומר-הסף ב-lib/db.ts היה דוחה אותו בצדק (fail-closed). */
process.env.DATABASE_URL = `file:${path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "db", "dex.db")}`;

const outDir = path.resolve(process.argv[2] ?? ".");
const chain = await import("../src/lib/dex/chain");
const { buildWorldSnapshot, buildRelaySnapshot } = await import("../src/lib/dex/world-snapshot");

/* כמו הלב בענן: המתן לטעינת תמונת-השרשרת מה-db (עד 90ש') לפני בניית התמונה —
 * בלי-זה ensureChain מחזיר עולם-ריק (height 0) והמראה הייתה מוגשת ריקה. */
const rt = chain.ensureChain();
chain.stopLoops(); // הפקה-יבשה: בלי טיימרי-קיר
const t0 = Date.now();
while (rt.pendingLoad && Date.now() - t0 < 90_000) {
  await new Promise((r) => setTimeout(r, 300));
}
if (rt.halted) {
  console.error(`[world-snapshot] chain HALTED — refusing snapshot. reason: ${rt.haltReason ?? "?"}`);
  process.exit(1);
}
console.log(`[world-snapshot] chain loaded · height ${rt.st.height}`);
fs.mkdirSync(path.join(outDir, "dex"), { recursive: true });
fs.writeFileSync(path.join(outDir, "dex", "world.json"), JSON.stringify(buildWorldSnapshot()));
fs.writeFileSync(path.join(outDir, "dex", "relay.json"), JSON.stringify(buildRelaySnapshot()));
chain.stopLoops();

console.log(`[world-snapshot] wrote ${outDir}/dex/world.json + relay.json`);
console.log(`[world-snapshot] done → ${outDir}/dex/`);
process.exit(0);
