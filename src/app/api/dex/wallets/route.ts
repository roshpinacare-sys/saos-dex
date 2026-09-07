import { NextResponse } from "next/server";
import { getWallets } from "@/lib/dex/chain";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ok: true, wallets: getWallets() });
}
