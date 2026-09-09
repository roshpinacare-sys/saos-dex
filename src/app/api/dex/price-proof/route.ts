import { NextResponse } from "next/server";
import { getLiveState } from "@/lib/dex/chain";
import { priceProof } from "@/lib/dex/price-proof";

export const dynamic = "force-dynamic";

/** GET — מנוע-הוכחת-המחיר (Task 56) · ציבורי-מלא (קריאה-בלבד).
 * שרשרת-הנגזרת: בריכות-חיות → WSTEEM מגובה-1:1 → STEEM-שוק-ציבורי (CoinGecko)
 * → SAOS-ב-$-אמת · עומק-אמת (depth profile) · הצלבת-שווקים (cross-venue)
 * · אוצר-האמת (יתרות-STEEM/HIVE/BLURT חיות × מחירי-שוק). */
export async function GET() {
  try {
    const st = getLiveState();
    const proof = await priceProof(st);
    return NextResponse.json(proof);
  } catch (e) {
    // fail-כנה — לא מאלפים נתונים כשמשהו נופל
    return NextResponse.json({
      ok: false,
      error: "price-proof-error",
      note: e instanceof Error ? e.message : "unknown",
    }, { status: 200 });
  }
}
