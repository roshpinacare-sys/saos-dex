/* fence-check.ts — סורק-הגדר הריבונית (SETTLE-11) · אוכף "אפס-קוד-זר" + עקביות-שערים
 *
 * ריצה: bun scripts/fence-check.ts   (exit 0 = נקי · exit 1 = הפרה)
 *
 * SECURITY INTENT (המפעיל: "לא נפעיל קוד זר"):
 *  1. איסור מוחלט על הרצת-קוד-דינמית/מרחוק: eval, new Function, import/require מ-http(s).
 *  2. כל כתובת https ב-src חייבת להיות שער-מקובע (fence.ts) או שער-תצוגה-בלבד
 *     (קישורי-explorer לעין-המפעיל — לעולם לא נשלפים מהקוד).
 *
 * FIX(Roast-65-b · H1/H2): הסורק-הסטטי היה-עיוור ל-runtime — עתה מריץ גם את
 * fenceSelftest() (מניפסט-הקוראים-הפנימיים + אכיפת-ה-scheme + התאמת-פורטים), ומוסיף
 * שני-כללי-סריקה:
 *  · כל-fetch( ב-src/lib חייב-להיות-בקובץ-המייבא-את-הגדר (fencedFetch) — עוזר-מרכזי:
 *    src/lib/dex/fence.ts (המאפשר-היחיד של bare-fetch, כי-הוא-המיישם של הגדר+redirect:error).
 *  · redirect:"follow" אסור בכל-src (H2 — מניעת-replay של body חתום אחרי 307/308).
 */
import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pinnedHosts, hostOf, fenceSelftest, type FenceCase } from "../src/lib/dex/fence";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCAN_DIRS = ["src"];

/* FIX(Roast-65-b · H2): קבצי-src/lib עם bare-fetch שאינם-חייבים-ייבוא-גדר:
 *  · src/lib/dex/fence.ts — העוזר-המרכזי עצמו (מיישם גדר + redirect:"error"; כל-השאר חייבים-דרכו).
 * FIX(Roast-65-e1 · 65-b M7): רשומת-PENDING של-settle.ts הוסרה — jfetch עתה מיובא
 *    דרך-fencedFetch (assertAllowedHost + redirect:"error"); אין-עוד-היתר-מתוארך. */
const FETCH_WITHOUT_FENCE_ALLOWED = new Set([
  "src/lib/dex/fence.ts",
]);

/* שערים שמופיעים ב-src אך מיועדים-תצוגה-בלבד (קישורי-EXPLORER — אף-fetch אליהם) */
const DISPLAY_ONLY = new Set([
  "steemworld.org", "hiveblocks.com", "tronscan.org", "etherscan.io", "solscan.io", "explorer.solana.com",
  /* Roast-74 · מסילת-הרשתות: סרק-Steem לתצוגת-txid (Blurt: אין-סריקה-חיה — מוצהר-בקוד) */
  "steemscan.com",
]);

const BAD: { re: RegExp; why: string }[] = [
  { re: /\beval\s*\(/, why: "eval() — הרצת-קוד-דינמית אסורה (מדיניות אפס-קוד-זר)" },
  { re: /new\s+Function\s*\(/, why: "new Function — הרצת-קוד-דינמית אסורה" },
  { re: /import\s*\(\s*["'`]https?:/i, why: "import() מרחוק — קוד-זר בזמן-ריצה" },
  { re: /require\s*\(\s*["'`]https?:/i, why: "require() מרחוק — קוד-זר בזמן-ריצה" },
  /* FIX(Roast-65-b · H2): redirect:"follow" = undici עוקב 307/308 מחוץ-לגדר עם method+body */
  { re: /redirect\s*:\s*["']follow["']/, why: "redirect:\"follow\" — אסור: מארח-מקובע שעונה 307/308 ימשוך fetch מחוץ-לגדר (replay של body חתום). השתמשו ב-fencedFetch (redirect:\"error\" נאכף-מרכזית)" },
];

/* FIX(Roast-65-b · H2): bare-fetch — כל-fetch( ב-src/lib חייב-קובץ-עם-ייבוא-גדר */
const RE_BARE_FETCH = /(?<![a-zA-Z_$])fetch\s*\(/;
const RE_FENCE_IMPORT = /\bfrom\s+["'][^"']*(?:dex\/)?fence["']/;

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
  const rel = path.relative(ROOT, f);
  for (const b of BAD) {
    if (b.re.test(src)) {
      console.error(`[fence-check] VIOLATION ${rel} — ${b.why}`);
      violations += 1;
    }
  }
  /* כל-https-ליטרלי חייב-להיות שער-מקובע או תצוגה-בלבד.
   * FIX(Roast-65-b · H1): src/lib/dex/fence.ts פטור-מהבדיקה-הזאת — קובץ-המדיניות-עצמו:
   * הפינים-המוצהרים + מקרי-ה-reject-של-fenceSelftest (מארחים-עוינים-מוצהרים-במפורש). */
  const urls = src.match(/https:\/\/[a-zA-Z0-9.-]+/g) ?? [];
  for (const u of urls) {
    const h = hostOf(u);
    if (!h) continue;
    if (pinnedHosts().includes(h) || DISPLAY_ONLY.has(h)) continue;
    if (rel.replace(/\\/g, "/") === "src/lib/dex/fence.ts") continue; // קובץ-המדיניות/ה-selftest
    console.error(`[fence-check] UNPINNED-HOST ${rel} — "${h}" אינו מקובע ב-fence.ts ואינו מוצהר תצוגה-בלבד`);
    violations += 1;
  }
  /* FIX(Roast-65-b · H2): bare-fetch ב-src/lib בלי-ייבוא-גדר = הפרה */
  if (rel.startsWith("src/lib/") && RE_BARE_FETCH.test(src)) {
    if (FETCH_WITHOUT_FENCE_ALLOWED.has(rel.replace(/\\/g, "/"))) {
      console.info(`[fence-check] allowed-fetch ${rel} — רשומת-היתר/PENDING מתוארכת (ראה FETCH_WITHOUT_FENCE_ALLOWED בסורק)`);
    } else if (!RE_FENCE_IMPORT.test(src)) {
      console.error(`[fence-check] UNFENCED-FETCH ${rel} — bare-fetch() ב-src/lib בקובץ-שאינו-מייבא-את-הגדר. חובה: fencedFetch(url, where, init) מ-src/lib/dex/fence.ts (גדר + redirect:"error")`);
      violations += 1;
    }
  }
}

/* FIX(Roast-65-b · H1): בדיקת-ריצה — הגדר חייבת-להיות פתוחה-בדיוק לקוראים-הלגיטימיים
 * (loopback-pins, כל-השערים-המקובעים, אכיפת-https/ws) וסגורה לכל-השאר.
 * Roast-73: הצלבה-חיה מול-railExecEndpoints() — נקודות-הקצה-האמת של מבצע-המסילה
 * (החותם-החוץ ההיסטורי בוטל-כנה; אם-הפינים-והקוד-יסטו-זה-מזה, הסריקה-תיכשל). */
const extra: FenceCase[] = [];
try {
  const { railExecEndpoints } = await import("../src/lib/dex/rail-exec");
  for (const ep of railExecEndpoints()) {
    extra.push({ endpoint: ep, expect: "allow", why: "railExecEndpoints() — נקודת-ביצוע-חיה של-מבצע-המסילה-הריבוני (הצלבה-מול-מניפסט-הגדר)" });
  }
} catch (e) {
  console.error(`[fence-check] SELFTEST-WIRE-FAILED — לא ניתן לטעון את נקודות-הקצה של rail-exec: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
  violations += 1;
}
const st = fenceSelftest(extra);
if (!st.ok) {
  for (const f of st.failures) console.error(`[fence-check] SELFTEST-FAIL ${f}`);
  violations += st.failures.length;
} else {
  console.log(`[fence-check] selftest: ${st.ran} מקרי-גדר עברו (allow/reject בדיוק-כמדיניות · כולל-railExecEndpoints חי)`);
}

if (violations > 0) {
  console.error(`[fence-check] נכשל: ${violations} הפרות גדר`);
  process.exit(1);
}
console.log(`[fence-check] נקי: ${files.length} קבצים · אפס eval/new-Function/יבוא-מרחוק · אפס redirect:"follow" · כל-fetch ב-src/lib מגודר · כל-השערים מקובעים (${pinnedHosts().length} pinned + ${DISPLAY_ONLY.size} display-only) · selftest ${st.ran}/${st.ran}`);
