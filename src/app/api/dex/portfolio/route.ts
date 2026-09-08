import { NextResponse } from "next/server";
import { getPortfolio } from "@/lib/dex/portfolio";

export const dynamic = "force-dynamic";

/* ══ PORTFOLIO (SETTLE-12) — תיקיית-המטבעות הריבונית ═════════════════════════
 * GET בלבד (תצפית-ציבורית — השקיפות היא המוצר). שני ספרים: core ו-portfolio-b,
 * כל-שווי מדוד-מספרים-שלמים ממחירי-בריכות-חיים; זהויות-חוץ כנות בלבד.
 * מוטציות על התיקייה = העברה-חופשית (/api/dex/transfer) או batch (/api/dex/batch) —
 * שניהם משוערי-מפעיל. */

export async function GET() {
  return NextResponse.json({ ok: true, portfolio: getPortfolio() });
}
