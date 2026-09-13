import { NextResponse } from "next/server";
import { getPools, getWallets, getLiveState, nextNonce, submitOp } from "@/lib/dex/chain";
import { ASSETS } from "@/lib/dex/kernel";
import { quoteRoute } from "@/lib/dex/router";
import { buildAtomicRoutePlan, toBatchOps } from "@/lib/dex/exec-route";
import { consoleGuard } from "@/lib/dex/guard";
import { operatorAuth } from "@/lib/operator-auth";

export const dynamic = "force-dynamic";

/* ══ SOVEREIGN-CONVERT (SETTLE-11) — דלפק-ההמרות של הרשת ═══════════════════
 * המטרה שהמפעיל קבע: "שנוכל להמיר על הרשת שלנו את המטבעות שברשותנו" —
 * ריבוני לחלוטין: פגישת-מחיר וסליקה בגרעין שלנו (AMM 30bps), אפס קוד זר,
 * אפס בורסה חיצונית, אפס שער-לא-מקובע.
 *
 * נכסי-הרשת (ASSETS קנוני): SAOS · USDS · WSTEEM · WSBD · PHIVE · ENERGY · STEEM
 * מסלולי-המרה: ישיר (בריכה-קיימת) או דרך-רכזת SAOS (2 קפיצות).
 * העטיפה 1:1 (wrap_mint/wrap_burn) — נתיב הכניסה מSTEEM/החזרה, דרך /api/dex/wrap.
 *
 * כשלון-כנה: אין-מסלול → no-path. ביצוע בלי minOut → נדחה (fail-closed —
 * המרה-בלי-מגן-החלקה היא חשיפה לתמרון-מחיר, וזה בדיוק מה שהגדר נגדו). */

const poolKeyOf = (x: string, y: string): string => [x, y].sort().join("/");
void poolKeyOf; // נשמר-לתיעוד-הזוגות-הקנוניים (findPath-הוסר — quoteRoute-הוא-האמת)

/* GET — מלאי-מהחזקות + טבלת-ציטוטים חיה (בלי-ביצוע) */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const assetIn = (url.searchParams.get("assetIn") || "").toUpperCase();
  const assetOut = (url.searchParams.get("assetOut") || "").toUpperCase();
  const amount = Math.max(0, Math.floor(Number(url.searchParams.get("amount") || 0)));

  const pools = getPools();
  const pairs = new Set(pools.map((p) => p.key));

  const holdings = getWallets()
    .filter((w) => w.name === "operator" || w.name === "treasury" || w.name === "arena")
    .map((w) => ({ name: w.name, credits: w.credits, balances: w.balances }));

  // FIX(Roast-71 · one-truth): הציטוט-עבר-מfindPath-המקומי (בריכות-בלבד, עד-2-קפיצות,
  // בלי-מסדרון-עיגון — STEEM→USDS היה-None-בשער-הזה-ותקין-בראוטר) לquoteRoute —
  // אותו-מנוע-כמו-POST וכמו-הראוטר: מסלול-הטוב-ביותר-עד-3-רגליים כולל-wrap.
  let quote: object | null = null;
  if (assetIn && assetOut && amount > 0) {
    const q = quoteRoute(assetIn, assetOut, amount);
    if (q && q.amountOutMu > 0) {
      quote = {
        path: q.legs.map((l) => l.to), // FIX(3-a · D7): טרנרי-מת — שני-הענפים היו l.to ממילא
        venues: q.legs.map((l) => l.venue),
        out: q.amountOutMu,
        effPriceMu: q.effPriceMu,
        minOutSuggested: Math.floor(q.amountOutMu * 0.99),
      };
    }
  }

  return NextResponse.json({
    ok: true,
    desk: "sovereign-convert/1.1.0+settle11 (roast-71 atomic+one-truth)",
    // FIX(Roast-63 · M4): רשימת-הנכסים-חיה-מהגרעין (הייתה-קבועה-והתיישנה — חסרו BLURT/WBLURT/LB|*)
    assets: [...new Set([...ASSETS, ...Object.keys(getLiveState().assets)])],
    pairs: [...pairs].sort(),
    holdings,
    quote, // null כשאין-פרמטרים/אין-מסלול
    wrapNote: "מסדרון-העיגון-החי: STEEM⇄WSTEEM · BLURT⇄WBLURT (עטיפה 1:1 מגובה — נכלל-אוטומטית במסלולי-quoteRoute)",
    gates: "POST דורש x-saos-operator + כותרת-מנהלת + minOut (fail-closed) · ביצוע-batch-אטומי (הכל-או-כלום)",
  });
}

/* POST — ביצוע-המרה.
 * FIX(Roast-71 · atomic-convert): הנתיב-הישן שלח pool_swap ×hops כפקודות-
 * עוקבות — רגל-2-שנדחית-אחרי-רגל-1-בוצעה הייתה משאירה נכס-תלוש-באמצע-שרשרת.
 * עכשיו: אותו-מנוע-המנוע-המשותף-עם-הראוטר (exec-route.ts) — batch-אטומי
 * (הכל-או-כלום), minOut חובה-על-הפלט-הסופי (נשאר fail-closed כמו-SETTLE-11),
 * והמסלול-הוא-הטוב-ביותר-עד-3-רגליים (כולל-מסדרון-עיגון) — לא-רק-דרך-SAOS. */
export async function POST(req: Request) {
  // P0(25-a): שער-מפעיל — מוטציה דורשת טוקן x-saos-operator (בלי טוקן: 503 fail-closed)
  const oa = operatorAuth(req);
  if (oa) return oa;
  // FIX(FOUNDRY top-bug): שער-קונסולה — מוטציה-דורשת-כותרת-מנהלת
  const g = consoleGuard(req);
  if (g) return g;

  const body = (await req.json().catch(() => ({}))) as {
    assetIn?: string; assetOut?: string; amount?: number; minOut?: number;
  };
  const assetIn = (body.assetIn || "").toUpperCase();
  const assetOut = (body.assetOut || "").toUpperCase();
  const amount = Math.floor(Number(body.amount));
  // FIX(SETTLE-11 fail-closed): המרה בלי minOut = חשיפה לתמרון-מחיר — נדחה תמיד.
  const minOut = Math.floor(Number(body.minOut));
  if (!assetIn || !assetOut || !(amount > 0) || !Number.isFinite(minOut) || minOut < 0) {
    return NextResponse.json({ ok: false, error: "bad-request (נדרש assetIn+assetOut+amount>0+minOut)" }, { status: 200 });
  }

  const plan = buildAtomicRoutePlan(assetIn, assetOut, amount, minOut);
  if (!plan.ok || !plan.sub) {
    return NextResponse.json({ ok: false, error: plan.error === "no-route" ? "no-path (אין מסלול-מבצע)" : plan.error }, { status: 200 });
  }

  // דלפק-ההמרות מנוהל-על-ידי-המפעיל — הביצוע-מארנקו (issuer fail-closed קבוע)
  const ops = toBatchOps(plan.sub, "operator", "cv");
  const r = submitOp({ type: "batch", issuer: "operator", nonce: nextNonce("cv-batch"), ops });
  if (!r.queued) return NextResponse.json({ ok: false, error: r.reason ?? "queue-rejected" }, { status: 200 });
  return NextResponse.json({
    ok: true, atomic: true,
    hops: plan.routeVenues, // תאימות-לאחור: שמות-המקומות (POOL:/PEG-RAIL:)
    path: plan.routeVenues,
    expectOutMu: plan.expectOutMu,
    effPriceMu: plan.effPriceMu,
    count: ops.length,
    note: "queued — batch-אטומי (הכל-או-כלום), minOut fail-closed על-הפלט-הסופי",
  });
}
