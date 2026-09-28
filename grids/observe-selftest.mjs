// OBSERVE-SELFTEST — וקטורים דטרמיניסטיים אופליין לצופה-המילויים-אמת (A-9)
//   node grids/observe-selftest.mjs  → אפס-רשת, אפס-מפתחות, אפס-כתיבה-למדינה-החיה
// האמת-המרוקנת למטה היא שחזור של מילויים-אמת שאירעו 2026-09-28 (coin-raffle
// חצה את הספר מול סולם-הפאריטי שלנו) — ערכי-היחידות מה-chain, בלי-כתובות-זהות.

import { parseFills, applyRealFills } from "./observe.mjs";

const NAI_STEEM = "@@000000021";
const NAI_SBD = "@@000000013";
const asset = (value, nai) => ({ amount: String(Math.round(value * 1000)), nai, precision: 3 });

const t = (name, ok) => {
  console.log(`${ok ? " ✓" : " ✗"} ${name}`);
  if (!ok) process.exitCode = 1;
};

/* עזר: רשומת-history כמו שה-chain מחזיר */
const hist = (seq, ts, type, value) => [seq, { op: { type, value }, timestamp: ts }];

/* ── וקטורים ────────────────────────────────────────────────────────────── */
/* ערכי-האמת: כל-5 המילויים-החיים של 2026-09-28 היו אסקים (מכרנו STEEM ל-coin-raffle,
 * סה"כ 28.393 STEEM → +3.033 SBD, כולם ברצועת-הפאריטי). וקטור-2 מנוסח כביד-אמת:
 * אנחנו open_owner שמשלם SBD — הצד-השני משלם STEEM. */
const HISTORY = [
  // 1. מילוי-אסק: אנחנו current_owner — שילמנו 11.902 STEEM, קיבלנו 1.271 SBD (אמת-מה-chain)
  hist(100, "2026-09-28T13:03:15", "fill_order_operation", {
    current_owner: "headcorner", current_pays: asset(11.902, NAI_STEEM),
    open_owner: "coin-raffle", open_pays: asset(1.271, NAI_SBD),
  }),
  // 2. מילוי-ביד: אנחנו open_owner — שילמנו 0.680 SBD, קיבלנו 6.387 STEEM (מבנה-ביד)
  hist(101, "2026-09-28T13:03:54", "fill_order_operation", {
    current_owner: "coin-raffle", current_pays: asset(6.387, NAI_STEEM),
    open_owner: "headcorner", open_pays: asset(0.680, NAI_SBD),
  }),
  // 3. מילוי של אחרים — נתעלם
  hist(102, "2026-09-28T13:04:00", "fill_order_operation", {
    current_owner: "someone-else", current_pays: asset(5, NAI_STEEM),
    open_owner: "coin-raffle", open_pays: asset(0.5, NAI_SBD),
  }),
  // 4. זוג-לא-צפוי (STEEM/STEEM) — מדלגים כנה
  hist(103, "2026-09-28T13:05:00", "fill_order_operation", {
    current_owner: "headcorner", current_pays: asset(1, NAI_STEEM),
    open_owner: "coin-raffle", open_pays: asset(1, NAI_STEEM),
  }),
  // 5. אופ-לא-מילוי — מתעלמים
  hist(104, "2026-09-28T13:06:00", "vote_operation", { voter: "headcorner", weight: 0 }),
  // 6. מילוי-אסק נוסף לבדיקת-מיון ודלתא-SBD
  hist(105, "2026-09-28T13:07:00", "fill_order_operation", {
    current_owner: "headcorner", current_pays: asset(8.710, NAI_STEEM),
    open_owner: "coin-raffle", open_pays: asset(0.935, NAI_SBD),
  }),
];

let fails = 0;
const v = (name, ok) => { t(name, ok); if (!ok) fails++; };

/* 1. חילוץ בסיסי: רק המילויים-שלנו, ממוינים לפי-seq */
const r1 = parseFills(HISTORY, "headcorner", -1);
v("3 own fills extracted (others/unknown-pair/ops ignored)", r1.fills.length === 3);
v("sorted by seq", r1.fills.map((f) => f.seq).join(",") === "100,101,105");
v("lastSeq = max history seq", r1.lastSeq === 105);

/* 2. צדדים וכיוונים */
v("fill#100 = ask (we paid STEEM)", r1.fills[0].side === "ask" && r1.fills[0].steem === 11.902 && r1.fills[0].sbd === 1.271);
v("fill#101 = bid (we paid SBD, got STEEM)", r1.fills[1].side === "bid" && r1.fills[1].steem === 6.387 && r1.fills[1].sbd === 0.680);
v("counterparty resolved on both sides", r1.fills[0].counterparty === "coin-raffle" && r1.fills[1].counterparty === "coin-raffle");
v("rate = sbd/steem (ask 0.10679…)", Math.abs(r1.fills[0].rate - 1.271 / 11.902) < 1e-7);

/* 3. דדופ: sinceSeq מונע ספירה-כפולה */
const r2 = parseFills(HISTORY, "headcorner", 105);
v("dedup: sinceSeq=105 → zero refills", r2.fills.length === 0);
const r3 = parseFills(HISTORY, "headcorner", 100);
v("dedup partial: sinceSeq=100 → 2 fills", r3.fills.length === 2 && r3.fills[0].seq === 101);

/* 4. מיזוג-מדינה: מד-אמת מתעדכן נכון */
const state = { feeMeter: { simMu: 5, simFills: 3 } };
const app = applyRealFills(state, r1);
v("applyRealFills: 3 events emitted", app.added === 3 && app.newEvents.length === 3);
v("real events flagged real:true (not sim)", app.newEvents.every((e) => e.real === true && e.sim === undefined));
v("realFills = 3", state.feeMeter.realFills === 3);
const expectedDelta = Math.round(((1.271 + 0.935) - 0.680) * 1e6) / 1e6;
v("realSbdDelta = asks-in minus bids-out", Math.abs(state.feeMeter.realSbdDelta - expectedDelta) < 1e-9);
v("_lastRealSeq persisted = 105", state.feeMeter._lastRealSeq === 105);

/* 5. מיזוג ריק — אפס-תופעות-לוואי */
const state2 = { feeMeter: { realFills: 7 } };
const app2 = applyRealFills(state2, parseFills(HISTORY, "headcorner", 105));
v("applyRealFills empty: no events, meter untouched", app2.added === 0 && state2.feeMeter.realFills === 7);

/* 6. היסטוריה-ריקה */
const r4 = parseFills([], "headcorner", -1);
v("empty history → zero fills, lastSeq stays -1", r4.fills.length === 0 && r4.lastSeq === -1);

/* 7. הערכים-האמת-מהשרשרת 2026-09-28 (מילוי #100): rate ≈ 0.1068 SBD/STEEM */
v("chain-truth rate in parity band [0.105,0.108]", r1.fills[0].rate > 0.105 && r1.fills[0].rate < 0.108);

console.log(process.exitCode === 1 ? "OBSERVE-SELFTEST: FAIL" : "OBSERVE-SELFTEST: PASS");
