import { NextResponse } from "next/server";
import { getArena, setArenaParams } from "@/lib/dex/chain";
import type { ArenaParams } from "@/lib/dex/mm";
import { consoleGuard } from "@/lib/dex/guard";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ok: true, arena: getArena() });
}

/** עדכון-פרמטרים של הארנה האוטונומית (אוטופיילוט) */
export async function POST(req: Request) {
  // FIX(FOUNDRY top-bug): שער-קונסולה — מוטציה-דורשת-כותרת-מנהלת
  const g = consoleGuard(req);
  if (g) return g;

  const body = (await req.json().catch(() => ({}))) as Partial<ArenaParams>;
  const params = setArenaParams(body);
  return NextResponse.json({ ok: true, params });
}
