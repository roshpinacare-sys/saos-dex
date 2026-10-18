import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

// סכמת אימות לפרמטרים של בקשת GET
const GetSwapSchema = z.object({
  fromToken: z.string().min(1, 'fromToken is required'),
  toToken: z.string().min(1, 'toToken is required'),
  amount: z.string().min(1, 'amount is required'),
  slippage: z.string().optional().default('1'),
  userAddress: z.string().min(1, 'userAddress is required'),
});

// סכמת אימות לפרמטרים של בקשת POST
const PostSwapSchema = z.object({
  fromToken: z.string().min(1, 'fromToken is required'),
  toToken: z.string().min(1, 'toToken is required'),
  amount: z.string().min(1, 'amount is required'),
  slippage: z.string().min(1, 'slippage is required'),
  userAddress: z.string().min(1, 'userAddress is required'),
  nonce: z.string().min(1, 'nonce is required'),
  signature: z.string().min(1, 'signature is required'),
});

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  
  try {
    // אימות פרמטרים של GET
    const validatedParams = GetSwapSchema.parse({
      fromToken: searchParams.get('fromToken'),
      toToken: searchParams.get('toToken'),
      amount: searchParams.get('amount'),
      slippage: searchParams.get('slippage'),
      userAddress: searchParams.get('userAddress'),
    });
    
    // אם האימות עבר בהצלחה, ממשיכים עם הלוגיקה של ה-API
    // כאן יש להוסיף את הלוגיקה הקיימת של ה-API
    
    return NextResponse.json({ 
      ok: true, 
      message: 'Swap quote retrieved successfully',
      data: validatedParams 
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { 
          ok: false, 
          error: 'Validation failed',
          details: error.errors.map(e => ({
            field: e.path.join('.'),
            message: e.message
          }))
        }, 
        { status: 400 }
      );
    }
    
    return NextResponse.json(
      { ok: false, error: 'Internal server error' }, 
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    // אימות פרמטרים של POST
    const validatedBody = PostSwapSchema.parse(body);
    
    // אם האימות עבר בהצלחה, ממשיכים עם הלוגיקה של ה-API
    // כאן יש להוסיף את הלוגיקה הקיימת של ה-API
    
    return NextResponse.json({ 
      ok: true, 
      message: 'Swap executed successfully',
      data: validatedBody 
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { 
          ok: false, 
          error: 'Validation failed',
          details: error.errors.map(e => ({
            field: e.path.join('.'),
            message: e.message
          }))
        }, 
        { status: 400 }
      );
    }
    
    return NextResponse.json(
      { ok: false, error: 'Internal server error' }, 
      { status: 500 }
    );
  }
}