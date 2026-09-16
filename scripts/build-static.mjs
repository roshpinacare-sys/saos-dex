/**
 * build-static.mjs (Task 35) — בניית המראה הסטטית של הטרמינל → out/ (ל-GitHub Pages).
 *
 * היעד: /Console/saos-dex/ — הטרמינל הריבוני כמו שהוא, מוגש סטטית מה-Pages
 * הציבורי, וניזון מ-dex/world.json שהלב בענן מפרסם בכל פעימה. אפס סנדבוקס.
 *
 * הצינור (כולו הפיך — קוד-המקור נשאר שלם לחלוטין לאחר הריצה):
 *   1. מרחיק זמנית את src/app/api ← מסלולי-דמון בלבד (force-dynamic; ייצוא
 *      סטטי מסרב לבנות אותם). התצוגה לא מייבאת אותם — רק קוראת בזמן-ריצה.
 *   2. כותב תצורת-ייצוא זמנית (output:export · basePath:/Console/saos-dex).
 *   3. בונה עם NEXT_PUBLIC_STATIC_MIRROR=1 ← הטרמינל קורא world.json במקום
 *      ה-API, מאט סקר ל-20ש', ומציג "PUBLIC MIRROR · read-only" בכנות.
 *   4. משחזר את הכל (finally) — גם אם הבנייה נכשלה.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const API = path.join(ROOT, "src", "app", "api");
const API_BAK = path.join(ROOT, ".api-static-backup");
const CFG = path.join(ROOT, "next.config.ts");
const CFG_BAK = path.join(ROOT, "next.config.ts.daemon-bak");

const STATIC_CFG = `import type { NextConfig } from "next";

/* תצורת-המראה (Task 35): ייצוא-סטטי ל-GitHub Pages תחת /Console/saos-dex/.
 * נכתבת זמנית על-ידי scripts/build-static.mjs ומוחזרת מיד — תצורת-הדמון
 * (next.config.ts) נשמרת בדיוק-כמו-שהיא. */
const nextConfig: NextConfig = {
  typescript: { ignoreBuildErrors: false },
  reactStrictMode: false,
  output: "export",
  basePath: "/Console/saos-dex",
  trailingSlash: true,
  images: { unoptimized: true },
};
export default nextConfig;
`;

if (fs.existsSync(API_BAK) || fs.existsSync(CFG_BAK)) {
  console.error("[build-static] backup exists — previous run crashed. restore manually:");
  console.error(`  mv ${API_BAK} ${API} ; cp ${CFG_BAK} ${CFG} ; rm ${CFG_BAK}`);
  process.exit(1);
}

function run(cmd, env = {}) {
  execSync(cmd, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...env } });
}

fs.renameSync(API, API_BAK);
fs.copyFileSync(CFG, CFG_BAK);
try {
  fs.writeFileSync(CFG, STATIC_CFG);
  run("bunx next build", { NEXT_PUBLIC_STATIC_MIRROR: "1" });
} finally {
  fs.renameSync(API_BAK, API);
  fs.copyFileSync(CFG_BAK, CFG);
  fs.rmSync(CFG_BAK);
}

const out = path.join(ROOT, "out");
if (!fs.existsSync(path.join(out, "index.html"))) {
  console.error("[build-static] out/index.html missing — build failed?");
  process.exit(1);
}
console.log("[build-static] ✓ out/ ready — deploy its content to Console repo at saos-dex/");
