// SPREAD-TIERS — N1 · סולם-הידוק-המרווח-מבוסס-ראיות (owner approve trace 1a1629f96941f20d)
// ══════════════════════════════════════════════════════════════════════════════════════════
// החוק: הסולם מתהדק רק כשהראיות מתירות — מילוי-צד-שלישי (לא-צמד-עצמי, לא-wash,
// edge-מדוד ≠ 0) הוא המחיר-המשלם-על-הידוק. בלי-ראיות → הבסיס-החתום (grid-params.json).
//
// למה-כך: N1-צעד-1 (round-24) כיווץ את הבסיס ל-ask 60/bid 100bps. היעד-המאושר —
// דו-ספרתי-bps (askStep ≥ 10 מותר-בשומר validate-params). אבל הידוק-עיוור מקרב-את
// האסקים-אל-המגע בלי-קונה-אמת = דילול-התור ושריפת-RC-מדודה. עתה: כל-מדרגה-נפתחת
// ע"י-מילויי-חוץ-מצטברים-בפנקס (הראיה-שהשוק-החוץ קונה-באמת ברמות-האלה).
//
// המדרגות (STEEM בלבד; רגל-HIVE נשארת-מיקרו-שמרנית — דוקטרינת-אבק R99):
//   T0 (בסיס-חתום)            ask 60 / bid 100
//   T1 (≥2 מילויי-חוץ)        ask 45 / bid 80
//   T2 (≥5 מילויי-חוץ)        ask 30 / bid 60
//   T3 (≥12 מילויי-חוץ)       ask 18 / bid 45   ← דו-ספרתי
//   T4 (≥20 מילויי-חוץ)       ask 12 / bid 35   ← דו-ספרתי-עמוק (N1-המשך, cycle 28)
//   T5 (≥32 מילויי-חוץ)       ask 10 / bid 25   ← רצפות-השומר-בדיוק — היעד-הסופי
//
// רצפות-מוחלטות (מתואמות-לשומר): ask ≥ 10bps · bid ≥ 25bps — לעולם לא מתחת.
// מלמעלה: לעולם לא מעל-הבסיס (הסולם רק מהדק; משמעת-חד-כיוונית).
//
// כנות: התוצא-כולל evidence (ספירת-המילויים-המדודה) וכל-ריצה מפרסמת-את-המדרגה
// בגלוי ב-dex/grid.json (publicDoc.policy.spreadTiers). אין-מדרגה-סמויה.

/** רצפות-השומר — מקור-האמת: grids/validate-params.mjs */
const ASK_FLOOR_BPS = 10;
const BID_FLOOR_BPS = 25;

/* חלון-הראיות (R-GRID-WAR · מדוד-חי 2026-10-22T01:31–01:43Z): לפני-החות הזו הפנקס
 * מכיל את עידן-מלחמת-הבוטים — מילויי-צמד-עצמי שלא-סומנו (הדגל-selfCross נולד עם
 * החוק; ההיסטוריה-הישנה עמומה). מילוי-עמום אינו ראיה-להידוק — רק מילויים שנרשמו
 * תחת-החוק-המדוד (אחרי-החות) נספרים. זו הבחירה-השמרנית-הכנה: הסולם מתחיל-ב-T0
 * ומטפס רק על ראיות-חוץ-אמת אחרי-החוק. */
export const EVIDENCE_WINDOW_CUT = "2026-10-22T01:43:00Z";

const TIERS = [
  { name: "T5", minThirdPartyFills: 32, askStepBps: 10, bidStepBps: 25 },
  { name: "T4", minThirdPartyFills: 20, askStepBps: 12, bidStepBps: 35 },
  { name: "T3", minThirdPartyFills: 12, askStepBps: 18, bidStepBps: 45 },
  { name: "T2", minThirdPartyFills: 5, askStepBps: 30, bidStepBps: 60 },
  { name: "T1", minThirdPartyFills: 2, askStepBps: 45, bidStepBps: 80 },
];

/**
 * ספירת-מילויי-חוץ מדודה: רשומת-מילוי נספרת רק אם
 *  · היא בשרשרת-הנדרשת (ברירת-מחדל steem),
 *  · נרשמה-אחרי-חלון-הראיות (מילויים-ישנים מעידן-מלחמת-הבוטים עמומי-מקור — לא ראיה),
 *  · אינה-מסומנת selfCross (צמד-עצמי — ווליום בלבד, R-GRID-WAR),
 *  · וה-edge-המדוד שלה ≠ 0 (מילוי-בעל-שוליים-חוץ-אמת; wash-מילויים נרשמים edge=0).
 * @param {Array<{chain?: string, selfCross?: boolean, edgeBps?: number, at: string}>} fills
 * @param {string} chain
 */
export function countThirdPartyFills(fills, chain = "steem") {
  if (!Array.isArray(fills)) return 0;
  let n = 0;
  for (const f of fills) {
    if (!f || typeof f !== "object") continue;
    if ((f.chain ?? "steem") !== chain) continue;
    if (typeof f.at !== "string" || Date.parse(f.at) < Date.parse(EVIDENCE_WINDOW_CUT)) continue; // עידן-עמום — לא ראיה
    if (f.selfCross === true) continue; // צמד-עצמי — לעולם לא ראיה-להידוק
    if (!Number.isFinite(f.edgeBps) || f.edgeBps === 0) continue; // בלי-edge-מדוד = לא ראיה
    n++;
  }
  return n;
}

const clampBps = (v, floor) => Math.max(floor, Math.min(v, Number.POSITIVE_INFINITY));

/**
 * גזירת-המדרגה-החיה מהפנקס. טהורה (לא קוראת fs, לא סביבה) — אותה-פונקציה
 * ל-grid-beat, ל-selftest ולבדיקת-CLI.
 * @param {Array} fills רשומות-מילויי-הפנקס (ledger.fills)
 * @param {{ askStepBps: number, bidStepBps: number }} base הבסיס-החתום מ-grid-params.json
 * @param {string} [chain="steem"]
 * @returns {{ tier: string, askStepBps: number, bidStepBps: number, baseAskStepBps: number,
 *             baseBidStepBps: number, thirdPartyFills: number, nextTier: {name, needs} | null,
 *             evidence: string, note: string }}
 */
export function deriveSpreadTiers(fills, base, chain = "steem") {
  const baseAsk = Number.isFinite(base?.askStepBps) ? base.askStepBps : 60;
  const baseBid = Number.isFinite(base?.bidStepBps) ? base.bidStepBps : 100;
  const thirdParty = countThirdPartyFills(fills, chain);

  // הבסיס-החתום הוא תמיד התקרה (הסולם רק מהדק, לעולם לא מרחיב)
  let tier = "T0";
  let ask = clampBps(baseAsk, ASK_FLOOR_BPS);
  let bid = clampBps(baseBid, BID_FLOOR_BPS);

  for (const t of TIERS) {
    if (thirdParty >= t.minThirdPartyFills) {
      tier = t.name;
      ask = clampBps(Math.min(t.askStepBps, baseAsk), ASK_FLOOR_BPS);
      bid = clampBps(Math.min(t.bidStepBps, baseBid), BID_FLOOR_BPS);
      break;
    }
  }

  // המדרגה-הבאה — לפרסום-כנה של מה שיפתח-את-הידוק-הבא
  const activeIdx = TIERS.findIndex((t) => t.name === tier);
  const nextTier = activeIdx === -1
    ? { name: TIERS[TIERS.length - 1].name, needs: TIERS[TIERS.length - 1].minThirdPartyFills - thirdParty }
    : activeIdx > 0
      ? { name: TIERS[activeIdx - 1].name, needs: TIERS[activeIdx - 1].minThirdPartyFills - thirdParty }
      : null;

  return {
    tier,
    askStepBps: ask,
    bidStepBps: bid,
    baseAskStepBps: baseAsk,
    baseBidStepBps: baseBid,
    thirdPartyFills: thirdParty,
    evidenceWindow: `>= ${EVIDENCE_WINDOW_CUT}`,
    nextTier: nextTier && nextTier.needs > 0 ? { name: nextTier.name, needs: nextTier.needs } : null,
    evidence: `${thirdParty} third-party fills counted on the ${chain} ledger tape (window >= ${EVIDENCE_WINDOW_CUT} — pre-law bot-war era is ambiguous, never evidence; selfCross excluded, edge≠0 only)`,
    note: `N1 evidence-gated ladder: tier ${tier} · ladder tightens only as post-law third-party fills accumulate (T1≥2 → 45/80, T2≥5 → 30/60, T3≥12 → 18/45, T4≥20 → 12/35, T5≥32 → 10/25 = validator floors exactly); never below validator floors (ask≥${ASK_FLOOR_BPS}, bid≥${BID_FLOOR_BPS}); never above the sealed base`,
  };
}

/* ── CLI ─────────────────────────────────────────────────────────────────── */
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("spread-tiers.mjs")) {
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const ledgerPath = path.join(process.cwd(), "db", "grid-ledger.json");
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    const r = deriveSpreadTiers(ledger.fills ?? [], { askStepBps: 60, bidStepBps: 100 });
    console.log(`spread-tiers: ${r.tier} · ask ${r.askStepBps}bps / bid ${r.bidStepBps}bps (base ${r.baseAskStepBps}/${r.baseBidStepBps})`);
    console.log(`  ${r.evidence}`);
    console.log(`  next: ${r.nextTier ? `${r.nextTier.name} after ${r.nextTier.needs} more third-party fills` : "at top tier"}`);
    process.exit(0);
  } catch (e) {
    console.error(`spread-tiers: honest skip — ${String(e?.message ?? e).slice(0, 140)}`);
    process.exit(1);
  }
}
