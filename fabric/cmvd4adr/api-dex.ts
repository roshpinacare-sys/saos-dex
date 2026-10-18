import { NextRequest, NextResponse } from 'next/server';

// Original zero-dependency validation (SAOS) — replaces the phantom 'zod' import.
// zod was never declared in package.json; the fleet artery measured HEAD typecheck
// FAIL (TS18046 'error' is of type 'unknown' / TS7006 implicit-any callback at the
// old catch sites, receipts/fleet/saos-dex.json 2026-10-18T02:12Z). Behavior and
// response shapes preserved verbatim:
//   400 { ok:false, error:'Validation failed', details:[{field,message}] } on bad input
//   500 { ok:false, error:'Internal server error' } on unreadable body
// Fidelity note: the old GET slippage chain was z.string().optional().default('1'),
// but searchParams.get() returns null (not undefined), so the optional/default never
// fired — missing slippage was ALWAYS a 400. required:true preserves that behavior.
type Issue = { field: string; message: string };
type FieldSpec = { required: boolean; fallback?: string };

function pickStrings(
  src: Record<string, unknown>,
  spec: Record<string, FieldSpec>
): { data: Record<string, string>; issues: Issue[] } {
  const data: Record<string, string> = {};
  const issues: Issue[] = [];
  for (const [key, s] of Object.entries(spec)) {
    const raw = src[key];
    if (typeof raw === 'string' && raw.length > 0) data[key] = raw;
    else if (!s.required) data[key] = s.fallback ?? '';
    else issues.push({ field: key, message: `${key} is required` });
  }
  return { data, issues };
}

// סכמת אימות לפרמטרים של בקשת GET
const GET_SPEC: Record<string, FieldSpec> = {
  fromToken: { required: true },
  toToken: { required: true },
  amount: { required: true },
  slippage: { required: true },
  userAddress: { required: true },
};

// סכמת אימות לפרמטרים של בקשת POST
const POST_SPEC: Record<string, FieldSpec> = {
  fromToken: { required: true },
  toToken: { required: true },
  amount: { required: true },
  slippage: { required: true },
  userAddress: { required: true },
  nonce: { required: true },
  signature: { required: true },
};

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const src: Record<string, unknown> = {};
  for (const key of Object.keys(GET_SPEC)) src[key] = searchParams.get(key);
  const { data, issues } = pickStrings(src, GET_SPEC);
  if (issues.length > 0) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: issues },
      { status: 400 }
    );
  }

  // אם האימות עבר בהצלחה, ממשיכים עם הלוגיקה של ה-API
  // כאן יש להוסיף את הלוגיקה הקיימת של ה-API

  return NextResponse.json({
    ok: true,
    message: 'Swap quote retrieved successfully',
    data
  });
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
  const src: Record<string, unknown> =
    body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const { data, issues } = pickStrings(src, POST_SPEC);
  if (issues.length > 0) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: issues },
      { status: 400 }
    );
  }

  // אם האימות עבר בהצלחה, ממשיכים עם הלוגיקה של ה-API
  // כאן יש להוסיף את הלוגיקה הקיימת של ה-API

  return NextResponse.json({
    ok: true,
    message: 'Swap executed successfully',
    data
  });
}
