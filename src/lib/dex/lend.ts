/**
 * lend.ts — R44 · THE-MARKET: שוק-הכספים הריבוני (peer-to-pool, Aave-v3-style).
 * ============================================================================
 * המכשיר שהיה חסר לרשת מול-ענקיות-ה-DeFi: שוק-כספים על-השרשרת-הקנונית —
 * אספקה/שאיבה בעקומת-kink (בסיס-1% + שיפוע-4% עד-80% ניצולת, +60% מעליה),
 * פקטור-רזרבה 10% → אוצר, בטחונות ב-LTV-שמרני, ניזולת בחסר-HF עם בונוס-5%.
 * המתמטיקה וה-ops חיים-בקרנל (kernel.ts — אותו-מקום-של-הכספת); כאן חיים
 * הסוכנים — פעילות-ריבונית-אוטונומית-אמיתית שמזיזה-את-השוק.
 *
 * ההבדל מהכספת (Task 80): הכספת היא CDP (Maker — שאיבה מגובה-בטחונות,
 * הריבית → אוצר). כאן זה שוק-עמיתים (Aave — המלווים מפקידים לבריכה, הלווים
 * שואלים ממנה, ו-90% מהריבית זורמת-למלווים). שניהם חיים-זה-לצד-זה.
 *
 * הסוכנים ("דבר-גורר-דבר" — הכסף-האמיתי של הרשת עובד):
 *   · האוצר מנהל-את-הנזילות-העודפת שלו בעצמו: אספקה-אדפטיבית לפי-ביקוש-האשראי
 *     (3× החוב החי, בין-20k-ל-500kµ) — ההון-הרדום מרוויח, והשוק מעמיק-כשגדל.
 *   · חיילי-הצי (soldier-1, soldier-3) מנהלים-מחזור-אשראי: בטחונות-WSTEEM ←
 *     שאילת-USDS ב-LTV-30% ← החזקה ~יום ← פירעון-מלא-בריבית ← שחרור. הניצולת
 *     חיה, הריבית זורמת-לאוצר-ולמלווים, והעקומה זזה-באמת.
 *
 * חוקי-כנות (אותם-חוקים-כמו-כל-סוכן-ברשת): אין-זריעה-מזויפת — רק-יתרה-
 * פנויה-אמיתית; אין-עמדה-מתחת-למינימום — הסוכן שותק-בכנות; הגנה-עצמית —
 * פירעון-מוקדם מתחת-ל-HF 1.5. הכל בגובה-טהור — ריפליי-מדויק.
 */
import type { DexState, Op, OpResult } from "./kernel";
import {
  addBal, avail, lendState, lendAssetValueMu, lendHealthFactor,
  lendBorrowAprBps, lendDebtNow,
} from "./kernel";

/* ── הסוכן: האוצר — מנהל-הנזילות של הרשת ────────────────────────────────── */
const TREASURY_EVERY = 40;          // קדנצת-סוכנים (אותה-פעימה-כמו-שאר-הצי)
const TREASURY_FLOOR_MU = 300_000; // רצפת-נזילות-תפעולית שהאוצר שומר-לעצמו ($300)
const TREASURY_MIN_MU = 20_000;    // אספקה-מינימלית — שוק-חי גם-בלי-לווים
const TREASURY_MAX_MU = 500_000;   // תקרת-חשיפה-עצמית
const TREASURY_DEMAND_MULT = 3;    // יעד = 3× החוב-החי (ניצולת-נוחה-ללווים)

/** לווי-הצי — מחזור-אשראי-אמיתי: בטחונות ← שאילה ← החזקה ← פירעון-בריבית ← שחרור. */
const BORROWER_AGENTS = ["soldier-1", "soldier-3"] as const;
const BORROWER_FREE_FRACTION = 40;  // עד-40% מהיתרה-הפנויה → בטחונות (שמורה-קשיחה לעבודת-השוק)
const BORROWER_LTV_BPS = 3000;      // 30% — שמרני-במכוון (HF בפתיחה ≈ 3.3)
const BORROWER_MIN_COL_MU = 20_000;
const BORROWER_MIN_DRAW_MU = 500;
const BORROWER_CYCLE_BLOCKS = 28_800; // ~יום-שרשרת-אחד בהחזקה
const BORROWER_SELF_HEAL_HF = 150;    // מתחת-ל-1.5 — פירעון-מוקדם (הגנה-עצמית)
const BORROWER_COL_CAP_MU = 120_000;  // תקרת-בטחונות-פר-מחזור

export function lendTick(st: DexState, tickCount: number, exec: (op: Op) => OpResult, nowMs: number): void {
  if (tickCount % TREASURY_EVERY !== 0) return;
  treasuryLendTick(st, exec, nowMs);
  for (const b of BORROWER_AGENTS) borrowerTick(st, b, exec, nowMs);
}

function treasuryLendTick(st: DexState, exec: (op: Op) => OpResult, nowMs: number): void {
  const ls = lendState(st);
  // ביקוש-האשראי-החי: Σ(חוב-קרן) מתומחר-ב-µUSDS — מה-שקובע-את-גודל-הבריכה
  let borrowsUsd = 0;
  for (const [a, m] of Object.entries(ls.markets)) borrowsUsd += lendAssetValueMu(st, a, m.bMu);
  const target = Math.min(TREASURY_MAX_MU, Math.max(TREASURY_MIN_MU, borrowsUsd * TREASURY_DEMAND_MULT));
  const cur = ls.positions["treasury"]?.s?.USDS?.mu ?? 0;
  if (target > cur + 1_000) {
    const room = avail(st, "treasury", "USDS") - TREASURY_FLOOR_MU;
    const amt = Math.min(target - cur, room);
    if (amt >= 1_000) {
      const r = exec({ type: "lend_supply", issuer: "treasury", nonce: `lnd-t-${st.height}`, asset: "USDS", amount: amt });
      if (r.ok) st.journal.push({ h: st.height, t: nowMs, soldier: "treasury", action: "lend_supply", note: `treasury supplies ${amt}µ USDS (adaptive target ${target}µ = 3× live borrows ${borrowsUsd}µ) — idle capital earns` });
    }
  } else if (target + 1_000 < cur) {
    const r = exec({ type: "lend_withdraw", issuer: "treasury", nonce: `lnd-t-${st.height}`, asset: "USDS", amount: cur - target });
    if (r.ok) st.journal.push({ h: st.height, t: nowMs, soldier: "treasury", action: "lend_withdraw", note: `treasury right-sizes ${cur - target}µ (demand fell) — sovereign liquidity management` });
  }
}

function borrowerTick(st: DexState, who: string, exec: (op: Op) => OpResult, nowMs: number): void {
  const ls = lendState(st);
  const pos = ls.positions[who];
  const borrow = pos?.b?.USDS;
  const hf = lendHealthFactor(st, who);

  if (!borrow || borrow.mu + borrow.int <= 0) {
    // אין-חוב — פתיחת-מחזור: בטחונות מהיתרה-הפנויה-האמיתית (אפס-זריעה)
    const free = (st.balances[who]?.WSTEEM ?? 0) - (st.locked?.[who]?.WSTEEM ?? 0);
    const col = Math.min(Math.floor((free * BORROWER_FREE_FRACTION) / 100), BORROWER_COL_CAP_MU);
    if (col < BORROWER_MIN_COL_MU) return; // אין-עודף-אמת — הסוכן שותק-בכנות
    const colVal = lendAssetValueMu(st, "WSTEEM", col);
    const draw = Math.floor((colVal * BORROWER_LTV_BPS) / 10_000);
    if (draw < BORROWER_MIN_DRAW_MU) return;
    let r = exec({ type: "lend_supply", issuer: who, nonce: `lnd-${who}-${st.height}-c`, asset: "WSTEEM", amount: col });
    if (!r.ok) return;
    r = exec({ type: "lend_borrow", issuer: who, nonce: `lnd-${who}-${st.height}-b`, asset: "USDS", amount: draw });
    if (r.ok) st.journal.push({ h: st.height, t: nowMs, soldier: who, action: "lend_borrow", note: `${who} borrows ${draw}µ USDS against ${col}µ WSTEEM (LTV 30% · HF ${lendHealthFactor(st, who)}) — credit cycle open` });
    return;
  }

  // יש-חוב: הגנה-עצמית-קודם, אחר-כך-מחזור-הפירעון
  const m = ls.markets["USDS"];
  const debt = lendDebtNow(borrow, lendBorrowAprBps(m), st.height);
  const agedEnough = st.height - borrow.atH >= BORROWER_CYCLE_BLOCKS;
  if (hf < BORROWER_SELF_HEAL_HF || agedEnough) {
    const r = exec({ type: "lend_repay", issuer: who, nonce: `lnd-${who}-${st.height}-r`, asset: "USDS", amount: -1 });
    if (r.ok) {
      st.journal.push({ h: st.height, t: nowMs, soldier: who, action: "lend_repay", note: `${who} repays cycle in full (debt was ${debt}µ · HF ${hf}${hf < BORROWER_SELF_HEAL_HF ? " SELF-HEAL" : " matured"}) — interest → treasury + suppliers` });
      const w = exec({ type: "lend_withdraw", issuer: who, nonce: `lnd-${who}-${st.height}-w`, asset: "WSTEEM", amount: -1 });
      if (w.ok) st.journal.push({ h: st.height, t: nowMs, soldier: who, action: "lend_withdraw", note: `${who} releases collateral — cycle closed, next cycle opens on cadence` });
    }
  }
}
