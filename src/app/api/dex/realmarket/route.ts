import { NextResponse } from "next/server";
import { operatorAuth } from "@/lib/operator-auth";
import {
  realSnapshotSoft, realPlaceOrder, realCancelOrder, realPowerUp,
} from "@/lib/dex/realmarket";

export const dynamic = "force-dynamic";

/** GET — תמונת-מצב אמת של השוק-האמיתי (ציבורי · קריאה-בלבד · אף-פעם לא 500) */
export async function GET() {
  const snap = await realSnapshotSoft();
  return NextResponse.json(snap);
}

/**
 * POST — פעולות-חייל-אמת על ספר-STEEM (מאושרות-מפעיל · x-saos-operator):
 *  · place   { orderid, amountToSell: "0.260 SBD", minToReceive: "2.708 STEEM" }
 *  · cancel  { orderid }
 *  · powerdown { vestingShares: "2822636.039374 VESTS" }
 *  · powerup { steemAmount: "150.000 STEEM" }
 */
export async function POST(req: Request) {
  const oa = operatorAuth(req);
  if (oa) return oa;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad-json" }, { status: 400 });
  }
  const action = String(body.action ?? "");
  try {
    switch (action) {
      case "place": {
        const orderid = Number(body.orderid);
        const amountToSell = String(body.amountToSell ?? "");
        const minToReceive = String(body.minToReceive ?? "");
        if (!Number.isInteger(orderid) || orderid <= 0 || !amountToSell || !minToReceive) {
          return NextResponse.json({ ok: false, error: "place: orderid/amountToSell/minToReceive required" }, { status: 400 });
        }
        const r = await realPlaceOrder({ orderid, amountToSell, minToReceive });
        return NextResponse.json({ ok: true, action, ...r });
      }
      case "cancel": {
        const orderid = Number(body.orderid);
        if (!Number.isInteger(orderid)) {
          return NextResponse.json({ ok: false, error: "cancel: orderid required" }, { status: 400 });
        }
        const r = await realCancelOrder(orderid);
        return NextResponse.json({ ok: true, action, ...r });
      }
      case "powerdown": {
        // DIRECTIVE-R24 (owner 2026-09-13): לא עושים powerdown — כוח-הצי (SP/BP/HP)
        // מזין-RC-להדפסות-החיילים. חלוקת-הכוח בין STEEM/HIVE/BLURT אינה-תחום-ה-DEX.
        // ההוראה נאכפת כאן וגם ב-realReplacePowerdown (הגנה-כפולה fail-closed).
        return NextResponse.json({ ok: false, error: "DIRECTIVE-R24: powerdown forbidden by owner — fleet RC protected (requires explicit new owner instruction)" }, { status: 403 });
      }
      case "powerup": {
        const steemAmount = String(body.steemAmount ?? "");
        if (!/^\d+(\.\d+)? STEEM$/.test(steemAmount)) {
          return NextResponse.json({ ok: false, error: "powerup: steemAmount format 'N.NNN STEEM'" }, { status: 400 });
        }
        const r = await realPowerUp(steemAmount, body.to ? String(body.to) : undefined);
        return NextResponse.json({ ok: true, action, ...r });
      }
      default:
        return NextResponse.json({ ok: false, error: `unknown action: ${action}` }, { status: 400 });
    }
  } catch (e) {
    // כנות: שגיאת-שרשרת = נתונים, לא 500
    return NextResponse.json({ ok: false, action, error: e instanceof Error ? e.message : String(e) });
  }
}
