// ALPHA-PERFORMANCE-MATH — מסנן-הקלי של-הכביש-הסלול (R330 · SAOS-KELLY-CAP/1)
// ══════════════════════════════════════════════════════════════════════════════════════════════
// Owner directive 2026-10-14 (IM trace 1a13acb997251019): "כדי-לוודא-שה-Gearbox-לא-רק-מטפס-
// בהילוכים-אלא-עושה-זאת-על-בסיס-יעילות-מתמטית-טהורה" — Realized P&L / Kelly Criterion Filter.
// DECISIONS #18 (saos-dex).
//
// חוקי-המסנן (המתמטיקה-של-הבעלים, מותאמת-למציאות-ה-estate):
//   1. הקבלות-בגיט הן-הפנק: SAOS-TREASURY-LADDER-RECEIPT/1 + SAOS-ARMY-LADDER-RECEIPT/1
//      כבר-חיים-בגיט (state לא-אפמרלי — חוק #14 SANDBOX-EPHEMERAL). אין-קובץ-מדידה-חדש,
//      אין-כותב-חדש — המסנן קורא-מה שכבר-מפורסם.
//   2. pnl ממומש = דלתא-יתרת-SBD לכל-סוחר בין-קבלות-עוקבות. maker-מכירה-בלבד = הצבה/ביטול
//      נוגעים-ב-STEEM-נעול (חוזר-בביטול) ולא-ב-SBD-נזיל — דלתא-SBD מודדת-תזרים-ממומש
//      בלי-רעש-נעילות. יתרת-SBD-יורדת (ניקוז/קנייה-רעה) = פס-אדום אמיתי.
//   3. פעימה-אינפורמטיבית = |pnl| > eps (יתרת-שקטה = אין-מימוש = אין-מידע-על-יתרון;
//      פעימות-שקטות אינן-מורידות-את-winRate — סטייה-מתועדת-מהנוסחה-המקורית של-הבעלים,
//      שבה-פעימות-אפס-היו-מדללות-את-המדגם-בגלל-עצלות-הסולם-ולא-בגלל-כשל-שוק).
//   4. סדר-הכשלים (כל-שכבה-כנה):
//        קבצי-קבלות-בלתי-קריאים-לגמרי  → metrics-fault → cap = min(תקרת-ההילוך, 25)
//        פעימות-אינפורמטיביות < minBeats → probation    → cap = תקרת-ההילוך × 0.5 (מבחן-קשיח)
//        מדגם-מלא                        → kelly        → cap = min(תקרת-ההילוך, ⌊תקרה × safeKelly × 4⌋)
//      נוסחת-הקלי של-הבעלים מילולית: f = p − ((1−p) / WLR); safe = clamp(f × ½, 0.01, 0.25).
//   5. הקלי יכול-רק-להדק — לעולם-לא-להרפות: הטבלה-בגיט (policy-gears.json) נשארת-התקרה.
//      הקוד קורא-פרמטרים-מהטבלה ואינו-ממציא-תקרות; פרמטר-שבור = ברירת-המחדל-של-ההחלטה.
//   6. כשל-מסנן לעולם-לא-עוצר-את-הכביש: ההילוכים, policy.json ושער-הבעלים ממשיכים-להחזיק;
//      הקלי הוא-מצמץ-ביצועים, לא-בלם. maker-בלבד = צל-4% בשוליים-שליליים עולה-חשיפה,
//      לא-כסף-שרוף — והסולם נשאר-חי-כדי-למדוד-התאוששות.
//   7. אפס-סודות; קריאה-בלבד; mtime-cache לכלכלת-2-ליבות (שבירה-לפי-גודל+זמן-קובץ).
//
// שימוש:
//   import { performanceCap, calculatePerformanceCap, kellyStats, extractBeats } from "./alpha-performance-math.mjs";

import { readFileSync, statSync } from "node:fs";

/** ברירות-המחדל-של-ההחלטה (#18) — פרמטר-שבור/חסר-בטבלה נופל-לכאן, לעולם-לא-ממציאים-אחר. */
export const KELLY_DEFAULTS = Object.freeze({
  minBeats: 10,          // מבחן-קשיח: פחות-מזה = חצי-תקרה
  probationFactor: 0.5,  // חצי-תקרה עד-שנצבר-מידע (מילולי-מההנחיה)
  halfKelly: 0.5,        // חצי-קלי — מקסום-צמיחה-בלי-קריסת-הון
  maxFraction: 0.25,     // תקרת-safeKelly
  minFraction: 0.01,     // רצפת-safeKelly (המייצר-נשאר-חי-למדוד-התאוששות)
  scale: 4,              // נרמול-חזרה-לתקרה: safeKelly 0.25 × 4 = תקרה-מלאה
  fallbackCapSbd: 25,    // רצפת-כשל-מדידה (הילוך-1)
  epsSbd: 0.000001,      // סף-פעימה-אינפורמטיבית
});

const finitePos = (n) => typeof n === "number" && Number.isFinite(n) && n > 0;

/** פרמטרים-מהטבלה: שדה-שבור = ברירת-מחדל (הקוד אינו-ממציא; ההחלטה-#18 היא-המקור). */
export function sanitizeParams(raw) {
  const p = { ...KELLY_DEFAULTS };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return p;
  for (const k of Object.keys(KELLY_DEFAULTS)) {
    const v = raw[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) p[k] = v;
  }
  if (!(p.probationFactor > 0 && p.probationFactor <= 1)) p.probationFactor = KELLY_DEFAULTS.probationFactor;
  if (!(p.scale > 0)) p.scale = KELLY_DEFAULTS.scale;
  if (!(p.minFraction <= p.maxFraction)) { p.minFraction = KELLY_DEFAULTS.minFraction; p.maxFraction = KELLY_DEFAULTS.maxFraction; }
  return p;
}

// ── mtime-cache (כלכלת-2-ליבות: policyGate קורא-לכל-כוונה; הקבצים-קטנים-אבל-גדלים) ──
const CACHE = new Map();
export function resetKellyCache() { CACHE.clear(); }

function readReceiptsCached(receiptPaths) {
  const paths = Array.isArray(receiptPaths) ? receiptPaths : null;
  if (!paths || paths.length === 0 || paths.some((p) => typeof p !== "string" || !p.trim())) {
    throw new Error("receipt paths malformed — metrics fault");
  }
  let anyReadable = false;
  const sig = paths.map((p) => {
    try { const s = statSync(p); anyReadable = true; return `${p}:${Math.round(s.mtimeMs)}:${s.size}`; }
    catch { return `${p}:-1:-1`; } // קובץ-חסר
  }).join("|");
  const hit = CACHE.get(sig);
  if (hit) return hit;
  const recs = [];
  for (const p of paths) {
    let raw = "";
    try { raw = readFileSync(p, "utf8"); } catch { continue; }
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try { const j = JSON.parse(t); if (j && typeof j === "object") recs.push(j); } catch { /* שורה-קרועה — דילוג-כן */ }
    }
  }
  CACHE.clear();
  CACHE.set(sig, recs);
  // חוק-הבעלים (מילולי מההנחיה): תקלת-קובץ = רצפת-מקסימום. כל-קבצי-הפנק חסרים = פנק-שבור
  // (הקבלות-חיות-בגיט!) = fault → רצפה 25. קובץ-קיים-וריק = אין-מימוש-עדיין = probation.
  if (!anyReadable) throw new Error("no receipt file readable — metrics fault");
  return recs;
}

/**
 * תמונות-הון משתי-סכמות-הקבלות (קריאה-בלבד, אפס-המצאה):
 *   treasury: { trader, traderSbd, ... } → תמונה-אחת
 *   army:     { results: [{ account, traderSbd, ... }] } → תמונה-לכל-חשבון
 * מוחזר: [{ at, account, sbd }] — רק-שדות-מוכרים, רק-מספרים-סופיים.
 */
export function readEquitySnapshots(receiptPaths) {
  const recs = readReceiptsCached(receiptPaths);
  const out = [];
  for (const r of recs) {
    const at = typeof r.at === "string" ? r.at : null;
    if (!at) continue;
    if (typeof r.traderSbd === "number" && Number.isFinite(r.traderSbd) && typeof r.trader === "string") {
      out.push({ at, account: r.trader, sbd: r.traderSbd, src: r.schema ?? "?" });
    }
    if (Array.isArray(r.results)) {
      for (const res of r.results) {
        if (res && typeof res.account === "string" && typeof res.traderSbd === "number" && Number.isFinite(res.traderSbd)) {
          out.push({ at, account: res.account, sbd: res.traderSbd, src: r.schema ?? "?" });
        }
      }
    }
  }
  return out;
}

/**
 * פעימות-pnl: דלתא-SBD לכל-חשבון בין-תמונות-עוקבות (ממוין-זמנית).
 * beats = כל-הדלתאות; informative = |pnl| > eps (מימוש-אמיתי).
 */
export function extractBeats(receiptPaths, params) {
  const p = sanitizeParams(params);
  const snaps = readEquitySnapshots(receiptPaths);
  const byAcct = new Map();
  for (const s of snaps) {
    const t = Date.parse(s.at);
    if (!Number.isFinite(t)) continue;
    if (!byAcct.has(s.account)) byAcct.set(s.account, []);
    byAcct.get(s.account).push({ t, sbd: s.sbd });
  }
  const beats = [];
  for (const [account, series] of byAcct) {
    series.sort((a, b) => a.t - b.t);
    for (let i = 1; i < series.length; i++) {
      beats.push({ account, pnl: series[i].sbd - series[i - 1].sbd, at: series[i].t });
    }
  }
  return { beats, snapshots: snaps.length, informative: beats.filter((b) => Math.abs(b.pnl) > p.epsSbd).length, epsSbd: p.epsSbd };
}

/**
 * מתמטיקת-הקלי על-המדגם-האינפורמטיבי — נוסחת-הבעלים מילולית:
 *   winRate = wins/informative · ratio = avgWin/|avgLoss| · f = p − ((1−p)/ratio)
 *   safe = clamp(f × halfKelly, minFraction, maxFraction)
 * sampled=false כשהמדגם-צעיר (< minBeats) — הקורא-מעלה-מצב-probation.
 */
export function kellyStats(beats, params) {
  const p = sanitizeParams(params);
  const all = Array.isArray(beats) ? beats : [];
  const informative = all.filter((b) => b && Number.isFinite(b.pnl) && Math.abs(b.pnl) > p.epsSbd);
  const base = {
    totalBeats: all.length, informative: informative.length, minBeats: p.minBeats,
    wins: null, losses: null, winRate: null, avgWin: null, avgLoss: null,
    winToLossRatio: null, kellyFraction: null, safeKelly: null, sampled: false,
  };
  if (informative.length < p.minBeats) return base;
  const wins = informative.filter((b) => b.pnl > 0);
  const losses = informative.filter((b) => b.pnl < 0);
  const winRate = wins.length / informative.length;
  const avgWin = wins.length ? wins.reduce((s, b) => s + b.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, b) => s + b.pnl, 0) / losses.length) : 0;
  const ratio = avgLoss > 0 ? avgWin / avgLoss : 1;
  const kellyFraction = winRate - ((1 - winRate) / (ratio || 1));
  const safeKelly = Math.max(p.minFraction, Math.min(kellyFraction * p.halfKelly, p.maxFraction));
  return { ...base, sampled: true, wins: wins.length, losses: losses.length, winRate, avgWin, avgLoss, winToLossRatio: ratio, kellyFraction, safeKelly };
}

/**
 * תקרת-הביצועים — סדר-הכשלים-הכנה (ראה-כותרת):
 *   fault → min(base, 25) · probation → ⌊base × 0.5⌋ · kelly → min(base, ⌊base × safe × 4⌋)
 * מוחזר { cap, factor, mode, why, stats } — ה-cap לעולם-לא-עולה-על-base (הטבלה-היא-התקרה).
 */
export function performanceCap(args) {
  const a = args && typeof args === "object" ? args : {};
  const p = sanitizeParams(a.params);
  const base = finitePos(a.baseGearCap) ? a.baseGearCap : null;
  if (base == null) {
    return { cap: p.fallbackCapSbd, factor: 1, mode: "invalid-base", why: "baseGearCap not finite>0 — fallback floor", stats: null };
  }
  let ext;
  try { ext = extractBeats(a.receiptPaths, p); }
  catch (e) {
    const cap = Math.min(base, p.fallbackCapSbd);
    return { cap, factor: cap / base, mode: "metrics-fault", why: `receipts unreadable (${String(e?.message ?? e).slice(0, 80)}) — floor ${p.fallbackCapSbd}`, stats: null };
  }
  const stats = kellyStats(ext.beats, p);
  if (!stats.sampled) {
    const cap = Math.max(1, Math.floor(base * p.probationFactor));
    return { cap, factor: cap / base, mode: "probation", why: `informative fills ${stats.informative}/${p.minBeats} — hard probation ×${p.probationFactor} (owner law: half cap until measured)`, stats };
  }
  const dynamic = Math.floor(base * (stats.safeKelly * p.scale) + 1e-9); // 1e-9: floor-רעש-נקודה-צפה (0.2×4×50 = 19.999…→20)
  const cap = Math.min(dynamic, base);
  return {
    cap, factor: cap / base, mode: "kelly",
    why: `winRate=${stats.winRate.toFixed(3)} WLR=${stats.winToLossRatio.toFixed(3)} kelly=${stats.kellyFraction.toFixed(3)} safe=${stats.safeKelly.toFixed(3)} ×${p.scale} → ${cap}/${base}`,
    stats,
  };
}

/**
 * חתימת-הבעלים מההנחיה (parity): calculatePerformanceCap(metricsPath, baseGearCap) → מספר.
 * קובץ-תקלה → 25 (הרצפה-המינימלית של-ההנחיה); מדגם-צעיר → חצי-תקרה; מדגם-מלא → קלי.
 */
export function calculatePerformanceCap(metricsPath, baseGearCap) {
  return performanceCap({ baseGearCap, receiptPaths: [metricsPath] }).cap;
}
