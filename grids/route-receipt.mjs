// ROUTE-RECEIPT — המסלול-הראשון STEEM↔HIVE (Wave-2 סעיף 3 · מתוכנן-במלואו, לא-מבוצע)
// ═══════════════════════════════════════════════════════════════════════════
// dex-router הוא KEYLESS-READ (venues={} · DEX-ROUTER-HALTED-STASIS — dex-router.json
// ב-Domain) ו-dex-xc קובע: STEEM=KEYED-DESK · HIVE=PLAN-PEGOUT-KEYED-OPERATOR —
// אין-מסילת-ביצוע חמושה בין-השרשרות. לכן המסלול-הראשון נולד ARMED-STAGED:
// מתוכנן על ספרים-אמת (שוק-הפנימי של STEEM ושל HIVE), עם-עלות/החלקה נמדדים,
// וממתין למסילה — ביצוע יהיה בראנג עתידי רק לאחר שמסילת-הגריד של T-B נצפית
// ירוקה + מילת-בעלים. אפס-שידור, אפס-מפתחות, אפס-חתימה בקו-הזה.
//
// מבנה-המסלול (STEEM → HIVE):
//   רגל-1  sell STEEM → SBD   על ספר-הבידים של שוק-הפנימי STEEM (ONCHAIN_REAL)
//   רגל-2  SBD → HBD          גשר-פאריטה דרך-הדולר: hbdPerSbd = sbdUsd / hbdUsd
//                              (HBD≈$1 משטר-החתך — אותה-כנות של HIVE:HBD ב-arb-scan)
//   רגל-3  buy HIVE ← HBD     על ספר-האסקים של שוק-הפנימי HIVE (ONCHAIN_REAL)
//
// אמת-מספרים: כל-מחיר/כמות מ-walkVwap על הספרים-החיים; עומק-הרגליים קובע
// executableSize; החלקה נמדדת מול מרכז-הספרים (mid×mid דרך-הפאריטה). אין-עמלות
// מומצאות: העמלה-הביתית FEE_BPS רק על-רגלי-הספר (30bps לרגל — strategies.mjs);
// עמלת-הגשר SBD↔HBD = עמלת-convert השרשרת (מדוד-לא-כאן) — מסומנת "unknown,
// not invented" כמו-הגשר-בלרט (blurt-quote.mjs). ספר-חסר → fail-closed כנה.

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { walkVwap, measureRefs, steemBookFeed, hiveBookFeed, FEE_BPS, r6 } from "./arb-scan.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROUTE_RECEIPT_PATH = join(HERE, "state", "route-receipt.json");
export const ROUTE_SCHEMA = "saos-dex-route-receipt-v1";
export const ARMED_STAGED = "ARMED-STAGED-AWAITING-LANE";
export const READY_NEXT_TICK = "READY-TO-EXECUTE-NEXT-TICK"; // רק אם מסילת-הגריד נצפית ירוקה (ראה worklog/T-B)

export const OWNER_NOTE_HEB =
  "מסלול-הראוטר הראשון STEEM→HIVE — מתוכנן-במלואו על ספרי-השוק-הפנימי, חמוש-בשלב (ARMED-STAGED) וממתין-למסילה. " +
  "אין ביצוע ואין שידור בשלב-זה: הביצוע יינתן בראנג עתידי רק אחרי שמסילת-הגריד (T-B, stagedLanes) נצפית ירוקה " +
  "ואחרי מילת-בעלים מפורשת. המספרים כאן נמדדו מהספרים-החיים בעת-ההנפקה — לא אומדן, לא המצאה.";

/** עמלה-ביתית פר-רגל-ספר (FEE_BPS) על-עלות-הרגל; הגשר מחוץ-למודל-העמלה (מסומן). */
function legCost(levels, size, side) {
  const w = walkVwap(levels ?? [], size);
  if (w.vwap == null) return { vwap: null, filled: 0 };
  const f = FEE_BPS / 1e4;
  const vwapWithFee = side === "sell" ? w.vwap * (1 - f) : w.vwap * (1 + f);
  return { vwap: r6(vwapWithFee), rawVwap: r6(w.vwap), filled: w.filled };
}

/** הליכת-תקציב על אסקים: קנייה בגובה-תקציב-quote (HBD) — מכסה-עומק, לא ממציא. */
export function walkBuyWithBudget(asks, budget) {
  if (!Array.isArray(asks) || !(budget > 0)) return { filled: 0, spent: 0, vwap: null };
  let rem = budget, spent = 0, filled = 0;
  for (const l of asks) {
    if (!(l?.price > 0) || !(l?.qty > 0)) continue;
    const cost = l.qty * l.price;
    if (cost <= rem) { filled += l.qty; spent += cost; rem -= cost; }
    else { filled += rem / l.price; spent += rem; rem = 0; }
    if (rem <= 1e-12) break;
  }
  return { filled: r6(filled), spent: r6(spent), vwap: filled > 0 ? r6(spent / filled) : null };
}

/**
 * ליבה-טהורה: תכנון-מסלול STEEM→HIVE מקלטים-נתונים (דטרמיניסטי).
 * steemBook/hiveBook: {asks:[{price,qty}],bids:[…]} (פלט parseCondenserBook)
 * sbdUsd: ייחוס-חי (HTX/llama/coingecko — arb-scan.measureRefs); hbdUsd: 1 (משטר-החתך)
 * size: כמות-STEEM למסלול (הרצה מציעה גודל-מוגן-עומק; הליבה מקבלת-זאת מבחוץ)
 */
export function planSteemHiveRoute({ steemBook, hiveBook, sbdUsd, hbdUsd = 1, size, nowIso, armState = ARMED_STAGED, notes = "" }) {
  const missing = [];
  if (!steemBook?.bids?.length) missing.push("steem-internal bids");
  if (!steemBook?.asks?.length) missing.push("steem-internal asks (mid)");
  if (!hiveBook?.asks?.length) missing.push("hive-internal asks");
  if (!hiveBook?.bids?.length) missing.push("hive-internal bids (mid)");
  if (!(sbdUsd > 0)) missing.push("sbdUsd ref");
  if (!(hbdUsd > 0)) missing.push("hbdUsd ref");
  if (!(size > 0)) missing.push("size");
  if (missing.length) {
    return {
      schema: ROUTE_SCHEMA, ok: false, route: "STEEM→SBD→HBD→HIVE",
      armState, missing, error: `fail-closed: missing real inputs — ${missing.join(", ")}`,
      computedAt: nowIso ?? null, law: "no invented numbers — no real book, no route",
      execution: "NOT-EXECUTED — plan-only receipt, zero broadcast, zero keys",
    };
  }

  const hbdPerSbd = sbdUsd / hbdUsd; // גשר-הפאריטה דרך-הדולר (כנות-משטר-החתך)
  // רגל-1: מכירת STEEM לתוך הבידים (המסלול נמדד על עומק הצד-הנגדי-הנמכר-אליו)
  const l1 = legCost(steemBook.bids, size, "sell");
  const sbdOut = r6(l1.filled * l1.vwap); // כולל עמלת-הבית על המכירה
  const hbdAtBridge = r6(sbdOut * hbdPerSbd);
  // רגל-3: קניית HIVE מהאסקים בתקציב מה-שהגשר מממן (הליכת-תקציב — מכסה עומק, לא ממציא);
  // עמלת-הבית על קנייה: כל-יחידה עולה ×(1+f) — מהתקציב הקבוע מתקבל filled/(1+f) יחידות.
  const l3raw = walkBuyWithBudget(hiveBook.asks, hbdAtBridge);
  const hiveOut = r6(l3raw.filled / (1 + FEE_BPS / 1e4));
  const l3 = { rawVwap: l3raw.vwap, filled: l3raw.filled };
  // גודל-בר-ביצוע = מה-ששתי-הרגליים באמת מספקות (רגל-3 כבר חתוכה לתקציב רגל-1)
  const executableSize = hiveOut;

  // החלקה: מחיר-אפקטיבי HIVE/STEEM במסלול מול מרכז-הספרים (mid→SBD→HBD→HIVE)
  const steemMid = (steemBook.bids[0].price + steemBook.asks[0].price) / 2;
  const hiveMid = (hiveBook.asks[0].price + hiveBook.bids[0].price) / 2;
  const routeMidHivePerSteem = steemMid * hbdPerSbd / hiveMid;
  const routeEffHivePerSteem = executableSize > 0 ? executableSize / size : null;
  const slippageBps = routeEffHivePerSteem != null ? r6(((routeEffHivePerSteem - routeMidHivePerSteem) / routeMidHivePerSteem) * 1e4) : null;

  const legs = [
    { n: 1, kind: "SELL-BOOK", venue: "steem-internal (ONCHAIN_REAL)", from: "STEEM", to: "SBD", sizeIn: r6(l1.filled), vwapRaw: l1.rawVwap, feeBps: FEE_BPS, out: sbdOut, unit: "SBD" },
    { n: 2, kind: "PARITY-BRIDGE", venue: "SBD→HBD via USD refs", from: "SBD", to: "HBD", sizeIn: sbdOut, rate: r6(hbdPerSbd), out: hbdAtBridge, unit: "HBD", fee: "chain convert fee — unknown, not invented (measured at execution rung)" },
    { n: 3, kind: "BUY-BOOK", venue: "hive-internal (ONCHAIN_REAL)", from: "HBD", to: "HIVE", budgetHbd: hbdAtBridge, vwapRaw: l3.rawVwap, filledPreFee: l3.filled, feeBps: FEE_BPS, out: hiveOut, unit: "HIVE" },
  ];

  return {
    schema: ROUTE_SCHEMA,
    ok: true,
    route: "STEEM→SBD→HBD→HIVE",
    direction: "STEEM↔HIVE (Wave-2 first-route candidate)",
    legs,
    expectedOut: { hive: hiveOut, perSteem: routeEffHivePerSteem != null ? r6(routeEffHivePerSteem) : null },
    inputSize: { steem: size },
    executableSize,
    slippageBps,
    refs: { sbdUsd, hbdUsd, hbdPerSbd: r6(hbdPerSbd), note: "SBD ref = live measureRefs; HBD = $1.00 haircut regime (same honesty as arb-scan HIVE:HBD)" },
    bookDepth: {
      steemBidDepthSteem: r6(steemBook.bids.reduce((s, l) => s + l.qty, 0)),
      hiveAskDepthHbd: r6(hiveBook.asks.reduce((s, l) => s + l.qty * l.price, 0)),
    },
    armState,
    execution: "NOT-EXECUTED — plan-only receipt, zero broadcast, zero keys",
    unlockCondition: "T-B staged grid lane observed green + explicit owner word — future rung",
    ownerNote: OWNER_NOTE_HEB,
    computedAt: nowIso ?? null,
    notes,
    law: "fake exchange = failure — a route without real books is not a route",
  };
}

/** הרצה-חיה-חסרת-מפתחות: ספרים-חיים + ייחוס-חי → קבלה ל-state/route-receipt.json */
export async function emitRouteReceipt({ size = 50, nowIso = null, armState = ARMED_STAGED, receiptPath = ROUTE_RECEIPT_PATH } = {}) {
  const at = nowIso ?? new Date().toISOString();
  const [steemBox, hiveBox, refsBox] = await Promise.allSettled([steemBookFeed({}), hiveBookFeed({}), measureRefs({})]);
  const steemBook = steemBox.status === "fulfilled" && steemBox.value.ok ? steemBox.value.data : null;
  const hiveBook = hiveBox.status === "fulfilled" && hiveBox.value.ok ? hiveBox.value.data : null;
  const sbdUsd = refsBox.status === "fulfilled" ? refsBox.value.refs?.sbdUsd ?? null : null;
  const feedErrors = [
    ...(steemBox.status === "fulfilled" && !steemBox.value.ok ? [`steem book: ${steemBox.value.error}`] : []),
    ...(hiveBox.status === "fulfilled" && !hiveBox.value.ok ? [`hive book: ${hiveBox.value.error}`] : []),
    ...(sbdUsd == null ? ["sbdUsd ref unavailable"] : []),
  ];
  const receipt = planSteemHiveRoute({ steemBook, hiveBook, sbdUsd, hbdUsd: 1, size, nowIso: at, armState, notes: feedErrors.join(" · ") });
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 1) + "\n");
  return { receipt, receiptPath };
}

/* ── CLI: node grids/route-receipt.mjs [--size N] ─────────────────────────── */
if (process.argv[1] && process.argv[1].endsWith("route-receipt.mjs")) {
  try {
    const si = process.argv.indexOf("--size");
    const size = si > -1 && Number.isFinite(parseFloat(process.argv[si + 1])) ? parseFloat(process.argv[si + 1]) : 50;
    const { receipt, receiptPath } = await emitRouteReceipt({ size });
    if (receipt.ok) {
      console.log(`[route-receipt] ${receipt.route} · armState ${receipt.armState}`);
      console.log(`[route-receipt] expectedOut ${receipt.expectedOut.hive} HIVE (${receipt.expectedOut.perSteem}/STEEM) · executableSize ${receipt.executableSize} · slippage ${receipt.slippageBps}bps vs mid-mid`);
    } else {
      console.log(`[route-receipt] honest fail-closed: ${receipt.error}`);
    }
    console.log(`[route-receipt] receipt: ${receiptPath} · ${receipt.execution}`);
  } catch (e) {
    console.error(`[route-receipt] honest failure: ${String(e?.message ?? e).slice(0, 140)}`);
    process.exitCode = 0;
  }
}
