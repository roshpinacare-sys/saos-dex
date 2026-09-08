import { NextResponse } from "next/server";
import { getQuote, submitOp, nextNonce } from "@/lib/dex/chain";
import { consoleGuard } from "@/lib/dex/guard";

export const dynamic = "force-dynamic";

/** GET quote — ציטוט-AMM חי (בלי-ביצוע) */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const pair = url.searchParams.get("pair") ?? "";
  const assetIn = url.searchParams.get("assetIn") ?? "";
  const amountIn = Math.floor(Number(url.searchParams.get("amount") ?? 0));
  const q = getQuote(pair, assetIn, amountIn);
  if (!q) return NextResponse.json({ ok: false, error: "no-quote" }, { status: 200 });
  return NextResponse.json({ ok: true, ...q });
}

/** POST swap — החלפה דרך בריכת 30bps (minOut fail-closed) */
export async function POST(req: Request) {
  // FIX(FOUNDRY top-bug): שער-קונסולה — מוטציה-דורשת-כותרת-מנהלת
  const g = consoleGuard(req);
  if (g) return g;

  const body = (await req.json().catch(() => ({}))) as {
    pair?: string; assetIn?: string; amount?: number; minOut?: number;
  };
  const amount = Math.floor(Number(body.amount));
  if (!body.pair || !body.assetIn || !(amount > 0)) {
    return NextResponse.json({ ok: false, error: "bad-request" }, { status: 200 });
  }
  const minOut = body.minOut === undefined ? undefined : Math.floor(Number(body.minOut));
  const r = submitOp({
    type: "pool_swap",
    issuer: "operator",
    nonce: nextNonce("sw"),
    pair: body.pair, assetIn: body.assetIn as never, amount, minOut,
  });
  return NextResponse.json({ ok: r.queued, error: r.reason, note: r.queued ? "queued — ייכלל בבלוק הבא" : undefined });
}
