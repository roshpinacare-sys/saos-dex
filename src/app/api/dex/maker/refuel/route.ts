import { NextResponse } from "next/server";
import { submitOp, nextNonce, getLiveState } from "@/lib/dex/chain";
import { funderFor, funderAfford, REFUEL_CAP } from "@/lib/dex/kernel";
import { consoleGuard } from "@/lib/dex/guard";
import { operatorAuth } from "@/lib/operator-auth";
import { isMakerIdentity } from "@/lib/dex/maker"; // EXEC-CD-9 · זהויות-מייקר-חוץ

export const dynamic = "force-dynamic";

/**
 * EXEC-CD-8 · POST /api/dex/maker/refuel — מסילת-דלק למייקר (Maker-API).
 *
 * כל-פקודה-על-הספר משלמת-גז-קרדיטים מדוד (order=60) — מייקר-גריד-חי שורף-דלק
 * בכל-רענון. החיילים-ממומנים-מהסולם (settle/mm tick); המפעיל-הריבוני — שדה-המסלול
 * הזה: אותו-מנגנון בדיוק (funderFor — סולם-הממנים arena→bots→treasury, exclude=המקבל),
 * אותן-תקרות (REFUEL_CAP), אותו-op גרעיני מיומן (refuel = העברה-טהורה-אפס-הטבעה).
 * אם-אף-ממנה-לא-יכול → funderFor מחזיר "operator" → הגרעין דוחה bad-refuel —
 * כישלון-כן-ולא-שקר (כלכלת-הדלק-יבשה = הדוח-אמת).
 */
export async function POST(req: Request) {
  const oa = operatorAuth(req);
  if (oa) return oa;
  const g = consoleGuard(req);
  if (g) return g;

  const body = (await req.json().catch(() => ({}))) as { amount?: number; to?: string };
  // EXEC-CD-9 · מימון-זהות-חוץ: to רשות (ברירת-מחדל: operator) — המפעיל מממן-חשבון-אזרח
  const target = body.to ? String(body.to).toLowerCase() : "operator";
  if (!isMakerIdentity(target)) {
    return NextResponse.json({ ok: false, error: "bad-identity (a-z0-9- 3..24; שמות-מערכת-אסורים)" }, { status: 200 });
  }
  const amt = Math.floor(Number(body.amount ?? 30_000));
  if (!(amt > 0) || amt > REFUEL_CAP) {
    return NextResponse.json({ ok: false, error: `amount-1..${REFUEL_CAP}` }, { status: 200 });
  }
  const st = getLiveState();
  const funder = funderFor(st, amt, target); // exclude=המקבל — לא-מימון-עצמי (precedent-settle)
  // FIX(EXEC-CD-9): funderFor מחזיר "operator" גם-כ-fallback-יבש וגם-כממנה-לגיטימי
  // (היעד-חוץ) — הבדיקה-הכנה היא מרווח-היכולת-בפועל (funderAfford), לא-השם.
  const funderCredits = st.credits[funder] ?? 0;
  if (funderAfford(st, funder) < amt) {
    return NextResponse.json({
      ok: false,
      error: "no-funder-can-afford (כלכלת-הדלק-יבשה — מחזור-גז-הספר מזין-את-המזרקה)",
      funder: funder === "operator" && funderAfford(st, funder) < amt ? null : funder,
      funderCredits,
    }, { status: 200 });
  }
  const r = submitOp({ type: "refuel", issuer: funder, nonce: nextNonce("mmr"), to: target, amount: amt });
  return NextResponse.json({
    ok: r.queued, error: r.reason,
    funder, amount: amt,
    note: r.queued ? "refuel — העברה-טהורה (אפס-הטבעה), נכלל בבלוק הבא (≤3ש׳)" : undefined,
  });
}
