import { NextResponse } from "next/server";
import { bench } from "@/lib/dex/chain";
import { operatorAuth } from "@/lib/operator-auth";
import { consoleGuard } from "@/lib/dex/guard"; // FIX(R16-a·m11)

export const dynamic = "force-dynamic";

/** הוכחת-יכולת: מדידת-קצב אמת על מצב-טרי (מורשת grid98 --bench)
 * FIX(Roast-67 · bench-gate): GET-ציבורי-רץ-עד-200k-applyOp-על-ה-thread — וקטור-DoS
 * (מטמון-60ש׳-מרכך-בלבד). המצג-אינו-בשימוש-ה-UI — מגודר-עכשיו-למפעיל (fail-closed). */
export async function GET(req: Request) {
  const oa = operatorAuth(req);
  if (oa) return oa;
  const g = consoleGuard(req); // FIX(R16-a·m11)
  if (g) return g;
  const url = new URL(req.url);
  const ops = Math.min(200_000, Math.max(1_000, Math.floor(Number(url.searchParams.get("ops") ?? 20_000))));
  const r = bench(ops);
  return NextResponse.json({ ok: true, ...r, verdict: `${(r.perDay / 1_000_000).toFixed(1)}M ops/יום תאורטי` });
}
