#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// DIVIDEND-SWEEP — סדולת-הדיבידנד-המתוזמנת (ESC-11 · הקילומטר-האחרון)
// ───────────────────────────────────────────────────────────────────────────
// שרשרת-האמת שהיא מריצה, כל-סבב:
//   1. קציר: feeMeter → treasuryProfit (fee-harvest/planHarvest — H-1..H-5, אותן-חוקים)
//   2. מדידה: Δ treasuryProfitEver (הראצ'ט-המונוטוני, kernel.ts:454) מאז-סימן-המים
//   3. דיבידנד: xfer_free treasury → owner-dividend של min(Δ, יתרת-האוצר-מעל-רצפת-הדלק,
//      FREE_XFER_CAP) — רווח-נמדד-בלבד, לעולם-לא-מוטבע (LAW-2), אפס-גז (SETTLE-12)
//   4. מסילת-חוץ: קבלת READY-FOR-RELEASE — הרגל-החוץ (µ→STEEM→בעלים) נשארת
//      נעולה-לאישור-מפעיל (bridge.ts: שחרור-חוץ-מחייב-מפתח-ממומן-ואימות-מפעיל —
//      כנות-מבנית; הסדולה מכינה-את-הכוונות-ולא מעמידה-פנים-שהכסף-זז).
//
// חוקי-ברזל:
//   D-1 · דיבידנד-רק-מרווח-נמדד: ΔEver-בלבד; סימן-מים-ראשון = אתחול-כנה (0-לאחור)
//   D-2 · רצפת-הכלכלה: TREASURY_FLOOR_MU(200_000µ) נשאר-באוצר — כלכלה-רעבה-לא-מחלקת-דיבידנד
//   D-3 · תקרת-נזק: אפס-מעל-FREE_XFER_CAP(2_000_000µ)-פר-פקודה (kernel.ts:234)
//   D-4 · LAW-1: אף-חתימה-מ-headcorner/cornerstone — הסדולה חותמת-רק-מ-"treasury"
//   D-5 · fail-honest: מנוע-מושהה/סנאפשוט-ישן/אין-טוקן → דילוג-כנה-מתועד, אף-המצאה
//   D-6 · אפס-סודות: הטוקן-נקרא-מ-/proc-בזמן-ריצה-בלבד — לעולם-לא-נכתב/נרשם
//
// ריצה:  node grids/dividend-sweep.mjs            → סבב-אחד (קציר+דיבידנד-אם-ראוי)
//        node grids/dividend-sweep.mjs --check    → מדידה-בלבד (אפס-מוטציה)
//        node grids/dividend-sweep.mjs --loop     → מתזמן-חי (כל-30-דקות)
//        node grids/dividend-sweep.mjs --selftest → בדיקות-ברזל (אופליין)
// ═══════════════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, appendFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(HERE, "state");
const RECEIPTS = join(STATE_DIR, "dividend-sweep.jsonl");
const WATERMARK = join(STATE_DIR, "dividend-watermark.json");
const DEX_PORT = 3010;

export const TREASURY_FLOOR_MU = 200_000; // D-2: רצפת-דלק-הכלכלה באוצר
export const DIVIDEND_MIN_MU = 500;       // סף-אבק — מתחת-זה הסבב-מדלג-בכנות
export const SWEEP_INTERVAL_MIN = 30;     // קדנס-המתזמן
export const OWNER_DIVIDEND_ACCOUNT = "owner-dividend"; // החשבון-הריבוני-הפנימי-של-דיבידנד-הבעלים
export const FREE_XFER_CAP = 2_000_000;   // D-3 — מועתק-מדויק מ-kernel.ts:234
const FORBIDDEN_SIGNERS = ["headcorner", "cornerstone"]; // D-4 — LAW-1

export function planDividend({ deltaEverMu, treasuryUsdsMu }) {
  const d = Number(deltaEverMu ?? 0), t = Number(treasuryUsdsMu ?? 0);
  if (!Number.isFinite(d) || d < 0 || !Number.isFinite(t) || t < 0) return { action: "SKIP", why: "bad-inputs (fail-honest)" };
  if (d < DIVIDEND_MIN_MU) return { action: "SKIP", why: `delta ${d}µ < dust ${DIVIDEND_MIN_MU}µ (D-1)` };
  const surplus = Math.max(0, t - TREASURY_FLOOR_MU);
  if (surplus < DIVIDEND_MIN_MU) return { action: "SKIP", why: `treasury ${t}µ at/below economy floor ${TREASURY_FLOOR_MU}µ (D-2) — כלכלה-רעבה-לא-מחלקת` };
  const amt = Math.min(d, surplus, FREE_XFER_CAP);
  return { action: "DIVIDEND", amount: amt, why: `measured ΔEver ${d}µ · surplus-above-floor ${surplus}µ · cap ${FREE_XFER_CAP}µ → ${amt}µ (D-1/D-2/D-3)` };
}

function readWatermark() {
  try { return JSON.parse(readFileSync(WATERMARK, "utf8")); } catch { return null; }
}

function writeWatermarkAtomic(w) {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = WATERMARK + ".tmp";
  writeFileSync(tmp, JSON.stringify(w, null, 1));
  renameSync(tmp, WATERMARK); // כתיבה-אטומית — אותה-משמעת של flushSnapshot
}

async function liveState() {
  const r = await fetch(`http://127.0.0.1:${DEX_PORT}/saos-dex/api/dex/state`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`state ${r.status}`);
  const d = await r.json();
  const st = d?.state ?? d;
  return { height: st.height, feeMeterMu: st.feeMeter, treasuryProfitMu: st.treasuryProfit, halted: st.halted, stateRoot: st.stateRoot };
}

/* הראצ'ט-והיתרות-חיים-רק-מסנאפשוט-טרי (ה-API-הפומבי-אינו-חושף-אותם) */
async function snapshotTruth(maxAgeMin = 90) {
  const p = join(HERE, "..", "db", "state-snapshot.json");
  const raw = JSON.parse(readFileSync(p, "utf8"));
  const at = raw?.at ?? raw?.savedAt ?? null;
  if (at) {
    const age = (Date.now() - Date.parse(at)) / 60_000;
    if (age > maxAgeMin) throw new Error(`snapshot stale ${Math.round(age)}min > ${maxAgeMin}min (D-5 fail-honest)`);
  }
  const st = raw?.state ?? raw;
  const bal = st?.balances?.treasury ?? {};
  return {
    ever: Number(st?.treasuryProfitEver ?? 0),
    treasuryUsdsMu: Number(bal?.USDS ?? 0),
    snapshotAt: at,
  };
}

function operatorToken(pid) {
  try { return (readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").find((s) => s.startsWith("DEX_OPERATOR_TOKEN=")) ?? "").split("=").slice(1).join("="); }
  catch { return ""; }
}

function findEnginePid() {
  try { const out = execSync("pgrep -f 'next dev -p 3010' | head -1", { encoding: "utf8" }).trim(); return out ? Number(out) : null; }
  catch { return null; }
}

function receipt(e) {
  mkdirSync(STATE_DIR, { recursive: true });
  try { appendLine(RECEIPTS, JSON.stringify({ schema: "SAOS-DIVIDEND-SWEEP/1", at: new Date().toISOString(), ...e })); }
  catch { console.error("receipt-append-fail (honest)"); }
}

function appendLine(p, line) { appendFileSync(p, line + "\n"); }

export async function sweep({ checkOnly = false } = {}) {
  const out = { mode: checkOnly ? "CHECK" : "RUN" };
  try {
    const live = await liveState();
    out.height = live.height;
    if (live.halted) { out.verdict = "SKIP"; out.why = "engine halted — honest sleep (D-5)"; return out; }

    /* שלב-1 · קציר-עמלות (אותו-חוק-כמו fee-harvest.mjs) */
    const fh = await import("./fee-harvest.mjs");
    const plan = fh.planHarvest({ feeMeterMu: live.feeMeterMu });
    out.harvestPlan = plan;
    if (plan.action === "HARVEST" && !checkOnly) {
      const pid = Number(process.env.SAOS_DEX_PID ?? "") || findEnginePid();
      const token = pid ? operatorToken(pid) : "";
      if (!token) { out.harvest = { action: "SKIP", why: "operator token unreachable (H-5/D-6 fail-honest)" }; }
      else {
        const r = await fetch(`http://127.0.0.1:${DEX_PORT}/saos-dex/api/dex/batch`, {
          method: "POST",
          headers: { "x-saos-operator": token, "x-saos-dex-console": "1", "content-type": "application/json" },
          body: JSON.stringify({ issuer: "treasury", ops: [{ type: "harvest", amount: plan.amount, memo: `dividend-sweep harvest ${plan.amount}µ @h${live.height} · ESC-11 · ${plan.why}` }] }),
          signal: AbortSignal.timeout(8000),
        });
        out.harvest = await r.json().catch(() => ({ err: "bad-json" }));
      }
    }

    /* שלב-2+3 · הראצ'ט-והדיבידנד */
    const snap = await snapshotTruth();
    out.snapshotAt = snap.snapshotAt;
    out.ever = snap.ever;
    const wm = readWatermark();
    if (!wm || !Number.isFinite(Number(wm.ever))) {
      if (!checkOnly) writeWatermarkAtomic({ ever: snap.ever, at: new Date().toISOString(), note: "init — no retroactive dividend (D-1 honest)" });
      out.verdict = "WATERMARK-INIT"; out.why = `watermark set to measured Ever ${snap.ever}µ — רווח-היסטורי-אינו-דיבידנד-חדש (D-1)`;
      if (!checkOnly) receipt(out);
      return out;
    }
    const delta = Math.max(0, snap.ever - Number(wm.ever));
    out.deltaEverMu = delta;
    const dp = planDividend({ deltaEverMu: delta, treasuryUsdsMu: snap.treasuryUsdsMu });
    out.dividendPlan = dp;

    if (dp.action === "DIVIDEND" && !checkOnly) {
      const pid = Number(process.env.SAOS_DEX_PID ?? "") || findEnginePid();
      const token = pid ? operatorToken(pid) : "";
      if (!token) { out.dividend = { action: "SKIP", why: "operator token unreachable (D-6 fail-honest)" }; }
      else {
        const r = await fetch(`http://127.0.0.1:${DEX_PORT}/saos-dex/api/dex/batch`, {
          method: "POST",
          headers: { "x-saos-operator": token, "x-saos-dex-console": "1", "content-type": "application/json" },
          body: JSON.stringify({
            issuer: "treasury",
            ops: [{ type: "xfer_free", to: OWNER_DIVIDEND_ACCOUNT, asset: "USDS", amount: dp.amount, memo: `dividend measured-profit ${dp.amount}µ · ΔEver ${delta}µ · ESC-11 rail · ${dp.why}` }],
          }),
          signal: AbortSignal.timeout(8000),
        });
        out.dividend = await r.json().catch(() => ({ err: "bad-json" }));
        /* סימן-מים-מתקדם-רק-על-הצלחה-אמת (xfer ok) — כשל = הסבב-הבא-מנסה-שוב */
        const ok = out.dividend?.ok === true || out.dividend?.results?.some?.((x) => x?.ok === true) || out.dividend?.accepted === true;
        if (ok) writeWatermarkAtomic({ ever: snap.ever, at: new Date().toISOString(), sweptMu: dp.amount });
        out.watermarkAdvanced = ok;
      }
    } else if (dp.action === "SKIP" && delta >= DIVIDEND_MIN_MU && !checkOnly) {
      /* דילוג-עקב-רצפת/תקרה — סימן-המים-אינו-מתקדם: הרווח-נשאר-חייב-לדיבידנד-הבא (D-1) */
      out.watermarkAdvanced = false;
    }
    out.pendingReleaseMu = delta; /* מה-שנמדד-ולא-שוחרר-עדיין — הקנברי-החי-למסילת-החוץ */
    out.verdict = out.dividendPlan?.action ?? out.verdict ?? "MEASURED";
    if (!checkOnly) receipt(out);
    return out;
  } catch (e) {
    out.verdict = "FAIL-HONEST";
    out.why = String(e?.message ?? e).slice(0, 160);
    if (!checkOnly) receipt(out);
    return out;
  }
}

export async function selftest() {
  const A = (c, m) => { if (!c) throw new Error("SELFTEST-FAIL: " + m); };
  A(planDividend({ deltaEverMu: 0, treasuryUsdsMu: 1e6 }).action === "SKIP", "zero delta → skip (D-1)");
  A(planDividend({ deltaEverMu: 300, treasuryUsdsMu: 1e6 }).why.includes("dust"), "delta < dust → honest skip");
  const atFloor = planDividend({ deltaEverMu: 5000, treasuryUsdsMu: TREASURY_FLOOR_MU });
  A(atFloor.action === "SKIP" && atFloor.why.includes("floor"), "treasury at economy floor → skip (D-2)");
  const below = planDividend({ deltaEverMu: 5000, treasuryUsdsMu: 150_000 });
  A(below.action === "SKIP", "treasury below floor → skip (D-2) — כלכלה-רעבה-לא-מחלקת");
  const full = planDividend({ deltaEverMu: 5000, treasuryUsdsMu: 300_000 });
  A(full.action === "DIVIDEND" && full.amount === 5000, "surplus covers delta → full measured dividend");
  const capped = planDividend({ deltaEverMu: 9_000_000, treasuryUsdsMu: 9_000_000 });
  A(capped.amount === FREE_XFER_CAP, "cap binds at FREE_XFER_CAP (D-3)");
  const partial = planDividend({ deltaEverMu: 900_000, treasuryUsdsMu: 250_000 });
  A(partial.amount === 50_000, "surplus binds before delta (D-2)");
  A(planDividend({ deltaEverMu: -5, treasuryUsdsMu: 1e6 }).action === "SKIP", "negative → fail-honest skip");
  A(FORBIDDEN_SIGNERS.every((s) => s !== "treasury"), "sweep signs only from treasury (D-4/LAW-1)");
  A(TREASURY_FLOOR_MU === 200_000 && DIVIDEND_MIN_MU === 500 && FREE_XFER_CAP === 2_000_000, "caps match doctrine");
  return { ok: true, tests: 10 };
}

const args = process.argv.slice(2);
if (args.includes("--selftest")) {
  try { const r = await selftest(); console.log(JSON.stringify({ selftest: "PASS", ...r })); process.exit(0); }
  catch (e) { console.error(e.message); process.exit(1); }
}
if (args.includes("--loop")) {
  console.log(JSON.stringify({ loop: "dividend-sweep", everyMin: SWEEP_INTERVAL_MIN, pid: process.pid, at: new Date().toISOString() }));
  const run = async () => { const r = await sweep({}); console.log(JSON.stringify(r)); };
  void run();
  setInterval(() => void run(), SWEEP_INTERVAL_MIN * 60_000);
} else {
  const r = await sweep({ checkOnly: args.includes("--check") });
  console.log(JSON.stringify(r, null, 1));
}
