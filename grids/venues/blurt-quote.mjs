// BLURT-QUOTE — רגל-תכנון-בלרט חסרת-מפתחות (Z-87a · BRIDGE · plan-only)
// ═══════════════════════════════════════════════════════════════════════════════
// האמת-המדודה (Z-86a, חי 2026-10-04) — והחוק-הכנה שנגזר ממנה:
//   1. אין-ספר-בלרט-ציבורי: הצמתים-החיים (rpc.blurt.blog, blurt-rpc.saboin.com)
//      אינם חושפים get_order_book ("Could not find method"). כל-"ספר-בלרט" היה
//      המצאה — ואסורה. מה שקיים: שער-ייחוס api.blurt.blog/price_info בלבד.
//   2. אין-מטבע-יציב-בלרט: "BLURT-BD" לא קיים (current_sbd_supply=null; README
//      הרשמי: אין-מטבע-יציב בשרשרת). תיקון-הנחיית-הבעלים נרשם-ב-Z-86 ומוטבע כאן.
//   3. יציאה-מהירה-יחידה שעובדת: BRIDGE — transfer BLURT → @graphene-swap (או
//      @blurt-swap) עם memo "SWAP.BLURT <כתובת-hive>" → טוקן SWAP.BLURT
//      ב-Hive-Engine → מכירה בספר-ה-Engine (L2_REAL). הפקדה-נצפתה-על-השרשרת
//      (b4bull→graphene-swap 2025-06-05; cexius→blurt-swap 2026-10-02).
//      עמלת-הגשר: לא-מתועדת-בפומבי — נרשמת כ-unknown, אף-מספר לא מומצא.
//   4. תיוג: כל-פלט נושא label:"BRIDGE" ו-plan-only; אף-פעולה לא נשלחת,
//      אף-מפתח לא נדרש, והמודול מעולם לא זורק (fail-soft כנה).
//
// פידים (keyless): price_info (PAPER) + buyBook/sellBook של SWAP.BLURT ב-Engine
// (L2_REAL, ממוין client-side — השרת מחזיר שורות-לא-ממוינות; metrics נפסלים-כמיושנים).

import { engineBookFeed, blurtPriceRefFeed, r6, num, FEE_BPS } from "../arb-scan.mjs";

export const BRIDGE_PATHS = Object.freeze([
  {
    id: "graphene-swap",
    kind: "BLURT→SWAP.BLURT deposit",
    op: "transfer BLURT to @graphene-swap with memo 'SWAP.BLURT <hive-account>'",
    fee: "unknown — not documented; Z-89 on-chain measurement 2026-10-04: in-path shows NO haircut (1:1) across available evidence; terms unverified — never invented",
    evidence: "deposits re-measured live 2026-10-04 (blurt-rpc.saboin.com): b4bull→graphene-swap 148.918 BLURT memo 'SWAP.BLURT b4bull' · tydynrain 311.907+5.000 · misslea→memo oneplus7 47,353 · rubenstorm 5.000 · reverse path exists (blurt-swap→graphene-swap 'Token Conversion from SWAP.BLURT account lutx0'). Engine side (api.hive-engine.com): SWAP.BLURT issuer=graphene-swap, issuer balance 2,046,812.626434, holder balances tydynrain 350.953894 (≥ deposited 316.907 → no haircut visible), oneplus7 0 (sold after credit), stormruben 0.000794 (sold)",
  },
  {
    id: "blurt-swap",
    kind: "BLURT→SWAP.BLURT deposit (used by Cexius)",
    op: "transfer BLURT to @blurt-swap with memo 'SWAP.BLURT <hive-account>'",
    fee: "unknown (not publicly documented — never invented)",
    evidence: "cexius→blurt-swap 69,703 BLURT (2026-10-02) on-chain",
  },
]);

export const BLURT_HONESTY = Object.freeze({
  noBlurtBook: "NO-BLURT-BOOK: no public Blurt node exposes get_order_book (measured 2026-10-04) — Blurt itself is unquotable; only a USD reference price exists",
  noBlurtBd: "NO-BLURT-BD-STABLECOIN: 'BLURT-BD' does not exist (current_sbd_supply null; official README) — operator-directive correction",
  bridgeFeeUnknown: "BRIDGE-FEE-UNKNOWN: graphene-swap/blurt-swap memo-bridge fee is not publicly documented — recorded as unknown, not estimated. Z-89 measured evidence (2026-10-04, keyless, on-chain both sides): bridge-IN appears 1:1 with no haircut (tydynrain deposited 316.907 BLURT, holds 350.953894 SWAP.BLURT — surplus, not deficit); bridge terms remain unverified and can change — no fee number is invented here",
  wireFeeAfterBridge: "post-bridge exit costs: Hive-Engine orderbook 0% engine fee (source-verified) + HIVE⇄SWAP.HIVE wire 0.75% (min 0.001) if leaving L2 (source-verified hivepegged.js)",
  planOnly: "plan-only: this module signs nothing and requires no keys",
});

/** שער-הייחוס (PAPER — אין-ספר). */
export async function blurtRef({ fetchImpl = fetch } = {}) {
  const r = await blurtPriceRefFeed({ fetchImpl });
  return r.ok ? { ok: true, priceUsd: r.data.priceUsd, realness: "PAPER" } : { ok: false, error: r.error };
}

/** ספר-SWAP.BLURT ב-Engine (L2_REAL) — הרגל-היחידה-בעלת-עומק-אמת. */
export async function swapBlurtBook({ fetchImpl = fetch } = {}) {
  const r = await engineBookFeed("SWAP.BLURT", { fetchImpl });
  return r.ok ? { ok: true, book: r.data, realness: "L2_REAL" } : { ok: false, error: r.error };
}

/**
 * תוכנית-יציאה-מבלרט (plan-only, BRIDGE). אפס-IO מלבד פידים שהוזרקו.
 * מחזיר כנה ok:false כשהפידים חסרים — לעולם לא זורק, לעולם לא ממציא.
 */
export function planBlurtExit({ amountBlurt, book = null, blurtUsd = null, hiveUsd = null, nowIso = null, feeBps = FEE_BPS } = {}) {
  const warnings = Object.values(BLURT_HONESTY);
  const amt = num(amountBlurt);
  if (!(amt > 0)) return { ok: false, label: "BRIDGE", error: "amountBlurt must be > 0", warnings, plan: null };
  if (!book || !Array.isArray(book.bids) || book.bids.length === 0) {
    return { ok: false, label: "BRIDGE", error: "SWAP.BLURT book unavailable — no plan without the L2 book (fail-closed)", warnings, plan: null };
  }
  if (!(blurtUsd > 0) || !(hiveUsd > 0)) {
    return { ok: false, label: "BRIDGE", error: "USD refs unavailable (blurt/hive) — proceeds would require invention", warnings, plan: null };
  }

  // הליכה-בספר-ה-Engine (שלב-3 במסלול) — לאחר-הגשר, ב-L2
  let remaining = amt, proceedsHive = 0, filled = 0;
  const legs = [];
  for (const l of book.bids) {
    if (remaining <= 1e-9) break;
    const take = Math.min(remaining, l.qty);
    proceedsHive += take * l.price * (1 - feeBps / 1e4); // מודל-העמלה של הבית גם כאן
    legs.push({ venue: book.venue, realness: book.realness, qty: r6(take), priceHivePerBlurt: l.price });
    filled += take; remaining -= take;
  }
  if (filled <= 0) return { ok: false, label: "BRIDGE", error: "engine book walk produced no fill", warnings, plan: null };

  const proceedsUsd = proceedsHive * hiveUsd;
  const refUsd = amt * blurtUsd;
  const slippageBps = refUsd > 0 ? r6(((refUsd - proceedsUsd) / refUsd) * 1e4) : null;

  return {
    ok: true,
    label: "BRIDGE",
    schema: "blurt-exit-plan-v1",
    at: nowIso ?? null,
    amountBlurt: amt,
    steps: [
      { n: 1, kind: "BRIDGE", what: `transfer ${amt} BLURT → @graphene-swap (או @blurt-swap) memo "SWAP.BLURT <hive-account>"`, fee: "unknown — not documented (measured evidence: in-path 1:1, no haircut visible; terms unverified)", evidence: BRIDGE_PATHS.map((b) => `${b.id}: ${b.evidence}`) },
      { n: 2, kind: "L2-ARRIVAL", what: "SWAP.BLURT credited on Hive-Engine (same account named in memo)", fee: "bridge-side unknown; Engine token credit 0%" },
      { n: 3, kind: "SELL-L2", what: `sell SWAP.BLURT into the live Engine bid book (${book.venue})`, fee: `house fee model ${feeBps}bps/leg (measured plan only)` },
    ],
    plan: {
      fillableBlurt: r6(filled), unfilledBlurt: r6(Math.max(0, remaining)),
      proceedsHive: r6(proceedsHive), proceedsUsd: r6(proceedsUsd),
      referenceUsd: r6(refUsd), slippageVsRefBps: slippageBps,
      legs,
    },
    realness: { bridge: "ONCHAIN_REAL (transfer), fee unknown", sell: book.realness, reference: "PAPER" },
    warnings,
    execution: "none — plan-only; the transfer/broadcast step is NOT built here (owner rail only)",
  };
}

/** ריצה-חיה keyless (plan-only). */
export async function runBlurtExit({ amountBlurt, fetchImpl = fetch, nowIso = null } = {}) {
  const [bookRes, refRes] = await Promise.allSettled([swapBlurtBook({ fetchImpl }), blurtRef({ fetchImpl })]);
  const hiveBox = await import("../arb-scan.mjs").then((m) => m.measureRefs({ fetchImpl }));
  const book = bookRes.status === "fulfilled" && bookRes.value.ok ? bookRes.value.book : null;
  const blurtUsd = refRes.status === "fulfilled" && refRes.value.ok ? refRes.value.priceUsd : null;
  const hiveUsd = hiveBox?.refs?.hiveUsd ?? null;
  return planBlurtExit({ amountBlurt, book, blurtUsd, hiveUsd, nowIso });
}

/* ── CLI: node grids/venues/blurt-quote.mjs --amount 1000 ─────────────────── */
if (process.argv[1] && process.argv[1].endsWith("blurt-quote.mjs") && !process.argv.includes("--selftest")) {
  const i = process.argv.indexOf("--amount");
  const amount = Number(i >= 0 ? process.argv[i + 1] : "1000");
  const plan = await runBlurtExit({ amountBlurt: amount, nowIso: new Date().toISOString() });
  console.log(JSON.stringify(plan, null, 1));
}
