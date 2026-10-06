import { NextResponse } from "next/server";
import { kpair, tradesFor } from "@/lib/dex/klines";

export const dynamic = "force-dynamic";

/** Task 83 · GET /api/dex/trades — היסטוריית-עסקאות עם עימוד-cursor (חדשות-בראש).
 * ?pair=SAOS/USDS & limit≤500 & before=<ms cursor> — סטנדרט-בורסות לטייפ-היסטורי. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const pairQ = url.searchParams.get("pair") ?? "";
  const limit = Math.min(Math.max(1, Math.floor(Number(url.searchParams.get("limit") ?? 50) || 50)), 500);
  const before = Math.floor(Number(url.searchParams.get("before") ?? 0) || 0);

  let pair = "";
  if (pairQ.includes("/")) {
    const [a, b] = pairQ.split("/");
    pair = kpair(a, b);
  } else {
    pair = kpair("SAOS", "USDS");
  }

  const trades = tradesFor(pair, limit, before || undefined);
  const oldest = trades.length > 0 ? trades[trades.length - 1].at : 0;
  return NextResponse.json(
    {
      ok: true,
      pair,
      trades,
      count: trades.length,
      nextBefore: trades.length >= limit ? oldest : null,
      note: "עסקאות-אמת מהגרעין — ring-2,000-פר-זוג (טבעת-זיכרון, חוץ-מצב)",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
