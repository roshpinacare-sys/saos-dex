#!/usr/bin/env node
// evolve.mjs — לולאת-הבנייה הריבונית (owner directive 2026-10-18: "אני רוצה בניה שיפור וכו תמיד ולא רק בדיקות")
//
// החוק:
//  - בכל-ריצה מבוצעת אכסנית-אחת מ-BUILDQUEUE.json (round-robin חסר-מצב: hour % N).
//  - כל-פלט עובר שער-שלמות JSON/טקסט לפני-commit (W1.5 law: fail-closed).
//  - אפס-שינוי → NO-OP כנה (לא מזייפים עבודה).
//  - אפס-מפתחות, אפס-כספות, אפס-סודות: מגע הוא תיעוד/מוצר/מדדים בלבד.
//  - קבלה: learning/builder-<ts>.json + commit `sovereign-builder: ... [skip ci]`.
//
// שימוש: node scripts/builder/evolve.mjs [--task <id>] [--dry]

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

const ROOT = process.cwd();
const NOW = new Date();
const ISO = NOW.toISOString();
const dry = process.argv.includes("--dry");
const taskArg = (process.argv.indexOf("--task") >= 0) ? process.argv[process.argv.indexOf("--task") + 1] : null;

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...opts }).trim();
}

// —— שער-שלמות (W1.5): כל-קובץ שנכתב נבדק — JSON חייב להתפרק, טקסט חייב להיות לא-ריק ——
const written = [];
const dryBuffer = new Map();
function writeGated(relPath, content) {
  if (!content || String(content).trim().length < 10) throw new Error(`INTEGRITY-GATE: ${relPath} content too small`);
  if (relPath.endsWith(".json")) JSON.parse(String(content)); // throws on bad JSON
  if (dry) {
    dryBuffer.set(relPath, String(content)); // dry = רק בדיקת-שער, אפס-כתיבה לדיסק
    written.push(relPath);
    return;
  }
  const abs = path.join(ROOT, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, String(content));
  written.push(relPath);
}

// —— משימה 1: מפת-כלים חיה (usability of everything) ——
function taskToolsIndex() {
  const dirs = ["scripts", "deploy", "grids", "markets", "ops", "harness", "mini-services", "audit-package", "broadcasts"];
  const rows = [];
  for (const d of dirs) {
    const abs = path.join(ROOT, d);
    if (!existsSync(abs)) continue;
    let files = [];
    try {
      files = sh(`git ls-files '${d}/*'`).split("\n").filter(Boolean);
    } catch { continue; }
    for (const f of files) {
      if (!/\.(mjs|sh|ts)$/.test(f)) continue;
      let purpose = "";
      try {
        const lines = readFileSync(path.join(ROOT, f), "utf8").split("\n").slice(0, 30);
        // קודם כותרת-בלוק בהתחלה, אחרת התגובה הראשונה ב-30 השורות הראשונות
        for (const l of lines) {
          const m = l.match(/^\s*(?:\/\/|#|\/\*)\s*(.+?)\s*(?:\*\/)?$/);
          if (m && !/^\s*(eslint|@ts|import|from)/.test(m[1])) { purpose = m[1].trim().slice(0, 90); break; }
        }
      } catch { /* binary or unreadable — skip purpose */ }
      rows.push({ tool: f, purpose: purpose || "— (תיעוד חסר)" });
    }
  }
  const md = [
    `# מפת-הכלים החיה (TOOLS-INDEX)`,
    ``,
    `> נוצר אוטומטית ע"י sovereign-builder ב-${ISO} · ${rows.length} כלים · המקור: git ls-files`,
    ``,
    `| כלי | ייעוד (מהכותרת בקוד) |`,
    `|---|---|`,
    ...rows.map((r) => `| \`${r.tool}\` | ${r.purpose} |`),
    ``,
  ].join("\n");
  writeGated("docs/TOOLS-INDEX.md", md);
  return { tools: rows.length };
}

// —— משימה 2: דוח-טריות (התשובה החיה ל"מה סגור/לא-מעודכן") ——
function taskFreshness() {
  const watch = [];
  for (const d of ["db", "grids/state"]) {
    try { for (const f of sh(`git ls-files '${d}/*'`).split("\n").filter(Boolean)) if (/\.json(l)?$/.test(f)) watch.push(f); } catch {}
  }
  const rows = watch.map((f) => {
    let iso = "";
    try { iso = sh(`git log -1 --format=%cI -- '${f}'`); } catch {}
    const ageMin = iso ? Math.round((Date.now() - new Date(iso).getTime()) / 60000) : null;
    const tone = ageMin === null ? "⚪" : ageMin < 120 ? "🟢" : ageMin < 1440 ? "🟡" : "🔴";
    return { file: f, at: iso || "never", ageMin, tone };
  });
  const stale = rows.filter((r) => r.tone === "🔴").length;
  const md = [
    `# דוח-טריות המדדים (FRESHNESS)`,
    ``,
    `> נוצר אוטומטית ב-${ISO} · 🟢 <2h · 🟡 <24h · 🔴 ישן (>24h) · 🔴 מספר: ${stale}`,
    ``,
    `| קובץ | עודכן לאחרונה | גיל (דק') |`,
    `|---|---|---|`,
    ...rows.sort((a, b) => (b.ageMin ?? 1e9) - (a.ageMin ?? 1e9)).map(
      (r) => `| ${r.tone} \`${r.file}\` | ${r.at.slice(0, 19)} | ${r.ageMin ?? "—"} |`,
    ),
    ``,
  ].join("\n");
  writeGated("docs/FRESHNESS.md", md);
  return { watched: rows.length, stale };
}

// —— משימה 3: סקירת-מוצר (UI audit — סתימות/חורים בממשק) ——
function taskUiAudit() {
  let files = [];
  try { files = sh(`git ls-files 'src/**/*.tsx' 'src/**/*.ts'`).split("\n").filter(Boolean); } catch {}
  const findings = [];
  const markers = [/TODO/i, /FIXME/, /PLACEHOLDER/i, /lorem/i, /__mock__/i];
  for (const f of files) {
    let txt = "";
    try { txt = readFileSync(path.join(ROOT, f), "utf8"); } catch { continue; }
    const lines = txt.split("\n");
    lines.forEach((l, i) => {
      for (const m of markers) {
        if (m.test(l)) {
          findings.push({ file: f, line: i + 1, marker: m.source.replace(/\\i|\/|\\\//g, ""), text: l.trim().slice(0, 80) });
          break;
        }
      }
    });
  }
  const md = [
    `# סקירת-מוצר (UI-AUDIT)`,
    ``,
    `> נוצר אוטומטית ב-${ISO} · נסרקו ${files.length} קבצי ממשק · סתימות: ${findings.length}`,
    ``,
    ...(findings.length ? findings.map((f) => `- \`${f.file}:${f.line}\` [${f.marker}] ${f.text}`) : ["- אפס-סתימות — הממשק נקי."]),
    ``,
  ].join("\n");
  writeGated("docs/UI-AUDIT.md", md);
  return { scanned: files.length, findings: findings.length };
}

// —— משימה 4: תדריך-מוצר חי (BUILD-STATUS — סיכום כלכלה+שרשרת ליום) ——
function taskBuildStatus() {
  const snap = JSON.parse(readFileSync(path.join(ROOT, "db/state-snapshot.json"), "utf8"));
  const credits = snap?.state?.credits ?? {};
  const sum = Object.values(credits).reduce((a, b) => a + b, 0);
  let army = {};
  try { army = JSON.parse(readFileSync(path.join(ROOT, "grids/state/army-public.json"), "utf8")); } catch {}
  const md = [
    `# תדריך-המוצר החי (BUILD-STATUS)`,
    ``,
    `> נוצר אוטומטית ב-${ISO} ע"י sovereign-builder — מהשרשרת עצמה, לא מהשערות.`,
    ``,
    `| מדד | ערך |`,
    `|---|---|`,
    `| גובה-שרשרת | ${snap?.state?.height ?? "—"} |`,
    `| snapshot | ${snap?.savedAt ?? "—"} |`,
    `| Σ credits (מחזור-פנימי) | ${sum}µ |`,
    `| מחזיקים | ${Object.keys(credits).length} |`,
    `| feeMeter | ${snap?.state?.feeMeter ?? "—"}µ |`,
    `| צבא | ${army?.verdict ?? "—"} · ${army?.acted ?? "?"}/${army?.roster ?? "?"} פעלו · עצירה ${army?.stasis ?? "?"} |`,
    `| pools | ${Object.keys(snap?.state?.pools ?? {}).length} |`,
    ``,
  ].join("\n");
  writeGated("docs/BUILD-STATUS.md", md);
  return { creditsSum: sum, army: army?.verdict ?? "-" };
}

// —— התור ——
const QUEUE = JSON.parse(readFileSync(path.join(ROOT, "BUILDQUEUE.json"), "utf8"));
const tasks = {
  "tools-index": { fn: taskToolsIndex, title: "מפת-כלים חיה" },
  "freshness-report": { fn: taskFreshness, title: "דוח-טריות" },
  "ui-audit": { fn: taskUiAudit, title: "סקירת-מוצר" },
  "build-status": { fn: taskBuildStatus, title: "תדריך-מוצר חי" },
};

const hourSlot = NOW.getUTCHours();
const selectedId = taskArg || QUEUE.order[hourSlot % QUEUE.order.length];
const t = tasks[selectedId];
if (!t) {
  console.error(`BUILDQUEUE: unknown task '${selectedId}'`);
  process.exit(2);
}

console.log(`[sovereign-builder] ${ISO} → task=${selectedId} (${t.title})${dry ? " [DRY]" : ""}`);
const result = t.fn();

// —— קבלה ——
// git status --porcelain (ולא git diff) — גם קבצים חדשים (??) נספרים כשינוי אמיתי
const diffFiles = dry ? [] : written.filter((f) => {
  try {
    const st = sh(`git status --porcelain -- '${f}'`);
    return st.length > 0;
  } catch { return false; }
});
const receipt = {
  schema: "SAOS-SOVEREIGN-BUILDER/1",
  at: ISO,
  task: selectedId,
  title: t.title,
  result,
  filesWritten: written,
  changed: diffFiles,
  verdict: diffFiles.length ? "BUILT" : "NO-OP(honest)",
};
if (dry) {
  console.log(JSON.stringify({ ...receipt, verdict: "DRY" }, null, 1));
  process.exit(0);
}
mkdirSync(path.join(ROOT, "learning"), { recursive: true });
writeGated(`learning/builder-${NOW.getTime()}.json`, JSON.stringify(receipt, null, 1) + "\n");
// מניעת-הצטברות: יותר מ-60 קבלות → מחיקת הישנות
try {
  const lr = sh(`git ls-files 'learning/builder-*.json'`).split("\n").filter(Boolean).sort();
  if (lr.length > 60) for (const old of lr.slice(0, lr.length - 60)) sh(`git rm -q --cached '${old}' && rm -f '${old}'`);
} catch {}

console.log(JSON.stringify(receipt, null, 1));
