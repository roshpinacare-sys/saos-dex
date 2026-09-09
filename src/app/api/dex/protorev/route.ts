import { NextResponse } from "next/server";
import { getLiveState } from "@/lib/dex/chain";
import { protoRevState } from "@/lib/dex/protorev";

export const dynamic = "force-dynamic";

/** Task 57/58 · ProtoRev — דוח-הארביטראז'-הפנימי (GET ציבורי — שקיפות-מלאה).
 * שולחן-הארב הוא האוצר-עצמו; הרווח → revAux → 40%-שריפה/40%-ve/20%-אוצר. */
export async function GET() {
  return NextResponse.json(protoRevState(getLiveState()));
}
