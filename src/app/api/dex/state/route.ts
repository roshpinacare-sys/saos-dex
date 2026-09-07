import { NextResponse } from "next/server";
import { ensureChain, getState, getMarkets, getPools, getWallets, getArena, getProofs, getTape } from "@/lib/dex/chain";

export const dynamic = "force-dynamic";

/** מצב-עולם מלא לקונסולה (poll אחת ל-2 שנ׳) */
export async function GET() {
  const rt = ensureChain();
  const proofs = getProofs();
  return NextResponse.json({
    ok: true,
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
