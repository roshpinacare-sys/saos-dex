import { NextResponse } from "next/server";
import { submitOp, nextNonce, getLiveState } from "@/lib/dex/chain";
import { consoleGuard } from "@/lib/dex/guard";
import { operatorAuth } from "@/lib/operator-auth";
import { cowState } from "@/lib/dex/cow";

export const dynamic = "force-dynamic";

/** Task 58 · CoW-אצווה — ה-API (GET ציבורי · POST דרך-השער).
 * הזמנות-אצווה נסגרות-בסוף-הבלוק במחיר-שווק-אחיד; עודף-המחיר נשאר-אצל-הסוחרים. */

const ISSUER_RE = /^[a-z0-9_-]{2,24}$/;

function issuerOf(body: { as?: unknown }): string {
  const as = String(body.as ?? "").toLowerCase();
  return ISSUER_RE.test(as) ? as : "operator";
}

/** GET — מצב-האצוות: פתוחות + מדידות + יומן-סליקה (ציבורי). */
export async function GET() {
  return NextResponse.json(cowState(getLiveState()));
}

/** POST — order · cancel (מוטציות-ממפול). שערים: operatorAuth + consoleGuard. */
export async function POST(req: Request) {
  const oa = operatorAuth(req);
  if (oa) return oa;
  const g = consoleGuard(req);
  if (g) return g;

  const body = (await req.json().catch(() => ({}))) as {
    op?: string; orderId?: number;
    base?: string; quote?: string; side?: "buy" | "sell";
    price?: number; amount?: number; as?: string;
  };
  const op = String(body.op ?? "");
  const issuer = issuerOf(body);
  const num = (v: unknown): number => Math.floor(Number(v ?? 0));

  if (op === "order") {
    const base = String(body.base ?? "").toUpperCase();
    const quote = String(body.quote ?? "").toUpperCase();
    const side = body.side;
    const price = num(body.price);
    const amount = num(body.amount);
    if ((side !== "buy" && side !== "sell") || !base || !quote || base === quote || !(price > 0) || !(amount > 0))
      return NextResponse.json({ ok: false, error: "bad-request", note: "נדרש: base, quote, side, price, amount" }, { status: 200 });
    const r = submitOp({
      type: "cow_order", issuer, nonce: nextNonce("cow"),
      base: base as never, quote: quote as never, side, price, amount,
    });
    return NextResponse.json({
      ok: r.queued, error: r.reason,
      note: r.queued ? "הזמנת-האצווה נקלטה — תיסגר בסוף-הבלוק במחיר-אחיד (או תחצה לבריכות/ספר)" : undefined,
    });
  }
  if (op === "cancel") {
    if (!(num(body.orderId) > 0))
      return NextResponse.json({ ok: false, error: "bad-request", note: "נדרש: orderId" }, { status: 200 });
    const r = submitOp({ type: "cow_cancel", issuer, nonce: nextNonce("cowx"), orderId: num(body.orderId) });
    return NextResponse.json({ ok: r.queued, error: r.reason });
  }
  return NextResponse.json({ ok: false, error: "unknown-op", note: "פעולות: order · cancel" }, { status: 200 });
}
