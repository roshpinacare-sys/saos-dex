import { NextResponse } from "next/server";
import { submitOp, nextNonce } from "@/lib/dex/chain";

export const dynamic = "force-dynamic";

/** ניהול-בריכות: add נזילות (פרופורציונלי) או remove (pro-rata LP) */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    action?: "add" | "remove";
    pair?: string; amountA?: number; lp?: number;
  };
  const pair = body.pair;
  if (!pair) return NextResponse.json({ ok: false, error: "pair-required" }, { status: 200 });

  if (body.action === "add") {
    const amountA = Math.floor(Number(body.amountA));
    if (!(amountA > 0)) return NextResponse.json({ ok: false, error: "bad-amount" }, { status: 200 });
    const r = submitOp({
      type: "pool_add", issuer: "operator", nonce: nextNonce("pa"),
      pair, amount: amountA,
    });
    return NextResponse.json({ ok: r.queued, error: r.reason });
  }

  if (body.action === "remove") {
    const lp = Math.floor(Number(body.lp));
    if (!(lp > 0)) return NextResponse.json({ ok: false, error: "bad-lp" }, { status: 200 });
    const r = submitOp({
      type: "pool_rmw", issuer: "operator", nonce: nextNonce("pr"),
      pair, lp,
    });
    return NextResponse.json({ ok: r.queued, error: r.reason });
  }

  return NextResponse.json({ ok: false, error: "bad-action" }, { status: 200 });
}
