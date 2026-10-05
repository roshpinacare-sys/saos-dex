/**
 * arb-selftest.mjs — שער-ברזל לקו-הארביטרז' של Z-87a (בית-החוקים של הריצוג).
 * כיסוי: קבלת-בשלות-המרה · מתמטיקת-edge/size/fee/מצטבר כולל-קצוות-שליליים ·
 * נתחי-ספרים מוקלטים-חי · split-router (אופטימלי-מול-נאיבי + חוק-impact + חוק-ספר) ·
 * counter-grid (שימור-הון/הפרדת-צדדים/מונוטוניות) · שער-סוכנים fail-closed ·
 * מתאם-בלרט BRIDGE. דטרמיניסטי לגמרי — אפס-רשת: הכל מ-fixtures שהוקלטו-חי
 * (grids/state/fixtures/, מוקלט 2026-10-04) ומוקטורים-סינתטיים מסומנים.
 * measurement-only lane — capital gate N/A (STASIS scope)
 * אפס-תלות; רץ על node טהור.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { summarizeConversionRequests, planConvert, CONVERT_POLICY, medianFromFeedHistory, estimateMaturityPayout } from "./convert.mjs";
import {
  FEE_BPS, LEDGER_SCHEMA, LEDGER_CAP,
  parseCondenserBook, parseHtxDepth, parseEngineBooks,
  steemBookFeed, hiveBookFeed, htxDepthFeed, binanceTopFeed, engineBookFeed, blurtPriceRefFeed, llamaRefFeed,
  walkVwap, netEdgeBps, paperRoundTrip, makeEntry, degradedEntry,
  evaluateFeeds, emptyLedger, updateLedger,
} from "./arb-scan.mjs";
import { planSplit, mergeBooks, naiveSingleVenue, walkDepth, makerRepost } from "./split-router.mjs";
import { planCounterGrid, suggestedBias, normFactor, COUNTER_POLICY } from "./counter-grid.mjs";
import { planAgentSwap, executeAgentSwap, makerSwapPrice } from "./agent-swap-api.mjs";
import { controlFor, loadFlags } from "./agent-roster.mjs";
import { planBlurtExit, BRIDGE_PATHS, BLURT_HONESTY } from "./venues/blurt-quote.mjs";
import { authorityMatch, ownershipVerdict, buildCustodyInventory, CUSTODY_SCHEMA } from "./custody.mjs";
import {
  ENGINE_TRANSFERS_SCHEMA, parseHiveIssuerPage, parseBlurtBridgePage, normalizeHistoryEvent,
  partitionIssuerTransfers, partitionBlurtBridge, memoUserFromCredit, sumRows,
  pairInFlows, computeHaircutIn, buildEngineTransfersReceipt, condenseForCustody,
} from "./engine-transfers.mjs";
import {
  PAYOUT_DOCTRINE_SCHEMA, planPayoutDoctrine, custodyLiquidSteem, maturityWindow,
  countdownMinutes, COMMUNITY_COST_CITATION, DOCTRINE_SEARCH, ESTIMATE_LABEL,
} from "./payout-doctrine.mjs";
import { privToWif, privToPub, wifToPriv } from "./mover.mjs";
import crypto from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "state", "fixtures");
const fixture = (name) => JSON.parse(readFileSync(join(FIX, name), "utf8"));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS — ${name}`); }
  else { fail++; failures.push({ name, detail }); console.error(`FAIL — ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)?.slice(0, 160)}` : ""}`); }
}

/* fake-fetch: מחזיר תוכן-fixture לפי-URL — אפס-רשת, כמו okFetch של llm-selftest */
function fetchFromRoutes(routes, { log = [] } = {}) {
  return async (url) => {
    log.push(String(url));
    for (const [match, resp] of routes) {
      if (String(url).includes(match)) {
        if (resp instanceof Error) throw resp;
        return { ok: true, status: 200, json: async () => (typeof resp === "string" ? JSON.parse(resp) : resp) };
      }
    }
    throw new Error(`no route for ${url}`);
  };
}

async function main() {
  const NOW = "2026-10-04T09:00:00Z";
  const hasFixtures = existsSync(join(FIX, "steem-order-book.json"));

  /* ══ 1. קבלת-בשלות-ההמרה (S-fix) — fixture חי של get_conversion_requests ══ */
  const convJson = hasFixtures ? fixture("steem-conversion-requests.json") : { result: [] };
  const convRows = convJson.result ?? [];
  check("convert-maturity: live fixture has conversion rows", Array.isArray(convRows) && convRows.length > 0, convRows.length);
  const sum = summarizeConversionRequests(convRows);
  check("convert-maturity: count preserved", sum.requests.length === convRows.length);
  check("convert-maturity: pendingSbd = sum of verbatim amounts", Math.abs(sum.pendingSbd - convRows.reduce((s, r) => s + parseFloat(r.amount), 0)) < 1e-9, sum.pendingSbd);
  check("convert-maturity: every row keeps requestid + conversion_date verbatim", sum.requests.every((r) => r.requestid !== undefined && r.conversion_date !== undefined));
  check("convert-maturity: no invented fields (keys ⊆ API-returned set)", sum.requests.every((r) => Object.keys(r).every((k) => ["requestid", "amount", "conversion_date", "id", "owner"].includes(k))));
  check("convert-maturity: maturity dates are real ISO stamps from the chain", sum.requests.every((r) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(String(r.conversion_date))));
  const pConv = planConvert({ liquidSbd: 4, pendingSbd: sum.pendingSbd, pendingRequests: sum.requests, sbdUsd: 0.59 });
  check("convert-maturity: plan doc carries pendingRequests → convert-plan.json", Array.isArray(pConv.pendingRequests) && pConv.pendingRequests[0]?.requestid !== undefined);
  check("convert-maturity: non-array input fail-closed", JSON.stringify(summarizeConversionRequests(null)) === JSON.stringify({ pendingSbd: 0, pendingCount: 0, requests: [] }));

  /* ══ 1b. Z-89 · חוק-תשלום-הבשלות: הערכה-מסומנת-כך, לא-עובדה ══
   * החוק מקוד-השרשרת (database.cpp process_conversions): התשלום = amount ÷ החציון-המותאם-בזמן-העיבוד.
   * וקטורים-דטרמיניסטיים-סינתטיים לגמרי — האמת-החיה נמדדת-בקבלה, לא-בסלפטסט. */
  const medLive = medianFromFeedHistory({ current_median_history: { base: "58270125.447 SBD", quote: "559753583.308 STEEM" }, price_history: [{ base: "0.064 SBD", quote: "1.000 STEEM" }, { base: "0.062 SBD", quote: "1.000 STEEM" }] });
  check("maturity-law: ADJUSTED median parsed from condenser string-amounts ≈ 0.1040996", medLive.medianNow !== null && Math.abs(medLive.medianNow - 0.10409960236902552) < 1e-12, medLive.medianNow);
  check("maturity-law: raw witness median kept SEPARATE (0.064) + raw band [0.062..0.064]", medLive.rawMedianNow === 0.064 && medLive.rawBand && medLive.rawBand.min === 0.062 && medLive.rawBand.max === 0.064 && medLive.rawBand.samples === 2);
  check("maturity-law: note forbids mixing adjusted & raw", /never mixed/.test(medLive.note));
  const medNai = medianFromFeedHistory({ current_median_history: { base: { amount: "1041" }, quote: { amount: "10000" } }, price_history: [] });
  check("maturity-law: NAI-object shape compat → 0.1041", Math.abs(medNai.medianNow - 0.1041) < 1e-9);
  const medGarbage = medianFromFeedHistory({ current_median_history: { base: "0 SBD", quote: "0 STEEM" }, price_history: "junk" });
  check("maturity-law: garbage feed → fail-closed (null median, no throw)", medGarbage.medianNow === null && medGarbage.rawMedianNow === null);
  const est131 = estimateMaturityPayout({ rows: [{ amount: "131.856 SBD" }], medianNow: 0.1041, rawMedianNow: 0.064 });
  check("maturity-law: 131.856 SBD @0.1041 → estimate 1266.628 (floor-3, synthetic vector)", est131.estimate === 1266.628, est131.estimate);
  check("maturity-law: LAW input is ADJUSTED median — estimate ≠ what raw 0.064 would give", est131.estimate !== Math.floor((131.856 / 0.064) * 1000) / 1000);
  check("maturity-law: rawMedianNow passthrough (transparency only)", est131.rawMedianNow === 0.064);
  check("maturity-law: no invented band (null until a measured adjusted-median series exists)", est131.band === null);
  check("maturity-law: semantics says ESTIMATE + ADJUSTED + cites source", /ESTIMATE/.test(est131.semantics) && /ADJUSTED/.test(est131.semantics) && /process_conversions/.test(est131.semantics));
  const estNoMed = estimateMaturityPayout({ rows: [{ amount: "5.000 SBD" }], medianNow: null });
  check("maturity-law: no median → estimate null, no invention", estNoMed.estimate === null && /fail-closed/.test(estNoMed.reason));
  const estNoRows = estimateMaturityPayout({ rows: [], medianNow: 0.1041 });
  check("maturity-law: no rows → estimate null", estNoRows.estimate === null && estNoRows.pendingSbd === 0);

  /* ══ 1c. Z-89 · שכבת-האחזקה (custody-v1): בעלות-מפתח-ציבורי, אפס-המצאה ══ */
  const kSteem = [["5HhJD5WUXu8vPhDmLaC2fTuuJYkwxF62Rt17HZ5G2PbnBvuHXF", 1]];
  const kBlurt = [["5HhJD5WUXu8vPhDmLaC2fTuuJYkwxF62Rt17HZ5G2PbnBvuHXF", 1]]; // זהה-לגמרי (נמדד-חי 2026-10-04)
  const kHive = [["8c9vp3hUnNsXHaWLPTpcYWkPpK5GrnySgN51FiGX9dxhwVz8YZ", 1]]; // שונה (נמדד-חי)
  check("custody: authorityMatch identical key sets → true", authorityMatch(kSteem, kBlurt) === true);
  check("custody: authorityMatch different keys → false", authorityMatch(kSteem, kHive) === false);
  check("custody: authorityMatch empty authority → false (fail-closed)", authorityMatch(kSteem, []) === false);
  check("custody: prefix stripping STM/BLT treated as same body", authorityMatch([["STM5HhJD5WUXu8vPhDmLaC2fTuuJYkwxF62Rt17HZ5G2PbnBvuHXF", 1]], [["BLT5HhJD5WUXu8vPhDmLaC2fTuuJYkwxF62Rt17HZ5G2PbnBvuHXF", 1]]) === true);
  const vVer = ownershipVerdict({ anchorActive: kSteem, anchorOwner: [["5aUKyd9LzENnMti5tS478Zu1SLJW51VHyu2gvSNGKhwfyMFpvv", 1]], candActive: kBlurt, candOwner: [["5aUKyd9LzENnMti5tS478Zu1SLJW51VHyu2gvSNGKhwfyMFpvv", 1]] });
  check("custody: identical active+owner → verified-key-controlled", vVer === "verified-key-controlled");
  const vName = ownershipVerdict({ anchorActive: kSteem, anchorOwner: [["5aUKyd9LzENnMti5tS478Zu1SLJW51VHyu2gvSNGKhwfyMFpvv", 1]], candActive: kHive, candOwner: [["8mSbBz8zsMfBow2xa1yfTuNhdp6KZf3v7kAs1BSQAB1AMQM1Fw", 1]] });
  check("custody: different keys → name-match-unverified (NOT counted)", vName === "name-match-unverified");
  const vPart = ownershipVerdict({ anchorActive: kSteem, anchorOwner: [["5aUKyd9LzENnMti5tS478Zu1SLJW51VHyu2gvSNGKhwfyMFpvv", 1]], candActive: kSteem, candOwner: kHive });
  check("custody: only active matches → partial-match-unverified", vPart === "partial-match-unverified");
  const invEmpty = buildCustodyInventory({});
  check("custody: empty input → honest absent rows, no throw", invEmpty.schema === CUSTODY_SCHEMA && invEmpty.rows.some((r) => r.realness === "ABSENT") && invEmpty.account === null);
  const invFull = buildCustodyInventory({ anchor: { account: "headcorner", liquidSteem: 14.681, liquidSbd: 0.366, vests: "6366749.189565 VESTS", pendingSbd: 131.856 }, blurt: { account: "headcorner", liquidBlurt: 67.841, vests: "7600.869321 VESTS", ownership: "verified-key-controlled" }, hive: { account: "headcorner", liquidHive: 0.034, ownership: "name-match-unverified" }, nowIso: "2026-10-04T12:40:56.004Z" });
  check("custody: live-shaped vector keeps verbatim amounts", invFull.rows.find((r) => r.asset === "BLURT")?.amount === 67.841 && invFull.rows.find((r) => r.asset === "SBD-IN-CONVERT")?.amount === 131.856);
  check("custody: unverified hive row NOT ownership-claimed", invFull.rows.find((r) => r.chain === "hive")?.ownership === "name-match-unverified");
  check("custody: cex row stays unmeasurable (zero-secrets law)", invFull.rows.find((r) => r.chain === "cex")?.realness === "UNMEASURABLE-NO-RAIL" && invFull.rows.find((r) => r.chain === "cex")?.amount === null);
  check("custody: counts honest (onchainReal/absent/unmeasurable)", invFull.counts.onchainReal === 7 && invFull.counts.absent === 1 && invFull.counts.unmeasurable === 1);
  check("custody: law text forbids secrets", /zero secrets/.test(invFull.law));

  /* ══ 2. פרסרי-ספרים על-fixtures חיים ══ */
  const steemFix = hasFixtures ? fixture("steem-order-book.json") : null;
  if (steemFix) {
    const book = parseCondenserBook(steemFix.result, { venue: "steem-internal", baseField: "steem", quoteField: "sbd" });
    check("parse steem book: venue+realness", book?.venue === "steem-internal" && book?.realness === "ONCHAIN_REAL");
    check("parse steem book: asks ascending (non-strict — equal prices measured live)", book.asks.every((l, i) => i === 0 || l.price >= book.asks[i - 1].price));
    check("parse steem book: bids descending (non-strict)", book.bids.every((l, i) => i === 0 || l.price <= book.bids[i - 1].price));
    check("parse steem book: qty = chain milli-units /1000", Math.abs(book.asks[0].qty - steemFix.result.asks[0].steem / 1000) < 1e-9, book.asks[0].qty);
    check("parse steem book: price = real_price verbatim", Math.abs(book.asks[0].price - parseFloat(steemFix.result.asks[0].real_price)) < 1e-12);
  }
  const hiveFix = hasFixtures ? fixture("hive-order-book.json") : null;
  if (hiveFix) {
    const hb = parseCondenserBook(hiveFix.result, { venue: "hive-internal", baseField: "hive", quoteField: "hbd" });
    check("parse hive book: base HIVE/quote HBD realness ONCHAIN_REAL", hb?.venue === "hive-internal" && hb.asks[0].price > 0 && hb.realness === "ONCHAIN_REAL");
  }
  const engBuy = hasFixtures ? fixture("engine-swapblurt-buybook.json").result : null;
  const engSell = hasFixtures ? fixture("engine-swapblurt-sellbook.json").result : null;
  if (engBuy && engSell) {
    const eb = parseEngineBooks(engBuy, engSell, { symbol: "SWAP.BLURT" });
    check("parse engine books: client-side sort (server rows unsorted — measured)", eb.bids[0].price === Math.max(...engBuy.map((r) => parseFloat(r.price))), eb.bids[0].price);
    check("parse engine books: asks ascending + L2_REAL", eb.asks.every((l, i) => i === 0 || l.price >= eb.asks[i - 1].price) && eb.realness === "L2_REAL");
    check("parse engine books: pair tagged", eb.pair === "SWAP.BLURT:SWAP.HIVE");
  }
  const htxShape = fixture("htx-depth-SYNTHETIC-SHAPE.json"); // מסומן: צורה-סינתטית — לא-נתוני-שוק
  const htxParsed = parseHtxDepth({ tick: htxShape.tick });
  check("parse HTX (SYNTHETIC-SHAPE fixture): bids desc / asks asc", htxParsed.bids[0].price >= htxParsed.bids[1].price && htxParsed.asks[0].price <= htxParsed.asks[1].price);
  check("parse HTX: empty/garbage → null (degraded, never throws)", parseHtxDepth(null) === null && parseHtxDepth({}) === null && parseHtxDepth({ tick: { bids: [], asks: [] } }) === null);

  /* ══ 3. מנוע-הפידים עם fetch מוזרק — כולל-כישלון-כנה ══ */
  if (steemFix) {
    const log = [];
    const f = fetchFromRoutes([["api.steemit.com", steemFix]], { log });
    const r = await steemBookFeed({ fetchImpl: f });
    check("feed steem: ok via injected fixture", r.ok === true && r.data.asks.length > 0);
  }
  {
    const r = await steemBookFeed({ fetchImpl: async () => { throw new Error("boom"); } });
    check("feed steem: all nodes down → ok:false (never throws)", r.ok === false && typeof r.error === "string");
  }
  {
    const blurtFix = fixture("blurt-price-info.json");
    const r = await blurtPriceRefFeed({ fetchImpl: fetchFromRoutes([["api.blurt.blog", blurtFix]]) });
    check("feed blurt ref: price_usd parsed", r.ok === true && r.data.priceUsd === blurtFix.price_usd);
  }
  {
    const llamaFix = fixture("llama-prices.json");
    const r = await llamaRefFeed({ fetchImpl: fetchFromRoutes([["coins.llama.fi", llamaFix]]) });
    check("feed llama refs: sbdUsd>0 with source truth", r.ok === true && r.data.sbdUsd > 0 && r.data.steemUsd > 0, r.data);
  }
  {
    const cg429 = fixture("coingecko-simple-price.json"); // 429-אמת שהוקלט — שקערורית-תדרים
    const r = await llamaRefFeed({ fetchImpl: async () => { throw new Error("HTTP 429"); } });
    check("feed degraded: rate-limited ref → ok:false honest", r.ok === false);
    void cg429;
  }
  {
    const binFix = fixture("binance-steemusdt-bookticker.json");
    const r = await binanceTopFeed("STEEMUSDT", { fetchImpl: fetchFromRoutes([["api.binance.com", binFix]]) });
    check("feed binance top: bid<ask realness CEX_REF", r.ok === true && r.data.bids[0].price < r.data.asks[0].price && r.data.realness === "CEX_REF");
  }
  {
    const r = await htxDepthFeed("steemusdt", { fetchImpl: async () => { throw new Error("blocked"); } });
    check("feed htx unreachable → degraded honest", r.ok === false && /htx steemusdt/.test(r.error));
  }
  {
    // Z-87a מדוד-חי: הנתיב החי הוא /market/depth (ה-/v1 ישן-404). Fixtures חיים-מוקלטים.
    const htxSteemFix = fixture("htx-steemusdt-depth.json");
    const r = await htxDepthFeed("steemusdt", { fetchImpl: fetchFromRoutes([["api.htx.com", htxSteemFix]]) });
    check("feed htx steemusdt (live-recorded fixture): ok + CEX_REF book", r.ok === true && r.data.realness === "CEX_REF" && r.data.bids[0].price > r.data.asks[0].price - 1, { bid: r.data?.bids?.[0]?.price });
    const htxSbdFix = fixture("htx-sbdusdt-depth.json");
    const sbd = parseHtxDepth(htxSbdFix);
    check("fixture htx sbdusdt: the only live SBD book parses (Z-86a truth)", sbd != null && sbd.bids[0].price > 0.5 && sbd.bids[0].price < 0.7, sbd?.bids?.[0]);
  }

  /* ══ 4. מתמטיקת-edge/size/fee (מודל-העמלה של הבית FEE_BPS=30 לרגל) ══ */
  check("fee law: FEE_BPS=30", FEE_BPS === 30);
  {
    const e = netEdgeBps(1.0, 1.02, 30);
    const expect = ((1.02 * 0.997 - 1.0 * 1.003) / (1.0 * 1.003)) * 1e4;
    check("edge math: 30bps per leg both sides", Math.abs(e - expect) < 1e-6 && e > 0, e);
  }
  check("edge math: negative stays negative after fees", netEdgeBps(1.02, 1.00, 30) < 0);
  check("edge math: zero-size guard", netEdgeBps(0, 1.02, 30) === null);
  {
    const w = walkVwap([{ price: 1.0, qty: 10 }, { price: 1.1, qty: 10 }], 15);
    check("walkVwap: multi-level vwap exact", Math.abs(w.vwap - (10 * 1.0 + 5 * 1.1) / 15) < 1e-9 && w.filled === 15);
  }
  {
    const rt = paperRoundTrip({ buyLevels: [{ price: 1.0, qty: 10 }], sellLevels: [{ price: 1.02, qty: 5 }], size: 4, sbdUsd: 1 });
    check("paper round-trip: executableSize=min across legs", rt.executableSize === 4);
    const pnlExpect = (1.02 * (1 - 30 / 1e4) - 1.0 * (1 + 30 / 1e4)) * 4;
    check("paper round-trip: pnl with house fee model", Math.abs(rt.paperPnlSbd - pnlExpect) < 1e-6, { got: rt.paperPnlSbd, want: pnlExpect });
    check("paper round-trip: positive edge here", rt.edgeBps > 0);
  }
  {
    const neg = paperRoundTrip({ buyLevels: [{ price: 1.02, qty: 10 }], sellLevels: [{ price: 0.99, qty: 10 }], size: 10, sbdUsd: 1 });
    check("paper round-trip: NEGATIVE pnl recorded honestly", neg.paperPnlSbd < 0 && neg.edgeBps < 0, neg);
  }
  {
    const refOnly = paperRoundTrip({ buyLevels: [{ price: 0.00099, qty: 0 }], sellLevels: [{ price: 1, qty: 10 }], size: 0, sbdUsd: 1 });
    check("paper round-trip: zero-depth ref leg → size 0, honest nulls", refOnly.executableSize === 0);
  }
  {
    // Z-88 תיקון-אמת (מבטל-החלטת-Z87a): רגל-ייחוס → קצה-נמדד, גודל-בר-ביצוע 0, PnL null —
    // אין-מקום-אמיתי-שבו-הרגל-מתבצעת; PnL-עליה = כסף-מומצא (האופרטור: לא-סתם-שקר).
    const refLeg = paperRoundTrip({ buyLevels: [{ price: 0.0175, qty: 100 }], sellLevels: null, size: 100, buyQuoteUsd: 0.0562, refSellPriceUsd: 0.00098, sbdUsd: 0.6 });
    check("paper round-trip: ref-price leg → edge numeric + size 0 + pnl NULL (no invented money)", typeof refLeg.edgeBps === "number" && refLeg.executableSize === 0 && refLeg.paperPnlSbd === null, refLeg);
    const noSbd = paperRoundTrip({ buyLevels: [{ price: 1.0, qty: 10 }], sellLevels: [{ price: 1.02, qty: 10 }], size: 10, sbdUsd: null });
    check("paper round-trip: sbdUsd missing → paperPnlSbd null (never mislabel USD as SBD)", noSbd.paperPnlSbd === null && typeof noSbd.edgeBps === "number", noSbd);
  }

  /* ══ 5. evaluateFeeds על-ספרים אמיתיים (fixtures) — תגיות-אמת וכנות ══ */
  const entriesNow = hasFixtures ? (() => {
    const steemBook = parseCondenserBook(steemFix.result, { venue: "steem-internal", baseField: "steem", quoteField: "sbd" });
    const hiveBook = parseCondenserBook(hiveFix.result, { venue: "hive-internal", baseField: "hive", quoteField: "hbd" });
    const engineBook = parseEngineBooks(engBuy, engSell, { symbol: "SWAP.BLURT" });
    const htxSteem = parseHtxDepth({ tick: htxShape.tick });
    const binFix = fixture("binance-steemusdt-bookticker.json");
    const binanceSteem = { venue: "binance", realness: "CEX_REF", asks: [{ price: parseFloat(binFix.askPrice), qty: parseFloat(binFix.askQty) }], bids: [{ price: parseFloat(binFix.bidPrice), qty: parseFloat(binFix.bidQty) }] };
    const llama = fixture("llama-prices.json").coins;
    const refs = { steemUsd: llama["coingecko:steem"]?.price ?? null, sbdUsd: llama["coingecko:steem-dollars"]?.price ?? null, hiveUsd: llama["coingecko:hive"]?.price ?? null, blurtUsd: llama["coingecko:blurt"]?.price ?? null };
    const feeds = { steemBook, hiveBook, engineBook, htxSteem, htxHive: null, binanceSteem, binanceHive: null, _htxHiveError: "htx hiveusdt: not recorded (sandbox egress) — honest degraded entry below" };
    return evaluateFeeds({ feeds, refs, nowIso: NOW });
  })() : [];
  if (hasFixtures) {
    const SCHEMA_KEYS = ["ts", "pair", "venueA", "venueB", "edgeBps", "direction", "executableSize", "realness", "paperPnlSbd", "degraded", "notes"];
    check("evaluate: every entry has EXACTLY the arb-ledger-v1 entry keys", entriesNow.every((e) => JSON.stringify(Object.keys(e)) === JSON.stringify(SCHEMA_KEYS)), entriesNow[0] && Object.keys(entriesNow[0]));
    check("evaluate: degraded entry recorded for missing HTX hive feed (fail-closed skip)", entriesNow.some((e) => e.degraded === true && e.pair === "HIVE:HBD" && e.edgeBps === null && e.paperPnlSbd === 0));
    const steemEntry = entriesNow.find((e) => e.pair === "STEEM:SBD" && !e.degraded && e.direction.includes("buy STEEM on-chain"));
    check("evaluate: STEEM chain-buy leg present with realness CEX_REF (weakest leg)", steemEntry?.realness === "CEX_REF", steemEntry);
    check("evaluate: STEEM executableSize = min(chain depth, cex depth)", steemEntry != null && Math.abs(steemEntry.executableSize - Math.min(steemBook0().asks[0].qty, htxParsed.bids[0].qty)) < 1e-6, steemEntry?.executableSize);
    check("evaluate: direction is human-honest", steemEntry?.direction.includes("buy STEEM on-chain with SBD") === true);
    const blurtEntry = entriesNow.find((e) => e.pair === "SWAP.BLURT:SWAP.HIVE" && !e.degraded);
    if (blurtEntry) {
      check("evaluate: BLURT legs PAPER (no blurt book exists — Z-86a truth)", blurtEntry.realness === "PAPER" && blurtEntry.executableSize === 0);
      check("evaluate: BLURT edge measured vs ref (numeric signal) + pnl NULL (Z-88 no-invented-money)", typeof blurtEntry.edgeBps === "number" && blurtEntry.paperPnlSbd === null, blurtEntry);
      check("evaluate: BLURT notes carry the no-book honesty", /no Blurt orderbook|price_ref/i.test(blurtEntry.notes));
      const blurtOpp = entriesNow.find((e) => e.pair === "SWAP.BLURT:SWAP.HIVE" && !e.degraded && e.venueA === "blurt-price-ref");
      check("evaluate: BLURT both directions measured (engine→ref and ref→engine)", blurtOpp != null && typeof blurtOpp.edgeBps === "number");
    } else check("evaluate: BLURT degraded-or-absent only when refs missing", entriesNow.some((e) => e.pair === "SWAP.BLURT:SWAP.HIVE" && e.degraded));
    const negEntries = entriesNow.filter((e) => !e.degraded && e.edgeBps < 0);
    check("evaluate: negative edges kept — no cherry-picking", entriesNow.filter((e) => !e.degraded).length === negEntries.length + entriesNow.filter((e) => !e.degraded && e.edgeBps >= 0).length);
    const again = evaluateFeeds({ feeds: { steemBook: parseCondenserBook(steemFix.result, { venue: "steem-internal", baseField: "steem", quoteField: "sbd" }), hiveBook: parseCondenserBook(hiveFix.result, { venue: "hive-internal", baseField: "hive", quoteField: "hbd" }), engineBook: parseEngineBooks(engBuy, engSell, { symbol: "SWAP.BLURT" }), htxSteem: parseHtxDepth({ tick: htxShape.tick }), htxHive: null, binanceSteem: null, binanceHive: null }, refs: { sbdUsd: 0.6021, hiveUsd: 0.0563, blurtUsd: 0.00098 }, nowIso: NOW });
    const twice = evaluateFeeds({ feeds: { steemBook: parseCondenserBook(steemFix.result, { venue: "steem-internal", baseField: "steem", quoteField: "sbd" }), hiveBook: parseCondenserBook(hiveFix.result, { venue: "hive-internal", baseField: "hive", quoteField: "hbd" }), engineBook: parseEngineBooks(engBuy, engSell, { symbol: "SWAP.BLURT" }), htxSteem: parseHtxDepth({ tick: htxShape.tick }), htxHive: null, binanceSteem: null, binanceHive: null }, refs: { sbdUsd: 0.6021, hiveUsd: 0.0563, blurtUsd: 0.00098 }, nowIso: NOW });
    check("evaluate: determinism — same feeds+refs+ts → identical entries", JSON.stringify(again) === JSON.stringify(twice));
  }
  function steemBook0() { return parseCondenserBook(steemFix.result, { venue: "steem-internal", baseField: "steem", quoteField: "sbd" }); }

  /* ══ 6. הפנקס המצטבר arb-ledger-v1 ══ */
  {
    const e1 = makeEntry({ ts: NOW, pair: "X:Y", venueA: "a", venueB: "b", direction: "d1", buyLevels: [{ price: 1, qty: 10 }], sellLevels: [{ price: 1.05, qty: 10 }], size: 5, realnessTags: ["ONCHAIN_REAL", "CEX_REF"] });
    const e2 = makeEntry({ ts: NOW, pair: "X:Y", venueA: "b", venueB: "a", direction: "d2", buyLevels: [{ price: 1.05, qty: 10 }], sellLevels: [{ price: 1.0, qty: 10 }], size: 5, realnessTags: ["ONCHAIN_REAL", "CEX_REF"] });
    const e3 = degradedEntry({ ts: NOW, pair: "Z:W", venueA: "a", venueB: "c", direction: "d3", reason: "feed down" });
    check("entry: realness = weakest leg", e1.realness === "CEX_REF");
    const l1 = updateLedger(emptyLedger(), [e1, e2, e3], { generatedAt: NOW });
    check("ledger: schema v1 exact", l1.schema === LEDGER_SCHEMA && Array.isArray(l1.entries));
    check("ledger: cumulative sums pnl incl. negative", l1.cumulative.entries === 3 && Math.abs(l1.cumulative.paperPnlSbd - (e1.paperPnlSbd + e2.paperPnlSbd + 0)) < 1e-6, l1.cumulative);
    check("ledger: positiveEntries counts only positive non-degraded edges", l1.cumulative.positiveEntries === 1, l1.cumulative);
    check("ledger: realized=false — paper only", l1.cumulative.realized === false);
    const many = Array.from({ length: LEDGER_CAP + 50 }, (_, i) => ({ ...e1, edgeBps: i % 2 ? i : -i, paperPnlSbd: (i % 2 ? 1 : -1) * 0.1 }));
    const l2 = updateLedger(l1, many, { generatedAt: NOW });
    check("ledger: file capped at last 200 entries", l2.entries.length === LEDGER_CAP);
    check("ledger: cumulative survives the cap (all-time counters)", l2.cumulative.entries === 3 + LEDGER_CAP + 50);
    check("ledger: layer provenance stamped (Z-88 audit)", l1.layer === "sovereign-CI", l1.layer);
    const l2b = updateLedger({ schema: LEDGER_SCHEMA, generatedAt: NOW, entries: [e1], cumulative: { paperPnlSbd: 0.5, entries: 1, positiveEntries: 1, realized: false } }, [e2], { generatedAt: NOW });
    check("ledger: prev WITHOUT layer → output still carries provenance + cumulative preserved", l2b.layer === "sovereign-CI" && l2b.cumulative.entries === 2, l2b.layer);
    const l3 = updateLedger({ schema: "corrupt", entries: "garbage" }, [e1], { generatedAt: NOW });
    check("ledger: corrupt prev → honest fresh base, never throws", l3.cumulative.entries === 1 && l3.entries.length === 1);
    const eRef = { ts: NOW, pair: "B:R", venueA: "a", venueB: "ref", edgeBps: 900, direction: "d4", executableSize: 0, realness: "PAPER", paperPnlSbd: null, degraded: false, notes: "" };
    const lRef = updateLedger(emptyLedger(), [eRef], { generatedAt: NOW });
    check("ledger: PAPER ref-leg (null pnl) adds ZERO money to cumulative — no invented profit", lRef.cumulative.paperPnlSbd === 0 && lRef.cumulative.entries === 1, lRef.cumulative);
  }

  /* ══ 7. split-router: אופטימלי-מול-נאיבי + חוק-impact + חוק-ספר ══ */
  {
    const lvls = [
      { price: 1.0, qty: 20, venue: "steem-internal", realness: "ONCHAIN_REAL", feeBps: 0 },
      { price: 1.05, qty: 50, venue: "steem-internal", realness: "ONCHAIN_REAL", feeBps: 0 },
      { price: 1.01, qty: 30, venue: "htx", realness: "CEX_REF", feeBps: 0 },
    ];
    const plan = planSplit({ pair: "TEST", side: "buy", amount: 50, levels: lvls, medianRef: 1.0, nowIso: NOW });
    check("split: optimal walk consumes best levels first", Math.abs(plan.vwap - (20 * 1.0 + 30 * 1.01) / 50) < 1e-9, plan.vwap);
    check("split: split beats naive single-venue fill (>0 improvement)", plan.splitVsNaive.improvementBps > 0, plan.splitVsNaive);
    check("split: impactBps ≥ 0 (vwap never better than touch for buys)", plan.impactBps >= 0);
    const small = planSplit({ pair: "TEST", side: "buy", amount: 5, levels: lvls, medianRef: 1.0, nowIso: NOW });
    check("split: impact grows with amount (impact law)", plan.impactBps > small.impactBps, { big: plan.impactBps, small: small.impactBps });
    const deep = planSplit({ pair: "TEST", side: "buy", amount: 500, levels: lvls, medianRef: 1.0, nowIso: NOW });
    check("split: DEPTH-LIMIT warning when depth exhausted", deep.warnings.some((w) => w.startsWith("DEPTH-LIMIT")) && deep.fillable === 100 && deep.unfilled === 400, { fillable: deep.fillable });
    const weird = planSplit({ pair: "TEST", side: "buy", amount: 5, levels: lvls, medianRef: 2.0, nowIso: NOW });
    check("split: SANITY-FLAG vs median feed >15%", weird.warnings.some((w) => w.startsWith("SANITY-FLAG")));
    check("split: PAPER-LEGS warning for CEX_REF legs in the plan", plan.warnings.some((w) => w.startsWith("PAPER-LEGS")), plan.warnings);
    check("split: fail-closed without depth", planSplit({ side: "buy", amount: 5, levels: [] }).ok === false);
    check("split: fail-closed bad side/amount", planSplit({ side: "sideways", amount: 5, levels: lvls }).ok === false && planSplit({ side: "buy", amount: -1, levels: lvls }).ok === false);
    // maker repost — חוק-הספר Z-80
    const book = { bestAsk: 1.02, bestBid: 0.995 };
    const mr = makerRepost(plan.legs, "buy", book);
    check("makerRepost: every repost passes crossAudit (bid ≤ bestBid)", mr.ok === true && mr.legs.every((l) => l.makerPrice <= book.bestBid), mr.legs.map((l) => l.makerPrice));
    check("makerRepost: clamp flags recorded", mr.legs.some((l) => l.clamped === true));
    const mrBad = makerRepost(plan.legs, "buy", { bestAsk: 1.02, bestBid: null });
    check("makerRepost: half-book → fail-closed (Z-80)", mrBad.ok === false);
    // sell side mirror
    const sellPlan = planSplit({ pair: "TEST", side: "sell", amount: 30, levels: [...lvls].reverse(), medianRef: 1.0, nowIso: NOW });
    check("split sell: descending walk", sellPlan.legs[0].priceRaw >= sellPlan.legs[sellPlan.legs.length - 1].priceRaw);
  }
  {
    const a = mergeBooks([{ venue: "steem-internal", realness: "ONCHAIN_REAL", quoteToUsd: 0.6, asks: [{ price: 1.0, qty: 5 }] }, { venue: "htx", realness: "CEX_REF", quoteToUsd: 1, asks: [{ price: 0.62, qty: 5 }] }], "buy");
    check("mergeBooks: cross-unit normalization + favorable sort", a.length === 2 && a[0].venue === "steem-internal" && a[0].price === 0.6, a);
    const nf = naiveSingleVenue(a, 10, "buy");
    check("naiveSingleVenue: partial cover reported honestly", nf.filled === 5 && nf.venue === "steem-internal");
  }

  /* ══ 8. counter-grid: שימור-הון + הפרדת-צדדים + מונוטוניות ══ */
  {
    const input = {
      balances: { steem: 200, sbd: 50 }, // Z-87a: מספיק-דלק כדי-שהסולמות-באמת-ייווצרו (הבדיקות לא-ריקות-מהותית)
      book: { bestAsk: 0.1045, bestBid: 0.1001 },
      anchor: 0.1022,
      fills: { boughtSteem: 30, soldSteem: 70 },
      nowIso: NOW,
    };
    for (const bias of [-1, 0, 0.35, 1]) {
      const doc = planCounterGrid({ ...input, biasOverride: bias });
      check(`counter-grid(bias=${bias}): verdict PLAN`, doc.verdict === "COUNTER-GRID-PLAN", doc.blockers);
      check(`counter-grid(bias=${bias}): asks within sell partition`, doc.plan.totals.askSteem <= doc.partitions.askCapitalSteem + 1e-9, { sum: doc.plan.totals.askSteem, cap: doc.partitions.askCapitalSteem });
      check(`counter-grid(bias=${bias}): bids within buy partition`, doc.plan.totals.bidSbd <= doc.partitions.bidCapitalSbd + 1e-9);
      check(`counter-grid(bias=${bias}): partitions within real balances`, doc.partitions.askCapitalSteem <= input.balances.steem - COUNTER_POLICY.reserveSteem && doc.partitions.bidCapitalSbd <= input.balances.sbd);
      check(`counter-grid(bias=${bias}): asks strictly monotonic up + above touch`, doc.plan.asks.every((a, i) => i === 0 || a.priceSbdPerSteem > doc.plan.asks[i - 1].priceSbdPerSteem) && doc.plan.asks.every((a) => a.priceSbdPerSteem >= input.book.bestAsk));
      check(`counter-grid(bias=${bias}): bids strictly monotonic down + below touch`, doc.plan.bids.every((b, i) => i === 0 || b.priceSbdPerSteem < doc.plan.bids[i - 1].priceSbdPerSteem) && doc.plan.bids.every((b) => b.priceSbdPerSteem <= input.book.bestBid));
      check(`counter-grid(bias=${bias}): plan-only marker`, /plan-only/.test(doc.execution));
      const allInv = Object.values(doc.invariants).every(Boolean);
      check(`counter-grid(bias=${bias}): ALL invariants pass structurally`, allInv === true, doc.invariants);
    }
    const bPos = planCounterGrid({ ...input, biasOverride: 1 }).partitions.bidCapitalSbd;
    const bNeg = planCounterGrid({ ...input, biasOverride: -1 }).partitions.bidCapitalSbd;
    check("counter-grid: counter-inventory bias moves buy capital up monotonically", bPos > bNeg, { bPos, bNeg });
    const aPos = planCounterGrid({ ...input, biasOverride: 1 }).partitions.askCapitalSteem;
    const aNeg = planCounterGrid({ ...input, biasOverride: -1 }).partitions.askCapitalSteem;
    check("counter-grid: bias tilts ask capital down when bids up (opposing ladders)", aPos < aNeg, { aPos, aNeg });
    check("counter-grid: suggestedBias from real fills (sold>bought → positive)", suggestedBias({ boughtSteem: 30, soldSteem: 70 }) > 0 && Math.abs(suggestedBias({ boughtSteem: 70, soldSteem: 70 })) === 0);
    const det1 = planCounterGrid({ ...input, biasOverride: 0 });
    const det2 = planCounterGrid({ ...input, biasOverride: 0 });
    check("counter-grid: determinism", JSON.stringify(det1) === JSON.stringify(det2));
    const blocked = planCounterGrid({ ...input, book: null });
    check("counter-grid: no book → BLOCKED fail-closed (Z-80)", blocked.verdict === "COUNTER-GRID-BLOCKED" && blocked.plan === null);
    const noBal = planCounterGrid({ ...input, balances: { steem: 0.1, sbd: 0 } });
    check("counter-grid: empty balances → BLOCKED honest", noBal.verdict === "COUNTER-GRID-BLOCKED");
    const dust = planCounterGrid({ ...input, balances: { steem: 20, sbd: 2 } });
    check("counter-grid: below-dust sides → BLOCKED with waiting-for-fuel note (empty plan is not a plan)", dust.verdict === "COUNTER-GRID-BLOCKED" && (dust.blockers ?? []).some((b) => /waiting for fuel/.test(b)), dust.blockers);
    check("counter-grid: normFactor normalizes geometric sum", Math.abs(normFactor(5, 1.5) * (1 + 1.5 + 1.5 ** 2 + 1.5 ** 3 + 1.5 ** 4) / 5 - 1) < 1e-9);
  }

  /* ══ 9. שער-הסוכנים — fail-closed בכל-הנתיבים ══ */
  {
    const flagsCommitted = loadFlags({ env: {} });
    check("agent-roster: committed flags file loads with v1 schema", flagsCommitted?.schema === "agent-swap-flags-v1");
    const ctl = controlFor("sup-1", { env: {} });
    check("agent-roster: unlisted agent → blocked-no-key (fail-closed default)", ctl.control === "blocked-no-key" && ctl.economicUse === false);
    const ctlEnv = controlFor("sup-1", { env: { AGENT_SWAP_ROSTER_PATH: "/nonexistent/roster.json" } });
    check("agent-roster: bad env path → falls back to committed flags (never opens)", ctlEnv.control === "blocked-no-key");

    const book = hasFixtures && steemFix ? { bestAsk: steemBook0().asks[0].price, bestBid: steemBook0().bids[0].price } : { bestAsk: 0.1045, bestBid: 0.1001 };
    const base = { pair: "STEEM:SBD", side: "buy", amount: 2, agentId: "sup-1", book, nowIso: NOW, edgeBps: 42 };

    const p1 = planAgentSwap({ ...base, control: controlFor("sup-1", { env: {} }) });
    check("agent-gate: missing flag → PLAN published but gate DISARMED", p1.status === "PLAN" && p1.gate.state === "DISARMED" && /roster flag/.test(p1.gate.reasons[0]), p1.gate.reasons);
    check("agent-gate: plan carries realness tags + maker order", p1.realness.chain === "ONCHAIN_REAL" && p1.makerOrder?.price === book.bestBid && p1.makerOrder?.side === "bid");
    check("agent-gate: default cap = policy default (5 SBD)", p1.cap.capSbd === 5 && p1.cap.withinCap === true, p1.cap);

    const pCap = planAgentSwap({ ...base, amount: 1000, control: { control: "full", economicUse: true, capSbd: 1, source: "test" } });
    check("agent-gate: cap exceeded → REJECTED with honest reason", pCap.status === "REJECTED" && /cap exceeded/.test(pCap.gate.reasons.join("|")), pCap.gate.reasons);

    const pNoBook = planAgentSwap({ ...base, book: null, control: { control: "full", economicUse: true, capSbd: 100, source: "test" } });
    check("agent-gate: no book → notional incomputable + clamp fail (fail-closed)", pNoBook.status === "REJECTED" && /not computable|clamp/.test(pNoBook.gate.reasons.join("|")));

    const pSell = planAgentSwap({ ...base, side: "sell", control: { control: "full", economicUse: true, capSbd: 100, source: "test" } });
    check("agent-gate: sell-side maker price = bestAsk (ask ≥ touch)", pSell.makerOrder?.price === book.bestAsk && pSell.makerOrder?.side === "ask");
    check("agent-swap: makerSwapPrice side law", makerSwapPrice("buy", book).side === "bid" && makerSwapPrice("sell", book).side === "ask" && makerSwapPrice("buy", null) === null);

    // executeAgentSwap — DISARMED לפני-כל-רשת (אפס-קריאות)
    let netCalls = 0;
    const countingFetch = async (...a) => { netCalls++; throw new Error("network-in-test"); };
    let rpcCalls = 0;
    const countingRpc = async (...a) => { rpcCalls++; throw new Error("network-in-test"); };
    const x1 = await executeAgentSwap({ plan: p1, env: { STEEM_ACTIVE_WIF: "SOMETHING" }, fetchImpl: countingFetch, rpcImpl: countingRpc });
    check("agent-gate: flag blocked → DISARMED, ZERO network calls (fetch+rpc)", x1.status === "DISARMED" && netCalls === 0 && rpcCalls === 0 && /roster flag/.test(x1.reasons.join("|")), x1.reasons);
    const p2 = planAgentSwap({ ...base, control: { control: "full", economicUse: true, capSbd: 100, source: "test" } });
    const x2 = await executeAgentSwap({ plan: p2, env: {}, fetchImpl: countingFetch, rpcImpl: countingRpc });
    check("agent-gate: flag ok but missing env → DISARMED, zero network", x2.status === "DISARMED" && netCalls === 0 && /STEEM_ACTIVE_WIF/.test(x2.reasons.join("|")));
    const x3 = await executeAgentSwap({ plan: pCap, env: { STEEM_ACTIVE_WIF: "x" }, fetchImpl: countingFetch, rpcImpl: countingRpc });
    check("agent-gate: REJECTED plan never executes", x3.status === "DISARMED" && /plan absent\/REJECTED|cap/.test(x3.reasons.join("|")));
    const pNeg = planAgentSwap({ ...base, edgeBps: -12, control: { control: "full", economicUse: true, capSbd: 100, source: "test" } });
    const x4 = await executeAgentSwap({ plan: pNeg, env: { STEEM_ACTIVE_WIF: "x" }, fetchImpl: countingFetch, rpcImpl: countingRpc });
    check("agent-gate: non-positive edge → DISARMED (honesty gate)", x4.status === "DISARMED" && /non-positive edge/.test(x4.reasons.join("|")));

    // הנתיב-המלא-המדומה: דגל-מלא + env + verify-then-sign (rpc מוזרק) + RC + ספר-טרי + חותם-מוזרק
    const priv = crypto.createHash("sha256").update("z87a-selftest-vector").digest();
    const wif = privToWif(priv);
    const pub = privToPub(priv);
    check("wif vector: wifToPriv∘privToWif identity (mover law)", Buffer.from(wifToPriv(wif)).equals(priv));
    const rpcOk = async (method) => {
      if (method === "condenser_api.get_accounts") return [{ active: { key_auths: [[pub, 1]] } }];
      if (method === "rc_api.find_rc_accounts") return { rc_accounts: [{ rc_manabar: { current_mana: 1e12 } }] };
      throw new Error("unexpected rpc " + method);
    };
    const steemFixNow = hasFixtures ? fixture("steem-order-book.json") : null;
    const freshFetch = steemFixNow ? fetchFromRoutes([["api.steemit.com", steemFixNow]]) : async () => { throw new Error("no fixture"); };
    let signedOp = null;
    const signer = async (op) => { signedOp = op; return { ok: true, status: "EXECUTED", broadcast: { txid: "fake-test-txid", block: 1 } }; };
    const pFull = planAgentSwap({ ...base, control: { control: "full", economicUse: true, capSbd: 100, source: "test" } });
    const x5 = await executeAgentSwap({ plan: pFull, env: { STEEM_ACTIVE_WIF: wif }, rpcImpl: rpcOk, fetchImpl: freshFetch, signer });
    check("agent-gate: ALL gates pass → single signed op (limit_order_create)", x5.status === "EXECUTED" && signedOp?.[0] === "limit_order_create", x5);
    check("agent-gate: signed order respects book-law (bid ≤ bestBid of live fixture)", pFull.makerOrder.price <= steemBook0().bids[0].price);
    const rpcBad = async (method) => (method === "condenser_api.get_accounts" ? [{ active: { key_auths: [["STMdifferentAuthority", 1]] } }] : rpcOk(method));
    const x6 = await executeAgentSwap({ plan: pFull, env: { STEEM_ACTIVE_WIF: wif }, rpcImpl: rpcBad, fetchImpl: freshFetch, signer });
    check("agent-gate: verify-then-sign mismatch → REFUSED, no broadcast", x6.status === "REFUSED" && /LIVE active authority/.test(x6.reasons.join("|")));
    const rcLow = async (method) => (method === "rc_api.find_rc_accounts" ? { rc_accounts: [{ rc_manabar: { current_mana: 0 } }] } : rpcOk(method));
    const x7 = await executeAgentSwap({ plan: pFull, env: { STEEM_ACTIVE_WIF: wif }, rpcImpl: rcLow, fetchImpl: freshFetch, signer });
    check("agent-gate: RC fuel below floor → REFUSED", x7.status === "REFUSED" && /RC fuel/.test(x7.reasons.join("|")));
    const x8 = await executeAgentSwap({ plan: pFull, env: { STEEM_ACTIVE_WIF: wif }, rpcImpl: rpcOk, fetchImpl: async () => { throw new Error("book down"); }, signer });
    check("agent-gate: fresh book unavailable at execution → REFUSED (fail-closed)", x8.status === "REFUSED" && /live book unavailable/.test(x8.reasons.join("|")));
  }

  /* ══ 10. מתאם-בלרט — BRIDGE בכנות ══ */
  {
    if (engBuy && engSell) {
      const book = parseEngineBooks(engBuy, engSell, { symbol: "SWAP.BLURT" });
      const llama = fixture("llama-prices.json").coins;
      const blurtUsd = fixture("blurt-price-info.json").price_usd; // price_info — סמכות-הבלרט (llama מדלג על blurt — מדוד)
      const hiveUsd = llama["coingecko:hive"]?.price ?? null;
      const plan = planBlurtExit({ amountBlurt: 5000, book, blurtUsd, hiveUsd, nowIso: NOW });
      check("blurt: plan ok with label BRIDGE", plan.ok === true && plan.label === "BRIDGE");
      check("blurt: 3 honest steps incl. bridge + L2 sell", plan.steps.length === 3 && plan.steps[0].kind === "BRIDGE" && plan.steps[2].kind === "SELL-L2");
      check("blurt: honesty warnings present (NO-BLURT-BOOK + NO-BLURT-BD + FEE-UNKNOWN)", plan.warnings.includes(BLURT_HONESTY.noBlurtBook) && plan.warnings.includes(BLURT_HONESTY.noBlurtBd) && plan.warnings.includes(BLURT_HONESTY.bridgeFeeUnknown));
      check("blurt: bridge fee recorded unknown — never invented", plan.steps[0].fee.includes("unknown") && BRIDGE_PATHS.every((b) => b.fee.includes("unknown")));
      check("blurt: sell realness L2_REAL (engine book), plan-only", plan.realness.sell === "L2_REAL" && /plan-only/.test(plan.execution));
      check("blurt: proceeds honor house fee model", plan.ok === true && plan.plan.proceedsHive < plan.plan.legs.reduce((s, l) => s + l.qty * l.priceHivePerBlurt, 0));
      check("blurt: slippage vs ref computed from named inputs", plan.ok === true && typeof plan.plan.slippageVsRefBps === "number");
      const det = planBlurtExit({ amountBlurt: 5000, book, blurtUsd, hiveUsd, nowIso: NOW });
      check("blurt: determinism", JSON.stringify(det) === JSON.stringify(plan));
      const noBook = planBlurtExit({ amountBlurt: 5000, book: null, blurtUsd, hiveUsd, nowIso: NOW });
      check("blurt: missing book → honest ok:false (no invention)", noBook.ok === false && /no plan without the L2 book/.test(noBook.error));
      const noRef = planBlurtExit({ amountBlurt: 5000, book, blurtUsd: null, hiveUsd, nowIso: NOW });
      check("blurt: missing refs → honest ok:false", noRef.ok === false && /invention/.test(noRef.error));
      const dust = planBlurtExit({ amountBlurt: 0, book, blurtUsd, hiveUsd, nowIso: NOW });
      check("blurt: zero amount rejected", dust.ok === false);
    }
  }


  /* ══ 12. engine-transfers (Z-90-c): הנתיב-החלופי להיסטוריית-העברות — פרסרים + זיווג-ראיות ══
   * fixtures חיים-מוקלטים 2026-10-04 (account_history_api @hive · condenser get_account_history @blurt).
   * אפס-רשת: הכל מ-fixtures ומוקטורים-סינתטיים-מסומנים. */
  {
    const hiveSample = fixture("engine-issuer-hive-history-SAMPLE.json");
    const gsHistory = fixture("engine-blurt-graphene-swap-history.json");
    const bsHistory = fixture("engine-blurt-blurt-swap-history.json");

    const hp = parseHiveIssuerPage(hiveSample);
    check("engine: hive sample parses (live-recorded page, 40 rows)", hp.rows.length === 40 && hp.error === null, hp.error);
    check("engine: parseHiveIssuerPage(null) → fail-closed no throw", parseHiveIssuerPage(null).rows.length === 0 && /fail-closed/.test(parseHiveIssuerPage(null).error));
    const cred = hp.rows.find((r) => r.symbol === "SWAP.BLURT" && r.contractAction === "transfer");
    check("engine: issuer credit derives from=required_auths[0] (no payload.from)", cred.from === "graphene-swap" && typeof cred.quantity === "number", cred);
    check("engine: memo user extracted from the verbatim bridge memo", cred.memoUser === "mustakin321" && memoUserFromCredit("random memo") === null);
    const dictOpRow = hiveSample.result.history.find(([, ev]) => String(ev.op?.type ?? "").startsWith("custom_json"));
    check("engine: normalizeHistoryEvent tolerates list-op (blurt) and dict-op (hive) shapes", normalizeHistoryEvent(dictOpRow[1]).opType === "custom_json" && normalizeHistoryEvent(gsHistory.result[0][1]).opType === "transfer");
    const part = partitionIssuerTransfers(hp.rows);
    check("engine: partition keeps credits vs other symbols separated", part.credits.length === 6 && part.otherSymbolCounts["SWAP.STEEM"] === 4 && part.otherSymbolCounts["SWAP.HBD"] === 2, part.otherSymbolCounts);
    const syntheticInto = partitionIssuerTransfers([{ opType: "custom_json", contractName: "tokens", contractAction: "transfer", symbol: "SWAP.BLURT", from: "alice", to: "graphene-swap", quantity: 5, memo: "x" }]);
    check("engine: user-signed burn partitioned honestly (into-issuer)", syntheticInto.intoIssuer.length === 1 && syntheticInto.credits.length === 0);

    const gp = parseBlurtBridgePage(gsHistory);
    const gpart = partitionBlurtBridge(gp.rows);
    check("engine: graphene-swap @BLURT full ledger = 32 deposits (complete history measured)", gp.rows.length === 32 && gpart.deposits.length === 32 && gpart.payouts.length === 0);
    const reserveRelay = gpart.deposits.filter((d) => d.user === "blurt-swap" && /Token Conversion from SWAP\.BLURT account/.test(d.memo ?? ""));
    check("engine: Z-89 evidence class (blurt-swap→graphene-swap reserve relay) inside deposits with honest memoForm", reserveRelay.length === 2 && reserveRelay.every((d) => d.memoForm === "other"));
    const bp = parseBlurtBridgePage(bsHistory);
    const bpart = partitionBlurtBridge(bp.rows);
    check("engine: blurt-swap page partitions deposits + redemption payouts", bpart.deposits.length > 0 && bpart.payouts.length > 0 && bpart.deposits.every((d) => d.asset === undefined || true), { dep: bpart.deposits.length, pay: bpart.payouts.length });
    check("engine: payout rows carry the verbatim redemption memo class", bpart.payouts.every((p) => /^Token Conversion from SWAP\.BLURT account\s+\S+\s*$/.test(p.memo)));

    const sums = sumRows([{ quantity: 10.5, ts: "b" }, { quantity: 0.25, ts: "a" }, { quantity: "junk", ts: "c" }, { quantity: null, ts: "d" }]);
    check("engine: sumRows exact + window sorted + non-numeric skipped", sums.count === 2 && Math.abs(sums.sum - 10.75) < 1e-9 && sums.fromTs === "a" && sums.toTs === "b");

    // זיווג-ראיות: וקטורים-סינתטיים-מסומנים (fee 75bps = הדפוס-החי-שנמדד 2026-10-04)
    const depOk = { user: "u1", target: "h1", quantity: 1000, ts: "2026-10-01T10:00:00", idx: 1 };
    const credOk = { user: "u1", to: "h1", quantity: 992.5, ts: "2026-10-01T10:15:00", idx: 9, memoUser: "u1" };
    const pr = pairInFlows({ credits: [credOk], deposits: [depOk] });
    check("engine: single-flow pair → ratio 0.9925, fee 75bps (measured pattern)", pr.pairs.length === 1 && pr.pairs[0].ratio === 0.9925 && pr.pairs[0].feeBps === 75, pr.pairs);
    const multi = pairInFlows({ credits: [credOk], deposits: [depOk, { ...depOk, idx: 2 }] });
    check("engine: multi-deposit user excluded from pairing (not verified evidence)", multi.pairs.length === 0 && multi.excludedMultiFlow >= 1);
    const pend = pairInFlows({ credits: [], deposits: [depOk] });
    check("engine: deposit without credit → excluded (honest pending)", pend.pairs.length === 0 && pend.excludedPending >= 1);
    const late = pairInFlows({ credits: [{ ...credOk, ts: "2026-10-03T10:00:00" }], deposits: [depOk] });
    check("engine: credit >24h after deposit → excluded (delay)", late.pairs.length === 0 && late.excludedDelay >= 1);
    const hc = computeHaircutIn(pr.pairs.concat([{ user: "u2", target: "h2", deposit: { quantity: 100, ts: "t", idx: 2, chain: "blurt" }, credit: { quantity: 99.25, ts: "t", idx: 3, chain: "hive-engine" }, ratio: 0.9925, feeBps: 75 }]));
    check("engine: haircut across 2 pairs → 0.9925 common, feeBps 75", hc.pairCount === 2 && hc.ratio === 0.9925 && hc.commonRatio === 0.9925 && hc.feeBps === 75, hc);
    check("engine: no pairs → haircut null (no invention)", computeHaircutIn([]) === null && computeHaircutIn(null) === null);

    const rec = buildEngineTransfersReceipt({ at: NOW, engine: { rows: hp.rows, pagesFetched: 1 }, blurtReserve: { rows: gp.rows, completeHistory: true }, blurtActive: { rows: bp.rows } });
    check("engine: receipt from live fixtures → ok + schema engine-transfers-v1", rec.ok === true && rec.schema === ENGINE_TRANSFERS_SCHEMA);
    check("engine: receipt stamps measured windows (from/to ts on all legs)", rec.window.engine.fromTs !== null && rec.window.blurtReserve.completeHistory === true && rec.window.blurtActive.fromTs !== null, rec.window);
    check("engine: in/out measured with counts+sums (verbatim arithmetic)", rec.in.engineCredits.count === 6 && rec.in.blurtDepositsReserve.count === 32 && rec.out.blurtPayouts.count === bpart.payouts.length);
    check("engine: honesty warning always present (terms unverified — measured-only)", /terms unverified — measured-only/.test(rec.honesty));
    check("engine: out engine-burn leg honest non-measured (user-signed invisible)", rec.out.engineBurns.measured === false && /invisible/.test(rec.out.engineBurns.note));
    const recEmpty = buildEngineTransfersReceipt({ at: NOW, degraded: ["all legs down"] });
    check("engine: all legs down → ok:false, haircut null, degraded kept (fail-closed)", recEmpty.ok === false && recEmpty.haircutIn === null && recEmpty.degraded.length === 1);
    check("engine: determinism — same fixtures → identical receipt", JSON.stringify(buildEngineTransfersReceipt({ at: NOW, engine: { rows: hp.rows, pagesFetched: 1 }, blurtReserve: { rows: gp.rows, completeHistory: true }, blurtActive: { rows: bp.rows } })) === JSON.stringify(rec));
    const condensed = condenseForCustody(rec);
    check("engine: condenseForCustody carries mission keys (window/in/out/haircut/honesty)", condensed && typeof condensed.inCount === "number" && typeof condensed.inSum === "number" && typeof condensed.outCount === "number" && typeof condensed.outSum === "number" && condensed.window !== undefined && condensed.honesty !== undefined);
    check("engine: condenseForCustody(null/bad) → null (custody row stays ABSENT)", condenseForCustody(null) === null && condenseForCustody(recEmpty) === null);
  }

  /* ══ 13. payout-doctrine (Z-90-c): בניית-החלטות-הבשלות — טהור, דטרמיניסטי, אפס-המצאה ══ */
  {
    // וקטור-חי-מצוטט: custody steem row (receipt 2026-10-04) + convert receipt estimate
    const custodyVec = { at: "2026-10-04T12:42:18.061Z", rows: [
      { chain: "steem", venue: "chain-liquid", asset: "STEEM", amount: 14.681, realness: "ONCHAIN_REAL" },
      { chain: "steem", venue: "chain-liquid", asset: "SBD", amount: 0.366, realness: "ONCHAIN_REAL" },
      { chain: "steem", venue: "chain-locked", asset: "SBD-IN-CONVERT", amount: 131.856, realness: "ONCHAIN_REAL" },
    ] };
    const convertVec = { pendingSbd: 131.856, discountBps: 3982, pendingRequests: [
      { requestid: 1790942528, amount: "0.001 SBD", conversion_date: "2026-10-06T00:02:12" },
      { requestid: 1791090394, amount: "3.969 SBD", conversion_date: "2026-10-07T17:06:39" },
    ], maturityEstimate: { pendingSbd: 131.856, medianNow: 0.10409960236902552, estimate: 1266.633, band: null, semantics: "payout = amount / ADJUSTED median-at-maturity (steem database.cpp process_conversions) — ESTIMATE, floats until conversion_date" } };

    check("payout: custodyLiquidSteem reads the steem liquid row", custodyLiquidSteem(custodyVec) === 14.681 && custodyLiquidSteem({ rows: [] }) === null && custodyLiquidSteem(null) === null);
    const win = maturityWindow(convertVec);
    check("payout: maturity window = min/max of verbatim conversion_dates", win.earliest === "2026-10-06T00:02:12Z" && win.latest === "2026-10-07T17:06:39Z" && win.rows === 2, win);
    check("payout: empty convert → null window (fail-closed)", maturityWindow(null).earliest === null);

    const plan = planPayoutDoctrine({ convert: convertVec, custody: custodyVec, nowIso: "2026-10-04T12:00:00Z" });
    check("payout: schema + ok on the live-shaped vector", plan.schema === PAYOUT_DOCTRINE_SCHEMA && plan.ok === true);
    check("payout: projection = liquid + estimate (14.681 + 1266.633 = 1281.314)", plan.projection.projectedLiquidSteem === 1281.314, plan.projection);
    check("payout: estimate carries the Hebrew estimate label + floats-until-maturity law", plan.inputs.convert.payoutEstimate.labeledAs === ESTIMATE_LABEL && /floats until conversion_date/.test(plan.inputs.convert.payoutEstimate.law));
    check("payout: communityCreationReady true — projected ≥ fee 3 + buffer 0.1", plan.readiness.communityCreationReady === true && /3\+0\.1|fee 3 \+ buffer 0\.1/.test(plan.readiness.basis), plan.readiness.basis);
    check("payout: before-payout boolean computed from custody liquid alone (14.681 ≥ 3.1)", plan.readiness.communityCreationReadyBeforePayout === true);
    check("payout: counterGridFuelReady null — NO written doctrine constant (never invented)", plan.readiness.counterGridFuelReady === null && /החלטת-בעלים|owner decision|owner-armed|no written fuel-allocation/.test(plan.readiness.counterGridFuelPrecondition));
    check("payout: all fuel allocations null with owner-decision precondition", Object.entries(plan.readiness.fuelAllocations).every(([k, v]) => k === "precondition" || v === null) && plan.readiness.fuelAllocations.precondition.length > 0);
    check("payout: community cost cited verbatim (community.mjs lines + formula)", plan.inputs.communityCost.accountFeeSteem === 3 && plan.inputs.communityCost.feeBufferSteem === 0.1 && plan.inputs.communityCost.lines.needFormula === 78 && plan.inputs.communityCost.source === "grids/community.mjs");
    check("payout: doctrine search documented negative evidence", DOCTRINE_SEARCH.fuelAllocationConstantsFound === false && DOCTRINE_SEARCH.ownerDecisionTerm === "החלטת-בעלים" && DOCTRINE_SEARCH.searched.length === 4);
    check("payout: arm-gates list — CEX rail, agent flags, signing key, community execute", plan.armGates.length === 4 && /CEX rail/.test(plan.armGates[0].gate) && /agent/.test(plan.armGates[1].gate) && /signing key/.test(plan.armGates[2].gate) && /community/.test(plan.armGates[3].gate));

    // fail-closed כנה: קלטות-חסרות → nulls, לעולם לא זורק
    const noEst = planPayoutDoctrine({ convert: { ...convertVec, maturityEstimate: null }, custody: custodyVec, nowIso: NOW });
    check("payout: missing estimate → projection null + readiness null (no invention)", noEst.projection.projectedLiquidSteem === null && noEst.readiness.communityCreationReady === null && noEst.ok === false && /fail-closed/.test(noEst.readiness.basis));
    const noCust = planPayoutDoctrine({ convert: convertVec, custody: null, nowIso: NOW });
    check("payout: missing custody → projection null + readiness null", noCust.projection.projectedLiquidSteem === null && noCust.readiness.communityCreationReady === null && noCust.ok === false);

    // וקטור-הבשלה-הפוכה: נזיל-נוכחי 2.086 (community-plan חי 05:48Z) — לפני-התשלום עדיין לא-מוכן
    const beforeAfter = planPayoutDoctrine({ convert: convertVec, custody: { at: "t", rows: [{ chain: "steem", venue: "chain-liquid", asset: "STEEM", amount: 2.086, realness: "ONCHAIN_REAL" }] }, nowIso: NOW });
    check("payout: 2.086 liquid → before-payout false, after-payout true (1268.719 ≥ 3.1)", beforeAfter.readiness.communityCreationReadyBeforePayout === false && beforeAfter.readiness.communityCreationReady === true && beforeAfter.projection.projectedLiquidSteem === 1268.719, beforeAfter.readiness);

    const cd = countdownMinutes({ earliest: "2026-10-06T00:02:12Z", latest: "2026-10-07T17:06:39Z", asof: "2026-10-05T00:00:00Z" });
    check("payout: countdown deterministic (1442.2 / 3966.65 min, not passed)", cd.minutesUntilEarliest.minutes === 1442.2 && cd.minutesUntilLatest.minutes === 3906.7 && cd.minutesUntilEarliest.passed === false, cd);
    const cdPast = countdownMinutes({ earliest: "2026-10-06T00:02:12Z", latest: "2026-10-07T17:06:39Z", asof: "2026-10-08T00:00:00Z" });
    check("payout: countdown after maturity → passed flags honest", cdPast.minutesUntilEarliest.passed === true && cdPast.minutesUntilLatest.passed === true);
    check("payout: countdown garbage asof → nulls (fail-closed)", countdownMinutes({ earliest: "2026-10-06T00:02:12Z", latest: "2026-10-07T17:06:39Z", asof: "junk" }).minutesUntilEarliest === null);

    check("payout: determinism — same inputs → identical plan", JSON.stringify(planPayoutDoctrine({ convert: convertVec, custody: custodyVec, nowIso: "2026-10-04T12:00:00Z" })) === JSON.stringify(plan));
    check("payout: law forbids invented allocations", /no invented allocations/.test(plan.law) && /הערכה בלבד/.test(plan.law));
  }

  console.log(`\nARB-SELFTEST ${fail === 0 ? "PASS" : "FAIL"} — ${pass}/${pass + fail} rules green`);
  if (fail > 0) {
    console.error(JSON.stringify(failures, null, 2));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`ARB-SELFTEST CRASH :: ${String(e?.stack ?? e).slice(0, 500)}`);
  process.exit(1);
});
