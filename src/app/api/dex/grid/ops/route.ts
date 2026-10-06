import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

export const dynamic = "force-dynamic";

/* ═══════════════════════════════════════════════════════════════════════════
 * EXEC-CD-10 · GET /api/dex/grid/ops — מרכז-החיים של רשת-הגריד (STEEM)
 * ═══════════════════════════════════════════════════════════════════════════
 * הבעלים ביקש: "אין-לי נתוני-פעילות מסודרים של-הפוזיציות — תעשה משהו איכותי".
 * המצב-האמת: כל-הנתונים קיימים אבל פזורים — grids/state/*.json (התאום-חי
 * grid-trigger-twin[bot] מחייב-אותם לגיט כל-~30דק׳), db/grid-ledger.json
 * (הפנקס-האמת של grid-beat — פקודות-אמת על שוק-STEEM הפנימי), arb-ledger,
 * custody, route-receipt. מעולם לא היה-ערוץ אחד שמארגן אותם לפוזיציות/פעילות.
 *
 * הערוץ הזה = סוכם-כנה בלבד:
 *  - אפס-המצאה: כל-מספר נקרא מקובץ-אמת או מ-git; מה שחסר מדווח כחסר (fail-soft).
 *  - כל-מקור נושא mtime → ה-UI מציג "מתי" לכל-מספר (כנות-זמן).
 *  - הלב: realPnl/positionSteem/openAvgCost מהתאום + הפקודות-הפתוחות
 *    והמילויים-האמת מהפנקס — "נתוני-פעילות מסודרים של-הפוזיציות" סוף-סוף במקום-אחד.
 *  - connection[] — מפת-החיבור: איך הגריד-של-STEEM מתחבר לכאן (ל-DEX) —
 *    כל-צעד עם-הערך-החי שלו מהמקורות.
 * אפס-סודות: קריאה-בלבד · אין-מפתחות · אין-חתימה · אין-שידור.
 * ═══════════════════════════════════════════════════════════════════════════ */

type Json = Record<string, unknown>;

/* ── שורש-הריפו — next-dev רץ-עם cwd=saos-dex; נבדוק וניפול-בכנות לנתיב-הידוע ── */
function repoRoot(): string {
  const candidates = [process.cwd(), "/home/z/my-project/saos-dex"];
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, "grids", "state", "state.json"))) return c;
    } catch { /* נמשיך */ }
  }
  return process.cwd();
}
const ROOT = repoRoot();

/* ── קריאת-JSON עם-כנות-זמן (mtime) וכשל-כנה ── */
function readJson(rel: string): { data: Json | null; mtime: string | null; error: string | null } {
  try {
    const p = path.join(ROOT, rel);
    const st = fs.statSync(p);
    const data = JSON.parse(fs.readFileSync(p, "utf8")) as Json;
    return { data, mtime: st.mtime.toISOString(), error: null };
  } catch (e) {
    return { data: null, mtime: null, error: String(e).slice(0, 140) };
  }
}

/* ── עזרי-היצרות (הקלט הוא JSON דינמי — מצמצמים בכנות) ── */
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/* ── דופק-התאום (grid-heartbeat commits) — git-log עם-מטמון-5דק׳ ── */
type Tick = { sha: string; at: string; msg: string };
const HB = "__gridOpsHeartbeatCache_v2";
function heartbeat(): { ticks: Tick[]; error: string | null; fetchedAt: string } {
  const g = globalThis as { [HB]?: { at: number; val: { ticks: Tick[]; error: string | null; fetchedAt: string } } };
  const hit = g[HB];
  if (hit && Date.now() - hit.at < 300_000) return hit.val;
  let val: { ticks: Tick[]; error: string | null; fetchedAt: string };
  try {
    const out = execSync(`git log -14 --format="%h|%cI|%s" --grep=grid-heartbeat`, {
      encoding: "utf8",
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const ticks: Tick[] = out
      ? out.split("\n").map((l) => {
          const [sha, at, ...rest] = l.split("|");
          return { sha, at, msg: rest.join("|") };
        })
      : [];
    val = { ticks, error: null, fetchedAt: new Date().toISOString() };
  } catch (e) {
    val = { ticks: [], error: String(e).slice(0, 140), fetchedAt: new Date().toISOString() };
  }
  g[HB] = { at: Date.now(), val };
  return val;
}

export async function GET() {
  /* ── 1) מצב-התאום: החיילים + מד-העמלות + הפוזיציה-האמת ── */
  const st = readJson("grids/state/state.json");
  const stD = st.data;
  const market = (stD?.market as Json | undefined) ?? {};
  const feeMeter = (stD?.feeMeter as Json | undefined) ?? {};
  const realPnl = (feeMeter.realPnl as Json | undefined) ?? {};
  const soldiersRaw = arr(stD?.grids);
  const soldiers = soldiersRaw.map((g) => {
    const s = (g ?? {}) as Json;
    const p = (s.params as Json | undefined) ?? {};
    return {
      id: str(s.id),
      strategy: str(s.strategy),
      active: s.active === true,
      inventoryMu: num(s.inventoryMu),
      pnlSimMu: num(s.pnlSimMu),
      lastNote: str(s.lastNote),
      levels: numOrNull(p.levels),
      widthBps: numOrNull(p.widthBps),
      capMu: numOrNull(p.capMu),
    };
  });
  const twin = {
    asof: str(stD?.asof) || null,
    runCount: num(stD?.runCount),
    spawnCount: num(stD?.spawnCount),
    market: {
      refPrice: numOrNull(market.refPrice),
      source: str(market.source) || null,
      stale: market.stale === true,
      calmBps: numOrNull(market.calmBps),
    },
    feeMeter: {
      simMu: num(feeMeter.simMu),
      simFills: num(feeMeter.simFills),
      realMu: num(feeMeter.realMu),
      realFills: num(feeMeter.realFills),
      milestonesHit: arr(feeMeter.milestonesHit).map(num),
      queue: arr(feeMeter.queue).map(str),
      realSbdDelta: numOrNull(feeMeter.realSbdDelta),
      realPnl: {
        buys: num(realPnl.buys),
        sells: num(realPnl.sells),
        boughtSteem: num(realPnl.boughtSteem),
        spentSbd: num(realPnl.spentSbd),
        soldSteem: num(realPnl.soldSteem),
        proceedsSbd: num(realPnl.proceedsSbd),
        realizedSbd: num(realPnl.realizedSbd),
        positionSteem: num(realPnl.positionSteem),
        positionCostSbd: num(realPnl.positionCostSbd),
        openAvgCost: numOrNull(realPnl.openAvgCost),
      },
    },
    fleetCap: (stD?.fleetCap as Json | undefined) ?? null,
    soldiersSummary: {
      count: soldiers.length,
      active: soldiers.filter((s) => s.active).length,
      totalInventoryMu: Math.round(soldiers.reduce((a, s) => a + s.inventoryMu, 0) * 100) / 100,
      totalPnlSimMu: Math.round(soldiers.reduce((a, s) => a + s.pnlSimMu, 0) * 100) / 100,
    },
    soldiers,
  };

  /* ── 2) ההצעה החיה (peg.mjs → offer.json): הסולם-המתוכנן + החסמים-הכנים ── */
  const of = readJson("grids/state/offer.json");
  const ofD = of.data;
  const marks = (ofD?.marks as Json | undefined) ?? {};
  const book = (ofD?.book as Json | undefined) ?? {};
  const inventory = (ofD?.inventory as Json | undefined) ?? {};
  const drag = (ofD?.drag as Json | undefined) ?? {};
  const plan = (ofD?.plan as Json | undefined) ?? {};
  const convertArb = (marks.convertArb as Json | undefined) ?? {};
  const offer = ofD
    ? {
        publishedAt: str(ofD.publishedAt) || null,
        verdict: str(ofD.verdict) || null,
        blocker: arr(ofD.blocker).map(str),
        account: str(ofD.account) || null,
        chain: str(ofD.chain) || null,
        marks: {
          steemUsd: numOrNull(marks.steemUsd),
          sbdUsd: numOrNull(marks.sbdUsd),
          paritySbdPerSteem: numOrNull(marks.paritySbdPerSteem),
          convertArb: {
            discountPct: numOrNull(convertArb.discountPct),
            verdict: str(convertArb.verdict) || null,
            lockDays: numOrNull(convertArb.lockDays),
          },
        },
        book: {
          bestBid: numOrNull(book.bestBid),
          bestAsk: numOrNull(book.bestAsk),
          mid: numOrNull(book.mid),
          spreadBps: numOrNull(book.spreadBps),
        },
        inventory: { steem: numOrNull(inventory.steem), sbd: numOrNull(inventory.sbd) },
        openOrdersNow: numOrNull(ofD.openOrdersNow),
        parityBps: numOrNull(ofD.parityBps),
        drag: {
          k: numOrNull(drag.k),
          spreadBps: numOrNull(drag.spreadBps),
          effAskStepBps: numOrNull(drag.effAskStepBps),
          effBidStepBps: numOrNull(drag.effBidStepBps),
        },
        plan: {
          asks: arr(plan.asks).map((x) => {
            const l = (x ?? {}) as Json;
            return {
              level: num(l.level),
              priceSbdPerSteem: numOrNull(l.priceSbdPerSteem),
              sizeSteem: numOrNull(l.sizeSteem),
              kind: str(l.kind),
            };
          }),
          bids: arr(plan.bids).map((x) => {
            const l = (x ?? {}) as Json;
            return {
              level: num(l.level),
              priceSbdPerSteem: numOrNull(l.priceSbdPerSteem),
              sizeSteem: numOrNull(l.sizeSteem),
              kind: str(l.kind),
            };
          }),
          totals: (plan.totals as Json | undefined) ?? null,
        },
      }
    : null;

  /* ── 3) הפנקס-האמת של grid-beat: פקודות-אמת + מילויים-אמת על שוק-STEEM ── */
  const led = readJson("db/grid-ledger.json");
  const ledD = led.data;
  const ordersRaw = arr(ledD?.orders);
  const fillsRaw = arr(ledD?.fills);
  type LedgerOrder = {
    id: number;
    at: string;
    side: string;
    chain: string;
    sell: string;
    receive: string;
    priceSbdPerSteem: number;
    status: string;
    lastSeenAt: string;
  };
  const mapOrder = (x: unknown): LedgerOrder => {
    const o = (x ?? {}) as Json;
    return {
      id: num(o.id),
      at: str(o.at),
      side: str(o.side),
      chain: str(o.chain) || "steem",
      sell: str(o.sell),
      receive: str(o.receive),
      priceSbdPerSteem: num(o.priceSbdPerSteem),
      status: str(o.status) || "unknown",
      lastSeenAt: str(o.lastSeenAt) || str(o.at),
    };
  };
  const allOrders = ordersRaw.map(mapOrder);
  const real = ledD
    ? {
        version: num(ledD.version),
        placedTotal: num(ledD.placedTotal),
        filledTotal: num(ledD.filledTotal),
        cancelledTotal: num(ledD.cancelledTotal),
        externalFlowUsd: num(ledD.externalFlowUsd),
        counts: { orders: allOrders.length, fills: fillsRaw.length },
        openOrders: allOrders.filter((o) => o.status === "open").sort((a, b) => b.id - a.id),
        recentOrders: allOrders.slice(-15).reverse(),
        recentFills: fillsRaw
          .slice(-15)
          .reverse()
          .map((x) => {
            const f = (x ?? {}) as Json;
            return {
              at: str(f.at),
              side: str(f.side),
              direction: str(f.direction),
              chain: str(f.chain) || "steem",
              paid: str(f.paid),
              received: str(f.received),
              edgeBps: numOrNull(f.edgeBps),
            };
          }),
      }
    : null;

  /* ── 4) סורק-הארביטרז' החוצה-וניוז (arb-scan → arb-ledger.json) ── */
  const arbF = readJson("grids/state/arb-ledger.json");
  const arbD = arbF.data;
  const arbEntries = arr(arbD?.entries);
  const arb = arbD
    ? {
        generatedAt: str(arbD.generatedAt) || null,
        layer: str(arbD.layer) || null,
        truthGate: (arbD.truthGate as Json | undefined) ?? null,
        cumulative: (arbD.cumulative as Json | undefined) ?? null,
        count: arbEntries.length,
        recent: arbEntries
          .slice(-8)
          .reverse()
          .map((x) => {
            const e = (x ?? {}) as Json;
            return {
              ts: str(e.ts),
              pair: str(e.pair),
              edgeBps: numOrNull(e.edgeBps),
              executableSize: numOrNull(e.executableSize),
              realness: str(e.realness) || "UNKNOWN",
              paperPnlSbd: numOrNull(e.paperPnlSbd),
              degraded: e.degraded === true,
              notes: str(e.notes).slice(0, 160),
            };
          }),
      }
    : null;

  /* ── 5) אמת-המשמור על-השרשרת (custody.json) ── */
  const cusF = readJson("grids/state/custody.json");
  const cusD = cusF.data;
  const custody = cusD
    ? {
        at: str(cusD.at) || null,
        account: str(cusD.account) || null,
        counts: (cusD.counts as Json | undefined) ?? null,
        rows: arr(cusD.rows).map((x) => {
          const r = (x ?? {}) as Json;
          return {
            chain: str(r.chain),
            venue: str(r.venue),
            asset: str(r.asset),
            amount: r.amount === null || r.amount === undefined ? null : String(r.amount),
            ownership: str(r.ownership) || null,
            realness: str(r.realness) || "UNKNOWN",
            note: str(r.note) || null,
          };
        }),
      }
    : null;

  /* ── 6) קבלת-הניתוב האחרונה (route-receipt.json) ── */
  const routeF = readJson("grids/state/route-receipt.json");
  const route = routeF.data;

  /* ── 7) דופק-התאום מהגיט ── */
  const hb = heartbeat();

  /* ── 8) מפת-החיבור: איך הגריד-של-STEEM מתחבר לכאן (ל-DEX) ── */
  const refPrice = twin.market.refPrice;
  const parity = offer?.marks.paritySbdPerSteem ?? null;
  const connection = [
    {
      step: 1,
      title: "מדידה-אמת משרשרת-STEEM",
      detail: "condenser_api.get_feed_history → refPrice פנימי (אף-שורה לא ממציאה מחיר; נפילה → stale והגרידים ידיים-בכיס)",
      live:
        refPrice != null
          ? `refPrice ${refPrice} SBD/STEEM · stale=${twin.market.stale ? "כן" : "לא"}`
          : "אין-מדידה",
    },
    {
      step: 2,
      title: "רשת-המיקרו-גרידים (צורה בלבד · sim)",
      detail: "mm-grid/anchor-quote/supremacy/micro-arb/sweep — מייצרים רמות/רוחבים/סימטריה; המיקרו-כלכלה היא-צורה ואינה מנפחת גדלים",
      live: `${twin.soldiersSummary.count} חיילים · ${twin.soldiersSummary.active} פעילים · simFees ${twin.feeMeter.simMu.toFixed(0)}µ מ-${twin.feeMeter.simFills} מילויי-סימולציה`,
    },
    {
      step: 3,
      title: "peg.mjs — צורה → הצעה חוץ (offer.json)",
      detail: "דוקטרינת-הפאריטי: אף-מכירה מתחת לערך-החוץ, אף-קנייה מעליו · גרירה-דינמית מפיזור-הספר-החי · המנוע מציע ולא חותם",
      live: offer
        ? `${offer.verdict} · ${offer.plan.asks.length} אסקים/${offer.plan.bids.length} בידים · parity ${parity ?? "?"} (parityBps ${offer.parityBps})`
        : "אין-הצעה",
    },
    {
      step: 4,
      title: "grid-beat (R81 · headcorner) — החותם היחיד",
      detail: "מפעיל את הסולם על שוק-STEEM הפנימי הציבורי: Z-80 חוק-הספר (אף-אסק מתחת למגע) · Z-81 שימור-תור · STASIS בלם-הון · מייקר-בלבד",
      live: real
        ? `placedTotal ${real.placedTotal} · cancelled ${real.cancelledTotal} · openOrdersNow ${offer?.openOrdersNow ?? "?"}`
        : "אין-פנקס",
    },
    {
      step: 5,
      title: "מילויים-אמת נמדדים → פוזיציה",
      detail: "כל-מילוי נמדד מהשרשרת עם-סימון-ערך-חוץ (edgeBps מול ציון-USD) — הפוזיציה והעלות-הממוצעת חיים כאן",
      live: real
        ? `realFills ${twin.feeMeter.realFills} · פוזיציה ${twin.feeMeter.realPnl.positionSteem} STEEM @ ${twin.feeMeter.realPnl.openAvgCost ?? "?"} · realized ${twin.feeMeter.realPnl.realizedSbd} SBD`
        : "אין-מילויים",
    },
    {
      step: 6,
      title: "אבני-דרך → הולדת מיקרו-גריד-הבא",
      detail: "מד-העמלות מגיע לאבן-דרך → מיקרו-גריד חדש נולד מהתבניות — דבר-גורר-דבר גם-בכלכלה, אין-הדפסה-עצמית",
      live: `מיילסטונים ${twin.feeMeter.milestonesHit.length} · תור-לידה [${twin.feeMeter.queue.join(", ") || "—"}] · spawnCount ${twin.spawnCount}`,
    },
    {
      step: 7,
      title: "הגשר ל-DEX שלנו",
      detail: "blurt-quote: רגל-בלרט = memo-bridge ל@graphene-swap/@blurt-swap → SWAP.BLURT ב-Engine · arb-scan סורק ספרי-Engine מול שרשרת/HTX/Binance ומחויב לפנקס-ארב",
      live: arb ? `arb entries ${arb.count} · generatedAt ${arb.generatedAt ?? "?"}` : "אין-פנקס-ארב",
    },
  ];

  return NextResponse.json({
    ok: true,
    asof: new Date().toISOString(),
    root: path.basename(ROOT),
    sources: {
      state: { mtime: st.mtime, error: st.error },
      offer: { mtime: of.mtime, error: of.error },
      ledger: { mtime: led.mtime, error: led.error },
      arb: { mtime: arbF.mtime, error: arbF.error },
      custody: { mtime: cusF.mtime, error: cusF.error },
      route: { mtime: routeF.mtime, error: routeF.error },
    },
    twin,
    offer,
    real,
    arb,
    custody,
    route,
    heartbeat: hb,
    connection,
    honesty:
      "סוכם-כנה בלבד: כל-מספר נקרא מקובצי-אמת שהתאום מחייב-לגיט (grids/state/*, db/grid-ledger.json) או מ-git-לוג — אפס-המצאה, אפס-סודות, קריאה-בלבד. מה שחסר מדווח כחסר.",
  });
}
