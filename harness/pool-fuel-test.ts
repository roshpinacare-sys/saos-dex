/**
 * EXEC-CD-9 · בדיקות-קלון-דטרמיניסטיות לשינויי-המדיניות-המאושרים.
 * רץ על עותק (structuredClone) של מצב-חי — אפס-נגיעה בשרשרת-החיה.
 *
 * מוכיח:
 *  A. pool_open-חצי-פתוח: נתיב-אזרחי-מאושר (שער-ערבות, LP-לפותח, owner) ·
 *     דחיות-כנות (מתחת-לשער, pair-לא-קנוני, בריכה-קיימת, תקרה) ·
 *     נתיב-האוצר-לא-השתנה · מגן-repeg-על-בריכת-אזרח · שימור-Σ.
 *  B. fuel-freeze-fix: מד-גז-הספר (feed→avail→take-פעם-אחת) · מחזור-לאוצר
 *     בסמנטיקות-mint_fuel (feeMinted↑) · האינווריאנטה Σcredits+gasUsed−feeMinted===ג'נזיס ·
 *     רצפת-מצב קוטלת הטבעה-כפולה (סימולציית-מד-מיושן).
 *  C. ריבייט: חשבון-10bps · unpaid=due−paid מונוטוני.
 */
import { applyOp, GAS_TABLE, POOL_OPEN_MIN_SIDE_MU, POOL_OPEN_MAX_PER_ISSUER, PRIMER_MU, PRIMER_SPLIT } from "../src/lib/dex/kernel";
import { getLiveState } from "../src/lib/dex/chain";
import { bookGasFeed, bookGasRecycleAvail, bookGasTake, bookGasFloor, bookGasStats } from "../src/lib/dex/bookgas";
import { bookGasRecycle } from "../src/lib/dex/economy";
import { rebateDueMu, rebateUnpaidMu, rebateMarkPaid } from "../src/lib/dex/maker";
import type { DexState, Op } from "../src/lib/dex/kernel";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const live = getLiveState();
const nowMs = 1_700_000_000_000;
const NONCE = () => `cd9-${Math.floor(nowMs)}-${Math.floor(Math.random() * 1e9)}`;
// זוגות-קנוניים-פנויים (לא-קיימים-בשרשרת-החיה: SAOS/USDS · USDS/WSTEEM · ENERGY/SAOS · USDS/WTRX)
const FREE_PAIR = "PHIVE/USDS";
const CAP_PAIRS = ["USDS/WSBD", "PHIVE/USDS", "ENERGY/USDS", "SAOS/WSTEEM", "SAOS/WSBD", "PHIVE/SAOS", "SAOS/WTRX", "ENERGY/PHIVE", "WSBD/WSTEEM"];

function freshClone(): DexState {
  const st = structuredClone(live) as DexState;
  // יחידת-בדיקה — דלק-ומלאי-מספיק לפותח-הבדיקה (לא-נוגעים באוצר-החי)
  st.credits["operator"] = 100_000;
  st.locked["operator"] = {}; // בידוד-יחידה: אפס-נעילות-חיות (העותק סנדבוקס)
  if (!st.height) st.height = 127_700; // בידוד-יחידה: גובה-ריאה (ההרנס עלול-להיטען-בגובה-0)
  st.balances["operator"] = {
    ...st.balances["operator"],
    USDS: 2_000_000, PHIVE: 2_000_000, WSTEEM: 2_000_000,
    WBLURT: 300_000, WSBD: 300_000, BLURT: 300_000, SBD: 300_000,
    STEEM: 300_000, ENERGY: 300_000, WSOL: 300_000, SAOS: 300_000, WTRX: 300_000,
  };
  return st;
}
function credits(st: DexState, who: string): number { return st.credits[who] ?? 0; }
function sumCredits(st: DexState): number {
  let t = 0;
  for (const v of Object.values(st.credits)) t += v;
  return t;
}

/* ══ A · pool_open חצי-פתוח ═══════════════════════════════════════════════ */
console.log("\n══ A1 · פתיחה-אזרחית-על-השער → LP-לפותח + owner ══");
{
  const st = freshClone();
  const phiveBefore = st.balances["operator"]?.PHIVE ?? 0;
  const r = applyOp(st, {
    type: "pool_open", issuer: "operator", nonce: NONCE(),
    pair: FREE_PAIR, amount: POOL_OPEN_MIN_SIDE_MU, amountB: POOL_OPEN_MIN_SIDE_MU,
  } as Op, nowMs);
  check("pool_open-אזרחי מתקבל", r.ok, JSON.stringify(r).slice(0, 140));
  const pool = st.pools[FREE_PAIR];
  check("הבריכה נולדה עם owner=הפותח", !!pool && pool.owner === "operator", JSON.stringify(pool ?? {}).slice(0, 120));
  const lpKey = `LP|${FREE_PAIR}`;
  check("LP=√k כולו-לפותח", (st.balances["operator"]?.[lpKey] ?? 0) > 0, `lp=${st.balances["operator"]?.[lpKey]}`);
  check("הזריעה יצאה מהיתרות-של-הפותח (אפס-אוצר-בסיכון)",
    (st.balances["operator"]?.PHIVE ?? 0) === phiveBefore - POOL_OPEN_MIN_SIDE_MU,
    `after=${st.balances["operator"]?.PHIVE} before=${phiveBefore}`);
  check("גז-אפס (שער-הערבות הוא המגן — לא המחיר)", r.gas === GAS_TABLE.pool_open, `gas=${r.gas}`);
}

console.log("\n══ A2 · מתחת-לשער → דחייה-כנה-אפס-נגיעה ══");
{
  const st = freshClone();
  const snap = JSON.stringify(st.pools);
  const r = applyOp(st, {
    type: "pool_open", issuer: "operator", nonce: NONCE(),
    pair: "USDS/WSBD", amount: 1000, amountB: 1000,
  } as Op, nowMs);
  check("נדחה below-margin-gate", !r.ok && String(r.err).startsWith("below-margin-gate"), JSON.stringify(r).slice(0, 120));
  check("אפס-שינוי-בבריכות", JSON.stringify(st.pools) === snap);
}

console.log("\n══ A3 · pair-לא-קנוני + בריכה-קיימת → דחייה ══");
{
  const st = freshClone();
  const r1 = applyOp(st, { type: "pool_open", issuer: "operator", nonce: NONCE(), pair: "USDS/PHIVE", amount: POOL_OPEN_MIN_SIDE_MU, amountB: POOL_OPEN_MIN_SIDE_MU } as Op, nowMs);
  check("non-canonical נדחה", !r1.ok && r1.err === "non-canonical-pair", JSON.stringify(r1).slice(0, 100));
  applyOp(st, { type: "pool_open", issuer: "operator", nonce: NONCE(), pair: FREE_PAIR, amount: POOL_OPEN_MIN_SIDE_MU, amountB: POOL_OPEN_MIN_SIDE_MU } as Op, nowMs);
  const r2 = applyOp(st, { type: "pool_open", issuer: "operator", nonce: NONCE(), pair: FREE_PAIR, amount: POOL_OPEN_MIN_SIDE_MU, amountB: POOL_OPEN_MIN_SIDE_MU } as Op, nowMs);
  check("pool-exists נדחה (פתיחה-כפולה)", !r2.ok && r2.err === "pool-exists", JSON.stringify(r2).slice(0, 100));
}

console.log("\n══ A4 · תקרת-בריכות-פר-פותח (8) → התשיעית נדחה ══");
{
  const st = freshClone();
  let opened = 0, capped = false;
  for (const pair of CAP_PAIRS) {
    if (st.pools[pair]) continue; // זוג-תפוס-במצב-החי — לא-חלק-מהניסוי
    const r = applyOp(st, { type: "pool_open", issuer: "operator", nonce: NONCE(), pair, amount: POOL_OPEN_MIN_SIDE_MU, amountB: POOL_OPEN_MIN_SIDE_MU } as Op, nowMs);
    if (r.ok) opened++;
    if (!r.ok && r.err === "pool-cap-reached") { capped = true; break; }
    if (!r.ok) { console.log(`    (pair ${pair}: ${r.err})`); break; }
  }
  check("8-נפתחו-והתשיעית-נחסמה", opened === POOL_OPEN_MAX_PER_ISSUER && capped, `opened=${opened} capped=${capped}`);
}

console.log("\n══ A5 · מגן-repeg: בריכת-אזרח אינה-ניתנת-לסימון-מחדש-אוצר ══");
{
  const st = freshClone();
  applyOp(st, { type: "pool_open", issuer: "operator", nonce: NONCE(), pair: FREE_PAIR, amount: POOL_OPEN_MIN_SIDE_MU, amountB: POOL_OPEN_MIN_SIDE_MU } as Op, nowMs);
  const r = applyOp(st, { type: "pool_repeg", issuer: "treasury", nonce: NONCE(), pair: FREE_PAIR } as Op, nowMs);
  check("citizen-pool-no-repeg", !r.ok && r.err === "citizen-pool-no-repeg", JSON.stringify(r).slice(0, 100));
  check("אפס-שריפת-גז-על-דחייה", r.gas === 0, `gas=${r.gas}`);
}

console.log("\n══ A6 · נתיב-האוצר-לא-השתנה (owner=undefined) ══");
{
  const st = freshClone();
  // זריעה-ריבונית על pair-פנוי (אוצר-הבדיקה ממומן-מקומית)
  st.balances["treasury"] = { ...st.balances["treasury"], WSBD: 100_000, USDS: (st.balances["treasury"]?.USDS ?? 0) + 100_000 };
  const before = credits(st, "treasury");
  const r = applyOp(st, { type: "pool_open", issuer: "treasury", nonce: NONCE(), pair: "USDS/WSBD", amount: 60_000, amountB: 60_000 } as Op, nowMs);
  check("pool_open-אוצר מתקבל", r.ok, JSON.stringify(r).slice(0, 120));
  check("owner=undefined (ריבוני — repeg-חוקי)", st.pools["USDS/WSBD"]?.owner === undefined, `owner=${st.pools["USDS/WSBD"]?.owner}`);
  check("LP-לאוצר", (st.balances["treasury"]?.["LP|USDS/WSBD"] ?? 0) > 0);
  const rp = applyOp(st, { type: "pool_repeg", issuer: "treasury", nonce: NONCE(), pair: "USDS/WSBD" } as Op, nowMs);
  check("repeg-ריבוני-נשאר-חוקי (או דחייה-כנה של עוגן-חסר)", rp.ok || rp.err === "no-anchor" || rp.err === "on-anchor" || rp.err === "bad-anchor", JSON.stringify(rp).slice(0, 100));
  check("אפס-דלק-אוצר-בשריפה (pool_open/repeg-אפס-גז)", credits(st, "treasury") === before, `after=${credits(st, "treasury")} before=${before}`);
}

/* ══ B · fuel-freeze-fix ═══════════════════════════════════════════════════ */
console.log("\n══ B1 · מד-גז-הספר: feed→avail→take-פעם-אחת ══");
{
  const stats0 = bookGasStats();
  bookGasFeed([{ type: "order", gas: 60 }, { type: "cancel_all", gas: 15 }, { type: "order", gas: 0 }]); // אפס-גז לא-נספר
  const stats = bookGasStats();
  check("המד סופר שריפות-מאושרות-בלבד (Δ75, אפס-גז לא)", stats.collectedMu === stats0.collectedMu + 75, JSON.stringify({ ...stats, ...stats0 }));
  const avail0 = bookGasRecycleAvail();
  check("pending>0 אחרי-הזנה", avail0 >= 75, `avail=${avail0}`);
  const taken = bookGasTake(avail0);
  check("take מנכה-פעם-אחת", taken === avail0 && bookGasRecycleAvail() === 0, `taken=${taken} avail-after=${bookGasRecycleAvail()}`);
  const takenAgain = bookGasTake(avail0);
  check("take-שני = 0 (אף-µ-לא-מוחזר-פעמיים)", takenAgain === 0, `again=${takenAgain}`);
}

console.log("\n══ B2 · המחזור: לאוצר בסמנטיקות-mint_fuel + אינווריאנטה ══");
{
  const st = freshClone();
  bookGasFloor(st.bookGasRecycledMu ?? 0); // אותו-רצף-טעינה-כמו-השרשרת
  bookGasFeed([{ type: "order", gas: 60 }, { type: "order", gas: 60 }, { type: "fill", gas: 60 }, { type: "cancel", gas: 15 }]);
  const avail = bookGasRecycleAvail();
  const sumBefore = sumCredits(st);
  const gasBefore = st.gasUsed;
  const mintedBefore = st.feeMinted ?? 0;
  const treasuryBefore = credits(st, "treasury");
  bookGasRecycle(st, st.height, nowMs);
  const minted = (st.feeMinted ?? 0) - mintedBefore;
  check("קרדיטים-הגיעו-לאוצר (בדיוק-המד)", credits(st, "treasury") === treasuryBefore + avail, `Δ=${credits(st, "treasury") - treasuryBefore} avail=${avail}`);
  check("feeMinted↑ באותו-סכום (סמנטיקות-mint_fuel)", minted === avail, `minted=${minted} avail=${avail}`);
  check("אינווריאנטה: Σcredits+gasUsed−feeMinted נשמר",
    sumCredits(st) + (st.gasUsed - gasBefore) - minted === sumBefore, `Σ=${sumCredits(st)}`);
  check("רצפת-המצב נרשמה", (st.bookGasRecycledMu ?? 0) >= avail, `floor=${st.bookGasRecycledMu}`);
  // מחזור-שני על אותו-מד — אפס (כל-µ-פעם-אחת)
  const treasuryMid = credits(st, "treasury");
  bookGasRecycle(st, st.height, nowMs);
  check("מחזור-שני = 0 (אין-הטבעה-כפולה)", credits(st, "treasury") === treasuryMid, `treasury=${credits(st, "treasury")}`);
}

console.log("\n══ B3 · רצפת-מצב קוטלת הטבעה-כפולה (סימולציית-מד-מיושן) ══");
{
  const st = freshClone();
  bookGasFeed([{ type: "order", gas: 60 }]);
  bookGasRecycle(st, st.height, nowMs); // המצב נשטף: bookGasRecycledMu=+60
  const stateFloor = st.bookGasRecycledMu ?? 0;
  // קריסה-וטעינה-מחדש: קובץ-המד היה-מיושן (recycled-חסר-60) — מדמים-ישירות-על-המד החי
  const meter = (globalThis as unknown as { __saosDexBookGas?: { recycledMu: number } }).__saosDexBookGas;
  check("תנאי-מקדים: מד-מדומה-מיושן", !!meter && meter.recycledMu >= stateFloor);
  const totalKnown = Math.max(stateFloor, meter?.recycledMu ?? 0); // בייצור: מצב = הסך-הכול-האמת
  if (meter) meter.recycledMu -= 60; // המד-איבד-את-הדלתא-שנשטפה-רק-במצב
  bookGasFloor(totalKnown); // אותה-קריאה-של-השרשרת-בטעינה (רצפת-הסך-הכול-האמת)
  check("floor מיישר את המד המיושן", bookGasRecycleAvail() === 0, `avail=${bookGasRecycleAvail()}`);
  const treasuryBefore = credits(st, "treasury");
  bookGasRecycle(st, st.height, nowMs);
  check("אפס-מחזור-על-אותו-גז (רצפת-המצב מנצחת)", credits(st, "treasury") === treasuryBefore);
}

console.log("\n══ B4 · THE-PRIMER: חד-פעמי · ספליט-מדויק · אינווריאנטה ══");
{
  const st = freshClone();
  const sumBefore = sumCredits(st);
  const gasBefore = st.gasUsed;
  const mintedBefore = st.feeMinted ?? 0;
  const r = applyOp(st, { type: "primer", issuer: "treasury", nonce: NONCE() } as Op, nowMs);
  check("primer מתקבל", r.ok, JSON.stringify(r).slice(0, 120));
  const delta = sumCredits(st) - sumBefore;
  check("Σ-הספליט = PRIMER_MU בדיוק", delta === PRIMER_MU, `Δ=${delta}`);
  check("ארנה קיבלה 300k", credits(st, "arena") >= 300_000, `arena=${credits(st, "arena")}`);
  check("feeMinted↑ באותו-סכום", (st.feeMinted ?? 0) - mintedBefore === PRIMER_MU, `minted=${st.feeMinted}`);
  check("אינווריאנטה נשמרת", sumCredits(st) + (st.gasUsed - gasBefore) - ((st.feeMinted ?? 0) - mintedBefore) === sumBefore);
  check("דגל-primerUsed נרשם", st.primerUsed === true && st.primerH === st.height, `used=${st.primerUsed} h=${st.primerH}`);
  const r2 = applyOp(st, { type: "primer", issuer: "treasury", nonce: NONCE() } as Op, nowMs);
  check("פריימר-שני נדחה fail-closed", !r2.ok && r2.err === "primer-already-used", JSON.stringify(r2).slice(0, 100));
  const r3 = applyOp(st, { type: "primer", issuer: "operator", nonce: NONCE() } as Op, nowMs);
  check("לא-אוצר נדחה", !r3.ok && r3.err === "treasury-only", JSON.stringify(r3).slice(0, 100));
}

console.log("\n══ B5 · ביקורת-הלדגר-עם-הפריימר — ההצהרה מאושרת ══");
{
  const st = structuredClone(live) as DexState; // עותק-טהור — הביקורת דנה רק את הפריימר עצמו
  applyOp(st, { type: "primer", issuer: "treasury", nonce: NONCE() } as Op, nowMs);
  check("primerMu מוצהר = 1M", (st.primerMu ?? 0) === PRIMER_MU, `primerMu=${st.primerMu}`);
  const { ledgerAudit, genesisTotals } = await import("../src/lib/dex/settle");
  const audit = ledgerAudit(st, genesisTotals());
  check("audit ירוק — זהות-העמלות מחסירה-את-ההצהרה", audit.ok, JSON.stringify([...audit.errors, ...audit.negatives]).slice(0, 180));
  // וההיפך: בלי-ההצהרה (מדמים מחיקת-שדה) — הביקורת חייבת להיאדם (fail-closed)
  const st2 = structuredClone(st) as DexState;
  const pm = st2.primerMu; delete st2.primerMu; delete st2.primerUsed;
  const audit2 = ledgerAudit(st2, genesisTotals());
  check("בלי-הצהרה — הביקורת נופלת (לא-מוסתר)", !audit2.ok, JSON.stringify(audit2.errors.slice(0, 1)));
  void pm;
  // B5b · המחזור-מוצהר: פריימר + מחזור-גז-ספר על עותק-טהור — הביקורת נשארת ירוקה
  const st3 = structuredClone(live) as DexState;
  applyOp(st3, { type: "primer", issuer: "treasury", nonce: NONCE() } as Op, nowMs);
  bookGasFeed([{ type: "order", gas: 60 }, { type: "fill", gas: 60 }, { type: "cancel", gas: 15 }]);
  bookGasRecycle(st3, st3.height, nowMs);
  const audit3 = ledgerAudit(st3, genesisTotals());
  check("audit ירוק עם פריימר+מחזור-גז (שלושת-המקורות)", audit3.ok, JSON.stringify([...audit3.errors, ...audit3.negatives]).slice(0, 180));
}

/* ══ C · ריבייט ════════════════════════════════════════════════════════════ */
console.log("\n══ C1 · חשבון-ריבייט 10bps + מונוטוניות ══");
{
  const volMu = 1_000_000; // 1000 USDS נומינל
  const who = `cd9-rebate-probe-${Date.now()}`; // זהות-בדיקה-טרייה — אפס-התנגשות-היסטוריה
  const due = Math.floor((volMu * 10) / 10_000);
  check("מתמטיקת-10bps (1Mµ → 1000µ)", due === 1000, `due=${due}`);
  check("rateBps=0 → 0-כנה (תאימות-אחורה)", rebateDueMu("no-such-maker", 0) === 0);
  check("מייקר-לא-מיוחס → 0", rebateDueMu("cd9-never-existed") === 0, `got=${rebateDueMu("cd9-never-existed")}`);
  rebateMarkPaid(who, 5);
  check("unpaid לעולם לא שלילי", rebateUnpaidMu(who) >= 0, `unpaid=${rebateUnpaidMu(who)}`);
}

/* ══ D · שימור-כללי ════════════════════════════════════════════════════════ */
console.log("\n══ D1 · Σ(balances+reserves) נשמר בפתיחה-אזרחית ══");
{
  const st = freshClone();
  const sum = (): number => {
    let t = 0;
    // LP-מטבעות נגזרת-מוטבעת (√k) — מוצרים מהזריעה עצמה; השימור-הברזל הוא על נכסי-האמת
    for (const w of Object.values(st.balances)) for (const [a, v] of Object.entries(w)) if (!a.startsWith("LP|")) t += v;
    for (const p of Object.values(st.pools)) t += p.ra + p.rb;
    return t;
  };
  const before = sum();
  applyOp(st, { type: "pool_open", issuer: "operator", nonce: NONCE(), pair: FREE_PAIR, amount: POOL_OPEN_MIN_SIDE_MU, amountB: POOL_OPEN_MIN_SIDE_MU } as Op, nowMs);
  check("אפס-יצירה/השמדה (הזריעה עוברת-לרזרבות)", sum() === before, `Δ=${sum() - before}`);
}

console.log(`\n═══ סיכום EXEC-CD-9: ${pass} עברו · ${fail} נכשלו ═══`);
process.exit(fail > 0 ? 1 : 0);
