import { NextResponse } from "next/server";

/** FIX(FOUNDRY-NET-AUDIT top-bug: "0-auth routes") — שער-קונסולה לפעולות-מוטציה.
 *
 * מנגנון: כותרת-מנהלת `x-saos-dex-console: 1` חובה בכל-POST.
 * · דפדפן-חוצה-מקור אינו-יכול-לצרף-כותרת-מותאמת-בלי-preflight, ו-preflight
 *   נכשל-כאן (אין-CORS-מאושר) — כלומר-הכותרת פועלת-כשער-CSRF אמיתי.
 * · הקונסולה-שלנו (אותו-מקור) וכלי-שרת/פיתוח מצרפים-אותה-בחופשיות.
 * · GET נשאר-פתוח-לגמרי (תצפית-ציבורית-בכוונה — השקיפות-היא-המוצר).
 *
 * זהו-שער-היגיינה, לא-גבול-ריבונות: הדקס הוא סימולציה-סגורה (אפס-כסף-אמת);
 * הערך-המוגן הוא תקינות-הראיות-הציבוריות מפני-קריאות-מקריות/זוחלות. */
export function consoleGuard(req: Request): NextResponse | null {
  if (req.headers.get("x-saos-dex-console") === "1") return null;
  return NextResponse.json(
    {
      ok: false,
      error: "console-header-required",
      note: "פעולות-מוטציה מחייבות כותרת x-saos-dex-console: 1 (שער-CSRF — קונסולה בלבד)",
    },
    { status: 403 },
  );
}
