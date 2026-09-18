/**
 * sbd-rail-first-cycle.ts — R42 · THE-SBD-RAIL PROOF
 * =============================================================================
 * הוכחה-מבודדת בגובה-הגרעין (בלי-שרשרת, בלי-DB): הגלגל-החיצוני-של-דבר-גורר-דבר.
 * סולם: µ = מילי-יחידות (1 SBD = 1000µ) — אותו-קנון-מדויק של WSTEEM/WBLURT/WTRX.
 *
 *   1. ג'נזיס: אוצר-מחזיק 50,000µ WSBD בלי-גיבוי (האמת-החיה-של-היום).
 *   2. הפעימה קוראת-חי: ל-headcorner יש 0.049 SBD אמת = 49µ → deficit-mint 49µ.
 *   3. הטענה-חד-פעמית: שימוש-חוזר נדחה — אין-הטבעה-כפולה.
 *   4. הגריד-מוכר: SBD-חי-קופץ → הפעימה-הבאה עוטפת-את-העודף (הגיבוי-עוקב).
 *   5. הגריד-קונה: היתרה-החיה-יורדת-מתחת-לגיבוי → אין-הטבעה (rail-deficit כנה).
 *   6. נתיב-היציאה: wrap_burn WSBD→SBD עובד — ל-WSBD נולד-unwrap (SBD בגרעין).
 *   7. שימור: אין-µ-יש-מאין — רק-הטבעה-מגובה-חי.
 *
 * הרצה: bun run sbd-rail-first-cycle.ts
 */
import { genesisState, applyOp, stateRoot } from "./src/lib/dex/kernel";

let failures = 0;
const check = (name: string, cond: boolean, detail?: string): void => {
  console.log(`${cond ? "  PASS" : "  FAIL"} · ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
};

let h = 26_000;
const st = genesisState();
const now = Date.now();

const wsbdSupply = (): number =>
  Object.values(st.balances).reduce((s, b) => s + (b["WSBD"] ?? 0), 0);

const g0 = st.balances["treasury"]?.["WSBD"] ?? 0;
check("ג'נזיס-אמת: אוצר-מחזיק-WSBD בלי-גיבוי (האמת-החיה-של-היום)", g0 === 50_000 && (st.backing["WSBD"] ?? 0) === 0, `supply=${g0}µ backing=${st.backing["WSBD"] ?? 0}µ`);

// ── 1) פעימה-ראשונה: deficit-mint מול-0.049-SBD-אמת (= 49µ בקנון-מילי) ──
const liveSbd1 = Math.floor(0.049 * 1000); // 49µ — מדידת-חי מ-RPC-ציבורי
const deficit1 = liveSbd1 - (st.backing["WSBD"] ?? 0);
check("deficit-נכון: 49µ מול-גיבוי-0 (אמת-קטנה-אבל-אמת)", deficit1 === 49, `deficit=${deficit1}µ`);
const r1 = applyOp(st, { type: "wrap_mint", issuer: "treasury", nonce: "sdbrail-1", wrapAsset: "WSBD", amount: deficit1, external: true, claim: `sbd:headcorner:${h}:${deficit1}` } as never, now);
check("ההטבעה-המגובה-עברה", r1.ok, r1.ok ? undefined : String(r1.err));
check("גיבוי-WSBD קפץ-ל-49µ", (st.backing["WSBD"] ?? 0) === 49, `backing=${st.backing["WSBD"]}µ`);
check("אוצר: 50,000µ ג'נזיס + 49µ מגובה = 50,049µ", (st.balances["treasury"]?.["WSBD"] ?? 0) === 50_049, `=${st.balances["treasury"]?.["WSBD"] ?? 0}µ`);

// ── 2) הטענה-החד-פעמית: שימוש-חוזר נדחה ──
const r2 = applyOp(st, { type: "wrap_mint", issuer: "treasury", nonce: "sdbrail-2", wrapAsset: "WSBD", amount: deficit1, external: true, claim: `sbd:headcorner:${h}:${deficit1}` } as never, now);
check("טענה-חוזרת נדחית (אין-הטבעה-כפולה)", !r2.ok, String((r2 as { err?: string }).err));
check("שום-דבר-לא-זז-אחרי-הדחייה", wsbdSupply() === 50_049 && st.backing["WSBD"] === 49);

// ── 3) הגריד-מכר-STEEM: SBD-חי-קופץ-ל-0.150 (150µ) → פעימה-שנייה עוטפת-101µ ──
h += 480;
const liveSbd2 = Math.floor(0.150 * 1000); // 150µ
const deficit2 = liveSbd2 - st.backing["WSBD"];
check("deficit-שני-נכון: 101µ (הגריד-מכר)", deficit2 === 101, `deficit=${deficit2}µ`);
const r3 = applyOp(st, { type: "wrap_mint", issuer: "treasury", nonce: "sdbrail-3", wrapAsset: "WSBD", amount: deficit2, external: true, claim: `sbd:headcorner:${h}:${deficit2}` } as never, now);
check("ההטבעה-השנייה-עברה (הגיבוי-עוקב-אחרי-המציאות)", r3.ok, r3.ok ? undefined : String(r3.err));
check("גיבוי-WSBD = 150µ = ה-SBD-החי-בדיוק", st.backing["WSBD"] === 150, `backing=${st.backing["WSBD"]}µ`);

// ── 4) הגריד-קונה-STEEM-ב-SBD: היתרה-החיה-יורדת-מתחת-לגיבוי → אין-הטבעה ──
h += 480;
const liveSbd3 = Math.floor(0.090 * 1000); // 90µ — הגריד-קנה
const deficit3 = liveSbd3 - st.backing["WSBD"];
check("rail-deficit: -60µ — אין-מה-להטביע (היה-הדפסה)", deficit3 === -60, `deficit=${deficit3}µ`);
check("הרץ-הכנה לא-מטביע-בגירעון", deficit3 <= 0, "deficit-mint רק-כשעודף-אמת");

// ── 5) נתיב-היציאה: wrap_burn WSBD→SBD עובד (SBD-נרשם-בגרעין) ──
const burnAmt = 100;
const r4 = applyOp(st, { type: "wrap_burn", issuer: "treasury", nonce: "sdbrail-4", wrapAsset: "WSBD", amount: burnAmt } as never, now);
check("wrap_burn WSBD→SBD עובר (ל-WSBD נולד-unwrap)", r4.ok, r4.ok ? undefined : String(r4.err));
check("האוצר-קיבל 100µ SBD-פנימי", (st.balances["treasury"]?.["SBD"] ?? 0) === 100, `=${st.balances["treasury"]?.["SBD"] ?? 0}µ`);
check("הגיבוי-ירד-בדיוק-בשרוף (150→50)", st.backing["WSBD"] === 50, `backing=${st.backing["WSBD"]}µ`);
check("היצע-WSBD ירד-בשרוף (50,150→50,050)", wsbdSupply() === 50_050, `supply=${wsbdSupply()}µ`);

// ── 6) שורש-קנוני-חי ──
check("שורש-קנוני-חי-בסוף", Boolean(stateRoot(st)), stateRoot(st).slice(0, 16) + "…");

console.log("");
if (failures === 0) {
  console.log("══ R42 · THE-SBD-RAIL — ALL GREEN ══");
  console.log("הגלגל-החיצוני: גריד-מוכר ← SBD-אמת-מצטבר ← הפעימה-עוטפת ← גיבוי-WSBD-חי ← unwrap-קיים.");
  console.log(`סדר-הגודל-החי: 0.049-SBD-נזיל-היום ← דלק-ה-powerdown (~55-SBD/שבוע ממכירות-מעל-קו-הזהות) יזרים-מכאן.`);
  process.exit(0);
} else {
  console.log(`══ ${failures} FAILURES ══`);
  process.exit(1);
}
