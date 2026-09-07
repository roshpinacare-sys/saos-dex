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

export type ChaosTarget = "steem" | "hive" | "tron";

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

/** תצפית-ציבורית על-מצב-ההזרקות (לכלי-בדיקה ולתיעוד) */
export function chaosView(): { target: ChaosTarget; partitioned: boolean; remainingMs: number }[] {
  return (["steem", "hive", "tron"] as ChaosTarget[]).map((target) => {
    const until = armMap().get(target);
    const remainingMs = until === undefined ? 0 : Math.max(0, until - Date.now());
    return { target, partitioned: remainingMs > 0, remainingMs };
  });
}
