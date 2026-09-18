/**
 * save-first-cycle.ts — מחזור-החיסכון הראשון · THE-SAVE PROOF (R40)
 * =============================================================================
 * הוכחה-מבודדת-מלאה של מכשיר-החיסכון, בגובה-הגרעין (בלי-שרשרת, בלי-DB —
 * הגרעין-הוא-האמת). ההרצה בונה-מצב-מבוקר, מריצה את המחזור-המלא, וקובעת
 * עובדות-במדידה — לא-בהצהרה:
 *
 *   1. חוסך פותח עמדה (save_open) — הקרן נכנסת-לחשבון-העד save-pot.
 *   2. לווה פותח כספת (vault_open) — שואב USDS נגד WSTEEM.
 *   3. הזמן עובר (288,000 בלוקים = 10 ימים) — הריבית נצברת-בעצלה.
 *   4. הלווה פורע (vault_repay) — הריבית נוחתת-בפועל ביתרת-האוצר.
 *   5. savingsTick — ההכנסה-המדודה מחולקת-לחוסך (100% פרו-ראטה).
 *   6. החוסך סוגר (save_close) — מקבל קרן + ריבית-אמת.
 *   7. ביקורת-ברזל: היצע-ה-USDS הכולל נשמר-במדויק (אפס-הטבעה לאורך-כל
 *      מחזור-החיסכון), הסירה-מלאה, החשבון-עד ריק, השורש-הקנוני חי.
 *   8. כנות-הכיסוי: אוצר-ריק → הכנסה מגיעה → אין-צבירה (אין-הדפסה-מעולם).
 *
 * הרצה: bun run save-first-cycle.ts
 */
import { genesisState, applyOp, stateRoot, vaultEffDebtMu, vaultRateBps } from "./src/lib/dex/kernel";
import { savingsTick } from "./src/lib/dex/save";
import { addBal } from "./src/lib/dex/kernel";

let failures = 0;
const check = (name: string, cond: boolean, detail?: string): void => {
  console.log(`${cond ? "  PASS" : "  FAIL"} · ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
};
const usdsTotal = (st: ReturnType<typeof genesisState>): number =>
  Object.values(st.balances).reduce((s, b) => s + (b["USDS"] ?? 0), 0);
const W = "wsteem-holder";

async function main(): Promise<void> {
  const st = genesisState();

  /* ── הקמת-מצב-מבוקר (ההרכה-הזו היא-ההרכה: מוצהרת-במלואה, לא-חלק-מהשרשרת) ── */
  st.assets["WSTEEM"] = { refPrice: 54, listed: 1 };
  st.assets["USDS"] = { refPrice: 1000, listed: 1 };
  const alice = "alice-saver", bob = "bob-borrower";
  st.credits[alice] = 1_000_000; st.credits[bob] = 1_000_000;
  addBal(st, alice, "USDS", 2_000_000);            // $2,000 — כסף-החוסך
  addBal(st, W, "WSTEEM", 10_000_000);             // מחזיק-הבטחונות
  addBal(st, "treasury", "USDS", 5_000_000);       // כיסוי-ריבית-כספות
  const usdsBeforeSave = usdsTotal(st);
  console.log(`[proof] controlled state · USDS total ${usdsBeforeSave}µ`);

  /* ── 1) פתיחת-חיסכון ── */
  const o1 = applyOp(st, { type: "save_open", issuer: alice, nonce: "p-save-o1", amount: 2_000_000 }, 1);
  check("save_open accepted", o1.ok, JSON.stringify(o1));
  check("pot holds principal", (st.balances["save-pot"]?.["USDS"] ?? 0) === 2_000_000 && st.savings?.potMu === 2_000_000);
  check("saver balance drained", (st.balances[alice]?.["USDS"] ?? 0) === 0);

  /* ── 2) פתיחת-כספת (המקור-האמיתי-היחיד-להכנסת-החיסכון היום) ── */
  addBal(st, bob, "WSTEEM", 3_000_000); // 3,000 WSTEEM ≈ $162 → יחס-בטחונות נדיב
  const colMu = 3_000_000;
  const colVal = Math.floor((colMu * 54) / 1000); // 162,000µ = $162
  const drawMu = Math.floor((colVal * 100) / 250); // ≤40% מערך — CR 250%
  const o2 = applyOp(st, { type: "vault_open", issuer: bob, nonce: "p-vlt-o1", asset: "WSTEEM", amount: colMu, drawMu }, 2);
  check("vault_open accepted", o2.ok, `draw ${drawMu}µ · ` + JSON.stringify(o2).slice(0, 80));
  const usdsAfterVaultOpen = usdsTotal(st);
  check("vault draw mints exactly the debt", usdsAfterVaultOpen === usdsBeforeSave + drawMu, `${usdsAfterVaultOpen} = ${usdsBeforeSave}+${drawMu}`);

  /* ── 3) הזמן עובר: 288,000 בלוקים = 10 ימים קנוניים ── */
  addBal(st, bob, "USDS", 200_000); // הכנסת-הלווה בינתיים — כיסוי-הריבית בפירעון (הכנסה-אמיתית-של-ההרכה)
  st.height += 288_000;
  const rate = vaultRateBps(st);
  const v = st.vaults![bob];
  const eff = vaultEffDebtMu(v.debtMu + v.intMu, rate, v.atH, st.height);
  const interest = eff - (v.debtMu + v.intMu);
  console.log(`[proof] 10 days later · debt ${v.debtMu}µ + interest ${interest}µ (rate ${rate}bps)`);

  /* ── 4) פירעון-הכספת — הריבית נוחתת-באוצר ── */
  const treasBeforeRepay = st.balances["treasury"]?.["USDS"] ?? 0;
  const o3 = applyOp(st, { type: "vault_repay", issuer: bob, nonce: "p-vlt-r1", repayMu: eff, withdrawMu: colMu }, 3);
  check("vault_repay accepted", o3.ok, JSON.stringify(o3).slice(0, 80));
  check("interest landed in treasury (real USDS)", (st.balances["treasury"]?.["USDS"] ?? 0) === treasBeforeRepay + interest, `${treasBeforeRepay} → ${st.balances["treasury"]?.["USDS"]}`);
  check("vault interest counter == measured", st.vaultTot?.interestMu === interest);
  const usdsAfterVaultCycle = usdsTotal(st);
  check("vault cycle is supply-neutral (mint==burn)", usdsAfterVaultCycle === usdsBeforeSave + 200_000, `${usdsAfterVaultCycle} = ${usdsBeforeSave}+200,000 harness injection (draw ${drawMu}µ minted and burned)`);

  /* ── 5) צבירת-החיסכון — ההכנסה-המדודה זורמת-לחוסך ── */
  const owedBefore = st.savings?.positions[alice]?.owedMu ?? 0;
  savingsTick(st, 4);
  const owedAfter = st.savings?.positions[alice]?.owedMu ?? 0;
  check("savingsTick credited the saver", owedAfter - owedBefore === interest, `${owedBefore} → ${owedAfter} (interest ${interest})`);
  check("interest funded from treasury (not minted)", (st.balances["treasury"]?.["USDS"] ?? 0) === treasBeforeRepay, `treasury back to ${treasBeforeRepay}`);
  check("pot grew by the income", (st.balances["save-pot"]?.["USDS"] ?? 0) === 2_000_000 + interest);
  check("paidMu counter == interest", st.savings?.paidMu === interest);
  check("USDS supply unchanged by distribution", usdsTotal(st) === usdsAfterVaultCycle, `${usdsTotal(st)} (pure transfer)`);

  /* ── 6) סגירה-מלאה — קרן + ריבית בידיים ── */
  const o4 = applyOp(st, { type: "save_close", issuer: alice, nonce: "p-save-c1" }, 5);
  check("save_close accepted (full)", o4.ok, JSON.stringify(o4));
  check("saver walked with principal+interest", (st.balances[alice]?.["USDS"] ?? 0) === 2_000_000 + interest, `${st.balances[alice]?.["USDS"]}µ = 2,000,000 + ${interest}`);
  check("pot empty after full close", (st.balances["save-pot"]?.["USDS"] ?? 0) === 0 && (st.savings?.potMu ?? 1) === 0);
  check("position deleted", !st.savings?.positions[alice]);
  check("closes counter", st.savings?.closes === 1);
  check("USDS supply conserved through the whole savings cycle", usdsTotal(st) === usdsAfterVaultCycle, `${usdsTotal(st)}`);

  /* ── 7) כנות-הזמן: הכנסה שהגיעה בלי-חוסכים לא מחולקת-רטרואקטיבית ── */
  const treasMark = st.balances["treasury"]?.["USDS"] ?? 0;
  addBal(st, bob, "WSTEEM", 2_000_000); // בטחונות-לכספת-השנייה — לפני-הפתיחה
  addBal(st, bob, "USDS", 200_000);    // כיסוי-הריבית-הצפויה
  const o6 = applyOp(st, { type: "vault_open", issuer: bob, nonce: "p-vlt-o2", asset: "WSTEEM", amount: 2_000_000, drawMu: 40_000 }, 7);
  check("second vault open (setup)", o6.ok, JSON.stringify(o6).slice(0, 60));
  st.height += 144_000;
  const v2 = st.vaults![bob];
  const eff2 = vaultEffDebtMu(v2.debtMu + v2.intMu, vaultRateBps(st), v2.atH, st.height);
  applyOp(st, { type: "vault_repay", issuer: bob, nonce: "p-vlt-r2", repayMu: eff2, withdrawMu: 2_000_000 }, 8);
  const int2 = st.vaultTot!.interestMu - interest;
  check("income landed while nobody saved", (st.balances["treasury"]?.["USDS"] ?? 0) === treasMark + int2, `treasury ${treasMark} → ${st.balances["treasury"]?.["USDS"]} (+${int2}µ interest)`);
  savingsTick(st, 9); // אין-חוסכים — ההכנסה מסומנת, אין-למי-לחלק
  const o5 = applyOp(st, { type: "save_open", issuer: alice, nonce: "p-save-o2", amount: 500_000 }, 6);
  check("saver arrives AFTER the income (re-open)", o5.ok);
  savingsTick(st, 10); // דלתא-הכנסה מאז = 0 — אין-רטרואקטיביות
  check("NO retroactive accrual for the later saver", st.savings!.positions[alice].owedMu === 0, `owed ${st.savings!.positions[alice].owedMu} (the ${int2}µ was marked before she arrived)`);
  const r7 = applyOp(st, { type: "save_close", issuer: alice, nonce: "p-save-c2" }, 11);
  check("later saver closes with principal only", r7.ok && (st.balances[alice]?.["USDS"] ?? 0) === 2_000_000 + interest, JSON.stringify(r7).slice(0, 60));

  /* ── 8) שורש-קנוני-חי (המצב-כולו סדיר-לחתימה) ── */
  let root = "";
  try { root = stateRoot(st); } catch (e) { root = "THROW: " + (e as Error).message; }
  check("stateRoot computes on savings state", root.length === 64, root.slice(0, 24) + "…");

  console.log(`\n[proof] ${failures === 0 ? "ALL GREEN — instrument proven: deposit → measured income → distribution → full withdrawal, zero mint" : failures + " FAILURES"}`);
  process.exit(failures === 0 ? 0 : 9);
}

void main();
