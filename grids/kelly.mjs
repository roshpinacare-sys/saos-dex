// ═══════════════════════════════════════════════════════════════════════════
// KELLY — מנוע-הגודל-מהתוחלת (SAOS-KELLY/1) · MASTER DIRECTIVE §2 STRICT KELLY-SAFE SIZING
// ───────────────────────────────────────────────────────────────────────────
// קריטריון-קלי מהמדידה-האמת: גודל-פוזיציה נגזר מהתוחלת-הנמדדת של פנקס-ה-fill-ים
// האמת — לא מהנחות, לא משאיפות, לא מ-LLM. דוקטרינת "שום-טענה-בלי-מדידה".
//
// מקור-האמת הנמדד (מתועד-בפלט, לא-באוויר):
//   db/grid-ledger.json → fills[] — פנקס-המילויים שסופר בכל grid-beat
//   ("285 fills counted", commit 40c5db66). כל-fill נושא paidUsd/recvUsd —
//   הערך-בדולר שנתקבל/ששולם, נקבע-בעת-המילוי מהמחיר-החוץ החתום על-השורה
//   (steemUsd/sbdUsd). רווח-פר-מילוי = recvUsd − paidUsd (USD).
//
// חוקי-הברזל:
//   1. אפס-אכיפה (מדורג — דוקטרינת observe→enforce של STASIS/policy/rateMode):
//      הפלט הוא **המלצה-בלבד** (recommendation file); תקרות-הכסף האוכפות נשארות
//      policy.mjs (maxNotionalPerOpSbd / maxCycleNotionalSbd / ownerGate) וכל
//      מעבר-לאכיפה דורש מילת-בעלים מפורשת. אפס-חיווט-לזרימת-הזמנות-החי במחזור-זה.
//   2. מילויי-wash (selfCross=true) לעולם לא ראיה — אותו-חוק של pnl-audit
//      (LAW-P1: `if (f.self) continue;`) ושל spread-tiers ("מילויי-צמד-עצמי
//      לעולם לא ראיה"): חציית-רגליים-עצמית אינה קצה-שוק. נספרים-כנה, נשללים-מהתוחלת.
//   3. תוחלת-שלילית → גודל-אפס: אף-פעם לא מגדילים קצה-מפסיד (f* ≤ 0 → 0).
//   4. fail-honest: פנקס-חסר/פגום/ריק-מנתוני-רווח → INSUFFICIENT-DATA —
//      לעולם לא המצאת-מספרים. שורות-פגומות נספרות-כנה, לא נשתקות.
//   5. אפס-סודות, אפס-רשת, אפס-תלות: node:fs/node:path/node:url בלבד —
//      שופט-טהור דטרמיניסטי (אותה-משמעת של brake/policy/position-sizing).
//   6. רבע-קלי (quarter-Kelly): המלצת-הגודל היא ¼ מקלי-המלא — דיסציפלינת
//      הקטנה-סטנדרטית לרעש-מדידה; קלי-המלא מפורסם-כנה לצידה.
//
// CLI:
//   node grids/kelly.mjs   ← ריצה-על-הפנקסים-החיים; שורת-JSON-כנה-אחת + כתיבת-ההמלצה
//   node grids/kelly-selftest.mjs  ← ברזל-אופליין (TDD, מוקטורים-דטרמיניסטיים)
// ═══════════════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");

/** תצוגת-נתיב: יחסי-לשורש-הריפו כשאפשר (הפלט-נסחר-בגיט — נתיב-נייד, לא-סנדבוקס). */
const displayPath = (p) => {
  try {
    const a = resolve(String(p)), b = resolve(REPO_ROOT);
    return a === b || a.startsWith(b + "/") ? a.slice(b.length + 1) : a;
  } catch { return String(p); }
};

/** פנקס-המילויים החי — עדות-ה-grid-beat (git-tracked: `!db/grid-ledger.json` ב-.gitignore). */
export const DEFAULT_LEDGER_PATHS = [join(HERE, "..", "db", "grid-ledger.json")];
export const DEFAULT_OUT_PATH = join(HERE, "state", "kelly-sizing.json");
export const KELLY_PROTOCOL = "SAOS-KELLY/1";

/** תקרת-בסיס-מתמטית (100% = אין-היצמדות-נוספת מעבר למתמטיקה); התקרה-האוכפת-אמת חיה ב-policy.mjs. */
const MAX_CAP_BPS = 10000;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/* ── estimate — טהור: p = wins/(wins+losses) · b = avgWin/avgLoss ────────────
 * fail-honest: אפס-עסקאות / קלט-זר → ok:false ו-p/b null (לעולם לא ∞, לעולם לא המצאה). */
export function estimate({ wins, losses, avgWin, avgLoss } = {}) {
  const w = wins, l = losses;
  if (!Number.isInteger(w) || w < 0 || !Number.isInteger(l) || l < 0 || w + l <= 0) {
    return { ok: false, p: null, b: null, why: "wins/losses must be non-negative ints with wins+losses>0" };
  }
  if (!isNum(avgWin) || avgWin <= 0 || !isNum(avgLoss) || avgLoss <= 0) {
    return { ok: false, p: null, b: null, why: "avgWin/avgLoss must be finite >0 (b undefined otherwise — no sizing without a measured payoff)" };
  }
  return { ok: true, p: w / (w + l), b: avgWin / avgLoss, why: null };
}

/* ── kellyFraction — קלי-קלאסי מלא: f* = p − (1−p)/b ─────────────────────────
 * תוחלת-שלילית/קלט-זר → 0 (אף-פעם לא מגדילים קצה-מפסיד). b→0 (פיצוי-דמוי-אפס)
 * מתמטית מתכווץ ל−∞ → מוצמד ל-0. b=∞ נדחה fail-honest (אין-מדידת-הפסד = אין-מדידה). */
export function kellyFraction(p, b) {
  if (!isNum(p) || p < 0 || p > 1) return 0;
  if (!isNum(b) || b <= 0) return 0;
  const f = p - (1 - p) / b;
  return Math.max(0, Math.min(1, f));
}

/* ── fractionalKelly — הקטנת-השבר (ברירת-מחדל רבע-קלי 0.25), מוצמד ל-[0,1] ── */
export function fractionalKelly(f, quarter = 0.25) {
  if (!isNum(f)) return 0;
  const q = isNum(quarter) && quarter > 0 ? quarter : 0.25;
  return Math.max(0, Math.min(1, Math.max(0, f) * q));
}

/* ── readFillStats — קריאת-פנקסי-המילויים (כנות-מלאה, אפס-שתיקה) ────────────
 * צורות-קלט נתמכות:
 *   (a) JSON עם מערך fills (פנקס-ה-grid: db/grid-ledger.json) או מערך-גלוי;
 *   (b) JSONL — אירוע-מילוי לשורה (למשל ראיות fill-evidence עם שדה profit).
 * חילוץ-רווח-פר-מילוי (סדר-עדיפויות מדוד):
 *   1) recvUsd − paidUsd (USD, צימות-זמן-מילוי — הפנקס-החי);
 *   2) שדה profit מפורש (ראיות-חוץ) — משמש אם-ורק-אם (1) אינו-קיים.
 * מילויי-wash (selfCross=true) נשללים מהתוחלת (LAW-P1) ונספרים-כנה.
 * רווח-אפס-מדויק (|π|<1e-9 USD — רעש-נקודה-צפה בלבד) = תוצאה-בלתי-קובעת — נספר בנפרד. */
export function readFillStats(ledgerPaths) {
  const paths = (Array.isArray(ledgerPaths) ? ledgerPaths : [ledgerPaths]).map(String).filter(Boolean);
  const source = { file: paths.map(displayPath).join(", "), field: null };
  const agg = {
    rawFills: 0, washFills: 0, noProfitFills: 0, zeroProfitFills: 0, malformedLines: 0,
    wins: 0, losses: 0, avgWin: null, avgLoss: null, sumProfitUsd: 0,
    extraction: { deltaUsd: 0, profitField: 0 },
  };
  if (!paths.length) return { verdict: "INSUFFICIENT-DATA", reason: "no ledger paths given — nothing measured", ...agg, wins: 0, losses: 0, trades: 0, p: null, b: null, ok: false };
  const profits = [];
  let filesRead = 0, filesMissing = 0, filesWrongShape = 0;

  for (const p of paths) {
    let txt;
    try { txt = readFileSync(p, "utf8"); }
    catch { filesMissing++; continue; }
    filesRead++;

    // ניסיון-ראשון: קובץ-JSON שלם
    let whole = null, wholeOk = true;
    try { whole = JSON.parse(txt); } catch { wholeOk = false; }
    let entries = null;
    if (wholeOk) {
      if (Array.isArray(whole)) entries = whole;
      else if (whole && typeof whole === "object" && Array.isArray(whole.fills)) entries = whole.fills;
    }
    // ניסיון-שני: JSONL (או-גוש-JSON-שאינו-מכיל-fills → מתנהג-כטקסט-שורות)
    if (entries === null) {
      entries = [];
      for (const line of txt.split("\n")) {
        const s = line.trim();
        if (!s) continue; // שורה-ריקה — לא פגומה, לא נספרת
        try { const j = JSON.parse(s); if (j && typeof j === "object") entries.push(j); else { agg.malformedLines++; } }
        catch { agg.malformedLines++; } // שורה-פגומה — נספרת-כנה, לא נשתקת
      }
      if (wholeOk && !Array.isArray(whole) && !(whole && typeof whole === "object" && Array.isArray(whole.fills)) && entries.length === 0) {
        filesWrongShape++; // JSON-שלם אך בלי-fills ובלי-שורות-שימושיות — צורה-זרה
      }
    }

    for (const f of entries) {
      if (!f || typeof f !== "object" || Array.isArray(f)) { agg.malformedLines++; continue; }
      agg.rawFills++;
      if (f.selfCross === true) { agg.washFills++; continue; } // LAW-P1: wash לעולם לא ראיה
      let profit = null;
      if (isNum(f.recvUsd) && isNum(f.paidUsd)) { profit = f.recvUsd - f.paidUsd; agg.extraction.deltaUsd++; }
      else if (isNum(f.profit)) { profit = f.profit; agg.extraction.profitField++; }
      if (profit === null) { agg.noProfitFills++; continue; }
      if (Math.abs(profit) < 1e-9) { agg.zeroProfitFills++; continue; } // רעש-נקודה-צפה = בלתי-קובע
      profits.push(profit);
    }
  }

  source.field = agg.extraction.deltaUsd >= agg.extraction.profitField
    ? "fills[].recvUsd − fills[].paidUsd (USD per-fill mark, stamped at fill time)"
    : "profit (per-fill explicit field, USD as-found)";

  agg.wins = profits.filter((x) => x > 0).length;
  agg.losses = profits.filter((x) => x < 0).length;
  agg.sumProfitUsd = profits.reduce((s, v) => s + v, 0);
  agg.avgWin = agg.wins > 0 ? profits.filter((x) => x > 0).reduce((s, v) => s + v, 0) / agg.wins : null;
  agg.avgLoss = agg.losses > 0 ? Math.abs(profits.filter((x) => x < 0).reduce((s, v) => s + v, 0) / agg.losses) : null;

  if (profits.length === 0) {
    const why = [
      filesMissing ? `${filesMissing} file(s) unreadable` : null,
      filesWrongShape ? `${filesWrongShape} file(s) wrong shape (no fills)` : null,
      !filesRead ? "no file readable" : `${filesRead} file(s) read, 0 fills with usable profit`,
    ].filter(Boolean).join(" · ");
    return { verdict: "INSUFFICIENT-DATA", reason: `no usable profit data — ${why} (fail-honest, nothing invented)`, ...agg, wins: 0, losses: 0, trades: 0, p: null, b: null, ok: false, source };
  }
  const est = estimate({ wins: agg.wins, losses: agg.losses, avgWin: agg.avgWin, avgLoss: agg.avgLoss });
  return { verdict: "OK", ...agg, ...est, trades: agg.wins + agg.losses, source };
}

/* ── recommendSizing — פסק-הדין (SAOS-KELLY/1, observe-only) ────────────────
 * verdicts: OK | CLAMPED | NO-EDGE | INSUFFICIENT-DATA
 * fractionBps = רבע-קלי ב-bps-אחוז-הון, מוצמד ל-[0, policyCapBps];
 * fullKellyBps = המדידה-הגולמית של קלי-המלא (יכול להיות שלילי — כנות-מלאה). */
export function recommendSizing({ stats, policyCaps } = {}) {
  const enforcement = "observe-only — policy.mjs caps govern; enforcement transition needs owner word";
  const base = {
    protocol: KELLY_PROTOCOL, verdict: "INSUFFICIENT-DATA",
    fractionBps: 0, fullKellyBps: 0, p: null, b: null, trades: 0, wins: 0, losses: 0,
    source: { file: null, field: null }, measuredAt: new Date().toISOString(),
    observability: { enforcement, why: null, capBps: null, counters: null },
  };
  if (!stats || stats.verdict !== "OK" || stats.ok !== true || !(stats.trades > 0)) {
    base.observability.why = stats?.verdict === "INSUFFICIENT-DATA"
      ? stats.reason
      : `stats not measurable (verdict=${stats?.verdict ?? "none"})`;
    if (stats?.source) { base.source = { file: stats.source.file, field: stats.source.field }; }
    return base;
  }

  // תקרת-הפוליסה ב-bps (ייעוץ-בלבד — האכיפה-אמת היא תקרות-SBD של policy.mjs);
  // חסרה/זרה → 10000 (הצמדה-מתמטית-בלבד) עם-הערה-כנה.
  let capBps = MAX_CAP_BPS, capNote = "policyCaps.capBps absent — mathematical bound only (100%)";
  const cap = policyCaps && typeof policyCaps === "object" ? policyCaps.capBps : null;
  if (isNum(cap) && cap >= 0 && cap <= MAX_CAP_BPS) { capBps = cap; capNote = `policyCaps.capBps=${cap}`; }
  else if (cap !== null) { capNote = `policyCaps.capBps '${cap}' invalid — fell back to ${MAX_CAP_BPS} (fail-honest note, advisory layer only)`; }

  // קלי-המלא: השבר-המתמטי הגולמי (יכול להיות שלילי — כנות-מלאה) + הצמדה-לגודל
  const rawFull = isNum(stats.b) && stats.b > 0 ? stats.p - (1 - stats.p) / stats.b : 0;
  const full = kellyFraction(stats.p, stats.b);
  const quarter = fractionalKelly(full, 0.25);
  const fullKellyBps = Math.round(rawFull * 10000);
  const rawBps = Math.round(quarter * 10000);
  const fractionBps = Math.max(0, Math.min(capBps, rawBps));
  const verdict = rawFull <= 0 ? "NO-EDGE" : rawBps > capBps ? "CLAMPED" : "OK";

  return {
    protocol: KELLY_PROTOCOL, verdict, fractionBps, fullKellyBps,
    p: stats.p, b: stats.b, trades: stats.trades, wins: stats.wins, losses: stats.losses,
    source: {
      file: stats.source?.file ?? null, field: stats.source?.field ?? null,
      rawFills: stats.rawFills, washFillsExcluded: stats.washFills,
      noProfitFills: stats.noProfitFills, zeroProfitFills: stats.zeroProfitFills,
      malformedLines: stats.malformedLines, avgWinUsd: stats.avgWin, avgLossUsd: stats.avgLoss,
      sumProfitUsd: stats.sumProfitUsd,
    },
    measuredAt: new Date().toISOString(),
    observability: { enforcement, why: null, capBps, capNote, counters: { extraction: stats.extraction } },
  };
}

/* ── writeRecommendation — כתיבה-אטומית (tmp+rename), אפס-סודות ───────────── */
export function writeRecommendation(rec, outPath = DEFAULT_OUT_PATH) {
  const dest = String(outPath || DEFAULT_OUT_PATH);
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(tmp, JSON.stringify(rec, null, 1) + "\n");
  renameSync(tmp, dest); // אטומי: הקוראים לעולם לא רואים חצי-קובץ
  return dest;
}

/* ── CLI — node grids/kelly.mjs: מדידה-אמת על-הפנקסים-החיים ─────────────────
 * קונטקסט-הפוליסה נקרא-כנה (grids/state/policy.json) לתיעוד-השכבה-האוכפת —
 * אך אינו משנה-התנהגות: השכבה-הזאת observe-only במחזור-זה. */
function policyContext() {
  try {
    const j = JSON.parse(readFileSync(join(HERE, "state", "policy.json"), "utf8"));
    const grid = j?.lanes?.grid && typeof j.lanes.grid === "object" ? j.lanes.grid : {};
    return {
      lane: "grid",
      maxNotionalPerOpSbd: isNum(grid.maxNotionalPerOpSbd) ? grid.maxNotionalPerOpSbd : null,
      ownerGateNotionalSbd: isNum(j?.ownerGate?.notionalSbd) ? j.ownerGate.notionalSbd : null,
      note: "enforcement stays in policy.mjs — kelly output is advisory (observe mode)",
    };
  } catch { return null; } // פוליסה-חסרה לא מפריעה למדידה — כנות: null
}

function main() {
  let rec;
  try {
    const stats = readFillStats(DEFAULT_LEDGER_PATHS);
    rec = recommendSizing({ stats, policyCaps: { capBps: MAX_CAP_BPS } });
    rec.observability.policyContext = policyContext();
  } catch (e) {
    rec = {
      protocol: KELLY_PROTOCOL, verdict: "INSUFFICIENT-DATA", fractionBps: 0, fullKellyBps: 0,
      p: null, b: null, trades: 0, wins: 0, losses: 0, source: { file: null, field: null },
      measuredAt: new Date().toISOString(),
      observability: { enforcement: "observe-only — policy.mjs caps govern; enforcement transition needs owner word", why: `measure failed: ${String(e?.message ?? e).slice(0, 200)}` },
    };
  }
  console.log(JSON.stringify(rec)); // שורת-JSON-כנה-אחת
  const out = writeRecommendation(rec);
  if (process.env.KELLY_DEBUG === "1") console.error(`[kelly] recommendation written: ${out}`);
  return rec;
}

/* ריצה-ישירה בלבד — ייבוא-לבדיקות לא מפעיל את ה-CLI.
 * (import.meta.url הוא כבר URL — משווים ישירות מול pathToFileURL של-argv[1]; אין-עטיפה-כפולה.) */
const arg = process.argv[1] ? resolve(process.argv[1]) : null;
if (arg && pathToFileURL(arg).href === import.meta.url) main();
