/**
 * chart.tsx — גרפים בסטנדרט-מוסדי (Task 83 · CEX-grade):
 *  · PriceChart — נרות-candlestick + היסטוגרמת-נפח (lightweight-charts v5,
 *    אותה-ספריית-TradingView שהמובילים משתמשים-בה) מנרות-OHLCV אמת של-המנוע.
 *  · DepthChart — גרף-עומק מצטבר (bids/asks) — סטנדרט-dYdX/Hyperliquid/Binance.
 * עדכון-setData בכל-תמונה — אפס-אנימציה · monospace-צירים · fitContent חכם-פעם-אחת.
 * UI Nuclear Override: data-testid + placeholder מוכר כשהספרייה נכשלת + console.error
 * על-כל-כשל-אתחול (אף-כשל שקט).
 */
"use client";

import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";

export interface KlineCandle { t: number; o: number; h: number; l: number; c: number; vMu: number }
const GOLD = "#f5b841";
const GREEN = "#22c55e";
const RED = "#ef4444";

export function PriceChart({ candles, height = 320, intervalLabel }: { candles: KlineCandle[]; height?: number; intervalLabel?: string }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const fittedRef = useRef(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    let disposed = false;
    let chart: IChartApi | null = null;
    let cs: ISeriesApi<"Candlestick"> | null = null;
    let vs: ISeriesApi<"Histogram"> | null = null;
    let ro: ResizeObserver | null = null;
    const raf = requestAnimationFrame(() => {
      if (disposed || !box) return;
      try {
        chart = createChart(box, {
          width: box.clientWidth,
          height,
          layout: {
            background: { type: ColorType.Solid, color: "transparent" },
            textColor: "#71717a",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 10,
            attributionLogo: false,
          },
          grid: {
            vertLines: { color: "rgba(63, 63, 70, 0.35)" },
            horzLines: { color: "rgba(63, 63, 70, 0.35)" },
          },
          rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.28 } },
          timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 2 },
          crosshair: {
            mode: 1, // Magnet — קריאה-מדויקת בלבד
            vertLine: { color: "#52525b", width: 1, style: 3, labelBackgroundColor: "#27272a" },
            horzLine: { color: "#52525b", width: 1, style: 3, labelBackgroundColor: "#27272a" },
          },
        });
      } catch (e) {
        console.error("[saos-dex][chart] lightweight-charts init failed:", e instanceof Error ? e.message : e);
        setFailed(true);
        return;
      }
      try {
        cs = chart.addSeries(CandlestickSeries, {
          upColor: GREEN, downColor: RED, borderVisible: false,
          wickUpColor: GREEN, wickDownColor: RED,
          priceLineVisible: false, lastValueVisible: true,
        });
        vs = chart.addSeries(HistogramSeries, {
          priceScaleId: "vol",
          priceFormat: { type: "volume" },
          priceLineVisible: false, lastValueVisible: false,
        });
        chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
      } catch (e) {
        console.error("[saos-dex][chart] series init failed:", e instanceof Error ? e.message : e);
        setFailed(true);
        return;
      }
      chartRef.current = chart;
      candleRef.current = cs;
      volRef.current = vs;
      ro = new ResizeObserver(() => {
        chart?.applyOptions({ width: box.clientWidth, height });
      });
      ro.observe(box);
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      chart?.remove();
      chartRef.current = null;
      candleRef.current = null;
      volRef.current = null;
      fittedRef.current = false;
    };
  }, [height]);

  // הזנה: נרות-עולים (השרת מוודא ייחודיות-זמן); fitContent רק-פעם-ראשונה פר-קומפוננטה
  useEffect(() => {
    const cs = candleRef.current;
    const vs = volRef.current;
    if (!cs || !vs) return;
    const seen = new Map<number, KlineCandle>();
    for (const c of candles) seen.set(Math.floor(c.t / 1000), c); // החדש-מנצח
    const sorted = [...seen.entries()].sort((a, b) => a[0] - b[0]);
    cs.setData(sorted.map(([time, c]) => ({
      time: time as UTCTimestamp,
      open: c.o / 1000, high: c.h / 1000, low: c.l / 1000, close: c.c / 1000,
    })));
    vs.setData(sorted.map(([time, c]) => ({
      time: time as UTCTimestamp,
      value: c.vMu,
      color: c.c >= c.o ? "rgba(34, 197, 94, 0.45)" : "rgba(239, 68, 68, 0.45)",
    })));
    if (!fittedRef.current && sorted.length > 0) {
      chartRef.current?.timeScale().fitContent();
      fittedRef.current = true;
    }
  }, [candles]);

  if (failed) {
    return (
      <div
        data-testid="lightweight-charts-container"
        data-chart-status="failed"
        className="flex w-full items-center justify-center rounded-lg border border-dashed border-red-500/40 bg-red-500/5"
        style={{ height }}
        dir="ltr"
      >
        <div className="text-center">
          <div className="font-mono text-sm font-black text-red-400">CHART FAILED TO RENDER</div>
          <div className="mt-1 text-[10px] text-zinc-500">lightweight-charts failed to initialize — see console for the error</div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div
        ref={boxRef}
        data-testid="lightweight-charts-container"
        data-chart-status={candles.length === 0 ? "waiting" : "live"}
        data-points={candles.length}
        style={{ height }}
        className="w-full"
        dir="ltr"
      />
      {candles.length === 0 && (
        <p className="py-2 text-center font-mono text-[11px] text-zinc-600">
          candles accumulate from live trades — הנרות נבנים-מסחר-אמת בלבד{intervalLabel ? ` (${intervalLabel})` : ""}
        </p>
      )}
    </div>
  );
}

/** DepthChart — גרף-עומק מצטבר ב-SVG טהור (אפס-תלות): ירוק=קניות מצטברות משמאל,
 * אדום=מכירות מצטברות מימין, הפער-במרכז=ה-spread. כנות: מהספר-החי (12-רמות). */
export function DepthChart({ market, height = 160 }: { market?: { bids: { price: number; total: number }[]; asks: { price: number; total: number }[] } | undefined; height?: number }) {
  const W = 100; // viewBox-נורמל (0..100)
  const H = 100;
  const bids = (market?.bids ?? []).slice(0, 12).map((b) => ({ px: b.price, sz: b.total })).sort((a, b) => a.px - b.px);
  const asks = (market?.asks ?? []).slice(0, 12).map((a) => ({ px: a.price, sz: a.total })).sort((a, b) => b.px - a.px);
  const cumBids: { px: number; cum: number }[] = [];
  let acc = 0;
  for (const b of bids) { acc += b.sz; cumBids.push({ px: b.px, cum: acc }); }
  const cumAsks: { px: number; cum: number }[] = [];
  acc = 0;
  for (const a of asks) { acc += a.sz; cumAsks.push({ px: a.px, cum: acc }); }
  const maxCum = Math.max(1, acc, cumBids.length ? cumBids[cumBids.length - 1].cum : 0);
  const pxMin = cumBids.length ? cumBids[0].px : 0;
  const pxMax = cumAsks.length ? cumAsks[0].px : 1;
  const span = Math.max(1, pxMax - pxMin);
  const xOf = (px: number): number => Math.max(0, Math.min(W, ((px - pxMin) / span) * W));
  const yOf = (cum: number): number => H - (cum / maxCum) * (H - 6) - 2;

  const bidPath = cumBids.length
    ? `M ${xOf(cumBids[0].px).toFixed(2)} ${H} ` + cumBids.map((p) => `L ${xOf(p.px).toFixed(2)} ${yOf(p.cum).toFixed(2)}`).join(" ") + ` L ${xOf(cumBids[cumBids.length - 1].px).toFixed(2)} ${H} Z`
    : "";
  const askPath = cumAsks.length
    ? `M ${xOf(cumAsks[0].px).toFixed(2)} ${H} ` + cumAsks.map((p) => `L ${xOf(p.px).toFixed(2)} ${yOf(p.cum).toFixed(2)}`).join(" ") + ` L ${xOf(cumAsks[cumAsks.length - 1].px).toFixed(2)} ${H} Z`
    : "";

  const totalBid = cumBids.length ? cumBids[cumBids.length - 1].cum : 0;
  const totalAsk = cumAsks.length ? cumAsks[cumAsks.length - 1].cum : 0;
  const imbBps = totalBid + totalAsk > 0 ? Math.floor(((totalBid - totalAsk) / (totalBid + totalAsk)) * 10_000) : 0;

  return (
    <div data-testid="depth-chart" data-imb-bps={imbBps}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height }} role="img" aria-label="Order book depth chart">
        {bidPath && <path d={bidPath} fill="rgba(34, 197, 94, 0.25)" stroke={GREEN} strokeWidth="0.6" />}
        {askPath && <path d={askPath} fill="rgba(239, 68, 68, 0.25)" stroke={RED} strokeWidth="0.6" />}
      </svg>
      <div className="mt-1.5 flex items-center justify-between font-mono text-[10px] text-zinc-500" dir="ltr">
        <span className="text-green-400">bid depth {fmtIntDepth(totalBid)}µ</span>
        <span className={imbBps > 0 ? "text-green-300" : "text-red-300"}>imbalance {imbBps > 0 ? "+" : ""}{(imbBps / 100).toFixed(2)}%</span>
        <span className="text-red-400">ask depth {fmtIntDepth(totalAsk)}µ</span>
      </div>
    </div>
  );
}

function fmtIntDepth(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.floor(n));
}
