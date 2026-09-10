import { NextResponse } from "next/server";
import { submitOp, nextNonce, getLiveState } from "@/lib/dex/chain";
import { consoleGuard } from "@/lib/dex/guard";
import { operatorAuth } from "@/lib/operator-auth";
import { launchpadState } from "@/lib/dex/launchpad";

export const dynamic = "force-dynamic";

/** Task 57/58 · מסילת-ההשקות — ה-API (GET ציבורי · POST דרך-השער).
 * רב-משתמשי: `as` (FIX Roast-63: סמכות-מפעיל-בלבד — המפעיל רשאי לפעול בשם-כל-חשבון-רשום; אין-כאן-אימות-גשר-חוץ) קובע-את-המנפיק — לא רק המפעיל. */

const ISSUER_RE = /^[a-z0-9_-]{2,24}$/;

function issuerOf(body: { as?: unknown }): string {
  const as = String(body.as ?? "").toLowerCase();
  return ISSUER_RE.test(as) ? as : "operator";
}

/** GET — רשימת-ההשקות-החיות + המדיניות + פנקס-ההכנסה-הנלווית (ציבורי). */
export async function GET() {
  return NextResponse.json(launchpadState(getLiveState()));
}

/** POST — create · buy · sell (מוטציות-ממפול). שערים: operatorAuth + consoleGuard. */
export async function POST(req: Request) {
  const oa = operatorAuth(req);
  if (oa) return oa;
  const g = consoleGuard(req);
  if (g) return g;

  const body = (await req.json().catch(() => ({}))) as {
    action?: string; ticker?: string; name?: string; mode?: string; supply?: number; amount?: number; as?: string;
  };
  const action = String(body.action ?? "");
  const issuer = issuerOf(body);
  const ticker = String(body.ticker ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const num = (v: unknown): number => Math.floor(Number(v ?? 0));

  if (action === "create") {
    const mode = body.mode === "lbp" ? "lbp" : "curve";
    const supply = num(body.supply) || 200_000_000; // ברירת-מחדל: 200K טוקן
    const r = submitOp({
      type: "launch_create", issuer, nonce: nextNonce("lpc"),
      ticker, name: String(body.name ?? ticker).slice(0, 24), lmode: mode, supply,
    });
    return NextResponse.json({
      ok: r.queued, error: r.reason,
      note: r.queued ? `ההשקה נקלטה — תיכנס לבלוק הבא (≤3 שניות)` : undefined,
    });
  }
  if (action === "buy" || action === "sell") {
    if (!ticker || !(num(body.amount) > 0))
      return NextResponse.json({ ok: false, error: "bad-request", note: "נדרש: ticker, amount" }, { status: 200 });
    const r = submitOp({
      type: action === "buy" ? "launch_buy" : "launch_sell", issuer, nonce: nextNonce(action === "buy" ? "lpb" : "lps"),
      ticker, amount: num(body.amount),
    });
    return NextResponse.json({
      ok: r.queued, error: r.reason,
      note: r.queued ? "נשלח לממפול — ייכלל בבלוק הבא (≤3 שניות)" : undefined,
    });
  }
  return NextResponse.json({ ok: false, error: "unknown-op", note: "פעולות: create · buy · sell" }, { status: 200 });
}
