import { NextResponse } from "next/server";
import { nextNonce, submitOp } from "@/lib/dex/chain";
import { ASSETS, FREE_XFER_CAP, type Asset } from "@/lib/dex/kernel";
import { consoleGuard } from "@/lib/dex/guard";
import { operatorAuth } from "@/lib/operator-auth";

export const dynamic = "force-dynamic";

/* ══ THE-SWEEP (SETTLE-12) — העברה-חופשית על הרשת-הריבונית ══════════════════
 * "שנוכל להעביר חופשי ללא עלות של גז — על הרשת שלנו" (דבר-המפעיל).
 * POST /api/dex/transfer {from, to, asset, amountMu} → op xfer_free (גז-0).
 * fail-closed: נכס-מרשימת-ASSETS בלבד · תקרת-FREE_XFER_CAP · מזהים-קנוניים ·
 * שער-מפעיל + שער-קונסולה. אין-חשבונות-רפאים: היעד נבדק-בגרעין דרך-addBal,
 * והמוצא חייב-יתרה (avail) — כל-השאר נדחה. */

const idOk = (s: string): boolean => /^[a-z0-9][a-z0-9-]{0,30}$/.test(s);

export async function POST(req: Request) {
  const oa = operatorAuth(req);
  if (oa) return oa;
  const g = consoleGuard(req);
  if (g) return g;

  const body = (await req.json().catch(() => ({}))) as {
    from?: string; to?: string; asset?: string; amountMu?: number;
  };
  const from = String(body.from || "").toLowerCase();
  const to = String(body.to || "").toLowerCase();
  const asset = String(body.asset || "").toUpperCase();
  const amountMu = Math.floor(Number(body.amountMu));
  if (!idOk(from) || !idOk(to) || from === to) {
    return NextResponse.json({ ok: false, error: "bad-parties (from≠to, [a-z0-9-] בלבד)" }, { status: 200 });
  }
  if (!ASSETS.includes(asset as Asset)) {
    return NextResponse.json({ ok: false, error: `bad-asset (מותר: ${ASSETS.join("|")})` }, { status: 200 });
  }
  if (!(amountMu > 0) || amountMu > FREE_XFER_CAP) {
    return NextResponse.json({ ok: false, error: `bad-amount (1..${FREE_XFER_CAP}µ — תקרת-החינם-פר-פקודה)` }, { status: 200 });
  }
  const r = submitOp({ type: "xfer_free", issuer: from, nonce: nextNonce("xf"), to, asset: asset as Asset, amount: amountMu });
  if (!r.queued) return NextResponse.json({ ok: false, error: r.reason ?? "queue-rejected" }, { status: 200 });
  return NextResponse.json({ ok: true, note: `העברה-חופשית ${amountMu}µ ${asset} → ${to} (גז-0 — תיכלל בבלוק הבא)` });
}
