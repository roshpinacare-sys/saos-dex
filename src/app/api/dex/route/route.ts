import { NextResponse } from "next/server";
import { nextNonce, submitOp } from "@/lib/dex/chain";
import { allLpValuations, quoteRoute, quoteSplit, routableMap, wrapPairs } from "@/lib/dex/router";
import { ASSETS } from "@/lib/dex/kernel";
import { buildAtomicRoutePlan, isExecIssuer, toBatchOps } from "@/lib/dex/exec-route";
import { consoleGuard } from "@/lib/dex/guard";
import { operatorAuth } from "@/lib/operator-auth";

export const dynamic = "force-dynamic";

/* ══ THE-ROUTER (SETTLE-15) — מקור-הנזיל-שמכניס-מהכל ═════════════════════════
 * GET  /api/dex/route?assetIn=X&assetOut=Y&amount=N
 *      → הציטוט-הטוב-ביותר (רגליים+מחיר-אפקטיבי+חלופות) · מפת-נזילות ·
 *        תמחור-טוקני-LP · מסדרון-העיגון. בלי-amount: רק-המפה.
 * POST /api/dex/route {assetIn, assetOut, amount, minOut?} → ביצוע-אטומי
 *      דרך-batch (דבר-גורר-דבר): pool_swap/wrap תתי-ops עם-minOut fail-closed
 *      לכל-רגל. הכל-או-כלום — אין-נכס-תלוש-באמצע-שרשרת.
 * FIX(Roast-71): מנוע-הביצוע עבר-ל-exec-route.ts המשותף (אותו-batch-אטומי
 * גם-ב-/api/dex/convert — ביטול-הנתיב-הלא-אטומי) ושער-הנכסים עבר-מרשימה-קבועה
 * ל-knownAsset (נכסי-השקות-כמו LB|LA היו-ציטוט-תקין-וביצוע-נדחה). */

/** GET — ציטוט חי + מפת-הנזילות (ציבורי, קריאה-בלבד) */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const assetIn = String(url.searchParams.get("assetIn") ?? "").toUpperCase();
  const assetOut = String(url.searchParams.get("assetOut") ?? "USDS").toUpperCase();
  const amountInMu = Math.floor(Number(url.searchParams.get("amount") ?? 0));
  const quote = amountInMu > 0 ? quoteRoute(assetIn, assetOut, amountInMu) : null;
  // Task 55 · SPLIT-ROUTING: הפיצול-החכם — רק-אם-הוא-אכן-משתלם (savingBps>0)
  const split = amountInMu > 0 ? quoteSplit(assetIn, assetOut, amountInMu) : null;
  return NextResponse.json({
    ok: true,
    quote,
    split,
    routable: routableMap(),
    wrapRail: wrapPairs(),
    lpValuations: allLpValuations(),
    assets: ASSETS,
    honesty: "ציטוט=סימולציית-שלמים על הבריכות-החיות (30bps לרגל-בריכה) · מסדרון-עיגון 1:1 מוגבל-גיבוי · מפה-כנה: מי-ראוטר-ביל ומי-לא · פיצול-מסלול מוצע-רק-כשהוא משתלם",
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
  const minOut = rawMinOut === undefined ? undefined : Math.max(0, Math.floor(rawMinOut));

  const plan = buildAtomicRoutePlan(assetIn, assetOut, amount, minOut);
  if (!plan.ok || !plan.sub) {
    return NextResponse.json({ ok: false, error: plan.error ?? "no-route" }, { status: 200 });
  }

  const issuer = String(body.issuer || "operator").toLowerCase();
  if (!isExecIssuer(issuer)) return NextResponse.json({ ok: false, error: "bad-issuer" }, { status: 200 });

  const ops = toBatchOps(plan.sub, issuer, "rt");
  const r = submitOp({ type: "batch", issuer, nonce: nextNonce("rr"), ops });
  if (!r.queued) return NextResponse.json({ ok: false, error: r.reason ?? "queue-rejected" }, { status: 200 });
  return NextResponse.json({
    ok: true, atomic: true,
    route: plan.routeVenues,
    expectOutMu: plan.expectOutMu,
    effPriceMu: plan.effPriceMu,
    count: ops.length,
    note: `${ops.length} רגליים ב-batch-אטומי (דבר-גורר-דבר) — minOut fail-closed לכל-רגל`,
  });
}
