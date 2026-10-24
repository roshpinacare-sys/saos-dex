import { NextResponse } from "next/server";
import { getLiveState, submitOp, nextNonce } from "@/lib/dex/chain";
import { htlcInvariant, HTLC_MAX_TIMEOUT_H } from "@/lib/dex/htlc";
import { consoleGuard } from "@/lib/dex/guard";
import { operatorAuth } from "@/lib/operator-auth";

export const dynamic = "force-dynamic";

/**
 * /api/dex/htlc — דלת-הגשר-האטומי-הפנימי (G70 §7.2 · wave 19.82).
 *
 * GET — תצוגה-ציבורית-כנה: כל-החוזים (אחרונים-50) + מבקר-השימור חי.
 *   · ה-preimage נראה **רק-אחרי-חשיפתו-על-השרשרת** (העד-הציבורי של-I8);
 *     לפני-כן רק ה-hashlock — זו-בדיוק-נקודת-האטומיות.
 *   · אפס-סודות · אפס-מפתחות · fail-honest.
 *
 * POST — שער-מפעיל (operatorAuth + consoleGuard) → submitOp (המשפך-היחיד —
 * קבינט-הסיכון-טרום-המסחר תופס-מעלה, fail-closed):
 *   · create {issuer?, to, asset, amount, hashlock, timeoutH, htlcId}
 *   · claim  {issuer?, htlcId, preimage}
 *   · refund {issuer?, htlcId}
 *   issuer נאכף-לחשבונות-הרשת ([a-z0-9-], ברירת-מחדל operator — אותו-חוזה
 *   של-סוואפ/פקודות). ה-nonce אוטומטי (מונה-מונוטוני — SETTLE-9).
 */

type HtlcView = {
  id: string; from: string; to: string; asset: string; amount: number;
  hashlock: string; timeoutH: number; createdAtH: number;
  state: "locked" | "claimed" | "refunded";
  settledAtH?: number; preimage?: string;
};

export async function GET() {
  const st = getLiveState();
  const all = Object.entries(st.htlcs ?? {});
  const contracts: HtlcView[] = all
    .slice(-50)
    .reverse()
    .map(([id, r]) => ({
      id,
      from: r.from,
      to: r.to,
      asset: r.asset,
      amount: r.amount,
      hashlock: r.hashlock,
      timeoutH: r.timeoutH,
      createdAtH: r.createdAtH,
      state: r.state,
      settledAtH: r.settledAtH,
      // כנות: העד נחשף רק אחרי-תביעה — לפני-כן אין-לאף-אחד את-הסוד
      ...(r.state === "claimed" && r.preimage ? { preimage: r.preimage } : {}),
    }));
  const inv = htlcInvariant(st);
  return NextResponse.json({
    ok: true,
    height: st.height,
    total: all.length,
    byState: {
      locked: all.filter(([, r]) => r.state === "locked").length,
      claimed: all.filter(([, r]) => r.state === "claimed").length,
      refunded: all.filter(([, r]) => r.state === "refunded").length,
    },
    invariant: { ok: inv.ok, lockedTotal: inv.lockedTotal, activeTotal: inv.activeTotal, seams: inv.seams },
    maxTimeoutH: HTLC_MAX_TIMEOUT_H,
    contracts,
  });
}

export async function POST(req: Request) {
  // שער-מפעיל — מוטציה דורשת טוקן x-saos-operator (503 fail-closed בלעדיו)
  const oa = operatorAuth(req);
  if (oa) return oa;
  const g = consoleGuard(req);
  if (g) return g;

  const body = (await req.json().catch(() => ({}))) as {
    action?: string; issuer?: string; to?: string; asset?: string; amount?: number;
    hashlock?: string; timeoutH?: number; htlcId?: string; preimage?: string; nonce?: string;
  };
  const action = String(body.action ?? "");

  const agentRaw = typeof body.issuer === "string" ? body.issuer.trim().toLowerCase() : "";
  const issuer = /^[a-z0-9][a-z0-9_-]{0,31}$/.test(agentRaw) ? agentRaw : "operator";

  if (action === "create") {
    const amount = Math.floor(Number(body.amount));
    if (!body.to || !body.asset || !body.htlcId || !(amount > 0)
      || !body.hashlock || !(Number(body.timeoutH) > 0)) {
      return NextResponse.json({ ok: false, error: "bad-request" }, { status: 200 });
    }
    const r = submitOp({
      type: "htlc_create",
      issuer,
      nonce: nextNonce("hc"),
      to: body.to,
      asset: body.asset as never,
      amount,
      htlcId: body.htlcId,
      hashlock: body.hashlock,
      timeoutH: Math.floor(Number(body.timeoutH)),
    });
    return NextResponse.json({ ok: r.queued, error: r.reason, note: r.queued ? "queued — ייכלל בבלוק הבא" : undefined });
  }

  if (action === "claim") {
    if (!body.htlcId || !body.preimage) {
      return NextResponse.json({ ok: false, error: "bad-request" }, { status: 200 });
    }
    const r = submitOp({
      type: "htlc_claim",
      issuer,
      nonce: nextNonce("hm"),
      htlcId: body.htlcId,
      preimage: body.preimage,
    });
    return NextResponse.json({ ok: r.queued, error: r.reason, note: r.queued ? "queued — העד-ייחשף-על-השרשרת" : undefined });
  }

  if (action === "refund") {
    if (!body.htlcId) {
      return NextResponse.json({ ok: false, error: "bad-request" }, { status: 200 });
    }
    const r = submitOp({
      type: "htlc_refund",
      issuer,
      nonce: nextNonce("hr"),
      htlcId: body.htlcId,
    });
    return NextResponse.json({ ok: r.queued, error: r.reason, note: r.queued ? "queued — ההחזר ייכלל בבלוק הבא" : undefined });
  }

  return NextResponse.json({ ok: false, error: "unknown-action" }, { status: 200 });
}
