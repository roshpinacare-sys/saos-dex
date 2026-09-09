import { NextResponse } from "next/server";
import { getLiveState } from "@/lib/dex/chain";
import { aleState } from "@/lib/dex/ale";

export const dynamic = "force-dynamic";

/* ══ ALE · מנוע-הנזילות-האוטונומית (Task 55) ═════════════════════════════════
 * GET /api/dex/ale → הדוח-החי: POL% אמת, שווי-עמדות-LP-אוצר, פלאיהול
 * (עמלות→שריפה/ve/אוצר→הזרעה→נזילות-עמוקה-יותר), הוכחות-אוטונומיה
 * (fills-ארנה-בלי-משתמשים), יומן-הזרעות, ומסדרון-הכספת (backing-אמת).
 * קריאה-בלבד · קצוות-כנים · אפס-זיוף — הכל-נמדד-מהמצב-החי-של-הגרעין. */
export async function GET() {
  return NextResponse.json(aleState(getLiveState()));
}
