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

const HERE = dirname(fileURLToPath(import.meta.url));
const EVENTS_LOG = join(HERE, "state", "events.jsonl");
const OFFER_PATH = join(HERE, "state", "offer.json");
const CONSOLE_PAGES = "https://roshpinacare-sys.github.io/Console/dex/money.json";

/* ── מדיניות ברירת-מחדל (זהים לקבועי grid-pulse R83 — מקור-אחד לאמת) ─────── */
export const DEFAULT_POLICY = {
  commitPct: 0.9,        // אחוז-התחייבות מהיתרות הנזילות
  bidLevels: 3,
  askLevels: 3,
  bidStepBps: 200,       // ריחוק-בין-רמות קנייה (מדורג כלפי-מטה)
  askStepBps: 50,        // ריחוק-בין-רמות מכירה (מדורג כלפי-מעלה)
  askGrowth: 1.5,        // צמיחה-גיאומטרית של גודל-רמה (אותה-משמעת של mm-core)
  bidGrowth: 1.5,
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
    return offerDoc({ ok: false, blockers, bridge, marks, snapshot, gridState, policy, nowIso, parityBps, triggers: consumeTriggers(triggerBook) });
  }

  /* גדלים-אמת מיתרות-השרשרת בלבד (אין-מכשור-עצמי — עקרון 4) */
  const steemCommit = Math.max(0, Math.floor((snapshot.balances.steem - policy.reserveSteem) * policy.commitPct * 1000) / 1000);
  const sbdCommit = Math.max(0, Math.floor(snapshot.balances.sbd * policy.commitPct * 1000) / 1000);

  /* מכירה: רצפת-הפאריטי — אף-STEEM לא נמכר מתחת לערך-החוץ שלו */
  const asks = [];
  let askSteem = 0;
  for (let i = 1; i <= policy.askLevels; i++) {
    const price = r6(parity * (1 + (policy.askStepBps * i) / 10000));
    const sizeSteem = r3((steemCommit / policy.askLevels) * Math.pow(policy.askGrowth, i - 1) * normFactor(policy.askLevels, policy.askGrowth));
    askSteem = r3(askSteem + sizeSteem);
    asks.push({ side: "ask", level: i, priceSbdPerSteem: price, sizeSteem, kind: "sell-steem-above-parity" });
  }

  /* קנייה: תקרת-הפאריטי — כל קנייה מתחת לערך-החוץ היא עודף-נמדד */
  const bids = [];
  let bidSbd = 0;
  for (let i = 1; i <= policy.bidLevels; i++) {
    const price = r6(parity * (1 - (policy.bidStepBps * i) / 10000));
    const spendSbd = r3((sbdCommit / policy.bidLevels) * Math.pow(policy.bidGrowth, i - 1) * normFactor(policy.bidLevels, policy.bidGrowth));
    bidSbd = r3(bidSbd + spendSbd);
    const sizeSteem = spendSbd > 0 && price > 0 ? r3(spendSbd / price) : 0;
    bids.push({ side: "bid", level: i, priceSbdPerSteem: price, spendSbd, sizeSteem, kind: "buy-steem-below-parity" });
  }

  /* חסמי-מלאי כנים (אותם-ספים של grid-pulse): אין מכירת-עירום, אין התחייבות-יתר */
  if (askSteem > steemCommit) blockers.push(`ask plan ${askSteem} STEEM exceeds commitable ${steemCommit}`);
  if (askSteem > 0 && askSteem < policy.minLevelSteem * policy.askLevels) {
    blockers.push(`sell-side waiting for fuel: ${askSteem} STEEM commitable < ${(policy.minLevelSteem * policy.askLevels).toFixed(2)} needed`);
  }
  if (bidSbd > sbdCommit) blockers.push(`bid plan ${bidSbd} SBD exceeds commitable ${sbdCommit}`);
  if (bidSbd < policy.minLevelSbd * policy.bidLevels) {
    blockers.push(`buy-side waiting for SBD inventory: ${bidSbd} SBD commitable < ${(policy.minLevelSbd * policy.bidLevels).toFixed(2)} needed`);
  }

  const ok = blockers.length === 0;
  return offerDoc({
    ok, blockers, bridge, marks, snapshot, gridState, policy, nowIso,
    parityBps, fair: { internalRef: ref, externalParity: parity, boundary: "parity: asks ≥ parity (never sell below external value), bids ≤ parity (never pay above it)" },
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
    marks: o.marks ? { steemUsd: o.marks.steemUsd, sbdUsd: o.marks.sbdUsd, paritySbdPerSteem: o.marks.parity, sources: o.marks.sources } : null,
    book: o.snapshot?.book ?? null,
    inventory: o.snapshot?.balances ?? null,
    openOrdersNow: o.snapshot?.openOrders ?? null,
    fair: o.fair ?? null,
    parityBps: o.parityBps ?? null,
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
