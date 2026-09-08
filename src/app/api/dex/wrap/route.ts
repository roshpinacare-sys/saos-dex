import { NextResponse } from "next/server";
import { submitOp, nextNonce } from "@/lib/dex/chain";
import { consoleGuard } from "@/lib/dex/guard";

export const dynamic = "force-dynamic";

/** עטיפה 1:1 כנה (dex-facts): wrap_mint / wrap_burn עם גיבוי נעול */
export async function POST(req: Request) {
  // FIX(FOUNDRY top-bug): שער-קונסולה — מוטציה-דורשת-כותרת-מנהלת
  const g = consoleGuard(req);
  if (g) return g;

  const body = (await req.json().catch(() => ({}))) as {
    action?: "mint" | "burn";
    asset?: string; amount?: number;
  };
  const amount = Math.floor(Number(body.amount));
  const asset = body.asset;
  if (!asset || !asset.startsWith("W") || !(amount > 0)) {
    return NextResponse.json({ ok: false, error: "bad-wrap (נדרש נכס W* + כמות)" }, { status: 200 });
  }
  const r = submitOp({
    type: body.action === "burn" ? "wrap_burn" : "wrap_mint",
    issuer: "operator",
    nonce: nextNonce("wp"),
    wrapAsset: asset as never, amount,
  });
  return NextResponse.json({ ok: r.queued, error: r.reason });
}
