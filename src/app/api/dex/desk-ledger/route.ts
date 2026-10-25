import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { canon, sha256 } from "@/lib/dex/canonical";
import { operatorAuth } from "@/lib/operator-auth"; // §1 lockdown (directive 1a173c6ac120ccb1): identity moved to the operator gate

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// saos-dex /api/dex/desk-ledger (R350) — עוגן-הקבלות של הספר-הריבוני
// ============================================================================
// הגשר החוקי היחיד מחדר-הישיבות (saos-desk) אל הריבונות-הכלכלית — דוקטרינת
// exec34: ההון דרך ה-ledger שלנו, לא דרך ברוקר. הקונסולה של saos-desk שולחת
// לכל רשומה חתומה (SAOS-DEX-LEDGER/1: deposit · escrow_lock · settle · withdraw)
// והדקס מנעל אותה כקבלה:
//  • זהות (§1, directive 1a173c6ac120ccb1): operatorAuth — כותרת x-saos-operator
//    מול DEX_OPERATOR_TOKEN (timing-safe, fail-closed 503 בלי-טוקן). החתימה sig8
//    היא פונקציה-ציבורית (sha256(canon)) ולכן אינה אימות — היא חוק-שלמות-השרשרת
//    בלבד (idempotency + prevSig); מי-שלא מאומת — לא נועל כלום.
//  • אימות-עצמאי fail-closed: sig8(canon(payload-without-sig)) === sig
//  • סוג-מוכר בלבד, שלמים-בלבד בשדות-המדידה
//  • idempotency: sig כפול = 200 כנה (כבר ננעל)
//  • רציפות-prevSig מדווחת כנה (contiguous) ואינה וטו — הקונסולה שרשרת-האם
// אפס-מפתחות, אפס-ברוקר, אפס-המצאה: מה שלא חתום — לא ננעל.

const KINDS = ["deposit", "escrow_lock", "settle", "withdraw"];
const SCHEMA = "saos-dex/desk-entry@1";

function sig8(payload: unknown): string {
  return sha256(canon(payload)).slice(0, 8);
}

export async function POST(req: Request) {
  const oa = operatorAuth(req); // §1 — זהות-המפעיל קודם-לכל (החתימה sig8 אינה אימות)
  if (oa) return oa;
  let body: { record?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, message: "גוף-הבקשה אינו JSON תקין." }, { status: 400 });
  }
  const rec = body.record;
  if (!rec || typeof rec !== "object") {
    return NextResponse.json({ ok: false, message: "חסרה רשומה." }, { status: 400 });
  }
  const kind = String(rec.kind ?? "");
  if (!KINDS.includes(kind)) {
    return NextResponse.json({ ok: false, message: `סוג-רשומה זר: ${kind} — fail-closed.` }, { status: 400 });
  }
  if (rec.schema !== SCHEMA) {
    return NextResponse.json({ ok: false, message: `סכימה לא מוכרת: ${String(rec.schema)} — נדרש ${SCHEMA}.` }, { status: 400 });
  }
  const { sig, ...rest } = rec as { sig?: string } & Record<string, unknown>;
  if (typeof sig !== "string" || sig.length !== 8) {
    return NextResponse.json({ ok: false, message: "חתימה חסרה/פגומה — fail-closed." }, { status: 400 });
  }
  // שלמים-בלבד בשדות-המדידה (חוק-היחידות של הדקס)
  const intFields = ["seq", "equityBps", "sizeBps", "entryMu", "stopMu", "targetMu", "atrMu", "exitMu", "realizedBps", "barsHeld"] as const;
  for (const f of intFields) {
    const v = rest[f];
    if (v !== undefined && v !== null && !Number.isInteger(v)) {
      return NextResponse.json({ ok: false, message: `שדה ${f} אינו שלם — חוק-היחידות נפסל.` }, { status: 400 });
    }
  }
  let recomputed: string;
  try {
    recomputed = sig8(rest);
  } catch {
    return NextResponse.json({ ok: false, message: "payload אינו canonical (float/מחזורי/סוג-זר) — חוק-היחידות, fail-closed." }, { status: 400 });
  }
  if (recomputed !== sig) {
    return NextResponse.json({ ok: false, message: `חתימה לא מתאימה (${recomputed} ≠ ${sig}) — רשומה פגומה, לא ננעלה.` }, { status: 400 });
  }

  try {
    // idempotency לפי sig
    const existing = await db.deskLedgerReceipt.findUnique({ where: { sig } });
    if (existing) {
      return NextResponse.json({ ok: true, receipt: { sig: existing.sig, verified: existing.verified }, idempotent: true });
    }
    // רציפות-prevSig — דיווח כנה, לא וטו
    const last = await db.deskLedgerReceipt.findFirst({ orderBy: { seq: "desc" }, select: { sig: true } });
    const contiguous = (rest.prevSig ?? null) === (last?.sig ?? null);
    const created = await db.deskLedgerReceipt.create({
      data: {
        seq: Number.isInteger(rest.seq) ? (rest.seq as number) : -1,
        kind,
        symbol: typeof rest.symbol === "string" ? rest.symbol : null,
        positionId: typeof rest.positionId === "string" ? rest.positionId : null,
        payload: canon(rec),
        sig,
        prevSig: (rest.prevSig as string | null) ?? null,
        verified: true,
      },
    });
    return NextResponse.json({ ok: true, receipt: { sig: created.sig, verified: created.verified }, contiguous });
  } catch (e) {
    return NextResponse.json({ ok: false, message: `אגירת-קבלה נכשלה: ${String(e instanceof Error ? e.message : e)}` }, { status: 500 });
  }
}

export async function GET() {
  try {
    const rows = await db.deskLedgerReceipt.findMany({ orderBy: { seq: "asc" }, take: 500 });
    let contiguous = rows.length > 0;
    let prevSig: string | null = null;
    const reasons: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if ((r.prevSig ?? null) !== prevSig) { contiguous = false; reasons.push(`#${i}:PREVSIG`); }
      const parsed = JSON.parse(r.payload) as { sig?: string };
      const { sig, ...rest } = parsed;
      if (sig !== sig8(rest)) { contiguous = false; reasons.push(`#${i}:SIG`); }
      prevSig = r.sig;
    }
    return NextResponse.json({
      ok: true as const,
      count: rows.length,
      contiguous,
      reasons,
      receipts: rows.map((r) => ({ seq: r.seq, kind: r.kind, symbol: r.symbol, sig: r.sig, prevSig: r.prevSig, verified: r.verified, createdAt: r.createdAt.toISOString() })),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, message: `קריאת-קבלות נכשלה: ${String(e instanceof Error ? e.message : e)}` }, { status: 500 });
  }
}
