import { NextResponse } from "next/server";
import { getProofs } from "@/lib/dex/chain";
import { merkleRoot } from "@/lib/dex/canonical";

export const dynamic = "force-dynamic";

/**
 * verify-pack — משטח-הראיות הציבורי: עלים + שורש + חישוב-עצמאי מחדש.
 * כל אחד יכול לאמת בלי לסמוך עלינו (מורשת verify-pack של הפלטפורמה).
 */
export async function GET() {
  const proofs = getProofs();
  const rt = proofs.latest;
  if (!rt) {
    return NextResponse.json({ ok: true, empty: true, message: "אין-חותם עדיין — החותם הראשון בגובה 12" });
  }
  try {
    const rows = await (await import("@/lib/db")).db.blockHeader.findMany({
      where: { height: { gte: rt.fromHeight, lte: rt.toHeight } },
      orderBy: { height: "asc" },
      select: { height: true, hash: true },
    });
    const leaves = rows.map((r) => r.hash);
    const recomputed = merkleRoot(leaves);
    return NextResponse.json({
      ok: true,
      seal: rt,
      leaves,
      recomputedRoot: recomputed,
      verified: recomputed === rt.root,
      howToVerify: proofs.howToVerify,
      receipts: proofs.receipts,
    });
  } catch {
    return NextResponse.json({ ok: false, error: "db-unavailable (ראיות-DB כבויות — השרשרת ממשיכה)", seal: rt }, { status: 200 });
  }
}
