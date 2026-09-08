import { NextResponse } from "next/server";
import { ensureChain, submitOp, nextNonce } from "@/lib/dex/chain";
import { consoleGuard } from "@/lib/dex/guard";

export const dynamic = "force-dynamic";

/** ביטול-הזמנה — בעלים-בלבד (operator על שלו) */
export async function POST(req: Request) {
  // FIX(FOUNDRY top-bug): שער-קונסולה — מוטציה-דורשת-כותרת-מנהלת
  const g = consoleGuard(req);
  if (g) return g;

  const body = (await req.json().catch(() => ({}))) as { orderId?: number };
  const orderId = Math.floor(Number(body.orderId));
  if (!(orderId > 0)) return NextResponse.json({ ok: false, error: "bad-order-id" }, { status: 200 });
  const rt = ensureChain();
  const order = rt.st.orders.find((o) => o.id === orderId);
  if (!order) return NextResponse.json({ ok: false, error: "not-found" }, { status: 200 });
  if (order.owner !== "operator") return NextResponse.json({ ok: false, error: "not-owner (רק-ההזמנות של operator)" }, { status: 200 });
  const r = submitOp({ type: "cancel", issuer: "operator", nonce: nextNonce("cx"), orderId });
  return NextResponse.json({ ok: r.queued, error: r.reason });
}
