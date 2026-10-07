import { NextResponse } from "next/server";
import { ensureChain, submitOp, nextNonce } from "@/lib/dex/chain";
import { consoleGuard } from "@/lib/dex/guard";
import { operatorAuth } from "@/lib/operator-auth";

export const dynamic = "force-dynamic";

/** ביטול-הזמנה — בעלים-בלבד (operator על שלו) */
export async function POST(req: Request) {
  // P0(25-a): שער-מפעיל — מוטציה דורשת טוקן x-saos-operator (בלי DEX_OPERATOR_TOKEN: 503 fail-closed)
  const oa = operatorAuth(req);
  if (oa) return oa;

  // FIX(FOUNDRY top-bug): שער-קונסולה — מוטציה-דורשת-כותרת-מנהלת
  const g = consoleGuard(req);
  if (g) return g;

  // EXEC-CD-22 · THE-LEGION: ביטול-סוכן — סוכן מבטל רק את-הפקודות-שלו (owner-בדיקה),
  // operator ממשיך לבטל-הכל (תאימות-לאחור).
  const body = (await req.json().catch(() => ({}))) as { orderId?: number; issuer?: string };
  const orderId = Math.floor(Number(body.orderId));
  if (!(orderId > 0)) return NextResponse.json({ ok: false, error: "bad-order-id" }, { status: 200 });
  const rt = ensureChain();
  const order = rt.st.orders.find((o) => o.id === orderId);
  if (!order) return NextResponse.json({ ok: false, error: "not-found" }, { status: 200 });
  const agentRaw = typeof body.issuer === "string" ? body.issuer.trim().toLowerCase() : "";
  const agent = /^[a-z0-9][a-z0-9-]{0,23}$/.test(agentRaw) ? agentRaw : "operator";
  if (order.owner !== agent) return NextResponse.json({ ok: false, error: `not-owner (ההזמנה שייכת ל-${order.owner})` }, { status: 200 });
  const r = submitOp({ type: "cancel", issuer: agent, nonce: nextNonce("cx"), orderId });
  return NextResponse.json({ ok: r.queued, error: r.reason });
}
