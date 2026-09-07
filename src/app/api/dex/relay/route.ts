import { NextResponse } from "next/server";
import { relayStatus } from "@/lib/dex/relay";

export const dynamic = "force-dynamic";

/** GET /api/dex/relay — מצב-ציבורי של מודול-העיגון (אפס סודות). */
export async function GET() {
  try {
    return NextResponse.json({ ok: true, relay: relayStatus() });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
