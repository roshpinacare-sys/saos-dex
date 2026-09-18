/**
 * ve.ts — R41 · THE-VE: הריבונות-הנעולה · נעילה ← הצבעה ← אפוק-פליפ.
 * ============================================================================
 * מה שהיה חסר לשאלת "דבר-גורר-דבר": הפרימיטיבים חיים בגרעין (ve_lock / ve_vote /
 * bond_buy — Task 54) — אבל הם לא-מחוברים-לזרימה. הקרן (ve-pot) נטענה-בפועל
 * מהראוטר (מדידה-חיה: 21,096µ USDS ב-10 מחזורים) — ואף-אחד לא-נעל ולא-הצביע:
 * ההכנסה ישבה-מוקפת-חומה בלי-תובעים. הסוכנים-האלה סוגרים-את-המעגל.
 *
 * חוקי-הסוכנים (כנות-מלאה, גובה-טהור — ריפליי מדויק):
 *   · אין זריעה: הנעילה היא מה-SAOS-האמיתי-הפנוי של הסוכן בלבד (עמדת-עומדת).
 *   · מחזור: נעילה-חד-פעמית ← הצבעה-לבריכה-העמוקה (SAOS/USDS — שם-העמלות זורמות).
 *     העמדה לא-נפתחת-לעולם-על-השרשרת — זו-ההוכחה-החיה שהצינור משלם.
 *   · אג"ח: הסוחר ממיר USDS מכיסו-שלו ← SAOS-אוצר בהנחת-3% ← נעילת-ve-12שב'
 *     (נזילות-אוצר שאי-אפשר-למשוך — Olympus-POL בלי-מלכודת-ההדפסה).
 *   · קדנציה: בדיקה כל-40-טיקים (אותו-דפוס-קדנצה של כל-הסוכנים).
 *   · אותם-חוקים לכל-נועל: האפוק-פליפ מחלק לפי-כוח-ve פרו-פורציונלי — הסוכן
 *     הזה סופג-בכנות את-הצבירה-ההיסטורית של הקרן (מי-שנועל-ראשון בכל-רשת-ve
 *     כזו — מקבל-את-הקרן-העומדת; הכל ביומן-הציבורי).
 */
import type { DexState, Op, OpResult } from "./kernel";
import { avail } from "./kernel";

// ── ve_lock + ve_vote: עמדת-העומדת של הסוחר ──────────────────────────
const VE_AGENT = "operator";         // המפעיל — SAOS-פנוי-אמיתי (מדידה-חיה: ל-soldier-1 75% מה-SAOS תפוס-בפקודות — הסוכן שתק-בכנות; המפעיל מדגים את-הנעילה-הישירה, כפי-שהוא-מדגים את-החיסכון)
const VE_LOCK_MU = 200_000;         // 200 SAOS מכיסו-שלו — 10% מה-SAOS שלו (כמו-החיסכון: ~11% מה-USDS)
const VE_WEEKS = 12;                // נעילה-בינונית — מיושרת-עם-נעילת-האג"ח
const VOTE_PAIR = "SAOS/USDS";      // הבריכה-העמוקה — שם-העמלות-הנמדדות זורמות

// ── bond_buy: אג"ח-ריבונית אחת-חד-פעמית — ההוכחה, לא-המשאבה ──────────
const BOND_AGENT = "soldier-1";     // הסוחר: הדלת-השנייה-ל-ve — אג"ח ← נעילה ← הצבעה (שתי-הדלתות מוכחות)
const BOND_MU = 100_000;            // 100 USDS מכיסו (מעל-המינימום 50, מתחת-לכל-תקרת-טעם)
const BOND_FLOOR_MU = 2_000_000;    // רצפת-נזילות: אין-אג"ח על-חשבון-הסחר-החי

export function veDemoTick(st: DexState, tickCount: number, exec: (op: Op) => OpResult, nowMs: number): void {
  if (tickCount % 40 !== 0) return;

  // 1) נעילה-חד-פעמית מהמאזן-האמיתי — אין-מקור-נסתר
  if (!st.ve?.[VE_AGENT]) {
    if (avail(st, VE_AGENT, "SAOS") < VE_LOCK_MU) return; // אין-SAOS-פנוי — הסוכן שותק-בכנות
    const r = exec({ type: "ve_lock", issuer: VE_AGENT, nonce: `ve-${st.height}-l`, asset: "SAOS", amount: VE_LOCK_MU, weeks: VE_WEEKS });
    if (r.ok) {
      st.journal.push({ h: st.height, t: nowMs, soldier: VE_AGENT, action: "ve_lock", note: `operator locks ${VE_LOCK_MU}µ SAOS × ${VE_WEEKS}w → ve — standing position, same rules as every locker` });
    }
  }

  // 2) הצבעה לבריכה-העמוקה (חידוש-אידמפוטנטי — רק-אם-חסרה)
  if (st.ve?.[VE_AGENT] && st.veVotes?.[VE_AGENT] !== VOTE_PAIR) {
    const r = exec({ type: "ve_vote", issuer: VE_AGENT, nonce: `ve-${st.height}-v`, pair: VOTE_PAIR });
    if (r.ok) {
      st.journal.push({ h: st.height, t: nowMs, soldier: VE_AGENT, action: "ve_vote", note: `vote → ${VOTE_PAIR} — fees flow to the voted pool's lockers` });
    }
  }
}

export function bondDemoTick(st: DexState, tickCount: number, exec: (op: Op) => OpResult, nowMs: number): void {
  if (tickCount % 40 !== 0) return;
  if (st.bondUserH?.[BOND_AGENT]) return; // אג"ח-עומדת-אחת — ההוכחה-שקיימת, לא-מכונת-רכישה
  if (avail(st, BOND_AGENT, "USDS") < BOND_MU + BOND_FLOOR_MU) return; // רצפת-נזילות-הסחר
  const r = exec({ type: "bond_buy", issuer: BOND_AGENT, nonce: `bnd-${st.height}`, amount: BOND_MU });
  if (r.ok) {
    st.journal.push({ h: st.height, t: nowMs, soldier: BOND_AGENT, action: "bond_buy", note: `trader buys sovereign bond: ${BOND_MU}µ USDS → discounted SAOS, ve-locked 12w — treasury liquidity that cannot be pulled` });
  }
}
