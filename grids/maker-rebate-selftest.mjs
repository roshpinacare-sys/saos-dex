// MAKER-REBATE-SELFTEST — ביקורת-הברזל של פנקס-הריבייטים (SAOS-MAKER-REBATE/1)
// ═══════════════════════════════════════════════════════════════════════════════════════════
// כלל-הזהב: אפס-מילויים → אפס · צבירה מונוטונית · Σריבייט ≤ Σחית-האוצר בכל-רגל ובסך-הכל ·
// קלט-רע = fail-closed (חלון/תצורה) או fail-honest (רשומה) · דטרמיניזם ביט-ביט · שלמים-בלבד.
// ריצה: node grids/maker-rebate-selftest.mjs   (exit 0 = PASS)
import { computeRebates, validateConfig, normalizeFill, maxRebateBps, monotoneCheck, PROTOCOL } from "./maker-rebate.mjs";

let failed = 0, passed = 0;
const t = (name, cond) => {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}`); failed++; }
};

const fill = (maker, price, amountMu) => ({ kind: "fill", maker, price, amountMu, taker: "taker-x", at: 0 });

console.log("maker-rebate-selftest:");

/* 1) אפס-מילויים → אפס-כנה (לא שקר, לא קריסה) */
const z = computeRebates([]);
t("zero fills → ok:true, perMaker empty", z.ok === true && z.perMaker.length === 0);
t("zero fills → all totals exactly 0", z.totals.notionalMu === 0 && z.totals.feeMu === 0 && z.totals.treasuryCutMu === 0 && z.totals.rebateMu === 0 && z.totals.treasuryKeepsMu === 0);
t("protocol stamped", z.protocol === PROTOCOL && z.protocol === "SAOS-MAKER-REBATE/1");

/* 2) חוק-האריתמטיקה של-הקרנל — מספרים-ידניים מדויקים (kernel notional + 30bps + 30% cut) */
const one = computeRebates([fill("mm-1", 1000, 1_000_000)]);
const om = one.perMaker[0];
t("notional = floor(price×amountMu/1000) = 1,000,000µ", om.notionalMu === 1_000_000);
t("fee 30bps = 3,000µ · treasury cut 30% = 900µ", om.feeMu === 3_000 && om.treasuryCutMu === 900);
t("rebate 5bps = 500µ ≤ cut · treasury keeps 400µ", om.rebateMu === 500 && one.totals.treasuryKeepsMu === 400);

/* 3) חוק-התקציב בכל-רגל: בתקרה-החוקית (9bps) הריבייט == החית — ולעולם לא מעליה */
const capL = computeRebates([fill("mm-1", 1000, 1_000_000)], { rebateBps: 9 });
t("max lawful rebate = floor(30×30/100) = 9bps", maxRebateBps(30, 30) === 9);
t("at cap: rebate === treasury cut exactly (900µ), keeps 0", capL.perMaker[0].rebateMu === 900 && capL.totals.rebateMu === capL.totals.treasuryCutMu && capL.totals.treasuryKeepsMu === 0);

/* 4) fail-closed על תצורה — כל-חריגה מחוק-החית חוסמת את הפנקס כולו */
t("rebateBps above cap (10>9) → ok:false", computeRebates([fill("mm-1", 1000, 1e6)], { rebateBps: 10 }).ok === false);
t("non-integer rebateBps (5.5) → ok:false", computeRebates([], { rebateBps: 5.5 }).ok === false);
t("treasuryCutPct=101 → ok:false", computeRebates([], { treasuryCutPct: 101 }).ok === false);
t("treasuryCutPct=-1 → ok:false", computeRebates([], { treasuryCutPct: -1 }).ok === false);
t("feeBps=-30 → ok:false", computeRebates([], { feeBps: -30 }).ok === false);
t("feeBps=30001 → ok:false", computeRebates([], { feeBps: 30001 }).ok === false);
t("feeBps=0 with default rebate>0 → ok:false (no fee, no budget)", computeRebates([], { feeBps: 0 }).ok === false);
t("feeBps=0 with rebateBps=0 → ok:true, all-zero honest", (() => { const r = computeRebates([fill("mm-1", 1000, 1e6)], { feeBps: 0, rebateBps: 0 }); return r.ok === true && r.totals.rebateMu === 0 && r.window.credited === 1; })());
t("validateConfig default config passes", validateConfig({}).ok === true && validateConfig({}).config.maxRebateBps === 9);

/* 5) fail-closed על חלון */
t("null window → ok:false", computeRebates(null).ok === false);
t("string window → ok:false", computeRebates("x").ok === false);
t("{fills:'no'} → ok:false", computeRebates({ fills: "no" }).ok === false);

/* 6) fail-honest על רשומות — רע-בודד מדולג ונמדד, לעולם לא מייצר כסף */
const badRows = computeRebates([null, 3, "x", {}, { maker: "", price: 10, amountMu: 1e6 }, { maker: "mm 1", price: 10, amountMu: 1e6 }, { maker: "mm-1", price: -5, amountMu: 100 }, { maker: "mm-1", price: NaN, amountMu: 100 }, { maker: "mm-1", price: 2_000_000_000, amountMu: 5_000_000_000 }, { maker: "mm-1", price: 7, amountMu: 100 }]);
t("10 bad rows → window stays ok:true (fail-honest)", badRows.ok === true && badRows.window.credited === 0 && badRows.window.skipped === 10);
t("skip reasons tallied exactly (malformed/no-attribution/bad-maker/bad-notional/overflow/dust)", badRows.window.reasons["malformed"] === 3 && badRows.window.reasons["no-attribution"] === 2 && badRows.window.reasons["bad-maker"] === 1 && badRows.window.reasons["bad-notional"] === 2 && badRows.window.reasons["overflow"] === 1 && badRows.window.reasons["dust-notional"] === 1);
t("overflow guard: price×amountMu beyond 2^53 skipped, never fabricated", normalizeFill({ maker: "m", price: 2_000_000_000, amountMu: 5_000_000_000 }).skip === "overflow");

/* 7) צבירה מונוטונית + אדיטיביות-שלמים על חלונות דיסקרטיים */
const A = computeRebates([fill("mm-1", 1000, 1_000_000), fill("mm-1", 2000, 1_000_000)]);
const B = computeRebates([fill("mm-1", 1000, 500_000), fill("mm-2", 1000, 2_000_000)]);
const U = computeRebates([fill("mm-1", 1000, 1_000_000), fill("mm-1", 2000, 1_000_000), fill("mm-1", 1000, 500_000), fill("mm-2", 1000, 2_000_000)]);
const mm1A = A.perMaker.find((r) => r.maker === "mm-1"), mm1U = U.perMaker.find((r) => r.maker === "mm-1");
t("monotonic: mm-1 accrual grows with window (1500µ → 1750µ), fills 2 → 3", mm1A.rebateMu === 1500 && mm1U.rebateMu === 1750 && mm1U.fills === 3 && mm1U.rebateMu > mm1A.rebateMu);
t("monotoneCheck: union additive in integers, no maker decreased", monotoneCheck(A, B, U) === true);
t("monotoneCheck refuses broken ledgers", monotoneCheck(A, B, { ...U, ok: false }) === false && monotoneCheck(A, B, { ...U, totals: { ...U.totals, rebateMu: U.totals.rebateMu - 1 } }) === false);
t("union budget holds: Σrebate(2750) ≤ Σcut(4950), treasury keeps 2200", U.totals.rebateMu === 2750 && U.totals.treasuryCutMu === 4950 && U.totals.treasuryKeepsMu === 2200);

/* 8) סדר-קנוני + דטרמיניזם ביט-בית */
const reversed = computeRebates([fill("mm-2", 1000, 2_000_000), fill("mm-1", 1000, 1_000_000)]);
t("perMaker sorted canonically by maker (insertion order irrelevant)", reversed.perMaker.length === 2 && reversed.perMaker[0].maker === "mm-1" && reversed.perMaker[1].maker === "mm-2");
const d1 = JSON.stringify(computeRebates([fill("mm-1", 1234, 987_654), fill("mm-3", 500, 2_000_000), fill("mm-2", 800, 1_000_000)]));
const d2 = JSON.stringify(computeRebates([fill("mm-1", 1234, 987_654), fill("mm-3", 500, 2_000_000), fill("mm-2", 800, 1_000_000)]));
t("determinism bit-for-bit (two runs → identical JSON)", d1 === d2);

/* 9) חוק-השלמים: כל-ערך-µ בפנקס הוא safe-integer */
const allInts = (l) => [l.totals.notionalMu, l.totals.feeMu, l.totals.treasuryCutMu, l.totals.rebateMu, l.totals.treasuryKeepsMu, ...l.perMaker.flatMap((r) => [r.fills, r.notionalMu, r.feeMu, r.treasuryCutMu, r.rebateMu])].every(Number.isSafeInteger);
t("every µ field in the ledger is a safe integer", allInts(U) && allInts(capL));

/* 10) מילויי-ספר-STEEM הציבורי (observe.mjs) — ייחוס לפי role, בלי-role = אין-זכאי */
const obs = computeRebates([
  { seq: 100, at: "2026-10-29T00:00:00Z", side: "ask", steem: 11.902, sbd: 1.271, rate: 0.1068, counterparty: "coin-raffle", role: "maker", account: "headcorner" },
  { seq: 101, side: "bid", steem: 6.387, sbd: 0.680, counterparty: "cashly", role: "taker" },
  { seq: 102, side: "ask", steem: 3.0, sbd: 0.3, counterparty: "wick", },
]);
const obMm = obs.perMaker.find((r) => r.maker === "headcorner");
t("observe maker fill credited: notional=round(1.271×1000)=1271µ, fee=3µ, cut=0, rebate=0 (honest small-tick zero)", !!obMm && obMm.notionalMu === 1271 && obMm.feeMu === 3 && obMm.treasuryCutMu === 0 && obMm.rebateMu === 0);
t("observe taker fill → counterparty credited as maker (they rested)", obs.perMaker.some((r) => r.maker === "cashly" && r.notionalMu === 680));
t("observe fill without role → skipped no-attribution (fail-honest)", obs.window.credited === 2 && obs.window.reasons["no-attribution"] === 1);
t("zero-fee STEEM book: feeBps=0+rebateBps=0 → credited but zero budget (law, not bug)", computeRebates([{ seq: 1, side: "ask", steem: 5, sbd: 0.5, counterparty: "x", role: "maker", account: "headcorner" }], { feeBps: 0, rebateBps: 0 }).totals.rebateMu === 0);

/* 11) עטיפה: {fills:[...]} — אותה-צורה של קוראי-state */
const wrapped = computeRebates({ fills: [fill("mm-9", 1000, 1_000_000)] });
t("wrapped window shape accepted", wrapped.ok === true && wrapped.window.credited === 1 && wrapped.totals.rebateMu === 500);

if (failed) { console.error(`maker-rebate-selftest: FAILED (${failed})`); process.exit(1); }
console.log(`maker-rebate-selftest: PASS (${passed} laws)`);
