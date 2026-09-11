/**
 * peg-selftest.ts — בדיקת-רגרסיה של דלת-המטבעות על גרעין-טרי (Task 72).
 * הרצה: bun run scripts/peg-selftest.ts
 * אפס-רשת · אפס-DB · אפס-סודות — applyOp ישירות על genesisState() טרי.
 * הבדיקה מוכיחה את המסלול המלא: oracle_set → wrap_mint external (claim) →
 * xfer_free → pool_open במחיר-אורקל → pool_swap → הצלבת-אמת (spread).
 */
import { applyOp, genesisState, type DexState, type Op } from "../src/lib/dex/kernel";
import { poolMidFor, quoteOut } from "../src/lib/dex/amm";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${detail}`); }
}

const st: DexState = genesisState();
const h = (): number => st.height;
const op = (o: Partial<Op>): OpResult => applyOp(st, { issuer: "treasury", nonce: `t-${st.nonces.length}-${Math.floor(st.nonces.length)}`, ...o } as Op, 1_700_000_000_000);
type OpResult = ReturnType<typeof applyOp>;

console.log("╔═ peg-selftest — דלת-המטבעות (THE-COIN-DOOR) ═╗");

// 1. oracle_set — אוצר
{
  const r = op({ type: "oracle_set", prices: { WTRX: 273_100, WSOL: 190_500_000 }, claim: "median(test×3)" });
  check("oracle_set treasury accepted", r.ok, r.ok ? "" : r.err);
  check("oracle canonical in state", st.oracle?.WTRX?.mu === 273_100 && st.oracle?.WSOL?.mu === 190_500_000);
  check("oracle src label", st.oracle?.WTRX?.src === "median(test×3)");
}
// 2. oracle_set — לא-אוצר נדחה
{
  const r = applyOp(st, { type: "oracle_set", issuer: "operator", nonce: "n-not-treasury", prices: { WTRX: 1 } }, 1_700_000_000_000);
  check("oracle_set non-treasury rejected", !r.ok && r.err === "treasury-only", r.ok ? "ACCEPTED (BAD!)" : r.err);
}
// 3. oracle_set — מחיר-לא-שלם נדחה (fail-closed)
{
  const r = applyOp(st, { type: "oracle_set", issuer: "treasury", nonce: "n-float", prices: { WTRX: 273.5 } }, 1_700_000_000_000);
  check("oracle_set float price rejected", !r.ok && r.err === "bad-oracle-price", r.ok ? "ACCEPTED (BAD!)" : r.err);
}
// 4. wrap_mint external — הטבעה-מגובה (פקדת-TRX 1 TRX = 1,000µ)
{
  const r = op({ type: "wrap_mint", wrapAsset: "WTRX", amount: 1_000, claim: "trx:SELFTEST0000000000000000000000000000000000000000000000000000", external: true });
  check("wrap_mint external WTRX accepted", r.ok, r.ok ? "" : r.err);
  check("backing recorded", st.backing["WTRX"] === 1_000);
  check("treasury holds minted peg", (st.balances["treasury"]?.["WTRX"] ?? 0) === 1_000);
  check("claim in ext ring", (st.extClaims ?? []).some((c) => c.startsWith("trx:SELFTEST")));
}
// 5. double-claim נדחה (תביעה-חד-פעמית)
{
  const r = op({ type: "wrap_mint", wrapAsset: "WTRX", amount: 1_000, claim: "trx:SELFTEST0000000000000000000000000000000000000000000000000000", external: true });
  check("double-claim rejected", !r.ok && /claim-already-used/.test(r.err), r.ok ? "ACCEPTED (BAD!)" : r.err);
}
// 6. batch אטומי: טביעת-WSOL + העברה-למפקיד
{
  const r = op({
    type: "batch",
    ops: [
      { type: "wrap_mint", issuer: "treasury", nonce: "sub-wm", wrapAsset: "WSOL", amount: 1_500, claim: "sol:SELFTESTSOL00000000000000000000000000000000000000000000000", external: true } as Op,
      { type: "xfer_free", issuer: "treasury", nonce: "sub-x", to: "operator", asset: "WSOL", amount: 1_500 } as Op,
    ],
  });
  check("batch mint+xfer atomic accepted", r.ok, r.ok ? "" : r.err);
  check("operator holds WSOL", (st.balances["operator"]?.["WSOL"] ?? 0) === 1_500);
  check("treasury WSOL emptied by xfer", (st.balances["treasury"]?.["WSOL"] ?? 0) === 0);
}
// 7. xfer_free — הפקדת-TRX-מגובה למפעיל
{
  const r = op({ type: "xfer_free", to: "operator", asset: "WTRX", amount: 1_000 });
  check("xfer_free WTRX to operator", r.ok, r.ok ? "" : r.err);
}
// 8. asset_list WTRX
{
  const r = op({ type: "asset_list", asset: "WTRX", refPrice: 273_100 });
  check("asset_list WTRX", r.ok, r.ok ? "" : r.err);
}
// 8.5. open-pool step-1 (דלת): המפעיל מזריע-את-העוגן-חזרה-לאוצר
{
  const r = applyOp(st, { type: "xfer_free", issuer: "operator", nonce: "n-seed", to: "treasury", asset: "WTRX", amount: 1_000 }, 1_700_000_000_000);
  check("operator seeds peg to treasury", r.ok, r.ok ? "" : r.err);
}
// 9. pool_open — זריעה-דו-צדדית במחיר-אורקל (1,000µ × 273.1 = 273,100µ USDS)
{
  const usdsSide = Math.floor((1_000 * 273_100) / 1000);
  const r = op({ type: "pool_open", pair: "USDS/WTRX", amount: usdsSide, amountB: 1_000 });
  check("pool_open USDS/WTRX at oracle", r.ok, r.ok ? "" : r.err);
  const p = st.pools["USDS/WTRX"];
  check("pool exists with full LP to treasury", !!p && (st.balances["treasury"]?.["LP|USDS/WTRX"] ?? 0) === p.lp);
  const mid = p ? poolMidFor(p, "WTRX", "USDS") : 0;
  // mid מול-אורקל: סטיית-עיגול בלבד → CONVERGED
  const spread = Math.round(((mid - 273_100) / 273_100) * 10_000);
  check(`pool mid ≈ oracle (${mid} vs 273100, spread ${spread}bps)`, Math.abs(spread) < 300);
}
// 10. pool_swap — הסוואפ-האמת: המפעיל קונה WTRX ב-USDS
{
  const p = st.pools["USDS/WTRX"]!;
  const q = quoteOut(p, "USDS", 50_000);
  check("quote gives positive WTRX out", !!q && q.out > 0);
  const before = st.balances["operator"]?.["WTRX"] ?? 0;
  const r = applyOp(st, { type: "pool_swap", issuer: "operator", nonce: "n-swap", pair: "USDS/WTRX", assetIn: "USDS", amount: 50_000, minOut: q!.minOut0 }, 1_700_000_000_000);
  check("pool_swap USDS→WTRX accepted", r.ok, r.ok ? "" : r.err);
  const got = (st.balances["operator"]?.["WTRX"] ?? 0) - before;
  check(`swap executed ≈ quote (${got}µ vs ${q?.out}µ)`, q ? got === q.out : false);
}
// 11. minOut מגן — סוואפ עם minOut-בלתי-אפשרי נדחה
{
  const r = applyOp(st, { type: "pool_swap", issuer: "operator", nonce: "n-minout", pair: "USDS/WTRX", assetIn: "USDS", amount: 10_000, minOut: 999_999_999 }, 1_700_000_000_000);
  check("impossible minOut rejected (slippage guard)", !r.ok, r.ok ? "ACCEPTED (BAD!)" : r.err);
}
// 12. peg-out: xfer_free ל-outbox + attest (ההפרדה-הגלויה)
{
  const before = st.balances["operator"]?.["WSOL"] ?? 0;
  const r = op({
    type: "batch", issuer: "operator",
    ops: [
      { type: "xfer_free", issuer: "operator", nonce: "sub-out", to: "peg-outbox", asset: "WSOL", amount: 500 } as Op,
      { type: "attest", issuer: "operator", nonce: "sub-att", claim: "peg-out 500µ WSOL → TRXdestSELFTEST" } as Op,
    ],
  });
  check("peg-out batch accepted", r.ok, r.ok ? "" : r.err);
  check("outbox holds separated peg", (st.balances["peg-outbox"]?.["WSOL"] ?? 0) === 500);
  check("operator balance decreased", (st.balances["operator"]?.["WSOL"] ?? 0) === before - 500);
}
// 13. stateRoot — עקביות: שורש-חוזר = אותו-ערך (קנוניות)
{
  const { stateRootOf } = await import("../src/lib/dex/canonical");
  const r1 = stateRootOf(st);
  const r2 = stateRootOf(st);
  check("stateRoot deterministic on recompute", r1 === r2);
}

// 14. roast-78 · רצפת-הגנת-הגיבוי — הכרעות-טהורות (סדר-ההגנות)
{
  const { solBackingFloorDecision } = await import("../src/lib/dex/relay-sol");
  // א. שריפה-מותרת: מעל-התביעות בהפרש-גדול (המצב-החי: 59.7M מול-רצפה 50M)
  {
    const d = solBackingFloorDecision(59_705_000, 50_000_000, 890_880);
    check("floor ok when headroom large", d.allow && d.code === "ok", d.detail);
  }
  // ב. backing-floor: השריפה תצלול מתחת-לתביעות — חסימה-כנה (הגנת-העיגון-ה-1:1)
  {
    const d = solBackingFloorDecision(50_003_000, 50_000_000, 890_880);
    check("backing-floor blocks burn into claims", !d.allow && d.code === "backing-floor", d.detail);
    check("backing-floor message honest", /backing-floor/.test(d.detail) && /economic hold/.test(d.detail));
  }
  // ג. גבול-בדיוק: balance − fee == רצפה → מותר (שורפים-עד-הרצפה, לא-מתחתיה)
  {
    const d = solBackingFloorDecision(50_005_000, 50_000_000, 890_880);
    check("burn down to exactly the floor allowed", d.allow && d.code === "ok", d.detail);
  }
  // ד. unfunded: אין-אפילו-לרצפה-הקנונית (קודם היה-נורה-ראשון — עתה backing-floor קודם)
  {
    const d = solBackingFloorDecision(400_000, 0, 890_880);
    check("unfunded fires without claims floor", !d.allow && d.code === "unfunded", d.detail);
  }
  // ה. סדר-ההגנות: משמורת-ענייה + תביעות-גבוהות → backing-floor קודם ל-unfunded
  {
    const d = solBackingFloorDecision(400_000, 50_000_000, 890_880);
    check("backing-floor precedes unfunded in protection order", !d.allow && d.code === "backing-floor", d.detail);
  }
  // ו. אפס-רצפה (תאימות-לאחור): התנהגות-כמו-roast-67 — רק-הרצפה-הקנונית
  {
    const d = solBackingFloorDecision(1_000_000_000, 0, 890_880);
    check("zero floor keeps legacy behavior", d.allow && d.code === "ok", d.detail);
  }
}

console.log(`╚═ ${pass} pass · ${fail} fail — h${h()} ═╝`);
if (fail > 0) process.exit(1);
