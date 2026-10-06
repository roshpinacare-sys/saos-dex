import { NextResponse } from "next/server";
import { submitOp, nextNonce } from "@/lib/dex/chain";
import { ASSETS, BATCH_MAX_OPS } from "@/lib/dex/kernel";
import { consoleGuard } from "@/lib/dex/guard";
import { operatorAuth } from "@/lib/operator-auth";

export const dynamic = "force-dynamic";

/**
 * EXEC-CD-8 · POST /api/dex/maker/quotes — הצבת-ציטוטים-באצווה (Maker-API).
 *
 * סטנדרט-מייקרים-מקצועיים: גריד-שלם-נכנס בשליחה-אחת (≤ BATCH_MAX_OPS=8, תקרת-
 * הגרעין-האטומי). שני-מצבים:
 *  · atomic (ברירת-מחדל) — batch-אטומי-גרעיני (הכל-או-כלום): ציטוט-אחד-פסול
 *    מוחק את-כולה — מגן-מלאי-ממיקום-חלקי-של-גריד (grid-half-placed).
 *  · best-effort — כל-ציטוט נשלח בנפרד; תוצאה-פר-ציטוט-מוחזרת (רענון-מדורג).
 * סוגי-פקודות-מלאים-פר-ציטוט: postOnly (maker-only) · ioc. הערבויות/הנעילות
 * זרימות-דרך-אותו-חוזה-אסקרו של-הגרעין — אפס-קוד-כספים-כאן (שער-בלבד).
 */
export async function POST(req: Request) {
  const oa = operatorAuth(req);
  if (oa) return oa;
  const g = consoleGuard(req);
  if (g) return g;

  try {
    const body = (await req.json()) as {
      mode?: "atomic" | "best-effort";
      orders?: {
        base?: string; quote?: string; side?: "buy" | "sell";
        price?: number; amount?: number;
        postOnly?: boolean; ioc?: boolean;
      }[];
    };
    const list = Array.isArray(body.orders) ? body.orders : [];
    if (list.length === 0 || list.length > BATCH_MAX_OPS) {
      return NextResponse.json({ ok: false, error: `orders-1..${BATCH_MAX_OPS}` }, { status: 200 });
    }
    const mode = body.mode === "best-effort" ? "best-effort" : "atomic";

    // אימות-מפורש-פר-ציטוט (fail-closed לפני-כל-שליחה — אותו-חוזה של /api/dex/order)
    interface Sub {
      type: "order";
      base: string; quote: string; side: "buy" | "sell";
      price: number; amount: number;
      postOnly?: true; ioc?: true;
    }
    const subs: Sub[] = [];
    for (const q of list) {
      const amount = Math.floor(Number(q.amount));
      const price = Math.floor(Number(q.price));
      if (!q.base || !q.quote || q.base === q.quote
        || !ASSETS.includes(q.base as never) || !ASSETS.includes(q.quote as never)
        || (q.side !== "buy" && q.side !== "sell")
        || !(price > 0) || !(amount > 0)
        || (q.postOnly === true && q.ioc === true)) {
        return NextResponse.json({ ok: false, error: "bad-quote (base/quote/side/price/amount; postOnly+ioc אסורים-יחד)" }, { status: 200 });
      }
      subs.push({
        type: "order",
        base: q.base, quote: q.quote, side: q.side,
        price, amount,
        postOnly: q.postOnly === true ? true : undefined,
        ioc: q.ioc === true ? true : undefined,
      });
    }

    if (mode === "atomic") {
      // batch-אטומי-גרעיני — תתי-ops עם nonces משלהם (issuer-pinned בגרעין;
      // דחיית-תת-אחד = דחיית-הכול = אפס-מיקום-חלקי)
      const r = submitOp({
        type: "batch",
        issuer: "operator",
        nonce: nextNonce("mmq"),
        ops: subs.map((s, i) => ({ ...s, issuer: "operator", nonce: nextNonce(`mmq${i}`) })) as never,
      });
      return NextResponse.json({
        ok: r.queued, mode, count: subs.length, error: r.reason,
        note: r.queued
          ? "atomic-batch — כולו ייכנס בבלוק הבא (≤3ש׳) או יידחה כולו (כולל postOnly-חוצה)"
          : undefined,
      });
    }

    // best-effort — שליחות-נפרדות, תוצאה-פר-ציטוט
    const results = subs.map((s, i) => {
      const r = submitOp({ ...s, issuer: "operator", nonce: nextNonce(`mmb${i}`) } as never);
      return { i, queued: r.queued, error: r.reason };
    });
    return NextResponse.json({ ok: results.every((r) => r.queued), mode, count: subs.length, results });
  } catch {
    return NextResponse.json({ ok: false, error: "bad-json" }, { status: 200 });
  }
}
