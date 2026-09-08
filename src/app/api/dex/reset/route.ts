import { NextResponse } from "next/server";
import { resetChain } from "@/lib/dex/chain";

export const dynamic = "force-dynamic";

/** איפוס-סביבה: ג'נזיס טרי + ניקוי-ראיות (כלי-פיתוח, כנה).
 * FIX(SETTLE-7): שער-אישור — היה-POST עירום שמוחק את-כל-הראיות הציבוריות
 * (בלוקים/חותמות/קבלות/עדות-ארנה) בקריאה-אחת ללא-אימות. מחייב
 * { confirm: "WIPE" } — מקרה-מקרי/סקרי-בוט נדחה; מי-שמבקש-מפורש עובר.
 * reset גם-מעיר-שרשרת-מושהית (halted) — נתיב-ההתאוששות הרשמי. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { confirm?: string };
  if (body.confirm !== "WIPE") {
    return NextResponse.json({
      ok: false,
      error: "confirm-required",
      note: "איפוס-מוחלט מוחק כל-הראיות — שלח POST {\"confirm\":\"WIPE\"} כדי-לאשר",
    }, { status: 403 });
  }
  await resetChain();
  return NextResponse.json({ ok: true, note: "אופס לג'נזיס — השרשרת חיה מחדש (halted נוקה, טבעת-הדלק נוקתה)" });
}
