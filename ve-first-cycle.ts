/**
 * ve-first-cycle.ts — המחזור-הראשון של הריבונות-הנעולה · THE-VE PROOF (R41)
 * =============================================================================
 * הוכחה-מבודדת-מלאה של הצינור הרדום-עד-כה, בגובה-הגרעין (בלי-שרשרת, בלי-DB —
 * הגרעין-הוא-האמת). עובדות-במדידה, לא-בהצהרה:
 *
 *   1. נועל נועל SAOS מכיסו (ve_lock) ← ה-SAOS יורד-לכספת-העד ve-vault.
 *   2. הוא מצביע לבריכה (ve_vote) ← ההצבעה נרשמת.
 *   3. ההכנסה-המדודה מזרימה לקרן-ve (בדיוק-כמו-הראוטר: אוצר ← ve-pot).
 *   4. אפוק-פליפ (economyTick בגובה-אפוק) ← הקרן מחולקת-לנועל-המצביע.
 *   5. פרו-ראטה-אמת: שני-נועלים ביחס-כוח 1:2 מקבלים 1:2 (עד-אבק-השארית).
 *   6. כנות-הדעיכה: כוח-ve דועך-לינארית עם-הגובה.
 *   7. כנות-הנעילה: ve_unlock לפני-התום נדחה; אחרי-התום — כל-ה-SAOS חוזר.
 *   8. אג"ח-ריבונית (bond_buy): USDS ← אוצר, SAOS ← נעילת-ve-12שב', הנחה ≥3%,
 *      שימור-היצע-מדויק (אפס-הטבעה, אפס-שריפה, העברה-טהורה).
 *   9. ביקורת-ברזל: SAOS ו-USDS כוללים נשמרים-לאורך-כל-ההוכחה; שורש-קנוני חי.
 *
 * הרצה: bun run ve-first-cycle.ts
 */
import { genesisState, applyOp, stateRoot, addBal, VE_POT, BLOCKS_PER_WEEK, EPOCH_BLOCKS } from "./src/lib/dex/kernel";
import { vePoints } from "./src/lib/dex/economy";

let failures = 0;
const check = (name: string, cond: boolean, detail?: string): void => {
  console.log(`${cond ? "  PASS" : "  FAIL"} · ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
};
const totalOf = (st: ReturnType<typeof genesisState>, asset: string): number =>
  Object.values(st.balances).reduce((s, b) => s + (b[asset] ?? 0), 0);
// סך-כולל-אמת: יתרות + רזרבות-בריכות (ALE זורע-POL מהאוצר בכל-economyTick — הכסף עובר
// לבריכות, לא-נעלם; ביקורת-היצע חייבת-לראות-את-שני-הצדדים)
const grandTotal = (st: ReturnType<typeof genesisState>, asset: string): number =>
  totalOf(st, asset) + Object.values(st.pools).reduce((s, p) => s + (p.a === asset ? p.ra : p.b === asset ? p.rb : 0), 0);

async function main(): Promise<void> {
  const st = genesisState();

  /* ── הקמת-מצב-מבוקר (מוצהרת-במלואה — לא-חלק-מהשרשרת) ── */
  st.assets["SAOS"] = { refPrice: 1320, listed: 1 };
  st.assets["USDS"] = { refPrice: 1000, listed: 1 };
  // בריכת-ייחוס חיה לאג"ח (מחיר 1320µ-USDS ל-SAOS — כמו-השרשרת)
  st.pools["SAOS/USDS"] = { a: "SAOS", b: "USDS", ra: 14_967_632, rb: 19_787_350, lp: 17_093_100, feeAccruedTreasury: 0, swaps: 0 };
  const s1 = "ve-locker-a", s2 = "ve-locker-b";
  st.credits[s1] = 1_000_000; st.credits[s2] = 1_000_000;
  addBal(st, s1, "SAOS", 400_000);   // 400 SAOS מכיסו
  addBal(st, s2, "SAOS", 400_000);
  addBal(st, s1, "USDS", 5_000_000);
  addBal(st, "treasury", "SAOS", 4_000_000); // נזילות-אוצר לאג"ח
  addBal(st, "treasury", "USDS", 3_000_000);
  const saos0 = grandTotal(st, "SAOS"), usds0 = grandTotal(st, "USDS");
  console.log(`[proof] controlled state · SAOS ${saos0}µ · USDS ${usds0}µ`);

  /* ── 1) נעילה מהכיס-האמיתי ── */
  const vaultBefore = st.balances["ve-vault"]?.["SAOS"] ?? 0;
  const r1 = applyOp(st, { type: "ve_lock", issuer: s1, nonce: "p-ve-l1", asset: "SAOS", amount: 200_000, weeks: 12 }, 1);
  check("ve_lock accepted", r1.ok, JSON.stringify(r1).slice(0, 80));
  check("SAOS escrowed to ve-vault (pure transfer)", (st.balances["ve-vault"]?.["SAOS"] ?? 0) - vaultBefore === 200_000 && (st.balances[s1]?.["SAOS"] ?? 0) === 200_000, `ve-vault ${vaultBefore} → ${st.balances["ve-vault"]?.["SAOS"]} · locker ${st.balances[s1]?.["SAOS"]}`);
  check("position recorded", st.ve?.[s1]?.amt === 200_000 && st.ve?.[s1]?.weeks === 12);

  /* ── 2) הצבעה לבריכה-העמוקה ── */
  const r2 = applyOp(st, { type: "ve_vote", issuer: s1, nonce: "p-ve-v1", pair: "SAOS/USDS" }, 2);
  check("ve_vote accepted", r2.ok, JSON.stringify(r2).slice(0, 60));
  check("vote recorded", st.veVotes?.[s1] === "SAOS/USDS");

  /* ── 3) ההכנסה-המדודה מזרימה לקרן-ve (כמו-הראוטר: אוצר ← ve-pot) ── */
  const FUND = 21_096; // הסכום-ההיסטורי האמיתי שהצטבר בשרשרת-החיה לפני-הנועל-הראשון
  addBal(st, "treasury", "USDS", -FUND);
  addBal(st, VE_POT, "USDS", FUND);
  check("ve pot funded", (st.balances[VE_POT]?.["USDS"] ?? 0) === FUND, `${FUND}µ standing`);

  /* ── 4) אפוק-פליפ: הקרן מתרוקנת-לנועל-המצביע ── */
  st.height = EPOCH_BLOCKS; // גובה-אפוק — הטריגר-הקנוני
  const s1Before = st.balances[s1]?.["USDS"] ?? 0;
  const { economyTick } = await import("./src/lib/dex/economy");
  economyTick(st, 3); // h%1200===0 → epochFlip (revenueCycle חוזר-בשקט — אין-בריכת-אפס/רווח-מתחת-רצפה... בריכה-קיימת: ההכנסה נמדדת-מה-profit הכנות-מעל-הרצפה — כאן 0)
  const paid1 = (st.balances[s1]?.["USDS"] ?? 0) - s1Before;
  check("epoch flip paid the locker the full standing pot", paid1 === FUND, `${s1Before} → ${st.balances[s1]?.["USDS"]} (+${paid1}µ = pot ${FUND}µ)`);
  check("pot drained to zero", (st.balances[VE_POT]?.["USDS"] ?? 0) === 0);
  check("epoch counter advanced", (st.veEpoch ?? 0) === 1);

  /* ── 5) פרו-ראטה: שני-נועלים ביחס-כוח 1:2 ── */
  addBal(st, "treasury", "USDS", -3_000);
  addBal(st, VE_POT, "USDS", 3_000);
  // s1: 200,000µ נשארו-עוד ~11.9שב'; s2: נועל-עכשיו 400,000µ ל-12שב' — כוח ≈ 1:2
  const r3 = applyOp(st, { type: "ve_lock", issuer: s2, nonce: "p-ve-l2", asset: "SAOS", amount: 400_000, weeks: 12 }, 4);
  check("second locker accepted", r3.ok, JSON.stringify(r3).slice(0, 60));
  const r4 = applyOp(st, { type: "ve_vote", issuer: s2, nonce: "p-ve-v2", pair: "SAOS/USDS" }, 5);
  check("second vote accepted", r4.ok);
  const p1 = vePoints(st, s1, st.height), p2 = vePoints(st, s2, st.height);
  check("ve power honest — fresh lock ≈ 2× the 1-week-older lock of half size", p2 > p1 * 1.9 && p2 < p1 * 2.1, `p1=${p1} p2=${p2}`);
  st.height = 2 * EPOCH_BLOCKS;
  const b1 = st.balances[s1]?.["USDS"] ?? 0, b2 = st.balances[s2]?.["USDS"] ?? 0;
  economyTick(st, 6);
  const got1 = (st.balances[s1]?.["USDS"] ?? 0) - b1, got2 = (st.balances[s2]?.["USDS"] ?? 0) - b2;
  check("pro-rata ≈1:2 (±dust, remainder stays in pot)", Math.abs(got1 * 2 - got2) <= 2 && got1 + got2 >= 2_998, `s1 +${got1} · s2 +${got2} (pot 3,000µ → ${st.balances[VE_POT]?.USDS ?? 0}µ dust)`);

  /* ── 6) כנות-הדעיכה: הכוח דועך-לינארית עם-הגובה ── */
  const now = vePoints(st, s2, st.height);
  const later = vePoints(st, s2, st.height + BLOCKS_PER_WEEK); // שבוע-קדימה
  check("ve power decays linearly with height", later < now && later >= Math.floor(now * 0.9), `now ${now} → +1w ${later}`);

  /* ── 7) כנות-הנעילה: נעילה-בתוקף נדחית; אחרי-התום — החזרה-מלאה ── */
  const rEarly = applyOp(st, { type: "ve_unlock", issuer: s2, nonce: "p-ve-u1" }, 7);
  check("ve_unlock rejected before expiry", !rEarly.ok, JSON.stringify(rEarly).slice(0, 60));
  st.height = (st.ve?.[s2]?.unlockH ?? 0) + 1; // אחרי-התום
  const s2SaosBefore = st.balances[s2]?.["SAOS"] ?? 0;
  const rLate = applyOp(st, { type: "ve_unlock", issuer: s2, nonce: "p-ve-u2" }, 8);
  check("ve_unlock after expiry returns all SAOS", rLate.ok && (st.balances[s2]?.["SAOS"] ?? 0) - s2SaosBefore === 400_000, `${s2SaosBefore} → ${st.balances[s2]?.["SAOS"]}`);
  check("position + vote deleted", !st.ve?.[s2] && !st.veVotes?.[s2]);

  /* ── 8) אג"ח-ריבונית: USDS ← אוצר · SAOS ← נעילת-ve-12שב' · הנחה ≥3% ── */
  const usdsBond = 100_000;
  const tSaosB = st.balances["treasury"]?.["SAOS"] ?? 0;
  const tUsdsB = st.balances["treasury"]?.["USDS"] ?? 0;
  const pool = st.pools["SAOS/USDS"];
  const price = Math.floor((pool.rb * 1000) / pool.ra); // µ-USDS ל-SAOS
  const r5 = applyOp(st, { type: "bond_buy", issuer: s1, nonce: "p-bnd-1", amount: usdsBond }, 9);
  check("bond_buy accepted", r5.ok, JSON.stringify(r5).slice(0, 80));
  const saosGot = st.ve?.[s1] ? st.ve[s1].amt - 200_000 : 0; // התוספת-לנעילה-הקיימת
  const fairSaos = Math.floor((usdsBond * 1000) / price);
  check("bond delivers SAOS at ≥3% discount to pool price", saosGot >= Math.floor((fairSaos * 10_000) / 9_700), `got ${saosGot}µ vs fair ${fairSaos}µ (price ${price})`);
  check("USDS proceeds landed in treasury", (st.balances["treasury"]?.["USDS"] ?? 0) === tUsdsB + usdsBond);
  check("treasury SAOS left the wallet (real POL sale)", (st.balances["treasury"]?.["SAOS"] ?? 0) === tSaosB - saosGot);
  check("bond SAOS is ve-locked 12w", (st.ve?.[s1]?.unlockH ?? 0) >= st.height + 12 * BLOCKS_PER_WEEK - 1);
  check("bond counters measured", st.bond?.count === 1 && st.bond?.usdsInMu === usdsBond && st.bond?.soldSaosMu === saosGot);
  check("cooldown blocks re-purchase", !(applyOp(st, { type: "bond_buy", issuer: s1, nonce: "p-bnd-2", amount: usdsBond }, 10)).ok);

  /* ── 9) ביקורת-ברזל: שימור-היצע-המדויק לאורך-כל-ההוכחה (יתרות+בריכות) + שורש-קנוני ── */
  check("USDS supply conserved end-to-end (transfers + ALE POL seeding — nothing vanishes)", grandTotal(st, "USDS") === usds0, `${grandTotal(st, "USDS")} = ${usds0} (balances ${totalOf(st, "USDS")} + pools)`);
  check("SAOS supply conserved end-to-end (escrow + pools, never minted/burned)", grandTotal(st, "SAOS") === saos0, `${grandTotal(st, "SAOS")} = ${saos0} (balances ${totalOf(st, "SAOS")} + pools)`);
  let root = "";
  try { root = stateRoot(st); } catch (e) { root = "THROW: " + (e as Error).message; }
  check("stateRoot computes on ve/bond state", root.length === 64, root.slice(0, 24) + "…");

  console.log(`\n[proof] ${failures === 0 ? "ALL GREEN — flywheel proven: lock → vote → epoch payout → pro-rata → decay → unlock-gate → bond, zero mint" : failures + " FAILURES"}`);
  process.exit(failures === 0 ? 0 : 9);
}

void main();
