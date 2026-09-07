import { NextResponse } from "next/server";
import { resetChain } from "@/lib/dex/chain";

export const dynamic = "force-dynamic";

/** איפוס-סביבה: ג'נזיס טרי + ניקוי-ראיות (כלי-פיתוח, כנה) */
export async function POST() {
  await resetChain();
  return NextResponse.json({ ok: true, note: "אופס לג'נזיס — השרשרת חיה מחדש" });
}
