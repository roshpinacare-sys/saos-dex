import { NextResponse } from "next/server";
import { nextNonce, submitOp } from "@/lib/dex/chain";
import { BATCH_MAX_OPS, type Asset, type Op } from "@/lib/dex/kernel";
import { allLpValuations, quoteRoute, routableMap, wrapPairs } from "@/lib/dex/router";
import { ASSETS } from "@/lib/dex/kernel";
import { consoleGuard } from "@/lib/dex/guard";
import { operatorAuth } from "@/lib/operator-auth";

export const dynamic = "force-dynamic";

/* ══ THE-ROUTER (SETTLE-15) — מקור-הנזיל-שמכניס-מהכל ═════════════════════════
 * GET  /api/dex/route?assetIn=X&assetOut=Y&amount=N
 *      → הציטוט-הטוב-ביותר (רגליים+מחיר-אפקטיבי+חלופות) · מפת-נזילות ·
 *        תמחור-טוקני-LP · מסדרון-העיגון. בלי-amount: רק-המפה.
 * POST /api/dex/route {assetIn, assetOut, amount, minOut?} → ביצוע-אטומי
 *      דרך-batch (דבר-גורר-דבר): pool_swap/wrap תתי-ops עם-minOut fail-closed
 *      לכל-רגל. הכל-או-כלום — אין-נכס-תלוש-באמצע-שרשרת. */

/** GET — ציטוט חי + מפת-הנזילות (ציבורי, קריאה-בלבד) */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const assetIn = String(url.searchParams.get("assetIn") ?? "").toUpperCase();
  const assetOut = String(url.searchParams.get("assetOut") ?? "USDS").toUpperCase();
  const amountInMu = Math.floor(Number(url.searchParams.get("amount") ?? 0));
  const quote = amountInMu > 0 ? quoteRoute(assetIn, assetOut, amountInMu) : null;
  return NextResponse.json({
    ok: true,
    quote,
    routable: routableMap(),
    wrapRail: wrapPairs(),
    lpValuations: allLpValuations(),
    assets: ASSETS,
    honesty: "ציטוט=סימולציית-שלמים על הבריכות-החיות (30bps לרגל-בריכה) · מסדרון-עיגון 1:1 מוגבל-גיבוי · מפה-כנה: מי-ראוטר-ביל ומי-לא",
  });
}

/** POST — ביצוע-המסלול-הטוב-ביותר כ-batch-אטומי (שער-מפעיל) */
export async function POST(req: Request) {
  const oa = operatorAuth(req);
  if (oa) return oa;
  const g = consoleGuard(req);
  if (g) return g;

  const body = (await req.json().catch(() => ({}))) as {
    assetIn?: string; assetOut?: string; amount?: number; minOut?: number; issuer?: string;
  };
  const assetIn = String(body.assetIn ?? "").toUpperCase();
  const assetOut = String(body.assetOut ?? "").toUpperCase();
  const amount = Math.floor(Number(body.amount));
  const rawMinOut = body.minOut === undefined ? undefined : Number(body.minOut);
  if (!ASSETS.includes(assetIn as Asset) || !ASSETS.includes(assetOut as Asset) || assetIn === assetOut || !(amount > 0)
    || (rawMinOut !== undefined && !Number.isFinite(rawMinOut))) {
    return NextResponse.json({ ok: false, error: "bad-request" }, { status: 200 });
  }
  const minOut = rawMinOut === undefined ? undefined : Math.max(0, Math.floor(rawMinOut));

  const q = quoteRoute(assetIn, assetOut, amount);
  if (!q) return NextResponse.json({ ok: false, error: "no-route" }, { status: 200 });
  if (minOut !== undefined && q.amountOutMu < minOut) {
    return NextResponse.json({ ok: false, error: `quote-below-minOut (${q.amountOutMu} < ${minOut})` }, { status: 200 });
  }
  if (q.legs.length > BATCH_MAX_OPS) return NextResponse.json({ ok: false, error: "route-too-long" }, { status: 200 });

  const issuer = String(body.issuer || "operator").toLowerCase();
  if (!["operator", "treasury", "arena", "portfolio-b"].includes(issuer)) {
    return NextResponse.json({ ok: false, error: "bad-issuer" }, { status: 200 });
  }

  // הרכבת תתי-ops מהמסלול: minOut לכל-רגל = 99% מפלט-הציטוט שלה (fail-closed),
  // והרגל-האחרונה מקבלת את minOut-המפעיל (קפדן-יותר) כשנמסר.
  const sub: Partial<Op>[] = q.legs.map((l, i) => {
    const last = i === q.legs.length - 1;
    const floorMu = Math.floor((l.outMu * 99) / 100);
    if (l.kind === "pool") {
      return {
        type: "pool_swap" as const,
        pair: l.venue.slice(5),
        assetIn: l.from as Asset,
        amount: l.inMu,
        minOut: last && minOut !== undefined ? minOut : floorMu,
      };
    }
    // רגל-עטיפה 1:1 — הכיוון נגזר מהרגל: to=wrapped → mint, to=native → burn
    const wrapped = l.to.startsWith("W") ? l.to : l.from;
    return {
      type: l.to.startsWith("W") ? ("wrap_mint" as const) : ("wrap_burn" as const),
      wrapAsset: wrapped as Asset,
      amount: l.inMu,
    };
  });

  const ops: Op[] = sub.map((s, i) => ({ ...s, issuer, nonce: nextNonce(`rt${i}`) })) as Op[];
  const r = submitOp({ type: "batch", issuer, nonce: nextNonce("rr"), ops });
  if (!r.queued) return NextResponse.json({ ok: false, error: r.reason ?? "queue-rejected" }, { status: 200 });
  return NextResponse.json({
    ok: true, atomic: true,
    route: q.legs.map((l) => l.venue),
    expectOutMu: q.amountOutMu,
    effPriceMu: q.effPriceMu,
    count: ops.length,
    note: `${ops.length} רגליים ב-batch-אטומי (דבר-גורר-דבר) — minOut fail-closed לכל-רגל`,
  });
}
