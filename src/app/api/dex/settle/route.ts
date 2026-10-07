import { NextResponse } from "next/server";
import { getCensus, getLiveState, getState, setArenaParams, submitOp, CODE_VERSION, getBurnWindow } from "@/lib/dex/chain";
import {
  genesisTotals, ledgerAudit, runExam, realMoneyAudit, stabilityCheck, runwayCheck,
} from "@/lib/dex/settle";
import { DEFAULT_PARAMS } from "@/lib/dex/mm";
import { poolMid, getPool } from "@/lib/dex/amm";
import { poolKey, avail, funderFor, LADDER_FUEL_FLOOR, MINT_FUEL_CAP, REFUEL_CAP } from "@/lib/dex/kernel";
import { consoleGuard } from "@/lib/dex/guard";
import { operatorAuth } from "@/lib/operator-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/* ── cache: הביקורת-החיה נוגעת ברשתות-ציבוריות — 25ש׳ מנוחה-בין-סריקות ── */
interface ReportShape { at: number; payload: Record<string, unknown> }
const g = globalThis as unknown as { __settleReport?: ReportShape };
const CACHE_MS = 25_000;

/** GET /api/dex/settle — דוח-עמדת-הסליקה המלא:
 * census (סוכנים) · ledger (חשבונאות-ברזל) · exam (מבחן-סוכנים) ·
 * realMoney (כסף-אמת 5-רשתות + אימות-עיגון-טרי) · stability (האם-הכל-יושב) */
export async function GET() {
  const cached = g.__settleReport;
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return NextResponse.json({ ...cached.payload, cached: true, cachedAgeMs: Date.now() - cached.at });
  }
  const st = getLiveState();
  const totals = genesisTotals();
  const ledger = ledgerAudit(st, totals);
  const exam = runExam(st);
  const realMoney = await realMoneyAudit();
  const stability = stabilityCheck(st);
  const runway = runwayCheck(st, undefined, getBurnWindow());
  const state = getState();
  const payload = {
    ok: true,
    at: new Date().toISOString(),
    burnSamplesLen: getBurnWindow().length, // דיאגנוסטיקה (SETTLE-5) — אורך-טבעת-הדגימה שה-route רואה
    codeVersion: CODE_VERSION, // טביעת-קוד: גילוי-דעיכת-תהליך (תהליך-ישן מריץ קוד-ישן — ממצא-חי 2026-09)
    height: state.height,
    stateRoot: state.stateRoot,
    halted: state.halted,
    census: { agents: getCensus() },
    ledger,
    exam,
    realMoney,
    stability,
    runway,
    verdict: {
      ledgerOk: ledger.ok,
      examOk: exam.ok,
      realMoneyOk: realMoney.ok,
      marketSitting: stability.sitting,
      allSettled: ledger.ok && exam.ok && realMoney.ok && stability.sitting && !state.halted,
    },
  };
  g.__settleReport = { at: Date.now(), payload };
  return NextResponse.json(payload);
}

/** POST /api/dex/settle — פעולת-ייצוב-מיידית:
 * 1) הדקת-פרמטרים: הארנה עוברת לתצורת-הסליקה (ספרד-32bps, 3-רמות, צעד-20bps)
 * 2) מנעול-בריכה-חד-פעמי: סוגרים-את-הפער-המלא בין-הבריכה לפייר (עד-250k µ)
 * ממפול-רגיל בלבד — כל-הפעולות מאושרות-על-הספר, אפס-עקיפות. */
export async function POST(req: Request) {
  // P0(25-a): שער-מפעיל — מוטציה דורשת טוקן x-saos-operator (בלי DEX_OPERATOR_TOKEN: 503 fail-closed)
  const oa = operatorAuth(req);
  if (oa) return oa;

  // FIX(FOUNDRY top-bug): שער-קונסולה — מוטציה-דורשת-כותרת-מנהלת
  const g = consoleGuard(req);
  if (g) return g;

  const params = setArenaParams({ ...DEFAULT_PARAMS });
  const st = getLiveState();
  const pushed: { kind: string; detail: string }[] = [];

  // (0) עירוי-חיות מיידי (THE-REFUEL + THE-FOUNTAIN): אוצר-ריק? הטבעה-עצמית
  // מגובה-עמלות-מדודות (profit-שהוכר + feeMeter-מעל-רצפת-הסולם) קודם — ואז כל-
  // סוכני-הבחינה/הגריד מקבלים-קרדיטים. הטבעה-מגובה-וחד-פעמית: האינווריאנטה
  // Σcredits+gas−minted===ג'נזיס וביקורת-העמלות עומדות.
  {
    const trCr = st.credits["treasury"] ?? 0;
    // FIX(SETTLE-9): היה-קידוד-קשיח (8_000/100_000) במקום קבועי-הגרעין — דריפט-סיכון
    // בלוגיקת-כסף. הסף (60k) גבוה-מכוון מהפעימה-האוטומטית (10k ב-mm.ts):
    // settle-הוא פעולת-מפעיל — מטעין-עומק, לא מתערב-בכל-נשימה.
    const fuelAvail = Math.max(0, st.treasuryProfit) + Math.max(0, Math.floor(((st.feeMeter ?? 0) - LADDER_FUEL_FLOOR) / 2));
    if (trCr < 60_000 && fuelAvail > 20_000) {
      const mint = Math.min(MINT_FUEL_CAP, fuelAvail);
      if (mint > 0) {
        const r = submitOp({ type: "mint_fuel", issuer: "treasury", nonce: `settle-fountain-${Date.now().toString(36)}`, to: "treasury", amount: mint });
        pushed.push({ kind: "mint-fuel", detail: r.queued ? `treasury self-mint +${mint}µ credits (fees-backed: profit ${st.treasuryProfit} + meter ${st.feeMeter})` : `rejected: ${r.reason}` });
      }
    }
  }
  const EXAM_AGENTS = ["soldier-1", "soldier-2", "soldier-3", "soldier-4", "bot-a", "bot-b", "bot-c"] as const;
  for (const ag of EXAM_AGENTS) {
    const c = st.credits[ag] ?? 0;
    if (c < 8_000) {
      const amt = Math.min(30_000 - c, REFUEL_CAP);
      if (amt > 0) {
        // ממנה-מדורג (SETTLE-5/9 + roast-79 — funderFor אחד בגרעין): ארנה → בוטים → אוצר → מפעיל
        const funder = funderFor(st, amt, ag);
        const r = submitOp({ type: "refuel", issuer: funder, nonce: `settle-refuel-${ag}-${Date.now().toString(36)}`, to: ag, amount: amt });
        pushed.push({ kind: "refuel", detail: r.queued ? `${ag} +${amt}µ credits ← ${funder} (had ${c})` : `rejected: ${r.reason}` });
      }
    }
  }

  // EXEC-CD-28 · SOVEREIGN-TRADER FUEL: המפעיל-הריבוני הוא-ראשון-בתור-הדלק —
  // בלעדיו-אין-סוואף-מפעיל (הדלק-יבש הקפיא את סוואף-הבית — נמדד-חי h153128:
  // batch(operator):insufficient-credits). אותו-funderFor מדורג, אותן-תקרות,
  // אותו-op-גרעיני (refuel = העברה-טהורה-אפס-הטבעה — האינווריאנטה עומדת).
  // הרצפה נמוכה-בכוונה (5k) כדי-שהמפעיל-יסחור-ברציפות; המזרקה האוטומטית
  // (mm.ts) מטעינה-את-הסולם כשהמד-חוצה-את-רצפת-הגרעין (8k).
  for (const ag of ["operator", "treasury"] as const) {
    const c = st.credits[ag] ?? 0;
    if (c < 5_000) {
      const amt = Math.min(20_000 - c, REFUEL_CAP);
      if (amt > 0) {
        const funder = funderFor(st, amt, ag);
        const r = submitOp({ type: "refuel", issuer: funder, nonce: `settle-refuel-${ag}-${Date.now().toString(36)}`, to: ag, amount: amt });
        pushed.push({ kind: "refuel-sovereign", detail: r.queued ? `${ag} +${amt}µ credits ← ${funder} (had ${c})` : `rejected: ${r.reason}` });
      }
    }
  }

  const m = { base: "SAOS", quote: "USDS" } as const;
  const p = getPool(st, poolKey(m.base, m.quote));
  const fair = stabilityCheck(st).fair;
  if (p && fair > 0) {
    const pm = poolMid(p);
    const gapBps = Math.floor(((pm - fair) / fair) * 10_000);
    if (Math.abs(gapBps) >= 30) {
      const assetIn = gapBps > 0 ? m.base : m.quote;
      const rIn = assetIn === p.a ? p.ra : p.rb;
      const fullGap = Math.floor(Math.abs(Math.floor((rIn * gapBps) / 10_000)));
      const size = Math.min(Math.max(fullGap, 10_000), 250_000, avail(st, "arena", assetIn));
      if (size >= 5_000) {
        const r = submitOp({ type: "pool_swap", issuer: "arena", nonce: `settle-pool-${Date.now().toString(36)}`, pair: poolKey(m.base, m.quote), assetIn, amount: size });
        pushed.push({ kind: "pool-peg", detail: r.queued ? `${size}µ ${assetIn} → pool (gap ${gapBps}bps)` : `rejected: ${r.reason}` });
      }
    } else {
      pushed.push({ kind: "pool-peg", detail: `gap ${gapBps}bps ≤ 30 — no action` });
    }
  }

  return NextResponse.json({
    ok: true,
    params,
    pushed,
    note: "pegkeeper continues per-tick (pool-lock every 2 ticks, ladder-band every 4)",
  });
}
