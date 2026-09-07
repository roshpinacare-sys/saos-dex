import { NextResponse } from "next/server";
import { operatorFaucet } from "@/lib/dex/chain";

export const dynamic = "force-dynamic";

/** ברז-דמו (כנות): העברה-פרוטוקולית מהאוצר ל-operator — פעם ב-60 שנ׳ */
export async function POST() {
  const r = operatorFaucet();
  return NextResponse.json(r);
}
