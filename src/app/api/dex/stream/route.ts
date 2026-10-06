import { chainVersion, getLiveState, getMarkets, getTape } from "@/lib/dex/chain";

export const dynamic = "force-dynamic";

/** Task 83 · GET /api/dex/stream — סטרימינג בזמן-אמת (Server-Sent Events).
 * המובילים (dYdX/Hyperliquid/Binance) מזרימים WS; אצלנו SSE — HTTP-ילידי,
 * עובר-דרך-גייטוויי בלי-התערבות, אוטו-ריקונקט של-EventSource-סטנדרטי.
 * מטען-קומפקטי כל-2ש׳: גובה · מחירי-השווקים + סטטיסטיקת-24ש' · 5-העסקאות-האחרונות.
 * כנות: ה-long-poll (state?v=) נשאר מקור-האמת-המלא לעמוד — הזרם הוא שכבת-דופק-חי. */
export async function GET(req: Request) {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          if (timer) { clearInterval(timer); timer = null; }
        }
      };
      // ראש-מיידי + הצהרת-retry לריקונקט-סטנדרטי
      try {
        controller.enqueue(encoder.encode("retry: 3000\n\n"));
      } catch { /* סגירה-מוקדמת */ }

      const push = () => {
        try {
          const markets = getMarkets().map((m) => ({
            key: m.key,
            fair: m.fair,
            bestBid: m.bestBid,
            bestAsk: m.bestAsk,
            chg24Bps: m.stats24.chg24Bps,
            vol24QuoteMu: m.stats24.vol24QuoteMu,
            high24: m.stats24.high24,
            low24: m.stats24.low24,
          }));
          const tape = getTape(5).map((e) => ({ base: e.base, quote: e.quote, price: e.price, amountMu: e.amountMu, at: e.at, h: e.h }));
          send("tick", {
            v: chainVersion(),
            h: getLiveState().height,
            ts: Date.now(),
            markets,
            tape,
          });
        } catch {
          // כנות: כשל-סנכרון — דילוג-פעימה, הזרם נשאר חי
        }
      };
      // הגובה-החי: קריאה-קלה מהגרעין (בלי-לחשב-שורש)
      push();
      timer = setInterval(push, 2000);

      // ניקוי-מסודר בניתוק-הלקוח
      req.signal.addEventListener("abort", () => {
        if (timer) { clearInterval(timer); timer = null; }
        try { controller.close(); } catch { /* כבר-סגור */ }
      });
    },
    cancel() {
      if (timer) { clearInterval(timer); timer = null; }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
