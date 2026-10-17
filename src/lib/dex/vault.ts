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

const DEMO_AGENT = "arena";           // OWNER-MANDATE 2026-10-17: היה soldier-4 (סולק) — הארנה: עודף-הבטחונות-האמתי (WSTEEM-עומק)
const DEMO_EVERY = 40;                 // בדיקה כל-40-טיקים (קדנצת-סוכנים)
/* FIX(R47 · scale-truth): התקרה-הישנה (100,000µ) שאבה-2,160µ בלבד — ריבית-יום
 * שלמה עליה (floor(2160×500×5760/10⁴×2.1M))=0 — עיגול-השלמים מאפס-את-הזרימה
 * לנצח-בסדר-גודל-זה. התקרה הוגדלה-ל-250,000µ והשברית-ל-65% (עדיין-שמורת-
 * נזילות-אמתית-לעבודת-השוק): שאיבה ≈5,500µ ← floor(ריבית-מחזור)≥1µ — הזרימה
 * מתממשת-בפועל. העמדה-העומדת-הנוכחית (2,160µ מ-h16672) תפרע-מיד-בפעימה-
 * הבאה עם-ריבית-אמת שנצברה-מגובה-טהור. */
const DEMO_COLLATERAL_MU = 250_000;     // תקרת-עמדה: 250 STEEM ≈ $14 בעוגן-החי
const DEMO_MIN_COLLATERAL_MU = 50_000; // מתחת-לזה אין-טעם-הדגמה — הסוכן שותק-בכנות
const DEMO_FREE_FRACTION = 0.65;       // עד-לכל-היותר 65% מהיתרה-הפנויה (שמורת-נזילות-לעבודת-השוק)
const DEMO_CYCLE_BLOCKS = 12_000;       // FIX(R47 · time-truth): ~2 ימים-אמת (היה 28,800 = 5 ימים) — ריבית-מחזור floor≥1µ מתממשת
const DEMO_SELF_HEAL_CR = 175;          // מתחת-לזה — פירעון-מוקדם (החלקת-אורקל נגדנו)

export function vaultTick(st: DexState, tick: number, exec: (op: Op) => OpResult, nowMs: number): void {
  if (tick % DEMO_EVERY !== 0) return;
  const v = st.vaults?.[DEMO_AGENT];

  if (!v) {
    // אין-עמדה: פתח-אחת מהיתרה-הפנויה-האמתית (אין-זריעה-מזויפת) — עד-40%-ממנה,
    // כי-השוק-מנוע חי-ומוכר: הבטחונות בני-הנזילות הם אלה-שאין-בהם-צורך-עבודה-מיידי.
    const free = (st.balances[DEMO_AGENT]?.[VAULT_COLLATERAL] ?? 0) - (st.locked?.[DEMO_AGENT]?.[VAULT_COLLATERAL] ?? 0);
    const amt = Math.min(DEMO_COLLATERAL_MU, Math.floor(free * DEMO_FREE_FRACTION));
    if (amt < DEMO_MIN_COLLATERAL_MU) return; // אין-עודף-אמת — הסוכן שותק-בכנות
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
