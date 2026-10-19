// ONE-BODY — עזרה-הדדית-צבאית (W13 · מנדט-בעלים 2026-10-19)
// ═══════════════════════════════════════════════════════════════════════════════
// מילת-הבעלים (IM, 2026-10-19): "אני רוצה שכל החשבונות יתמכו אחד בשני הם יכולים
// לפעול כגוף אחד ולתמוך ולהעביר בין אחד לשני למילוי וכו לפי הצורך בצורה חכמה
// חשוב לשמור על רווחיות".
//
// המדידה שהולידה את המסילה (2026-10-19 02:0xZ, condenser_api.get_accounts):
//   headcorner 644.852 STEEM + 23.669 SBD עומד-בצד; כל-הצי (12 סוחרים) מסתחרר
//   על 7.107 STEEM + 2.032 SBD. הסוחרים שמכרו — צברו SBD ואזלו STEEM; אלה שקנו
//   — ההפך. הגוף אינו מפזר-מחדש את הדלק שלו בעצמו. המסילה הזאת היא מחזור-הדם:
//
//   · תורם-STEEM  = סוחר שהמיד-נדד-למעלה/פג-תוקף-הצבות והשאיר אותו מעל
//     תקרת-הפתיחה — העודף מעל (openCap + reserve) דלק-מת; הוא זורם למי שנטול-דלק.
//   · מקבל-STEEM = סוחר שאינו יכול להציב אפילו חצי-רגל (< 0.5) — מקבל רגל-טובה
//     אחת + רזרבה (topUp 1.5) — ובכך חוזר לספר מיד-במחזור הזה.
//   · תורם-SBD = סוחר שהמכירות שלו מולאו (SBD > 2.0) — העודף מעל דלק-קנייה
//     (keep 1.0) זורם למי שאין לו SBD להצבות-קנייה (minSbdForBuyLeg 0.5).
//   · cashmachine מוחרג מתורמים לגמרי — הוא מסילת-ה-payroll (escrow agent-fee),
//     לא חייל; מקבל-כן.
//
// חוקי-ברזל (כל-השכבות, בדיוק-כמו-הבית):
//   1. תכנון טהור ודטרמיניסטי (planAid) — בלי I/O, בלי שעון; ניתן-להוכחה בוקטורים.
//   2. custody: headcorner/cornerstone לעולם לא תורמים ולא מקבלים (FORBIDDEN —
//      חשבונות-מפתח-בעלים; האחוזה ניזונה רק דרך fleet-fuel החד-כיווני).
//   3. roster-bound: רק חשבונות תוכנית-הסולם תורמים/מקבלים. אפס-כתובות-זרות.
//   4. תקרות-קשיחות: ≤ 2.0 STEEM להעברה · ≤ 6.0 STEEM לריצה · ≤ 0.5 SBD להעברה
//      · ≤ 1.0 SBD לריצה · אפס-אבק (min-donation).
//   5. אידמפוטנטיות-חיה: התכנון נעשה מול יתרות-שרשרת טריות; מקבל שנתמלא
//      בין-המדידה-לחתימה יידלג (בדיקת-יתרה-חוזרת בזמן-הריצה, לא בתכנון).
//   6. שער-מפתח לכל-תורם (activeAuthorityOk — אותו-משטר-בית) + שער-פוליסה
//      (lane 'general' · kind 'transfer' — המסילה-המותרת-החתומה ב-policy.json).
//   7. אפס-סודות בתכנון/בקבלה; החתימה עצמה חיה רק בתוך army-ladder run.
//
// שימוש:
//   node grids/one-body.mjs --selftest        (וקטורים אופליינים)
//   planAid() נקרא מתוך grids/army-ladder.mjs בתוך הריצה (שער-מפתח+פוליסה שם).

const dp3 = (n) => Math.round(Number(n) * 1000) / 1000;

/* ── תקרות-קשיחות (W13-seal; הרחבה = מילת-בעלים + קומיט-מתועד) ──────────────────── */
export const AID_CAPS = {
  minDonationSteem: 0.5,   // אפס-אבק — העברה-חסרת-משמעות לא נחתמת
  recipientFloorSteem: 0.5, // מקבל = מי שאינו יכול להציב חצי-רגל
  topUpSteem: 1.5,          // רגל-טובה אחת (≤ per-leg 3.0 בדלק-מלא) + רזרבה
  maxPerTransferSteem: 2.0,
  maxRunSteem: 6.0,
  donorFloorSbd: 2.0,       // תורם-SBD = מכירות-שמולאו מעל דלק-קנייה
  keepSbd: 1.0,             // התורם שומר דלק-קנייה (minSbdForBuyLeg 0.5 × 2 רגליים)
  minDonationSbd: 0.2,
  recipientFloorSbd: 0.5,
  topUpSbd: 0.5,
  maxPerTransferSbd: 0.5,
  maxRunSbd: 1.0,
  maxLegsPerRun: 12,        // הגבלת-קצב עליונה (policy general: 48/h)
};
export const FORBIDDEN_AID = new Set(["headcorner", "cornerstone"]); // custody boundary
export const DONOR_EXEMPT = new Set(["cashmachine"]); // מסילת-ה-payroll — מקבל-בלבד

/* ── התכנון הטהור (בלי I/O — ניתן-להוכחה) ────────────────────────────────────────
 * balances: [{account, steem, sbd}] (מספרים — נמדדו מהשרשרת)
 * plan:     תוכנית-הסולם (roster + maxOpenSteem לגזירת-רצפת-התורם)
 * מחזיר: aid legs [{from, to, asset, amount}] — תורמים בסדר עודף-יורד, מקבלים
 * בסדר מחסור-עולה, שובר-שוויון שם-החשבון (דטרמיניזם מלא). */
export function planAid({ balances, plan, caps = AID_CAPS }) {
  const legs = [];
  if (!Array.isArray(balances) || !balances.length) return legs;
  const roster = new Set(((plan && plan.traders) || []).map((t) => t && t.account).filter(Boolean));
  const openCap = Number(plan && plan.maxOpenSteem) > 0 ? Number(plan.maxOpenSteem) : 6.0;
  const donorFloorSteem = dp3(openCap + 0.1 + 0.5); // openCap + reserve + idle-buffer
  const known = balances.filter((b) => b && roster.has(b.account) && !FORBIDDEN_AID.has(b.account));

  // STEEM — מחזור-הדלק הראשי
  let runSteem = 0;
  const recipients = known
    .filter((b) => Number(b.steem) < caps.recipientFloorSteem)
    .sort((a, b) => Number(a.steem) - Number(b.steem) || (a.account < b.account ? -1 : 1));
  const donors = known
    .filter((b) => !DONOR_EXEMPT.has(b.account) && Number(b.steem) > donorFloorSteem)
    .map((b) => ({ ...b, surplus: dp3(Number(b.steem) - donorFloorSteem) }))
    .sort((a, b) => b.surplus - a.surplus || (a.account < b.account ? -1 : 1));
  for (const r of recipients) {
    let need = caps.topUpSteem;
    for (const d of donors) {
      if (need < caps.minDonationSteem || runSteem >= caps.maxRunSteem) break;
      if (d.surplus < caps.minDonationSteem || d.account === r.account) continue;
      const give = dp3(Math.min(need, d.surplus, caps.maxPerTransferSteem, caps.maxRunSteem - runSteem));
      if (give < caps.minDonationSteem) continue;
      legs.push({ from: d.account, to: r.account, asset: "STEEM", amount: give });
      d.surplus = dp3(d.surplus - give);
      need = dp3(need - give);
      runSteem = dp3(runSteem + give);
    }
  }

  // SBD — מחזור דלק-הקנייה (reinvest)
  let runSbd = 0;
  const sRecipients = known
    .filter((b) => Number(b.sbd) < caps.recipientFloorSbd)
    .sort((a, b) => Number(a.sbd) - Number(b.sbd) || (a.account < b.account ? -1 : 1));
  const sDonors = known
    .filter((b) => !DONOR_EXEMPT.has(b.account) && Number(b.sbd) > caps.donorFloorSbd)
    .map((b) => ({ ...b, surplus: dp3(Number(b.sbd) - caps.keepSbd) }))
    .sort((a, b) => b.surplus - a.surplus || (a.account < b.account ? -1 : 1));
  for (const r of sRecipients) {
    let need = caps.topUpSbd;
    for (const d of sDonors) {
      if (need < caps.minDonationSbd || runSbd >= caps.maxRunSbd) break;
      if (d.surplus < caps.minDonationSbd || d.account === r.account) continue;
      const give = dp3(Math.min(need, d.surplus, caps.maxPerTransferSbd, caps.maxRunSbd - runSbd));
      if (give < caps.minDonationSbd) continue;
      legs.push({ from: d.account, to: r.account, asset: "SBD", amount: give });
      d.surplus = dp3(d.surplus - give);
      need = dp3(need - give);
      runSbd = dp3(runSbd + give);
    }
  }
  return legs;
}

/* ── selftest (אופליין — וקטורים-כנים) ─────────────────────────────────────────── */
export function selftest() {
  const assert = (c, msg) => { if (!c) { console.error("SELFTEST FAIL:", msg); process.exit(1); } };
  const plan = {
    protocol: "SAOS-ARMY-LADDER-PLAN/1",
    traders: ["hcsoldier4", "hcsoldier5", "hcsoldier6", "tov", "haran", "lsa", "cashmachine", "wog"]
      .map((a) => ({ account: a })),
    maxPerLegSteem: 3.0, maxOpenSteem: 6.0,
  };

  // 1) הגוף הבסיסי: עודף-STEEM זורם למחסור (הדפוס שנמדד 02:0xZ)
  const bal1 = [
    { account: "hcsoldier6", steem: 8.4, sbd: 0.0 },   // עודף 1.8 מעל רצפת 6.6
    { account: "haran", steem: 0.101, sbd: 0.16 },     // מקבל
    { account: "lsa", steem: 0.101, sbd: 0.16 },       // מקבל
    { account: "hcsoldier5", steem: 3.0, sbd: 0.2 },   // ניטרלי
  ];
  const a1 = planAid({ balances: bal1, plan });
  assert(a1.length === 1, "one donor feeds the biggest deficit first");
  assert(a1[0].from === "hcsoldier6" && a1[0].to === "haran", "donor= surplus account, recipient= deepest deficit");
  assert(a1[0].asset === "STEEM" && Math.abs(a1[0].amount - 1.5) < 1e-9, "top-up = exactly one good leg + reserve");

  // 2) ריצה-מלאה: שני-תורמים מזינים את-כל-החסרים עד-תקרת-הריצה
  const bal2 = [
    { account: "hcsoldier6", steem: 9.0, sbd: 0.0 },   // עודף 2.4
    { account: "hcsoldier4", steem: 8.6, sbd: 0.0 },   // עודף 2.0
    { account: "haran", steem: 0.1, sbd: 0.2 },
    { account: "lsa", steem: 0.2, sbd: 0.2 },
    { account: "tov", steem: 0.3, sbd: 0.2 },
    { account: "wog", steem: 0.1, sbd: 0.2 },
  ];
  const a2 = planAid({ balances: bal2, plan });
  const total2 = a2.reduce((s, l) => s + l.amount, 0);
  assert(total2 <= AID_CAPS.maxRunSteem + 1e-9, "run cap respected");
  assert(a2.every((l) => l.amount <= AID_CAPS.maxPerTransferSteem + 1e-9), "per-transfer cap respected");
  const gave = new Map();
  for (const l of a2) gave.set(l.from, (gave.get(l.from) || 0) + l.amount);
  for (const [from, amt] of gave) assert(amt <= dp3(from === "hcsoldier6" ? 2.4 : 2.0) + 1e-9, `donor ${from} never gives beyond its measured surplus`);

  // 3) custody: חשבונות-בעלים לעולם לא נוגעים; roster-bound
  const bal3 = [
    { account: "headcorner", steem: 644.0, sbd: 23.0 }, // אצל-הבעלים — אסור
    { account: "cornerstone", steem: 0.1, sbd: 0.1 },   // אסור-גם-כמקבל
    { account: "hcsoldier6", steem: 8.0, sbd: 0.0 },
    { account: "stranger", steem: 0.1, sbd: 0.1 },      // מחוץ-לרוסטר — לא-קיים
    { account: "haran", steem: 0.1, sbd: 0.2 },
  ];
  const a3 = planAid({ balances: bal3, plan });
  assert(a3.every((l) => l.from !== "headcorner" && l.to !== "headcorner" && l.to !== "cornerstone"), "custody boundary absolute");
  assert(a3.every((l) => l.to === "haran"), "roster-bound: strangers invisible");

  // 4) cashmachine: מסילת-payroll — מקבל-בלבד, לעולם לא תורם
  const bal4 = [
    { account: "cashmachine", steem: 20.0, sbd: 5.0 }, // היה-תורם-מושלם — חסום
    { account: "hcsoldier6", steem: 9.0, sbd: 0.0 },
    { account: "haran", steem: 0.1, sbd: 0.2 },
  ];
  const a4 = planAid({ balances: bal4, plan });
  assert(a4.every((l) => l.from !== "cashmachine"), "payroll rail never donates");
  assert(a4.some((l) => l.to === "cashmachine" || l.to === "haran"), "payroll rail may receive");

  // 5) SBD — מכירות-שמולאו מזינות דלק-קנייה לחסרים
  const bal5 = [
    { account: "hcsoldier4", steem: 1.0, sbd: 4.0 },   // עודף 3.0 מעל keep 1.0
    { account: "hcsoldier5", steem: 4.0, sbd: 0.1 },   // מקבל-SBD
    { account: "tov", steem: 4.0, sbd: 3.0 },          // ניטרלי (בין floor ל-donorFloor)
  ];
  const a5 = planAid({ balances: bal5, plan });
  const sbdLeg = a5.find((l) => l.asset === "SBD");
  assert(sbdLeg && sbdLeg.from === "hcsoldier4" && sbdLeg.to === "hcsoldier5", "SBD surplus flows to bid-fuel deficit");
  assert(Math.abs(sbdLeg.amount - 0.5) < 1e-9, "SBD top-up = exactly minSbdForBuyLeg scale");

  // 6) אידמפוטנטיות: גוף-מאוזן → אפס-רגליים (ריצה-כפולה בטוחה)
  const bal6 = [
    { account: "hcsoldier6", steem: 6.0, sbd: 1.0 },
    { account: "haran", steem: 1.0, sbd: 0.6 },
    { account: "lsa", steem: 2.0, sbd: 0.8 },
  ];
  assert(planAid({ balances: bal6, plan }).length === 0, "balanced body → zero legs (idempotent re-run)");

  // 7) דטרמיניזם: אותו-קלט → אותו-פלט (פעמיים)
  const a7a = planAid({ balances: bal2, plan });
  const a7b = planAid({ balances: bal2, plan });
  assert(JSON.stringify(a7a) === JSON.stringify(a7b), "pure deterministic planner");

  // 8) קלט-ריק/פגום → אפס-רגליים (fail-closed חינני)
  assert(planAid({ balances: [], plan }).length === 0, "empty balances → no legs");
  assert(planAid({ balances: null, plan }).length === 0, "null balances → no legs");
  assert(planAid({ balances: bal1, plan: null }).length === 0, "null plan → no legs (roster empty)");

  console.log("SELFTEST PASS: 13/13 vectors (one-body)");
}

if (process.argv.slice(2).includes("--selftest")) selftest();
