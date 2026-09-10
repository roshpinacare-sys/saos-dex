import { NextResponse } from "next/server";
import { getLiveState } from "@/lib/dex/chain";
import { truthLedger } from "@/lib/dex/truth";

export const dynamic = "force-dynamic";

/** GET — מנוע-האמת (Task 61) · ציבורי-מלא.
 * ספר-אמת חי: פסק-דין-כן לכל-נכס (REAL/INTERNAL/UNBACKED/FAKE-PEG),
 * גיבוי-אמת-מהשרשראות (SP/BP/HP בגורמים-חיים), מחיר-חוץ-אמת,
 * מסילת-WBLURT-מגובה-חי (אתחול-אידמפוטנטי-בקריאה-הראשונה),
 * וסולם-יציאה-עם-החסמים-האמתיים. */
export async function GET() {
  try {
    const st = getLiveState();
    const report = await truthLedger(st);
    return NextResponse.json(report);
  } catch (e) {
    return NextResponse.json({
      ok: false,
      error: "truth-error",
      note: e instanceof Error ? e.message : "unknown",
    }, { status: 200 });
  }
}
