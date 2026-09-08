import { NextResponse } from "next/server";
import { fencePosture } from "@/lib/dex/fence";

export const dynamic = "force-dynamic";

/** GET /api/dex/security — עמדת-האבטחה המוצהרת (קריאה-בלבד, אפס-סודות).
 * מול פישינג/סוכנים-זרים: מה מקובע, מה מופעל, מה נאכף — בכנות ובבוליאנים. */
export async function GET() {
  return NextResponse.json({ ok: true, security: fencePosture() });
}
