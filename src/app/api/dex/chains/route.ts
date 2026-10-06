import { NextResponse } from "next/server";
import { chainStream } from "@/lib/dex/chain-stream";

export const dynamic = "force-dynamic";

/* ══ THE-CHAIN-STREAM (EXEC-CD-11) ════════════════════════════════════════════
 * GET — הזרם-החי של הרשתות-האמיתיות: 8 רשתות (Ethereum · Base · BSC · Solana ·
 * TRON · STEEM · Hive · Blurt) דרך RPC-ציבורי-keyless בלבד.
 * לכל-רשת: גובה-בלוק-חי · גיל-בלוק · גז · chainId-מאומת · מחיר-אמת-ממוין-
 * חוצה-מקורות · יתרת-כתובת-הפקדה-הריבונית. TTL-קאש-30ש׳ + single-flight.
 * fail-כנה-לכל-רשת-בנפרד — רשת-מתה נראית-כרשת-מתה, לא מוסתרת ולא מאולפת. */
export async function GET() {
  try {
    const stream = await chainStream();
    return NextResponse.json(stream);
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "chain-stream-failed" });
  }
}
