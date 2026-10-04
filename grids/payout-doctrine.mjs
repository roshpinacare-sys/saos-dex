// PAYOUT-DOCTRINE (Z-90-c) — קבלת-הדוקטרינה-לתשלום: בנייה-דטרמיניסטית-מוקדמת של החלטות-הבשלות
// ═══════════════════════════════════════════════════════════════════════════════════════════
// הבשלות של קו-ההמרה (131.856 SBD) מגיעה בחלון 2026-10-06T00:02:12Z → 2026-10-07T17:06:39Z,
// עם הערכה-חיה 1266.633 STEEM (הכל מילולית ב-grids/state/convert-plan.json — נקרא-חי, לא מוקשה).
// המודול הזה לא ממציא כלום: כל-קלט מצוטט לקבלה/שורת-קוד כתובה, ואם-אין-קבוע-כתוב — null עם
// שער-החלטת-בעלים ("החלטת-בעלים"). חיפוש-הדוקטרינה מתועד-מילולית: ב-grids/rules.mjs,
// grids/counter-grid.mjs, grids/strategies.mjs, grids/daily-cycle.mjs אין-שום-קבוע-הקצאת-דלק-
// לתשלום (יש רק רזרבות-גריד מקומיות: counter-grid.mjs:26 / peg.mjs:56 reserveSteem 0.5 —
// לא דוקטרינת-הקצאה). לכן: הקצאות-הדלק נשארות null עד שהבעלים כותב את-הדוקטרינה.
// אמת-מספרים: הערכת-התשלום מסומנת "הערכה בלבד" (floats עד conversion_date — steem
// database.cpp process_conversions, Z-89); ספירת-הזמן מחושבת-בזמן-ריצה עם asof מוטבע.
// אפס-מפתחות, אפס-רשת-חתימה, fail-closed: קלט-חסר → null כנה, לעולם לא מספר-מומצא.

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(HERE, "state");
const RECEIPT_PATH = join(STATE_DIR, "payout-doctrine.json");

export const PAYOUT_DOCTRINE_SCHEMA = "payout-doctrine-v1";

/** קבוע-הציטוט: עמלת-יצירת-קהילה כפי-שכתובה-בקוד (grids/community.mjs) — לא המצאה. */
export const COMMUNITY_COST_CITATION = {
  source: "grids/community.mjs",
  lines: { policy: 39, feeBufferSteem: 44, accountFeeDefault: 52, needFormula: 78, chainMeasured: 137 },
  accountFeeSteem: 3,        // planCommunity default (line 52) + chain-measured get_chain_properties (community-plan.json "accountFee": 3)
  feeBufferSteem: 0.1,       // COMMUNITY_POLICY.FEE_BUFFER_STEEM (line 44)
  formula: "need = accountFee + FEE_BUFFER_STEEM (line 78)",
};

/** חיפוש-הדוקטרינה — מתועד-מילולית: איפה חיפשנו ומה נמצא (כנות-שלילית שמורה). */
export const DOCTRINE_SEARCH = {
  searched: ["grids/rules.mjs", "grids/counter-grid.mjs", "grids/strategies.mjs", "grids/daily-cycle.mjs"],
  fuelAllocationConstantsFound: false,
  closestWrittenReserves: [
    { source: "grids/counter-grid.mjs:26", constant: "reserveSteem: 0.5", meaning: "per-grid reserve — not a payout-allocation doctrine" },
    { source: "grids/peg.mjs:56", constant: "reserveSteem: 0.5", meaning: "per-grid reserve — not a payout-allocation doctrine" },
  ],
  ownerDecisionTerm: "החלטת-בעלים",
};

export const ESTIMATE_LABEL = "הערכה בלבד";

/** קריאת-קבלה fail-closed — קובץ-חסר/פגום → null (לעולם לא זורק). */
export function readJsonReceipt(path) {
  try {
    if (!existsSync(path)) return null;
    const j = JSON.parse(readFileSync(path, "utf8"));
    return j && typeof j === "object" ? j : null;
  } catch { return null; }
}

/** חילוץ-טהור: שורת-STEEM הנזילה מפנקס-האחזקה (custody-v1 rows). */
export function custodyLiquidSteem(custodyReceipt) {
  const rows = Array.isArray(custodyReceipt?.rows) ? custodyReceipt.rows : [];
  const row = rows.find((r) => r && r.chain === "steem" && r.asset === "STEEM" && r.venue === "chain-liquid");
  const amount = typeof row?.amount === "number" ? row.amount : Number.parseFloat(row?.amount);
  return Number.isFinite(amount) ? amount : null;
}

/** חילוץ-טהור: חלון-הבשלות מתוך שורות-ההמרה המילוליות (min/max conversion_date). */
export function maturityWindow(convertReceipt) {
  const rows = Array.isArray(convertReceipt?.pendingRequests) ? convertReceipt.pendingRequests : [];
  const tss = rows.map((r) => Date.parse(r?.conversion_date)).filter((t) => Number.isFinite(t));
  if (tss.length === 0) return { earliest: null, latest: null, rows: 0 };
  const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
  return { earliest: iso(Math.min(...tss)), latest: iso(Math.max(...tss)), rows: tss.length };
}

/** ספירת-זמן טהורה: דקות עד-הבשלות המוקדמת/המאוחרת, מ-asof קבוע (דטרמיניסטי לבדיקות). */
export function countdownMinutes({ earliest, latest, asof }) {
  const now = Date.parse(asof);
  if (!Number.isFinite(now)) return { minutesUntilEarliest: null, minutesUntilLatest: null, asof };
  const to = (ts) => {
    const t = Date.parse(ts);
    if (!Number.isFinite(t)) return null;
    const minutes = Math.round(((t - now) / 6e4) * 10) / 10;
    return { minutes, passed: minutes < 0 };
  };
  return { minutesUntilEarliest: to(earliest), minutesUntilLatest: to(latest), asof };
}

/** המתכנן-הטהור: קלטות-מצוטטות → תוכנית-החלטות-אם-הבשלות-תיפול. אפס-IO. */
export function planPayoutDoctrine({
  convert = null,          // {pendingSbd, maturityEstimate:{estimate, semantics}, ...} מתוך convert-plan.json
  custody = null,          // {at, liquidSteem} מתוך custody.json
  communityCost = COMMUNITY_COST_CITATION,
  doctrineSearch = DOCTRINE_SEARCH,
  nowIso = null,
} = {}) {
  const pendingSbd = typeof convert?.pendingSbd === "number" ? convert.pendingSbd : null;
  const estimate = typeof convert?.maturityEstimate?.estimate === "number" ? convert.maturityEstimate.estimate : null;
  const estimateSemantics = convert?.maturityEstimate?.semantics ?? null;
  const win = maturityWindow(convert);
  const liquidSteem = custodyLiquidSteem(custody);
  const needTotal = Math.round((communityCost.accountFeeSteem + communityCost.feeBufferSteem) * 1000) / 1000;

  // אם-הבשלות-תיפול: נזיל-צפוי = נזיל-נוכחי + הערכה (הערכה בלבד — לא עובדה)
  const projectedLiquidSteem = liquidSteem != null && estimate != null
    ? Math.round((liquidSteem + estimate) * 1000) / 1000
    : null;

  const communityCreationReady = projectedLiquidSteem != null ? projectedLiquidSteem >= needTotal : null;
  const communityCreationReadyBeforePayout = liquidSteem != null ? liquidSteem >= needTotal : null;

  // אין-קבוע-דוקטרינה-כתוב → אף-מספר לא מומצא: הקצאות null + שער-החלטת-בעלים
  const fuelAllocations = {
    counterGridSteem: null,
    agentsFuelSteem: null,
    cexRailFloatSteem: null,
    communityReserveSteem: null,
    precondition: `${doctrineSearch.ownerDecisionTerm} — אין-קבוע-הקצאת-דלק-כתוב ב-repo (חיפוש מתועד ב-doctrineSearch); אף-מספר לא מומצא`,
  };

  const cd = countdownMinutes({ earliest: win.earliest, latest: win.latest, asof: nowIso });

  return {
    schema: PAYOUT_DOCTRINE_SCHEMA,
    at: nowIso,
    ok: pendingSbd != null && estimate != null && liquidSteem != null,
    inputs: {
      convert: {
        source: "grids/state/convert-plan.json",
        pendingSbd,
        pendingCount: win.rows,
        maturityWindow: { earliest: win.earliest, latest: win.latest },
        payoutEstimate: {
          value: estimate,
          labeledAs: ESTIMATE_LABEL,
          semantics: estimateSemantics,
          law: "payout floats until conversion_date (steem database.cpp process_conversions, Z-89)",
        },
        discountBps: typeof convert?.discountBps === "number" ? convert.discountBps : null,
      },
      custody: {
        source: "grids/state/custody.json (steem row, ONCHAIN_REAL)",
        at: custody?.at ?? null,
        liquidSteem,
        liquidSbd: custody?.rows?.find?.((r) => r?.chain === "steem" && r?.asset === "SBD")?.amount ?? null,
        pendingSbdInConvert: custody?.rows?.find?.((r) => r?.chain === "steem" && r?.asset === "SBD-IN-CONVERT")?.amount ?? null,
      },
      communityCost: communityCost,
      doctrineSearch: doctrineSearch,
    },
    projection: {
      formula: "projectedLiquidSteem = custody.liquidSteem + payoutEstimate",
      projectedLiquidSteem,
      labeledAs: ESTIMATE_LABEL,
      note: "arithmetic on an estimate stays an estimate — never a fact until the chain pays",
    },
    readiness: {
      communityCreationReady,
      basis: communityCreationReady != null
        ? `projected ${projectedLiquidSteem} STEEM ≥ need ${needTotal} STEEM (fee ${communityCost.accountFeeSteem} + buffer ${communityCost.feeBufferSteem}, ${communityCost.source}:${communityCost.lines.needFormula})`
        : "fail-closed — inputs missing (no invention)",
      communityCreationReadyBeforePayout,
      counterGridFuelReady: null,
      counterGridFuelPrecondition: `${doctrineSearch.ownerDecisionTerm} — no written fuel-allocation doctrine constant exists in the repo (documented search); NEVER invented`,
      fuelAllocations,
    },
    countdown: cd,
    armGates: [
      { gate: "CEX rail (HTX/Binance keys)", law: "zero-secrets — owner-armed; rail-readiness measured in custody.json cex note" },
      { gate: "per-agent swap flags (grids/state/agent-swap-flags.json)", law: "owner-armed roster — controlFor default blocked-no-key (grids/agent-roster.mjs)" },
      { gate: "signing key (STEEM_ACTIVE_WIF / master vault)", law: "owner-held; verify-then-sign gates only (mover/convert/community)" },
      { gate: "community creation --execute", law: "owner-gated by mandate + key (grids/community.mjs:59)" },
    ],
    law: "deterministic pre-build of the maturity decisions — every figure cited from a receipt or a written constant; estimates labeled " + ESTIMATE_LABEL + "; fail-closed nulls; no invented allocations",
  };
}

/* ── ריצה-חיה: קריאת-קבלות → קבלת-דוקטרינה → persist ─────────────────────── */

export function runPayoutDoctrine({ nowIso = null } = {}) {
  const at = nowIso ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const convert = readJsonReceipt(join(STATE_DIR, "convert-plan.json"));
  const custody = readJsonReceipt(join(STATE_DIR, "custody.json"));
  const communityPlan = readJsonReceipt(join(STATE_DIR, "community-plan.json"));
  const degraded = [];
  if (!convert) degraded.push("convert-plan.json unreadable — payout estimate unavailable (fail-closed)");
  if (!custody) degraded.push("custody.json unreadable — liquid unavailable (fail-closed)");
  const communityCost = { ...COMMUNITY_COST_CITATION };
  if (communityPlan && Number.isFinite(communityPlan.accountFee)) {
    communityCost.chainMeasuredAccountFee = communityPlan.accountFee; // חי: get_chain_properties דרך community.mjs liveState
    if (communityPlan.accountFee !== COMMUNITY_COST_CITATION.accountFeeSteem) {
      communityCost.note = "chain-measured fee differs from the written default — the WRITTEN doctrine constant stays authoritative for planning; re-run after owner reviews the difference";
    }
  }
  const receipt = planPayoutDoctrine({ convert, custody, communityCost, nowIso: at });
  receipt.degraded = degraded;
  return receipt;
}

export function persistPayoutDoctrine(receipt) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    if (!existsSync(STATE_DIR)) throw new Error("state dir unavailable");
    writeFileSync(RECEIPT_PATH, JSON.stringify(receipt, null, 1) + "\n");
    return true;
  } catch { return false; }
}

/* ── CLI ──────────────────────────────────────────────────────────────────── */
if (process.argv[1] && process.argv[1].endsWith("payout-doctrine.mjs") && !process.argv.includes("--selftest")) {
  const receipt = runPayoutDoctrine();
  persistPayoutDoctrine(receipt);
  console.log(JSON.stringify({
    schema: receipt.schema, at: receipt.at, ok: receipt.ok,
    inputs: {
      pendingSbd: receipt.inputs.convert.pendingSbd,
      estimate: receipt.inputs.convert.payoutEstimate.value,
      liquidSteem: receipt.inputs.custody.liquidSteem,
      window: receipt.inputs.convert.maturityWindow,
    },
    projection: receipt.projection.projectedLiquidSteem,
    readiness: {
      communityCreationReady: receipt.readiness.communityCreationReady,
      communityCreationReadyBeforePayout: receipt.readiness.communityCreationReadyBeforePayout,
      counterGridFuelReady: receipt.readiness.counterGridFuelReady,
    },
    countdown: receipt.countdown,
    degraded: receipt.degraded,
  }, null, 1));
}
