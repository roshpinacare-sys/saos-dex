import { NextResponse } from "next/server";
import { onrampSnapshot } from "@/lib/onramp";
import { operatorAuth } from "@/lib/operator-auth";

export const dynamic = "force-dynamic";

/* ══ THE-ONRAMP (SETTLE-17) — מפת-הנזילות-החוץ-האמתית ═══════════════════════
 * GET — ציבורי, חסר-מפתחות: מאזני-חוץ-חיים (9-חיילי-הצי + headcorner) מה-RPC
 * המקובע + מפת-יכולת-כנה (מה-מניב-עכשיו / מה-דורש-החלטת-מפעיל).
 * TTL-קאש 10 דק'. אפס-סודות · אפס-כתיבה.
 * FIX(Roast-64-c · F15): ?force=1 עבר-אחר-שער-המפעיל — היה-ציבורי ואיפשר לכל-אחד
 * לרסק-את-ה-TTL (DoS-על-ה-RPC-המקובע). בלי-אימות: force מתעלם (יחס-false) עם
 * note "force-ignored-public". אותו-דפוס operatorAuth כמו שאר-הראוטים. */
export async function GET(req: Request) {
  const wantsForce = new URL(req.url).searchParams.get("force") === "1";
  let force = false;
  let note: string | undefined;
  if (wantsForce) {
    // operatorAuth מחזיר null רק-כשהכותרת x-saos-operator מאומתת (fail-closed —
    // אין-DEX_OPERATOR_TOKEN בסביבה = השער-סגור גם-ל-force)
    if (operatorAuth(req) === null) force = true;
    else note = "force-ignored-public";
  }
  try {
    const data = await onrampSnapshot(force);
    return NextResponse.json(note ? { ok: true, onramp: data, note } : { ok: true, onramp: data });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: String((e as Error)?.message || e).slice(0, 160) },
      { status: 502 },
    );
  }
}
