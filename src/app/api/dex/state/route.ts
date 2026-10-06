import { NextResponse } from "next/server";
import { ensureChain, chainVersion, getState, getMarkets, getPools, getWallets, getArena, getProofs, getTape } from "@/lib/dex/chain";
import "@/lib/dex/preview-bridge"; // גשר-התצוגה של הסנדבוקס (side-effect, fail-closed)

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const WAIT_MAX_MS = 12_000;   // חלון-long-poll — הלקוח מיד מנפיש בקשה-חדשה
const WAIT_STEP_MS = 250;

/**
 * GET /api/dex/state?v=<version> — מצב-עולם מלא.
 * בלי v: תשובה מידית. עם v: long-poll מבוסס-אירוע — מחזיר רק כשהשרשרת התקדמה
 * מעבר לגרסה-המבוקשת (או keepalive כל-12ש׳). אפס-השהיה מלאכותית בצד-הלקוח.
 */
export async function GET(req: Request) {
  const rt = ensureChain();
  const since = Number(new URL(req.url).searchParams.get("v") || 0);
  // FIX(3-a · D2): שרשרת-מושהית (rt.halted — fail-fast, הגרסה-קפואה) לא נכנסת
  // ל-long-poll: הלולאה הייתה ישנה 12ש׳ מלאים על מצב-שלא-יזוז לעולם. תשובה-מידית
  // (200, state.halted=true+haltReason — שדות-קיימים ב-getState) — הלקוח מציג-
  // באנר ומאט-קצב (page.tsx D4), בלי-סקר-חם על-שוק-קפוא.
  if (!(rt.halted === true) && Number.isFinite(since) && since > 0) {
    const deadline = Date.now() + WAIT_MAX_MS;
    while (chainVersion() === since && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, WAIT_STEP_MS));
    }
  }
  const proofs = getProofs();
  return NextResponse.json({
    ok: true,
    version: chainVersion(),
    state: getState(),
    markets: getMarkets(),
    pools: getPools(),
    wallets: getWallets(),
    arena: getArena(),
    proofs: { seals: proofs.seals, receipts: proofs.receipts, blockWindow: proofs.blockWindow },
    tape: getTape(30),
    tick: rt.tickCount,
  });
}
