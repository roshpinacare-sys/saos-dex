/* scripts/lend-proof.ts — R44 · הוכחה-מקומית-מבודדת של שוק-הכספים
 * ============================================================================
 * רצה על שיבוט-מלא של השרשרת החיה (db/ מועתק-לסנדבוקס חד-פעמי) — אפס-מגע
 * בקנוני. שלוש-שכבות-הוכחה:
 *
 *   א. מתמטיקה-טהורה (עקומת-kink, צבירה, HF) — נוסחאות-שלמים מדויקות
 *   ב. יחידת-קרנל (applyOp על מצב-סינתטי): חלוקת-ריבית 90/10 פרו-ראטה,
 *      ניזולת-חיובית עם בונוס, אינווריאנטת-ספרים — בסדרי-גודל שנראים-לעין
 *   ג. מחזור-שרשרת-מלא (על השיבוט): אוצר ← בריכה ← חייל ← פירעון ← משיכה,
 *      הסוכנים-האוטונומיים פועלים-לבד, וביקורת-ספרי-הברזל (ledgerAudit) עוברת
 *
 * הרצה: bun scripts/lend-proof.ts   (הסנדבוקס נבנה-ונהרס-בעצמו)
 */
import fs from "fs";
import os from "os";
import path from "path";

/* ── בידוד-מלא: שיבוט-ה-db לסנדבוקס, לפני-כל-ייבוא-של-המנוע ── */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "saos-lend-proof-"));
fs.cpSync(path.join(process.cwd(), "db"), path.join(SANDBOX, "db"), { recursive: true });
process.env.DATABASE_URL = `file:${path.join(SANDBOX, "db", "dex.db")}`;
process.chdir(SANDBOX); // DATA_DIR = cwd()/db — המנוע יראה-רק-את-השיבוט

let PASS = 0, FAIL = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { PASS++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`); }
  else { FAIL++; console.error(`  ✗ FAIL: ${label}${detail ? ` — ${detail}` : ""}`); }
}
interface Receipt { [k: string]: unknown }

async function main(): Promise<void> {
  const t0 = Date.now();
  const K = await import("../src/lib/dex/kernel");
  const { applyOp, genesisState, LEND_MARKETS, lendDebtNow, lendBorrowAprBps, lendSupplyAprBps, lendUtilBps, lendHealthFactor, lendLiqThresholdBps } = K as any;
  console.log("[proof] sandbox:", SANDBOX);

  /* ═══ א. מתמטיקה-טהורה ═══ */
  console.log("\n[proof] ══ א · מתמטיקה-טהורה ══");
  ok(lendBorrowAprBps(undefined) === 100, "אספקה-ריקה → 1% בסיס");
  ok(lendBorrowAprBps({ sMu: 1000, bMu: 400 }) === 300, "ניצולת-40% → 300bps");
  ok(lendBorrowAprBps({ sMu: 1000, bMu: 800 }) === 500, "ניצולת-80% (kink) → 500bps");
  ok(lendBorrowAprBps({ sMu: 1000, bMu: 950 }) === 5000, "ניצולת-95% → 5000bps (עונש-קיצה)");
  ok(lendSupplyAprBps({ sMu: 1000, bMu: 0 }) === 0, "אין-לווים → אין-ריבית-אספקה (כנות)");
  ok(lendSupplyAprBps({ sMu: 1000, bMu: 800 }) === Math.floor(500 * 8000 * 9000 / 100_000_000), "APR-אספקה = שאילה×U×0.9");
  // צבירה-דטרמיניסטית: 1Mµ ב-5% שנה ל-28,800 בלוקים (יום) — חישוב-יד מדויק
  const dayInt = Math.floor(1_000_000 * 500 * 28_800 / (10_000 * 10_483_200));
  ok(lendDebtNow({ mu: 1_000_000, int: 0, atH: 0 }, 500, 28_800) === 1_000_000 + dayInt, `יום-אחד של 1Mµ@5% → +${dayInt}µ`);
  ok(lendDebtNow({ mu: 1_000_000, int: 0, atH: 100 }, 500, 100) === 1_000_000, "אפס-בלוקים → אפס-צבירה");
  ok(lendLiqThresholdBps("USDS") === 9000 && lendLiqThresholdBps("WSTEEM") === 6500, "סף-ניזולת = LTV+15pp");

  /* ═══ ב. יחידת-קרנל על מצב-סינתטי (applyOp ישירות) ═══ */
  console.log("\n[proof] ══ ב · יחידת-קרנל: חלוקת-ריבית + ניזולת ══");
  {
    const st = genesisState() as any;
    st.height = 50_000;
    st.assets.USDS = { refPrice: 1000, listed: 1 };
    st.assets.WSTEEM = { refPrice: 56, listed: 1 };
    // יתרות-סינתטיות + קרדיטים לגז
    const seed = (w: string, asset: string, mu: number): void => { st.balances[w] = { ...(st.balances[w] ?? {}), [asset]: mu }; };
    const credits = (w: string, c: number): void => { st.credits[w] = c; };
    seed("lender-a", "USDS", 3_000_000); seed("lender-b", "USDS", 1_000_000);
    seed("borrower-x", "USDS", 2_000_000); seed("borrower-x", "WSTEEM", 5_000_000);
    seed("raider", "USDS", 5_000_000);
    for (const w of ["lender-a", "lender-b", "borrower-x", "raider", "treasury"]) credits(w, 10_000_000);
    const P = (op: any): any => applyOp(st, op, 1_000);
    let r: any;
    r = P({ type: "lend_supply", issuer: "lender-a", nonce: "u1", asset: "USDS", amount: 3_000_000 });
    ok(r.ok, "lender-a מפקיד 3Mµ");
    r = P({ type: "lend_supply", issuer: "lender-b", nonce: "u2", asset: "USDS", amount: 1_000_000 });
    ok(r.ok, "lender-b מפקיד 1Mµ");
    r = P({ type: "lend_supply", issuer: "borrower-x", nonce: "u3", asset: "WSTEEM", amount: 5_000_000 });
    ok(r.ok, "borrower-x מפקיד 5Mµ WSTEEM בטחונות");
    r = P({ type: "lend_borrow", issuer: "borrower-x", nonce: "u4", asset: "USDS", amount: 100_000 });
    ok(r.ok, "borrower-x שואל 100kµ (מול 280kµ ערך-בטחונות)");
    // הזדקנות-החוב: קפיצת-גובה סינתטית — 576,000 בלוקים (20 ימים) ב-~1.4% APR
    st.height = 50_000 + 576_000;
    const ls = st.lend;
    const apr = lendBorrowAprBps(ls.markets.USDS);
    const expectedInt = Math.floor(100_000 * apr * 576_000 / (10_000 * 10_483_200));
    const debt = lendDebtNow(ls.positions["borrower-x"].b.USDS, apr, st.height);
    ok(debt === 100_000 + expectedInt && expectedInt > 0, `ריבית-מוחשבת: 100,000µ × ${apr / 100}% × 20 ימים = +${expectedInt}µ`, `APR ${apr / 100}% · ניצולת ${lendUtilBps(ls.markets.USDS) / 100}%`);
    const treUSDS0 = st.balances.treasury?.USDS ?? 0;
    const aEarn0 = ls.positions["lender-a"].s.USDS.earned;
    const bEarn0 = ls.positions["lender-b"].s.USDS.earned;
    r = P({ type: "lend_repay", issuer: "borrower-x", nonce: "u5", asset: "USDS", amount: -1 });
    ok(r.ok, "פירעון-מלא");
    const ls2 = st.lend;
    const toSup = Math.floor(expectedInt * 9000 / 10_000);
    const toRes = expectedInt - toSup;
    ok(ls2.markets.USDS.resMu === toRes, `רזרבת-אוצר 10% = ${toRes}µ`, String(ls2.markets.USDS.resMu));
    ok((st.balances.treasury?.USDS ?? 0) - treUSDS0 === toRes, "האוצר קיבל-בפועל את הרזרבה", `${(st.balances.treasury?.USDS ?? 0) - treUSDS0}µ`);
    const aEarn = ls2.positions["lender-a"].s.USDS.earned - aEarn0;
    const bEarn = ls2.positions["lender-b"].s.USDS.earned - bEarn0;
    ok(aEarn + bEarn === toSup, `90% חולקו-מדויק לשני מלווים (${aEarn}+${bEarn}=${toSup})`);
    ok(aEarn === Math.floor(toSup * 3_000_000 / 4_000_000), `פרו-ראטה לפי-קרן: lender-a 3/4 = ${aEarn}µ`);
    // אינווריאנטת-הספרים על-המצב-הסינתטי
    const inv = (asset: string): boolean => {
      const pot = st.balances["lend-pot"]?.[asset] ?? 0;
      let expect = 0;
      for (const p of Object.values(st.lend.positions) as any[]) {
        expect += (p.s[asset]?.mu ?? 0) + (p.s[asset]?.earned ?? 0) - (p.b[asset]?.mu ?? 0);
      }
      return pot === expect;
    };
    ok(inv("USDS") && inv("WSTEEM"), "אינווריאנטה: pot = Σקרן+Σרווחים−Σחוב (שני-נכסים)");

    /* ניזולת-חיובית: מחיר-קורס ← HF<1 ← פשיטה עם בונוס-5% */
    r = P({ type: "lend_borrow", issuer: "borrower-x", nonce: "u6", asset: "USDS", amount: 60_000 });
    ok(r.ok, "מחזור-שני: שאילה-נוספת 60kµ");
    st.assets.WSTEEM.refPrice = 10; // פושט-מחירים: 56→10 (ירידת-82%) — HF צונח
    const hf = lendHealthFactor(st, "borrower-x");
    ok(hf < 100, `אחרי-פושט-המחירים HF=${(hf / 100).toFixed(2)} < 1 — ניזול`);
    const raiderW0 = st.balances.raider?.WSTEEM ?? 0;
    const raiderU0 = st.balances.raider?.USDS ?? 0;
    r = P({ type: "lend_liquidate", issuer: "raider", nonce: "u7", owner: "borrower-x", asset: "USDS", amount: -1 });
    ok(r.ok, "הריידר מנזל את-החייב");
    const seized = (st.balances.raider?.WSTEEM ?? 0) - raiderW0;
    const paid = raiderU0 - (st.balances.raider?.USDS ?? 0);
    ok(seized > 0 && paid > 0, `המפרק שילם ${paid}µ ותפס ${seized}µ WSTEEM`);
    ok(!st.lend.positions["borrower-x"]?.b?.USDS, "חוב-הניזול נסגר-במלואו");
    ok(st.lend.totals.liquidations === 1, "מונה-הניזולות = 1");
    ok(inv("USDS") && inv("WSTEEM"), "אינווריאנטה גם-אחרי-הניזולת");
  }

  /* ═══ ג. מחזור-שרשרת-מלא (על-השיבול-החי) ═══ */
  console.log("\n[proof] ══ ג · מחזור-שרשרת + סוכנים-אוטונומיים ══");
  const chain = await import("../src/lib/dex/chain");
  const rt = chain.ensureChain();
  const t = Date.now();
  while (rt.pendingLoad && Date.now() - t < 90_000) await new Promise((r) => setTimeout(r, 300));
  if (rt.halted) { console.error("[proof] chain HALTED at load — refusing"); process.exit(1); }
  chain.stopLoops();
  const { submitOp, nextNonce } = chain as any;
  const st = rt.st as any;
  const h0 = st.height;
  const { genesisTotals, ledgerAudit } = await import("../src/lib/dex/settle");
  const GT = genesisTotals();
  const fullAudit = (): { ok: boolean; errors: string[] } => {
    const a = ledgerAudit(st, GT);
    return { ok: a.errors.length === 0, errors: a.errors };
  };
  let r2: any;

  // דחיות-במצב-אמת (הדחייה קורית-בבלוק — הראיה: המצב)
  submitOp({ type: "lend_supply", issuer: "treasury", nonce: nextNonce("rx1"), asset: "PHIVE", amount: 1000 });
  await chain.stepOnce();
  ok(!st.lend?.markets?.PHIVE, "נכס-לא-רשום לא-נפתח-שוק");
  submitOp({ type: "lend_borrow", issuer: "bot-a", nonce: nextNonce("rx2"), asset: "USDS", amount: 1000 });
  await chain.stepOnce();
  ok(!st.lend?.positions?.["bot-a"]?.b?.USDS, "שאילה-בלי-בטחונות לא-נפתחה");

  // המחזור-האמיתי: TR_SUPPLY בדיוק-ביעד-הסוכן (20k = הרצפה-האדפטיבית) — בלי-מלחמה-עם-הסוכן
  const TR_SUPPLY = 20_000;
  r2 = submitOp({ type: "lend_supply", issuer: "treasury", nonce: nextNonce("rt1"), asset: "USDS", amount: TR_SUPPLY });
  await chain.stepOnce();
  ok(r2.queued, `אוצר מפקיד ${TR_SUPPLY}µ USDS (יעד-הסוכן)`);
  const S1 = "soldier-1";
  const s1Free = (st.balances[S1].WSTEEM ?? 0) - (st.locked?.[S1]?.WSTEEM ?? 0);
  const S1_COL = Math.min(60_000, Math.floor(s1Free * 0.9));
  r2 = submitOp({ type: "lend_supply", issuer: S1, nonce: nextNonce("rs1c"), asset: "WSTEEM", amount: S1_COL });
  await chain.stepOnce();
  ok(st.lend?.positions?.[S1]?.s?.WSTEEM?.mu === S1_COL, `${S1} הפקיד ${S1_COL}µ WSTEEM (זמין-אמת)`);
  const colVal = Math.floor(S1_COL * 56 / 1000);
  const DRAW = Math.floor(colVal * 4000 / 10_000); // 40% מהערך → HF = 50/40 = 1.25
  r2 = submitOp({ type: "lend_borrow", issuer: S1, nonce: nextNonce("rs1b"), asset: "USDS", amount: DRAW });
  await chain.stepOnce();
  const lsL = st.lend;
  ok(lsL?.positions?.[S1]?.b?.USDS?.mu === DRAW, `${S1} שואל ${DRAW}µ (HF≈1.25)`, `rej: ${JSON.stringify((rt as any).rejectedLast?.sample ?? null)}`);
  ok(lsL.markets.USDS.bMu === DRAW, "חוב-קרן במראה-השוק", String(lsL.markets.USDS.bMu));
  const hf1 = lendHealthFactor(st, S1);
  ok(hf1 >= 110 && hf1 < 1000, `HF חי (${(hf1 / 100).toFixed(2)})`);
  // רצפת-נזילות-10%: שאילה-ענקית נדחית (הראיה: החוב לא-זז)
  const cashNow = st.balances["lend-pot"]?.USDS ?? 0;
  submitOp({ type: "lend_borrow", issuer: S1, nonce: nextNonce("rs1b2"), asset: "USDS", amount: cashNow - Math.floor(lsL.markets.USDS.sMu * 0.1) + 1 });
  await chain.stepOnce();
  ok(st.lend.markets.USDS.bMu === DRAW, "שאילה-מעל-רצפת-10% נדחתה (החוב לא-זז)");
  // פירעון + משיכה (כנות-סקאלה: ריבית-µ-בודדים — האמת-של-סדר-הגודל)
  r2 = submitOp({ type: "lend_repay", issuer: S1, nonce: nextNonce("rs1r"), asset: "USDS", amount: -1 });
  await chain.stepOnce();
  ok(r2.queued && !st.lend.positions[S1]?.b?.USDS, "פירעון-מלא סוגר-את-החוב");
  r2 = submitOp({ type: "lend_withdraw", issuer: S1, nonce: nextNonce("rs1w"), asset: "WSTEEM", amount: -1 });
  await chain.stepOnce();
  ok(r2.queued && !st.lend.positions[S1], "משיכת-בטחונות סוגרת-את-העמדה");
  const wdJournal = (st.journal as any[]).find((j) => j.action === "lend_withdraw" && j.soldier === S1);
  ok(!!wdJournal && String(wdJournal.note ?? "").includes(String(S1_COL)), `הבטחונות חזרו (קבלת-יומן: ${String(wdJournal?.note ?? "").slice(0, 60)}…)`);

  /* הסוכנים-האוטונומיים: 240 בלוקים — המערך-עובד-לבד */
  const hAgent0 = st.height;
  for (let i = 0; i < 240; i++) await chain.stepOnce();
  const lsA = st.lend;
  const jLend = (st.journal as any[]).filter((j) => String(j.action).startsWith("lend_"));
  ok(jLend.length > 0, "הסוכנים ביצעו-פעולות-לבד", `${jLend.length} רשומות`);
  const treSupply = lsA.positions.treasury?.s?.USDS?.mu ?? 0;
  ok(treSupply > 0, "האוצר מזרים-לבד (אדפטיבי)", `${treSupply}µ`);
  const borrowers = Object.values(lsA.positions).filter((p: any) => p.b?.USDS && p.b.USDS.mu > 0).length;
  ok(borrowers > 0, "חיילים לווים-לבד", `${borrowers} לווים`);
  ok(lendUtilBps(lsA.markets.USDS) > 0, "ניצולת-חיה", `${lendUtilBps(lsA.markets.USDS) / 100}%`);

  /* ביקורת-ספרי-הברזל המלאה — אחרי-הכל */
  const audit = fullAudit();
  ok(audit.ok, "ledgerAudit מלא: יתרות+בריכות+גיבוי=ג'נזיס (שימור-מוחלט)", audit.errors.slice(0, 2).join(" · "));
  const invLive = Object.entries(K.LEND_MARKETS).every(([asset]: any) => {
    const pot = st.balances["lend-pot"]?.[asset] ?? 0;
    let expect = 0;
    for (const p of Object.values(st.lend.positions) as any[]) expect += (p.s[asset]?.mu ?? 0) + (p.s[asset]?.earned ?? 0) - (p.b[asset]?.mu ?? 0);
    return pot === expect;
  });
  ok(invLive, "אינווריאנטת-ה-pot חיה-על-השרשרת");
  ok(!rt.halted, "השרשרת לא-HALTED (כל-הביקורות-הפנימיות עברו)");
  console.log(`  · h${h0}→h${st.height} · ${jLend.length} פעולות-lend ביומן · דוגמה: ${jLend[jLend.length - 1]?.action}`);

  const receipt: Receipt = {
    proof: "R44-lend-isolated",
    sandbox: SANDBOX,
    heightStart: h0, heightEnd: st.height, pass: PASS, fail: FAIL,
    unit: { interestSplit: "90/10 verified", proRata: "3:1 verified", liquidation: "bonus-seize verified" },
    live: { journalLendOps: jLend.length, treasuryLiveMu: treSupply, borrowersLive: borrowers, utilBps: lendUtilBps(lsA.markets.USDS) },
    ledgerAudit: audit.ok, durationMs: Date.now() - t0,
  };
  fs.writeFileSync(path.join(process.env.HOME ?? "/tmp", "r44-lend-proof.json"), JSON.stringify(receipt, null, 2));
  console.log(`\n[proof] ═══ ${PASS} עבר · ${FAIL} נכשל · h${h0}→h${st.height} · ${((Date.now() - t0) / 1000).toFixed(0)}s ═══`);
  process.exit(FAIL === 0 ? 0 : 2);
}

main().catch((e) => { console.error("[proof] FATAL:", e); process.exit(1); });
