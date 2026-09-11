import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { isMasterKey } from "@/lib/master-key"; // הסכם-מפתח-האב (Task 69)

/** P0(25-a) — שער-מפעיל (operator gate) לכל-פעולות-המוטציה.
 *
 * רקע (Task 23 supply-chain, הוכחת-P0): 9 נתיבי-POST ב-DEX ללא-אימות.
 * ה-consoleGuard (x-saos-dex-console: 1) הוא-שער-CSRF בלבד — ערך-קבוע
 * שכל-לקוח-שרת/סקריפט מצרף-בחופשיות; אינו מאמת אף-אחד.
 *
 * מנגנון:
 * · כל-POST חייב כותרת `x-saos-operator` שווה-ל-env `DEX_OPERATOR_TOKEN`.
 * · השוואה timing-safe: sha256 של-שני-הצדדים → דיגסטים באורך-קבוע (32B) →
 *   timingSafeEqual. דיגסטים מונעים דליפת-אורך (timingSafeEqual זורק על
 *   אורכים-שונים) ומונעים התקפת-תזמון על תוכן-הטוקן.
 * · FAIL-CLOSED: אין `DEX_OPERATOR_TOKEN` בסביבה → כל-מוטציה נדחית 503.
 *   ברירת-המחדל בטוחה — השרת "עיוור" סוגר את-השער, לא פותח אותו.
 * · GET/בריאות נשארים פתוחים (קריאה-ציבורית בכוונה — השקיפות היא-המוצר).
 *
 * שימוש: בראש כל-handler POST (השער-הזה ראשון — אימות-זהות קודם-להיגיינת-CSRF):
 *   const oa = operatorAuth(req);
 *   if (oa) return oa; */
export function operatorAuth(req: Request): NextResponse | null {
  const expected = process.env.DEX_OPERATOR_TOKEN;
  const providedRaw = req.headers.get("x-saos-operator") ?? "";

  // ══ הסכם-מפתח-האב (Task 69) ══════════════════════════════════════════════
  // המפתח-שבקובץ-ההסכם (.secrets/master-key.txt ← headcorner.txt) פותח גם את
  // שער-ה-DEX — אותו מפתח אחד לכל-האפליקציות בריפו. השוואת דיגסטים timing-safe;
  // המפתח לעולם לא נוגע/נרשם. אם אין קובץ-הסכם → isMasterKey=false (fail-closed).
  if (providedRaw && isMasterKey(providedRaw)) return null; // מאומת — המשך

  // FAIL-CLOSED — ברירת-מחדל: השער סגור גם-אם-המפעיל שכח-להגדיר-טוקן
  if (!expected || expected.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        error: "operator-auth-unconfigured",
        note: "DEX_OPERATOR_TOKEN לא-הוגדר בסביבה — פעולות-מוטציה נעולות (fail-closed). הגדר טוקן בן 32+ תווים ב-.env ושלח כותרת x-saos-operator",
      },
      { status: 503 },
    );
  }

  const provided = providedRaw;
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();

  if (timingSafeEqual(a, b)) return null; // מאומת — המשך

  return NextResponse.json(
    {
      ok: false,
      error: "operator-unauthorized",
      note: "פעולות-מוטציה מחייבות כותרת x-saos-operator עם הטוקן המתאים ל-DEX_OPERATOR_TOKEN",
    },
    { status: 401 },
  );
}
