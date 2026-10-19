/**
 * t37-laws-selftest.ts — הוכחת-פעולה לשני-החוקים-הקרנליים של-T37 (2026-10-14)
 * =============================================================================
 * אפס-רשת · אפס-DB · אפס-מפתחות — מדידה-טהורה על מצב-ג'נזיס סינתטי.
 *
 *   T37-c · משמעת-חיוב-קרנלית (chargeFree): החיוב-הדיסקרטי מכבד את רצפת-הנעילות.
 *     וקטור-התקרית-המדודה (h151812): יתרה-גולמית גבוהה + נעילה-חיה = avail-נמוך —
 *     הקוד-הישן היה בודק את היתרה-הגולמית, פולש-לשטח-הנעול ומייצר נעילת-פנטום →
 *     HALT. החוק: avail הוא הגבול-האמת; פולשות = honest-skip, אפס-נגיעה-במצב.
 *
 *   T37-d · סרוו-עומק-הספר (bookAskAlive + reserveFunderAfford): הרזרבות-העומדות
 *     (sweeper/rail/bot-e) זורמות-למציבי-הספר רק-כשצד-האסק-של-השוק-הריבוני מת,
 *     ברצפות-מסלול-שלמות, ונחות-ברגע-שהספר-חוזר-לחיות. וקטור-המוות-המנעול
 *     (h155706): אוצר 14µ · operator 1,860µ < FUEL_ASK_MIN · מטר-על-רצפת —
 *     הסולם-הראשי-מת מול-רזרבות-עומדות-חוקיות וספר-חד-צדדי.
 *
 * יציאה 0 = כל-ההוכחות עמדו; אחרת 1.
 */
import {
  genesisState, applyOp, chargeFree, addLock, addBal, bal, lockedOf, avail,
  bookAskAlive, reserveFunderAfford, RESERVE_FUNDERS, RESERVE_FUNDERS_FLOOR,
  FUEL_FUNDERS, FUEL_ASK_MIN, type DexState,
} from "../src/lib/dex/kernel";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => {
  console.log(`${ok ? " ✓" : " ✗"} ${name}`);
  if (ok) pass++; else { fail++; process.exitCode = 1; }
};

const WSTEEM_SELL = { seq: 1, id: 1, owner: "soldier-1", base: "WSTEEM", quote: "USDS", side: "sell" as const, price: 57, amount: 80_000, filled: 0, live: true, nonce: "n1", at: 0, lockMu: 80_000 };

function stWith(opts: { treasuryBal?: number; treasuryLock?: number; credits?: Record<string, number>; orders?: DexState["orders"] } = {}): DexState {
  const st = genesisState();
  st.balances = {};
  st.locked = {};
  st.orders = opts.orders ?? [];
  if (opts.treasuryBal !== undefined) addBal(st, "treasury", "USDS", opts.treasuryBal);
  if (opts.treasuryLock) addLock(st, "treasury", "USDS", opts.treasuryLock);
  st.credits = { ...(opts.credits ?? {}) };
  return st;
}

/* ══ T37-c · chargeFree — משמעת-החיוב ══════════════════════════════════════ */
{
  // ו-1: הצלחה-רגילה — חיוב-מתוך-עודף-חופשי
  const st = stWith({ treasuryBal: 1_000 });
  const ok = chargeFree(st, "treasury", "USDS", 500);
  t("T37-c V1 charge from free surplus: ok, bal debited exactly", ok === true && bal(st, "treasury", "USDS") === 500 && lockedOf(st, "treasury", "USDS") === 0);

  // ו-2: רצפת-הנעילות — חיוב-שחודר-לשטח-הנעול נדחה ואפס-נגיעה-במצב
  const st2 = stWith({ treasuryBal: 1_000, treasuryLock: 900 });
  const jLen = st2.journal.length;
  const ok2 = chargeFree(st2, "treasury", "USDS", 500);
  t("T37-c V2 lock-floor respected: refuse + state untouched", ok2 === false && bal(st2, "treasury", "USDS") === 1_000 && lockedOf(st2, "treasury", "USDS") === 900 && avail(st2, "treasury", "USDS") === 100 && st2.journal.length === jLen);

  // ו-3: גבול-מדויק — avail==amt עובר ומניב-avail=0
  const st3 = stWith({ treasuryBal: 1_000, treasuryLock: 900 });
  const ok3 = chargeFree(st3, "treasury", "USDS", 100);
  t("T37-c V3 exact-avail charge passes to zero", ok3 === true && avail(st3, "treasury", "USDS") === 0);

  // ו-4: דחיות-צורה — לא-שלם / אפס / שלילי
  const st4 = stWith({ treasuryBal: 1_000 });
  const bad = [chargeFree(st4, "treasury", "USDS", 0), chargeFree(st4, "treasury", "USDS", -5), (() => { try { return chargeFree(st4, "treasury", "USDS", 1.5); } catch { return false; } })()];
  t("T37-c V4 zero/negative/non-integer refused", bad.every((x) => x === false) && bal(st4, "treasury", "USDS") === 1_000);

  // ו-5: וקטור-התקרית-המדודה (h151812) — מספרי-האמת:
  // מצב-הסוף-הנמדד: יתרה 1,000,164 · נעילה 1,003,213 → avail=−3,049 (ה-HALT-הכנה).
  // הפלישה: חיוב-דיסקרטי שנבדק-מול-היתרה-הגולמית (עובר) במקום-מול-avail (נדחה).
  // החוק: מצב-כזה מקבל אפס-חיובים-נוספים (כל-amt>0 נדחה); ההצצה-הישנה-מודגמת
  // מול-העותק: ממצב-שבו-היתרה-הגולמית-מספיקה-אך-ה-avail-לא — הדרך-הישנה חודרת
  // לשלילי (הצורה שהובילה ל-HALT), החוק מסרב.
  const st5 = stWith({ treasuryBal: 1_000_164, treasuryLock: 1_003_213 });
  t("T37-c V5a h151812 end-state measured: avail=−3,049, the law admits zero further charges", avail(st5, "treasury", "USDS") === -3_049 && chargeFree(st5, "treasury", "USDS", 1) === false && chargeFree(st5, "treasury", "USDS", 1_000_164) === false);
  const st5b = stWith({ treasuryBal: 1_100_000, treasuryLock: 1_003_213 }); // avail=96,787
  const oldPathProbe = (() => {
    const probe = stWith({ treasuryBal: 1_100_000, treasuryLock: 1_003_213 });
    probe.balances.treasury!.USDS = probe.balances.treasury!.USDS! - 1_000_164; // הבדיקה-הישנה: יתרה-גולמית ≥ amt → עובר
    return avail(probe, "treasury", "USDS") < 0;
  })();
  const ok5 = !chargeFree(st5b, "treasury", "USDS", 1_000_164);
  t("T37-c V5b raw-pass/law-refuse shape: old path invades to negative avail, chargeFree refuses", oldPathProbe === true && ok5 === true && avail(st5b, "treasury", "USDS") === 96_787 && lockedOf(st5b, "treasury", "USDS") === 1_003_213);
}

/* ══ T37-d · סרוו-עומק-הספר ═══════════════════════════════════════════════ */
{
  // ו-6: בדיקת-עומק-אמת — אסק-חי אחד על השוק-הריבוני = הספר-חי
  const alive = stWith({ orders: [WSTEEM_SELL] });
  const dead = stWith({ orders: [] });
  const bidOnly = stWith({ orders: [{ ...WSTEEM_SELL, side: "buy" as const }] });
  const otherBase = stWith({ orders: [{ ...WSTEEM_SELL, base: "SAOS" }] });
  const cancelled = stWith({ orders: [{ ...WSTEEM_SELL, live: false }] });
  t("T37-d V6 bookAskAlive measures the real state (live sell on USDS/WSTEEM)", bookAskAlive(alive) === true && bookAskAlive(dead) === false && bookAskAlive(bidOnly) === false && bookAskAlive(otherBase) === false && bookAskAlive(cancelled) === false);

  // ו-7: הרזרבה-אינה-סובסידיה — ספר-חי = אפס-זרימה-מהרזרבות
  const stLive = stWith({ orders: [WSTEEM_SELL], credits: { sweeper: 37_200, rail: 11_000, "bot-e": 9_860 } });
  t("T37-d V7 book alive → reserve afford is exactly 0 for all reserves", (RESERVE_FUNDERS as readonly string[]).every((f) => reserveFunderAfford(stLive, f as never) === 0));

  // ו-8: וקטור-המוות-המנעול (h155706) — ספר-מת + הרזרבות-המדודות:
  // sweeper 37,200−10,000=27,200 · rail 11,000−8,000=3,000 · bot-e 9,860−5,000=4,860
  const stDead = stWith({ orders: [], credits: { sweeper: 37_200, rail: 11_000, "bot-e": 9_860, treasury: 14, operator: 1_860 } });
  t("T37-d V8 h155706 deadlock shape: main ladder dead (14/1,860 < FUEL_ASK_MIN), reserves afford above their floors", stDead.credits.treasury! < FUEL_ASK_MIN && stDead.credits.operator! < FUEL_ASK_MIN && reserveFunderAfford(stDead, "sweeper") === 27_200 && reserveFunderAfford(stDead, "rail") === 3_000 && reserveFunderAfford(stDead, "bot-e") === 4_860);

  // ו-9: רצפות-מסלול — רזרבה-על-הרצפה-שלה = אפס; ושאינה-רזרבה = אפס-תמיד
  const stFloor = stWith({ orders: [], credits: { sweeper: 10_000, rail: 8_000, "bot-e": 5_000 } });
  t("T37-d V9 lane floors hold: at-floor reserve affords 0; non-reserve never affords", reserveFunderAfford(stFloor, "sweeper") === 0 && reserveFunderAfford(stFloor, "rail") === 0 && reserveFunderAfford(stFloor, "bot-e") === 0 && reserveFunderAfford(stDead, "treasury" as never) === 0 && reserveFunderAfford(stDead, "wash" as never) === 0);

  // ו-10: שער-ה-op — sweeper/rail/bot-e רשאים-להנפיק refuel; חייל לא
  const stOp = stWith({ orders: [], credits: { sweeper: 37_200, "soldier-1": 0, "soldier-2": 0 } });
  const r1 = applyOp(stOp, { type: "refuel", issuer: "sweeper", nonce: "r-1", to: "soldier-2", amount: 2_000 } as never, 0);
  const r2 = applyOp(stOp, { type: "refuel", issuer: "soldier-1", nonce: "r-2", to: "soldier-2", amount: 2_000 } as never, 0);
  const r3 = applyOp(stOp, { type: "refuel", issuer: "sweeper", nonce: "r-3", to: "soldier-1", amount: 200_000 } as never, 0); // מעל REFUEL_CAP
  const sumBefore = 37_200;
  const sumAfter = Object.values(stOp.credits).reduce((a, b) => a + b, 0);
  t("T37-d V10 refuel op: reserve funder admitted, soldier refused, REFUEL_CAP binds, Σcredits preserved", r1.ok === true && stOp.credits["soldier-2"] === 2_000 && r2.ok === false && r2.err === "funder-only" && r3.ok === false && r3.err === "refuel-exceeds-cap" && sumAfter === sumBefore);

  // ו-11: רצף-האמבולנס — מהמוות-המנעול אל-הספר-החי: הרזרבה זורמת, אסק-נולד, הרזרבה נחה
  // (ה-drill-תפס-את-הפגם-העצמי-הראשון: חייל-בלי-מלאי-WSTEEM — ההצבה-נדחית-escrow;
  // המלאי-הוא-תנאי-האסק, הגז-הוא-תנאי-ההצבה — שניהם-חייבים-לחיות)
  // חוק-הגז-הנוכחי (THE-REFUEL · df9e42b4 · מדידה-מלאה-מול-הקרנל-ב-2026-10-19):
  // refuel = אפס-גז (משפחת-הערוצים-הריבוניים relay/wrap/attest/heartbeat — המגן-הוא
  // מבני: FUEL_FUNDERS+REFUEL_CAP+reserveFunderAfford, לא-מחיר) → האסק-מקבל-את-הסכום
  // המלא 2,000µ מה-refuel (לא 1,940-שהיה-מקובל-תחת-גז-3%-ישן); אחר-כך הצבת-הפקודה
  // משלמת-גז-escrow-1µ (order: 1) → יתרה-סופית-מדודה = 1,999µ. הזרימה-חיה,
  // האינווריאנטה-נשמרת.
  const stFlow = stWith({ orders: [], credits: { sweeper: 37_200 } });
  addBal(stFlow, "soldier-1", "WSTEEM", 10_000); // מלאי-אסק-אמת לחייל
  const flow1 = reserveFunderAfford(stFlow, "sweeper");
  applyOp(stFlow, { type: "refuel", issuer: "sweeper", nonce: "f-1", to: "soldier-1", amount: 2_000 } as never, 0);
  applyOp(stFlow, { type: "order", issuer: "soldier-1", nonce: "o-1", base: "WSTEEM", quote: "USDS", side: "sell", price: 57, amount: 1_000 } as never, 0);
  const bookNowAlive = bookAskAlive(stFlow);
  const flow2 = reserveFunderAfford(stFlow, "sweeper");
  t("T37-d V11 ambulance lifecycle: flows while dead → book revives → reserve rests", flow1 === 27_200 && stFlow.credits["soldier-1"] === 1_999 && bookNowAlive === true && flow2 === 0);

  // ו-12: FUEL_FUNDERS — הרזרבות-בשער-המממנים (הטיפוס-עצמו)
  t("T37-d V12 FUEL_FUNDERS admits the standing reserves", (["sweeper", "rail", "bot-e"] as const).every((f) => (FUEL_FUNDERS as readonly string[]).includes(f)));
}

/* ══ רצפת-הברזל: האינווריאנטה-הקרנלית ═════════════════════════════════════ */
{
  // ו-13: Σcredits+gasUsed−feeMinted נשמר-במדויק לאורך-כל-הוקטורים-למעלה
  // (הג'נזיס-הסינתטי: 0-הטבעה; כל-ה-refuels טהורים)
  const st = stWith({ orders: [], credits: { sweeper: 37_200, "soldier-1": 0 } });
  applyOp(st, { type: "refuel", issuer: "sweeper", nonce: "i-1", to: "soldier-1", amount: 2_000 } as never, 0);
  const sum = Object.values(st.credits).reduce((a, b) => a + b, 0);
  t("T37 invariant Σcredits preserved through the ambulance path (zero minting)", sum === 37_200 && (st.feeMinted ?? 0) === 0);
}

console.log(`\nt37-laws-selftest: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
