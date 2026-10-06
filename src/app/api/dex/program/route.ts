import { NextResponse } from "next/server";
import { submitOp, nextNonce, getLiveState } from "@/lib/dex/chain";
import { consoleGuard } from "@/lib/dex/guard";
import { operatorAuth } from "@/lib/operator-auth";

export const dynamic = "force-dynamic";

/** GET — רשימת-תוכניות-המסחר-האוטומטי החיות (ציבורי — שקיפות-מלאה).
 * DCA (Jupiter) + טריגרים stop/take (GMX חסר-קיפרים) — הבלוק-בילדר הוא ה-keeper. */
export async function GET() {
  const st = getLiveState();
  const h = st.height;
  const journal = (st.journal ?? [])
    .filter((e) => String(e.soldier) === "dca" || String(e.soldier) === "trig" || String(e.action).startsWith("dca") || String(e.action).startsWith("trig"))
    .slice(-20); // החדשות-ביותר (היומן append-only — הישנות-בראש)
  return NextResponse.json({
    ok: true,
    height: h,
    dca: Object.values(st.dca ?? {}).map((p) => ({
      ...p,
      nextSliceIn: p.lastH === 0 ? 0 : Math.max(0, p.everyK - (h - p.lastH)),
      progressPct: p.slicesMax > 0 ? Math.floor((p.done * 100) / p.slicesMax) : 0,
    })),
    trig: Object.values(st.trig ?? {}).map((t) => ({
      ...t,
      blocksLeft: t.expiresH > 0 ? Math.max(0, t.expiresH - h) : null,
    })),
    journal,
    note: "בונה-הבלוקים הוא ה-keeper — אפס-תשתית-חוץ, ריפליי-אמת",
  });
}

/** POST — מוטציות-מסחר-אוטומטי: dca_create · dca_cancel · trig_create · trig_cancel.
 * שערים: operatorAuth (טוקן-מפעיל) + consoleGuard (CSRF) — כמו-כל-מוטציה-במנוע. */
export async function POST(req: Request) {
  const oa = operatorAuth(req);
  if (oa) return oa;
  const g = consoleGuard(req);
  if (g) return g;

  const body = (await req.json().catch(() => ({}))) as {
    op?: string;
    // dca_create
    assetIn?: string; assetOut?: string;
    perSlice?: number; slicesMax?: number; everyK?: number; minOutBps?: number;
    // trig_create
    base?: string; quote?: string; side?: "buy" | "sell";
    triggerPx?: number; limitPx?: number; amount?: number; expiresH?: number; kind?: "stop" | "take";
    // cancel
    progId?: string;
  };

  const op = String(body.op ?? "");
  const num = (v: unknown): number => Math.floor(Number(v ?? 0));

  if (op === "dca_create") {
    const perSlice = num(body.perSlice), slicesMax = num(body.slicesMax), everyK = num(body.everyK);
    if (!body.assetIn || !body.assetOut || !(perSlice > 0) || !(slicesMax >= 1) || !(everyK >= 1))
      return NextResponse.json({ ok: false, error: "bad-request", note: "נדרש: assetIn, assetOut, perSlice, slicesMax, everyK" }, { status: 200 });
    const r = submitOp({
      type: "dca_create", issuer: "operator", nonce: nextNonce("dca"),
      asset: body.assetIn as never, to: body.assetOut,
      perSlice, slicesMax, everyK,
      minOutBps: body.minOutBps === undefined ? 100 : num(body.minOutBps),
    });
    return NextResponse.json({ ok: r.queued, error: r.reason, note: r.queued ? "תוכנית-DCA נקלטה — תיכנס לבלוק הבא" : undefined });
  }
  if (op === "dca_cancel") {
    if (!body.progId) return NextResponse.json({ ok: false, error: "bad-request" }, { status: 200 });
    const r = submitOp({ type: "dca_cancel", issuer: "operator", nonce: nextNonce("dcax"), progId: body.progId });
    return NextResponse.json({ ok: r.queued, error: r.reason });
  }
  if (op === "trig_create") {
    const triggerPx = num(body.triggerPx), amount = num(body.amount);
    if (!body.base || !body.quote || (body.side !== "buy" && body.side !== "sell") || !(triggerPx > 0) || !(amount > 0))
      return NextResponse.json({ ok: false, error: "bad-request", note: "נדרש: base, quote, side, triggerPx, amount" }, { status: 200 });
    const r = submitOp({
      type: "trig_order", issuer: "operator", nonce: nextNonce("trg"),
      base: body.base as never, quote: body.quote as never, side: body.side,
      triggerPx, limitPx: body.limitPx === undefined ? 0 : num(body.limitPx),
      amount, expiresH: body.expiresH === undefined ? 0 : num(body.expiresH),
      // Task 83 · כיוון-חצייה: take = הפוך-מהצד (sell→up · buy→down); stop = ברירת-מחדל
      trigDir: body.kind === "take" ? (body.side === "sell" ? "up" : "down") : undefined,
    });
    return NextResponse.json({ ok: r.queued, error: r.reason, note: r.queued ? "טריגר הוצב — ייסרק כל-בלוק מול המחיר הקנוני" : undefined });
  }
  if (op === "oco_place") {
    // Task 83 · OCO — שני-טריגרים מקושרים (stop-loss + take-profit) בפקודה-אחת;
    // נורה/ביטול-אחת מבטלת-את-האחות. סמנטיקה: sell → stop < take; buy → take < stop.
    const triggerPx = num(body.triggerPx), limitPx = num(body.limitPx), amount = num(body.amount);
    if (!body.base || !body.quote || (body.side !== "buy" && body.side !== "sell") || !(triggerPx > 0) || !(limitPx > 0) || !(amount > 0))
      return NextResponse.json({ ok: false, error: "bad-request", note: "נדרש: base, quote, side, triggerPx (stop), limitPx (take), amount" }, { status: 200 });
    if (body.side === "sell" ? triggerPx >= limitPx : limitPx >= triggerPx)
      return NextResponse.json({ ok: false, error: "bad-oco-direction", note: body.side === "sell" ? "sell: חייב stop < take" : "buy: חייב take < stop" }, { status: 200 });
    const r = submitOp({
      type: "oco_place", issuer: "operator", nonce: nextNonce("oco"),
      base: body.base as never, quote: body.quote as never, side: body.side,
      triggerPx, limitPx, amount,
      expiresH: body.expiresH === undefined ? 0 : num(body.expiresH),
    });
    return NextResponse.json({ ok: r.queued, error: r.reason, note: r.queued ? "OCO הוצב (stop+take מקושרים) — ייסרק כל-בלוק" : undefined });
  }
  if (op === "trig_cancel") {
    if (!body.progId) return NextResponse.json({ ok: false, error: "bad-request" }, { status: 200 });
    const r = submitOp({ type: "trig_cancel", issuer: "operator", nonce: nextNonce("trgx"), progId: body.progId });
    return NextResponse.json({ ok: r.queued, error: r.reason });
  }
  return NextResponse.json({ ok: false, error: "unknown-op", note: "פעולות: dca_create · dca_cancel · trig_create · oco_place · trig_cancel" }, { status: 200 });
}
