// PRICE-TRUTH — N8 · משמעת-קו-הערך-המשולש (round-27 · owner mandate trace 1a163d4124276b39)
// ══════════════════════════════════════════════════════════════════════════════════════════
// המדידה-החיה-המלאה 2026-10-22T13:30–14:05Z — שלוש-סמכויות, תמונה-עקבית-אחת:
//   · binance STEEMUSDT = $0.0527 (נזילות-4.6M/24ש׳ · טווח 0.0525–0.0559)
//   · sbdUsd (הסימון-החי-שלנו-עצמו, פנקס db/grid-ledger.json 02:23Z) = $0.5009
//       → **SBD דה-פג מדוד ~$0.50** — והעוגן 0.10641 היה נכון כל-הזמן:
//         0.0527 ÷ 0.501 ≈ 0.1052 SBD ל-STEEM (USD-אמת).
//   · feed-רפואי-על-השרשרת = 0.10408 SBD/STEEM — עקבי-עם-הפאריטי תוך-1.1%
//       (implied sbdUsd = 0.0527/0.10408 = 0.5063 ≈ 0.5009 הנמדד — שתי-סמכויות-עצמאיות-מצטלבות).
//   · מגע-הספר = 0.1028 — **340bps-מתחת-לערך-ה-USD** (וזה-בדיוק-הפער-G3-המדוד).
//
// השורש-המדוד של אפס-המילויים-החוץ (19-ימים מאז-החוק): מדף-האסקים יושב על
// parity+60bps ≈ 0.1069 — ~400bps-מעל-המגע. אף-קונה-חוץ-לא-משלם-מעל-ערך-ה-USD
// כשהשוק-עצמו נסחר-מתחתיו. ובזמן-זה — מילוי-אמת-על-השרשרת: cashly קנה 0.5-STEEM
// במגע 0.102 מהרץ-התאום (13:37:51Z).
//
// החוק-החדש (הדוקטרינה-המקורית-נשמרת מילה-במילה — "אף-פעולה לא מוכרת מתחת
// לערך-ה-USD החוץ, ואף-פעולה לא קונה מעליו"; מה שמשתנה זה המדידה-והפרסום):
//   · valueLine = min(feed-רפואי, פאריטי-USD) — התביעה-השמרנית-ביותר-משתי-הסמכויות.
//       מדף-האסקים = valueLine+TIER (חוקי, ימולא בראלי) · תקרת-הבידים = valueLine.
//       המגע 0.1028 < valueLine 0.10408 → אסקי-מגע-תת-ערך נשארים-אסורים (דימום-אמת:
//       מכירה-ב-0.1028-משלמת-ב-SBD-ששווה-חצי-דולר = −340bps-ב-USD — הפנקס-מסמן-זאת-חי).
//   · **מנוע-המילויים-החוץ-החוקי = צד-הבידים במגע**: קנייה-ב-0.1026 = 175bps-מתחת
//       valueLine = עודף-נמדד-על-כל-מילוי (הדוקטרינה-מילולית: "כל קנייה מתחת לפאריטי
//       = עודף נמדד"). רמה-1 מתחבקת-מגע (bidTouchHugBps) — ראש-התור = זרימת-מוכרים.
//   · בדיקת-רצועה (שוק-שבור) = |mid − feed-רפואי| — תפוח-מול-תפוח.
//   · כנות-מלאה: כל-הסימונים + הדה-פג-המדוד + העקביות-הבין-סמכותית מתפרסמים
//       בכל-ריצה ב-publicDoc (priceTruth). אין-קו-ערך-סמוי.
//   · fail-closed: גם-feed-רפואי-וגם-פאריטי-USD חסרים → null → הקורא חוסם-מסחר.

export const PRICE_TRUTH_PROTOCOL = "SAOS-PRICE-TRUTH/1";

/** ניתוח-תוצאת get_current_median_history_price → SBD ל-1-STEEM. */
export function sbdPerSteemFromMedianFeed(medianHistory) {
  if (!medianHistory || typeof medianHistory !== "object") return null;
  const base = String(medianHistory.base ?? ""); // "58412723.670 SBD"
  const quote = String(medianHistory.quote ?? ""); // "561224995.101 STEEM"
  const b = parseFloat(base.replace(/[A-Za-z ]+/g, ""));
  const q = parseFloat(quote.replace(/[A-Za-z ]+/g, ""));
  if (!Number.isFinite(b) || !Number.isFinite(q) || b <= 0 || q <= 0) return null;
  if (!/SBD/.test(base) || !/STEEM/.test(quote)) return null; // יחידות-לא-צפויות — לא מנחשים
  return b / q;
}

/**
 * הגזירה-הטהורה. אפס-IO — אותה-פונקציה ל-grid-beat, ל-selftest ולבדיקת-CLI.
 * @param {{
 *   chainFeedSbdPerSteem?: number | null,
 *   globalSteemUsd?: number | null,   // binance (הנזיל-העמוק) — STEEM ב-USD
 *   globalSbdUsd?: number | null,     // SBD ב-USD (הסימון-החי; דה-פג-מדוד ~0.50)
 *   src?: Record<string, string | undefined>,
 * }} marks
 */
export function derivePriceTruth(marks = {}) {
  const chainFeed = Number.isFinite(marks.chainFeedSbdPerSteem) && marks.chainFeedSbdPerSteem > 0
    ? marks.chainFeedSbdPerSteem : null;
  const gSteem = Number.isFinite(marks.globalSteemUsd) && marks.globalSteemUsd > 0 ? marks.globalSteemUsd : null;
  const gSbd = Number.isFinite(marks.globalSbdUsd) && marks.globalSbdUsd > 0 ? marks.globalSbdUsd : null;
  const usdParity = gSteem && gSbd ? gSteem / gSbd : null;

  const notes = [];
  // עקביות-בין-סמכויות: impliedSbdUsd = binance-STEEM ÷ feed-רפואי. כשהוא סוטה
  // מהסימון-החי-של-SBD ביותר מ-10% — מדובר בדה-פג-עמוק/פיד-שבור; מפרסמים-בגלוי
  // ונשארים על min() (השמרני). בעולם-המדוד (10-22): 0.5063 מול 0.5009 = 1.1% — עקבי.
  const impliedSbdUsd = gSteem && chainFeed ? gSteem / chainFeed : null;
  const sbdDepegBps = impliedSbdUsd && gSbd ? Math.round(((gSbd - impliedSbdUsd) / impliedSbdUsd) * 10_000) : null;
  if (impliedSbdUsd != null && gSbd != null && Math.abs(sbdDepegBps) > 1000) {
    notes.push(`sbd-depeg-dispute: measured sbdUsd ${gSbd.toFixed(4)} vs implied-from-feed ${impliedSbdUsd.toFixed(4)} (${sbdDepegBps}bps apart) — value line stays min(chainFeed, usdParity), depeg published openly`);
  }

  const lines = [chainFeed, usdParity].filter((v) => Number.isFinite(v) && v > 0);
  const valueLineSbdPerSteem = lines.length ? Math.min(...lines) : null;

  let verdict;
  if (chainFeed && usdParity) verdict = "TRIANGLE-ARMED";
  else if (chainFeed) verdict = "CHAIN-ONLY";
  else if (usdParity) verdict = "USD-ONLY";
  else verdict = "UNMEASURED"; // fail-closed — הקורא מחויב לחסום מסחר

  return {
    protocol: PRICE_TRUTH_PROTOCOL,
    verdict,
    valueLineSbdPerSteem: valueLineSbdPerSteem != null ? Math.round(valueLineSbdPerSteem * 1e8) / 1e8 : null,
    bandRefSbdPerSteem: chainFeed ?? usdParity, // בדיקת-רצועה — תפוח-מול-תפוח (SBD/STEEM)
    marks: {
      chainFeedSbdPerSteem: chainFeed != null ? Math.round(chainFeed * 1e8) / 1e8 : null,
      usdParitySbdPerSteem: usdParity != null ? Math.round(usdParity * 1e8) / 1e8 : null,
      globalSteemUsd: gSteem, measuredSbdUsd: gSbd,
      impliedSbdUsdFromFeed: impliedSbdUsd != null ? Math.round(impliedSbdUsd * 1e8) / 1e8 : null,
      sbdDepegBps, // 10_000×(measured−implied)/implied — הדה-פג-המדוד-מפורסם
      src: marks.src ?? null,
    },
    notes,
    law: "valueLine=min(chainFeed,usdParity) · ask shelf=valueLine+TIER · bid ceiling=valueLine · band=|mid−chainFeed| — depeg and all marks published, no hidden value line",
  };
}

/** מדידת-ה-feed-הרפואי-מצומת-ציבורי (אותו-צומת-שהספר-נמדד-ממנו — אין-תלות-חוץ-חדשה). */
export async function measureChainFeed(node = "https://api.steemit.com", timeoutMs = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(node, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "condenser_api.get_current_median_history_price", params: [], id: 1 }),
      signal: ac.signal,
      cache: "no-store",
    });
    if (!r.ok) return null;
    const j = await r.json();
    return sbdPerSteemFromMedianFeed(j?.result);
  } catch {
    return null; // כנה: מדידה-שנכשלה = אין-מדידה (לא אולף)
  } finally {
    clearTimeout(t);
  }
}

/**
 * המדידה-המלאה: feed-רפואי (RPC) + סימוני-USD-שנמדדו-כבר-ע"י-extFeeds.
 * מחזיר מסמך-אמת-מלא או null-כנה (הקורא fail-closed).
 */
export async function measurePriceTruth({ steemUsd = null, sbdUsd = null, src = null, node = "https://api.steemit.com" } = {}) {
  const chainFeed = await measureChainFeed(node);
  const doc = derivePriceTruth({ chainFeedSbdPerSteem: chainFeed, globalSteemUsd: steemUsd, globalSbdUsd: sbdUsd, src });
  doc.measuredAt = new Date().toISOString();
  return doc;
}
