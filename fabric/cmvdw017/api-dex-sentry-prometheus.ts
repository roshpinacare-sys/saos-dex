import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { detectAndLogAnomaly } from '@/lib/anomalyDetection';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    // זיהוי חריגות לפני עיבוד
    await detectAndLogAnomaly(request, 'agent', body);
    
    // הלוגיקה העסקית הקיימת (לא משונה)
    const agent = await prisma.agent.create({
      data: {
        name: body.name,
        type: body.type,
        config: body.config,
      },
    });
    
    return NextResponse.json({ ok: true, agent });
  } catch (error) {
    // שגיאות עיבוד מטופלות על ידי detectAndLogAnomaly במקרים מסוימים
    return NextResponse.json({ ok: false, error: 'Internal server error' }, { status: 500 });
  }
}

// שמירת שיטות HTTP אחרות ללא שינוי
 export async function GET() {
   return NextResponse.json({ ok: false, error: 'Method not allowed' }, { status: 405 });
 }
 export async function PUT() {
   return NextResponse.json({ ok: false, error: 'Method not allowed' }, { status: 405 });
 }
 export async function DELETE() {
   return NextResponse.json({ ok: false, error: 'Method not allowed' }, { status: 405 });
 }