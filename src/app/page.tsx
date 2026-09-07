"use client";

/**
 * page.tsx — SAOS-DEX Sovereign Terminal · מהדורת Zero-Tolerance Visual Overhaul.
 *
 * ארכיטקטורת-תצוגה (מאומתת-DOM, אפס-אימוג'ים, zinc-950 מוסדי):
 *  · Header: לוגו טקסטואלי · מחיר-חי גדל (monospace) · נורת-מערכת ירוקה/אדומה
 *  · 3-טורי מחייב: שמאל 20% Watchlist · מרכז 50% גרף+ספר · ימין 30% מסחר+בריאות
 *  · גרף lightweight-charts — canvas חי, testid=lightweight-charts-container,
 *    כשל-רינדור = "CHART FAILED TO RENDER" אדום בולט + console.error
 *  · ספר-הזמנות: פסי-עומק מילוליים bg-green-500/10 (bids) / bg-red-500/10 (asks),
 *    testid=orderbook-row לכל-שורה
 *  · System Health: TPS · breakers ירוקים "CLOSED" · Verified Anchors ב-text-purple-400,
 *    testid=system-health-panel
 *  · טופס-מסחר: BUY/SELL על bg-green-600/bg-red-600 · אימות-קלט · Slippage Guard ויזואלי
 *
 * הערה-רשת: כל-קריאות-ה-API עוברות דרך קידומת-/saos-dex — השרת-האם מגשר לדמון-3010
 * (rewrite). כל-הנכסים (JS/CSS) נטענים מהאפליקציה-הראשית עצמה — 200 מובטח, אין-תלות
 * ב-basePath לטעינת-נכסים.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, Anchor, ArrowDownRight, ArrowUpRight, Ban, Bot, Coins, Layers, Landmark, List,
  RefreshCcw, ShieldCheck, Wallet, Zap, Waves, GaugeCircle,
} from "lucide-react";
import { GoldButton, Panel, Pill, StatusDot, Stat, fmt, fmtInt, shortHash } from "@/components/dex/kit";
import { PriceChart } from "@/components/dex/chart";

/** קידומת-הגשר — כל-קריאת-רשת עוברת דרכה אל דמון-3010 */
const BASE = "/saos-dex";
const api = (p: string): string => `${BASE}${p}`;

// ─── טיפוסים (מראה-API — זהה ל-server) ──────────────────────────────────────
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
interface TapeEv { kind: string; base: string; quote: string; price: number; amountMu: number; taker: string; maker?: string; at: number; h: number }
interface SealInfo { fromHeight: number; toHeight: number; root: string; stateRoot: string; leaves: number; at: number; digest: string }
interface StateView {
  height: number; tps: number; stateRoot: string; gasUsed: number; opsTotal: number; fills: number; swaps: number;
  ladders: number; treasuryProfit: number; feeMeter: number;
  ladder: { refPrice: number; lifts: number; lastLiftHeight: number; spentMu: number; stepCostMu: number };
  liveOrders: number; buildMs: number; uptimeSec: number; lastBlockAgoMs: number | null;
  dbOk: boolean; halted: boolean; tickMs: number; sealEvery: number; nextSealIn: number;
  backing: Record<string, number>; assets: Record<string, { refPrice: number }>;
}
interface ArenaParams { enabled: boolean; noise: boolean }
interface WorldResp {
  ok: boolean;
  version: number;
  state: StateView;
  markets: MarketView[];
  pools: PoolView[];
  wallets: WalletView[];
  arena: { params: ArenaParams; mempool: number };
  proofs: { seals: SealInfo[]; receipts: { kind: string; digest: string; at: number }[]; blockWindow: number };
  tape: TapeEv[];
}
type RelayChain = "steem" | "hive" | "tron" | "eth" | "sol";
interface RelayRecord { chain: RelayChain; height: number; status: string; txid: string | null; at: string; attempt: number; verified: boolean | null; verifiedAt: string | null; error?: string }
interface RelayView {
  enabled: boolean; account: string | null; anchorId: string; queue: number; tronIdentity: string | null;
  identities?: { eth: string | null; sol: string | null };
  ethIntents?: { height: number; intentHash: string; signature: string; address: string; verified: boolean }[];
  metrics: { broadcasts: number; verified: number; mismatches: number; breakerTrips: number; economicWaits: number; lastVerifyLatencyMs: number | null };
  chains: Record<RelayChain, {
    enabled: boolean; status: string; lastTxid: string | null; lastHeight: number | null; lastAt: string | null;
    lastError: string | null; lastVerifyError: string | null; anchored: number; verified: number; mismatches: number;
    breaker: { state: "closed" | "open" | "half-open"; failures: number; openedAt: number | null; trips: number };
  }>;
  records: RelayRecord[];
}
interface MyOrder { id: number; base: string; quote: string; side: "buy" | "sell"; price: number; amount: number; filled: number }

/* ══ מנוע-זרימה: long-polling מבוסס-אירוע + AbortController ══════════════════
 * הלקוח תולה בקשה עם הגרסה-המקומית; השרת משיב רק כשהשרשרת התקדמה (או keepalive
 * כל-12ש׳). אפס-סקר-תקופתי — עדכון עם-כל-בלוק. */
function useWorldStream(): { world: WorldResp | null; load: () => Promise<void> } {
  const [world, setWorld] = useState<WorldResp | null>(null);
  const versionRef = useRef(0);
  const ctrlRef = useRef<AbortController | null>(null);
  const [gen, setGen] = useState(0);

  // רענון-מיידי אחרי-פעולת-משתמש: נתק את ה-long-poll, קבל תמונה, החזר את הלולאה
  const load = useCallback(async () => {
    ctrlRef.current?.abort();
    try {
      const r = await fetch(api("/api/dex/state"), { cache: "no-store" });
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
          const r = await fetch(api(`/api/dex/state?v=${versionRef.current}`), { cache: "no-store", signal: ctrl.signal });
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
function useRelayStream(version: number | undefined): RelayView | null {
  const [relay, setRelay] = useState<RelayView | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        const r = await fetch(api("/api/dex/relay"), { cache: "no-store", signal: ctrl.signal });
        const j = (await r.json()) as { ok: boolean; relay: RelayView };
        if (j.ok) setRelay(j.relay);
      } catch { /* aborted / idle */ }
    })();
    return () => ctrl.abort();
  }, [version]);
  return relay;
}

/* ══ הזמנות-operator (לניהול-פקודות וביטול) ═════════════════════════════════ */
function useMyOrders(version: number | undefined): MyOrder[] {
  const [orders, setOrders] = useState<MyOrder[]>([]);
  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        const r = await fetch(api("/api/dex/my-orders"), { cache: "no-store", signal: ctrl.signal });
        const j = (await r.json()) as { ok: boolean; orders: MyOrder[] };
        if (j.ok) setOrders(j.orders);
      } catch { /* aborted */ }
    })();
    return () => ctrl.abort();
  }, [version]);
  return orders;
}

// ─── עזרי-מסחר ──────────────────────────────────────────────────────────────
const MU = 1000;

/** הליכה-על-הספר: מחיר-ממוצע-משוער + slippage-bps מול-הטוב-ביותר (הערכת-אמת) */
function walkSlippage(
  levels: { price: number; total: number }[], amountMu: number, side: "buy" | "sell"
): { avgPx: number; slipBps: number; covered: boolean } | null {
  if (levels.length === 0 || !(amountMu > 0)) return null;
  let need = amountMu, cost = 0, filled = 0;
  for (const lv of levels) {
    const take = Math.min(need, lv.total);
    cost += take * lv.price;
    filled += take;
    need -= take;
    if (need <= 0) break;
  }
  if (filled <= 0) return null;
  const avgPx = Math.floor(cost / filled);
  const best = levels[0]?.price ?? 0;
  if (best <= 0) return null;
  const slipBps = Math.floor((Math.abs(avgPx - best) / best) * 10_000);
  return { avgPx, slipBps, covered: need <= 0 };
}

/** צבע-מד-החלקה: ירוק<50bps · ענבר<150bps · אדום≥150bps (טונים מילוליים) */
const slipTone = (bps: number): "green" | "amber" | "red" => (bps < 50 ? "green" : bps < 150 ? "amber" : "red");
const slipColor = (tone: "green" | "amber" | "red"): string =>
  tone === "green" ? "bg-green-500" : tone === "amber" ? "bg-amber-500" : "bg-red-500";

/** שינוי-אחוזי מול מחיר-ייחוס — ירוק/אדום מילולי */
function changePct(fair: number, ref: number): number {
  if (!(ref > 0) || !(fair > 0)) return 0;
  return ((fair - ref) / ref) * 100;
}

// ─── טור-שמאל 20%: רשימת-שווקים (Watchlist) ─────────────────────────────────
function Watchlist({ markets, selected, onSelect }: {
  markets: MarketView[]; selected: string | undefined; onSelect: (key: string) => void;
}) {
  return (
    <div className="space-y-2" data-testid="watchlist-panel">
      {markets.map((m) => {
        const chg = changePct(m.fair, m.refPrice);
        const up = chg >= 0;
        const active = m.key === selected;
        return (
          <button
            key={m.key} type="button" onClick={() => onSelect(m.key)}
            className={`block w-full rounded-lg border px-3 py-2 text-right transition-colors ${active ? "border-amber-500/60 bg-zinc-800/70" : "border-zinc-800 bg-zinc-900/40 hover:border-zinc-700"}`}
          >
            <div className="flex items-center justify-between gap-2" dir="ltr">
              <span className="font-mono text-xs font-black text-zinc-100">{m.key}</span>
              <span className={`font-mono text-xs font-bold ${up ? "text-green-400" : "text-red-400"}`} data-testid="watchlist-change">
                {up ? "+" : ""}{chg.toFixed(2)}%
              </span>
            </div>
            <div className="mt-0.5 flex items-center justify-between gap-2" dir="ltr">
              <span className="font-mono text-sm font-bold text-amber-400">{m.fair > 0 ? fmt(m.fair, 2) : "—"}</span>
              <span className={`font-mono text-[10px] ${m.spreadBps > 0 ? "text-zinc-500" : "text-red-400"}`}>
                spread {m.spreadBps}bps
              </span>
            </div>
          </button>
        );
      })}
      {markets.length === 0 && (
        <p className="py-4 text-center font-mono text-[11px] text-zinc-600">מתחבר למנוע…</p>
      )}
      <p className="px-1 pt-1 text-[10px] leading-snug text-zinc-600">
        שינוי% מחושב מול מחיר-הייחוס של סולם-הערך. הזמנה = לחיצה על שוק.
      </p>
    </div>
  );
}

// ─── פאנל: System Health & Relay (testid=system-health-panel) — טור-ימין ────
function SystemHealthPanel({ st, relay, mempool }: { st: StateView | undefined; relay: RelayView | null; mempool: number }) {
  const breakers = relay ? (["steem", "hive", "tron", "eth", "sol"] as const).map((c) => relay.chains[c]?.breaker.state).filter((s): s is "closed" | "open" | "half-open" => !!s) : [];
  const breakerOpen = breakers.includes("open");
  const breakerHalf = breakers.includes("half-open");
  const mismatched = (relay?.metrics.mismatches ?? 0) > 0;
  const halted = st?.halted === true;

  // נורת-מערכת: ירוק = תקין · ענבר = ירידה-מבוקרת · אדום = זעקה
  const sysTone: "green" | "amber" | "red" =
    halted || breakerOpen || mismatched ? "red" : (st?.dbOk === false || breakerHalf) ? "amber" : "green";
  const sysText = halted ? "CHAIN HALTED" : breakerOpen ? "BREAKER OPEN" : mismatched ? "VERIFY ALERT" : (st?.dbOk === false || breakerHalf) ? "DEGRADED" : "NOMINAL";

  const chainDot = (status: string): "green" | "amber" | "zinc" =>
    status === "anchored" ? "green" : status === "failed" ? "amber" : status === "pending" ? "amber" : "zinc";
  const breakerChip = (s: string): string =>
    s === "closed" ? "border-green-500/40 bg-green-500/10 text-green-300" : s === "half-open" ? "border-amber-500/40 bg-amber-500/10 text-amber-300" : "border-red-500/40 bg-red-500/10 text-red-300";

  return (
    <section
      data-testid="system-health-panel"
      data-sys={sysText.toLowerCase()}
      className="rounded-xl border border-violet-500/30 bg-violet-500/[0.04] p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-bold tracking-wide text-violet-200">
          <GaugeCircle className="h-4 w-4 text-violet-300" />
          SYSTEM HEALTH
        </h2>
        <div className="flex items-center gap-2">
          <StatusDot tone={sysTone} pulse={sysTone !== "green"} />
          <span className={`font-mono text-xs font-black tracking-widest ${sysTone === "green" ? "text-green-300" : sysTone === "amber" ? "text-amber-300" : "text-red-300"}`}>
            {sysText}
          </span>
        </div>
      </div>

      {halted && (
        <div className="mt-2 rounded-lg border border-red-500/50 bg-red-500/10 px-3 py-2 font-mono text-xs font-black text-red-300" role="alert">
          INVARIANT VIOLATION — CHAIN HALTED (fail-fast). אף-פעולה לא תתקבל עד-חקירה.
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Stat label="TPS (LIVE)" value={st ? fmtInt(st.tps) : "…"} sub={`build ${st?.buildMs ?? "…"}ms · mempool ${fmtInt(mempool)}`} tone="text-violet-200" />
        <Stat label="BLOCK HEIGHT" value={st ? fmtInt(st.height) : "…"} sub={halted ? "HALTED" : `tick ${st ? st.tickMs / 1000 : 3}s`} tone={halted ? "text-red-300" : "text-zinc-100"} />
        <Stat label="VERIFIED ANCHORS" value={relay ? fmtInt(relay.metrics.verified) : "…"} sub={`broadcasts ${fmtInt(relay?.metrics.broadcasts ?? 0)}`} tone="text-purple-400" />
        <Stat label="MISMATCHES" value={relay ? fmtInt(relay.metrics.mismatches) : "…"} sub={mismatched ? "דורש-בדיקה מיידית" : "אפס — עקביות-מלאה"} tone={mismatched ? "text-red-300" : "text-green-300"} />
      </div>

      <div className="mt-2 space-y-1.5" dir="ltr">
        {relay ? (["steem", "hive", "tron", "eth", "sol"] as const).map((c) => {
          const ch = relay.chains[c];
          if (!ch) return null; // שרת-ישן ללא-השרשראות-החדשות — לא קורסים
          const last = relay.records.find((r) => r.chain === c && r.txid);
          const pendingFunding = ch.enabled && /unfunded/i.test(ch.lastError ?? "");
          const armedIdle = ch.enabled && ch.status === "idle";
          return (
            <div key={c} className="rounded-lg border border-zinc-800 bg-zinc-900/70 px-2.5 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 font-mono text-[11px] font-black uppercase tracking-wider text-zinc-200">
                  <StatusDot tone={chainDot(ch.status)} pulse={ch.status === "pending"} /> {c}
                </span>
                <span className={`rounded-full border px-2 py-0.5 font-mono text-[9px] font-bold uppercase ${breakerChip(ch.breaker.state)}`}>
                  breaker: {ch.breaker.state}
                </span>
              </div>
              {pendingFunding && (
                <div className="mt-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-amber-300" dir="ltr">
                  pending funding — armed (signing live, broadcast gated)
                </div>
              )}
              {armedIdle && (
                <div className="mt-1 rounded border border-green-500/40 bg-green-500/10 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-green-300" dir="ltr">
                  armed — identity loaded
                </div>
              )}
              <div className="mt-1 flex items-center justify-between gap-2 font-mono text-[10px] text-zinc-500">
                <span>{ch.anchored} anchored · {ch.verified} verified</span>
                {last?.txid && (
                  <a
                    href={c === "steem" ? `https://steemworld.org/tx/${last.txid}`
                      : c === "hive" ? `https://hiveblocks.com/tx/${last.txid}`
                      : c === "tron" ? `https://tronscan.org/#/transaction/${last.txid}`
                      : c === "eth" ? `https://etherscan.io/tx/${last.txid}`
                      : `https://explorer.solana.com/tx/${last.txid}?cluster=devnet`}
                    target="_blank" rel="noreferrer"
                    className="text-amber-400 underline-offset-2 hover:underline"
                  >
                    {shortHash(last.txid, 8)}
                  </a>
                )}
              </div>
            </div>
          );
        }) : (
          <div className="py-2 text-center font-mono text-[11px] text-zinc-600">relay telemetry connecting…</div>
        )}
      </div>

      {relay?.identities && (relay.identities.eth || relay.identities.sol) && (
        <div className="mt-2 space-y-0.5 rounded-lg border border-zinc-800 bg-zinc-900/40 px-2.5 py-1.5 font-mono text-[9px] text-zinc-500" dir="ltr">
          <div className="font-bold uppercase tracking-widest text-zinc-400">fleet identities (anchored manifest)</div>
          {relay.identities.eth && <div className="truncate">eth {relay.identities.eth}</div>}
          {relay.identities.sol && <div className="truncate">sol {relay.identities.sol}</div>}
          {relay.ethIntents && relay.ethIntents.length > 0 && (
            <div className="truncate text-violet-300/80">eip-191 intent h{relay.ethIntents[0].height} · sig verified: {String(relay.ethIntents[0].verified)}</div>
          )}
        </div>
      )}

      <p className="mt-2 font-mono text-[10px] text-zinc-600" dir="ltr">
        breaker trips {relay ? fmtInt(relay.metrics.breakerTrips) : "…"} · econ waits {relay ? fmtInt(relay.metrics.economicWaits) : "…"} · queue {relay ? fmtInt(relay.queue) : "…"}
      </p>
    </section>
  );
}

// ─── פאנל: ספר-הזמנות ויזואלי (testid=orderbook-row לכל-שורה) ───────────────
// דרישה-מילולית: bids עם bg-green-500/10 · asks עם bg-red-500/10 + פסי-עומק
function OrderBook({ market }: { market: MarketView | undefined }) {
  const asks = useMemo(() => [...(market?.asks ?? [])].sort((a, b) => b.price - a.price), [market]);
  const bids = useMemo(() => [...(market?.bids ?? [])].sort((a, b) => b.price - a.price), [market]);
  const maxTotal = useMemo(
    () => Math.max(1, ...asks.map((a) => a.total), ...bids.map((b) => b.total)),
    [asks, bids]
  );

  const Row = ({ px, total, orders, side }: { px: number; total: number; orders: number; side: "bid" | "ask" }) => (
    <tr data-testid="orderbook-row" data-side={side} className="relative border-b border-zinc-800/40 last:border-0">
      <td className={`relative z-0 w-full py-1.5 ${side === "bid" ? "bg-green-500/10" : "bg-red-500/10"}`} colSpan={3}>
        {/* פס-עומק — ממחיש את הנזילות ברמה-הזאת */}
        <span
          aria-hidden
          className={`absolute inset-y-0 right-0 rounded-sm ${side === "bid" ? "bg-green-500/10" : "bg-red-500/10"}`}
          style={{ width: `${Math.max(4, Math.round((total / maxTotal) * 100))}%` }}
        />
        <span
          aria-hidden
          className={`absolute inset-y-0 right-0 rounded-sm ${side === "bid" ? "border-r-2 border-green-400/60" : "border-r-2 border-red-400/60"}`}
          style={{ width: `${Math.max(4, Math.round((total / maxTotal) * 100))}%` }}
        />
        <div className="relative z-10 flex items-center justify-between gap-2 px-2 font-mono text-[11px]">
          <span className={side === "bid" ? "font-bold text-green-300" : "font-bold text-red-300"}>{fmtInt(px)}</span>
          <span className="text-zinc-200">{fmt(total, 0)}</span>
          <span className="w-8 text-left text-zinc-500">{orders}</span>
        </div>
      </td>
    </tr>
  );

  return (
    <div>
      <div className="flex items-center justify-between px-2 pb-1 font-mono text-[10px] uppercase tracking-wider text-zinc-600">
        <span>price</span><span>total (base)</span><span>orders</span>
      </div>
      <div className="scroll-slim max-h-64 overflow-y-auto" dir="ltr">
        <table className="w-full border-separate border-spacing-0">
          <tbody>
            {asks.map((a) => <Row key={`a-${a.price}`} px={a.price} total={a.total} orders={a.orders} side="ask" />)}
          </tbody>
        </table>
      </div>
      {/* שורת-הפרש-מרכזית */}
      <div className="my-1.5 flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900/80 px-3 py-1.5 font-mono text-xs" dir="ltr">
        <span className="text-zinc-500">spread</span>
        <span className={`font-bold ${(market?.spreadBps ?? 0) > 0 ? "text-amber-300" : "text-red-400"}`}>
          {market ? `${market.spreadBps} bps` : "—"}
        </span>
      </div>
      <div className="scroll-slim max-h-64 overflow-y-auto" dir="ltr">
        <table className="w-full border-separate border-spacing-0">
          <tbody>
            {bids.map((b) => <Row key={`b-${b.price}`} px={b.price} total={b.total} orders={b.orders} side="bid" />)}
          </tbody>
        </table>
        {(asks.length === 0 && bids.length === 0) && (
          <div className="py-6 text-center font-mono text-[11px] text-zinc-600">book is empty — waiting for live quotes</div>
        )}
      </div>
    </div>
  );
}

// ─── פאנל: טופס-מסחר (testid=trading-form) עם Slippage Guard ויזואלי ────────
function TradeForm({ market, opWallet, busy, post, onDone }: {
  market: MarketView | undefined;
  opWallet: WalletView | undefined;
  busy: boolean;
  post: (url: string, body?: unknown) => Promise<void>;
  onDone: () => void;
}) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [marketOrder, setMarketOrder] = useState(false);
  const [priceIn, setPriceIn] = useState("");
  const [amountIn, setAmountIn] = useState("");

  // מחיר-אפקטיבי נגזר ברנדור (בלי-effect): אם-השדה-ריק → ברירת-מחדל-חכמה = מחיר-הצד-השני
  const defaultPx = side === "buy" ? market?.bestAsk ?? 0 : market?.bestBid ?? 0;
  const effPx = priceIn !== "" ? Number(priceIn) || 0 : marketOrder ? 0 : defaultPx;

  const px = Math.floor(effPx);
  const amtUnits = Number(amountIn) || 0;
  const amtMu = Math.floor(amtUnits * MU);
  const notionalMu = Math.floor((px * amtMu) / MU);

  const payAsset = side === "buy" ? market?.quote ?? "USDS" : market?.base ?? "SAOS";
  const availMu = opWallet ? (opWallet.balances[payAsset] ?? 0) - (opWallet.locked[payAsset] ?? 0) : 0;
  const obligationMu = side === "buy" ? notionalMu : amtMu;

  // אימות-קלט (fail-closed ויזואלי — הכפתור ננעל עד-תקינות)
  const errors: string[] = [];
  if (!market) errors.push("no market selected");
  if (amtMu <= 0) errors.push("amount must be > 0");
  if (!marketOrder && px <= 0) errors.push("price must be > 0");
  if (marketOrder && side === "buy" && (market?.bestAsk ?? 0) <= 0 && (market?.bids.length ?? 0) === 0) errors.push("no liquidity to walk");
  if (obligationMu > availMu) errors.push(`insufficient ${payAsset}: need ${fmt(obligationMu, 0)}, avail ${fmt(availMu, 0)}`);
  const valid = errors.length === 0;

  // Slippage Guard — הערכת-אמת מהליכה-על-הספר:
  const walk = useMemo(() => {
    if (!market) return null;
    if (marketOrder) {
      const levels = side === "buy" ? market.asks : market.bids;
      return walkSlippage(levels, amtMu, side);
    }
    // limit: המרחק מהשוק = הגנה (מילוי רק-במחיר-שלך או-טוב-ממנו)
    const best = side === "buy" ? market.bestAsk : market.bestBid;
    if (!best || !px) return null;
    const bps = Math.floor(((side === "buy" ? best - px : px - best) / best) * 10_000);
    return { avgPx: px, slipBps: Math.max(0, bps), covered: true };
  }, [market, marketOrder, side, px, amtMu]);

  const guardTone = walk ? slipTone(walk.slipBps) : "green";
  const guardPct = Math.min(100, Math.round((walk?.slipBps ?? 0) / 2)); // סקאלה 0–200bps

  const submit = async () => {
    if (!valid || !market) return;
    await post(api("/api/dex/order"), {
      action: marketOrder ? "fill" : "order",
      base: market.base, quote: market.quote, side,
      price: marketOrder ? undefined : px,
      amount: amtMu,
    });
    setAmountIn("");
    onDone();
  };

  return (
    <div data-testid="trading-form" data-side={side} data-ordertype={marketOrder ? "market" : "limit"}>
      {/* מתגי-side — ירוק/אדום מילוליים */}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button" onClick={() => setSide("buy")}
          className={`flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-black transition-colors ${side === "buy" ? "border-green-500/60 bg-green-500/15 text-green-300" : "border-zinc-800 bg-zinc-900/60 text-zinc-500 hover:border-green-500/30"}`}
        >
          <ArrowUpRight className="h-4 w-4" /> BUY
        </button>
        <button
          type="button" onClick={() => setSide("sell")}
          className={`flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-black transition-colors ${side === "sell" ? "border-red-500/60 bg-red-500/15 text-red-300" : "border-zinc-800 bg-zinc-900/60 text-zinc-500 hover:border-red-500/30"}`}
        >
          <ArrowDownRight className="h-4 w-4" /> SELL
        </button>
      </div>

      {/* מתגי-סוג-פקודה */}
      <div className="mt-2 grid grid-cols-2 gap-2">
        <button type="button" onClick={() => setMarketOrder(false)}
          className={`rounded-md border px-2 py-1 text-[11px] font-bold ${!marketOrder ? "border-amber-500/50 bg-amber-500/10 text-amber-300" : "border-zinc-800 text-zinc-500"}`}>
          LIMIT
        </button>
        <button type="button" onClick={() => setMarketOrder(true)}
          className={`rounded-md border px-2 py-1 text-[11px] font-bold ${marketOrder ? "border-amber-500/50 bg-amber-500/10 text-amber-300" : "border-zinc-800 text-zinc-500"}`}>
          MARKET
        </button>
      </div>

      {/* שדות */}
      <div className="mt-3 space-y-2">
        {!marketOrder && (
          <label className="block">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">מחיר ({market?.quote ?? "quote"}, µ)</span>
            <input
              value={priceIn} onChange={(e) => setPriceIn(e.target.value.replace(/[^\d]/g, ""))} inputMode="numeric" dir="ltr"
              className="mt-0.5 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-amber-500/60"
              placeholder={String(market?.bestAsk ?? "")}
            />
          </label>
        )}
        <label className="block">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">כמות ({market?.base ?? "base"}, יחידות)</span>
          <input
            value={amountIn} onChange={(e) => setAmountIn(e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal" dir="ltr"
            className="mt-0.5 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-amber-500/60"
            placeholder="0.00"
          />
        </label>
      </div>

      {/* שורת-חשבון */}
      <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-[11px]">
        <div className="rounded-md border border-zinc-800 bg-zinc-900/70 px-2.5 py-1.5">
          <div className="text-[9px] uppercase tracking-wider text-zinc-600">notional</div>
          <div className="text-zinc-200">{fmtInt(notionalMu)} {market?.quote ?? ""}</div>
        </div>
        <div className="rounded-md border border-zinc-800 bg-zinc-900/70 px-2.5 py-1.5">
          <div className="text-[9px] uppercase tracking-wider text-zinc-600">avail {payAsset}</div>
          <div className={obligationMu > availMu ? "text-red-400" : "text-zinc-200"}>{fmt(Math.max(0, availMu), 0)}</div>
        </div>
      </div>

      {/* ── Slippage Guard ויזואלי ── */}
      <div className="mt-2 rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2" data-testid="slippage-guard" data-tone={guardTone}>
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
            <ShieldCheck className="h-3.5 w-3.5 text-amber-400" /> Slippage Guard
          </span>
          <span className={`font-mono text-xs font-black ${guardTone === "green" ? "text-green-300" : guardTone === "amber" ? "text-amber-300" : "text-red-300"}`}>
            {walk ? `${walk.slipBps} bps` : "—"}
          </span>
        </div>
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800" dir="ltr">
          <div className={`h-full rounded-full transition-all ${slipColor(guardTone)}`} style={{ width: `${Math.max(3, guardPct)}%` }} />
        </div>
        <p className="mt-1 text-[10px] leading-snug text-zinc-500">
          {marketOrder
            ? `הערכת-הליכה-על-הספר · מחיר-ממוצע משוער ${walk ? fmtInt(walk.avgPx) : "—"} ${market?.quote ?? ""}${walk && !walk.covered ? " · נזילות-לא-מספקת לכל-הכמות" : ""}`
            : "פקודת-לימיט = הגנה-מלאה: מילוי רק-במחיר-שלך או-טוב-ממנו, לעולם לא גרוע"}
        </p>
      </div>

      {/* שגיאות-אימות */}
      {errors.length > 0 && (
        <ul className="mt-2 space-y-0.5" data-testid="form-errors">
          {errors.map((e) => <li key={e} className="font-mono text-[10px] text-red-400">— {e}</li>)}
        </ul>
      )}

      {/* כפתור-ביצוע גדול: bg-green-600 / bg-red-600 מילוליים */}
      <GoldButton
        tone={side === "buy" ? "green" : "red"}
        disabled={!valid || busy}
        onClick={() => void submit()}
        className="mt-3 w-full py-3 text-base"
        testid="trade-submit"
      >
        {side === "buy" ? "BUY" : "SELL"} {market ? `${market.base}` : ""} {marketOrder ? "· MARKET" : `· LIMIT ${fmtInt(px)}`}
      </GoldButton>
    </div>
  );
}

// ─── פאנל: הזמנות-פתוחות שלי ────────────────────────────────────────────────
function MyOrders({ orders, busy, post, onDone }: {
  orders: MyOrder[]; busy: boolean; post: (url: string, body?: unknown) => Promise<void>; onDone: () => void;
}) {
  if (orders.length === 0) return <p className="py-2 text-center font-mono text-[11px] text-zinc-600">אין פקודות-לימיט פתוחות</p>;
  return (
    <div className="scroll-slim max-h-40 overflow-y-auto" dir="ltr">
      <table className="w-full text-left font-mono text-[11px]">
        <tbody>
          {orders.map((o) => (
            <tr key={o.id} className="border-b border-zinc-800/50">
              <td className={`py-1.5 font-bold ${o.side === "buy" ? "text-green-300" : "text-red-300"}`}>{o.side.toUpperCase()}</td>
              <td className="py-1.5 text-zinc-300">{fmtInt(o.price)}</td>
              <td className="py-1.5 text-zinc-400">{fmt(o.amount - o.filled, 0)} / {fmt(o.amount, 0)}</td>
              <td className="py-1.5 text-left">
                <button
                  disabled={busy} onClick={() => { void post(api("/api/dex/cancel"), { orderId: o.id }).then(onDone); }}
                  className="inline-flex items-center gap-1 rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:border-red-500/50 hover:text-red-300"
                >
                  <Ban className="h-3 w-3" /> cancel
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── פאנל: SWAP (בריכות) עם minOut-guard ────────────────────────────────────
function SwapPanel({ pools, busy, post }: { pools: PoolView[]; busy: boolean; post: (url: string, body?: unknown) => Promise<void> }) {
  const [poolKey, setPoolKey] = useState("");
  const [flip, setFlip] = useState(false);
  const [amountIn, setAmountIn] = useState("");
  const [quote, setQuote] = useState<{ out: number; price: number; minOut0: number } | null>(null);

  const pool = pools.find((p) => p.key === poolKey) ?? pools[0];
  const assetIn = pool ? (flip ? pool.b : pool.a) : "";
  const assetOut = pool ? (flip ? pool.a : pool.b) : "";
  const amountMu = Math.floor((Number(amountIn) || 0) * MU);

  // ציטוט-חי מהבריכה (קריאה-בלבד; setState רק-בתוך-callback אסינכרוני)
  const quoteLive = !!pool && amountMu > 0;
  useEffect(() => {
    if (!pool || amountMu <= 0) return;
    const ctrl = new AbortController();
    (async () => {
      try {
        const r = await fetch(api(`/api/dex/swap?pair=${encodeURIComponent(pool.key)}&assetIn=${assetIn}&amount=${amountMu}`), { cache: "no-store", signal: ctrl.signal });
        const j = (await r.json()) as { ok: boolean; out: number; minOut0: number };
        setQuote(j.ok ? { out: j.out, price: 0, minOut0: j.minOut0 } : null);
      } catch { /* aborted */ }
    })();
    return () => ctrl.abort();
  }, [pool, assetIn, amountMu]);
  const shownQuote = quoteLive ? quote : null;

  if (pools.length === 0) return <p className="py-2 text-center font-mono text-[11px] text-zinc-600">אין בריכות</p>;

  return (
    <div data-testid="swap-panel">
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">בריכה</span>
          <select
            value={pool?.key ?? ""} onChange={(e) => { setPoolKey(e.target.value); setQuote(null); }} dir="ltr"
            className="mt-0.5 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-2 font-mono text-xs text-amber-300 outline-none"
          >
            {pools.map((p) => <option key={p.key} value={p.key}>{p.key}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">כמות-כניסה ({assetIn})</span>
          <input
            value={amountIn} onChange={(e) => setAmountIn(e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal" dir="ltr"
            className="mt-0.5 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-amber-500/60"
            placeholder="0.00"
          />
        </label>
      </div>
      <button type="button" onClick={() => setFlip((x) => !x)}
        className="mt-2 inline-flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-[10px] font-bold text-zinc-400 hover:border-amber-500/50 hover:text-amber-300">
        <RefreshCcw className="h-3 w-3" /> היפוך-כיוון → {assetOut}
      </button>
      {shownQuote && (
        <div className="mt-2 rounded-md border border-zinc-800 bg-zinc-900/70 px-3 py-2 font-mono text-[11px]" dir="ltr">
          <div className="text-zinc-400">out ≈ <span className="font-bold text-green-300">{fmt(shownQuote.out, 2)}</span> {assetOut}</div>
          <div className="mt-0.5 text-zinc-500">minOut guard (1%): {fmtInt(shownQuote.minOut0)}</div>
        </div>
      )}
      <GoldButton
        disabled={busy || amountMu <= 0 || !pool}
        onClick={() => void post(api("/api/dex/swap"), { pair: pool?.key, assetIn, amount: amountMu, minOut: shownQuote?.minOut0 })}
        className="mt-2 w-full"
      >
        SWAP {assetIn} → {assetOut}
      </GoldButton>
      <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[10px] text-zinc-500" dir="ltr">
        {pools.map((p) => (
          <div key={p.key} className="rounded border border-zinc-800/70 px-2 py-1">
            <div className="truncate font-bold text-zinc-400">{p.key}</div>
            <div>mid {fmt(p.mid, 2)}</div>
            <div>swaps {fmtInt(p.swaps)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── פאנל: סליל-מסחר ────────────────────────────────────────────────────────
function Tape({ tape }: { tape: TapeEv[] }) {
  return (
    <div className="scroll-slim max-h-56 overflow-y-auto" dir="ltr">
      <table className="w-full text-left font-mono text-[11px]">
        <tbody>
          {tape.map((e, i) => (
            <tr key={i} className="border-b border-zinc-800/50">
              <td className="py-1 text-zinc-600">{new Date(e.at).toLocaleTimeString("en-GB")}</td>
              <td className={`py-1 font-bold ${e.kind === "fill" ? (e.maker ? "text-zinc-200" : "text-amber-300") : "text-violet-300"}`}>{e.kind}</td>
              <td className="py-1 text-zinc-300">{fmtInt(e.price)}</td>
              <td className="py-1 text-zinc-400">{fmt(e.amountMu, 0)}</td>
              <td className="py-1 text-zinc-600">{e.taker}{e.maker ? ` → ${e.maker}` : ""}</td>
            </tr>
          ))}
          {tape.length === 0 && <tr><td className="py-4 text-center text-zinc-600" colSpan={5}>אין-זרימה עדיין</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// ═══════════════════════════════ הטרמינל ════════════════════════════════════
export default function DexTerminal() {
  const { world, load } = useWorldStream();
  const [marketKey, setMarketKey] = useState<string>("");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const relay = useRelayStream(world?.version);
  const myOrders = useMyOrders(world?.version);

  const flash = useCallback((tone: "ok" | "err", text: string) => {
    setMsg({ tone, text });
    setTimeout(() => setMsg(null), 4000);
  }, []);

  const post = useCallback(async (url: string, body?: unknown) => {
    setBusy(true);
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
      const j = (await r.json()) as { ok: boolean; error?: string; note?: string; reason?: string };
      if (j.ok) flash("ok", j.note ?? "נכנס לתור — ייכלל בבלוק הבא");
      else flash("err", j.error ?? j.reason ?? "נדחה");
      void load();
    } catch (e) {
      flash("err", `כשל-רשת: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setBusy(false);
    }
  }, [flash, load]);

  const market = useMemo(() => {
    if (!world) return undefined;
    const picked = world.markets.find((m) => m.key === marketKey);
    if (picked) return picked;
    return [...world.markets].sort((a, b) => b.chart.length - a.chart.length)[0] ?? world.markets[0];
  }, [world, marketKey]);

  const opWallet = world?.wallets.find((w) => w.name === "operator");
  const st = world?.state;
  const px = market?.fair ?? 0;
  const refPx = market?.refPrice ?? 0;
  const up = px >= refPx;

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950">
      {/* ─── Header מוסדי: לוגו טקסטואלי · מחיר-חי גדול · נורת-מערכת ─── */}
      <header className="sticky top-0 z-30 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur" data-testid="terminal-header">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-amber-500/40 bg-amber-500/10">
              <Coins className="h-5 w-5 text-amber-400" />
            </div>
            <div>
              <h1 className="text-base font-black tracking-tight text-zinc-50">
                SAOS-DEX <span className="font-mono text-amber-400">SOVEREIGN TERMINAL</span>
              </h1>
              <p className="text-[10px] text-zinc-500">ספר-הזמנות דטרמיניסטי · בריכות 30bps · עיגון-חי Steem/Hive/TRON</p>
            </div>
          </div>

          {/* מחיר-חי גדול וברור (monospace) */}
          <div className="flex items-baseline gap-3" dir="ltr" data-testid="header-price" data-px={px}>
            <span className="font-mono text-3xl font-black tracking-tight text-amber-400">{px ? fmt(px, 2) : "—"}</span>
            <span className="font-mono text-xs text-zinc-500">{market ? `${market.base}/${market.quote}` : ""}</span>
            {refPx > 0 && px > 0 && (
              <span className={`flex items-center gap-0.5 font-mono text-xs font-bold ${up ? "text-green-400" : "text-red-400"}`}>
                {up ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
                {Math.abs(Math.floor(((px - refPx) / refPx) * 10_000))} bps
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* נורת-מערכת ירוקה/אדומה — בלי אימוג'ים */}
            <Pill tone={st?.halted ? "red" : "green"} pulse={st?.halted === true}>
              <StatusDot tone={st?.halted ? "red" : "green"} pulse={st?.halted === true} />
              {st?.halted ? "HALTED" : "LIVE"} · h{st ? fmtInt(st.height) : "…"}
            </Pill>
            <Pill tone="violet">TPS {st ? fmtInt(st.tps) : "…"}</Pill>
            <Pill tone="zinc">root {st ? shortHash(st.stateRoot, 8) : "…"}</Pill>
            <Pill tone="amber">SIM — ספר-ריבוני, אין כסף-אמת</Pill>
          </div>
        </div>
      </header>

      {msg && (
        <div className="mx-auto mt-3 w-full max-w-[1600px] px-4">
          <div className={`rounded-lg border px-4 py-2 text-sm font-semibold ${msg.tone === "ok" ? "border-green-500/40 bg-green-500/10 text-green-300" : "border-red-500/40 bg-red-500/10 text-red-300"}`} role="status" data-testid="flash-message">
            {msg.text}
          </div>
        </div>
      )}

      <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-4">
        {/* ═════ מבנה 3-טורי מחייב: 20% Watchlist · 50% גרף+ספר · 30% מסחר+בריאות ═════ */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-10">
          {/* ─── טור-שמאל (20%): רשימת-שווקים ─── */}
          <div className="order-3 lg:order-1 lg:col-span-2">
            <Panel title="MARKETS" icon={<List className="h-4 w-4 text-amber-400" />}
              action={<span className="font-mono text-[10px] text-zinc-500">{world?.markets.length ?? 0} live</span>}>
              <Watchlist markets={world?.markets ?? []} selected={market?.key} onSelect={setMarketKey} />
            </Panel>
          </div>

          {/* ─── טור-מרכזי (50%): גרף למעלה · ספר-הזמנות למטה ─── */}
          <div className="order-1 flex flex-col gap-4 lg:order-2 lg:col-span-5">
            <Panel
              title={market ? `${market.base}/${market.quote} · גרף-חי` : "גרף-חי"}
              icon={<Activity className="h-4 w-4 text-amber-400" />}
              action={
                <div className="flex items-center gap-2" dir="ltr">
                  <span className="hidden items-center gap-1 font-mono text-[10px] text-zinc-500 sm:flex">
                    <span className="text-green-400">bid {market ? fmtInt(market.bestBid) : "—"}</span>
                    <span className="text-red-400">ask {market ? fmtInt(market.bestAsk) : "—"}</span>
                  </span>
                  <select
                    value={market?.key ?? ""} onChange={(e) => setMarketKey(e.target.value)}
                    className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-xs font-bold text-amber-300 outline-none"
                  >
                    {(world?.markets ?? []).map((m) => <option key={m.key} value={m.key}>{m.key}</option>)}
                  </select>
                </div>
              }
            >
              <PriceChart data={market?.chart ?? []} height={420} />
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] text-zinc-600" dir="ltr">
                <span>lightweight-charts (TradingView standard) · event-driven stream</span>
                <span>{market?.chart.length ?? 0} live points</span>
              </div>
            </Panel>

            <Panel
              title="ספר-הזמנות" icon={<Layers className="h-4 w-4 text-amber-400" />}
              action={<span className="font-mono text-[10px] text-zinc-500" dir="ltr">depth bars · green bids / red asks</span>}
            >
              <OrderBook market={market} />
            </Panel>
          </div>

          {/* ─── טור-ימין (30%): טופס-מסחר למעלה · System Health למטה ─── */}
          <div className="order-2 flex flex-col gap-4 lg:order-3 lg:col-span-3">
            <Panel title="טופס-מסחר" icon={<Landmark className="h-4 w-4 text-amber-400" />}>
              <TradeForm market={market} opWallet={opWallet} busy={busy} post={post} onDone={() => void load()} />
              <div className="mt-3 border-t border-zinc-800 pt-3">
                <h3 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-zinc-400">
                  <Wallet className="h-3.5 w-3.5 text-zinc-500" /> הפקודות-שלי
                </h3>
                <MyOrders orders={myOrders} busy={busy} post={post} onDone={() => void load()} />
              </div>
            </Panel>

            <SystemHealthPanel st={st} relay={relay} mempool={world?.arena.mempool ?? 0} />
          </div>
        </div>

        {/* ─── שורה-תחתונה: סליל · SWAP · הוכחות-מרקל ─── */}
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Panel title="סליל-מסחר (Tape)" icon={<Zap className="h-4 w-4 text-amber-400" />}>
            <Tape tape={world?.tape ?? []} />
          </Panel>

          <Panel title="SWAP — בריכות 30bps" icon={<Waves className="h-4 w-4 text-violet-300" />}>
            <SwapPanel pools={world?.pools ?? []} busy={busy} post={post} />
          </Panel>

          <Panel title="הוכחות-מרקל" icon={<Anchor className="h-4 w-4 text-amber-400" />}
            action={
              relay && (
                <span className="font-mono text-[10px] text-zinc-500" dir="ltr">
                  {relay.anchorId}
                </span>
              )
            }
          >
            {(() => {
              const seal = world?.proofs.seals[0];
              if (!seal) return <p className="py-2 text-center font-mono text-[11px] text-zinc-600">החותם-הראשון בדרך (כל-12 בלוקים)</p>;
              return (
                <div className="space-y-2 font-mono text-[11px]" dir="ltr">
                  <div className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900/70 px-3 py-2">
                    <span className="text-zinc-500">seal h{seal.fromHeight}→h{seal.toHeight} ({seal.leaves} blocks)</span>
                    <span className="flex items-center gap-1 text-green-300"><ShieldCheck className="h-3.5 w-3.5" /> {shortHash(seal.digest, 10)}</span>
                  </div>
                  <div className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900/70 px-3 py-2">
                    <span className="text-zinc-500">stateRoot</span>
                    <span className="text-zinc-300">{shortHash(seal.stateRoot, 12)}</span>
                  </div>
                  <p className="text-[10px] leading-snug text-zinc-500">
                    קח את hashי-הבלוקים מה-API, בנה-מרקל בעצמך (odd-fold), והשווה ל-root — בלי לסמוך עלינו.
                    העיגון-הציבורי מאומת בקריאה-חוזרת מ-RPC עצמאי (System Health → VERIFIED ANCHORS).
                  </p>
                </div>
              );
            })()}
          </Panel>
        </div>
      </main>

      {/* ─── Footer דביק (mt-auto) — כנות-כלכלית ─── */}
      <footer className="mt-auto border-t border-zinc-800 bg-zinc-950">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-2 px-4 py-3 text-[10px] text-zinc-600" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
          <span className="flex items-center gap-1.5">
            <Bot className="h-3.5 w-3.5" /> סימולציה-ריבונית — ספר-מקומי, אין כסף-אמת, אין הבטחות-תשואה
          </span>
          <span className="flex items-center gap-3">
            <span className="flex items-center gap-1"><Anchor className="h-3.5 w-3.5" /> עיגון חי · {relay ? `${fmtInt(relay.metrics.verified)} verified` : "…"}</span>
            <span className="flex items-center gap-1"><ShieldCheck className="h-3.5 w-3.5" /> גיבוי 1:1 · {st ? (st.dbOk ? "ראיות-תקינות" : "ראיות-כבויות") : "…"}</span>
          </span>
        </div>
      </footer>
    </div>
  );
}
