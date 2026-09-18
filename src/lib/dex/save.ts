/**
 * save.ts — R40 · THE-SAVE: חיסכון-USDS בהכנסה-מדודה.
 * ============================================================================
 * המכשיר שחסר לשאלת "למה שיפקידו?": המפקיד מזקין USDS ← מקבל את **כל** הכנסת
 * הרשת המדודה שמגיעה בפועל לאוצר כ-USDS נזיל (היום: ריבית-כספת-ההלוואות —
 * מעבירות-פירעון אמת), יום-אחר-יום, פרו-ראטה לפי קרן. אפס הטבעה: הריבית
 * מועברת מיתרת-האוצר האמיתית — אם אין כיסוי, הצבירה נחתכת בכנות (חלקית).
 *
 * חוקי-המכשיר (כנות-מלאה, ריפליי-מדויק):
 *   · קרן חוסכים בחשבון-עד (save-pot) — העברה טהורה, אפס הטבעת USDS לעולם.
 *   · הכנסה = דלתא במונה ריבית-הכספת (vaultTot.interestMu) — מדידה-שנצברה
 *     בשרשרת, לא-הבטחה. אין-הכנסה ← אין-ריבית. השיעור המפורסם הוא המדוד.
 *   · פרו-ראטה לפי קרן-חייה בעת-הצבירה — מי-שהפקיד באמצע-היום מקבל מהרגע-שהפקיד.
 *   · המפעיל חוסך בעצמו (עמדת-הדגמה על-כסף-הפנים-האמיתי-שלו) — אותם-חוקים,
 *     אותו-שיעור-מדוד. הוכחת-החיים של המכשיר אינה-תיאטרון: הכסף נשאר-שם-וצובר.
 *   · שקיפות-מלאה: potMu, paidMu, שיעור-חלון-היום — הכל במראה-הציבורית (world.json).
 */
import type { DexState, Op, OpResult } from "./kernel";
import { addBal, avail, vaultTotals } from "./kernel";

/** צבירת-הכנסה — נקראת בכל-בלוק מבונה-הבלוקים (אחרי-סוכן-הכספת):
 *  דלתא-ריבית-כספת שהגיעה בפועל ← מחולקת-לחוסכים פרו-ראטה, מגובה-יתרת-אוצר-אמת. */
export function savingsTick(st: DexState, nowMs: number): void {
  if (!st.savings) {
    // התחלה-קנונית-דטרמיניסטית לתמונות-מצב-ישנות (שנולדו-טרם-המכשיר):
    // lastIncomeMu נפתח במונה-הריבית-הנוכחי — אין-חלוקה-רטרואקטיבית לעולם.
    st.savings = { positions: {}, potMu: 0, paidMu: 0, lastIncomeMu: vaultTotals(st).interestMu, dayPaidMu: 0, dayPaidPrevMu: 0, dayMarkH: st.height, opens: 0, closes: 0 };
  }
  const s = st.savings;
  const income = vaultTotals(st).interestMu;
  const delta = income - s.lastIncomeMu;
  s.lastIncomeMu = income; // מצב-ההכנסה מתעדכן-תמיד — גם-בלי-חוסכים (אין-רטרואקטיביות)
  if (delta > 0 && s.potMu > 0) {
    const cov = Math.max(0, avail(st, "treasury", "USDS")); // כיסוי-אמת-בלבד
    const pay = Math.min(delta, cov);
    if (pay > 0) {
      const who = Object.keys(s.positions);
      let left = pay;
      for (let i = 0; i < who.length; i++) {
        const p = s.positions[who[i]];
        if (i === who.length - 1) {
          // האחרון-בסדר-הקנוני בולע-את-האבק — שימור-מדויק-עד-ה-µ
          if (left > 0) { p.owedMu += left; left = 0; }
        } else if (p.mu > 0) {
          const share = Math.floor((pay * p.mu) / s.potMu);
          if (share > 0) { p.owedMu += share; left -= share; }
        }
      }
      addBal(st, "treasury", "USDS", -pay);
      addBal(st, "save-pot", "USDS", pay);
      s.paidMu += pay;
      s.dayPaidMu += pay;
    }
  }
  // חלון-היום הקנוני (28,800 בלוקים) — לפרסום-שיעור-אמת-מתגלגל
  while (st.height - s.dayMarkH >= 28_800) {
    s.dayMarkH += 28_800;
    s.dayPaidPrevMu = s.dayPaidMu;
    s.dayPaidMu = 0;
  }
  void nowMs; // הצבירה גובה-טהור — ריפליי-מדויק
}

/** סוכן-ההדגמה: המפעיל חוסך-בעצמו — עמדה-עומדת-וצוברת על-כסף-הפנים שלו.
 *  קדנצת-בדיקה כל-40-טיקים (אותו-דפוס-סוכנים). העמדה אינה-נסגרת-לעולם-על-השרשרת:
 *  זו-ההוכחה-החיה שהמכשיר משלם — המשיכה-המלאה מוכחת-בהוכחה-המקומית-המבודדת. */
const DEMO_AGENT = "operator";
const DEMO_AMOUNT_MU = 500_000; // 500 USDS — מכסף-המפעיל-עצמו, לא-מהאוצר
const DEMO_FLOOR_MU = 600_000; // רצפת-נזילות: אין-חיסכון-על-חשבון-התפעול

export function saveDemoTick(st: DexState, tickCount: number, exec: (op: Op) => OpResult, nowMs: number): void {
  if (tickCount % 40 !== 0) return;
  const s = st.savings;
  if (!s || s.positions[DEMO_AGENT]) return;
  if (avail(st, DEMO_AGENT, "USDS") < DEMO_FLOOR_MU) return;
  const r = exec({ type: "save_open", issuer: DEMO_AGENT, nonce: `save-${st.height}-o`, amount: DEMO_AMOUNT_MU });
  if (r.ok) {
    st.journal.push({ h: st.height, t: nowMs, soldier: DEMO_AGENT, action: "save_open", note: `operator saves ${DEMO_AMOUNT_MU}µ USDS — standing position, accrues the same measured rate as every depositor` });
  }
}
