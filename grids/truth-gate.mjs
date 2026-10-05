// TRUTH-GATE — שער-אמת על מילויים (Wave-2 סעיף 1 · מנדט-הבעלים #11 "בורסת-אמת")
// ═══════════════════════════════════════════════════════════════════════════
// הקו-האדום של הבעלים (מסמך-הסדר-אב, Wave-2): "בורסת-מזויפת = כישלון".
// מנוע בלי מילויי-אמת חייב לדווח על עצמו "כישלון" אוטומטית — הפנקס הזה הוא
// הדיווח. פסיקת-האמת נגזרת מקבצי-ראיה בלבד (directive: מדידה מהדבר עצמו):
//
//   · מילוי-אמת = fill_order מהשרשרת (שוק-הפנימי STEEM:SBD של headcorner) —
//     בעל ראיה: idx של היסטוריית-החשבון (Zip sovereign/money/pnl-scan.json,
//     checkpoint maxIndex) או מד-המנוע (grids/state/state.json feeMeter שניזון
//     מ-observe.mjs ← account_history). שניהם צפיות על אותה-אמת-שרשרת —
//     המספר-הראשי = max ביניהם (אף-מילוי לא נספר-פעמיים).
//   · מה שלא נספר לעולם: מילויי-סימולציה (db/tape.jsonl SAOS/USDS, feeMeter
//     simFills) ורשומות-PAPER בפנקס-הארביטרז' (arb-ledger) — נייר הוא נייר.
//
// מטריצת-הפסיקה (מקודדת, מסודרת):
//   1. יש-ראיה-מעולם && realFillsEver == 0        → FAILURE-NO-REAL-FILLS
//      (מעולם לא היה מילוי-אמת — הבורסה מזויפת במידה-רבה; הבלם לא מוחק עבר.
//       חשוב: "אין-קבצי-ראיה" אינו "אפס-מילויים-מעולם" — חוסר-ראיה לא יפעיל ענף זה)
//   2. realFills24h > 0                            → ALIVE-REAL-FILLS
//      (מילוי-אמת בחלון-המדידה — המנוע חי)
//   3. אין-מילוי-בחלון (או לא-נמדד) && STASIS פעיל → STASIS-CONTAINED
//      (היו מילויים/לא-נמדד; הבלם של הבעלים עוצר-כעת — מוכל, לא-כשל-חדש)
//   4. אחרת                                        → FAILURE-NO-REAL-FILLS
//      (חופשי-לסחור ואין מילויי-אמת מוכחים בחלון = כישלון)
//   realFills24h == null = לא-נמדד (קובץ-ראיה חסר בסביבה) — כנות-כנה: null
//   אינו "0"; פסיקה נופלת לענף 3/4 לפי-המצב (fail-closed, אין-המצאה).
//
// פרסום: הפסיקה מוטמעת ב-ledger.truthGate על-ידי arb-scan.mjs (runArbScan) —
// אותו-נתיב-קבלות שה-CI כבר מקומיט כל-30-דק' (arb-scan.yml) — מדידה-בלבד,
// אפס-הון, אפס-מפתחות. כל-טענה נושאת מקור-שם-קובץ; קובץ-חסר = שורת-absent כנה.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

export const TRUTH_GATE_LAW = "fake exchange = failure";
export const TRUTH_GATE_ENGINE = "saos-dex";
export const VERDICTS = ["ALIVE-REAL-FILLS", "FAILURE-NO-REAL-FILLS", "STASIS-CONTAINED"];
/** מקורות-ראיה (נתיבי-ברירת-מחדל; הרץ מזריק נתיבים חלופיים במבחנים) */
export const TRUTH_GATE_SOURCES = {
  engineState: join(HERE, "state", "state.json"),          // feeMeter — מילויים אמת שהוזרמו מ-chain (observe.mjs)
  stasis: join(HERE, "state", "STASIS.json"),              // הבלם — להקשר הפסיקה
  zipScan: join(HERE, "..", "..", "Zip", "sovereign", "money", "pnl-scan.json"),          // שורות-מילוי fill_order עם idx
  zipSnapshots: join(HERE, "..", "..", "Zip", "sovereign", "economy", "pnl-snapshots.json"), // FIFO-מיקרו-גריד
  arbLedger: join(HERE, "state", "arb-ledger.json"),       // מצוטט-כפריד (נייר) — לעולם לא נספר
  tape: join(HERE, "..", "db", "tape.jsonl"),              // מצוטט-כפריד (סימולציה) — לעולם לא נספר
};
/** תוכנית-מדידת-ה-PnL של המיקרו-גריד (Wave-2 סעיף 2) — מצוטטת מהמסמכים הקנוניים */
export const MICRO_GRID_PLAN = {
  dueAt: "2026-10-09",
  goal: "PnL-המיקרו-גריד חיובי נמדד (מ−1.362 SBD)",
  source: "MASTER-ORDER-DRAFT-2026-10-05.md §Wave-2 + item 12 (r151 armBuy tightening → impact measurement ~2026-10-09) · Zip session-handoff.md (r151/r156)",
};

const r6 = (v) => (Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : null);

/** קריאת-JSON כנה — קובץ-חסר/פגום → null (לעולם לא זורק; חוסר-ראיה אינו אפס-ראיה). */
export function readJsonSafe(path) {
  try {
    if (!path || !existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch { return null; }
}

/** גיל-בשעות מחותמת-ISO עד nowIso; קלט-פגום → null. */
export function ageHours(iso, nowIso) {
  const t = Date.parse(iso), n = Date.parse(nowIso);
  if (!Number.isFinite(t) || !Number.isFinite(n)) return null;
  return r6(Math.max(0, (n - t) / 36e5));
}

/** מספר-מילויים בחלון-24h מתוך שורות-מילוי עם חותמות (Zip pnl-scan). קלט-פגום → null. */
export function fillsInWindow(rows, nowIso, windowH = 24) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now)) return null;
  let n = 0, last = null;
  for (const f of rows) {
    const t = Date.parse(f?.at ?? "");
    if (!Number.isFinite(t)) continue; // שורה-בלי-חותמת — לא נספרת, לא מומצאת
    if (t > now) continue;             // חותמת-עתידית = קלט-פגום — לא נספרת
    if (now - t <= windowH * 36e5) { n++; if (!last || t > Date.parse(last)) last = f.at; }
  }
  return { count: n, lastFillAt: last, windowH };
}

/**
 * ליבה-טהורה: פסיקת-אמת מקלטים-נתונים (כל-הנתיבים nullable — אין-המצאה).
 * inputs: { nowIso, engineState, stasis, zipScan, zipSnapshots, arbLedger, tapePresent }
 */
export function computeTruthGate(inputs = {}) {
  const nowIso = inputs.nowIso ?? null;
  const engineState = inputs.engineState ?? null;
  const stasis = inputs.stasis ?? null;
  const zipScan = inputs.zipScan ?? null;
  const zipSnapshots = inputs.zipSnapshots ?? null;
  const arbLedger = inputs.arbLedger ?? null;
  const tapePresent = inputs.tapePresent === true;

  // ── מד-המנוע (saos-dex state.json feeMeter — fill_order שהוזרם מ-chain ע"י observe.mjs)
  const fm = engineState?.feeMeter ?? null;
  const engineFills = typeof fm?.realFills === "number" && fm.realFills >= 0 ? fm.realFills : null;
  const engineSource = {
    name: "saos-dex feeMeter (observe.mjs ← chain fill_order)",
    kind: "chain-meter",
    fills: engineFills,
    asof: engineState?.asof ?? null,
    realSbdDelta: typeof fm?.realSbdDelta === "number" ? fm.realSbdDelta : null,
    realizedSbd: typeof fm?.realPnl?.realizedSbd === "number" ? fm.realPnl.realizedSbd : null,
    note: "מד-המנוע — צפיה אחת על אמת-השרשרת; לא מתווסף לאחרים (max rule)",
  };

  // ── ראית-השורות (Zip pnl-scan.json — fill_order עם idx פר-מילוי)
  const scanRows = Array.isArray(zipScan?.fills) ? zipScan.fills : null;
  const scanEver = scanRows ? scanRows.length : null;
  const win = nowIso ? fillsInWindow(scanRows ?? [], nowIso, 24) : null;
  const realFills24h = win ? win.count : null; // null = אין-ראיה-בסביבה (כנה), לא אפס
  const scanSource = {
    name: "Zip sovereign/money/pnl-scan.json (fill_order rows, idx evidence)",
    kind: "chain-fill-rows",
    fills: scanEver,
    savedAt: zipScan?.savedAt ?? null,
    maxIndex: typeof zipScan?.maxIndex === "number" ? zipScan.maxIndex : null,
    lastFillAt: win?.lastFillAt ?? (scanRows && scanRows.length ? scanRows[scanRows.length - 1].at : null),
    note: "כל-מילוי נושא אינדקס-היסטוריית-חשבון (idx) — ראיה יציבה; מקור-החלון-בן-24h",
  };

  // ── תמונת-המיקרו-גריד (Zip pnl-snapshots — FIFO על אותם fill_order אמת)
  const lastSnap = Array.isArray(zipSnapshots?.entries) && zipSnapshots.entries.length ? zipSnapshots.entries[zipSnapshots.entries.length - 1] : null;
  const snapSource = {
    name: "Zip sovereign/economy/pnl-snapshots.json (FIFO micro-grid)",
    kind: "fifo-snapshot",
    fills: lastSnap?.realized?.fillsTotal ?? null,
    savedAt: zipSnapshots?.savedAt ?? null,
    seq: lastSnap?.seq ?? null,
    capturedSbd: typeof lastSnap?.realized?.capturedSbd === "number" ? lastSnap.realized.capturedSbd : null,
    trips: lastSnap?.realized?.trips ?? null,
    note: "FIFO על fill_order אמת; מקור-ה-PnL-הממומש של המיקרו-גריד",
  };

  // ── realFillsEver: max בין הצפיות-העקביות על אותה-אמת (אין-חיבור = אין-ספירה-כפולה)
  const views = [engineFills, scanEver, snapSource.fills].filter((v) => typeof v === "number");
  const realFillsEver = views.length ? Math.max(...views) : 0;
  const evidenceEverMeasured = views.length > 0; // "אין-ראיה" ≠ "אפס-מילויים-מעולם" — כנות-מבנית

  const sources = [engineSource, scanSource, snapSource];
  // שורות-absent כנות כשהראיה לא-נקראה בסביבה (למשל CI של saos-dex בלי Zip)
  if (engineFills == null) sources.push({ name: "saos-dex feeMeter", kind: "absent", note: "grids/state/state.json לא-נקרא — אין-ראיה בסביבה זו" });
  if (scanEver == null) sources.push({ name: "Zip pnl-scan.json", kind: "absent", note: "לא-קיים בסביבה (CI של saos-dex) — החלון-בן-24h לא-נמדד (null, לא 0)" });
  if (snapSource.fills == null && snapSource.seq == null) sources.push({ name: "Zip pnl-snapshots.json", kind: "absent", note: "לא-קיים בסביבה — תמונת-ה-FIFO לא-נמדדה כאן" });

  // ── הנייר שלא-נספר (הצהרת-היפוך: מה שלא נכנס לאמת)
  const excludedFromTruth = [
    { name: "db/tape.jsonl (SAOS/USDS sim tape)", present: tapePresent, note: "מילויי-סימולציה — לעולם לא נספרים כמילויי-אמת" },
    { name: "arb-ledger paper rows (realness PAPER / executableSize 0)", present: arbLedger != null, note: "רשויות-נייר בפנקס-הארביטרז' — נייר הוא נייר; הפסיקה לעולם לא נגזרת מהן", cumulative: arbLedger?.cumulative ?? null },
  ];

  // ── הבלם
  const stasisBlock = {
    active: stasis?.active === true,
    since: stasis?.since ?? null,
    note: stasis?.active === true ? "הבלם של הבעלים פעיל — מסילות-ההון עצורות; מדידה ממשיכה" : "הבלם לא-פעיל (או לא-נקרא)",
  };

  // ── מטריצת-הפסיקה (הסדר הוא-החוק — ראה כותרת-המודול)
  let verdict;
  const basis = [];
  if (evidenceEverMeasured && realFillsEver === 0) {
    verdict = "FAILURE-NO-REAL-FILLS";
    basis.push("realFillsEver == 0 (מתוך-ראיה קרואה) — לעולם לא נמדד מילוי-אמת; הקו-האדום נפגע (בורסת-מזויפת = כישלון)");
  } else if (realFills24h != null && realFills24h > 0) {
    verdict = "ALIVE-REAL-FILLS";
    basis.push(`realFills24h == ${realFills24h} — מילוי-אמת בחלון-המדידה (ראיה: ${scanSource.name})`);
  } else if (stasisBlock.active) {
    verdict = "STASIS-CONTAINED";
    basis.push(`realFills24h == ${realFills24h ?? "unmeasured"} בלבד + STASIS פעיל מ-${stasisBlock.since ?? "?"} — היו מילויים-אמת; המנוע מוכל-כעת ע"י הבלם של הבעלים`);
  } else {
    verdict = "FAILURE-NO-REAL-FILLS";
    basis.push(`realFills24h == ${realFills24h ?? "unmeasured"} והבלם לא-פעיל — המנוע חופשי-לסחור ואין מילויי-אמת בחלון = כישלון`);
  }

  // ── כנות-מיקרו-גריד (Wave-2 סעיף 2): התמונה וגילה — מדידת-השפעה ~2026-10-09
  const snapAge = zipSnapshots?.savedAt && nowIso ? ageHours(zipSnapshots.savedAt, nowIso) : null;
  const microGrid = {
    measured: lastSnap != null,
    seq: snapSource.seq,
    at: snapSource.savedAt,
    capturedSbd: snapSource.capturedSbd,
    fillsTotal: snapSource.fills,
    trips: snapSource.trips,
    lastFillAt: scanSource.lastFillAt,
    snapshotAgeHours: snapAge,
    snapshotStale: typeof snapAge === "number" ? snapAge > 48 : null,
    plan: { ...MICRO_GRID_PLAN },
    note: lastSnap
      ? "PnL-המיקרו-גריד מדוד-מהשרשרת (FIFO, ראית-idx) — לא מתומרף; תמונה עודנית >48h מסומנת stale (הרצת-המדידה תלוית-אפליקציה ב-Zip — דורשת-הצבה בראנג הבא)"
      : "תמונת-המיקרו-גריד לא-נקראה בסביבה זו — unmeasured כנה (לא אפס)",
  };

  return {
    engine: TRUTH_GATE_ENGINE,
    verdict,
    basis,
    realFills24h,
    realFillsEver,
    fillsWindow: { hours: 24, lastFillAt: scanSource.lastFillAt ?? null },
    sources,
    excludedFromTruth,
    microGrid,
    stasis: stasisBlock,
    publishedVia: "grids/state/arb-ledger.json (arb-scan cadence, arb-ledger-v1 receipt)",
    computedAt: nowIso,
    law: TRUTH_GATE_LAW,
  };
}

/** הרצה-מקבצי-ברירת-מחדל (ה-CI והסנדבוקס כאחד) — אף-קובץ-חסר לא מפיל. */
export function truthGateFromFiles({ nowIso, paths = TRUTH_GATE_SOURCES } = {}) {
  const engineState = readJsonSafe(paths.engineState);
  const stasis = readJsonSafe(paths.stasis);
  const zipScan = readJsonSafe(paths.zipScan);
  const zipSnapshots = readJsonSafe(paths.zipSnapshots);
  const arbLedger = readJsonSafe(paths.arbLedger);
  const tapePresent = paths.tape ? existsSync(paths.tape) : false;
  return computeTruthGate({ nowIso, engineState, stasis, zipScan, zipSnapshots, arbLedger, tapePresent });
}

/** כתיבת-קבלה עצמאית (CLI) — state/truth-gate.json */
export function saveTruthGateReport(verdict, path = join(HERE, "state", "truth-gate.json")) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(verdict, null, 1) + "\n");
  return path;
}

/* ── CLI: node grids/truth-gate.mjs ───────────────────────────────────────── */
if (process.argv[1] && process.argv[1].endsWith("truth-gate.mjs")) {
  try {
    const at = new Date().toISOString();
    const verdict = truthGateFromFiles({ nowIso: at });
    const p = saveTruthGateReport(verdict);
    console.log(`[truth-gate] ${at} · verdict ${verdict.verdict} · realFills24h ${verdict.realFills24h} · realFillsEver ${verdict.realFillsEver}`);
    console.log(`[truth-gate] ${verdict.law} · receipt: ${p}`);
    for (const b of verdict.basis) console.log(`[truth-gate] — ${b}`);
  } catch (e) {
    console.error(`[truth-gate] honest failure (no receipt mutation): ${String(e?.message ?? e).slice(0, 140)}`);
    process.exitCode = 0;
  }
}
