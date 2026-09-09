import { NextResponse } from "next/server";
import { nextNonce, submitOp, getLiveState } from "@/lib/dex/chain";
import { consoleGuard } from "@/lib/dex/guard";
import { operatorAuth } from "@/lib/operator-auth";

export const dynamic = "force-dynamic";

/* ══ רישום-נכסים (SETTLE-15) — שער-אוצר ל-asset_list/asset_price ══════════════
 * GET  — כל-הנכסים-הרשומים ומחירי-הייחוס (ציבורי).
 * POST {action:"price"|"list", asset, refPrice} — שער-מפעיל; ה-op עצמו
 *       treasury-only בגרעין (GAS 70/40). שימש-חי: יישור-refPrice של
 *       WSTEEM:=STEEM (עטיפה-1:1 — אמת-חשבונית). */

export async function GET() {
  const st = getLiveState();
  return NextResponse.json({ ok: true, assets: st.assets, backing: st.backing });
}

export async function POST(req: Request) {
  const oa = operatorAuth(req);
  if (oa) return oa;
  const g = consoleGuard(req);
  if (g) return g;

  const body = (await req.json().catch(() => ({}))) as { action?: string; asset?: string; refPrice?: number };
  const action = String(body.action ?? "");
  const asset = String(body.asset ?? "").toUpperCase();
  const refPrice = Math.floor(Number(body.refPrice));
  if (action !== "price" && action !== "list") {
    return NextResponse.json({ ok: false, error: "bad-action (price|list)" }, { status: 200 });
  }
  if (!asset || !(refPrice > 0)) return NextResponse.json({ ok: false, error: "bad-asset-or-refPrice" }, { status: 200 });
  const r = submitOp({
    type: action === "price" ? "asset_price" : "asset_list",
    issuer: "treasury", nonce: nextNonce("as"),
    asset: asset as never, refPrice,
  });
  if (!r.queued) return NextResponse.json({ ok: false, error: r.reason ?? "queue-rejected" }, { status: 200 });
  return NextResponse.json({ ok: true, note: `${action} ${asset} refPrice=${refPrice}µ — ייכלל בבלוק הבא (treasury-op)` });
}
