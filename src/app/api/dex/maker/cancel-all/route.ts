import { NextResponse } from "next/server";
import { submitOp, nextNonce } from "@/lib/dex/chain";
import { ASSETS } from "@/lib/dex/kernel";
import { consoleGuard } from "@/lib/dex/guard";
import { operatorAuth } from "@/lib/operator-auth";
import { isMakerIdentity } from "@/lib/dex/maker"; // EXEC-CD-9 · זהויות-מייקר-חוץ

export const dynamic = "force-dynamic";

/**
 * EXEC-CD-8 · POST /api/dex/maker/cancel-all — ביטול-סוויפ-אטומי (Maker-API).
 *
 * מוחק בפעולה-אחת את כל-הפקודות-החיות של-המנפיק (רשות: סינון base/quote לזוג-אחד) —
 * בזמן-בניית-הבלוק (לא בזמן-הבקשה) → אפס-מירוץ מול-מילויים שקורים-בין-לבין.
 * אידמפוטנטי: אין-פקודות = ok (ספירה תיחשף ב-journal וב-snapshot).
 * שחרור-הערבויות מדויק-פר-פקודה (מד-הנעילה-הפרטי) — בגרעין (case cancel_all).
 */
export async function POST(req: Request) {
  const oa = operatorAuth(req);
  if (oa) return oa;
  const g = consoleGuard(req);
  if (g) return g;

  const body = (await req.json().catch(() => ({}))) as { base?: string; quote?: string; issuer?: string };
  // EXEC-CD-9 · זהויות-מייקר-חוץ: סוויפ-על-זהות-מצוטטת (ברירת-מחדל: operator)
  const makerIssuer = body.issuer ? String(body.issuer).toLowerCase() : "operator";
  if (!isMakerIdentity(makerIssuer)) {
    return NextResponse.json({ ok: false, error: "bad-identity (a-z0-9- 3..24; שמות-מערכת-אסורים)" }, { status: 200 });
  }
  const base = body.base ? String(body.base) : undefined;
  const quote = body.quote ? String(body.quote) : undefined;
  // היגיינה-קפדנית: סינון-נכסים-לא-מוכרים נדחה (אותו-חוזה של /api/dex/order)
  if ((base && !ASSETS.includes(base as never)) || (quote && !ASSETS.includes(quote as never))) {
    return NextResponse.json({ ok: false, error: "bad-asset-filter" }, { status: 200 });
  }
  const r = submitOp({
    type: "cancel_all",
    issuer: makerIssuer,
    nonce: nextNonce("mca"),
    base: base as never, quote: quote as never,
  });
  return NextResponse.json({
    ok: r.queued, error: r.reason,
    scope: base && quote ? `${base}/${quote}` : "all-markets",
    note: r.queued ? "sweep — ירוץ בבלוק הבא (≤3ש׳) על-מה-שחי אז (אפס-מירוץ)" : undefined,
  });
}
