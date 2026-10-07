import { NextResponse } from "next/server";
import { ensureChain } from "@/lib/dex/chain";

export const dynamic = "force-dynamic";

/** ההזמנות החיות (לניהול וביטול) — EXEC-CD-22: סינון-סוכן ?issuer=legion-<name> */
export async function GET(req: Request) {
  const rt = ensureChain();
  const u = new URL(req.url);
  const raw = (u.searchParams.get("issuer") || "operator").trim().toLowerCase();
  const issuer = /^[a-z0-9][a-z0-9-]{0,23}$/.test(raw) ? raw : "operator";
  const orders = rt.st.orders
    .filter((o) => o.live && o.owner === issuer)
    .map((o) => ({
      id: o.id, base: o.base, quote: o.quote, side: o.side,
      price: o.price, amount: o.amount, filled: o.filled,
    }));
  return NextResponse.json({ ok: true, orders });
}
