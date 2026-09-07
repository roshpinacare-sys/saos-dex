"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, Anchor, BarChart3, Bot, Coins, Droplets, FlaskConical,
  GitBranch, Landmark, RefreshCcw, ShieldCheck, Wallet, Zap, Layers,
} from "lucide-react";
import { AreaChart, Area, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from "recharts";
import { GoldButton, Panel, Pill, Stat, fmt, fmtInt, shortHash } from "@/components/dex/kit";

// ─── טיפוסים (מראה-API) ─────────────────────────────────────────────────────
interface MarketView {
  base: string; quote: string; key: string;
  fair: number; bestBid: number; bestAsk: number; spreadBps: number;
  poolMid: number; refPrice: number;
  bids: { price: number; total: number; orders: number }[];
  asks: { price: number; total: number; orders: number }[];
  chart: { t: number; p: number }[];
}
interface PoolView { key: string; a: string; b: string; ra: number; rb: number; lp: number; mid: number; swaps: number; feeAccruedTreasury: number; k: number }
interface WalletView { name: string; credits: number; balances: Record<string, number>; locked: Record<string, number> }
interface SoldierView { name: string; saos: number; usds: number; equity: number; pnl: number; liveQuotes: number; locked: Record<string, number> }
interface TapeEv { kind: string; base: string; quote: string; price: number; amountMu: number; taker: string; maker?: string; at: number; h: number }
interface SealInfo { fromHeight: number; toHeight: number; root: string; stateRoot: string; leaves: number; at: number; digest: string }
interface StateView {
  height: number; stateRoot: string; gasUsed: number; opsTotal: number; fills: number; swaps: number;
  ladders: number; treasuryProfit: number; feeMeter: number;
  ladder: { refPrice: number; lifts: number; lastLiftHeight: number; spentMu: number; stepCostMu: number };
  liveOrders: number; buildMs: number; uptimeSec: number; lastBlockAgoMs: number | null;
  dbOk: boolean; tickMs: number; sealEvery: number; nextSealIn: number;
  backing: Record<string, number>; assets: Record<string, { refPrice: number }>;
}
interface ArenaParams { enabled: boolean; noise: boolean; spreadBps: number; stepBps: number; levels: number; sizeMu: number; maxInventoryMu: number; minEdgeBps: number; requoteBps: number }
interface WorldResp {
  ok: boolean;
  state: StateView;
  markets: MarketView[];
  pools: PoolView[];
  wallets: WalletView[];
  arena: { params: ArenaParams; soldiers: SoldierView[]; journal: { h: number; soldier: string; action: string; edgeBps?: number; profitMu?: number; note?: string }[]; mempool: number; dbOk: boolean };
  proofs: { seals: SealInfo[]; receipts: { kind: string; digest: string; at: number }[]; blockWindow: number };
  tape: TapeEv[];
}

const ASSETS = ["SAOS", "USDS", "WSTEEM", "ENERGY", "WSBD", "PHIVE"];

export default function DexConsole() {
  const [world, setWorld] = useState<WorldResp | null>(null);
  const [marketKey, setMarketKey] = useState("SAOS/USDS");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [proofPack, setProofPack] = useState<{ verified: boolean; recomputedRoot: string; leaves: string[]; seal: SealInfo } | null>(null);
  const [benchRes, setBenchRes] = useState<{ opsPerSec: number; perDay: number; verdict: string } | null>(null);

  const flash = useCallback((tone: "ok" | "err", text: string) => {
    setMsg({ tone, text });
    setTimeout(() => setMsg(null), 4000);
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/dex/state", { cache: "no-store" });
      const j = (await r.json()) as WorldResp;
      if (j.ok) setWorld(j);
    } catch { /* השרת עוד קם */ }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [load]);

  const post = useCallback(async (url: string, body?: unknown) => {
    setBusy(true);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const j = (await r.json()) as { ok: boolean; error?: string; note?: string; reason?: string };
      if (j.ok) flash("ok", j.note ?? "נכנס לתור — ייכלל בבלוק הבא");
      else flash("err", j.error ?? j.reason ?? "נדחה");
      void load();
      return j;
    } finally {
      setBusy(false);
    }
  }, [flash, load]);

  const market = useMemo(
    () => world?.markets.find((m) => m.key === marketKey) ?? world?.markets[0],
    [world, marketKey]
  );
  const opWallet = world?.wallets.find((w) => w.name === "operator");
  const st = world?.state;

  return (
    <div className="flex min-h-screen flex-col">
      {/* ─── כותרת-ריבונית ─── */}
      <header className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-amber-500/40 bg-amber-500/10">
              <Coins className="h-5 w-5 text-amber-400" />
            </div>
            <div>
              <h1 className="text-base font-black tracking-tight text-zinc-50">
                SAOS-DEX <span className="text-amber-400">· הבורסה הריבונית</span>
              </h1>
              <p className="text-[10px] text-zinc-500">ספר-הזמנות דטרמיניסטי · בריכות 30bps · ארנה אוטונומית · מורשת saos-dex + grid98</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone="amber" pulse>● פעימה חיה · גובה {st ? fmtInt(st.height) : "…"}</Pill>
            <Pill tone="zinc">root {st ? shortHash(st.stateRoot, 10) : "…"}</Pill>
            <Pill tone="emerald">חותם הבא בעוד {st ? st.nextSealIn : "…"} בלוקים</Pill>
            <Pill tone={st?.dbOk ? "emerald" : "rose"}>{st?.dbOk ? "ראיות-DB ✓" : "ראיות-DB כבויות"}</Pill>
            <Pill tone="gold">SIM — ספר-ריבוני, אין כסף אמת</Pill>
          </div>
        </div>
      </header>

      {msg && (
        <div className={`mx-auto mt-3 w-full max-w-7xl px-4`}>
          <div className={`rounded-lg border px-4 py-2 text-sm font-semibold ${msg.tone === "ok" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-rose-500/40 bg-rose-500/10 text-rose-300"}`}>
            {msg.text}
          </div>
        </div>
      )}

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-4">
        {/* ─── מדדי-על ─── */}
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="גובה-שרשרת" value={st ? fmtInt(st.height) : "…"} sub={`פעימה כל ${st ? st.tickMs / 1000 : 3} שנ׳`} />
          <Stat label="סה״כ-פעולות" value={st ? fmtInt(st.opsTotal) : "…"} sub={`fills ${fmtInt(st?.fills ?? 0)} · swaps ${fmtInt(st?.swaps ?? 0)}`} />
          <Stat label="מחיר-ייחוס SAOS" value={st ? fmt(st.ladder.refPrice, 3) + " USDS" : "…"} sub={`הרמות-רצפה ${fmtInt(st?.ladders ?? 0)}`} tone="text-amber-300" />
          <Stat label="רווח-אוצר (נקצר)" value={st ? fmt(st.treasuryProfit, 1) : "…"} sub={`מד-עמלות ${fmt(st?.feeMeter ?? 0, 1)}`} tone="text-emerald-300" />
          <Stat label="בניית-בלוק" value={st ? st.buildMs + "ms" : "…"} sub={`הזמנות-חיות ${fmtInt(st?.liveOrders ?? 0)}`} />
          <Stat label="ממפול" value={fmtInt(world?.arena.mempool ?? 0)} sub={`זמן-קומה ${st ? fmtInt(st.uptimeSec) + "s" : "…"}`} />
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* ─── טור ימין: ספר + סליל ─── */}
          <div className="flex flex-col gap-4">
            <Panel title="ספר-הזמנות" icon={<Layers className="h-4 w-4 text-amber-400" />}
              action={
                <select
                  value={marketKey}
                  onChange={(e) => setMarketKey(e.target.value)}
                  className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs font-bold text-amber-300 outline-none"
                >
                  {(world?.markets ?? []).map((m) => <option key={m.key} value={m.key}>{m.key}</option>)}
                </select>
              }
            >
              <BookLadder market={market} />
              <BookTrade market={market} opWallet={opWallet} busy={busy} post={post} />
            </Panel>

            <Panel title="סליל-מסחר (tape)" icon={<Activity className="h-4 w-4 text-emerald-400" />}>
              <div className="scroll-slim max-h-64 overflow-y-auto" dir="ltr">
                <table className="w-full text-left text-[11px] font-mono">
                  <tbody>
                    {(world?.tape ?? []).map((e, i) => (
                      <tr key={i} className="border-b border-zinc-800/50">
                        <td className="py-1 pr-2 text-zinc-500">#{e.h}</td>
                        <td className={`py-1 pr-2 font-bold ${e.kind === "fill" ? "text-amber-300" : "text-emerald-300"}`}>{e.kind}</td>
                        <td className="py-1 pr-2 text-zinc-300">{e.base}/{e.quote}</td>
                        <td className="py-1 pr-2">{(e.price / 1000).toFixed(4)}</td>
                        <td className="py-1 pr-2 text-zinc-400">{fmt(e.amountMu, 0)}</td>
                        <td className="py-1 text-zinc-500">{e.taker}{e.maker ? `×${e.maker}` : ""}</td>
                      </tr>
                    ))}
                    {(world?.tape ?? []).length === 0 && (
                      <tr><td className="py-3 text-center text-zinc-600" dir="rtl">ממתין לזרימה ראשונה…</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>

          {/* ─── טור מרכז: גרף + סוואג' + בריכות ─── */}
          <div className="flex flex-col gap-4">
            <Panel title={`גרף-מחיר · ${marketKey}`} icon={<BarChart3 className="h-4 w-4 text-amber-400" />}
              action={<Pill tone="zinc">fair {market ? fmt(market.fair, 4) : "—"}</Pill>}>
              <div className="h-52" dir="ltr">
                {market && market.chart.length > 1 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={market.chart.map((c, i) => ({ i, p: c.p / 1000 }))}>
                      <defs>
                        <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#f5b841" stopOpacity={0.5} />
                          <stop offset="100%" stopColor="#f5b841" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
                      <XAxis dataKey="i" hide />
                      <YAxis domain={["auto", "auto"]} tick={{ fill: "#71717a", fontSize: 10 }} width={54} />
                      <Tooltip
                        contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 8, fontSize: 12 }}
                        labelStyle={{ color: "#a1a1aa" }}
                        formatter={(v: number) => [v.toFixed(5), "מחיר"]}
                      />
                      <Area type="monotone" dataKey="p" stroke="#f5b841" strokeWidth={2} fill="url(#gold)" isAnimationActive={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-zinc-600">הגרף נבנה מהזרימה הראשונה…</div>
                )}
              </div>
              <div className="mt-2 grid grid-cols-4 gap-2 text-center text-[11px]">
                <div className="rounded-md bg-zinc-900 px-2 py-1.5">
                  <div className="text-zinc-500">best bid</div>
                  <div className="font-mono font-bold text-emerald-300">{market?.bestBid ? fmt(market.bestBid, 4) : "—"}</div>
                </div>
                <div className="rounded-md bg-zinc-900 px-2 py-1.5">
                  <div className="text-zinc-500">best ask</div>
                  <div className="font-mono font-bold text-rose-300">{market?.bestAsk ? fmt(market.bestAsk, 4) : "—"}</div>
                </div>
                <div className="rounded-md bg-zinc-900 px-2 py-1.5">
                  <div className="text-zinc-500">spread</div>
                  <div className="font-mono font-bold text-zinc-200">{market?.spreadBps ?? 0}bps</div>
                </div>
                <div className="rounded-md bg-zinc-900 px-2 py-1.5">
                  <div className="text-zinc-500">pool mid</div>
                  <div className="font-mono font-bold text-amber-300">{market?.poolMid ? fmt(market.poolMid, 4) : "—"}</div>
                </div>
              </div>
            </Panel>

            <SwapPanel market={market} pools={world?.pools ?? []} opWallet={opWallet} busy={busy} post={post} flash={flash} />

            <PoolsPanel pools={world?.pools ?? []} opWallet={opWallet} busy={busy} post={post} flash={flash} />
          </div>

          {/* ─── טור שמאל: ארנה + סולם + הוכחות + ביצועים ─── */}
          <div className="flex flex-col gap-4">
            <ArenaPanel world={world} busy={busy} post={post} />

            <Panel title="סולם-ערך (רצפה מגובה)" icon={<GitBranch className="h-4 w-4 text-emerald-400" />}>
              <div className="space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-zinc-400">רצפה-נוכחית</span>
                  <span className="font-mono font-bold text-amber-300">{st ? fmt(st.ladder.refPrice, 4) + " USDS" : "—"}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-zinc-400">הרמות-שבוצעו</span>
                  <span className="font-mono font-bold">{st ? fmtInt(st.ladders) : "—"} <span className="text-zinc-500">(≤0.5% לצעד)</span></span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-zinc-400">עלות-צעד (מעמלות-בלבד)</span>
                  <span className="font-mono">{st ? fmt(st.ladder.stepCostMu, 1) : "—"}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-zinc-400">מימון-שנצבר</span>
                  <span className="font-mono text-emerald-300">{st ? fmt(st.ladder.spentMu, 1) : "—"}</span>
                </div>
                <p className="rounded-md border border-zinc-800 bg-zinc-900/70 p-2 text-[10px] leading-relaxed text-zinc-500">
                  כל-הרמת-רצפה נגבית-בעמלות-שנמדדו בפועל (feeMeter) — אסור לקצור מעבר-למדידה. כנות-מלאה.
                </p>
              </div>
            </Panel>

            <Panel title="הוכחות-ציבוריות" icon={<ShieldCheck className="h-4 w-4 text-amber-400" />}
              action={
                <GoldButton tone="ghost" className="!px-2 !py-1 text-xs" disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const r = await fetch("/api/dex/proofs", { cache: "no-store" });
                      const j = (await r.json()) as { ok: boolean; empty?: boolean; verified?: boolean; recomputedRoot?: string; leaves?: string[]; seal?: SealInfo; message?: string };
                      if (j.empty) flash("err", "אין-חותם עדיין — הראשון בגובה 12");
                      else if (j.verified !== undefined) {
                        setProofPack({ verified: j.verified, recomputedRoot: j.recomputedRoot!, leaves: j.leaves!, seal: j.seal! });
                        flash(j.verified ? "ok" : "err", j.verified ? `מרקל אומת מחדש ✓ ${j.recomputedRoot?.slice(0, 10)}…` : "אי-התאמה!");
                      }
                    } finally { setBusy(false); }
                  }}>
                  אמת-עצמאית
                </GoldButton>
              }>
              <div className="space-y-2 text-xs">
                {(world?.proofs.seals ?? []).slice(0, 3).map((s) => (
                  <div key={s.digest} className="rounded-md border border-zinc-800 bg-zinc-900/70 px-2.5 py-2" dir="ltr">
                    <div className="flex items-center justify-between font-mono text-[11px]">
                      <span className="text-zinc-400">#{s.fromHeight}→{s.toHeight}</span>
                      <span className="font-bold text-amber-300">{s.root.slice(0, 14)}…</span>
                    </div>
                    <div className="mt-1 font-mono text-[10px] text-zinc-500">stateRoot {s.stateRoot.slice(0, 14)}… · {s.leaves} leaves</div>
                  </div>
                ))}
                {(world?.proofs.seals ?? []).length === 0 && <div className="py-2 text-center text-zinc-600">אין-חותמים עדיין</div>}
                {proofPack && (
                  <div className={`rounded-md border px-2.5 py-2 font-mono text-[10px] ${proofPack.verified ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-rose-500/40 bg-rose-500/10 text-rose-300"}`} dir="ltr">
                    merkle recompute: {proofPack.verified ? "PASS" : "FAIL"} · leaves={proofPack.leaves.length} · {proofPack.recomputedRoot.slice(0, 14)}…
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <GoldButton tone="ghost" className="!py-1.5 text-xs" disabled={busy} onClick={async () => {
                    setBusy(true);
                    try {
                      const r = await fetch("/api/dex/bench?ops=30000", { cache: "no-store" });
                      const j = (await r.json()) as { opsPerSec: number; perDay: number; verdict: string };
                      setBenchRes(j);
                      flash("ok", j.verdict);
                    } finally { setBusy(false); }
                  }}>
                    <Zap className="ml-1 inline h-3 w-3" /> מדידת-קצב
                  </GoldButton>
                  <GoldButton tone="ghost" className="!py-1.5 text-xs" disabled={busy} onClick={() => void post("/api/dex/reset")}>
                    <RefreshCcw className="ml-1 inline h-3 w-3" /> איפוס-ג'נזיס
                  </GoldButton>
                </div>
                {benchRes && (
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 font-mono text-[11px] text-amber-300" dir="ltr">
                    {fmtInt(benchRes.opsPerSec)} ops/sec · {(benchRes.perDay / 1e6).toFixed(1)}M/day
                  </div>
                )}
              </div>
            </Panel>

            <Panel title="גיבוי-נכסים עטופים (1:1)" icon={<Anchor className="h-4 w-4 text-zinc-400" />}>
              <div className="space-y-1.5 text-xs">
                {Object.entries(st?.backing ?? {}).length === 0 && <div className="text-zinc-600">אין-נכסים-עטופים פעילים — wrap_mint פתוח לכולם</div>}
                {Object.entries(st?.backing ?? {}).map(([a, v]) => (
                  <div key={a} className="flex items-center justify-between rounded-md bg-zinc-900/70 px-2.5 py-1.5">
                    <span className="font-bold text-zinc-300">{a}</span>
                    <span className="font-mono text-emerald-300">מגובה {fmt(v, 0)}</span>
                  </div>
                ))}
                <div className="flex gap-2 pt-1">
                  <GoldButton tone="ghost" className="flex-1 !py-1.5 text-xs" disabled={busy || !opWallet || (opWallet.balances["STEEM"] ?? 0) < 300_000}
                    onClick={() => void post("/api/dex/wrap", { action: "mint", asset: "WSTEEM", amount: 300_000 })}>
                    wrap 300 STEEM → WSTEEM
                  </GoldButton>
                  <GoldButton tone="ghost" className="!py-1.5 text-xs" disabled={busy || !opWallet || (opWallet.balances["WSTEEM"] ?? 0) < 100_000}
                    onClick={() => void post("/api/dex/wrap", { action: "burn", asset: "WSTEEM", amount: 100_000 })}>
                    burn 100
                  </GoldButton>
                </div>
              </div>
            </Panel>
          </div>
        </div>

        {/* ─── ארנקים ─── */}
        <Panel title="ארנקי-הרשת" icon={<Wallet className="h-4 w-4 text-amber-400" />} className="mt-4"
          action={
            <GoldButton tone="gold" className="!py-1.5 text-xs" disabled={busy}
              onClick={() => void post("/api/dex/faucet")}>
              <FlaskConical className="ml-1 inline h-3 w-3" /> ברז-דמו (operator, פעם/דקה)
            </GoldButton>
          }>
          <div className="scroll-slim max-h-72 overflow-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-right text-[10px] uppercase tracking-wider text-zinc-500">
                  <th className="pb-2">חשבון</th>
                  <th className="pb-2">יתרות (µ)</th>
                  <th className="pb-2">נעול (escrow)</th>
                  <th className="pb-2">קרדיט-GAS</th>
                </tr>
              </thead>
              <tbody>
                {(world?.wallets ?? []).map((w) => (
                  <tr key={w.name} className={`border-t border-zinc-800/60 ${w.name === "operator" ? "bg-amber-500/5" : ""}`}>
                    <td className="py-1.5 pl-2 font-bold text-zinc-200">{w.name}{w.name === "operator" && <span className="mr-1 text-[9px] text-amber-400">(אתה)</span>}</td>
                    <td className="py-1.5 font-mono text-[11px] text-zinc-300" dir="ltr">
                      {Object.entries(w.balances).filter(([, v]) => v !== 0).map(([a, v]) => `${a}:${fmtInt(v)}`).join(" · ") || "—"}
                    </td>
                    <td className="py-1.5 font-mono text-[11px] text-amber-300/80" dir="ltr">
                      {Object.entries(w.locked).filter(([, v]) => v !== 0).map(([a, v]) => `${a}:${fmtInt(v)}`).join(" · ") || "—"}
                    </td>
                    <td className="py-1.5 font-mono text-[11px] text-zinc-400" dir="ltr">{fmtInt(w.credits)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </main>

      {/* ─── פוטר דביק — כנות-מלאה ─── */}
      <footer className="mt-auto border-t border-zinc-800 bg-zinc-950/95 pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-3 text-[11px] text-zinc-500">
          <div className="flex items-center gap-2">
            <Landmark className="h-3.5 w-3.5 text-amber-500/60" />
            <span>SAOS-DEX v1.0 · ספר-ריבוני מקומי — <strong className="text-zinc-400">אין כסף אמת, אין הבטחות תשואה, אין עסקאות-חוץ</strong></span>
          </div>
          <div className="flex items-center gap-3">
            <span>עיגון-שרשרת-ציבורית דורש מפתחות-מפעיל (לא קיימים כאן — בכוונה)</span>
            <span className="font-mono">port 3010</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

// ─── ספר-הזמנות (צפיפות-עומק) ───────────────────────────────────────────────
function BookLadder({ market }: { market?: MarketView }) {
  const maxTotal = Math.max(1, ...(market?.bids ?? []).map((b) => b.total), ...(market?.asks ?? []).map((a) => a.total));
  const Row = ({ price, total, orders, side }: { price: number; total: number; orders: number; side: "bid" | "ask" }) => (
    <div className="relative flex items-center justify-between overflow-hidden rounded px-2 py-1 font-mono text-[11px]">
      <div
        className={`absolute inset-y-0 ${side === "bid" ? "right-0 bg-emerald-500/15" : "right-0 bg-rose-500/15"}`}
        style={{ width: `${(total / maxTotal) * 100}%` }}
      />
      <span className={`relative z-10 font-bold ${side === "bid" ? "text-emerald-300" : "text-rose-300"}`} dir="ltr">
        {(price / 1000).toFixed(4)}
      </span>
      <span className="relative z-10 text-zinc-300" dir="ltr">{fmt(total, 0)}</span>
      <span className="relative z-10 w-6 text-left text-zinc-600" dir="ltr">{orders}</span>
    </div>
  );
  return (
    <div>
      <div className="mb-1 flex justify-between px-2 text-[10px] uppercase tracking-wider text-zinc-500">
        <span>מחיר</span><span>סה״כ (µ)</span><span>הזמנות</span>
      </div>
      <div className="flex flex-col-reverse gap-0.5">
        {(market?.asks ?? []).slice(0, 8).map((a) => <Row key={`a${a.price}`} {...a} side="ask" />)}
      </div>
      <div className="my-1.5 flex items-center justify-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 py-1.5">
        <span className="text-[10px] text-zinc-400">spread</span>
        <span className="font-mono text-sm font-black text-amber-300">{market?.spreadBps ?? 0}bps</span>
      </div>
      <div className="flex flex-col gap-0.5">
        {(market?.bids ?? []).slice(0, 8).map((b) => <Row key={`b${b.price}`} {...b} side="bid" />)}
      </div>
      {(market?.bids ?? []).length === 0 && (market?.asks ?? []).length === 0 && (
        <div className="py-4 text-center text-xs text-zinc-600">הספר מתעורר — הארנה מציבה ציטוטים ראשונים…</div>
      )}
    </div>
  );
}

// ─── טופס-פקודה על הספר + ההזמנות שלי ──────────────────────────────────────
function BookTrade({ market, opWallet, busy, post }: {
  market?: MarketView; opWallet?: WalletView; busy: boolean;
  post: (url: string, body?: unknown) => Promise<{ ok: boolean; error?: string; note?: string }>;
}) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [price, setPrice] = useState("");
  const [amount, setAmount] = useState("100");
  const myOrders = useMyOrders(market?.key);
  useEffect(() => {
    if (market && !price) setPrice(String(market.bestBid || market.fair || ""));
  }, [market, price]);

  const priceMu = Math.floor(Number(price));
  const amountMu = Math.floor(Number(amount) * 1000);
  const lockAsset = side === "buy" ? market?.quote : market?.base;
  const lockMu = side === "buy" ? Math.floor((priceMu * amountMu) / 1000) : amountMu;
  const have = lockAsset ? (opWallet?.balances[lockAsset] ?? 0) - (opWallet?.locked[lockAsset] ?? 0) : 0;

  return (
    <div className="mt-3 border-t border-zinc-800 pt-3">
      <div className="mb-2 grid grid-cols-2 gap-1 rounded-lg bg-zinc-900 p-1">
        <button onClick={() => setSide("buy")}
          className={`rounded-md py-1.5 text-xs font-black transition-colors ${side === "buy" ? "bg-emerald-600 text-white" : "text-emerald-400"}`}>
          קנייה
        </button>
        <button onClick={() => setSide("sell")}
          className={`rounded-md py-1.5 text-xs font-black transition-colors ${side === "sell" ? "bg-rose-600 text-white" : "text-rose-400"}`}>
          מכירה
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <input value={price} onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ""))}
          placeholder="מחיר (µ)" dir="ltr" inputMode="decimal"
          className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-xs outline-none focus:border-amber-500/60" />
        <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
          placeholder="כמות (יחידות)" dir="ltr" inputMode="decimal"
          className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-xs outline-none focus:border-amber-500/60" />
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[10px] text-zinc-500">
        <span dir="ltr">escrow: {fmtInt(Math.max(0, lockMu))} {lockAsset ?? ""}</span>
        <span dir="ltr">avail: {fmtInt(Math.max(0, have))}</span>
      </div>
      <GoldButton className="mt-2 w-full !py-1.5 text-xs" disabled={busy || !(priceMu > 0) || !(amountMu > 0) || have < lockMu}
        tone={side === "buy" ? "emerald" : "rose"}
        onClick={() => void post("/api/dex/order", { action: "order", base: market?.base, quote: market?.quote, side, price: priceMu, amount: amountMu })}>
        הצב {side === "buy" ? "ביד" : "אסק"} {market?.base} @{price || "—"}
      </GoldButton>
      {myOrders.length > 0 && (
        <div className="scroll-slim mt-2 max-h-24 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-900/70 p-1.5">
          {myOrders.map((o) => (
            <div key={o.id} className="flex items-center justify-between px-1 py-0.5 font-mono text-[10px]" dir="ltr">
              <span className={o.side === "buy" ? "text-emerald-400" : "text-rose-400"}>{o.side} {(o.price / 1000).toFixed(4)}</span>
              <span className="text-zinc-400">{fmt(o.amount - o.filled, 0)}</span>
              <button disabled={busy} onClick={() => void post("/api/dex/cancel", { orderId: o.id })}
                className="rounded border border-zinc-700 px-1.5 text-zinc-400 hover:border-rose-500/60 hover:text-rose-300">
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function useMyOrders(marketKey?: string) {
  const [orders, setOrders] = useState<{ id: number; base: string; quote: string; side: "buy" | "sell"; price: number; amount: number; filled: number }[]>([]);
  useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        const r = await fetch("/api/dex/my-orders", { cache: "no-store" });
        const j = (await r.json()) as { ok: boolean; orders: typeof orders };
        if (alive && j.ok) setOrders(j.orders.filter((o) => !marketKey || `${o.base}/${o.quote}` === marketKey));
      } catch { /* ok */ }
    };
    void pull();
    const t = setInterval(() => void pull(), 2500);
    return () => { alive = false; clearInterval(t); };
  }, [marketKey]);
  return orders;
}

// ─── סוואג' (AMM) ───────────────────────────────────────────────────────────
function SwapPanel({ market, pools, opWallet, busy, post, flash }: {
  market?: MarketView; pools: PoolView[]; opWallet?: WalletView; busy: boolean;
  post: (url: string, body?: unknown) => Promise<{ ok: boolean; error?: string; note?: string }>;
  flash: (tone: "ok" | "err", text: string) => void;
}) {
  const [pair, setPair] = useState<string>("");
  const [dir, setDir] = useState<"a2b" | "b2a">("a2b");
  const [amount, setAmount] = useState("1000");
  const [quote, setQuote] = useState<{ out: number; price: number; minOut0: number } | null>(null);
  const [pulse, setPulse] = useState(false);

  const pool = useMemo(() => {
    if (pair) return pools.find((p) => p.key === pair);
    const key = market?.key ?? "";
    const p = pools.find((x) => x.key === key);
    if (p) { return p; }
    return pools[0];
  }, [pair, pools, market]);

  useEffect(() => { if (pool && !pair) setPair(pool.key); }, [pool, pair]);

  const assetIn = pool ? (dir === "a2b" ? pool.a : pool.b) : "";
  const assetOut = pool ? (dir === "a2b" ? pool.b : pool.a) : "";
  const amountMu = Math.floor(Number(amount) * 1000);

  useEffect(() => {
    let alive = true;
    if (!pool || !(amountMu > 0) || !assetIn) { setQuote(null); return; }
    (async () => {
      try {
        const r = await fetch(`/api/dex/swap?pair=${encodeURIComponent(pool.key)}&assetIn=${assetIn}&amount=${amountMu}`, { cache: "no-store" });
        const j = (await r.json()) as { ok: boolean; out: number; price: number; minOut0: number };
        if (alive) setQuote(j.ok ? { out: j.out, price: j.price, minOut0: j.minOut0 } : null);
      } catch { if (alive) setQuote(null); }
    })();
    const t = setInterval(() => {
      (async () => {
        try {
          const r = await fetch(`/api/dex/swap?pair=${encodeURIComponent(pool.key)}&assetIn=${assetIn}&amount=${amountMu}`, { cache: "no-store" });
          const j = (await r.json()) as { ok: boolean; out: number; price: number; minOut0: number };
          if (alive) setQuote(j.ok ? { out: j.out, price: j.price, minOut0: j.minOut0 } : null);
        } catch { /* ok */ }
      })();
    }, 2500);
    return () => { alive = false; clearInterval(t); };
  }, [pool, assetIn, amountMu, pulse]);

  const have = opWallet?.balances[assetIn] ?? 0;

  return (
    <Panel title="החלפה ריבונית (AMM 30bps)" icon={<Droplets className="h-4 w-4 text-amber-400" />}
      action={pool ? <Pill tone="zinc">{pool.key}</Pill> : undefined}>
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <select value={pair} onChange={(e) => setPair(e.target.value)}
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm font-bold outline-none focus:border-amber-500/60">
            {pools.map((p) => <option key={p.key} value={p.key}>{p.key}</option>)}
          </select>
          <GoldButton tone="ghost" onClick={() => { setDir(dir === "a2b" ? "b2a" : "a2b"); setPulse((x) => !x); }}>
            ⇄ {assetIn}→{assetOut}
          </GoldButton>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            inputMode="decimal"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-sm outline-none focus:border-amber-500/60"
            placeholder="כמות (יחידות)"
            dir="ltr"
          />
          <span className="w-16 text-center text-xs font-bold text-amber-300">{assetIn}</span>
        </div>
        <div className="flex items-center justify-between rounded-lg bg-zinc-900/80 px-3 py-2 text-xs">
          <span className="text-zinc-400">תקבל (חד-פעמי-ציטוט)</span>
          <span className="font-mono font-bold text-emerald-300" dir="ltr">
            {quote ? `${fmt(quote.out, 2)} ${assetOut}` : "—"}
          </span>
        </div>
        <div className="flex items-center justify-between px-1 text-[10px] text-zinc-500">
          <span>עמלה 30bps (70% LP · 30% אוצר)</span>
          <span dir="ltr">{quote ? `slip-guard: min ${fmt(quote.minOut0, 2)}` : ""}</span>
        </div>
        <GoldButton
          className="w-full" disabled={busy || !quote || !(amountMu > 0) || have < amountMu}
          onClick={() => void post("/api/dex/swap", { pair: pool?.key, assetIn, amount: amountMu, minOut: quote?.minOut0 })}>
          החלף {assetIn} → {assetOut}
        </GoldButton>
        <div className="text-center text-[10px] text-zinc-500" dir="ltr">
          have: {fmtInt(have)} {assetIn}
        </div>
      </div>
    </Panel>
  );
}

// ─── בריכות ─────────────────────────────────────────────────────────────────
function PoolsPanel({ pools, opWallet, busy, post, flash }: {
  pools: PoolView[]; opWallet?: WalletView; busy: boolean;
  post: (url: string, body?: unknown) => Promise<{ ok: boolean; error?: string; note?: string }>;
  flash: (tone: "ok" | "err", text: string) => void;
}) {
  const [sel, setSel] = useState<string>("");
  const [amountA, setAmountA] = useState("2000");
  const pool = pools.find((p) => p.key === (sel || pools[0]?.key));
  useEffect(() => { if (!sel && pools[0]) setSel(pools[0].key); }, [pools, sel]);
  const lpKey = pool ? `LP|${pool.key}` : "";
  const myLp = opWallet?.balances[lpKey] ?? 0;
  const amountMu = Math.floor(Number(amountA) * 1000);
  const needB = pool && pool.ra > 0 ? Math.floor((pool.rb * amountMu) / pool.ra) : 0;

  return (
    <Panel title="בריכות-זרימה (DEX-98)" icon={<Bot className="h-4 w-4 text-emerald-400" />}>
      <div className="space-y-2">
        {pools.map((p) => (
          <button key={p.key} onClick={() => setSel(p.key)}
            className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-right transition-colors ${pool?.key === p.key ? "border-amber-500/60 bg-amber-500/10" : "border-zinc-800 bg-zinc-900/60 hover:border-zinc-700"}`}>
            <span className="text-sm font-black text-zinc-100">{p.key}</span>
            <span className="font-mono text-[11px] text-zinc-400" dir="ltr">
              mid {(p.mid / 1000).toFixed(4)} · k {p.k.toExponential(2)} · swaps {p.swaps}
            </span>
          </button>
        ))}
        {pool && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3">
            <div className="mb-2 flex items-center justify-between text-[11px] text-zinc-400">
              <span dir="ltr">{pool.a}: {fmt(pool.ra, 0)} · {pool.b}: {fmt(pool.rb, 0)}</span>
              <span dir="ltr">LP שלי: {fmtInt(myLp)}</span>
            </div>
            <div className="flex items-center gap-2">
              <input value={amountA} onChange={(e) => setAmountA(e.target.value.replace(/[^0-9.]/g, ""))}
                className="w-24 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-xs outline-none focus:border-amber-500/60" dir="ltr" />
              <span className="text-[10px] text-zinc-500">{pool.a} + {fmt(needB, 0)} {pool.b}</span>
              <GoldButton className="mr-auto !py-1.5 text-xs" tone="emerald" disabled={busy || !(amountMu > 0)}
                onClick={() => void post("/api/dex/pool", { action: "add", pair: pool.key, amountA: amountMu })}>
                הוסף-נזילות
              </GoldButton>
              <GoldButton className="!py-1.5 text-xs" tone="ghost" disabled={busy || myLp <= 0}
                onClick={() => {
                  const half = Math.floor(myLp / 2);
                  if (half <= 0) { flash("err", "אין-LP למשיכה"); return; }
                  void post("/api/dex/pool", { action: "remove", pair: pool.key, lp: half });
                }}>
                משוך-½LP
              </GoldButton>
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

// ─── ארנה אוטונומית ─────────────────────────────────────────────────────────
function ArenaPanel({ world, busy, post }: { world: WorldResp | null; busy: boolean; post: (url: string, body?: unknown) => Promise<{ ok: boolean }> }) {
  const arena = world?.arena;
  const p = arena?.params;
  const [local, setLocal] = useState<ArenaParams | null>(null);
  useEffect(() => { if (p && !local) setLocal(p); }, [p, local]);
  const cur = local ?? p;
  if (!cur) return <Panel title="הארנה האוטונומית" icon={<Bot className="h-4 w-4 text-amber-400" />}><div className="py-3 text-center text-xs text-zinc-600">טוען…</div></Panel>;

  const slider = (label: string, key: "spreadBps" | "stepBps" | "levels" | "sizeMu" | "minEdgeBps", min: number, max: number) => (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px]">
        <span className="text-zinc-400">{label}</span>
        <span className="font-mono font-bold text-amber-300">{fmtInt(cur[key])}</span>
      </div>
      <input type="range" min={min} max={max} value={cur[key]} className="sovereign-range w-full"
        onChange={(e) => setLocal({ ...cur, [key]: Math.floor(Number(e.target.value)) })} />
    </div>
  );

  return (
    <Panel title="ארנת-החיילים (אוטופיילוט)" icon={<Bot className="h-4 w-4 text-amber-400" />}
      action={
        <GoldButton tone={cur.enabled ? "emerald" : "ghost"} className="!px-2 !py-1 text-xs" disabled={busy}
          onClick={() => { const next = { ...cur, enabled: !cur.enabled }; setLocal(next); void post("/api/dex/arena", next); }}>
          {cur.enabled ? "פועל ●" : "כבוי ○"}
        </GoldButton>
      }>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          {slider("רוחב-גריד (bps)", "spreadBps", 10, 200)}
          {slider("מרווח-רמות (bps)", "stepBps", 5, 150)}
          {slider("שער-שוליים (bps)", "minEdgeBps", 1, 100)}
          {slider("גודל-ציטוט (µ)", "sizeMu", 10_000, 500_000)}
        </div>
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-right text-[9px] uppercase tracking-wider text-zinc-500">
              <th className="pb-1">חייל</th><th className="pb-1">ציטוטים-חיים</th><th className="pb-1">SAOS</th><th className="pb-1">P&amp;L (µ, מסומן)</th>
            </tr>
          </thead>
          <tbody>
            {(arena?.soldiers ?? []).map((s) => (
              <tr key={s.name} className="border-t border-zinc-800/60">
                <td className="py-1 font-bold text-zinc-200">{s.name}</td>
                <td className="py-1 font-mono text-amber-300" dir="ltr">{s.liveQuotes}</td>
                <td className="py-1 font-mono text-zinc-300" dir="ltr">{fmt(s.saos, 0)}</td>
                <td className={`py-1 font-mono font-bold ${s.pnl >= 0 ? "text-emerald-300" : "text-rose-300"}`} dir="ltr">{s.pnl >= 0 ? "+" : ""}{fmtInt(s.pnl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="scroll-slim max-h-28 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-900/70 p-2">
          {(arena?.journal ?? []).map((j, i) => (
            <div key={i} className="flex items-center justify-between py-0.5 font-mono text-[10px] text-zinc-400" dir="ltr">
              <span className="text-zinc-600">#{j.h}</span>
              <span className={j.action === "harvest" ? "text-emerald-300" : ""}>{j.soldier}·{j.action}</span>
              <span>{j.edgeBps !== undefined ? `edge ${j.edgeBps}bps` : (j.note ?? "")}</span>
            </div>
          ))}
          {(arena?.journal ?? []).length === 0 && <div className="py-2 text-center text-zinc-600">יומן-הארנה ייפתח בפעולה הראשונה</div>}
        </div>
        <GoldButton className="w-full !py-1.5 text-xs" tone="gold" disabled={busy}
          onClick={() => { void post("/api/dex/arena", cur); }}>
          החל-פרמטרים על הארנה
        </GoldButton>
      </div>
    </Panel>
  );
}
