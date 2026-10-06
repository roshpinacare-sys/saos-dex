import { NextResponse } from "next/server";
import { ensureChain } from "@/lib/dex/chain";
import { makerStatsFor } from "@/lib/dex/maker";

export const dynamic = "force-dynamic";

/**
 * EXEC-CD-8 · GET /api/dex/maker/snapshot — תמונת-מייקר (Maker-API, קריאה-ציבורית —
 * השקיפות היא-המוצר: הספר-והייחוס הם עובדות-ציבוריות).
 *
 * תוכן: הפקודות-החיות של-המנפיק · ייחוס-מילויים-ממסחר-אמת (fills/volMu) ·
 * מסגרת-הריבייט (תעריף-כנה-0 עד-החלטת-מימון) · מילויי-maker-אחרונים מהטייפ.
 * עתיד: ?issuer=<אחר> כשהמפעיל יפתח-זהויות-מייקר-חוץ — הנתיב-כבר-מוכן-לזה.
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
    note: "rebateRateBps=0 — מסילה-חיה; מימון-הריבייט = החלטת-מפעיל (docs/MAKER-API.md)",
  });
}
