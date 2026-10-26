import { NextResponse } from "next/server";
import { fixedfloatGetRate } from "@/lib/dex/fixedfloat";

export const dynamic = "force-dynamic";

/* ══ BRIDGE QUOTE (directive §4 foundation · task E12) ═══════════════════════
 * READ-ONLY live external-swap quote from FixedFloat (ff.io v2 /price).
 * GET /api/dex/bridge/quote?from=btc&to=eth[&amount=1][&type=float]
 *   → { ok:true, provider:"fixedfloat", rate, minAmount, maxAmount, … }
 * Fail path: 503 + { ok:false, error } — the provider's own error text, no
 * fabrication, no cached fallback (the outside price is only honest when live).
 * No operator gate: the route moves no money and reveals no key material
 * (read-only /price call under the hood). no-store: a quote is a moment. */

export async function GET(req: Request) {
  const url = new URL(req.url);
  const from = (url.searchParams.get("from") || "").trim();
  const to = (url.searchParams.get("to") || "").trim();
  const amount = Number(url.searchParams.get("amount") || "1");
  const type = url.searchParams.get("type") === "fixed" ? "fixed" : "float";

  if (!from || !to) {
    return NextResponse.json(
      { ok: false, provider: "fixedfloat", error: "missing query params: ?from=<ccy>&to=<ccy> (e.g. from=btc&to=eth)" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    const q = await fixedfloatGetRate(from, to, {
      amount: Number.isFinite(amount) && amount > 0 ? amount : 1,
      type,
    });
    return NextResponse.json(
      {
        ok: true,
        provider: "fixedfloat",
        from: q.from.code,
        to: q.to.code,
        networkFrom: q.from.network,
        networkTo: q.to.network,
        rate: q.from.rate, // measured live: /price puts the pair rate on data.from.rate (toCcy per 1 fromCcy)
        minAmount: q.from.min,
        maxAmount: q.from.max,
        toMin: q.to.min,
        toMax: q.to.max,
        type,
        amount: q.from.amount,
        fetchedAt: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, provider: "fixedfloat", error: e instanceof Error ? e.message : String(e) },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
