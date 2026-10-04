// PEG — מנוע-הצמדה (B-1 · fleet/r130): פרמטרי-גריד פנים → הצעה חוץ
// ═══════════════════════════════════════════════════════════════════════════
// החוליה החסרה בלולאה "דבר-גורר-דבר": מודול ה-grids מריץ מיקרו-גרידים בפנים
// (סימולציה מסומנת sim:true), grid-pulse מפרסם בחוץ מדידה-חסרת-מפתחות —
// ואין מנוע שמתרגם את הכלכלה-הפנימית להצעה-חוץ שניתנת-לביצוע ולבדיקה.
// המנוע הזה הוא התרגום הזה.
//
// העקרונות (אותה חוקת-כנות של המודול ושל grid-pulse R83):
//   1. מחיר-אמת או כלום.  אין המצאת מחירים: הצורה מגיעה מהגרידים הפנימיים,
//      המחיר-אמת משני מקורות ציבוריים — feed_price (פנים) ופאריטי-USD (חוץ).
//      אין מדידה → אין הצעה (ידיים-בכיס, כנה).
//   2. דוקטרינת-הפאריטי: אף-פעולה לא מוכרת STEEM מתחת לערך-ה-USD החוץ שלו,
//      ואף-פעולה לא קונה מעליו. כל קנייה מתחת לפאריטי = עודף נמדד.
//      סטיית פאריטי מעבר לרצועה = סירוב-כנה לסחור בשוק שבור.
//   3. חסר-מפתחות מהיסוד: המנוע מציע — לא חותם. החותם היחיד הוא המוביל
//      (R81, שער-מפעיל X-1) דרך /api/money. הפלט הוא מסמך-הצעה דטרמיניסטי
//      שכל אחד יכול לחשב-מחדש מ-RPC ציבורי בלבד.
//   4. אין-מכשור-עצמי: הגדלים האמת נגזרים מיתרות-השרשרת בלבד. מלאי-ה-µ
//      הפנימי הוא סימולציה ואינו מנפח אף-גודל (אותה משמעת אין-הדפסה-עצמית).
//      הגשר פנים→חוץ הוא צורה (levels/widths/symmetry) — לא הון.
//   5. דטרמיניזם מלא: אותן-קלטות → אותו-מסמך בדיוק. הזמן מוזרק, לא נקרא.
//
// חיבור-לולאה: כל ריצה קוראת את ספר-הטריגרים (Console/triggers — Z-4/Z-5),
// מדווחת צריכה, ופולטת offer.published / offer.blocked ליומן האירועים של
// רשת-הטריגרים — כך ההצעה עצמה הופכת טריגר לדבר-הבא.

import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { appendEvent } from "./events.mjs";
import { loadState } from "./engine.mjs";
import { makerLadder, normBook, touchSpreadBps } from "./book-law.mjs"; // Z-80: חוק-הספר — אף-רמה לא חוצה את המגע

const HERE = dirname(fileURLToPath(import.meta.url));
const EVENTS_LOG = join(HERE, "state", "events.jsonl");
const OFFER_PATH = join(HERE, "state", "offer.json");
const CONSOLE_PAGES = "https://roshpinacare-sys.github.io/Console/dex/money.json";

/* ── מדיניות ברירת-מחדל (B-3: סולם-5-רמות + גרירה דינמית) ───────────────
   הסולם עולה ל-5 רמות-לצד (בהמשך לסולם-STEEM של המנוע-המקורי), והגרירה
   הדינמית מרחיבה את ריחוק-הרמות לפי פיזור-הספר-החי — אותה-גרירה שהמוביל R81
   מבצעת ידנית, כאן בפורמולה גלויה ודטרמיניסטית:
     dragK = clamp(1 + spreadBps/dragDivisorBps, 1, dragMax)
   אין-ספר / אין-פיזור → dragK=1 (ניטרלי). הגבול-העליון חסום (dragMax). */
export const DEFAULT_POLICY = {
  commitPct: 0.9,        // אחוז-התחייבות מהיתרות הנזילות
  bidLevels: 5,
  askLevels: 5,
  bidStepBps: 200,       // ריחוק-בסיס-בין-רמות קנייה (מדורג כלפי-מטה)
  askStepBps: 50,        // ריחוק-בסיס-בין-רמות מכירה (מדורג כלפי-מעלה)
  askGrowth: 1.5,        // צמיחה-גיאומטרית של גודל-רמה (אותה-משמעת של mm-core)
  bidGrowth: 1.5,
  dragDivisorBps: 2000,  // מכנת-הגרירה: spread/2000 → עד 1× נוסף
  dragMax: 3,            // תקרת-גרירה — אף-שוק לא מפזר את הסולם מעבר לזה
  parityBandBps: 5000,   // מעבר לזה — השוק שבור, סירוב-כנה
  reserveSteem: 0.5,     // דלק-שמור (RC/עסקאות) — לא נמכר לעולם
  minLevelSteem: 1.0,    // מינימום-רמה-אמת (סף-פיזור של grid-pulse)
  minLevelSbd: 0.05,
};

const r6 = (v) => Math.round(v * 1e6) / 1e6;
const r3 = (v) => Math.round(v * 1e3) / 1e3;
const num = (s) => (s ? parseFloat(String(s).replace(/[A-Za-z ]+/g, "")) : 0);

/* ── מדידות-אמת חסרות-מפתחות (אותם-מקורות של grid-pulse) ─────────────────── */

/** פידי-USD: בינאנס → CoinGecko → money.json של הצופה. כל-שכבה מתעדת מקור. */
export async function measureMarks() {
  const sources = {};
  let steemUsd = null;
  let sbdUsd = null;
  const jget = async (url, ms = 8000) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": "grids-peg" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  };
  for (let attempt = 0; attempt < 2 && steemUsd == null; attempt++) {
    try {
      const j = await jget("https://api.binance.com/api/v3/ticker/price?symbol=STEEMUSDT");
      if (Number(j.price) > 0) { steemUsd = Number(j.price); sources.steem = "binance:STEEMUSDT"; }
    } catch { /* נפילה לשכבה הבאה */ }
  }
  try {
    const j = await jget("https://api.coingecko.com/api/v3/simple/price?ids=steem,steem-dollars&vs_currencies=usd");
    if (steemUsd == null && typeof j?.steem?.usd === "number" && j.steem.usd > 0) { steemUsd = j.steem.usd; sources.steem = "coingecko:steem"; }
    if (typeof j?.["steem-dollars"]?.usd === "number" && j["steem-dollars"].usd > 0) { sbdUsd = j["steem-dollars"].usd; sources.sbd = "coingecko:steem-dollars"; }
  } catch { /* נפילה לשכבה הבאה */ }
  if (steemUsd == null || sbdUsd == null) {
    try {
      const m = await jget(CONSOLE_PAGES);
      if (steemUsd == null && typeof m?.marks?.steemUsd === "number" && m.marks.steemUsd > 0) { steemUsd = m.marks.steemUsd; sources.steem = `console:money.json@${String(m.publishedAt ?? "?").slice(0, 16)}Z`; }
      if (sbdUsd == null && typeof m?.marks?.sbdUsd === "number" && m.marks.sbdUsd > 0) { sbdUsd = m.marks.sbdUsd; sources.sbd = `console:money.json@${String(m.publishedAt ?? "?").slice(0, 16)}Z`; }
    } catch { /* בלי שער — בכנות */ }
  }
  const parity = steemUsd != null && sbdUsd != null && sbdUsd > 0 ? r6(steemUsd / sbdUsd) : null;
  return { steemUsd, sbdUsd, parity, sources };
}

/** צילום-חי מהשרשרת: יתרות, ספר, פקודות-פתוחות — condenser_api בלבד. */
export async function measureSnapshot(account = "headcorner") {
  const rpc = async (method, params) => {
    const r = await fetch("https://api.steemit.com", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(7000),
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
    });
    if (!r.ok) throw new Error(`steemit rpc ${method} -> ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${String(j.error.message ?? "rpc-error").slice(0, 80)}`);
    return j.result;
  };
  const [accArr, bookRaw, openRaw] = await Promise.all([
    rpc("condenser_api.get_accounts", [[account]]),
    rpc("condenser_api.get_order_book", [5]).catch(() => null),
    rpc("condenser_api.get_open_orders", [account]).catch(() => []),
  ]);
  const a = accArr?.[0];
  if (!a) throw new Error("account-empty");
  let book = { bestBid: null, bestAsk: null, mid: null, spreadBps: null };
  if (bookRaw?.asks?.[0] && bookRaw?.bids?.[0]) {
    const bestAsk = parseFloat(bookRaw.asks[0].real_price);
    const bestBid = parseFloat(bookRaw.bids[0].real_price);
    book = { bestBid, bestAsk, mid: r6((bestBid + bestAsk) / 2), spreadBps: Math.floor(((bestAsk - bestBid) / bestBid) * 10000) };
  }
  return {
    balances: { steem: num(a.balance), sbd: num(a.sbd_balance) },
    book,
    openOrders: Array.isArray(openRaw) ? openRaw.length : 0,
  };
}

/** צריכת ספר-הטריגרים (אותו-דפוס של grid-pulse Z-5): קורא ומדווח — לא מחליט. */
export function consumeTriggers(book, ids = ["T-PARITY-MOVE", "T-GRID-STALE", "T-FUEL-END", "T-RC-LOW"]) {
  if (book == null || typeof book !== "object") {
    return { source: null, consumed: [], note: "trigger book not available" };
  }
  try {
    const fired = (book?.fired ?? []).map((f) => f.id ?? f).filter((id) => ids.includes(id));
    return {
      source: book?.publishedAt ?? null,
      consumed: fired,
      note: fired.length
        ? "grid-relevant triggers fired — reflected in this offer cycle; signing stays operator-gated (R81)"
        : "no grid-relevant triggers fired",
    };
  } catch {
    return { source: null, consumed: [], note: "trigger book not available" };
  }
}

/* ═══ הליבה הטהורה — דטרמיניסטית לחלוטין, בלי רשת ובלי זמן ═══════════════
   קלטות: מצב-הגרידים הפנימי + צילום-השרשרת + פידי-USD + ספר-טריגרים.
   פלט: מסמך-הצעה (חסימות כנות או תוכנית-פקודות ביחידות-אמת). */
export function computeOffer({ gridState, snapshot, marks, triggerBook = null, policy = DEFAULT_POLICY, nowIso = null }) {
  const blockers = [];
  const bridge = internalBridge(gridState);

  /* מדידות-חובה: בלי שניהן — ידיים-בכיס (כנות לפני הכל) */
  const ref = gridState?.market?.refPrice ?? null;
  const refStale = !ref || gridState?.market?.stale === true;
  const parity = marks?.parity ?? null;
  if (refStale) blockers.push("internal ref stale or missing (steem-feed): no honest anchor to quote around");
  if (parity == null) blockers.push("external USD marks unavailable (steem/sbd feeds down): no value boundary");
  if (blockers.length > 0) {
    return offerDoc({ ok: false, blockers, bridge, marks, snapshot, gridState, policy, nowIso, triggers: consumeTriggers(triggerBook) });
  }

  /* דוקטרינת-הפאריטי: סטייה מעבר לרצועה = סירוב לסחור בשוק שבור */
  const parityBps = Math.floor(((ref - parity) / parity) * 10000);
  if (Math.abs(parityBps) > policy.parityBandBps) {
    blockers.push(`internal ref deviates ${parityBps}bps from external parity: refusing to quote a broken market`);
    return offerDoc({ ok: false, blockers, bridge, marks, snapshot, gridState, policy, nowIso, parityBps, bookLaw: (() => { const nb = normBook(snapshot?.book ?? null); return { bestAsk: nb.bestAsk, bestBid: nb.bestBid, mid: nb.mid, touchSpreadBps: touchSpreadBps(snapshot?.book ?? null) }; })(), triggers: consumeTriggers(triggerBook) });
  }

  /* גדלים-אמת מיתרות-השרשרת בלבד (אין-מכשור-עצמי — עקרון 4) */
  const steemCommit = Math.max(0, Math.floor((snapshot.balances.steem - policy.reserveSteem) * policy.commitPct * 1000) / 1000);
  const sbdCommit = Math.max(0, Math.floor(snapshot.balances.sbd * policy.commitPct * 1000) / 1000);

  /* גרירה-דינמית (B-3): ריחוק-הרמות נמדד מפיזור-הספר-החי. גלוי ודטרמיניסטי. */
  const spreadBps = Number.isFinite(snapshot?.book?.spreadBps) && snapshot.book.spreadBps >= 0 ? snapshot.book.spreadBps : null;
  const dragK = spreadBps == null ? 1 : Math.min(policy.dragMax, Math.max(1, 1 + spreadBps / policy.dragDivisorBps));
  const effAskStepBps = policy.askStepBps * dragK;
  const effBidStepBps = policy.bidStepBps * dragK;
  const drag = {
    k: Math.round(dragK * 1e6) / 1e6,
    spreadBps,
    divisorBps: policy.dragDivisorBps,
    max: policy.dragMax,
    effAskStepBps: Math.round(effAskStepBps * 1e6) / 1e6,
    effBidStepBps: Math.round(effBidStepBps * 1e6) / 1e6,
    note: "ladder spacing follows the live book spread (R81 drag, deterministic); no book → neutral 1.0",
  };

  /* מכירה: רצפת-הפאריטי — אף-STEEM לא נמכר מתחת לערך-החוץ שלו */
  /* הקצאה-תקציבית (תיקון-עיגול): כל-רמה מקבלת min(רצוי, נותר) — סכום-הסולם
   * לעולם לא חורג מהניתן-להתחייבות; רמת-אבק (<0.001) מושמטת בכנות. */
  const asks = [];
  let askRemaining = steemCommit;
  /* Z-80 חוק-הספר: העוגן הוא עדיין הפאריטי (רצפת-ערך-חוץ), אך רמה-1 נהדקת
   * אל המגע-החי אם-הפאריטי מתחתיו — והרמות נפרשות כלפי-מעלה מהבסיס-המהודק.
   * כך אף-אסק לא נופל מתחת ל-bestAsk → אף-מכירה-מיידית-כ-taker בצד-הלא-נכון. */
  const askPx = makerLadder({ anchor: parity, book: snapshot?.book ?? null, levels: policy.askLevels, stepBps: effAskStepBps, side: "ask" });
  for (let i = 1; i <= policy.askLevels; i++) {
    const price = askPx[i - 1] ?? r6(parity * (1 + (effAskStepBps * i) / 10000));
    const want = r3((steemCommit / policy.askLevels) * Math.pow(policy.askGrowth, i - 1) * normFactor(policy.askLevels, policy.askGrowth));
    const sizeSteem = Math.min(want, r3(askRemaining));
    if (sizeSteem < policy.minLevelSteem) break; // רמת-אבק — לא-חוצים, חוסמים-בכנות
    askRemaining = r3(askRemaining - sizeSteem);
    asks.push({ side: "ask", level: i, priceSbdPerSteem: price, sizeSteem, kind: "sell-steem-above-parity" });
  }
  const askSteem = r3(asks.reduce((s, a) => s + a.sizeSteem, 0));

  /* קנייה: תקרת-הפאריטי — כל קנייה מתחת לערך-החוץ היא עודף-נמדד */
  /* הקצאה-תקציבית — זהה לצד-המכירה */
  const bids = [];
  let bidRemaining = sbdCommit;
  /* Z-80 חוק-הספר בהיפוך: רמה-1 נהדקת אל המגע-מלמטה אם-הפאריטי מעליו —
   * אף-ביד לא עולה על bestBid → אף-קנייה-מיידית-כ-taker. ההידוק מזיז רק
   * כלפי-מטה, לכן תקרת-הפאריטי ("לא משלמים מעל ערך-חוץ") נשמרת תמיד. */
  const bidPx = makerLadder({ anchor: parity, book: snapshot?.book ?? null, levels: policy.bidLevels, stepBps: effBidStepBps, side: "bid" });
  for (let i = 1; i <= policy.bidLevels; i++) {
    const price = bidPx[i - 1] ?? r6(parity * (1 - (effBidStepBps * i) / 10000));
    const want = r3((sbdCommit / policy.bidLevels) * Math.pow(policy.bidGrowth, i - 1) * normFactor(policy.bidLevels, policy.bidGrowth));
    const spendSbd = Math.min(want, r3(bidRemaining));
    if (spendSbd < policy.minLevelSbd) break; // רמת-אבק — לא-חוצים, חוסמים-בכנות
    bidRemaining = r3(bidRemaining - spendSbd);
    const sizeSteem = spendSbd > 0 && price > 0 ? r3(spendSbd / price) : 0;
    bids.push({ side: "bid", level: i, priceSbdPerSteem: price, spendSbd, sizeSteem, kind: "buy-steem-below-parity" });
  }
  const bidSbd = r3(bids.reduce((s, b) => s + b.spendSbd, 0));

  /* חסמי-מלאי כנים — כעת הגנה-לעומק בלבד: ההקצאה-התקציבית מבטיחה סכום ≤ ניתן.
   * אם-החסם-נורה — יש-באג-אמת במנוע, והוא חייב לעצור (fail-closed). */
  if (askSteem > steemCommit) blockers.push(`ask plan ${askSteem} STEEM exceeds commitable ${steemCommit}`);
  if (askSteem < policy.minLevelSteem * policy.askLevels) {
    blockers.push(`sell-side waiting for fuel: ${askSteem} STEEM commitable < ${(policy.minLevelSteem * policy.askLevels).toFixed(2)} needed`);
  }
  if (bidSbd > sbdCommit) blockers.push(`bid plan ${bidSbd} SBD exceeds commitable ${sbdCommit}`);
  if (bidSbd < policy.minLevelSbd * policy.bidLevels) {
    blockers.push(`buy-side waiting for SBD inventory: ${bidSbd} SBD commitable < ${(policy.minLevelSbd * policy.bidLevels).toFixed(2)} needed`);
  }

  const ok = blockers.length === 0;
  return offerDoc({
    ok, blockers, bridge, marks, snapshot, gridState, policy, nowIso,
    parityBps, drag,
    fair: { internalRef: ref, externalParity: parity, boundary: "parity floor/ceiling (never sell below / pay above external value) + Z-80 book-touch maker clamp (asks ≥ bestAsk, bids ≤ bestBid)" },
    bookLaw: { ...(() => { const nb = normBook(snapshot?.book ?? null); return { bestAsk: nb.bestAsk, bestBid: nb.bestBid, mid: nb.mid, touchSpreadBps: touchSpreadBps(snapshot?.book ?? null) }; })(), law: "Z-80: no order may cross the live book — the bleed of 2026-10-04 (taker 0.10365→0.0999) is structurally banned" },
    plan: { asks, bids, totals: { askSteem, bidSbd, steemCommit, sbdCommit } },
    triggers: consumeTriggers(triggerBook),
  });
}

/* ── נרמול: כך שסכום-הרמות (עם צמיחה גיאומטרית) שווה בדיוק לתקציב ───────── */
function normFactor(levels, growth) {
  let s = 0;
  for (let i = 0; i < levels; i++) s += Math.pow(growth, i);
  return s > 0 ? levels / s : 1;
}

/* ── הגשר הפנים→חוץ: מה הגרידים הפנימיים תורמים להצעה (צורה — לא הון) ────── */
function internalBridge(gridState) {
  const active = (gridState?.grids ?? []).filter((g) => g.active);
  const inventoryMu = r3(active.reduce((s, g) => s + (g.inventoryMu ?? 0), 0));
  const capMu = active.reduce((s, g) => s + (g.params?.capMu ?? 0), 0);
  const strategies = active.map((g) => g.strategy);
  return {
    activeGrids: active.map((g) => g.id),
    strategies: [...new Set(strategies)],
    inventoryMu,
    capMu,
    utilizationPct: capMu > 0 ? Math.round((inventoryMu / capMu) * 1000) / 10 : 0,
    simFeesMu: gridState?.feeMeter?.simMu ?? 0,
    contribution: "shape only — levels/widths/symmetry doctrine; real sizes come from chain balances exclusively (no self-printing)",
  };
}

/* ── מד-ארביטרז'-המרה (T-7): SBD פנים = $1 ערך-פנים בהמרה (3.5 ימים) ───────
 * אם שוק-חוץ מתמחר SBD מתחת-לפנים — ההמרה condenser_api +EV מדוד. כנות:
 * הנזילות-3.5-יום נחשבת, והאדג' נמדד-בלבד — אין-הנחה של רווח לפני מימוש. */
export function convertArb(sbdUsd) {
  if (sbdUsd == null || !(sbdUsd > 0)) return null;
  const discountPct = r6((1 - sbdUsd) * 100);
  return {
    faceUsd: 1.0,
    marketUsd: sbdUsd,
    discountPct,
    verdict: sbdUsd < 0.99 ? "CONVERT-POSITIVE" : "NO-EDGE",
    lockDays: 3.5,
    note: "condenser convert: SBD→STEEM בערך-$1-פנים אחרי 3.5d · אדג' קיים רק אם שוק-חוץ מתמחר SBD<$1 · נזילות-המרה אינה-מיידית",
  };
}

/* ── מסמך-ההצעה: אותו-מבנה-חשיפה של grid-pulse (blocker/verdict/honesty) ─── */
function offerDoc(o) {
  const ok = o.ok === true;
  const doc = {
    ok,
    publishedAt: o.nowIso ?? new Date().toISOString(),
    engine: "saos-dex/grids/peg · B-1 (fleet/r130) — internal grid params → external offer; proposes, signs nothing",
    account: o.snapshot ? "headcorner" : null,
    chain: "STEEM-internal-market",
    verdict: ok ? "OFFER-READY" : "OFFER-BLOCKED",
    blocker: o.blockers.length ? o.blockers : null,
    bridge: o.bridge,
    marks: o.marks ? { steemUsd: o.marks.steemUsd, sbdUsd: o.marks.sbdUsd, paritySbdPerSteem: o.marks.parity, sources: o.marks.sources, convertArb: convertArb(o.marks.sbdUsd) } : null,
    book: o.snapshot?.book ?? null,
    inventory: o.snapshot?.balances ?? null,
    openOrdersNow: o.snapshot?.openOrders ?? null,
    fair: o.fair ?? null,
    parityBps: o.parityBps ?? null,
    drag: o.drag ?? null,
    plan: o.plan ?? null,
    triggers: o.triggers ?? consumeTriggers(null),
    honesty:
      "הצעה חסרת-מפתחות: הצורה נגזרת מהמיקרו-גרידים הפנימיים (סימולציה sim:true), הגדלים נגזרים מיתרות-השרשרת בלבד, " +
      "והמחיר-אמת כפול — feed_price פנים + פאריטי-USD חוץ. המנוע מציע ולא חותם: המוביל (R81) דרך /api/money " +
      "הוא החותם היחיד, וכל-מספר כאן ניתן-לחישוב-מחדש מ-RPC ציבורי.",
  };
  return doc;
}

/* ── ריצה-אחת: מדוד → חשב → פרסם → הצת אירוע ללולאה ────────────────────── */
export async function runPeg({ outPath = OFFER_PATH, account = "headcorner" } = {}) {
  let gridState = null;
  try {
    gridState = loadState();
  } catch {
    gridState = null;
  }
  const [snapshot, marks] = await Promise.all([measureSnapshot(account), measureMarks()]);
  let triggerBook = null;
  for (const p of [process.env.TRIGGERS_CURRENT, resolve(HERE, "../../Console/triggers/current.json")]) {
    if (p && existsSync(p)) {
      try { triggerBook = JSON.parse(readFileSync(p, "utf8")); break; } catch { /* כנה */ }
    }
  }
  const doc = computeOffer({ gridState, snapshot, marks, triggerBook });
  writeFileSync(outPath, JSON.stringify(doc, null, 1) + "\n");
  appendEvent(EVENTS_LOG, {
    type: doc.ok ? "offer.published" : "offer.blocked",
    source: "peg",
    payload: {
      verdict: doc.verdict,
      asks: doc.plan?.asks?.length ?? 0,
      bids: doc.plan?.bids?.length ?? 0,
      parityBps: doc.parityBps,
      blockers: doc.blocker,
    },
  });
  return doc;
}

/* ── CLI: node grids/peg.mjs [--selftest] ─────────────────────────────────── */
if (process.argv[1] && process.argv[1].endsWith("peg.mjs") && !process.argv.includes("--imported")) {
  if (process.argv.includes("--selftest")) {
    await import("./peg-selftest.mjs");
  } else {
    const doc = await runPeg();
    console.log(`[peg] ${doc.verdict} · parity=${doc.marks?.paritySbdPerSteem ?? "?"} · parityBps=${doc.parityBps ?? "?"} · asks=${doc.plan?.asks?.length ?? 0} bids=${doc.plan?.bids?.length ?? 0}`);
    if (doc.blocker) console.log(`[peg] honest blockers: ${doc.blocker.join(" | ")}`);
  }
}
