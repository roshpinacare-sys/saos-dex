/**
 * EXEC-CD-8 · בדיקות-קלון-דטרמיניסטיות ל-Maker-API ברמת-הגרעין.
 * רץ על עותק (structuredClone) של מצב-חי — אפס-נגיעה בשרשרת-החיה.
 * מוכיח: batch-אטומי (הצבה) · postOnly-חוצה-דוחה-את-כולה · cancel_all-סוויפ
 * עם-שחרור-אסקרו-מדויק · אינוואריאנטות-נעילה.
 */
import { applyOp } from "../src/lib/dex/kernel";
import { getLiveState } from "../src/lib/dex/chain";
import type { DexState, Op } from "../src/lib/dex/kernel";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function credits(st: DexState, who: string): number { return st.credits[who] ?? 0; }
function liveOrders(st: DexState, owner: string): number {
  return st.orders.filter((o) => o.live && o.owner === owner).length;
}
function lockedOf(st: DexState, who: string, a: string): number { return st.locked[who]?.[a] ?? 0; }

const live = getLiveState();
const nowMs = 1_700_000_000_000;
const NONCE = () => `ktest-${Math.floor(nowMs)}-${Math.floor(Math.random() * 1e9)}`;

/* ── עותק-בדיקה עם-דלק-מספיק (יחידת-בדיקה — לא-השרשרת-החיה) ─────────────── */
function freshClone(): DexState {
  const st = structuredClone(live) as DexState;
  st.credits["operator"] = 10_000;
  st.credits["arena"] = 10_000;
  return st;
}

console.log("\n══ T1 · batch-אטומי: 2 ציטוטי-postOnly נוחים ══");
{
  const st = freshClone();
  const before = liveOrders(st, "operator");
  const op: Op = {
    type: "batch", issuer: "operator", nonce: NONCE(),
    ops: [
      { type: "order", issuer: "operator", nonce: NONCE(), base: "SAOS", quote: "USDS", side: "buy", price: 1300, amount: 2000, postOnly: true },
      { type: "order", issuer: "operator", nonce: NONCE(), base: "SAOS", quote: "USDS", side: "sell", price: 1340, amount: 2000, postOnly: true },
    ] as never,
  };
  const r = applyOp(st, op, nowMs);
  check("batch מתקבל", r.ok, JSON.stringify(r).slice(0, 120));
  check("שתי-הפקודות חיות בספר", liveOrders(st, "operator") === before + 2, `live=${liveOrders(st, "operator")} before=${before}`);
  const gasBurn = 10_000 - credits(st, "operator");
  // TOLL-RECALIBRATION (640cf4fc · 2026-10-17, הנחיית-בעלים): order=1µ (היה 60µ) —
  // המעטפת batch נשארת אפס-גז; תתי-ה-ops משלמים את התעריף-הקנוני. 2×order = 2µ.
  check("גז = 2×order (2) — המעטפת אפס", gasBurn === 2, `burned=${gasBurn}`);
}

console.log("\n══ T2 · postOnly-חוצה בתוך-batch → דחייה-אטומית-מלאה ══");
{
  const st = freshClone();
  // זריעה-דטרמיניסטית: arena מציב-מייקר-נגד (ask @ 1340) — הספר-החי-עשוי-להיות-חד-צדדי
  const seed = applyOp(st, { type: "order", issuer: "arena", nonce: NONCE(), base: "SAOS", quote: "USDS", side: "sell", price: 1340, amount: 5000, postOnly: true } as Op, nowMs);
  check("זריעה: ask-arena נח", seed.ok, JSON.stringify(seed).slice(0, 100));
  const before = liveOrders(st, "operator");
  const crBefore = credits(st, "operator");
  const op: Op = {
    type: "batch", issuer: "operator", nonce: NONCE(),
    ops: [
      { type: "order", issuer: "operator", nonce: NONCE(), base: "SAOS", quote: "USDS", side: "buy", price: 1300, amount: 2000, postOnly: true },
      { type: "order", issuer: "operator", nonce: NONCE(), base: "SAOS", quote: "USDS", side: "buy", price: 1345, amount: 2000, postOnly: true }, // חוצה את 1340
    ] as never,
  };
  const r = applyOp(st, op, nowMs);
  check("ה-batch נדחה כולו", !r.ok, JSON.stringify(r).slice(0, 140));
  check("אפס-פקודות-נחו (אטומיות)", liveOrders(st, "operator") === before, `live=${liveOrders(st, "operator")} before=${before}`);
  check("אפס-שריפת-גז (הדחייה על העותק)", credits(st, "operator") === crBefore, `credits=${credits(st, "operator")}`);
  check("מייקר-הנגד-נשאר-שלם", liveOrders(st, "arena") === 1, `arena-live=${liveOrders(st, "arena")}`);
}

console.log("\n══ T3 · cancel_all סוויפ-מלא + שחרור-אסקרו-מדויק ══");
{
  const st = freshClone();
  // הצבה: קנייה (נועל ציטוט) + מכירה (נועל בסיס)
  applyOp(st, {
    type: "batch", issuer: "operator", nonce: NONCE(),
    ops: [
      { type: "order", issuer: "operator", nonce: NONCE(), base: "SAOS", quote: "USDS", side: "buy", price: 1300, amount: 2000, postOnly: true },
      { type: "order", issuer: "operator", nonce: NONCE(), base: "SAOS", quote: "USDS", side: "sell", price: 1340, amount: 2000, postOnly: true },
    ] as never,
  } as Op, nowMs);
  const lockUsdsBefore = lockedOf(st, "operator", "USDS");
  const lockSaosBefore = lockedOf(st, "operator", "SAOS");
  check("נעילת-קנייה קיימת (notional/1000)", lockUsdsBefore === Math.floor((1300 * 2000) / 1000), `locked=${lockUsdsBefore}`);
  check("נעילת-מכירה קיימת (בסיס-µ)", lockSaosBefore === 2000, `locked=${lockSaosBefore}`);

  const before = liveOrders(st, "operator");
  const r = applyOp(st, { type: "cancel_all", issuer: "operator", nonce: NONCE() } as Op, nowMs);
  check("cancel_all מתקבל", r.ok, JSON.stringify(r).slice(0, 120));
  check("כל-הפקודות-של-המנפיק מתו", liveOrders(st, "operator") === 0, `live=${liveOrders(st, "operator")} (before=${before})`);
  check("נעילת-USDS שוחררה-במלואה", lockedOf(st, "operator", "USDS") === 0, `locked=${lockedOf(st, "operator", "USDS")}`);
  check("נעילת-SAOS שוחררה-במלואה", lockedOf(st, "operator", "SAOS") === 0, `locked=${lockedOf(st, "operator", "SAOS")}`);
  const jc = st.journal.filter((j) => j.action === "cancel_all");
  check("יומן-סוויפ עם-ספירה", jc.length === 1 && jc[0].note?.startsWith("2 canceled"), jc[0]?.note);
}

console.log("\n══ T4 · cancel_all-מסונן-זוג + אידמפוטנטיות ══");
{
  const st = freshClone();
  applyOp(st, {
    type: "batch", issuer: "operator", nonce: NONCE(),
    ops: [
      { type: "order", issuer: "operator", nonce: NONCE(), base: "SAOS", quote: "USDS", side: "buy", price: 1300, amount: 2000, postOnly: true },
      { type: "order", issuer: "operator", nonce: NONCE(), base: "WSTEEM", quote: "USDS", side: "buy", price: 60, amount: 5000, postOnly: true },
    ] as never,
  } as Op, nowMs);
  const r1 = applyOp(st, { type: "cancel_all", issuer: "operator", nonce: NONCE(), base: "SAOS", quote: "USDS" } as Op, nowMs);
  check("סוויפ-מסונן מתקבל", r1.ok);
  check("רק-הזוג-המבוקש מת", liveOrders(st, "operator") === 1, `live=${liveOrders(st, "operator")}`);
  const r2 = applyOp(st, { type: "cancel_all", issuer: "operator", nonce: NONCE(), base: "SAOS", quote: "USDS" } as Op, nowMs);
  check("אידמפוטנטי (אין-פקודות = ok)", r2.ok);
  const r3 = applyOp(st, { type: "cancel_all", issuer: "arena", nonce: NONCE() } as Op, nowMs);
  check("מנפיק-אחר לא נוגע בזרים (אין-פקודות-ארנה = ok)", r3.ok);
}

console.log("\n══ T5 · ריפליי: אותו-nonce נדחה ══");
{
  const st = freshClone();
  const nonce = NONCE();
  const r1 = applyOp(st, { type: "cancel_all", issuer: "operator", nonce } as Op, nowMs);
  const r2 = applyOp(st, { type: "cancel_all", issuer: "operator", nonce } as Op, nowMs);
  check("ראשון ok", r1.ok);
  check("חוזר = replay-rejected", !r2.ok && String((r2 as { err?: string }).err).includes("replay"), JSON.stringify(r2).slice(0, 80));
}

console.log(`\n═══ תוצאה: ${pass} עברו · ${fail} נכשלו ═══`);
process.exit(fail > 0 ? 1 : 0);
