import { NextResponse } from "next/server";
import { ensureChain, getMarkets, getTape } from "@/lib/dex/chain";
import { getPool, poolMid, poolKey } from "@/lib/dex/amm";
import { fairPrice } from "@/lib/dex/mm";
import { stateRoot, GAS_TABLE } from "@/lib/dex/kernel";
import { scenarioA, scenarioAClean, scenarioB1, scenarioB2, scenarioB3, scenarioC, type BookLevel } from "@/lib/dex/showcase";
import { relayStatus } from "@/lib/dex/relay";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/dex/showcase — משטח-הוכחת-הפריצה.
 * כל-המספרים נגזרים מהקוד-החי: הספר-והבריכה של SAOS/USDS עכשיו,
 * סליל-המילויים החי, ומצב-העיגון-הריבוני ב-5 השרשראות.
 * אפס-מדומה: כל-שדה ניתן-לשחזור מה-endpoints הציבוריים.
 */
export async function GET() {
  try {
    const rt = ensureChain();
    const st = rt.st;

    // ── הזוג-הריבוני SAOS/USDS — הנכס שסביבו נבנה כל-המערכת ──
    const market = getMarkets().find((m) => m.key === "SAOS/USDS");
    if (!market) return NextResponse.json({ ok: false, error: "sovereign-market-missing" }, { status: 500 });
    const pool = getPool(st, poolKey("SAOS", "USDS"));
    if (!pool) return NextResponse.json({ ok: false, error: "sovereign-pool-missing" }, { status: 500 });

    const mid = fairPrice(st, "SAOS", "USDS") || poolMid(pool) || market.refPrice;
    const asks: BookLevel[] = market.asks;
    const bids: BookLevel[] = market.bids;
    const depthMu = asks.reduce((s, a) => s + a.total, 0);

    // A — אותה-כמות: הספר מול הבריכה-החיה (מצב-רזרבות-אמת: עמלה+פגיעה+סטייה-היסטורית)
    const cap = Math.max(20_000, Math.floor(depthMu / 2));
    const sizes = [10_000, 50_000, Math.min(150_000, cap), Math.min(400_000, cap)];
    const sizeList = Array.from(new Set(sizes));
    const A = scenarioA(asks, pool.ra, pool.rb, mid, sizeList);
    // A2 — בידוד-המנגנון: אותו-ספר מול בריכה-נקייה המיושרת ל-fair (רק עמלה+פגיעה)
    const A2 = scenarioAClean(asks, mid, sizeList);

    // B1 — דטרמיניזם: אותו-זרם-פעולות על 3 מצבים-טריים
    const B1 = scenarioB1(3);

    // B2 — כריך על הבריכה (חילוץ-אמת)
    const B2 = scenarioB2(pool.ra, pool.rb, 200_000, 150_000);

    // B3 — אותו-כריך על הספר החי (קורבן-מכובד-מול-עומק)
    const victimMu = Math.max(20_000, Math.min(200_000, Math.floor(depthMu / 2)));
    const B3 = scenarioB3(asks, bids, victimMu);

    // C — נזילות-אוטונומית: סליל-חי + יחוס-נזילות-מנוחה + קצב-חיים-מלא
    const C = scenarioC(
      getTape(600).map((e) => ({ kind: e.kind, maker: e.maker, amountMu: e.amountMu, at: e.at })),
      Math.floor((Date.now() - rt.startedAt) / 1000),
      st.stats.fills, st.stats.swaps,
      st.orders.map((o) => ({ owner: o.owner, remMu: o.amount - o.filled }))
    );

    // ריבונות — מצב-העיגון החי (אפס-סודות; מאותו-מקור כמו /api/dex/relay)
    const relay = relayStatus() as {
      metrics?: { broadcasts?: number; verified?: number; mismatches?: number; breakerTrips?: number };
      chains?: Record<string, { anchored?: number; verified?: number; lastTxid?: string | null; status?: string }>;
    };
    const perChain = Object.fromEntries(
      Object.entries(relay.chains ?? {}).map(([k, v]) => [k, {
        anchored: v.anchored ?? 0, verified: v.verified ?? 0, status: v.status ?? "unknown", lastTxid: v.lastTxid ?? null,
      }])
    );

    return NextResponse.json({
      ok: true,
      at: Date.now(),
      sovereignPair: {
        base: "SAOS", quote: "USDS", mid, poolMid: poolMid(pool),
        bookDepthMu: depthMu, liveOrders: st.orders.filter((o) => o.live).length,
        height: st.height, stateRoot: stateRoot(st),
      },
      A,
      A2,
      B: { replay: B1, poolSandwich: B2, bookSandwich: B3 },
      C,
      sovereignty: {
        verified: relay.metrics?.verified ?? 0,
        broadcasts: relay.metrics?.broadcasts ?? 0,
        mismatches: relay.metrics?.mismatches ?? 0,
        breakerTrips: relay.metrics?.breakerTrips ?? 0,
        rails: Object.keys(perChain).length,
        perChain,
        bridgesRequired: 0,
      },
      meta: {
        // FIX(SETTLE-7): נגזר מ-GAS_TABLE — היה-מקודש (200/220) בעוד-הטבלה החיה
        // אומרת 60/100 מאז-SETTLE-5 (לוח-הזמנים-סיבולת). ממשק-ההוכחה הציג-נתונים-שקריים.
        gasFill: GAS_TABLE.fill, gasPoolSwap: GAS_TABLE.pool_swap, feeBpsBook: 0, feeBpsPool: 30,
        notes: [
          "A: book fills at exact maker price (book.ts matchBook) vs pool x*y=k + 30bps (amm.ts poolSwap)",
          "B1: identical op stream on 3 fresh genesis states → identical stateRoot (kernel.ts applyOp determinism)",
          "B2/B3: same sandwich strategy — pool yields positive extraction, book yields negative attacker PnL",
          "C: share of live fill volume matched against grid-soldier quotes — zero external LPs",
        ],
      },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
