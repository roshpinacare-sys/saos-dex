import { NextResponse } from "next/server";
import { getBridgeView, claimInbound, lockOutbound, markReleased, registerInbound, startBridgeAutoKeeper, bridgeAutoStatus } from "@/lib/dex/bridge";
import { consoleGuard } from "@/lib/dex/guard";
import { operatorAuth } from "@/lib/operator-auth";

export const dynamic = "force-dynamic";

/* ══ SOVEREIGN-BRIDGE (SETTLE-12) — הגשר-הדו-כיווני ═════════════════════════
 * GET — מצב-הגשר: יתרות-escrow-חיות, כוונות-פנימיות, תקרות, החוזה-שלנו-שם.
 * POST — פעולות (שער-מפעיל + קונסולה, fail-closed):
 *   · register-in  {chain, proofRef, asset, amountMu, beneficiary, farAddress!,
 *     farAmount?, farMemo?, farSource?} — רישום-הפקדה-על-הרשת-החוץ עם **קישור**
 *     (FIX-Roast-64-c: התביעה מאומתת מול-הקישור — בלי-נמען-רשום אין-רישום).
 *   · claim        {id} — תשלום-מה-escrow-הריבוני ב-xfer_free (אפס-גז) — רק-אחרי-
 *     אימות-מחויב (נמען+סכום+עומק) מול-השרשרת-החוץ.
 *   · lock-out     {issuer, asset, amountMu, chain, farAddress!, farAmount?} — נעילת-נכס
 *     ב-escrow להוצאה לרשת-חוץ.
 *   · release      {id, farTxid} — המפעיל מעיד שהחוזה-שלנו-שם שחרר (תיקוף-פר-רשת
 *     + קישור-נמען) — אחרת-נשאר-locked.
 * FIX(Roast-66 · ZFB-keeper): ה-GET מקים-את-סולק-הכניסה-האוטומטי (פעם-אחת-לתהליך,
 * globalThis-guard) — הפקדה-מקושרת נסלקת-לבד ברגע-ההוכחה, אפס-עמלה, אפס-גז.
 * הכסף-עצמו זז-רק-בגרעין (stateRoot/חותמות) — הפנקס הוא ראיה-חוץ-מצב. */

export async function GET() {
  startBridgeAutoKeeper(); // FIX(Roast-66): idempotent — מופע-אחד-לתהליך
  return NextResponse.json({ ok: true, bridge: { ...getBridgeView(), auto: bridgeAutoStatus() } });
}

export async function POST(req: Request) {
  const oa = operatorAuth(req);
  if (oa) return oa;
  const g = consoleGuard(req);
  if (g) return g;

  const body = (await req.json().catch(() => ({}))) as { action?: string } & Record<string, unknown>;
  switch (String(body.action || "")) {
    case "register-in": {
      // FIX(Roast-64-c · F1): הקישור-החוץ נרשם-בכוונה (נמען+סכום+ממו+מקור) —
      // התביעה תאומת מולו; בלי-קישור-נמען הרישום נדחה fail-closed.
      const r = registerInbound({
        chain: String(body.chain || ""), proofRef: String(body.proofRef || ""),
        asset: String(body.asset || ""), amountMu: Number(body.amountMu),
        beneficiary: String(body.beneficiary || ""), farAddress: body.farAddress ? String(body.farAddress) : undefined,
        farAmount: body.farAmount ? String(body.farAmount) : undefined,
        farMemo: body.farMemo ? String(body.farMemo) : undefined,
        farSource: body.farSource ? String(body.farSource) : undefined,
      });
      return NextResponse.json(r, { status: 200 });
    }
    case "claim": {
      const r = await claimInbound({ id: String(body.id || "") });
      return NextResponse.json(r, { status: 200 });
    }
    case "lock-out": {
      const r = lockOutbound({
        issuer: String(body.issuer || ""), asset: String(body.asset || ""),
        amountMu: Number(body.amountMu), chain: String(body.chain || ""),
        farAddress: body.farAddress ? String(body.farAddress) : undefined,
        farAmount: body.farAmount ? String(body.farAmount) : undefined,
        farMemo: body.farMemo ? String(body.farMemo) : undefined,
        farSource: body.farSource ? String(body.farSource) : undefined,
      });
      return NextResponse.json(r, { status: 200 });
    }
    case "release": {
      const r = await markReleased({ id: String(body.id || ""), farTxid: String(body.farTxid || "") });
      return NextResponse.json(r, { status: 200 });
    }
    default:
      return NextResponse.json({ ok: false, error: "bad-action (register-in|claim|lock-out|release)" }, { status: 200 });
  }
}
