import { NextResponse } from "next/server";
import { consoleGuard } from "@/lib/dex/guard";
import { operatorAuth } from "@/lib/operator-auth";
import { accountPreview, railConfigured, railExecute, type RailAction } from "@/lib/hive-rail";

export const dynamic = "force-dynamic";

/**
 * Task 27/26-c — מסילת-HIVE של ה-DEX (נפרד מ-SOVEREIGN-CONVERT של SETTLE-11 שנשאר ב-/convert).
 *
 * GET /api/dex/convert?account=<name>
 *   תצוגה-חיה (ציבורית, ללא-מפתחות): מאזני HIVE נזיל/HP/RC + טוקני Hive-Engine
 *   + המסלול-המוצע (sell → withdraw → powerup) לפי המאזנים בפועל.
 *
 * POST /api/dex/hive-rail  (שער-מפעיל + שער-קונסולה)
 *   body: { account, action: "sell"|"withdraw"|"powerup"|"transfer",
 *           symbol?, quantity?, price?, amount?, to? }
 *   FIX(Roast-73): ביצוע-אמיתי דרך המבצע-הריבוני-בדמון (rail-exec) — החותם-החוץ
 *   ההיסטורי אינו-קיים עוד. אותן-ערבויות: אימות-סמכות-חי מול-השרשרת + תחומי-
 *   יתרה-חיים + שער-RC. החזר: {txid} ציבורי או שגיאה מוסברת.
 *
 * תוצר-הבעלים (2026-09-08): "מערכת dex שצריכה לדעת להמיר מה שצריך — תשתמש בזה".
 */

export async function GET(req: Request) {
  const url = new URL(req.url);
  const account = (url.searchParams.get("account") ?? "").trim();
  if (!/^[a-z0-9\-.]{3,16}$/.test(account)) {
    return NextResponse.json({ ok: false, error: "bad-account" }, { status: 400 });
  }
  try {
    const preview = await accountPreview(account);
    if (!preview) return NextResponse.json({ ok: false, error: "account-not-found" }, { status: 404 });
    return NextResponse.json({ ok: true, rail: "hive-token→SWAP.HIVE→HIVE→HP", executor: "sovereign-in-daemon (rail-exec · authority-gated · roast-73)", ...preview });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `preview-failed: ${String((e as Error)?.message ?? e).slice(0, 120)}` }, { status: 502 });
  }
}

const ACTIONS: RailAction[] = ["sell", "withdraw", "powerup", "transfer"];

export async function POST(req: Request) {
  // שער-מפעיל (fail-closed ללא DEX_OPERATOR_TOKEN) — כמו שאר נתיבי-המוטציה
  const oa = operatorAuth(req);
  if (oa) return oa;
  // שער-קונסולה — היגיינת-CSRF מעל האימות
  const g = consoleGuard(req);
  if (g) return g;

  const body = (await req.json().catch(() => ({}))) as {
    account?: string; action?: string; symbol?: string; quantity?: number; price?: number; amount?: number; to?: string;
  };
  const account = (body.account ?? "").toLowerCase();
  const action = body.action as RailAction;
  if (!/^[a-z0-9\-.]{3,16}$/.test(account)) return NextResponse.json({ ok: false, error: "bad-account" }, { status: 400 });
  if (!action || !ACTIONS.includes(action)) return NextResponse.json({ ok: false, error: `bad-action (allowlist: ${ACTIONS.join(",")})` }, { status: 400 });
  if (!railConfigured()) return NextResponse.json({ ok: false, error: "rail-not-configured (HIVE_ANCHOR_ACCOUNT/HIVE_ACTIVE_WIF missing) — fail-closed" }, { status: 503 });

  if (action === "sell" && (!body.symbol || !body.quantity || !body.price)) {
    return NextResponse.json({ ok: false, error: "sell requires symbol, quantity, price" }, { status: 400 });
  }
  if ((action === "powerup" || action === "transfer") && (!body.amount || body.amount <= 0)) {
    return NextResponse.json({ ok: false, error: "powerup/transfer require amount > 0" }, { status: 400 });
  }
  if (action === "transfer" && !body.to) {
    return NextResponse.json({ ok: false, error: "transfer requires to" }, { status: 400 });
  }

  const result = await railExecute({ account, action, symbol: body.symbol, quantity: body.quantity, price: body.price, amount: body.amount, to: body.to });
  return NextResponse.json({ ...result, action, account }, { status: result.ok ? 200 : result.refused === "authority-gate" ? 403 : 502 });
}
