import { NextResponse } from "next/server";
import { getPools, getQuote, getWallets, nextNonce, submitOp } from "@/lib/dex/chain";
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

function findPath(pairs: Set<string>, a: string, b: string): string[] | null {
  if (a === b) return null;
  if (pairs.has(poolKeyOf(a, b))) return [a, b];
  if (a !== "SAOS" && b !== "SAOS" && pairs.has(poolKeyOf(a, "SAOS")) && pairs.has(poolKeyOf(b, "SAOS"))) {
    return [a, "SAOS", b];
  }
  return null;
}

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

  const hopQuote = (assetInH: string, assetOutH: string, amountH: number): number | null => {
    const q = getQuote(poolKeyOf(assetInH, assetOutH), assetInH, amountH);
    return q ? q.out : null;
  };

  let quote: object | null = null;
  if (assetIn && assetOut && amount > 0) {
    const path = findPath(pairs, assetIn, assetOut);
    if (path) {
      if (path.length === 2) {
        const out = hopQuote(path[0], path[1], amount);
        quote = out === null ? null : { path, out, minOutSuggested: Math.floor(out * 0.99) };
      } else {
        const mid = hopQuote(path[0], path[1], amount);
        const out = mid && mid > 0 ? hopQuote(path[1], path[2], mid) : null;
        quote = out === null ? null : { path, out, minOutSuggested: Math.floor(out * 0.99) };
      }
    }
  }

  return NextResponse.json({
    ok: true,
    desk: "sovereign-convert/1.0.0+settle11",
    assets: ["SAOS", "USDS", "WSTEEM", "WSBD", "PHIVE", "ENERGY", "STEEM"],
    pairs: [...pairs].sort(),
    holdings,
    quote, // null כשאין-פרמטרים/אין-מסלול
    wrapNote: "STEEM↔WSTEEM (וכן PHIVE) — עטיפה 1:1 כנה דרך POST /api/dex/wrap (mint/burn)",
    gates: "POST דורש x-saos-operator + כותרת-מנהלת + minOut (fail-closed)",
  });
}

/* POST — ביצוע-המרה: מסלול-ישיר או דרך-SAOS; minOut חובה על-הפלט-הסופי */
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

  const pools = getPools();
  const path = findPath(new Set(pools.map((p) => p.key)), assetIn, assetOut);
  if (!path) {
    return NextResponse.json({ ok: false, error: "no-path (אין בריכה ישירה ואין מסלול דרך SAOS)" }, { status: 200 });
  }

  const hops: { pair: string; assetIn: string; amount: number; minOut: number }[] = [];
  if (path.length === 2) {
    hops.push({ pair: poolKeyOf(path[0], path[1]), assetIn: path[0], amount, minOut });
  } else {
    // 2 קפיצות: קפיצה-1 עם מגן-5% מהציטוט; קפיצה-2 עם minOut של המפעיל (חובה)
    const q1 = getQuote(poolKeyOf(path[0], path[1]), path[0], amount);
    if (!q1 || !(q1.out > 0)) return NextResponse.json({ ok: false, error: "no-quote-hop1" }, { status: 200 });
    const guard1 = Math.floor(q1.out * 0.95); // מגן-החלקה פנימי (5%) — קפיצת-ביניים
    hops.push({ pair: poolKeyOf(path[0], path[1]), assetIn: path[0], amount, minOut: guard1 });
    hops.push({ pair: poolKeyOf(path[1], path[2]), assetIn: path[1], amount: guard1, minOut });
  }

  // העברה לגרעין: pool_swap ×hops (אותו-בלוק, בסדר — סדר-ההגשה נשמר דטרמיניסטית)
  const results: { pair: string; queued: boolean; error?: string }[] = [];
  for (const h of hops) {
    const r = submitOp({
      type: "pool_swap",
      issuer: "operator",
      nonce: nextNonce("cv"),
      pair: h.pair, assetIn: h.assetIn as never, amount: h.amount, minOut: h.minOut,
    });
    results.push({ pair: h.pair, queued: r.queued, error: r.reason });
  }
  const allQueued = results.every((r) => r.queued);
  return NextResponse.json({
    ok: allQueued, hops: results,
    note: allQueued ? "queued — ייכלל בבלוק הבא (minOut fail-closed בגרעין)" : undefined,
  });
}
