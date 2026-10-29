/**
 * route-map.mjs — הרצת-החיים של מנוע-נתיבי-ההמרה (route-graph.mjs).
 * מרכיב את מפת-הנתיבים החיה ממקורות-אמת keyless:
 *   · בריכות+ספר פנימי — מה-snapshot-החי של ה-engine (db/state-snapshot.json, או SAOS_ENGINE_URL/state)
 *   · ספר-STEEM + ספר-HIVE — condenser ציבורי (ONCHAIN_REAL)
 *   · אורקלי-ייחוד — Binance top (CEX_REF) + חציון-הפיד + USDT↔USDS parity-REF
 *   · דלתות-עטיפה 1:1 — חוק-ה-kernel (wrap אפס-עמלה)
 * כל-מקור-שנכשל → דילוג-כנה; אף-מספר-מומצא. פלט: grids/state/route-map.json.
 * PLAN-ONLY — אין-חתימה, אין-שידור, אין-מפתחות.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { steemBookFeed, hiveBookFeed, binanceTopFeed, condenserMedianFeed } from "./arb-scan.mjs";
import { buildRouteMap } from "./route-graph.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "state", "route-map.json");
const SNAPSHOT = join(HERE, "..", "db", "state-snapshot.json");
const ENGINE_URL = process.env.SAOS_ENGINE_URL || null; // כשה-engine חי-ומאוחסן — עדיף-על-ה-snapshot

/* ── דלתות-העטיפה הריבוניות — מתוך-חוק-ה-kernel בלבד (kernel.ts: REAL_DOOR_ASSETS + מסילות-ה-W) ──────
 * WSTEEM⇄STEEM (ZFB אפס-עמלה) · WSBD⇄SBD (R42 THE-SBD-RAIL) · WBLURT⇄BLURT (Task 61, מאומת-RPC) ·
 * WTRX/WSOL/WETH/WBNB/WBASE/WUSDC — REAL_DOOR_ASSETS (גיבוי-פקדה אמת). PHIVE אינו-דלת — נכס-פנטום
 * (kernel: «אין-unwrap — HIVE לא-רשום-בגרעין») — נאסר-לחבר-אותו-לחוץ. */
const DOORS = [
  { from: "STEEM", to: "WSTEEM", venue: "wrap-door:STEEM⇄WSTEEM", note: "wrap_mint/wrap_burn 1:1 · אפס-עמלה · ZFB" },
  { from: "SBD", to: "WSBD", venue: "wrap-door:SBD⇄WSBD", note: "R42 THE-SBD-RAIL · wrap 1:1 · עוגן-backing מדוד" },
  { from: "BLURT", to: "WBLURT", venue: "wrap-door:BLURT⇄WBLURT", note: "Task 61 · wrap 1:1 · גיבוי-אמת-מאומת" },
  { from: "TRX", to: "WTRX", venue: "wrap-door:TRX⇄WTRX", note: "REAL_DOOR · deposit-backed (Task 72)" },
  { from: "SOL", to: "WSOL", venue: "wrap-door:SOL⇄WSOL", note: "REAL_DOOR · deposit-backed" },
  { from: "ETH", to: "WETH", venue: "wrap-door:ETH⇄WETH", note: "REAL_DOOR · EIP-1559 relay · funding-gated" },
  { from: "BNB", to: "WBNB", venue: "wrap-door:BNB⇄WBNB", note: "REAL_DOOR · deposit-backed" },
  { from: "USDC", to: "WUSDC", venue: "wrap-door:USDC⇄WUSDC", note: "REAL_DOOR · EXEC-CD-30 · מאומת-RPC" },
];

/** טעינת-מצב-ה-engine: חי אם-SAOS_ENGINE_URL מוגדר-ומגיב; אחרת snapshot-הריפו (מסומן-בכנות). */
async function loadEngineState() {
  if (ENGINE_URL) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(`${ENGINE_URL.replace(/\/$/, "")}/api/dex/state`, { signal: ctl.signal, headers: { "User-Agent": "saos-dex/route-map (keyless)" } });
      clearTimeout(t);
      if (r.ok) {
        const j = await r.json();
        const st = j?.state ?? j;
        if (st?.pools) return { source: "LIVE_ENGINE", url: ENGINE_URL, state: st };
      }
    } catch { /* נופל-למטה-בכנות */ }
  }
  if (existsSync(SNAPSHOT)) {
    try {
      const j = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
      if (j?.state?.pools) return { source: "REPO_SNAPSHOT", savedAt: j.savedAt, state: j.state };
    } catch { /* fail-closed למטה */ }
  }
  return null;
}

/** ממיר state-ה-engine למבנה-הבריכות של הגרף (µ→יחידות-אנושיות: ra/rb נשארים-כמו-שהם — x·y=k יחסי). */
function poolsFromState(st) {
  return Object.entries(st.pools ?? {}).map(([key, p]) => ({
    key, a: p.a, b: p.b, ra: Number(p.ra), rb: Number(p.rb), feeBps: Number(p.dynFeeBps ?? p.feeBps ?? 30), realness: "ONCHAIN_REAL",
  })).filter((p) => p.ra > 0 && p.rb > 0);
}

function ordersFromState(st) {
  const orders = st.orders ?? [];
  return Array.isArray(orders) ? orders.filter((o) => o?.live) : [];
}

/** אורקלי-חוץ — CEX_REF (Binance top) + USDT↔USDS parity. כל-כישלון = דילוג-כנה. */
async function oracleRefs(skips) {
  const refs = [];
  const pairs = [["STEEMUSDT", "STEEM/USDT"], ["HIVEUSDT", "HIVE/USDT"], ["BTCUSDT", "BTC/USDT"], ["TRXUSDT", "TRX/USDT"], ["SOLUSDT", "SOL/USDT"]];
  const results = await Promise.all(pairs.map(async ([sym, pair]) => {
    try {
      const f = await binanceTopFeed(sym);
      const bid = f?.ok ? f.data?.bids?.[0]?.price : null, ask = f?.ok ? f.data?.asks?.[0]?.price : null;
      const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
      return mid ? { pair, rate: mid, venue: "binance-top", realness: "CEX_REF" } : null;
    } catch { return null; }
  }));
  let got = 0;
  for (const r of results) { if (r) { refs.push(r); got++; } }
  if (got < pairs.length) skips.push({ what: "binance-top", why: `only ${got}/${pairs.length} symbols returned` });
  // USDT↔USDS — parity-עצמי שלנו: USDS מוגדר µ=1000 קנוני; REF מסומן
  refs.push({ pair: "USDT/USDS", rate: 1, venue: "canonical-parity", realness: "REF" });
  return refs;
}

export async function buildLiveRouteMap({ now = Date.now(), fetchImpl = fetch } = {}) {
  const skips = [];
  const eng = await loadEngineState();
  if (!eng) skips.push({ what: "engine-state", why: "no live engine and no readable snapshot" });

  const pools = eng ? poolsFromState(eng.state) : [];
  const orders = eng ? ordersFromState(eng.state) : [];
  if (eng && pools.length === 0) skips.push({ what: "engine-pools", why: "state has no usable pools" });

  const [steem, hive, median] = await Promise.all([
    steemBookFeed({ fetchImpl }).catch(() => ({ ok: false, error: "throw" })),
    hiveBookFeed({ fetchImpl }).catch(() => ({ ok: false, error: "throw" })),
    condenserMedianFeed({ fetchImpl }).catch(() => ({ ok: false, error: "throw" })),
  ]);
  const extBooks = [];
  if (steem?.ok) extBooks.push({ pair: "STEEM/SBD", venue: steem.data.venue, realness: "ONCHAIN_REAL", feeBps: 0, bids: steem.data.bids, asks: steem.data.asks });
  else skips.push({ what: "steem-book", why: steem?.error ?? "unavailable" });
  if (hive?.ok) extBooks.push({ pair: "HIVE/HBD", venue: hive.data.venue, realness: "ONCHAIN_REAL", feeBps: 0, bids: hive.data.bids, asks: hive.data.asks });
  else skips.push({ what: "hive-book", why: hive?.error ?? "unavailable" });

  const refs = await oracleRefs(skips);
  if (median?.ok && median.data?.price > 0) refs.push({ pair: "STEEM/SBD", rate: median.data.price, venue: "chain-median-feed", realness: "ONCHAIN_REAL" });
  else skips.push({ what: "median-feed", why: median?.error ?? "unavailable" });

  const map = buildRouteMap({ pools, orders, doors: DOORS, extBooks, refs, skips }, { now });
  map.engineSource = eng ? { kind: eng.source, savedAt: eng.savedAt ?? null, url: eng.url ?? null } : { kind: "NONE" };
  return map;
}

/* ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────── */
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) {
  const t0 = Date.now();
  const map = await buildLiveRouteMap({});
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(map, null, 1) + "\n");
  const routed = map.routes.filter((r) => r.verdict === "ROUTED");
  console.log(JSON.stringify({
    state: "ok", engine: map.engineSource.kind, nodes: map.graph.nodes.length, edges: map.graph.byKind,
    routed: routed.length, arb: map.arb.length, skips: map.skips.length,
    best: routed.slice(0, 3).map((r) => ({ path: `${r.from}->${r.to}`, via: r.best?.legs?.map((l) => l.kind).join("→"), out: r.best?.amountOut, realness: r.best?.realness })),
    ms: Date.now() - t0,
  }));
}
