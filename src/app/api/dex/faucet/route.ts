import { NextResponse } from "next/server";
import { operatorFaucet } from "@/lib/dex/chain";
import { consoleGuard } from "@/lib/dex/guard";

export const dynamic = "force-dynamic";

/** ברז-דמו (כנות): העברה-פרוטוקולית מהאוצר ל-operator — פעם ב-60 שנ׳ */
export async function POST(req: Request) {
  // FIX(FOUNDRY top-bug): שער-קונסולה — מוטציה-דורשת-כותרת-מנהלת
  const g = consoleGuard(req);
  if (g) return g;

  const r = operatorFaucet();
  return NextResponse.json(r);
}
