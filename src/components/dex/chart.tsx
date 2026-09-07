/**
 * chart.tsx — גרף-מחיר בסטנדרט-מוסדי: lightweight-charts (TradingView).
 * עדכון-setData בכל-תמונת-עולם — אפס-אנימציה, קריאות-צפופות, monospace-צירים.
 */
"use client";

import { useEffect, useRef } from "react";
import {
  AreaSeries,
  ColorType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";

const GOLD = "#f5b841";

export function PriceChart({ data, height = 208 }: { data: { t: number; p: number }[]; height?: number }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);

  // אתחול-חד-פעמי (שורד re-render; ניקוי מלא ב-unmount)
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const chart = createChart(box, {
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
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 2 },
      crosshair: {
        mode: 1, // Magnet — קריאה-מדויקת בלבד
        vertLine: { color: "#52525b", width: 1, style: 3, labelBackgroundColor: "#27272a" },
        horzLine: { color: "#52525b", width: 1, style: 3, labelBackgroundColor: "#27272a" },
      },
    });
    const series = chart.addSeries(AreaSeries, {
      lineColor: GOLD,
      topColor: "rgba(245, 184, 65, 0.28)",
      bottomColor: "rgba(245, 184, 65, 0.01)",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerBorderColor: GOLD,
      crosshairMarkerBackgroundColor: "#09090b",
    });
    chartRef.current = chart;
    seriesRef.current = series;
    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: box.clientWidth, height });
    });
    ro.observe(box);
    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [height]);

  // הזנה: dedupe לפי-שנייה (הספרייה דורשת זמנים-ייחודיים עולים)
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const bySecond = new Map<number, number>();
    for (const c of data) bySecond.set(Math.floor(c.t / 1000), c.p / 1000);
    const points = [...bySecond.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([time, value]) => ({ time: time as UTCTimestamp, value }));
    series.setData(points);
    chartRef.current?.timeScale().fitContent();
  }, [data]);

  return <div ref={boxRef} style={{ height }} className="w-full" dir="ltr" />;
}
