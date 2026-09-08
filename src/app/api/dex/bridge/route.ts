import { NextResponse } from "next/server";
import { getBridgeView, claimInbound, lockOutbound, markReleased, registerInbound } from "@/lib/dex/bridge";
import { consoleGuard } from "@/lib/dex/guard";
import { operatorAuth } from "@/lib/operator-auth";

export const dynamic = "force-dynamic";

/* ══ SOVEREIGN-BRIDGE (SETTLE-12) — הגשר-הדו-כיווני ═════════════════════════
 * GET — מצב-הגשר: יתרות-escrow-חיות, כוונות-פנימיות, תקרות, החוזה-שלנו-שם.
 * POST — פעולות (שער-מפעיל + קונסולה, fail-closed):
 *   · register-in  {chain, proofRef, asset, amountMu, beneficiary} — רישום-
 *     הפקדה-על-הרשת-החוץ (אנטי-כפילות לפי-proofRef).
 *   · claim        {id} — תשלום-מה-escrow-הריבוני ב-xfer_free (אפס-גז).
 *   · lock-out     {issuer, asset, amountMu, chain, farAddress?} — נעילת-נכס
 *     ב-escrow להוצאה לרשת-חוץ.
 *   · release      {id, farTxid} — הפעיל מעיד שהחוזה-שלנו-שם שחרר (64-hex).
 * הכסף-עצמו זז-רק-בגרעין (stateRoot/חותמות) — הפנקס הוא ראיה-חוץ-מצב. */

export async function GET() {
  return NextResponse.json({ ok: true, bridge: getBridgeView() });
}

export async function POST(req: Request) {
  const oa = operatorAuth(req);
  if (oa) return oa;
  const g = consoleGuard(req);
  if (g) return g;

  const body = (await req.json().catch(() => ({}))) as { action?: string } & Record<string, unknown>;
  switch (String(body.action || "")) {
    case "register-in": {
      const r = registerInbound({
        chain: String(body.chain || ""), proofRef: String(body.proofRef || ""),
        asset: String(body.asset || ""), amountMu: Number(body.amountMu),
        beneficiary: String(body.beneficiary || ""), farAddress: body.farAddress ? String(body.farAddress) : undefined,
      });
      return NextResponse.json(r, { status: 200 });
    }
    case "claim": {
      const r = claimInbound({ id: String(body.id || "") });
      return NextResponse.json(r, { status: 200 });
    }
    case "lock-out": {
      const r = lockOutbound({
        issuer: String(body.issuer || ""), asset: String(body.asset || ""),
        amountMu: Number(body.amountMu), chain: String(body.chain || ""),
        farAddress: body.farAddress ? String(body.farAddress) : undefined,
      });
      return NextResponse.json(r, { status: 200 });
    }
    case "release": {
      const r = markReleased({ id: String(body.id || ""), farTxid: String(body.farTxid || "") });
      return NextResponse.json(r, { status: 200 });
    }
    default:
      return NextResponse.json({ ok: false, error: "bad-action (register-in|claim|lock-out|release)" }, { status: 200 });
  }
}
