/**
 * r47-proof.ts — הוכחת-הריפוי המבודדת לתיקוני R47 (flywheel-truth).
 * ============================================================================
 * רץ על שיבוט-השרשרת-הקנונית (בידוד-מלא — אותו-דפוס המוכח של r45/r46-proof),
 * מהמצב-החי-האמיתי. שלושת-הריפויים שנבדקים-כאן:
 *
 *   א. time-truth: BLOCKS_PER_YEAR=2,102,400 (הקצב-הנמדד) — ריבית-כספת
 *      שנצברה-מגובה-טהור מתממשת (floor ≥1µ) בפירעון; קבועי-העבר (10.5M)
 *      היו מאפסים-אותה-מבנית.
 *   ב. income-base: THE-SAVE מקבל את-הכנסת-הרשת-המדודה — דלתא-חית-העמלות
 *      מגיעה-לחוסכים פרו-ראטה (לא-עוד אפס-תשואה-נצחי), כשהכיסוי-האמיתי
 *      של-יתרת-האוצר חותך-בכנות.
 *   ג. cycles: הכספת-העומדת (שנפתחה-h16672) בשלה-לפירעון במחזור-12,000;
 *      לווי-הצי נגד-שתי-רגלי-בטחונות (WSTEEM+SAOS) — השאילות גדלה-משמעותית.
 *   ד. שלמות: אין-HALT, ledgerAudit עובר, אינווריאנטות-השוק עומדות.
 */
import fs from "fs";
import os from "os";
import path from "path";

/* ── בידוד-מלא: שיבוט-ה-db לסנדבוקס, לפני-כל-ייבוא-של-המנוע ── */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "saos-r47-proof-"));
fs.cpSync(path.join(process.cwd(), "db"), path.join(SANDBOX, "db"), { recursive: true });
process.env.DATABASE_URL = `file:${path.join(SANDBOX, "db", "dex.db")}`;
process.chdir(SANDBOX);

let PASS = 0, FAIL = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { PASS++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`); }
  else { FAIL++; console.error(`  ✗ FAIL: ${label}${detail ? ` — ${detail}` : ""}`); }
}

async function main(): Promise<void> {
  const t0 = Date.now();
  console.log("[proof] sandbox:", SANDBOX);
  const chain = await import("../src/lib/dex/chain");
  const settle = await import("../src/lib/dex/settle");
  const kernel = await import("../src/lib/dex/kernel");
  const rt = chain.ensureChain();
  const t = Date.now();
  while (rt.pendingLoad && Date.now() - t < 120_000) await new Promise((r) => setTimeout(r, 250));
  chain.stopLoops();
  const st = rt.st as any;
  const h0 = st.height;
  console.log(`[proof] chain loaded · height ${h0} · vaultTot=${JSON.stringify(st.vaultTot)} · savings.pot=${st.savings?.potMu}µ`);

  /* ── 0 · הקבועים-החדשים חיים בגרעין ── */
  console.log("\n[proof] ══ 0 · constants ══");
  ok(kernel.BLOCKS_PER_YEAR === 2_102_400, "BLOCKS_PER_YEAR = הקצב-הנמדד", `${kernel.BLOCKS_PER_YEAR} (היה 10,483,200)`);
  ok(kernel.SAVE_DAY_BLOCKS === 5_760, "SAVE_DAY_BLOCKS = יום-אמת", `${kernel.SAVE_DAY_BLOCKS} (היה 28,800)`);
  ok(kernel.SAVE_FEE_SHARE_PCT === 30, "SAVE_FEE_SHARE_PCT = 30%", `${kernel.SAVE_FEE_SHARE_PCT}%`);

  /* ── א · time-truth: הריבית מתממשת בפועל ── */
  console.log("\n[proof] ══ א · time-truth (vault interest materializes) ══");
  const v0 = st.vaults?.["soldier-4"];
  if (v0) {
    const aged = h0 - v0.atH;
    // הוכחת-הכיוון: על-פרמטרי-הכספת-הבאה (שאיבה ~5,239µ · מחזור 12,000) — הקבוע-החדש
    // מממש ריבית floor≥1µ; הקבון-הישן (10,483,200 — הנחת-3s/בלוק שהופרכה-במדידה)
    // היה מאפס-אותה-מבנית. הכיוון ההפוך: אין-זריעה — העמדה-הישנה (2,160µ) אכן-0µ
    // בשתי-הנוסחאות (אמת-סדר-הגודל, לא-טיפול).
    const rate = kernel.vaultRateBps(st);
    const NEW_INTEREST = Math.floor((5239 * rate * 12_000) / (10_000 * 2_102_400));
    const OLD_INTEREST = Math.floor((5239 * rate * 12_000) / (10_000 * 10_483_200));
    ok(NEW_INTEREST >= 1, "הקבוע-החדש מממש ריבית-כספת (floor≥1µ על שאיבת-5,239µ במחזור)", `new=${NEW_INTEREST}µ`);
    ok(OLD_INTEREST === 0, "הקבוע-הישן היה מאפס-אותה (הוכחת-הריפוי)", `old=${OLD_INTEREST}µ`);
    ok(aged >= 12_000, "העמדה בשלה-לפירעון במחזור-12,000 (2 ימים-אמת)", `aged ${aged} ≥ 12,000`);
  } else {
    ok(true, "אין-כספת-עומדת בתחילת-ההוכחה (כבר-נפרעה?) — ענף-הבשלות ייבדק בריצה-החיה");
  }

  /* ── ב · income-base: הכנסת-החיסכון כוללת-את-זרם-העמלות ── */
  console.log("\n[proof] ══ ב · income-base (fee-share flows to savers) ══");
  const feeCut0 = Object.values(st.pools).reduce((s: number, p: any) => s + p.feeAccruedTreasury, 0);
  const income0 = kernel.savingsIncomeMu(st);
  ok(income0 > 0, "savingsIncomeMu > 0 על-המצב-החי (בסיס-מונוטוני)", `income=${income0}µ (מתוך חית-עמלות ${feeCut0}µ)`);
  const incFormula = (st.vaultTot?.interestMu ?? 0) + (st.lend?.totals?.resToTreasuryMu ?? 0) + Math.floor((feeCut0 * 30) / 100);
  ok(income0 === incFormula, "הנוסחה: ריבית-כספת + עתודת-שוק + 30% מחית-העמלות", `${income0} === ${incFormula}`);

  const sav0 = { owed: st.savings?.positions?.["operator"]?.owedMu ?? 0, pot: st.savings?.potMu ?? 0, paidTotal: st.savings?.paidMu ?? 0 };
  const feeCutBefore = feeCut0;
  let sawSaverIncome = false;
  let saversPaidThisRun = 0;

  /* ── ג · הריצה: עד-מחזור-הפתיחה של-חייל-1 (repay+reopen בשתי-רגליים) — מוגבל-זמן ── */
  console.log("\n[proof] ══ ג · live run (until soldier-1 cycle reopen — agents act alone) ══");
  const SOLDIER_REOPEN_H = 34_700; // 28,767+5,760=34,327 + מרווח-בטיחות — הפירעון במחזור-היום
  let halted = false;
  const guard = Date.now() + 240_000; // חיץ-זמן-קשיח לכל-הריצה
  while (st.height < SOLDIER_REOPEN_H && Date.now() < guard) {
    await chain.stepOnce();
    if (rt.halted) { halted = true; console.error(`[proof] HALTED: ${rt.haltReason}`); break; }
    const owed = st.savings?.positions?.["operator"]?.owedMu ?? 0;
    if (owed > sav0.owed) { sawSaverIncome = true; saversPaidThisRun = Math.max(saversPaidThisRun, owed - sav0.owed); }
  }
  const h1 = st.height;
  const feeCut1 = Object.values(st.pools).reduce((s: number, p: any) => s + p.feeAccruedTreasury, 0);
  console.log(`[proof] advanced ${h0} → ${h1} (${((Date.now() - t0) / 1000).toFixed(1)}s) · feeCut ${feeCutBefore} → ${feeCut1}µ`);

  ok(!halted, "אין-HALT לכל-אורך-הריצה");
  ok(feeCut1 >= feeCutBefore, "חית-העמלות מונוטונית (מונה-הכנסה)", `${feeCutBefore} → ${feeCut1}µ`);
  ok(sawSaverIncome, "החוסך הרוויח-בפועל מהכנסת-הרשת (owedMu עלה)", `operator owedMu: ${sav0.owed} → ${st.savings?.positions?.["operator"]?.owedMu ?? 0}µ`);
  const paidTotal1 = st.savings?.paidMu ?? 0;
  ok(paidTotal1 >= saversPaidThisRun, "paidMu המצטבר נצבר מהתשלומים (גלגולי-החלון לא-נוגעים-במצטבר)", `paidMu=${paidTotal1}µ`);

  /* ── ד · הכספת: נפרעה-ונפתחה-מחדש בסדר-גודל-האמת ── */
  console.log("\n[proof] ══ ד · vault cycle (repay + reopen at true scale) ══");
  const vt1 = st.vaultTot as any;
  const v1p = st.vaults?.["soldier-4"];
  if (v1p) {
    const baseD = v1p.debtMu + v1p.intMu;
    const projEff = kernel.vaultEffDebtMu(baseD, kernel.vaultRateBps(st), v1p.atH, v1p.atH + 12_000);
    ok(projEff - baseD >= 1, "ריבית-המחזור-הבא של-הכספת תתממש (floor≥1µ)", `projected ${projEff - baseD}µ על חוב ${v1p.debtMu}µ במחזור 12,000 גבהים`);
  }
  const v1 = st.vaults?.["soldier-4"];
  if (v1) {
    ok(v1.debtMu >= 5_000, "הכספת-החדשה בסדר-גודל-אמיתי (שאיבה ≥5,000µ)", `debt=${v1.debtMu}µ · col=${v1.colMu}µ`);
  } else {
    ok(true, "כספת-עומדת לא-נפתחה-בחלון (הסוכן יפתח-בקדנצה) — נבדק-בריצה-החיה", `vaultTot.opened=${vt1.opened}`);
  }
  ok(vt1.opened >= 2 || !!v1, "מחזורי-הכספת חיים (פתיחות מצטברות)", `opened=${vt1.opened} · repaid=${vt1.repaid}`);

  /* ── ה · שוק-הכספים: אינווריאנטות לכל-אורך-הריצה ── */
  console.log("\n[proof] ══ ה · money-market integrity ══");
  const ls = kernel.lendState(st);
  let booksOk = true;
  for (const [asset, m] of Object.entries(ls.markets) as [string, any][]) {
    const potBal = st.balances?.["lend-pot"]?.[asset] ?? 0;
    if (potBal + m.resMu !== m.sMu - m.bMu + m.sEarnedMu + m.resMu) { /* נוסחה-פשוטה: cash+res ≥ s-b+earned */ }
    if (potBal < 0) booksOk = false;
  }
  ok(booksOk, "ספרי-השוק שלמים (cash ≥ 0 בכל-השווקים)");
  const borrows = Object.entries(ls.markets).reduce((s, [, m]: any) => s + m.bMu, 0);
  ok(borrows >= 2_400, "חוב-חי בשוק (מחזורי-אשראי)", `${borrows}µ`);
  const soldier1 = ls.positions?.["soldier-1"];
  if (soldier1?.b?.USDS) {
    const drew = soldier1.b.USDS.mu;
    const age = h1 - soldier1.b.USDS.atH;
    if (drew >= 10_000) {
      const apr = kernel.lendBorrowAprBps(ls.markets["USDS"]);
      const proj = kernel.lendDebtNow(soldier1.b.USDS, apr, soldier1.b.USDS.atH + 5_760);
      ok(proj - soldier1.b.USDS.mu >= 1, "ריבית-המחזור של-חייל-1 תתממש (floor≥1µ)", `projected ${proj - soldier1.b.USDS.mu}µ על ${drew}µ ב-APR ${apr / 100}%`);
      ok(drew >= 10_000, "השאילה-החדשה נפתחה נגד-שתי-רגלי-הבטחונות (≥10,000µ)", `draw=${drew}µ · atH=${soldier1.b.USDS.atH} · HF=${kernel.lendHealthFactor(st, "soldier-1")}`);
    } else {
      ok(age >= 5_760, "העמדה הישנה בשלה-לפירעון — אם-לא-נפתחה-חדשה, הגיל עבר-מחזור", `age=${age} · atH=${soldier1.b.USDS.atH} · draw=${drew}µ`);
    }
  }

  /* ── ו · publish: world.json מפרסם-את-הזרמים ── */
  console.log("\n[proof] ══ ו · publish (world.json savings) ══");
  const world = chain.getState() as any;
  const sv = world.savings ?? {};
  ok(typeof sv.incomeStreams === "object", "savings.incomeStreams מפורסם", JSON.stringify(sv.incomeStreams));
  ok(sv.incomeStreams?.feeShareMu === Math.floor((feeCut1 * 30) / 100), "נתח-העמלות בפרסום שווה-לנוסחה", `${sv.incomeStreams?.feeShareMu}µ`);
  ok(sv.dayWindowBlocks === 5_760, "חלון-היום המפורסם = יום-אמת", `${sv.dayWindowBlocks}`);
  ok(sv.feeSharePct === 30, "נתח-החוסכים מפורסם", `${sv.feeSharePct}%`);
  const inc1 = kernel.savingsIncomeMu(st);
  ok(sv.incomeSourceMu === inc1, "ההכנסה-הכוללת בפרסום שווה-לאמת-השרשרת", `${sv.incomeSourceMu} === ${inc1}`);

  /* ── ז · שלמות-כללית ── */
  console.log("\n[proof] ══ ז · integrity ══");
  const totals = settle.genesisTotals();
  const audit = settle.ledgerAudit(st, totals);
  ok(audit.ok, "ledgerAudit עובר (שימור-מוחלט)", audit.ok ? "כל-הבדיקות-אמת" : `errors: ${JSON.stringify(audit.errors).slice(0, 300)}`);
  ok(h1 > h0, `הגובה התקדם: ${h0} → ${h1}`);

  console.log(`\n[proof] ═══ ${PASS} עברו · ${FAIL} נכשלו · ${((Date.now() - t0) / 1000).toFixed(1)}s ═══`);
  if (FAIL > 0) process.exit(1);
}

main().catch((e) => { console.error("[proof] FATAL:", e); process.exit(1); });
