import { NextResponse } from "next/server";
import { nextNonce, submitOp, getLiveState } from "@/lib/dex/chain";
import { getPool, quoteOut, poolMidFor } from "@/lib/dex/amm";
import { consoleGuard } from "@/lib/dex/guard";
import { operatorAuth } from "@/lib/operator-auth";

export const dynamic = "force-dynamic";

/* ══ THE-MICRODOSE (SETTLE-15) — סכום-קטן-אבל-מדויק לבחינת-יעילות-המיקרו ═════
 * דבר-המפעיל: "מה שצריך זה סכום-קטן אבל מדויק לבחון את יעילות המיקרו".
 *
 * שדה-הניסוי-החי: בריכת-ENERGY/SAOS (הבריכה-המיקרו — 40k/5kµ, אפס-מסחרות).
 *  · GET  ?pair= — מדידה-מלאה: רזרבות, mid, עומק-שני-הצדדים, השפעת-מחיר
 *    לעסקת-תקן (5kµ) בשני-הכיוונים (bps), עמלות-שנצברו.
 *  · POST {pair, amountA, issuer?} — מנת-מיקרו-מדויקת מהאוצר לבריכה
 *    (pool_add פרופורציונלי — אפס-הזזת-mid) + הדוח-לפני.
 *  · אימות-היעילות: אחרי-המנה מריצים-תנועת-ראוטר-אמת דרך-הבריכה
 *    (/api/dex/route ENERGY→USDS) ומודדים: Δעמלות-נתפסות, Δהשפעת-מחיר,
 *    יעילות=Δעומק לכל-µ-שהוזרק. הכל-מדידה-חיה, אפס-הטבעה (האוצר משלם מהיתרה). */

const STD_TRADE_MU = 5_000; // עסקת-התקן למדידת-השפעת-מחיר

function measure(pair: string) {
  const st = getLiveState();
  const p = getPool(st, pair);
  if (!p) return null;
  const mid = poolMidFor(p, p.a, p.b);
  const impact = (assetIn: string): { ok: boolean; priceMu: number; impactBps: number } => {
    const q = quoteOut(p, assetIn, STD_TRADE_MU);
    if (!q) return { ok: false, priceMu: 0, impactBps: 0 };
    const impactBps = mid > 0 ? Math.floor((Math.abs(q.price - mid) * 10_000) / mid) : 0;
    return { ok: true, priceMu: q.price, impactBps };
  };
  return {
    pair, a: p.a, b: p.b, ra: p.ra, rb: p.rb, lp: p.lp, mid,
    swaps: p.swaps, feeAccruedTreasury: p.feeAccruedTreasury,
    depthAUnitsMu: p.ra, depthBUnitsMu: p.rb,
    impactAtoB: impact(p.a), impactBtoA: impact(p.b),
    stdTradeMu: STD_TRADE_MU,
  };
}

/** GET — מדידת-הבריכה (ציבורי) */
export async function GET(req: Request) {
  const pair = String(new URL(req.url).searchParams.get("pair") ?? "ENERGY/SAOS");
  const m = measure(pair);
  if (!m) return NextResponse.json({ ok: false, error: "pool-not-found" }, { status: 200 });
  return NextResponse.json({ ok: true, pool: m, honesty: "מדידה-חיה על הרזרבות-בפועל · עסקת-תקן להשפעת-מחיר" });
}

/** POST — מנת-מיקרו-מדויקת (שער-מפעיל) */
export async function POST(req: Request) {
  const oa = operatorAuth(req);
  if (oa) return oa;
  const g = consoleGuard(req);
  if (g) return g;

  const body = (await req.json().catch(() => ({}))) as { pair?: string; amountA?: number; issuer?: string };
  const pair = String(body.pair ?? "");
  const amountA = Math.floor(Number(body.amountA));
  const issuer = String(body.issuer || "treasury").toLowerCase();
  if (!["treasury", "operator", "arena", "portfolio-b"].includes(issuer)) {
    return NextResponse.json({ ok: false, error: "bad-issuer" }, { status: 200 });
  }
  const before = measure(pair);
  if (!before) return NextResponse.json({ ok: false, error: "pool-not-found" }, { status: 200 });
  if (!(amountA > 0) || amountA > 2_000_000) {
    return NextResponse.json({ ok: false, error: "bad-amount (1..2,000,000µ — מנת-מיקרו-בלבד)" }, { status: 200 });
  }
  const r = submitOp({
    type: "pool_add", issuer, nonce: nextNonce("md"),
    pair, amount: amountA, // הגרעין משלים את הצד-השני פרופורציונלית (אפס-הזזת-mid)
  });
  if (!r.queued) return NextResponse.json({ ok: false, error: r.reason ?? "queue-rejected" }, { status: 200 });
  const st = getLiveState();
  const projB = Math.floor((before.rb * amountA) / before.ra);
  return NextResponse.json({
    ok: true, before, dose: { amountA, projectedAmountB: projB, issuer },
    expectedAfter: { ra: before.ra + amountA, rb: before.rb + projB, mid: before.mid },
    note: "מנת-מיקרו-פרופורציונלית — mid-לא-זז, עומק-עולה; מדדו-שוב-אחרי-בלוק (GET) והריצו-ראוטר-אמת דרך-הבריכה",
    arbHint: "POST /api/dex/route {assetIn:'ENERGY', assetOut:'USDS', amount:…, issuer:'treasury'}",
    balances: { issuerA: st.balances[issuer]?.[before.a] ?? 0, issuerB: st.balances[issuer]?.[before.b] ?? 0 },
  });
}
