import { NextResponse } from "next/server";
import { kpair, klinesFor } from "@/lib/dex/klines";

export const dynamic = "force-dynamic";

/** Task 83 · GET /api/dex/klines — נרות-OHLCV ממסחר-אמת (סטנדרט-Binance/dYdX).
 * ?pair=SAOS/USDS & interval=1m|5m|15m|1h|4h|1d & limit≤1000 & before=<ms cursor>
 * עימוד-cursor: before = תחילת-הנר-הישן-ביותר-שכבר-קיבלת (מחזיר את-הישן-ממנו).
 * כנות: נר קיים רק-איפה-שהיה-סחר — אפס-מילוי-פערים-מלאכותי. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const baseQ = url.searchParams.get("base") ?? "";
  const quoteQ = url.searchParams.get("quote") ?? "";
  const pairQ = url.searchParams.get("pair") ?? "";
  const raw = url.searchParams.get("interval") ?? "1m";
  const interval = (["1m", "5m", "15m", "1h", "4h", "1d"].includes(raw) ? raw : "1m") as "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
  const limit = Math.min(Math.max(1, Math.floor(Number(url.searchParams.get("limit") ?? 500) || 500)), 1000);
  const before = Math.floor(Number(url.searchParams.get("before") ?? 0) || 0);

  let pair = "";
  if (pairQ.includes("/")) {
    const [a, b] = pairQ.split("/");
    pair = kpair(a, b);
  } else if (baseQ && quoteQ) {
    pair = kpair(baseQ, quoteQ);
  } else {
    pair = kpair("SAOS", "USDS"); // הזוג-הריבוני — ברירת-מחדל
  }

  const candles = klinesFor(pair, interval, limit, before || undefined);
  const oldest = candles.length > 0 ? candles[0].t : 0;
  return NextResponse.json(
    {
      ok: true,
      pair, interval,
      candles,
      count: candles.length,
      nextBefore: candles.length >= limit ? oldest : null, // cursor לעימוד-היסטוריה
      note: "OHLCV ממסחר-אמת בלבד (fill+swap) — חוץ-מצב מוצמד-גיט (db/klines.json); אפס-נרות-מזויפים",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
