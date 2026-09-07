import { NextResponse } from "next/server";
import { bench } from "@/lib/dex/chain";

export const dynamic = "force-dynamic";

/** הוכחת-יכולת: מדידת-קצב אמת על מצב-טרי (מורשת grid98 --bench) */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const ops = Math.min(200_000, Math.max(1_000, Math.floor(Number(url.searchParams.get("ops") ?? 20_000))));
  const r = bench(ops);
  return NextResponse.json({ ok: true, ...r, verdict: `${(r.perDay / 1_000_000).toFixed(1)}M ops/יום תאורטי` });
}
