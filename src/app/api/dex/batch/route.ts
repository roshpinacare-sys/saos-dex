import { NextResponse } from "next/server";
import { nextNonce, submitOp } from "@/lib/dex/chain";
import { BATCH_MAX_OPS, type Op } from "@/lib/dex/kernel";
import { consoleGuard } from "@/lib/dex/guard";
import { operatorAuth } from "@/lib/operator-auth";

export const dynamic = "force-dynamic";

/* ══ דבר-גורר-דבר (SETTLE-12) — ביצוע-אטומי-קבוצתי על הגרעין ═══════════════
 * POST /api/dex/batch {issuer?, ops: [op, ...]} → op batch (הכל-או-כלום).
 * שימוש-הדגמה: המרה-דו-קפיצתית (WSTEEM→SAOS→USDS) — אם-קפיצה-2 נכשלת במגן
 * ה-minOut, קפיצה-1 מבוטלת-אף-היא. אין-ביצוע-חלקי. תתי-ops מקבלים nonces
 * מיוצרים-כאן וחייבים-אותו-issuer (הזהות-נאכפת-בגרעין). עומק-1 (אין-מקוננים). */

const ISSUERS = new Set(["operator", "treasury", "arena", "portfolio-b"]);

export async function POST(req: Request) {
  const oa = operatorAuth(req);
  if (oa) return oa;
  const g = consoleGuard(req);
  if (g) return g;

  const body = (await req.json().catch(() => ({}))) as { issuer?: string; ops?: Partial<Op>[] };
  const issuer = String(body.issuer || "operator").toLowerCase();
  if (!ISSUERS.has(issuer)) {
    return NextResponse.json({ ok: false, error: `bad-issuer (מותר: ${[...ISSUERS].join("|")})` }, { status: 200 });
  }
  const sub = Array.isArray(body.ops) ? body.ops : [];
  if (sub.length === 0 || sub.length > BATCH_MAX_OPS) {
    return NextResponse.json({ ok: false, error: `bad-ops (1..${BATCH_MAX_OPS})` }, { status: 200 });
  }
  if (sub.some((s) => !s || typeof s.type !== "string" || s.type === "batch")) {
    return NextResponse.json({ ok: false, error: "bad-sub-op (type חובה, אין-קינון-batch)" }, { status: 200 });
  }
  const ops: Op[] = sub.map((s, i) => ({
    ...s,
    issuer,
    nonce: nextNonce(`bt${i}`),
  })) as Op[];
  const r = submitOp({ type: "batch", issuer, nonce: nextNonce("ba"), ops });
  if (!r.queued) return NextResponse.json({ ok: false, error: r.reason ?? "queue-rejected" }, { status: 200 });
  return NextResponse.json({ ok: true, atomic: true, count: ops.length, note: `${ops.length} ops בעטיפה-אטומית אחת (הכל-או-כלום) — ייכלל בבלוק הבא` });
}
