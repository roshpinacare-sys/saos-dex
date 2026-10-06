import { NextResponse } from "next/server";
import { submitOp, nextNonce } from "@/lib/dex/chain";
import { PRIMER_MU, PRIMER_SPLIT } from "@/lib/dex/kernel";
import { getLiveState } from "@/lib/dex/chain";
import { consoleGuard } from "@/lib/dex/guard";
import { operatorAuth } from "@/lib/operator-auth";

export const dynamic = "force-dynamic";

/**
 * EXEC-CD-9 · POST /api/dex/economy/primer — הצתת-סולם-הדלק (THE-PRIMER).
 *
 * חד-פעמי-מוגבל-וגלוי (ראה-הערת-ה-GAS_TABLE-בגרעין): +1Mµ-קרדיטים בספליט-קבוע
 * לסולם-הממנים, feeMinted↑ (האינווריאנטה-נשמרת), דגל-primerH-קנוני → קריאה-שנייה
 * נדחית "primer-already-used" fail-closed. אחרי-ההצתה הכלכלה מתדלבת-עצמית
 * דרך-מד-גז-הספר (economy.bookGasRecycle — כל-100-בלוקים).
 */
export async function POST(req: Request) {
  const oa = operatorAuth(req);
  if (oa) return oa;
  const g = consoleGuard(req);
  if (g) return g;

  const st = getLiveState();
  if (st.primerUsed) {
    return NextResponse.json({ ok: false, error: "primer-already-used", primerH: st.primerH ?? null }, { status: 200 });
  }
  const r = submitOp({ type: "primer", issuer: "treasury", nonce: nextNonce("primer") });
  return NextResponse.json({
    ok: r.queued, error: r.reason,
    amountMu: PRIMER_MU,
    split: PRIMER_SPLIT,
    note: r.queued ? "THE-PRIMER — נכלל בבלוק הבא (≤3ש׳); מיד-אחריו מתדלבת-עצמית מגז-הספר" : undefined,
  });
}
