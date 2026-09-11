import { NextResponse } from "next/server";
import { consoleGuard } from "@/lib/dex/guard";
import { operatorAuth } from "@/lib/operator-auth";
import { agentStatus, planSwap, runSwap, runRail, planRail } from "@/lib/dex/agent";
import type { RailRequest, RailAction } from "@/lib/dex/rail-exec";

export const dynamic = "force-dynamic";

/* ══ סוכן-הסוואפ (Roast-73 · THE-SWAP-AGENT) ═══════════════════════════════
 * GET  /api/dex/agent → מצב-הסוכן: יכולות-חיות + מסילה + צי + מטריצת-הצתה +
 *                        יומן-40-הריצות-האחרונות (ציבורי · אפס-סודות).
 * POST /api/dex/agent (שער-מפעיל + שער-קונסולה):
 *   { kind: "plan-swap", assetIn, assetOut, amount, minOut?, issuer? } → תוכנית
 *   { kind: "swap",      assetIn, assetOut, amount, minOut?, issuer? } → ביצוע-אטומי
 *   { kind: "plan-rail", action, symbol?, quantity?, price?, amount?, to? } → תוכנית-מסילה
 *   { kind: "rail",      ...אותו-גוף } → ביצוע-שרשרת-אמת (txid אמת)
 *
 * המפעיל שולח-את-הסוכן — הסוכן מטפל-בהכל: תכנון, סמכויות, אורקל, אטומיות,
 * יומן. fail-closed-בכל-שכבה; שגיאות-כנות-ומפורטות. */

const RAIL_ACTIONS: RailAction[] = ["sell", "withdraw", "powerup", "transfer"];

export async function GET() {
  return NextResponse.json(await agentStatus());
}

export async function POST(req: Request) {
  const oa = operatorAuth(req);
  if (oa) return oa;
  const g = consoleGuard(req);
  if (g) return g;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const kind = String(body.kind ?? "").trim();

  if (kind === "plan-swap" || kind === "swap") {
    const assetIn = String(body.assetIn ?? "").toUpperCase();
    const assetOut = String(body.assetOut ?? "").toUpperCase();
    const amount = Math.floor(Number(body.amount));
    const minOut = body.minOut === undefined || body.minOut === null ? undefined : Math.max(0, Math.floor(Number(body.minOut)));
    const issuer = String(body.issuer ?? "operator").toLowerCase();
    if (!amount || amount <= 0) return NextResponse.json({ ok: false, error: "bad-amount" }, { status: 200 });

    if (kind === "plan-swap") {
      const plan = planSwap(assetIn, assetOut, amount, minOut, issuer);
      return NextResponse.json({ ...plan, kind });
    }
    const r = runSwap(assetIn, assetOut, amount, minOut, issuer);
    return NextResponse.json({ ok: r.ok, error: r.error ?? null, run: r.run ?? null, kind }, { status: 200 });
  }

  if (kind === "plan-rail" || kind === "rail") {
    const action = String(body.action ?? "") as RailAction;
    if (!RAIL_ACTIONS.includes(action)) {
      return NextResponse.json({ ok: false, error: `bad-action (allowlist: ${RAIL_ACTIONS.join(",")})` }, { status: 200 });
    }
    const railReq: RailRequest = {
      account: String(body.account ?? "__sovereign__"), // rail-exec כופף-את-החשבון-לזהות-הריבונית
      action,
      symbol: body.symbol ? String(body.symbol).toUpperCase() : undefined,
      quantity: body.quantity === undefined ? undefined : Number(body.quantity),
      price: body.price === undefined ? undefined : Number(body.price),
      amount: body.amount === undefined ? undefined : Number(body.amount),
      to: body.to ? String(body.to) : undefined,
    };
    if (kind === "plan-rail") {
      const plan = await planRail(railReq);
      return NextResponse.json({ ...plan, kind, network: "HIVE" });
    }
    const r = await runRail(railReq);
    return NextResponse.json({ ok: r.ok, error: r.error ?? null, run: r.run ?? null, kind, network: "HIVE" }, { status: 200 });
  }

  return NextResponse.json({
    ok: false,
    error: "bad-kind (allowlist: plan-swap, swap, plan-rail, rail)",
  }, { status: 200 });
}
