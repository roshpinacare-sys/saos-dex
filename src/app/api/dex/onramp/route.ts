import { NextResponse } from "next/server";
import { onrampSnapshot } from "@/lib/onramp";

export const dynamic = "force-dynamic";

/* ══ THE-ONRAMP (SETTLE-17) — מפת-הנזילות-החוץ-האמתית ═══════════════════════
 * GET — ציבורי, חסר-מפתחות: מאזני-חוץ-חיים (9-חיילי-הצי + headcorner) מה-RPC
 * המקובע + מפת-יכולת-כנה (מה-מניב-עכשיו / מה-דורש-החלטת-מפעיל).
 * TTL-קאש 10 דק'; ?force=1 מכריח-מדידה-חיה. אפס-סודות · אפס-כתיבה. */
export async function GET(req: Request) {
  const force = new URL(req.url).searchParams.get("force") === "1";
  try {
    const data = await onrampSnapshot(force);
    return NextResponse.json({ ok: true, onramp: data });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: String((e as Error)?.message || e).slice(0, 160) },
      { status: 502 },
    );
  }
}
