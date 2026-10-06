import { NextResponse } from "next/server";
import { ensureChain } from "@/lib/dex/chain";
import { makerStatsFor } from "@/lib/dex/maker";

export const dynamic = "force-dynamic";

/**
 * EXEC-CD-8 · GET /api/dex/maker/snapshot — תמונת-מייקר (Maker-API, קריאה-ציבורית —
 * השקיפות היא-המוצר: הספר-והייחוס הם עובדות-ציבוריות).
 *
 * תוכן: הפקודות-החיות של-המנפיק · ייחוס-מילויים-ממסחר-אמת (fills/volMu) ·
 * מסגרת-הריבייט (EXEC-CD-9: תעריף-10bps, ממומן-ממחזור-גז-הספר) · מילויי-maker-אחרונים מהטייפ.
 * EXEC-CD-9 · ?issuer=<אחר> חי — זהויות-מייקר-חוץ פתוחות (חשבונות-אזרח; המפתח-האחד חתום).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const issuer = url.searchParams.get("issuer") ?? "operator";
  const rt = ensureChain();

  const orders = rt.st.orders
    .filter((o) => o.live && o.owner === issuer)
    .map((o) => ({
      id: o.id, base: o.base, quote: o.quote, side: o.side,
      price: o.price, amount: o.amount, filled: o.filled,
    }));

  const myFills = rt.tape
    .filter((e) => (e as { kind?: string; maker?: string }).kind === "fill" && (e as { maker?: string }).maker === issuer)
    .slice(0, 20)
    .map((e) => {
      const f = e as { base?: string; quote?: string; price?: number; amountMu?: number; h?: number; at?: number };
      return { base: f.base, quote: f.quote, price: f.price, amountMu: f.amountMu, h: f.h, at: f.at };
    });

  return NextResponse.json({
    ok: true,
    issuer,
    liveOrders: orders.length,
    orders,
    stats: makerStatsFor(issuer),
    recentFillsAsMaker: myFills,
    note: "ריבייט 10bps בקרדיטי-דלק ממחזור-גז-הספר — סליקה: POST /api/dex/maker/rebate-settle",
  });
}
