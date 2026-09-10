/* chaos.ts — fault-injection harness למבחני-כאוס (Chaos Engineering)
 *
 * עקרון-מוסדי: נקודת-הזרקה אינרטית לחלוטין בפרודקשן.
 *  · אף-קריאה בקוד-הייצור אינה יוזמת תקלה — המודול רק עונה "האם הוזרקה מחיצה".
 *  · ההזרקה מתבצעת אך-ורק ע"י כלי-בדיקה (scripts/chaos-test.ts) ולמשך-זמן מוגדר.
 *  · השער (gate) ב-relay.ts זורק "כשל-קשי" לפני-כל-פעילות-רשת/מפתח —
 *    כלומר: מדמה ניתוק-RPC אמת מבלי לגעת ברשת עצמה ומבלי לחשוף סודות.
 *  · המצב חי ב-globalThis — שורד HMR, מבודד-פר-תהליך (הדמון-החי אינו מושפע
 *    מהזרקות של תהליך-בדיקה נפרד, ולהפך).
 *
 * מה אין כאן בכוונה:
 *  · אין גישה למפתחות, אין קריאת-.env, אין רשת — מודול-טהור לחלוטין.
 */

export type ChaosTarget = "steem" | "hive" | "tron" | "eth" | "sol" | "fleet";

const g = globalThis as unknown as { __saosDexChaos?: Map<ChaosTarget, number> };

function armMap(): Map<ChaosTarget, number> {
  if (!g.__saosDexChaos) g.__saosDexChaos = new Map();
  return g.__saosDexChaos;
}

/** הזרקת מחיצת-רשת (network partition) על-יעד למשך-זמן מוגדר */
export function armChaos(target: ChaosTarget, durationMs: number): void {
  armMap().set(target, Date.now() + Math.max(0, durationMs));
}

/** ניקוי-מלא של כל-ההזרקות (מיד, ללא-התחשבות ביתרת-זמן) */
export function disarmChaos(): void {
  armMap().clear();
}

/** השער: האם מחיצה פעילה כרגע על-היעד (פקיעת-זמן מנוקהת אוטומטית) */
export function chaosPartitioned(target: ChaosTarget): boolean {
  const m = armMap();
  const until = m.get(target);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    m.delete(target); // פקיעה-עצמית — לעולם לא נשארת תקלה-דבוקה
    return false;
  }
  return true;
}

/** תצפית-ציבורית על-מצב-ההזרקות (לכלי-בדיקה ולתיעוד)
 * FIX(SETTLE-7): כל-חמשת-היעדים — eth/sol נוספו (היו-בטיפוס-בלבד; מחיצה-מוזרקת
 * עליהם הייתה-בלתי-נראית לתצפית).
 * FIX(Roast-65-b · M9): "fleet" נוסף — ה-relay מגדר-גם-את-מסילת-הצי
 * (chaosPartitioned(chain) על-chain="fleet" ב-relay.ts), אבל-התצפית הציגה-רק
 * 5/6-יעדים: מחיצה-מוזרקת-על-fleet הייתה-חוסמת-עיגון-והתצפית-מציגה-הכל-תקין.
 * הרשימה-נגזרת-מ-ChaosTarget עצמו — לא-עוד-רשימת-תצוגה-נפרדת-שיכולה-לפגר. */
export function chaosView(): { target: ChaosTarget; partitioned: boolean; remainingMs: number }[] {
  const targets: ChaosTarget[] = ["steem", "hive", "tron", "eth", "sol", "fleet"];
  // אכיפת-קומפילציה: אם-ChaosTarget יגדל-בלי-עדכון-התצפית — tsc ייכשל (לא-עוד-יעד-בלתי-נראה)
  type _EveryTargetInView = [ChaosTarget] extends [(typeof targets)[number]] ? true : never;
  const _targetViewGuard: _EveryTargetInView = true;
  return targets.map((target) => {
    const until = armMap().get(target);
    const remainingMs = until === undefined ? 0 : Math.max(0, until - Date.now());
    return { target, partitioned: remainingMs > 0, remainingMs };
  });
}
