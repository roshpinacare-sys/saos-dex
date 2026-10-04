// SPLIT-ROUTER — מתכנן-פיצול-לעומק לסכומים-גדולים (Z-87a · plan-only · audit-Z86c פער-d)
// ═══════════════════════════════════════════════════════════════════════════════
// קלט: זוג + כמות + ספרים (רמות-מחיר/עומק). פלט: תוכנית-רגליים על-פני רמות-מחיר
// עם מחיר-ממוצע (vwap), impact-bps, סניטי-מול-חציון-הפיד, ואזהרות DEPTH-LIMIT.
//
// חוקי-ברזל:
//   1. PLAN-ONLY — המודול אינו חותם, אינו משדר, אינו נוגע במפתחות. קבלה-בלבד.
//   2. חוק-הספר (Z-80) נאכף כאן: אין-ספר-חי → אין-תוכנית (fail-closed); הפיכת
//      רגלי-taker לפקודות-maker עוברת crossAudit מחייב (ביד ≤ bestBid / אסק ≥ bestAsk).
//   3. אופטימליות-כנה: הליכה-חמדנית על-עומק פיסותי-ליניארי היא האופטימום
//      (הרמה-הטובה-ביותר נצרכת ראשונה — זהות מבנית); הקבלה מול מילוי-בודד-נאיבי
//      נמדדת ונרשמת (improvementBps) — לא-נטען בלי-מדידה.
//   4. אף-מספר-מומצא: הכל מחושב מהרמות-שהתקבלו; עמלה = מודל-הבית FEE_BPS לרגל.
//   5. דטרמיניזם: אותן-קלטות → אותה-תוכנית; הזמן מוזרק.

import { normBook, crossAudit, touchSpreadBps } from "./book-law.mjs";
import { FEE_BPS, r6, num } from "./arb-scan.mjs";
import { steemBookFeed, htxDepthFeed, binanceTopFeed, condenserMedianFeed, NODES_STEEM } from "./arb-scan.mjs";

/** מיזוג-ספרים לצד-אחד עם נירמול-יחידות (quoteToUsd לכל-ספר) — ממוין-לטובת-הלוקח. */
export function mergeBooks(books, side) {
  const out = [];
  for (const b of Array.isArray(books) ? books : []) {
    const f = Number(b?.quoteToUsd ?? 1);
    if (!Number.isFinite(f) || f <= 0) continue;
    const levels = side === "buy" ? (b?.asks ?? []) : (b?.bids ?? []);
    for (const l of levels) {
      const price = num(l?.price), qty = num(l?.qty);
      const feeBps = Number.isFinite(l?.feeBps) ? l.feeBps : (Number.isFinite(b?.feeBps) ? b.feeBps : FEE_BPS);
      if (!(price > 0) || !(qty > 0)) continue;
      out.push({ price: r6(price * f), qty, venue: b?.venue ?? "unknown", realness: b?.realness ?? "PAPER", feeBps, quoteToUsd: f });
    }
  }
  out.sort((a, b2) => (side === "buy" ? a.price - b2.price : b2.price - a.price));
  return out;
}

/** הליכה-חמדנית על-רמות-ממוינות (האופטימום לעומק פיסותי-ליניארי). */
export function walkDepth(levels, amount, side) {
  const legs = [];
  let remaining = amount, filled = 0, cost = 0;
  for (const l of Array.isArray(levels) ? levels : []) {
    if (remaining <= 1e-12) break;
    const take = Math.min(remaining, l.qty);
    const feeAdj = side === "buy" ? l.price * (1 + l.feeBps / 1e4) : l.price * (1 - l.feeBps / 1e4);
    const legCost = take * feeAdj;
    legs.push({ venue: l.venue, realness: l.realness, qty: r6(take), priceRaw: r6(l.price), priceEff: r6(feeAdj), cost: r6(legCost), feeBps: l.feeBps });
    filled += take; cost += legCost; remaining -= take;
  }
  return { legs, filled: r6(filled), cost: r6(cost), vwap: filled > 0 ? r6(cost / filled) : null, unfilled: r6(Math.max(0, remaining)) };
}

/** מילוי-בודד-נאיבי: כל-הסכום אצל-הוניו-הראשון-בעל-עומק (בסיס-השוואה לשיפור). */
export function naiveSingleVenue(levels, amount, side) {
  if (!Array.isArray(levels) || levels.length === 0) return { vwap: null, venue: null };
  const firstVenue = levels[0].venue;
  const own = levels.filter((l) => l.venue === firstVenue);
  const r = walkDepth(own, amount, side);
  return { vwap: r.vwap, venue: firstVenue, filled: r.filled };
}

/**
 * התוכנית הטהורה. levels: [{price, qty, venue, realness, feeBps}] — ביחידות-ציטוט
 * אחידות (מומלץ: mergeBooks עם quoteToUsd). medianRef: סמכות-החציון באותן-יחידות.
 */
export function planSplit({ pair = "?", side, amount, levels, medianRef = null, nowIso = null } = {}) {
  const warnings = [];
  if (side !== "buy" && side !== "sell") return { ok: false, error: "side must be buy|sell", warnings };
  if (!Number.isFinite(amount) || !(amount > 0)) return { ok: false, error: "amount must be > 0", warnings };
  if (!Array.isArray(levels) || levels.length === 0) return { ok: false, error: "no live depth supplied (fail-closed — no plan without a book)", warnings };

  // סידור-הגנתי דטרמיניסטי (הקורא עשוי שלא למיין): הרמה-הטובה-ביותר ראשונה
  levels = [...levels].sort((a, b) => (side === "buy" ? a.price - b.price : b.price - a.price));
  const bestRaw = levels[0].price;
  const bookShaped = side === "buy"
    ? { bestAsk: levels[0].price, bestBid: null }
    : { bestAsk: null, bestBid: levels[0].price };
  const nb = normBook(bookShaped);
  if (nb.bestAsk == null && nb.bestBid == null) return { ok: false, error: "book unusable (fail-closed)", warnings };

  const walk = walkDepth(levels, amount, side);
  if (walk.legs.length === 0) return { ok: false, error: "depth walk produced no legs", warnings };

  // עומק-מגע-ומילוי-בודד: כמה היה אפשר לקבל על-המגע לבדו
  const touchQty = levels[0].qty;
  const touchEff = side === "buy" ? levels[0].price * (1 + levels[0].feeBps / 1e4) : levels[0].price * (1 - levels[0].feeBps / 1e4);
  const singleFillable = Math.min(amount, touchQty);
  const single = naiveSingleVenue(levels, amount, side);

  // שיפור-הפיצול מול-המילוי-הנאיבי (מדידה — לא-טענה): (naive−split)/naive לקנייה
  let improvementBps = null;
  // ההשוואה תקפה רק כשהוניו-הראשון באמת מכסה-את-הסכום; אחרת null —
  // אסור להשוות vwap-חלקי-מול-מילוי-מלא (כנות-מדידה).
  if (single.vwap != null && single.vwap > 0 && walk.vwap != null && single.filled >= amount - 1e-9) {
    improvementBps = r6(((single.vwap - walk.vwap) / single.vwap) * 1e4 * (side === "buy" ? 1 : -1));
  }

  const impactBps = r6((Math.abs(walk.vwap - bestRaw) / bestRaw) * 1e4);

  // סניטי-מול-חציון-הפיד (>15% סטייה = דגל, לא-כשל — כנות)
  let sanity = { medianRef, deviationBps: null, flagged: false };
  if (medianRef != null && medianRef > 0 && walk.vwap != null) {
    const dev = r6(((walk.vwap - medianRef) / medianRef) * 1e4);
    sanity = { medianRef, deviationBps: dev, flagged: Math.abs(dev) > 1500 };
    if (sanity.flagged) warnings.push(`SANITY-FLAG: vwap deviates ${dev}bps from median feed ${medianRef} (>15%) — depeg/oracle check before acting`);
  }

  if (walk.filled < amount) warnings.push(`DEPTH-LIMIT: only ${walk.filled} of ${amount} fillable across ${new Set(walk.legs.map((l) => l.venue)).size} venue(s)`);
  const paperVenues = [...new Set(walk.legs.filter((l) => l.realness === "CEX_REF" || l.realness === "PAPER").map((l) => l.venue))];
  if (paperVenues.length > 0) warnings.push(`PAPER-LEGS: ${paperVenues.join(", ")} are REF quotes until a wallet rail is armed`);

  return {
    ok: true, pair, side, amount, nowIso: nowIso ?? null,
    fillable: walk.filled, unfilled: walk.unfilled,
    vwap: walk.vwap, touchRaw: r6(bestRaw), touchEff: r6(touchEff),
    impactBps, feeTotalQuote: r6(walk.legs.reduce((s, l) => s + l.cost * (l.feeBps / (side === "buy" ? 1e4 + l.feeBps : 1e4 - l.feeBps)), 0)),
    legs: walk.legs,
    touchDepth: r6(touchQty), singleFill: { fillable: r6(singleFillable), vwapAtTouch: r6(touchEff) },
    splitVsNaive: { naiveVenue: single.venue, naiveVwap: single.vwap, improvementBps },
    sanity,
    realness: worstOf(walk.legs.map((l) => l.realness)),
    warnings,
    law: "plan-only (Z-87a): no signing, no broadcast — maker repost goes through book-law crossAudit",
  };
}

function worstOf(tags) {
  const rank = { ONCHAIN_REAL: 4, L2_REAL: 3, CEX_REF: 2, PAPER: 1, DEGRADED: 0 };
  let w = "ONCHAIN_REAL";
  for (const t of tags) if ((rank[t] ?? -1) < (rank[w] ?? -1)) w = t;
  return w;
}

/** הפיכת-תוכנית-taker לפקודות-maker מנוחה — כל-רגל עוברת crossAudit מחייב (Z-80). */
export function makerRepost(legs, side, book) {
  const nb = normBook(book);
  const out = [];
  for (const l of Array.isArray(legs) ? legs : []) {
    // קנייה כ-maker = בידים; מכירה כ-maker = אסקים. המחיר נצמד למגע מבלי-לחצות.
    const raw = side === "buy" ? Math.min(l.priceRaw, nb.bestBid ?? l.priceRaw) : Math.max(l.priceRaw, nb.bestAsk ?? l.priceRaw);
    const post = r6(raw);
    const auditSide = side === "buy" ? "bid" : "ask";
    // Z-80: crossAudit מחייב ספר-דו-צדדי-חי; ספר-חסר-צד → fail-closed כנה
    const audit = crossAudit({ side: auditSide, price: post }, book);
    out.push({ ...l, makerPrice: audit.ok ? post : null, audit: audit.ok ? "pass" : audit.why, clamped: post !== l.priceRaw });
  }
  const allPass = out.length > 0 && out.every((l) => l.audit === "pass");
  return { ok: allPass, legs: out, book: nb, touchSpreadBps: touchSpreadBps(book) };
}

/* ══ ריצה-חיה (plan-only): ספרים-חיים → תוכנית → קבלה ══════════════════════ */

/** תוכנית-חיה על-STEEM:SBD: ספר-פנים (SBD) + HTX/Binance (USDT≈USD) מנורמלים ל-USD. */
export async function planSplitSteemUsd({ side, amount, fetchImpl = fetch, nowIso = null } = {}) {
  const [bookRes, htxRes, binRes, medRes] = await Promise.allSettled([
    steemBookFeed({ fetchImpl }), htxDepthFeed("steemusdt", { fetchImpl }),
    binanceTopFeed("STEEMUSDT", { fetchImpl }), condenserMedianFeed({ nodes: NODES_STEEM, fetchImpl }),
  ]);
  const ok = (r) => (r.status === "fulfilled" && r.value.ok ? r.value : null);
  const book = ok(bookRes)?.data ?? null;
  const htx = ok(htxRes)?.data ?? null;
  const bin = ok(binRes)?.data ?? null;
  const median = ok(medRes)?.data?.price ?? null;
  if (!book) return { ok: false, error: "steem internal book unavailable (fail-closed)" };
  // שער-SBD/USD נדרש לנירמול — מתקבל-מהקורא; כאן נגזר מהעומק-הפנים-עצמו אם-אפשר:
  // הסמכות-הכנה: מידוד-הפיד. נשתמש ב-ref-feed של arb-scan.
  const { measureRefs } = await import("./arb-scan.mjs");
  const refsBox = await measureRefs({ fetchImpl });
  const sbdUsd = refsBox?.refs?.sbdUsd ?? null;
  if (sbdUsd == null) return { ok: false, error: "no SBD/USD ref — cross-unit merge would require invention (fail-closed)" };
  const books = [{ ...book, quoteToUsd: sbdUsd, venue: "steem-internal", realness: "ONCHAIN_REAL" }];
  if (htx) books.push({ ...htx, quoteToUsd: 1, venue: "htx", realness: "CEX_REF" });
  if (bin) books.push({ ...bin, quoteToUsd: 1, venue: "binance", realness: "CEX_REF" });
  const levels = mergeBooks(books, side);
  const medianUsd = median != null ? median * sbdUsd : null; // חציון-הפיד ב-USD
  const plan = planSplit({ pair: "STEEM:SBD", side, amount, levels, medianRef: medianUsd, nowIso });
  return { ...plan, measured: { sbdUsd, medianSbdPerSteem: median, booksUsed: books.map((b) => b.venue) } };
}

/* ── CLI: node grids/split-router.mjs --side buy --amount 500 [--receipt] ── */
const isCli = process.argv[1] && process.argv[1].endsWith("split-router.mjs");
if (isCli && !process.argv.includes("--selftest")) {
  const argOf = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
  const side = argOf("--side", "buy");
  const amount = Number(argOf("--amount", "500"));
  try {
    const plan = await planSplitSteemUsd({ side, amount, nowIso: new Date().toISOString() });
    console.log(JSON.stringify(plan, null, 1));
    if (plan.ok && process.argv.includes("--receipt")) {
      const { writeFileSync, mkdirSync } = await import("node:fs");
      const path = (await import("node:path")).join((await import("node:url")).fileURLToPath(new URL(".", import.meta.url)), "state", "split-router-plan.json");
      mkdirSync((await import("node:path")).dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(plan, null, 1) + "\n");
      console.log(`[split-router] plan receipt written: ${path} (plan-only — no orders placed)`);
    }
  } catch (e) {
    console.error(`[split-router] honest failure: ${String(e?.message ?? e).slice(0, 140)}`);
    process.exit(2);
  }
}
