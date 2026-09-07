import { NextResponse } from "next/server";
import { submitOp, nextNonce } from "@/lib/dex/chain";

export const dynamic = "force-dynamic";

/** הצבת-הזמנת-לימיט (order) או מילוי-מיידי (fill) — חתום כ-operator על הספר הריבוני */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      action?: "order" | "fill";
      base?: string; quote?: string; side?: "buy" | "sell";
      price?: number; amount?: number; market?: boolean;
    };
    const action = body.action === "fill" ? "fill" : "order";
    const amount = Math.floor(Number(body.amount));
    if (!body.base || !body.quote || (body.side !== "buy" && body.side !== "sell") || !(amount > 0)) {
      return NextResponse.json({ ok: false, error: "bad-request" }, { status: 200 });
    }
    const price = body.price === undefined ? undefined : Math.floor(Number(body.price));
    const isMarket = action === "fill";
    if (!isMarket && (!(price && price > 0))) {
      return NextResponse.json({ ok: false, error: "price-required" }, { status: 200 });
    }
    const r = submitOp({
      type: action,
      issuer: "operator",
      nonce: nextNonce("op"),
      base: body.base as never, quote: body.quote as never,
      side: body.side, price, amount,
      market: isMarket ? true : undefined,
    });
    return NextResponse.json({ ok: r.queued, error: r.reason, note: r.queued ? "queued — ייכלל בבלוק הבא (≤3 שנ׳)" : undefined });
  } catch {
    return NextResponse.json({ ok: false, error: "bad-json" }, { status: 200 });
  }
}
