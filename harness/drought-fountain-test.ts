/**
 * G105 · THE-DROUGHT-FOUNTAIN · בדיקות-קלון-דטרמיניסטיות (trace 1a17ded5ebeb520d)
 * ═══════════════════════════════════════════════════════════════════════════════
 * רץ על עותק (structuredClone) של מצב-חי — אפס-נגיעה בשרשרת-החיה.
 *
 * מוכיח:
 *  D1  משטר-רגיל נשמר מילה-במילה: ארנה-ממומנת + מד-מתחת-לרצפה → דחייה כנה
 *      (mint-exceeds-measured-fees) — החוק-הישן לא נשבר.
 *  D2  isFuelDrought: מדידה מדויקת של הבצורת (ארנה-מתה + רווח-0 + אפס-מעל-רצפה)
 *      ושלילה-מדויקת כשאחד-התנאים מוסר.
 *  D3  בצורת: הטבעה מהמד עד DROUGHT_FLOOR — קרדיטים↑ feeMinted↑ מד↓ באותם-µ,
 *      האינווריאנטה Σcredits+gasUsed−feeMinted נשמרת בדיוק.
 *  D4  בצורת-מתוקה: מעבר ל-(מד−DROUGHT_FLOOR) ובלי revAux → דחייה כנה.
 *  D5  revAux כגיבוי-שלישי בבצורת בלבד: profit→meter→aux סדר-קנוני,
 *      revAuxMintedMu נרשם בדיוק, האינווריאנטה עומדת.
 *  D6  סדר-קנוני בתוך revAux: protorev נצרך לפני launchpad.
 *  D7  מחוץ-לבצורת revAux אינו גיבוי: ארנה-ממומנת + revAux עצום → דחייה.
 *  D8  דחיית-רגרסיה: non-treasury + תקרת-MINT_FUEL_CAP.
 *  D9  אפס-שבירת-ביקורת: ledgerAudit לפני/אחרי הטבעת-בצורת — אותן-שגיאות
 *      בדיוק (אפס-שגיאה-חדשה); זהות-העמלות הדיפרנציאלית מאומתת מספרית.
 */
import { applyOp, isFuelDrought, auxAvailMu, DROUGHT_FLOOR, LADDER_FUEL_FLOOR, MINT_FUEL_CAP } from "../src/lib/dex/kernel";
import { getLiveState } from "../src/lib/dex/chain";
import { ledgerAudit, genesisTotals } from "../src/lib/dex/settle";
import type { DexState, Op } from "../src/lib/dex/kernel";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const live = getLiveState();
let n = 0;
const uniq = () => `g105-${Date.now()}-${++n}`;

function freshClone(): DexState {
  const st = structuredClone(live) as DexState;
  st.credits["operator"] = 100_000; // יחידת-בדיקה — דלק-מספיק (העותק סנדבוקס)
  st.locked["operator"] = {};
  return st;
}
function credits(st: DexState, who: string): number { return st.credits[who] ?? 0; }
function sumCredits(st: DexState): number { let t = 0; for (const v of Object.values(st.credits)) t += v; return t; }
function mint(st: DexState, amount: number, to = "arena"): { ok: boolean; err?: string } {
  const r = applyOp(st, { type: "mint_fuel", issuer: "treasury", nonce: uniq(), to, amount } as Op);
  return r.ok ? { ok: true } : { ok: false, err: r.err };
}
/** מצב-בצורת-קנוני: ארנה-מתה + רווח-0 + מד-כלוא-מתחת-לרצפה (המדידה-החיה של 15:16Z) */
function droughtClone(meterMu = 3_346): DexState {
  const st = freshClone();
  st.credits["arena"] = 0;
  st.treasuryProfit = 0;
  st.feeMeter = meterMu;
  return st;
}

console.log("\n══ D1 · משטר-רגיל נשמר מילה-במילה ══");
{
  const st = freshClone();
  st.credits["arena"] = 50_000; // ארנה-חיה → לא-בצורת
  st.treasuryProfit = 0;
  st.feeMeter = 3_346; // מד-כלוא-מתחת-לרצפה
  const r = mint(st, 3_000);
  check("מד-מתחת-לרצפה-וארנה-חיה → נדחה (החוק-הישן)", !r.ok && r.err === "mint-exceeds-measured-fees", JSON.stringify(r));
  check("אפס-שינוי-מדידה בדחייה", st.feeMeter === 3_346 && (st.feeMinted ?? 0) === ((structuredClone(live) as DexState).feeMinted ?? 0));
}

console.log("\n══ D2 · isFuelDrought מדידה מדויקת ══");
{
  const a = droughtClone();
  check("בצורת-מלאה מזוהה", isFuelDrought(a));
  a.credits["arena"] = DROUGHT_ARENA_LIVE();
  check("ארנה-חיה → לא-בצורת", !isFuelDrought(a));
  const b = droughtClone();
  b.treasuryProfit = 500; // רווח-חי → המזרקה הרגילה עובדת
  check("רווח-גדול-מ-0 → לא-בצורת", !isFuelDrought(b));
  const c = droughtClone(9_000); // מד-מעל-הרצפה → המשטר-הרגיל
  check("מד-מעל-8000 → לא-בצורת", !isFuelDrought(c));
  const d = droughtClone(8_000); // בדיוק-על-הרצפה → aboveFloor 0 → בצורת
  check("מד-בדיוק-8000 → בצורת (אפס-דלק-חוקי מעל-הרצפה)", isFuelDrought(d));
}
function DROUGHT_ARENA_LIVE(): number { return 10_000; } // אותו-סף-כמו-DROUGHT_ARENA_MIN בגרעין

console.log("\n══ D3 · הטבעת-בצורת מהמד ══");
{
  const st = droughtClone(3_346);
  const sum0 = sumCredits(st), gas0 = st.gasUsed, minted0 = st.feeMinted ?? 0;
  const r = mint(st, 3_000);
  check("הטבעה-3,000 מהמד-הכלוא → מאושרת", r.ok, JSON.stringify(r));
  check("המד ירד בדיוק (3,346→346)", st.feeMeter === 346, `meter=${st.feeMeter}`);
  check("מעל-רצפת-הבצורת (200) לא נגעו", st.feeMeter >= DROUGHT_FLOOR);
  check("קרדיטים הגיעו ליעד", credits(st, "arena") === 3_000);
  check("feeMinted נרשם", (st.feeMinted ?? 0) === minted0 + 3_000);
  check("אינווריאנטת-הקרדיטים", sumCredits(st) + (st.gasUsed - gas0) - ((st.feeMinted ?? 0) - minted0) === sum0);
}

console.log("\n══ D4 · בצורת-מתוקה (בלי revAux) → דחייה-כנה ══");
{
  const st = droughtClone(346);
  st.revAux = undefined;
  const r = mint(st, 500);
  check("מעבר-למד-פנוי-ובלי-aux → נדחה", !r.ok && r.err === "mint-exceeds-measured-fees", JSON.stringify(r));
  check("אפס-שינוי-מד", st.feeMeter === 346);
}

console.log("\n══ D5 · revAux גיבוי-שלישי בבצורת ══");
{
  const st = droughtClone(346);
  st.revAux = { protorevMu: 20_303_080, launchpadMu: 0, runs: 1, cycles: 1, rejections: 0, lastH: 1 };
  const sum0 = sumCredits(st), gas0 = st.gasUsed, minted0 = st.feeMinted ?? 0;
  const aux0 = auxAvailMu(st);
  const r = mint(st, 60_000);
  check("הטבעת-60k מגובת מד+aux → מאושרת", r.ok, JSON.stringify(r));
  const fromMeter = 346 - st.feeMeter;
  const fromAux = (st.revAuxMintedMu ?? 0);
  check("המד נשאב קודם (עד-הרצפה)", st.feeMeter === DROUGHT_FLOOR, `meter=${st.feeMeter}`);
  check("השארית מ-revAux בדיוק", fromMeter + fromAux === 60_000, `meter=${fromMeter} aux=${fromAux}`);
  check("revAux ירד בדיוק ב-aux-שנצרך", aux0 - auxAvailMu(st) === fromAux);
  check("revAuxMintedMu = ה-aux-שנצרך", fromAux === 60_000 - fromMeter);
  check("feeMinted נרשם במלואו", (st.feeMinted ?? 0) === minted0 + 60_000);
  check("קרדיטים הגיעו ליעד", credits(st, "arena") === 60_000);
  check("אינווריאנטת-הקרדיטים", sumCredits(st) + (st.gasUsed - gas0) - ((st.feeMinted ?? 0) - minted0) === sum0);
}

console.log("\n══ D6 · סדר-קנוני בתוך revAux: protorev לפני launchpad ══");
{
  const st = droughtClone(200);
  st.revAux = { protorevMu: 1_000, launchpadMu: 5_000, runs: 1, cycles: 1, rejections: 0, lastH: 1 };
  const r = mint(st, 4_000);
  check("הטבעה-4k מעל-רצפת-הבצורת → מאושרת", r.ok, JSON.stringify(r));
  check("protorev נשאב ראשון עד-תום", st.revAux?.protorevMu === 0, `pr=${st.revAux?.protorevMu}`);
  check("launchpad סופג-את-השארית", st.revAux?.launchpadMu === 5_000 - 3_000, `lp=${st.revAux?.launchpadMu}`); // 4k−1k(protorev)=3k מ-launchpad → 2k נשאר
  check("revAuxMintedMu כולל-את-שניהם", (st.revAuxMintedMu ?? 0) === 4_000 - 0, `ram=${st.revAuxMintedMu}`);
}

console.log("\n══ D7 · מחוץ-לבצורת revAux אינו גיבוי ══");
{
  const st = freshClone();
  st.credits["arena"] = 50_000; // ארנה-חיה
  st.treasuryProfit = 0;
  st.feeMeter = 3_346;
  st.revAux = { protorevMu: 20_303_080, launchpadMu: 0, runs: 1, cycles: 1, rejections: 0, lastH: 1 };
  const r = mint(st, 60_000);
  check("ארנה-חיה + revAux עצום → נדחה (הבצורת-היא-השער)", !r.ok && r.err === "mint-exceeds-measured-fees", JSON.stringify(r));
  check("revAux לא נגע", auxAvailMu(st) === 20_303_080);
  check("revAuxMintedMu נשאר 0", (st.revAuxMintedMu ?? 0) === 0);
}

console.log("\══ D8 · דחיות-רגרסיה ══".replace("\\", ""));
{
  const st = droughtClone(3_346);
  const r1 = applyOp(st, { type: "mint_fuel", issuer: "bot-a", nonce: uniq(), to: "bot-a", amount: 1_000 } as Op);
  check("non-treasury → treasury-only", !r1.ok && r1.err === "treasury-only");
  const r2 = mint(st, MINT_FUEL_CAP + 1);
  check("מעל-תקרת-ההטבעה → נדחה", !r2.ok && r2.err === "mint-exceeds-cap", JSON.stringify(r2));
  const r3 = mint(st, 0);
  check("כמות-0 → נדחה", !r3.ok && r3.err === "bad-amount");
}

console.log("\n══ D9 · אפס-שבירת-ביקורת (settle (d) עם הדלי-המוצהר) ══");
{
  const st = droughtClone(346);
  st.revAux = { protorevMu: 20_303_080, launchpadMu: 0, runs: 1, cycles: 1, rejections: 0, lastH: 1 };
  const totals = genesisTotals();
  const before = ledgerAudit(st, totals);
  const pools0 = before.fees.poolsTreasury, book0 = before.fees.bookFeesMu, spent0 = before.fees.feesSpentMu;
  const meter0 = st.feeMeter, profit0 = st.treasuryProfit, minted0b = st.feeMinted ?? 0;
  const r = mint(st, 60_000);
  check("הטבעת-בצורת-מגובה → מאושרת", r.ok, JSON.stringify(r));
  const after = ledgerAudit(st, totals);
  // זהות-העמלות-הדיפרנציאלית (אמת-עצמאית-מהבזל): Δpools+Δbook === Δmeter+Δprofit+Δminted−ΔrevAuxMinted+Δspent
  const lhs = (after.fees.poolsTreasury - pools0) + (after.fees.bookFeesMu - book0);
  const rhs = (st.feeMeter - meter0) + (st.treasuryProfit - profit0) + ((st.feeMinted ?? 0) - minted0b)
    - (st.revAuxMintedMu ?? 0) + (after.fees.feesSpentMu - spent0);
  check("זהות-העמלות-הדיפרנציאלית עומדת בדיוק", lhs === rhs, `lhs=${lhs} rhs=${rhs}`);
  if (before.ok) check("ביקורת-ירוקה-לפני → ירוקה-אחרי", after.ok, JSON.stringify(after.errors.slice(0, 3)));
  else {
    const kinds = (a: typeof after) => [...a.errors, ...a.negatives].map((e) => e.split("≠")[0].split(":")[0]).sort().join("|");
    check("אפס-סוג-שגיאה-חדש (בזל-עם-פער-היסטורי-מוצהר)", kinds(before) === kinds(after), `b=${kinds(before)} a=${kinds(after)}`);
  }
  check("ביקורת-האשראי עומדת", after.credits.ok === before.credits.ok, JSON.stringify(after.credits));
}

console.log(`\n══ G105-DROUGHT-FOUNTAIN: ${pass} PASS / ${fail} FAIL ══`);
if (fail > 0) { console.error("G105 drought-fountain: FAILURES PRESENT — landing forbidden"); process.exit(1); }
