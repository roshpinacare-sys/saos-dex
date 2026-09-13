import { NextResponse } from "next/server";
import { getLiveState } from "@/lib/dex/chain";
import { truthLedger, railTick } from "@/lib/dex/truth";
import { blurtHead } from "@/lib/dex/price-proof";
import { operatorAuth } from "@/lib/operator-auth";
import { consoleGuard } from "@/lib/dex/guard"; // FIX(R16-a·m11): אחידות-היגיינה עם-שאר-הנתיבים-המגודרים

export const dynamic = "force-dynamic";

/** GET — מנוע-האמת (Task 61) · ציבורי-מלא.
 * FIX(Roast-63): GET-קריאה-בלבד — אפס-כתיבה-לגרעין (היה-מטביע-WBLURT-בכל-סקר-ציבורי).
 * ספר-אמת חי: פסק-דין-כן לכל-נכס, גיבוי-אמת-מהשרשראות, מחיר-חוץ-אמת,
 * מסילת-WBLURT-מגובה-חי (מצב-בלבד), וסולם-יציאה-עם-החסמים-האמתיים. */
export async function GET() {
  try {
    const st = getLiveState();
    const report = await truthLedger(st);
    return NextResponse.json(report);
  } catch (e) {
    return NextResponse.json({
      ok: false,
      error: "truth-error",
      note: e instanceof Error ? e.message : "unknown",
    }, { status: 200 });
  }
}

/** POST — פעולת-מפעיל: {action:"rail"} — השלמת-WBLURT-מגובה-חוץ (אידמפוטנטי).
 * FIX(Roast-63): ההטבעה-עברה-מ-GET-הפתוח לכאן — שער-מפעיל (operatorAuth, fail-closed). */
export async function POST(req: Request) {
  const oa = operatorAuth(req);
  if (oa) return oa;
  const g = consoleGuard(req); // FIX(R16-a·m11)
  if (g) return g;
  try {
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    if (body.action !== "rail") {
      return NextResponse.json({ ok: false, error: "bad-action", note: "actions: rail" }, { status: 400 });
    }
    const st = getLiveState();
    const blurt = await blurtHead();
    const liveBlurtMu = blurt ? Math.floor(blurt.liquid * 1000) : 0;
    const rail = railTick(st, liveBlurtMu);
    return NextResponse.json({ ok: true, rail, liveBlurtMu });
  } catch (e) {
    return NextResponse.json({ ok: false, error: "truth-rail-error", note: e instanceof Error ? e.message : "unknown" }, { status: 200 });
  }
}
