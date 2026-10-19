import { NextResponse } from "next/server";
import { submitOp, nextNonce } from "@/lib/dex/chain";
import { REPRIME_MU, REPRIME_SPLIT } from "@/lib/dex/kernel";
import { getLiveState } from "@/lib/dex/chain";
import { consoleGuard } from "@/lib/dex/guard";
import { operatorAuth } from "@/lib/operator-auth";

export const dynamic = "force-dynamic";

/**
 * EXEC-CD-10 · POST /api/dex/economy/reprime — הצתת-הדלק-מחדש (THE-REPRIME-2).
 *
 * אותו-חוק-בדיוק של-הפריימר (EXEC-CD-9), פעם-שנייה-מנומקת-במדידה: המלאי-ההיסטורי
 * נשרף-כולו דרך-מחזור-ה-bookgas-החוקי, המזרקה-החוקית מטביעה-אפס-כמעט (profit 27µ
 * + meter על-רצפת-ה-8000), וכל-op-גז נדחה — ECON-STASIS מלא (נמדד 2026-10-20:
 * ענן Σcredits=12,839µ · מקומי Σcredits=0). חד-פעמי-מוגבל-וגלוי: +2Mµ-קרדיטים
 * בספליט-קבוע לסולם-הממנים, feeMinted↑ (האינווריאנטה נשמרת), דגל-reprimeH-קנוני
 * → קריאה-שנייה נדחית "reprime-already-used" fail-closed. מוצהר-בביקורת
 * (reprimePortion ב-settle (d)). מנדט-בעלים: "לממן חיילים לסחר אוטומטי ומילוי
 * מתמשך" + "תמשיך ודחוף כן" (2026-10-20).
 */
export async function POST(req: Request) {
  const oa = operatorAuth(req);
  if (oa) return oa;
  const g = consoleGuard(req);
  if (g) return g;

  const st = getLiveState();
  if (st.reprimeUsed) {
    return NextResponse.json({ ok: false, error: "reprime-already-used", reprimeH: st.reprimeH ?? null }, { status: 200 });
  }
  const r = submitOp({ type: "reprime", issuer: "treasury", nonce: nextNonce("reprime") });
  return NextResponse.json({
    ok: r.queued, error: r.reason,
    amountMu: REPRIME_MU,
    split: REPRIME_SPLIT,
    note: r.queued ? "THE-REPRIME-2 — נכלל בבלוק הבא (≤3ש׳); מיד-אחריו סולם-הממנים חי מחדש" : undefined,
  });
}
