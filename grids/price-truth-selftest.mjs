// PRICE-TRUTH-SELFTEST — N8 · בטריית-החוקים הטהורים (round-27 · העולם-המדוד-13:49Z)
import {
  PRICE_TRUTH_PROTOCOL, sbdPerSteemFromMedianFeed, derivePriceTruth,
} from "./price-truth.mjs";

let n = 0;
const ok = (cond, msg) => { n++; if (!cond) { console.error(`FAIL(${n}): ${msg}`); process.exit(1); } };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

/* ── ניתוח-ה-feed-הרפואי ── */
const med = sbdPerSteemFromMedianFeed({ base: "58412723.670 SBD", quote: "561224995.101 STEEM" });
ok(med != null && near(med, 0.1040807, 1e-6), `median feed parses to 0.104081 (got ${med})`);
ok(sbdPerSteemFromMedianFeed(null) === null, "null median → null");
ok(sbdPerSteemFromMedianFeed({ base: "1 USD", quote: "1 STEEM" }) === null, "wrong units refused (no guessing)");
ok(sbdPerSteemFromMedianFeed({ base: "0 SBD", quote: "1 STEEM" }) === null, "zero base refused");

/* ── המשולש-המדוד-האמיתי (binance 0.0527 · sbdUsd 0.501 מהפנקס-שלנו · feed 0.10408) ── */
const tri = derivePriceTruth({
  chainFeedSbdPerSteem: 0.10408, globalSteemUsd: 0.0527, globalSbdUsd: 0.501,
  src: { steem: "binance", sbd: "coingecko" },
});
ok(tri.verdict === "TRIANGLE-ARMED", `triangle verdict (got ${tri.verdict})`);
ok(near(tri.marks.usdParitySbdPerSteem, 0.10519, 1e-4), `usdParity = 0.0527/0.501 = 0.10519 (got ${tri.marks.usdParitySbdPerSteem})`);
ok(near(tri.valueLineSbdPerSteem, 0.10408), `valueLine = min(feed 0.10408, usdParity 0.10519) = 0.10408 (got ${tri.valueLineSbdPerSteem})`);
ok(tri.bandRefSbdPerSteem === 0.10408, "band ref = chainFeed (apples-to-apples)");
/* דה-פג-SBD-מפורסם: implied = 0.0527/0.10408 = 0.5063 · measured 0.501 → ~−107bps (עקבי) */
ok(tri.marks.impliedSbdUsdFromFeed != null && near(tri.marks.impliedSbdUsdFromFeed, 0.5063, 1e-3), `implied sbdUsd published (got ${tri.marks.impliedSbdUsdFromFeed})`);
ok(tri.marks.sbdDepegBps != null && Math.abs(tri.marks.sbdDepegBps) < 1000, `depeg coherent (got ${tri.marks.sbdDepegBps}bps)`);
ok(tri.notes.length === 0, `no dispute note when authorities agree (got ${JSON.stringify(tri.notes)})`);

/* ── החוק-המכריע (העולם-המדוד): ──
 * מגע 0.1028 < valueLine 0.10408 → אסקי-מגע תת-ערך נשארים אסורים (דימום-אמת ב-USD:
 * 0.1028 SBD × $0.501 = $0.0515 מול STEEM $0.0527 = −230bps). מדף-האסקים החוקי
 * = valueLine+TIER. והמנוע-החוקי-למילויי-חוץ = בידים במגע: 0.1026 < 0.10408 = עודף-נמדד. */
ok(0.1028 < tri.valueLineSbdPerSteem, "touch ask (0.1028) is BELOW the value line — value-guard correctly refuses sub-value sells");
ok(0.10408 * 1.006 > 0.1047, "ask shelf rests at valueLine+TIER (fills on rally, never bleeds)");
ok(0.1026 <= tri.valueLineSbdPerSteem, "touch bid (0.1026) clears the bid ceiling — +175bps measured surplus, the legal external-fill engine");

/* ── דה-פג-עמוק (SBD=$0.10) — מחלוקת-סמכויות-מדודה-בגלוי, הקו-נשאר-מינימלי ── */
const deep = derivePriceTruth({ chainFeedSbdPerSteem: 0.10408, globalSteemUsd: 0.0527, globalSbdUsd: 0.10 });
ok(deep.marks.sbdDepegBps != null && Math.abs(deep.marks.sbdDepegBps) > 1000, "deep depeg measured");
ok(deep.notes.some((x) => x.includes("sbd-depeg-dispute")), "deep depeg flagged openly");
ok(near(deep.valueLineSbdPerSteem, 0.10408), `deep depeg → usdParity 0.527 > feed → line stays 0.10408 (got ${deep.valueLineSbdPerSteem})`);

/* ── נפילות-כנות ── */
const chainOnly = derivePriceTruth({ chainFeedSbdPerSteem: 0.104, globalSteemUsd: null, globalSbdUsd: null });
ok(chainOnly.verdict === "CHAIN-ONLY" && near(chainOnly.valueLineSbdPerSteem, 0.104), "chain-only → line=chain, trade legal");
const usdOnly = derivePriceTruth({ chainFeedSbdPerSteem: null, globalSteemUsd: 0.0527, globalSbdUsd: 0.501 });
ok(usdOnly.verdict === "USD-ONLY" && near(usdOnly.valueLineSbdPerSteem, 0.10519, 1e-4), "usd-only → line=usdParity");
const none = derivePriceTruth({ chainFeedSbdPerSteem: null, globalSteemUsd: null, globalSbdUsd: null });
ok(none.verdict === "UNMEASURED" && none.valueLineSbdPerSteem === null && none.bandRefSbdPerSteem === null, "no marks → UNMEASURED, null lines (reader fail-closes)");

/* ── סינון-ערכים-רעים ── */
const bad = derivePriceTruth({ chainFeedSbdPerSteem: -1, globalSteemUsd: 0, globalSbdUsd: NaN });
ok(bad.verdict === "UNMEASURED", "negative/zero/NaN marks refused");
const inf = derivePriceTruth({ chainFeedSbdPerSteem: Number.POSITIVE_INFINITY, globalSteemUsd: 0.0527, globalSbdUsd: 0.501 });
ok(inf.verdict === "USD-ONLY", "infinite chain feed refused");

/* ── פרוטוקול ── */
ok(tri.protocol === PRICE_TRUTH_PROTOCOL && PRICE_TRUTH_PROTOCOL === "SAOS-PRICE-TRUTH/1", "protocol constant stable");

console.log(`price-truth-selftest: ${n} laws green`);
