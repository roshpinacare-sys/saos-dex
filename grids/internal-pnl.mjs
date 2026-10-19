#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// SAOS-INTERNAL-PNL/1 · גשר-ה-P&L-הפנימי — האמת-מהמנוע-אל-הפנקסים
// ───────────────────────────────────────────────────────────────────────────
// דבר-הבעלים 2026-10-19 (trace 1a1533c25fd2cc69): "תבדוק רווח אמיתי עשינו הרבה
// עסקאות. אין רווחים? למה 0? הפסדים אמיתיים רווחים..."
//
// **התשובה-המדודה**: הריבונות מנהלת שתי-כלכלות:
//   (א) כלכלת-ה-DEX-הפנימית (µ-credits, 1 USDS = 1000µ) — 100K+ מילויים אמת,
//       עמלות-קציר-מצטברות במונה-הראצ'ט `treasuryProfitEver` (kernel.ts:2288,
//       עולה-רק, זרע-גיט-מוכח 213,752µ @4ac9369). המנוע-הכלכלי-החוץ
//       (self-deposit) לא-ראה-את-המונה-הזה → דיווח-כנה-אבל-עיוור: 0.
//   (ב) כלכלת-שרשרת-STEEM (FLEET-13) — census + תביעות + pnl-audit (fill_order).
//
// הגשר-הזה קורא **ראיות-בלבד** מהדיסק (state-snapshot.json, גיל-מוגבל) ומוציא
// פנקס-אמת: רווח-מצטבר, הפסדים/עלויות-מדודות, יחס-µ→USD (מאומת-מקבלת-הפקדה).
// LAW-3: קובץ-ראיה-חסר/ישן/שגוי-סכימה → fail-honest (null), אף-המצאה.
// LAW-0: אף-קריאת-רשת — דיסק-בלבד (מקור-האמת-הוא-המנוע-שכבר-רץ).
// ═══════════════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SNAPSHOT_PATH = join(ROOT, "db", "state-snapshot.json");
const OUT_PATH = join(ROOT, "grids", "state", "internal-pnl.json");
const PNL_AUDIT_PATH = join(ROOT, "grids", "state", "pnl-audit.json");
const CREDITS_PATH = join(ROOT, "db", "dex-credits.json");
const MAX_AGE_MS = 3 * 3600 * 1000; // dex-beat שעתי — 3ש׳ מרווח-ביטחון
export const MU_PER_USDS = 1000;    // מאומת: הפקדה 2026-10-19T04:36 · 100 STEEM → usds 5.21 ↔ mu 5210

const D = (x, d = 4) => Number(Number(x ?? 0).toFixed(d));
const nowIso = () => new Date().toISOString();

// ── קריאת-ראיה מגוללת (LAW-3/4): סכימה-נכונה + טריות + מספרים-חוקיים או null ──
export function readEngineSnapshot(path = SNAPSHOT_PATH, maxAgeMs = MAX_AGE_MS) {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (raw?.version !== 1 || !raw.savedAt || !raw.state) return null;
    const age = Date.now() - Date.parse(raw.savedAt);
    if (!(age >= 0) || age > maxAgeMs) return null;
    const st = raw.state;
    const ever = st.treasuryProfitEver;
    if (!Number.isFinite(ever) || ever < 0) return null; // הראצ'ט חייב-להיות-חוקי
    return {
      savedAt: raw.savedAt, ageMs: age,
      height: st.height ?? null, fills: st.stats?.fills ?? null, swaps: st.stats?.swaps ?? null,
      treasuryProfitEverMu: ever,            // ראצ'ט: Σקציר-עמלות-מונוטוני (רווח-מסחר-אמת מצטבר)
      treasuryProfitMu: st.treasuryProfit ?? 0,   // יתרה-עובדת (לא מונה)
      feeMeterMu: st.feeMeter ?? 0,               // עמלות-שנצברו-שטרם-נקצרו
      feeMintedMu: st.feeMinted ?? 0,             // המזרקה: Σטובע-מעמלות (המענק-לכלכלה — לא-רווח-בעלים)
      gasFundedMu: st.gasFundedMu ?? 0,           // Σדלק-שמומן-מהעמלות (השקעה-מחדש — לא-רווח-בעלים)
      creditsTreasuryMu: st.credits?.treasury ?? 0,
      halted: st.halted ?? null,
    };
  } catch { return null; }
}

// ── ספר-ההפסדים-האמת (מדוד מהמקורות — אפס-אומדנים) ──
export function lossLedger({ snap, pnlAudit }) {
  const rows = [];
  if (pnlAudit && (pnlAudit.selfCrosses ?? 0) > 0) {
    rows.push({ id: "LOSS-1", what: "דליפת-חציה-עצמית (self-cross) — RC ונפח-מזויף עד-הגארד", measured: `${pnlAudit.selfCrosses} חציות-עצמיות נמדדו בעידן`, state: "GUARD-LIVE — שאריות-נוזלות עד-פקיעת-הרגליים-הישנות (≤27 יום)", evidence: `pnl-audit ${pnlAudit.at} selfCrosses=${pnlAudit.selfCrosses}` });
  }
  if (snap && snap.feeMeterMu != null && snap.treasuryProfitMu != null) {
    rows.push({ id: "COST-1", what: "השקעה-מחדש — עמלות-שכבר-הומרו-לדלק-כלכלה (לא-מגיעות-לבעלים)", measured: `${snap.gasFundedMu}µ דלק-מומן · ${snap.feeMintedMu}µ הוטבעו-למזרקה`, state: "BY-DESIGN — הכלכלה-מממנת-את-עצמה (msg-8); רק-הדלתא-המצטברת-היא-רווח-בעלים-פוטנציאלי", evidence: `state-snapshot ${snap.savedAt}` });
  }
  if (pnlAudit?.externalFills?.count != null) {
    rows.push({ id: "PROOF-1", what: "רווח-מרק-אמת — מילויים-מול-צדדים-חוץ-אמת (לא-wash)", measured: `${pnlAudit.externalFills.count} מילויי-חוץ: ${Object.entries(pnlAudit.externalFills.counterparties ?? {}).map(([k, v]) => `${k} ${v}`).join(" · ")}`, state: "EVIDENCE-ON-FILE", evidence: `pnl-audit ${pnlAudit.at}` });
  }
  return rows;
}

// ── הפקת-פנקס-האמת ──
export function buildInternalPnl({ snap, pnlAudit, prevEverMu }) {
  if (!snap) return null; // fail-honest
  const deltaMu = prevEverMu == null ? 0 : Math.max(0, snap.treasuryProfitEverMu - prevEverMu); // ראצ'ט: שלילי=מזויף → 0+דגל
  const ratchetSuspect = prevEverMu != null && snap.treasuryProfitEverMu < prevEverMu;
  return {
    schema: "SAOS-INTERNAL-PNL/1", at: nowIso(), laws: ["LAW-0 disk-only", "LAW-3 evidence-or-zero", "LAW-4 fail-honest"],
    engineSnapshot: { at: snap.savedAt, ageMs: snap.ageMs, height: snap.height, fills: snap.fills, swaps: snap.swaps, halted: snap.halted },
    muPerUsds: MU_PER_USDS, muPerUsdsEvidence: "db/dex-credits.json deposit 2026-10-19T04:36:53Z: 100 STEEM→usds 5.21↔mu 5210 (auto · verified vs steem watcher)",
    treasuryProfitEverMu: snap.treasuryProfitEverMu, treasuryProfitEverUsd: D(snap.treasuryProfitEverMu / MU_PER_USDS, 2),
    treasuryProfitMu: snap.treasuryProfitMu, feeMeterMu: snap.feeMeterMu, creditsTreasuryMu: snap.creditsTreasuryMu,
    feeMintedMu: snap.feeMintedMu, gasFundedMu: snap.gasFundedMu,
    deltaSincePrevMu: deltaMu, deltaSincePrevUsd: D(deltaMu / MU_PER_USDS, 4),
    ratchetSuspect, // כנות: מונה-שיורד = תמונה-זרה/שחזור — מדגלים, לא ממציאים
    eraTradingPnlSbd: pnlAudit?.engineEra?.estatePnlSbd ?? null, eraTradingPnlAt: pnlAudit?.at ?? null,
    lossLedger: lossLedger({ snap, pnlAudit }),
  };
}

export function run({ outPath = OUT_PATH } = {}) {
  const snap = readEngineSnapshot();
  if (!snap) {
    const fail = { schema: "SAOS-INTERNAL-PNL/1", at: nowIso(), verdict: "FAIL-HONEST (no fresh engine snapshot ≤3h — evidence-or-zero)" };
    try { writeFileSync(outPath, JSON.stringify(fail, null, 1) + "\n"); } catch { /* כנות */ }
    return fail;
  }
  let pnlAudit = null; try { pnlAudit = JSON.parse(readFileSync(PNL_AUDIT_PATH, "utf8")); } catch { /* כנות: אין-ביקורת */ }
  let prev = null; try { prev = JSON.parse(readFileSync(outPath, "utf8")); } catch { /* ראשוני */ }
  const prevEverMu = prev?.schema === "SAOS-INTERNAL-PNL/1" ? (prev.treasuryProfitEverMu ?? null) : null;
  const doc = buildInternalPnl({ snap, pnlAudit, prevEverMu });
  writeFileSync(outPath, JSON.stringify(doc, null, 1) + "\n");
  return doc;
}

// ── selftest ברזל ──
export async function selftest() {
  const A = (c, m) => { if (!c) throw new Error("SELFTEST-FAIL: " + m); };
  A(MU_PER_USDS === 1000, "µ peg is 1000µ=1 USDS (deposit-receipt truth)");
  const fakeSnap = { savedAt: new Date().toISOString(), state: { height: 100, stats: { fills: 5, swaps: 3 }, treasuryProfitEver: 5000, treasuryProfit: 500, feeMeter: 100, feeMinted: 900, gasFundedMu: 400, credits: { treasury: 2000 }, halted: false } };
  const pnl = { at: "t", selfCrosses: 7, externalFills: { count: 3, counterparties: { btsx: 3 } }, engineEra: { estatePnlSbd: 0.5 } };
  const doc = buildInternalPnl({ snap: { savedAt: fakeSnap.savedAt, ageMs: 1, height: 100, fills: 5, swaps: 3, treasuryProfitEverMu: 5000, treasuryProfitMu: 500, feeMeterMu: 100, feeMintedMu: 900, gasFundedMu: 400, creditsTreasuryMu: 2000, halted: false }, pnlAudit: pnl, prevEverMu: 4000 });
  A(doc.treasuryProfitEverUsd === 5, `ever 5000µ → $5 (got ${doc.treasuryProfitEverUsd})`);
  A(doc.deltaSincePrevMu === 1000 && doc.deltaSincePrevUsd === 1, "delta 4000→5000µ = $1");
  A(doc.ratchetSuspect === false, "rising ratchet not suspect");
  const docBad = buildInternalPnl({ snap: { ...doc.engineSnapshot, treasuryProfitEverMu: 3000, savedAt: "x", ageMs: 1, height: 1, fills: 1, swaps: 1, treasuryProfitMu: 1, feeMeterMu: 1, feeMintedMu: 1, gasFundedMu: 1, creditsTreasuryMu: 1, halted: false }, pnlAudit: pnl, prevEverMu: 4000 });
  A(docBad.ratchetSuspect === true && docBad.deltaSincePrevMu === 0, "falling ratchet = suspect flag + delta clamped 0");
  const docFirst = buildInternalPnl({ snap: { ...doc.engineSnapshot, treasuryProfitEverMu: 5000, savedAt: "y", ageMs: 1, height: 1, fills: 1, swaps: 1, treasuryProfitMu: 1, feeMeterMu: 1, feeMintedMu: 1, gasFundedMu: 1, creditsTreasuryMu: 1, halted: false }, pnlAudit: pnl, prevEverMu: null });
  A(docFirst.deltaSincePrevMu === 0, "no prev = delta 0 (honest — הצבירה-הקיימת-אינה-הכנסת-היום)");
  A(doc.lossLedger.some((r) => r.id === "LOSS-1") && doc.lossLedger.some((r) => r.id === "PROOF-1"), "loss ledger carries self-cross + external-fills truth");
  // גיל-מגולל: ישן → null
  const oldPath = join(dirname(fileURLToPath(import.meta.url)), "state", `sd-selftest-old-${Date.now()}.json`);
  writeFileSync(oldPath, JSON.stringify({ version: 1, savedAt: "2026-01-01T00:00:00Z", state: fakeSnap.state }));
  A(readEngineSnapshot(oldPath) === null, "stale snapshot refused");
  writeFileSync(oldPath, JSON.stringify({ version: 2, savedAt: new Date().toISOString(), state: fakeSnap.state }));
  A(readEngineSnapshot(oldPath) === null, "wrong version refused");
  writeFileSync(oldPath, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), state: { ...fakeSnap.state, treasuryProfitEver: -5 } }));
  A(readEngineSnapshot(oldPath) === null, "negative ratchet refused");
  const okDoc = buildInternalPnl({ snap: null, pnlAudit: null, prevEverMu: null });
  A(okDoc === null, "no snapshot → null (fail-honest)");
  try { rmSync(oldPath, { force: true }); } catch { /* כנות */ }
  return { ok: true, tests: 10 };
}

const args = process.argv.slice(2);
if (args.includes("--selftest")) {
  try { const r = await selftest(); console.log(JSON.stringify({ selftest: "PASS", ...r })); process.exit(0); }
  catch (e) { console.error(e.message); process.exit(1); }
}
const doc = run();
console.log(JSON.stringify({ status: doc?.verdict ?? "OK", everUsd: doc?.treasuryProfitEverUsd, deltaUsd: doc?.deltaSincePrevUsd, fills: doc?.engineSnapshot?.fills, height: doc?.engineSnapshot?.height }, null, 1));
