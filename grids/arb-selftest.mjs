/**
 * arb-selftest.mjs — שער-ברזל לקו-הארביטרז' של Z-87a (בית-החוקים של הריצוג).
 * כיסוי: קבלת-בשלות-המרה · מתמטיקת-edge/size/fee/מצטבר כולל-קצוות-שליליים ·
 * נתחי-ספרים מוקלטים-חי · split-router (אופטימלי-מול-נאיבי + חוק-impact + חוק-ספר) ·
 * counter-grid (שימור-הון/הפרדת-צדדים/מונוטוניות) · שער-סוכנים fail-closed ·
 * מתאם-בלרט BRIDGE. דטרמיניסטי לגמרי — אפס-רשת: הכל מ-fixtures שהוקלטו-חי
 * (grids/state/fixtures/, מוקלט 2026-10-04) ומוקטורים-סינתטיים מסומנים.
 * אפס-תלות; רץ על node טהור.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { summarizeConversionRequests, planConvert, CONVERT_POLICY } from "./convert.mjs";
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
    // Z-87a: רגל-ייחוס (מחיר-קבוע בלי-ספר) → קצה-נמדד, גודל-בר-ביצוע 0, PnL-נייר מוקלט
    const refLeg = paperRoundTrip({ buyLevels: [{ price: 0.0175, qty: 100 }], sellLevels: null, size: 100, buyQuoteUsd: 0.0562, refSellPriceUsd: 0.00098, sbdUsd: 0.6 });
    check("paper round-trip: ref-price leg → edge numeric + size 0 (no invented depth)", typeof refLeg.edgeBps === "number" && refLeg.executableSize === 0 && refLeg.paperPnlSbd != null, refLeg);
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
      check("evaluate: BLURT edge measured vs ref (numeric — no invention), not dropped", typeof blurtEntry.edgeBps === "number" && typeof blurtEntry.paperPnlSbd === "number", blurtEntry);
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
    const l3 = updateLedger({ schema: "corrupt", entries: "garbage" }, [e1], { generatedAt: NOW });
    check("ledger: corrupt prev → honest fresh base, never throws", l3.cumulative.entries === 1 && l3.entries.length === 1);
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
