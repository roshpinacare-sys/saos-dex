import { NextResponse } from "next/server";
import { ensureChain } from "@/lib/dex/chain";

export const dynamic = "force-dynamic";

/** ההזמנות החיות של operator (לניהול וביטול) */
export async function GET() {
  const rt = ensureChain();
  const orders = rt.st.orders
    .filter((o) => o.live && o.owner === "operator")
    .map((o) => ({
      id: o.id, base: o.base, quote: o.quote, side: o.side,
      price: o.price, amount: o.amount, filled: o.filled,
    }));
  return NextResponse.json({ ok: true, orders });
}
