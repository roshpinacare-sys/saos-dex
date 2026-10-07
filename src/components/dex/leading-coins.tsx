"use client";

/**
 * leading-coins.tsx — EXEC-CD-13 · LEADING-COINS · העמוד-הראשי-החי
 * ═════════════════════════════════════════════════════════════════
 * רצועת-המטבעות-המובילים בראש-העמוד + סוואפ-חוצה-נכסים/רשתות.
 * · מחירים: אמת-בלבד (זרם-הרשתות · פידי-חוץ-חציוני · אורקל-קנוני) — אפס-דקורציה.
 * · סוואפ: GET /api/dex/route (ציטוט-מסלול-אמת על הבריכות-החיות) →
 *   POST /api/dex/route (batch-אטומי, מפעיל-מאומת, minOut fail-closed).
 * · אין-בריכה → כנות-גלויה + זהות-הפקדה של הרשת (הדרך-היחידה-שהאמת-מאפשרת
 *   לחבר עוגן-חדש: פקדה-אמת → הטבעה-מגובה → בריכה-במחיר-אורקל).
 * "החלפה-בין-רשתות" = סוואפ עוגן↔עוגן (WETH↔WTRX) — ערך עובר בין רשתות-אמת
 * בתוך-הספר-הריבוני, בלי-גשרים-עוינים ובלי-מפתחות-שלישיים.
 */

import { useCallback, useEffect, useState } from "react";
import { ArrowLeftRight, Coins, Copy, RefreshCcw } from "lucide-react";
import { dexApi, isStaticMirror } from "@/lib/dex/api-url";
import { GoldButton, Panel, Pill, StatusDot, fmt, fmtInt } from "@/components/dex/kit";

interface LeadingCoin {
  key: string; sym: string; name: string; network: string;
  priceUsd: number | null; src: string | null;
  netLive: boolean | null; blockAgeSec: number | null; latencyMs: number | null;
  wrapAsset: string | null; wrapTier: string | null;
  backingMu: number | null; oracleMu: number | null;
  pegVerdict: string | null; poolKey: string | null; spreadBps: number | null;
}
interface LeadingAsset { id: string; tier: string; balanceMu: number; oracleMu: number | null }
interface RouteLeg { from: string; to: string; inMu: number; outMu: number; priceMu: number; venue: string }
interface QuoteView {
  assetIn: string; assetOut: string; amountInMu: number; amountOutMu: number;
  effPriceMu: number; legs: RouteLeg[]; alternatives: { amountOutMu: number; path: string[] }[];
}
interface LeadingData {
  ok: true; at: string; priceAgeSec: number | null; feedTtlSec: number | null; coins: LeadingCoin[]; assets: LeadingAsset[];
  networks: { connected: number; total: number; priceStale: boolean } | null;
  identities: { tron: string | null; sol: string | null; evm: string | null; note: string } | null;
  honesty: string;
}

const ASSET_LABEL: Record<string, string> = {
  SAOS: "SAOS · ריבוני", USDS: "USDS · דולר-ריבוני", WSTEEM: "WSTEEM (STEEM)",
  WTRX: "WTRX (TRON)", WSOL: "WSOL (Solana)", WETH: "WETH (Ethereum)",
  WBNB: "WBNB (BNB Chain)", WBASE: "WBASE (Base)", WBLURT: "WBLURT (Blurt)",
  PHIVE: "PHIVE (Hive)", STEEM: "STEEM טבעי", SBD: "SBD", WSBD: "WSBD",
  BLURT: "BLURT טבעי", ENERGY: "ENERGY",
};
/* עוגן → זהות-הפקדה של רשת-האם (מהדלת) */
const ANCHOR_NET: Record<string, "tron" | "sol" | "evm"> = {
  WTRX: "tron", WSOL: "sol", WETH: "evm", WBNB: "evm", WBASE: "evm",
};
const TIER_LABEL: Record<string, string> = {
  hub: "HUB", deep: "נזילות-עמוקה", micro: "מיקרו", rail: "מסדרון-עיגון", none: "אין-בריכה",
};

const fmtUsd = (v: number | null): string => {
  if (v === null || !Number.isFinite(v)) return "—";
  if (v >= 1000) return `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toPrecision(3)}`;
};

export function LeadingCoinsPanel({ post, flash, onNeedOperator }: {
  post: (url: string, body?: unknown) => Promise<{ ok: boolean; error?: string; note?: string; reason?: string } | undefined>;
  flash: (tone: "ok" | "err", text: string) => void;
  onNeedOperator: () => void;
}) {
  const [data, setData] = useState<LeadingData | null>(null);
  const [assetIn, setAssetIn] = useState("USDS");
  const [assetOut, setAssetOut] = useState("WSTEEM");
  const [amountUnits, setAmountUnits] = useState("1000");
  const [quote, setQuote] = useState<QuoteView | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [executing, setExecuting] = useState(false);

  const load = useCallback(() => {
    fetch(dexApi("/api/dex/leading"), { cache: "no-store" })
      .then((r) => r.json()).then((j) => { if (j?.ok) setData(j as LeadingData); })
      .catch(() => { /* כנות: הנתונים-הקודמים נשארים על-המסך */ });
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [load]);

  const amountMu = Math.floor(Number(amountUnits) * 1000);
  const amountValid = Number.isFinite(amountMu) && amountMu > 0;

  const loadQuote = useCallback(async () => {
    if (!amountValid) { setQuote(null); return; }
    setQuoting(true);
    try {
      const r = await fetch(dexApi(`/api/dex/route?assetIn=${encodeURIComponent(assetIn)}&assetOut=${encodeURIComponent(assetOut)}&amount=${amountMu}`), { cache: "no-store" });
      const j = (await r.json()) as { ok: boolean; quote: QuoteView | null };
      setQuote(j?.ok ? j.quote : null);
    } catch { setQuote(null); /* כנות: אין-ציטוט */ }
    finally { setQuoting(false); }
  }, [assetIn, assetOut, amountMu, amountValid]);

  /* ציטוט-אוטומטי תמידי (זוג+כמות, השהיה-400ms) — הציטוט-על-המסך חייב-להיות
   * תמיד-בדיוק-הכמות-שבקלט, אחרת-ביצוע-על-כמות-שונה-מהראוי (תיקון-EXEC-CD-13). */
  useEffect(() => {
    if (!amountValid) { setQuote(null); return; }
    const t = setTimeout(() => { void loadQuote(); }, 400);
    return () => clearTimeout(t);
  }, [assetIn, assetOut, amountMu, amountValid]); // loadQuote-יציב-מבחינת-תלויות-אלה

  const flip = () => { setAssetIn(assetOut); setAssetOut(assetIn); };

  const execute = async () => {
    if (!quote || executing) return;
    const minOut = Math.max(0, Math.floor(quote.amountOutMu * 0.99)); // סטייה-מרבית 1%
    setExecuting(true);
    const j = await post(dexApi("/api/dex/route"), { assetIn, assetOut, amount: quote.amountInMu, minOut });
    setExecuting(false);
    if (j?.ok) { void loadQuote(); void load(); }
  };

  const selectCoin = (c: LeadingCoin) => {
    if (!c.wrapAsset) { flash("err", `${c.sym}: אין-עוגן-רשום בספר — מחיר-שוק בלבד`); return; }
    setAssetOut(c.wrapAsset);
    setAssetIn("USDS");
  };

  const outAsset = data?.assets.find((a) => a.id === assetOut);
  const inAsset = data?.assets.find((a) => a.id === assetIn);
  const anchorNet = ANCHOR_NET[assetOut] ?? ANCHOR_NET[assetIn];
  const identity = anchorNet && data?.identities ? data.identities[anchorNet] : null;

  const copyIdentity = () => {
    if (!identity) return;
    void navigator.clipboard?.writeText(identity)
      .then(() => flash("ok", "זהות-הפקדה הועתקה — שלח מטבע-אמת אליה והדבק txid בדלת"))
      .catch(() => flash("err", "העתקה נכשלה — העתק ידנית"));
  };

  return (
    <Panel
      title="LEADING COINS · מטבעות-מובילים-חיים"
      icon={<Coins className="h-4 w-4 text-amber-400" aria-hidden />}
      className="mt-4"
      action={
        <div className="flex items-center gap-2">
          {data?.networks && (
            <Pill tone={data.networks.connected === data.networks.total ? "green" : "amber"} testid="leading-networks-pill">
              {data.networks.connected}/{data.networks.total} רשתות-חיות
            </Pill>
          )}
          {/* EXEC-CD-13-AV: כנות-קצב — מחירי-עזר-חציוניים-עם-TTL-5דק' (לא-tick-חי);
           * גיל-הפיד-האמיתי מוצג, ומעל-90ש׳ נצבע-אמבר. */
          }
          <Pill
            tone={(data?.priceAgeSec ?? 999) > 90 ? "amber" : "green"}
            testid="leading-feed-age"
          >
            מחירי-עזר · גיל {data?.priceAgeSec != null ? `${data.priceAgeSec}ש׳` : "…"} (ריענון-עד-{Math.round((data?.feedTtlSec ?? 300) / 60)}דק׳)
          </Pill>
        </div>
      }
    >
      {/* ── רצועת-המטבעות (8 אמת) ─────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8" data-testid="leading-coins-grid">
        {(data?.coins ?? []).map((c) => {
          const selected = c.wrapAsset === assetOut || c.wrapAsset === assetIn;
          const dot = c.netLive === true ? "green" : c.netLive === false ? "red" : "amber";
          return (
            <button
              key={c.key} type="button" onClick={() => selectCoin(c)}
              title={c.wrapAsset ? `${c.wrapAsset} · ${TIER_LABEL[c.wrapTier ?? "none"]}${c.pegVerdict ? ` · ${c.pegVerdict}` : ""}` : `${c.sym} — מחיר-שוק בלבד (אין-עוגן-רשום)`}
              className={`rounded-lg border p-2.5 text-right transition-colors ${
                selected ? "border-amber-500/60 bg-amber-500/[0.06]" : "border-zinc-800 bg-zinc-900/70 hover:border-zinc-600"
              }`}
              data-testid={`leading-coin-${c.key}`}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="flex items-center gap-1.5 font-mono text-xs font-black text-zinc-100">
                  <StatusDot tone={dot} pulse={c.netLive === true} /> {c.sym}
                </span>
                <span className="truncate text-[9px] text-zinc-500">{c.network}</span>
              </div>
              <div className="mt-1 font-mono text-sm font-bold text-zinc-50" data-testid={`leading-price-${c.key}`}>
                {fmtUsd(c.priceUsd)}
              </div>
              <div className="mt-0.5 truncate text-[9px] text-zinc-500">
                {c.wrapAsset
                  ? `${c.wrapAsset} · ${TIER_LABEL[c.wrapTier ?? "none"]}`
                  : "מחיר-שוק · אין-עוגן-רשום"}
              </div>
            </button>
          );
        })}
      </div>
      {!data && <p className="mt-3 text-[11px] text-zinc-500">מתחבר לזרם-המחירים-האמיתי…</p>}

      {/* ── סוואפ-חוצה-נכסים/רשתות ────────────────────────────────────── */}
      <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3" data-testid="leading-swap-box">
        <div className="grid items-end gap-2 md:grid-cols-[1fr_auto_1fr]">
          <label className="block text-[10px] font-semibold text-zinc-500">
            מ־
            <select
              value={assetIn} onChange={(e) => setAssetIn(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-2 font-mono text-xs font-bold text-zinc-100"
              data-testid="leading-swap-in"
            >
              {(data?.assets ?? [{ id: assetIn, tier: "none", balanceMu: 0, oracleMu: null }]).map((a) => (
                <option key={a.id} value={a.id}>{ASSET_LABEL[a.id] ?? a.id} — {TIER_LABEL[a.tier] ?? a.tier}</option>
              ))}
            </select>
            <span className="mt-1 block font-mono text-[10px] text-zinc-500">
              יתרה: {fmtInt(inAsset?.balanceMu ?? 0)}µ {assetIn === "USDS" ? "" : inAsset && inAsset.oracleMu != null ? `· אורקל ${fmtUsd(inAsset.oracleMu / 1e6)}` : ""}
            </span>
          </label>
          <GoldButton tone="ghost" onClick={flip} className="h-9 px-3" testid="leading-swap-flip" aria-label="החלפה-כיוון">
            <ArrowLeftRight className="h-4 w-4" aria-hidden />
          </GoldButton>
          <label className="block text-[10px] font-semibold text-zinc-500">
            ל־
            <select
              value={assetOut} onChange={(e) => setAssetOut(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-2 font-mono text-xs font-bold text-zinc-100"
              data-testid="leading-swap-out"
            >
              {(data?.assets ?? [{ id: assetOut, tier: "none", balanceMu: 0, oracleMu: null }]).map((a) => (
                <option key={a.id} value={a.id}>{ASSET_LABEL[a.id] ?? a.id} — {TIER_LABEL[a.tier] ?? a.tier}</option>
              ))}
            </select>
            <span className="mt-1 block font-mono text-[10px] text-zinc-500">
              יתרה: {fmtInt(outAsset?.balanceMu ?? 0)}µ {outAsset && outAsset.oracleMu != null ? `· אורקל ${fmtUsd(outAsset.oracleMu / 1e6)}` : ""}
            </span>
          </label>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            type="text" inputMode="decimal" dir="ltr" value={amountUnits}
            onChange={(e) => setAmountUnits(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="כמות (יחידות · ×1000=µ)"
            className="w-44 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-2 font-mono text-xs text-zinc-100"
            data-testid="leading-swap-amount"
          />
          <GoldButton tone="ghost" onClick={() => void loadQuote()} disabled={!amountValid || quoting} testid="leading-quote-btn">
            <RefreshCcw className="h-3.5 w-3.5" aria-hidden /> ציטוט-חי
          </GoldButton>
          {!isStaticMirror && (
            <GoldButton tone="gold" onClick={() => void execute()} disabled={!quote || executing} testid="leading-swap-execute">
              {executing ? "מבצע…" : "סוואפ-אטומי"}
            </GoldButton>
          )}
        </div>

        {/* תוצאת-הציטוט — כנה: מסלול-רגליים + מחיר-אפקטיבי + minOut */}
        {quote && (
          <div className="mt-3 rounded-md border border-green-500/25 bg-green-500/[0.04] p-2.5" data-testid="leading-quote-view">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-sm font-bold text-green-300">
                {fmtInt(quote.amountOutMu)}µ {assetOut}
                <span className="mr-2 text-[10px] font-normal text-zinc-400">(≈ {fmt(quote.amountOutMu)} {assetOut})</span>
              </span>
              <span className="font-mono text-[10px] text-zinc-400">
                מחיר-אפקטיבי: {fmtInt(quote.effPriceMu)}µ-{assetOut}-ליחידת-{assetIn} · minOut {fmtInt(Math.floor(quote.amountOutMu * 0.99))}µ (סטייה-מרבית 1%)
              </span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              {quote.legs.map((l, i) => (
                <span key={i} className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 font-mono text-[9px] text-zinc-400">
                  {l.venue}: {l.from}→{l.to} ({fmtInt(l.outMu)}µ)
                </span>
              ))}
            </div>
          </div>
        )}

        {/* אין-מסלול — כנות + דלת-הפקדה */}
        {!quote && !quoting && amountValid && data && (
          <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/[0.05] p-2.5" data-testid="leading-no-route">
            <p className="text-[11px] font-bold text-amber-300">
              אין-מסלול-חי לזוג {assetIn}→{assetOut} — כנות: סוואפ מבוצע על בריכות-חיות בלבד, אין-ציטוט-שווא.
            </p>
            <p className="mt-1 text-[10px] leading-snug text-zinc-400">
              עוגן-רשת חדש מתחבר רק-באמת: הפקד מטבע-אמת אל זהות-הפקדה → אימות-RPC-ציבורי → הטבעה-מגובה-1:1 → בריכה-נפתחת במחיר-אורקל.
            </p>
            {identity && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <code dir="ltr" className="max-w-full truncate rounded border border-zinc-800 bg-zinc-900 px-2 py-1 font-mono text-[10px] text-zinc-300">
                  {anchorNet === "tron" ? "TRON" : anchorNet === "sol" ? "Solana" : "EVM (eth/base/bsc)"}: {identity}
                </code>
                <GoldButton tone="ghost" onClick={copyIdentity} className="px-2 py-1 text-[10px]">
                  <Copy className="h-3 w-3" aria-hidden /> העתק-זהות
                </GoldButton>
                <span className="text-[9px] text-zinc-500">txid נשלח דרך דלת-הפקדות למטה · הטבעה חד-פעמית-מגובה</span>
              </div>
            )}
            {!identity && (
              <button type="button" onClick={onNeedOperator} className="mt-1 text-[10px] text-amber-300 underline-offset-2 hover:underline">
                דרוש-אימות-מפעיל לפעולות-מוטציה →
              </button>
            )}
          </div>
        )}

        <p className="mt-2 text-[9px] leading-snug text-zinc-600">
          הכל-או-כלום: batch-אטומי עם minOut fail-closed לכל-רגל · אין-נכס-תלוש-באמצע-שרשרת ·
          {isStaticMirror ? " מראה-ציבורי: קריאה-בלבד." : " מחובר-באמת: הבריכות-החיות כאן-עכשיו."}
        </p>
      </div>
    </Panel>
  );
}
