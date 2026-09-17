/**
 * vault.ts — Task 80 · THE-VAULT: סוכן-ההדגמה הריבוני של כספת-ההלוואות.
 * ============================================================================
 * שלב 2 בשעון נתיב הכסף (money.html): המחלקה הגדולה שחסרה לרשת — מכשיר
 * שמייצר תשואה על הון. הסוכן הזה הוא עושה-שוק קיים (soldier-4) ששם את
 * ה-WSTEEM האמיתי שקיבל מדוזות המסילה (SETTLE-18) כבטחונות, שואב נגדו
 * USDS, מחזיק את העמדה, ופורע במלואה — הריבית היא הכנסת אוצר אמיתית.
 *
 * חוקי-הסוכן (כנות-מלאה, גובה-טהור — ריפליי מדויק):
 *   · אין זריעה: רק יתרת-WSTEEM-פנויה-אמיתית של החייל. אין-מקור-נסתר.
 *   · מחזור: פתיחה ← החזקה (~2,400 בלוקים ≈ 2 שעות) ← פירעון+שחרור מלא.
 *   · הגנה-עצמית: אם יחס-הבטחונות של העמדה נשחק מתחת-ל-175% (החלקת-אורקל
 *     ריאלית) — פירעון-מוקדם מיידי. הסוכן מגן-על-ההון-שלו, לא מחכה-למפולת.
 *   · קדנציה: בדיקה כל-40-טיקים (אותו-דפוס-קדנצה של שאר-הסוכנים).
 *   · הנונס גובה-טהור (vlt-<h>-o/-r) — ייחודי-לבלוק, עמיד-לריפליי.
 *
 * ריבית בגובה-האמת: 5%/שנה על חוב-µ — בסדרי-הגודל של הרשת (~$2 עמדה) זה
 * µ-בודדים ליום. המונה interestMu רוכב-על-השרשרת ומצטבר-לעולם; המספר הקטן
 * הוא האמת של סדר-הגודל הזה, לא מכוער-אלא-כנה.
 */
import type { DexState, Op, OpResult } from "./kernel";
import {
  VAULT_COLLATERAL, VAULT_MIN_CR_PCT,
  vaultColValueMu, vaultRateBps, vaultEffDebtMu,
} from "./kernel";

const DEMO_AGENT = "soldier-4";        // עושה-השוק עם עודף-הבטחונות הגדול (דוזות-מסילה)
const DEMO_EVERY = 40;                 // בדיקה כל-40-טיקים (קדנצת-סוכנים)
const DEMO_COLLATERAL_MU = 100_000;     // 100 STEEM ≈ $5.4 בעוגן-החי — עמדת-הדגמה-אמת
const DEMO_KEEP_MU = 200_000;          // שמור-לעבודת-שוק: אל-תסגור-על-כל-היתרה
const DEMO_CYCLE_BLOCKS = 28_800;       // יום-מדומה אחד (בפועל ~5 ימים בקצב-הפעימות): העמדה פתוחה, נראית וצוברת ריבית-אמת
const DEMO_SELF_HEAL_CR = 175;          // מתחת-לזה — פירעון-מוקדם (החלקת-אורקל נגדנו)

export function vaultTick(st: DexState, tick: number, exec: (op: Op) => OpResult, nowMs: number): void {
  if (tick % DEMO_EVERY !== 0) return;
  const v = st.vaults?.[DEMO_AGENT];

  if (!v) {
    // אין-עמדה: פתח-אחת מהיתרה-הפנויה-האמתית (אין-זריעה-מזויפת)
    const free = (st.balances[DEMO_AGENT]?.[VAULT_COLLATERAL] ?? 0) - (st.locked?.[DEMO_AGENT]?.[VAULT_COLLATERAL] ?? 0);
    const amt = Math.min(DEMO_COLLATERAL_MU, free - DEMO_KEEP_MU);
    if (amt < DEMO_COLLATERAL_MU) return; // אין-עודף-אמת — הסוכן שותק-בכנות
    const colVal = vaultColValueMu(st, amt);
    const draw = Math.floor((colVal * 100) / VAULT_MIN_CR_PCT);
    if (draw <= 0) return; // מחיר-הבטחון אפסי — אין-שאיבה-הגיונית
    exec({ type: "vault_open", issuer: DEMO_AGENT, nonce: `vlt-${st.height}-o`, asset: VAULT_COLLATERAL, amount: amt, drawMu: draw });
    return;
  }

  // יש-עמדה: הגנה-עצמית-קודם, אחר-כך-מחזור-הפירעון
  const rate = vaultRateBps(st);
  const eff = vaultEffDebtMu(v.debtMu + v.intMu, rate, v.atH, st.height);
  if (eff > 0) {
    const colVal = vaultColValueMu(st, v.colMu);
    const cr = Math.floor((colVal * 100) / eff);
    const agedEnough = st.height - v.atH >= DEMO_CYCLE_BLOCKS;
    if (cr < DEMO_SELF_HEAL_CR || agedEnough) {
      exec({ type: "vault_repay", issuer: DEMO_AGENT, nonce: `vlt-${st.height}-r`, repayMu: eff, withdrawMu: v.colMu });
    }
    return;
  }

  // חוב-אפס (שאריות-בטחונות): שחרור-מלא וסגירה
  if (v.colMu > 0) {
    exec({ type: "vault_repay", issuer: DEMO_AGENT, nonce: `vlt-${st.height}-r`, repayMu: 0, withdrawMu: v.colMu });
  }
}
