"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, Anchor, ArrowLeftRight, BarChart3, Bot, Check, Coins, Cpu, Droplets, FlaskConical,
  GitBranch, Landmark, RefreshCcw, ShieldCheck, Wallet, X, Zap, Layers,
} from "lucide-react";
import { GoldButton, Panel, Pill, StatusDot, Stat, fmt, fmtInt, shortHash } from "@/components/dex/kit";
import { PriceChart } from "@/components/dex/chart";

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
  height: number; tps: number; stateRoot: string; gasUsed: number; opsTotal: number; fills: number; swaps: number;
  ladders: number; treasuryProfit: number; feeMeter: number;
  ladder: { refPrice: number; lifts: number; lastLiftHeight: number; spentMu: number; stepCostMu: number };
  liveOrders: number; buildMs: number; uptimeSec: number; lastBlockAgoMs: number | null;
  dbOk: boolean; tickMs: number; sealEvery: number; nextSealIn: number;
  backing: Record<string, number>; assets: Record<string, { refPrice: number }>;
}
interface ArenaParams { enabled: boolean; noise: boolean; spreadBps: number; stepBps: number; levels: number; sizeMu: number; maxInventoryMu: number; minEdgeBps: number; requoteBps: number }
interface WorldResp {
  ok: boolean;
  version: number;
  state: StateView;
  markets: MarketView[];
  pools: PoolView[];
  wallets: WalletView[];
  arena: { params: ArenaParams; soldiers: SoldierView[]; journal: { h: number; soldier: string; action: string; edgeBps?: number; profitMu?: number; note?: string }[]; mempool: number; dbOk: boolean };
  proofs: { seals: SealInfo[]; receipts: { kind: string; digest: string; at: number }[]; blockWindow: number };
  tape: TapeEv[];
}

const ASSETS = ["SAOS", "USDS", "WSTEEM", "ENERGY", "WSBD", "PHIVE"];

/* ══ מנוע-זרימה: long-polling מבוסס-אירוע עם AbortController ══════════════════
 * הלקוח תולה בקשה עם הגרסה-המקומית; השרת משיב רק כשהשרשרת התקדמה (או keepalive
 * כל-12ש׳). אפס-השהיה מלאכותית — עדכון עם כל-בלוק, בלי סקר-תקופתי. */
function useWorldStream(): { world: WorldResp | null; load: () => Promise<void> } {
  const [world, setWorld] = useState<WorldResp | null>(null);
  const versionRef = useRef(0);
  const ctrlRef = useRef<AbortController | null>(null);
  const [gen, setGen] = useState(0);

  // רענון-מיידי (אחרי-פעולת-משתמש): נתק את ה-long-poll, קבל תמונה עכשיו, החזר את הלולאה
  const load = useCallback(async () => {
    ctrlRef.current?.abort();
    try {
      const r = await fetch("/api/dex/state", { cache: "no-store" });
      const j = (await r.json()) as WorldResp;
      if (j.ok) {
        versionRef.current = j.version;
        setWorld(j);
      }
    } catch { /* השרת עוד קם */ }
    setGen((x) => x + 1);
  }, []);

  useEffect(() => {
    let stopped = false;
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    const loop = async () => {
      while (!stopped) {
        try {
          const r = await fetch(`/api/dex/state?v=${versionRef.current}`, { cache: "no-store", signal: ctrl.signal });
          const j = (await r.json()) as WorldResp;
          if (!stopped && j.ok && j.version !== versionRef.current) {
            versionRef.current = j.version;
            setWorld(j);
          }
        } catch {
          if (stopped || ctrl.signal.aborted) return;
          await new Promise((res) => setTimeout(res, 1500)); // backoff — השרת עוד קם
        }
      }
    };
    void loop();
    return () => { stopped = true; ctrl.abort(); };
  }, [gen]);

  return { world, load };
}

/* ══ זרם-Relay: נשלף עם כל-גרסת-עולם (מנוע-אירוע, בלי סקר-עצמאי) ════════════ */
interface RelayRecord { chain: "steem" | "hive" | "tron"; height: number; status: string; txid: string | null; at: string; attempt: number; verified: boolean | null; verifiedAt: string | null; error?: string }
interface RelayView {
  enabled: boolean; account: string | null; anchorId: string; queue: number; tronIdentity: string | null;
  metrics: { broadcasts: number; verified: number; mismatches: number; breakerTrips: number; economicWaits: number; lastVerifyLatencyMs: number | null };
  chains: Record<"steem" | "hive" | "tron", {
    enabled: boolean; status: string; lastTxid: string | null; lastHeight: number | null; lastAt: string | null;
    lastError: string | null; lastVerifyError: string | null; anchored: number; verified: number; mismatches: number;
    breaker: { state: "closed" | "open" | "half-open"; failures: number; openedAt: number | null; trips: number };
  }>;
  records: RelayRecord[];
}

function useRelayStream(version: number | undefined): RelayView | null {
  const [relay, setRelay] = useState<RelayView | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        const r = await fetch("/api/dex/relay", { cache: "no-store", signal: ctrl.signal });
        const j = (await r.json()) as { ok: boolean; relay: RelayView };
        if (j.ok) setRelay(j.relay);
      } catch { /* aborted / idle */ }
    })();
    return () => ctrl.abort();
  }, [version]);
  return relay;
}

export default function DexConsole() {
  const { world, load } = useWorldStream();
  const [marketKey, setMarketKey] = useState<string>(""); // "" = נגזר מהזרימה (הזוג העשיר-ביותר בגרף)
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [proofPack, setProofPack] = useState<{ verified: boolean; recomputedRoot: string; leaves: string[]; seal: SealInfo } | null>(null);
  const [benchRes, setBenchRes] = useState<{ opsPerSec: number; perDay: number; verdict: string } | null>(null);

  const relay = useRelayStream(world?.version);

  const flash = useCallback((tone: "ok" | "err", text: string) => {
    setMsg({ tone, text });
    setTimeout(() => setMsg(null), 4000);
  }, []);

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

  const market = useMemo(() => {
    if (!world) return undefined;
    const picked = world.markets.find((m) => m.key === marketKey);
    if (picked) return picked;
    // ברירת-מחדל מוסדית: הזוג עם הזרימה החיה העשירה ביותר (הכי-הרבה נקודות-גרף)
    return [...world.markets].sort((a, b) => b.chart.length - a.chart.length)[0] ?? world.markets[0];
  }, [world, marketKey]);
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
                SAOS-DEX <span className="text-amber-400">· טרמינל ריבוני</span>
              </h1>
              <p className="text-[10px] text-zinc-500">ספר-הזמנות דטרמיניסטי · בריכות 30bps · ארנה אוטונומית · עיגון חי Steem/Hive/TRON</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone="amber" pulse><StatusDot tone="amber" pulse /> פעימה חיה · גובה {st ? fmtInt(st.height) : "…"}</Pill>
            <Pill tone="zinc">root {st ? shortHash(st.stateRoot, 10) : "…"}</Pill>
            <Pill tone="emerald">חותם הבא בעוד {st ? st.nextSealIn : "…"} בלוקים</Pill>
            <Pill tone={st?.dbOk ? "emerald" : "rose"}>{st?.dbOk ? "ראיות-DB אומתו" : "ראיות-DB כבויות"}</Pill>
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

        {/* ─── System Health — סרגל-סטטוס מוסדי ─── */}
        <SystemHealthPanel st={st} mempool={world?.arena.mempool ?? 0} relay={relay} />

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* ─── טור ימין: ספר + סליל ─── */}
          <div className="flex flex-col gap-4">
            <Panel title="ספר-הזמנות" icon={<Layers className="h-4 w-4 text-amber-400" />}
              action={
                <select
                  value={market?.key ?? ""}
                  onChange={(e) => setMarketKey(e.target.value)}
                  className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs font-bold text-amber-300 outline-none"
                >
                  {(world?.markets ?? []).map((m) => <option key={m.key} value={m.key}>{m.key}</option>)}
                </select>
              }
            >
              <BookLadder market={market} />
              <BookTrade market={market} opWallet={opWallet} busy={busy} post={post} version={world?.version} />
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
            <Panel title={`גרף-מחיר · ${market?.key ?? "…"}`} icon={<BarChart3 className="h-4 w-4 text-amber-400" />}
              action={<Pill tone="zinc">fair {market ? fmt(market.fair, 4) : "—"}</Pill>}>
              <div className="h-52" dir="ltr">
                {market && market.chart.length > 1 ? (
                  <PriceChart data={market.chart} height={208} />
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

            <SwapPanel market={market} pools={world?.pools ?? []} opWallet={opWallet} busy={busy} post={post} version={world?.version} />

            <PoolsPanel pools={world?.pools ?? []} opWallet={opWallet} busy={busy} post={post} flash={flash} />
          </div>

          {/* ─── טור שמאל: ארנה + סולם + הוכחות + עיגון ─── */}
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
                        flash(j.verified ? "ok" : "err", j.verified ? `מרקל אומת מחדש — ${j.recomputedRoot?.slice(0, 10)}…` : "אי-התאמה!");
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

            <RelayPanel relay={relay} />

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
                    <td className="py-1.5 font-mono text-[11px] text-zinc-500">{fmtInt(w.credits)}</td>
                  </tr>
                ))}
                {(world?.wallets ?? []).length === 0 && (
                  <tr><td colSpan={4} className="py-4 text-center text-zinc-600">אין-ארנקים — הפעל את הברז</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[10px] text-zinc-600">
            נכסי-העטיפה המוצגים: {Object.keys(st?.backing ?? {}).map((a) => `${a} (${fmtInt(st?.backing[a] ?? 0)})`).join(" · ") || "—"} · מלאי-הנכסים: {ASSETS.join(" · ")}
          </p>
        </Panel>
      </main>

      {/* ─── פוטר דביק — כנות-מלאה ─── */}
      <footer className="mt-auto border-t border-zinc-800 bg-zinc-950/95 pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-3 text-[11px] text-zinc-500">
          <div className="flex items-center gap-2">
            <Landmark className="h-3.5 w-3.5 text-amber-500/60" />
            <span>SAOS-DEX v1.1 · ספר-מדומה (SIM) — <strong className="text-zinc-400">אין כסף אמת, אין הבטחות תשואה</strong> · עיגון-חותמות חי על Steem/Hive (custom_json) ו-TRON מותנה-מימון</span>
          </div>
          <div className="flex items-center gap-3">
            <span>אימות-צד-שלישי בסיירים הציבוריים</span>
            <span className="font-mono">port 3010</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

// ─── System Health — סרגל-סטטוס מוסדי (סגול-עמוק = סטטוס-מערכת) ────────────
function SystemHealthPanel({ st, mempool, relay }: { st?: StateView; mempool: number; relay: RelayView | null }) {
  const engineLive = st ? (st.lastBlockAgoMs === null || st.lastBlockAgoMs < st.tickMs * 2.5) : false;
  const chainKeys = ["steem", "hive", "tron"] as const;
  const breakerTone = (s: string) => (s === "closed" ? "emerald" : s === "open" ? "rose" : "amber") as "emerald" | "rose" | "amber";
  return (
    <Panel title="System Health" icon={<Cpu className="h-4 w-4 text-violet-400" />} className="mb-4"
      action={<Pill tone={engineLive ? "violet" : "rose"}><StatusDot tone={engineLive ? "violet" : "rose"} pulse={engineLive} /> {engineLive ? "כל-המערכות תקינות" : "מנוע-מעוכב"}</Pill>}>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {/* מנוע-השרשרת */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            <StatusDot tone={engineLive ? "emerald" : "rose"} pulse={engineLive} /> מנוע-שרשרת
          </div>
          <div className="mt-1 font-mono text-sm font-bold text-violet-300" dir="ltr">{st ? `${fmtInt(st.tps)} TPS` : "…"}</div>
          <div className="text-[10px] text-zinc-500" dir="ltr">
            block {st && st.lastBlockAgoMs !== null ? `${(st.lastBlockAgoMs / 1000).toFixed(1)}s ago` : "—"} · build {st?.buildMs ?? "—"}ms
          </div>
        </div>
        {/* ממפול + ראיות */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            <StatusDot tone={st?.dbOk ? "emerald" : "rose"} /> ראיות-DB
          </div>
          <div className="mt-1 font-mono text-sm font-bold text-zinc-100" dir="ltr">mempool {fmtInt(mempool)}</div>
          <div className="text-[10px] text-zinc-500">{st?.dbOk ? "שרשור-האש נכתב ואומת" : "כתיבת-ראיות נכשלה"}</div>
        </div>
        {/* Relay */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            <StatusDot tone={relay?.enabled ? "emerald" : "zinc"} pulse={relay?.enabled} /> Relay
          </div>
          <div className="mt-1 flex items-center gap-2 font-mono text-sm font-bold text-zinc-100" dir="ltr">
            {chainKeys.map((k) => (
              <span key={k} className="flex items-center gap-1 text-[11px]">
                <StatusDot tone={relay?.chains[k].status === "anchored" ? "emerald" : relay?.chains[k].status === "pending" || relay?.chains[k].status === "idle" || relay?.chains[k].status === "sent-unconfirmed" ? "amber" : relay?.chains[k].status === "failed" ? "rose" : "zinc"} />
                {k[0].toUpperCase()}
              </span>
            ))}
            <span className="text-[10px] text-zinc-500">q{relay?.queue ?? 0}</span>
          </div>
          <div className="text-[10px] text-zinc-500" dir="ltr">
            anchored {relay ? fmtInt(chainKeys.reduce((a, k) => a + relay.chains[k].anchored, 0)) : "—"} · queue {relay?.queue ?? 0}
          </div>
        </div>
        {/* Circuit breakers */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Circuit Breakers</div>
          <div className="mt-1 flex items-center gap-2" dir="ltr">
            {chainKeys.map((k) => {
              const b = relay?.chains[k].breaker;
              return (
                <span key={k} className="flex items-center gap-1 font-mono text-[11px] font-bold">
                  <StatusDot tone={breakerTone(b?.state ?? "closed")} />
                  {k[0].toUpperCase()}:{b?.state ?? "—"}
                </span>
              );
            })}
          </div>
          <div className="text-[10px] text-zinc-500" dir="ltr">trips {relay ? fmtInt(relay.metrics.breakerTrips) : "—"} · econ-waits {relay ? fmtInt(relay.metrics.economicWaits) : "—"}</div>
        </div>
        {/* אימות-על-שרשרת */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">On-Chain Verify</div>
          <div className="mt-1 flex items-center gap-3 font-mono text-sm font-bold" dir="ltr">
            <span className="text-emerald-300">{relay ? fmtInt(relay.metrics.verified) : "—"}<span className="text-[10px] text-zinc-500"> ok</span></span>
            <span className={(relay?.metrics.mismatches ?? 0) > 0 ? "text-rose-300" : "text-zinc-100"}>{relay ? fmtInt(relay.metrics.mismatches) : "—"}<span className="text-[10px] text-zinc-500"> mismatch</span></span>
          </div>
          <div className="text-[10px] text-zinc-500" dir="ltr">
            latency {relay?.metrics.lastVerifyLatencyMs !== null && relay?.metrics.lastVerifyLatencyMs !== undefined ? `${fmtInt(relay.metrics.lastVerifyLatencyMs)}ms` : "—"}
          </div>
        </div>
      </div>
      {(relay && Object.values(relay.chains).some((c) => c.lastVerifyError)) && (
        <div className="mt-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 font-mono text-[10px] text-rose-300" dir="ltr">
          ALERT: {chainKeys.filter((k) => relay.chains[k].lastVerifyError).map((k) => `${k}: ${relay.chains[k].lastVerifyError}`).join(" · ").slice(0, 160)}
        </div>
      )}
    </Panel>
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
function BookTrade({ market, opWallet, busy, post, version }: {
  market?: MarketView; opWallet?: WalletView; busy: boolean; version: number | undefined;
  post: (url: string, body?: unknown) => Promise<{ ok: boolean; error?: string; note?: string }>;
}) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [price, setPrice] = useState("");
  const [amount, setAmount] = useState("100");
  const myOrders = useMyOrders(market?.key, version);
  /* מחיר-ברירת-מחדל נגזר (אין-effect): שדה-ריק = עוקב אחרי best bid/fair */
  const priceValue = price !== "" ? price : String(market?.bestBid || market?.fair || "");

  const priceMu = Math.floor(Number(priceValue));
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
        <input value={priceValue} onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ""))}
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
        הצב {side === "buy" ? "ביד" : "אסק"} {market?.base} @{priceValue || "—"}
      </GoldButton>
      {myOrders.length > 0 && (
        <div className="scroll-slim mt-2 max-h-24 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-900/70 p-1.5">
          {myOrders.map((o) => (
            <div key={o.id} className="flex items-center justify-between px-1 py-0.5 font-mono text-[10px]" dir="ltr">
              <span className={o.side === "buy" ? "text-emerald-400" : "text-rose-400"}>{o.side} {(o.price / 1000).toFixed(4)}</span>
              <span className="text-zinc-400">{fmt(o.amount - o.filled, 0)}</span>
              <button disabled={busy} onClick={() => void post("/api/dex/cancel", { orderId: o.id })}
                aria-label="בטל הזמנה"
                className="rounded border border-zinc-700 px-1.5 text-zinc-400 hover:border-rose-500/60 hover:text-rose-300">
                <X className="inline h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* הזמנות-שלי: נשלפות בכל-גרסת-עולם (מנוע-אירוע) — AbortController לניקוי-מלא */
function useMyOrders(marketKey: string | undefined, version: number | undefined) {
  const [orders, setOrders] = useState<{ id: number; base: string; quote: string; side: "buy" | "sell"; price: number; amount: number; filled: number }[]>([]);
  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        const r = await fetch("/api/dex/my-orders", { cache: "no-store", signal: ctrl.signal });
        const j = (await r.json()) as { ok: boolean; orders: typeof orders };
        if (!ctrl.signal.aborted && j.ok) setOrders(j.orders.filter((o) => !marketKey || `${o.base}/${o.quote}` === marketKey));
      } catch { /* aborted / idle */ }
    })();
    return () => ctrl.abort();
  }, [marketKey, version]);
  return orders;
}

// ─── עיגון-רשת (Relay) — חותמות ה-DEX עוגנות חי על Steem/Hive/TRON ──────────
const EXPLORER: Record<"steem" | "hive" | "tron", (tx: string) => string> = {
  steem: (tx) => `https://steemworld.org/tx/${tx}`,
  hive: (tx) => `https://hiveblocks.com/tx/${tx}`,
  tron: (tx) => `https://tronscan.org/#/transaction/${tx}`,
};
const CHAIN_LABEL: Record<"steem" | "hive" | "tron", string> = { steem: "Steem", hive: "Hive", tron: "TRON" };

function relayTone(status: string): "emerald" | "amber" | "rose" | "zinc" {
  if (status === "anchored") return "emerald";
  if (status === "pending" || status === "sent-unconfirmed") return "amber";
  if (status === "failed") return "rose";
  return "zinc";
}

function RelayPanel({ relay }: { relay: RelayView | null }) {
  const keys = ["steem", "hive", "tron"] as const;
  const anchored = keys.filter((k) => relay?.chains[k].status === "anchored").length;
  return (
    <Panel title="עיגון-רשת חי (Relay → Steem/Hive/TRON)" icon={<Anchor className="h-4 w-4 text-emerald-400" />}
      action={<Pill tone={relay?.enabled ? (anchored > 0 ? "emerald" : "amber") : "zinc"} pulse={relay?.enabled}>
        {relay?.enabled ? (anchored > 0 ? `חי · ${anchored}/3` : "מאזין") : "כבוי"}
      </Pill>}>
      <div className="space-y-2 text-xs">
        {relay && (
          <div className="flex items-center justify-between font-mono text-[10px] text-zinc-500" dir="ltr">
            <span>account @{relay.account ?? "—"} · id {relay.anchorId}</span>
            <span>queue {relay.queue} · broadcasts {fmtInt(relay.metrics.broadcasts)}</span>
          </div>
        )}
        {keys.map((k) => {
          const c = relay?.chains[k];
          const st = c?.status ?? "idle";
          const err = c?.lastError;
          const vErr = c?.lastVerifyError;
          return (
            <div key={k} className="rounded-md border border-zinc-800 bg-zinc-900/70 px-2.5 py-2" dir="ltr">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-[11px] font-bold text-zinc-300">
                  <StatusDot tone={st === "anchored" ? "emerald" : st === "pending" || st === "sent-unconfirmed" ? "amber" : st === "failed" ? "rose" : "zinc"} pulse={st === "pending"} />
                  {CHAIN_LABEL[k]}
                </span>
                <span className="flex items-center gap-1.5">
                  {st === "anchored" && c && (
                    <Pill tone={c.verified > 0 ? "emerald" : "amber"}>
                      {c.verified > 0 ? <Check className="h-3 w-3" /> : null}V {c.verified}{c.mismatches > 0 ? ` · M ${c.mismatches}` : ""}
                    </Pill>
                  )}
                  <Pill tone={relayTone(st)}>{st}</Pill>
                </span>
              </div>
              <div className="mt-1 font-mono text-[10px] text-zinc-500">
                {c?.lastTxid ? (
                  <>txid <a className="text-amber-300 underline decoration-dotted hover:text-amber-200" href={EXPLORER[k](c.lastTxid)} target="_blank" rel="noreferrer">{shortHash(c.lastTxid)}</a> · h{c.lastHeight ?? "?"}</>
                ) : (
                  <>אין-עיגון עדיין</>
                )}
                {k === "tron" && relay?.tronIdentity && <> · identity {shortHash(relay.tronIdentity)}</>}
                {c && <> · breaker {c.breaker.state}{c.breaker.trips > 0 ? ` (trips ${c.breaker.trips})` : ""}</>}
              </div>
              {err && <div className="mt-1 font-mono text-[10px] text-amber-300/80" dir="ltr">{err.slice(0, 90)}</div>}
              {vErr && <div className="mt-1 font-mono text-[10px] text-rose-300" dir="ltr">verify: {vErr.slice(0, 90)}</div>}
            </div>
          );
        })}
        {relay && relay.records.length > 0 && (
          <div className="scroll-slim max-h-32 overflow-y-auto rounded-md border border-zinc-800/70 bg-zinc-950/60 px-2 py-1.5 font-mono text-[10px] leading-relaxed" dir="ltr">
            {relay.records.slice(0, 8).map((r, i) => (
              <div key={`${r.chain}-${r.height}-${r.at}-${i}`} className="flex items-center justify-between gap-2">
                <span className="text-zinc-500">{CHAIN_LABEL[r.chain]} h{r.height}</span>
                <span className={r.status === "anchored" ? "text-emerald-300" : r.status === "pending" ? "text-amber-300" : "text-rose-300"}>
                  {r.status}{r.txid ? ` · ${r.txid.slice(0, 12)}…` : ""}{r.attempt > 1 ? ` · try${r.attempt}` : ""}
                  {r.status === "anchored" && r.verified !== null && (r.verified ? " · V" : " · verify-FAIL")}
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="text-[10px] leading-relaxed text-zinc-600">
          כל חותם (כל-12 בלוקים) נשלח כ-custom_json בסמכות-active (אפס-עלות, RC) ל-Steem+Hive — חתימה מקומית, אימות-צד-שלישי בסיירים.
          אחרי-כל-txid מבוצעת קריאה-חוזרת ל-RPC: השוואת stateRoot על-השרשרת מול-המקומי (V = אומת). Circuit breaker per-chain עם backoff-אקספוננציאלי.
          TRON: זהות נגזרת מאותו סקלר — עיגון מתחיל עם מימון-bandwidth.
        </p>
      </div>
    </Panel>
  );
}

// ─── סוואג' (AMM) ───────────────────────────────────────────────────────────
function SwapPanel({ market, pools, opWallet, busy, post, version }: {
  market?: MarketView; pools: PoolView[]; opWallet?: WalletView; busy: boolean; version: number | undefined;
  post: (url: string, body?: unknown) => Promise<{ ok: boolean; error?: string; note?: string }>;
}) {
  const [pair, setPair] = useState<string>("");
  const [dir, setDir] = useState<"a2b" | "b2a">("a2b");
  const [amount, setAmount] = useState("1000");
  const [quote, setQuote] = useState<{ out: number; price: number; minOut0: number } | null>(null);

  /* הבריכה הפעילה נגזרת (אין-effect): ברירת-מחדל = זו-של-הזוג הנבחר, אחרת הראשונה */
  const activeKey = pair || pools.find((x) => x.key === market?.key)?.key || pools[0]?.key || "";
  const pool = useMemo(() => pools.find((p) => p.key === activeKey), [pools, activeKey]);

  const assetIn = pool ? (dir === "a2b" ? pool.a : pool.b) : "";
  const assetOut = pool ? (dir === "a2b" ? pool.b : pool.a) : "";
  const amountMu = Math.floor(Number(amount) * 1000);

  /* ציטוט-חד-פעמי-ציטוט: מתרענן עם כל-גרסת-עולם (אין-שהייה מלאכותית).
   * setState רק בקולבק-אסינכרוני; ה-null-גזירה מחוץ-ל-effect. */
  useEffect(() => {
    if (!pool || !(amountMu > 0) || !assetIn) return;
    const ctrl = new AbortController();
    (async () => {
      try {
        const r = await fetch(`/api/dex/swap?pair=${encodeURIComponent(pool.key)}&assetIn=${assetIn}&amount=${amountMu}`, { cache: "no-store", signal: ctrl.signal });
        const j = (await r.json()) as { ok: boolean; out: number; price: number; minOut0: number };
        if (!ctrl.signal.aborted) setQuote(j.ok ? { out: j.out, price: j.price, minOut0: j.minOut0 } : null);
      } catch { /* aborted / idle */ }
    })();
    return () => ctrl.abort();
  }, [pool, assetIn, amountMu, version]);
  const quoteView = pool && amountMu > 0 && assetIn ? quote : null;

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
          <GoldButton tone="ghost" onClick={() => setDir(dir === "a2b" ? "b2a" : "a2b")} aria-label="היפוך-כיוון">
            <ArrowLeftRight className="inline h-3.5 w-3.5" /> {assetIn}→{assetOut}
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
            {quoteView ? `${fmt(quoteView.out, 2)} ${assetOut}` : "—"}
          </span>
        </div>
        <div className="flex items-center justify-between px-1 text-[10px] text-zinc-500">
          <span>עמלה 30bps (70% LP · 30% אוצר)</span>
          <span dir="ltr">{quoteView ? `slip-guard: min ${fmt(quoteView.minOut0, 2)}` : ""}</span>
        </div>
        <GoldButton
          className="w-full" disabled={busy || !quoteView || !(amountMu > 0) || have < amountMu}
          onClick={() => void post("/api/dex/swap", { pair: pool?.key, assetIn, amount: amountMu, minOut: quoteView?.minOut0 })}>
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
  /* הבריכה הפעילה נגזרת (אין-effect) */
  const activeKey = sel || pools[0]?.key || "";
  const pool = pools.find((p) => p.key === activeKey);
  const lpKey = pool ? `LP|${pool.key}` : "";
  const myLp = opWallet?.balances[lpKey] ?? 0;
  const amountMu = Math.floor(Number(amountA) * 1000);
  const needB = pool && pool.ra > 0 ? Math.floor((pool.rb * amountMu) / pool.ra) : 0;

  return (
    <Panel title="בריכות-זרימה (DEX-98)" icon={<Bot className="h-4 w-4 text-emerald-400" />}>
      <div className="space-y-2">
        {pools.map((p) => (
          <button key={p.key} onClick={() => setSel(p.key)}
            className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-right transition-colors ${activeKey === p.key ? "border-amber-500/60 bg-amber-500/10" : "border-zinc-800 bg-zinc-900/60 hover:border-zinc-700"}`}>
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
  /* נגזרת-טהורה: עריכה-מקומית עד-שהיא קיימת, אחרת פרמטרי-השרת (אין-effect) */
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
          {cur.enabled ? <><StatusDot tone="emerald" pulse /> פועל</> : <><StatusDot tone="zinc" /> כבוי</>}
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
