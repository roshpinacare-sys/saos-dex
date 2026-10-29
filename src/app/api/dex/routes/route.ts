import { NextResponse } from "next/server";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { buildLiveRouteMap } from "../../../../../grids/route-map.mjs";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/dex/routes — מפת-נתיבי-ההמרה החיה (owner mandate 1a185071).
 * מחשב-חי מהמקורות האמת: מצב-ה-engine (או snapshot), ספרי-STEEM/HIVE ציבוריים,
 * אורקלי-חוץ, דלתות-ה-kernel. PLAN-ONLY — אין-ביצוע מהקריאה הזו.
 * cache קצר בתהליך (60ש') כדי-שה-poll החי לא-יכה-ברשתות-חוץ בכל-בקשה.
 */
let cache: { at: number; data: unknown } | null = null;
const TTL_MS = 60_000;

export async function GET() {
  try {
    if (cache && Date.now() - cache.at < TTL_MS) {
      return NextResponse.json({ ok: true, cached: true, ...(cache.data as object) });
    }
    const map = await buildLiveRouteMap({});
    cache = { at: Date.now(), data: map };
    return NextResponse.json({ ok: true, cached: false, ...map });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: String((e as Error)?.message ?? e).slice(0, 200), honesty: "fail-closed — אין-מפה-כשיש-תקלה" },
      { status: 503 },
    );
  }
}
