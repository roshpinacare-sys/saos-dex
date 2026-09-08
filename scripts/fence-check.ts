/* fence-check.ts — סורק-הגדר הריבונית (SETTLE-11) · אוכף "אפס-קוד-זר" + עקביות-שערים
 *
 * ריצה: bun scripts/fence-check.ts   (exit 0 = נקי · exit 1 = הפרה)
 *
 * SECURITY INTENT (המפעיל: "לא נפעיל קוד זר"):
 *  1. איסור מוחלט על הרצת-קוד-דינמית/מרחוק: eval, new Function, import/require מ-http(s).
 *  2. כל כתובת https ב-src חייבת להיות שער-מקובע (fence.ts) או שער-תצוגה-בלבד
 *     (קישורי-explorer לעין-המפעיל — לעולם לא נשלפים מהקוד).
 */
import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pinnedHosts, hostOf } from "../src/lib/dex/fence";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCAN_DIRS = ["src"];

/* שערים שמופיעים ב-src אך מיועדים-תצוגה-בלבד (קישורי-EXPLORER — אף-fetch אליהם) */
const DISPLAY_ONLY = new Set([
  "steemworld.org", "hiveblocks.com", "tronscan.org", "etherscan.io", "solscan.io", "explorer.solana.com",
]);

const BAD: { re: RegExp; why: string }[] = [
  { re: /\beval\s*\(/, why: "eval() — הרצת-קוד-דינמית אסורה (מדיניות אפס-קוד-זר)" },
  { re: /new\s+Function\s*\(/, why: "new Function — הרצת-קוד-דינמית אסורה" },
  { re: /import\s*\(\s*["'`]https?:/i, why: "import() מרחוק — קוד-זר בזמן-ריצה" },
  { re: /require\s*\(\s*["'`]https?:/i, why: "require() מרחוק — קוד-זר בזמן-ריצה" },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (name === "node_modules" || name === ".next") continue;
      out.push(...walk(p));
    } else if (/\.(ts|tsx|mjs|cjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

let violations = 0;
const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));

for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const b of BAD) {
    if (b.re.test(src)) {
      console.error(`[fence-check] VIOLATION ${path.relative(ROOT, f)} — ${b.why}`);
      violations += 1;
    }
  }
  /* כל-https-ליטרלי חייב-להיות שער-מקובע או תצוגה-בלבד */
  const urls = src.match(/https:\/\/[a-zA-Z0-9.-]+/g) ?? [];
  for (const u of urls) {
    const h = hostOf(u);
    if (!h) continue;
    if (pinnedHosts().includes(h) || DISPLAY_ONLY.has(h)) continue;
    console.error(`[fence-check] UNPINNED-HOST ${path.relative(ROOT, f)} — "${h}" אינו מקובע ב-fence.ts ואינו מוצהר תצוגה-בלבד`);
    violations += 1;
  }
}

if (violations > 0) {
  console.error(`[fence-check] נכשל: ${violations} הפרות גדר`);
  process.exit(1);
}
console.log(`[fence-check] נקי: ${files.length} קבצים · אפס eval/new-Function/יבוא-מרחוק · כל-השערים מקובעים (${pinnedHosts().length} pinned + ${DISPLAY_ONLY.size} display-only)`);
