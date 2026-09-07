/**
 * invariant.ts — Formal Assertions: חוק-הברזל של Fail-Fast (מהדורת-ביקורת).
 *
 * SECURITY INTENT: אינווריאנטה היא חוק-מצב שאסור-להפר בשום-נתיב-ביצוע.
 * כל-פונקציה קריטית (matchBook, seal) מצהירה את חוקיה בקוד עצמו — לא בתיעוד
 * בלבד. הפרה = מצב-עולם לא-מוגדר, והמערכת מסרבת להמשיך בו:
 *   · invariant() זורק InvariantViolation מיד (fail-fast, לא console.assert שקט)
 *   · לולאת-הפעימה (chain.tick) זיהה את הזריקה ומעלה-את-השרשרת (HALT) —
 *     עדיין-חיים לקריאה, אך לא בונה בלוקים נוספים ממצב-חשוד.
 * זו הפרדת-העולמות המוסדית: כשל-תפעול (רשת/DB) = המשך-פעולה מבוקר;
 * הפרת-אינווריאנטה = עצירה מיידית ומוכרזת.
 */
export class InvariantViolation extends Error {
  constructor(message: string) {
    super(`INVARIANT-VIOLATION: ${message}`);
    this.name = "InvariantViolation";
  }
}

/**
 * invariant — assertion מפורש עם סמנטיקת `asserts cond` של TypeScript.
 * עובר-שקט בנתיב-השמחה (השוואת-שלמים בלבד — עלות-זניחה בחם);
 * בהפרה — InvariantViolation עם מזהה-מכונן קריא (מדד-אופרטיבי + ראיה).
 */
export function invariant(cond: unknown, message: string): asserts cond {
  if (!cond) throw new InvariantViolation(message);
}
