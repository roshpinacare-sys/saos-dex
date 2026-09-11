"use client";

/**
 * agent-view.tsx — Roast-73 · תצוגת-סוכן-הסוואפ (THE-SWAP-AGENT CONSOLE)
 * ═════════════════════════════════════════════════════════════════════════════
 * הקונסולה-ששולחת-את-הסוכן: המפעיל נותן **כוונה** (נכס-פנימה/נכס-החוצה · כמות-µ ·
 * מנפיק) והסוכן מטפל-בהכל — תכנון, חציית-אורקל, ביצוע-אטומי, מסילת-HIVE-אמת,
 * יומן-מלא. הכל כנה: אין-הצלחות-מזויפות, אין-סודות-בפלט (שמות-חשבון/txid/כמויות).
 *
 * דפוסים: בדיוק-כשאר-המוטציות-באפליקציה — POST עם x-saos-dex-console: 1 +
 * x-saos-operator מ-localStorage (אותו-מפתח של פאנל-OPERATOR בכותרת; FleetPanel
 * ו-RouterPanel עובדים-באותו-אופן). שפה-ויזואלית: kit.tsx (zinc-950 · אמבר ·
 * monospace · אפס-אימוג'ים · אפס-כחול).
 */

import { useCallback, useEffect, useState } from "react";
import {
  Activity, Anchor, ArrowDownRight, Bot, ChevronDown, ChevronUp, ExternalLink, RefreshCcw,
  Route as RouteIcon, ShieldCheck, Waves,
} from "lucide-react";
import { GoldButton, Panel, Pill, StatusDot, Stat, fmt, fmtInt, shortHash } from "./kit";

/** קידומת-הגשר — כל-קריאת-רשת עוברת דרכה אל דמון-3010 (זהה ל-page.tsx) */
const BASE = "/saos-dex";
const api = (p: string): string => `${BASE}${p}`;

/** טוקן-המפעיל — אותו-מפתח-localStorage שפאנל-OPERATOR בכותרת מנהל (לעולם לא יוצא מהדפדפן) */
const OPERATOR_KEY = "saos-dex.operator-token";

/** נכסי-המנוע — מראה-נאמנה של רשימת-הנכסים-הידועים בגרעין (זהה ל-DEX_ASSETS ב-UI-האם · Task 70/72) */
const DEX_ASSETS = ["SAOS", "USDS", "WSTEEM", "ENERGY", "WSBD", "PHIVE", "STEEM", "WBLURT", "LB|LA", "WTRX", "WSOL"] as const;

/** מנפיקי-ביצוע — מראה-נאמנה של EXEC_ISSUERS מ-exec-route.ts (השרת מכוון fail-closed בכל-מקרה) */
const EXEC_ISSUERS = ["operator", "treasury", "arena", "portfolio-b"] as const;

/* ── טיפוסים (מראה-API — זהה ל-server /api/dex/agent) ───────────────────────── */
interface AgentStep { at: string; step: string; ok: boolean; detail: string; txid?: string }
interface AgentRun { id: string; at: string; kind: string; status: "done" | "failed"; steps: AgentStep[]; intent?: Record<string, unknown> }
/* Roast-74 · מסילה-רב-רשתית: סטטוס-פר-רשת חי מה-API (networks) + תאימות-אחורה לhive */
type RailNet = "hive" | "steem" | "blurt";
interface RailNetInfo {
  wif: boolean; authorityOk: boolean | null; authorityError?: string;
  rcEffective: number | null; rcOk: boolean | null; rcAvailable: boolean;
  liquid: number | null; engineAlive: boolean; engineBalances?: Record<string, string>;
  ops: string[]; gap: string; note: string;
}
interface RailStatus {
  configured: boolean; account: string | null; note?: string;
  networks?: Partial<Record<RailNet, RailNetInfo>>;
  ops: string[]; bounds: { rcMin: number; hiveTxFloor?: number; txFloors?: Partial<Record<RailNet, number>>; memoMax: number };
  honesty: string; probeError?: string;
  authorityOk: boolean | null; authorityCheckedAt?: string | null;
  rcEffective?: number | null; rcOk?: boolean;
  engineBalances?: Record<string, string>; hiveLiquid?: number;
}
interface FleetAccountMini {
  account: string; hasVerifiedKey: boolean; authorityOk: boolean | null;
  rcEffective: number | null; rcOk: boolean; anchoredCount: number; usable: boolean;
}
interface IgnitionRow { network: string; state: "live" | "armed" | "needs-fuel" | "pending"; keys: boolean; what: string; gap: string }
interface AgentStatus {
  ok: boolean;
  capabilities: Record<string, string>;
  rail: RailStatus;
  fleet: { configured: boolean; usableCount: number; accounts: FleetAccountMini[] };
  ignition: IgnitionRow[];
  journal: AgentRun[];
  honesty: string;
}
interface OracleCross {
  effPriceMu: number; oracleMu: number | null; oracleAtH: number | null;
  spreadBps: number | null; verdict: "no-oracle" | "aligned" | "divergent"; note: string;
}
interface SwapPlanResp {
  ok: boolean; error?: string | null; routeVenues?: string[];
  expectOutMu?: number; effPriceMu?: number; oracle?: OracleCross;
  balance?: { issuer: string; asset: string; availableMu: number; enough: boolean };
  opsCount?: number; honesty: string; kind?: string;
}
interface RunResp { ok: boolean; error?: string | null; run?: AgentRun | null; kind?: string; network?: string }
interface RailPlanResp {
  ok: boolean; error?: string | null; account?: string | null; authorityOk?: boolean | null;
  rcEffective?: number | null; balances?: Record<string, string>; steps?: string[];
  bound?: string | null; kind?: string; network?: string;
}

/* ── עזרי-תצוגה ─────────────────────────────────────────────────────────────── */
const timeOf = (iso: string): string => {
  try { return new Date(iso).toLocaleTimeString("he-IL", { hour12: false }); } catch { return "—"; }
};
/** RC-יעיל → מיליונים (הצגה-קריאה; הגרעין מדבר-יחידות-גלם) */
const rcAsM = (rc: number | null | undefined): string =>
  rc === null || rc === undefined ? "—" : `${fmtInt(Math.floor(rc / 1e6))}M`;

const capTone = (s: string): "green" | "amber" | "zinc" => (s.startsWith("live") ? "green" : s.startsWith("armed") ? "amber" : "zinc");
const capStateWord = (s: string): string => (s.split(/[\s(]/)[0] ?? s).slice(0, 16);

/** תג-מצב-הצתה: live=ירוק · armed=ענבר · needs-fuel=ענבר-מתוחם (outline) · pending=אפור */
function IgnitionBadge({ state }: { state: IgnitionRow["state"] }) {
  if (state === "live") return <Pill tone="green">חי</Pill>;
  if (state === "armed") return <Pill tone="amber">חמוש</Pill>;
  if (state === "needs-fuel")
    return <span className="inline-flex items-center rounded-full border border-amber-500/60 bg-transparent px-2.5 py-0.5 text-[11px] font-semibold text-amber-300">חסר-דלק</span>;
  return <Pill tone="zinc">ממתין</Pill>;
}

/** קישור-txid-כנה-פר-רשת: Hive→hiveblocks · Steem→steemscan · Blurt→אין-סריקה-חיה (מדוד) */
function txLink(txid: string, run?: AgentRun) {
  const net = String((run?.intent?.network as string) ?? "hive").toLowerCase();
  if (net === "steem") return { href: `https://steemscan.com/transaction/${txid}`, label: null };
  if (net === "blurt") return { href: null, label: "אין-סריקה-חיה-ל-Blurt (מדוד) — אימות-מול-צומת-rpc.blurt.blog" };
  return { href: `https://hiveblocks.com/tx/${txid}`, label: null };
}

/** לוג-צעדים-חי (ריצה/יומן): צעד · תוצאה · פירוט · txid-אמת-קליקבילי */
function RunSteps({ steps, run }: { steps: AgentStep[]; run?: AgentRun }) {
  if (steps.length === 0) return <p className="px-1 py-1 font-mono text-[10px] text-zinc-600">אין-צעדים-להצגה</p>;
  return (
    <div className="space-y-1">
      {steps.map((s, i) => {
        const link = s.txid ? txLink(s.txid, run) : null;
        return (
        <div key={`${s.step}-${i}`} className="flex items-start gap-2 rounded-md border border-zinc-800 bg-zinc-900/70 px-2.5 py-1.5">
          <StatusDot tone={s.ok ? "green" : "red"} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="font-mono text-[10px] font-bold text-zinc-200" dir="ltr">{s.step}</span>
              <span className="text-[10px] leading-snug text-zinc-400 break-words">{s.detail}</span>
            </div>
            {link?.href && (
              <a
                href={link.href} target="_blank" rel="noreferrer"
                className="mt-0.5 inline-flex items-center gap-1 font-mono text-[9px] text-amber-400 underline-offset-2 hover:underline" dir="ltr"
              >
                tx {shortHash(s.txid!, 14)} <ExternalLink className="h-2.5 w-2.5" aria-hidden />
              </a>
            )}
            {link && !link.href && s.txid && (
              <span className="mt-0.5 block font-mono text-[9px] text-zinc-500" dir="ltr">tx {shortHash(s.txid, 14)} · {link.label}</span>
            )}
          </div>
          <span className="shrink-0 font-mono text-[8.5px] text-zinc-600" dir="ltr">{timeOf(s.at)}</span>
        </div>
        );
      })}
    </div>
  );
}

/** כרטיס-ריצה (id · סוג · מצב · צעדים) — משותף לתוצאת-ביצוע וליומן */
function RunCard({ run, defaultOpen }: { run: AgentRun; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/60">
      <button
        type="button" onClick={() => setOpen((v) => !v)}
        className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-right"
        aria-expanded={open}
      >
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <Pill tone={run.status === "done" ? "green" : "red"}>{run.status === "done" ? "הושלם" : "נכשל"}</Pill>
          <span className="font-mono text-[10px] font-bold text-amber-300" dir="ltr">{run.kind}</span>
          <span className="font-mono text-[9px] text-zinc-600" dir="ltr">{run.id}</span>
        </span>
        <span className="flex items-center gap-2">
          <span className="font-mono text-[9px] text-zinc-600" dir="ltr">{timeOf(run.at)}</span>
          <span className="font-mono text-[9px] text-zinc-500">{run.steps.length} צעדים</span>
          {open ? <ChevronUp className="h-3 w-3 text-zinc-500" aria-hidden /> : <ChevronDown className="h-3 w-3 text-zinc-500" aria-hidden />}
        </span>
      </button>
      {open && <div className="border-t border-zinc-800/80 p-2"><RunSteps steps={run.steps} run={run} /></div>}
    </div>
  );
}

/* ══ התצוגה ═══════════════════════════════════════════════════════════════════ */
export function AgentView({ onNeedOperator, onOpenFleet }: { onNeedOperator: () => void; onOpenFleet: () => void }) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // ── טופס-הסוואפ ──
  const [assetIn, setAssetIn] = useState("WSTEEM");
  const [assetOut, setAssetOut] = useState("USDS");
  const [amount, setAmount] = useState("2000");
  const [minOut, setMinOut] = useState("");
  const [issuer, setIssuer] = useState<string>("operator");
  const [plan, setPlan] = useState<(SwapPlanResp & { sig: string }) | null>(null);
  const [run, setRun] = useState<AgentRun | null>(null);
  const [swapBusy, setSwapBusy] = useState<"plan" | "exec" | null>(null);
  const [swapMsg, setSwapMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // ── מסילה (Roast-74: רב-רשתית) ──
  const [railNet, setRailNet] = useState<RailNet>("hive");
  const [railAction, setRailAction] = useState<string>("withdraw");
  const [railQty, setRailQty] = useState("");
  const [railTo, setRailTo] = useState("");
  const [railPrice, setRailPrice] = useState("");
  const [railPlan, setRailPlan] = useState<(RailPlanResp & { sig: string }) | null>(null);
  const [railRun, setRailRun] = useState<AgentRun | null>(null);
  const [railBusy, setRailBusy] = useState<"plan" | "exec" | null>(null);
  const [railMsg, setRailMsg] = useState<{ ok: boolean; text: string } | null>(null);

  /** פעולות-האפשריות-לרשת-שנבחרה (מהאמת-חי — networks[n].ops) */
  const railNetInfo = status?.rail?.networks?.[railNet];
  const railOps = railNetInfo?.ops ?? (railNet === "blurt" ? ["powerup", "transfer"] : ["sell", "withdraw", "powerup", "transfer"]);
  useEffect(() => {
    if (!railOps.includes(railAction)) setRailAction(railOps.includes("withdraw") ? "withdraw" : railOps[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [railNet]);
  const railNeedsEngine = railAction === "sell" || railAction === "withdraw";
  const railBase = railNet === "hive" ? "HIVE" : railNet === "steem" ? "STEEM" : "BLURT";
  const railEngineSym = railNet === "steem" ? "SWAP.STEEM" : "SWAP.HIVE";

  /** רענון-מצב-הסוכן (GET ציבורי — בדיוק-כמו-FleetPanel: interval פשוט) */
  const load = useCallback(async (): Promise<boolean> => {
    try {
      const r = await fetch(api("/api/dex/agent"), { cache: "no-store" });
      const j = (await r.json()) as AgentStatus;
      if (j?.ok) { setStatus(j); return true; }
      return false;
    } catch { return false; }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => { void load(); }, 12_000);
    return () => clearInterval(t);
  }, [load]);

  const refreshNow = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  /** POST-סוכן — אותם-שערים-בדיוק כמו כל-מוטציה באפליקציה (console-header + operator) */
  const postAgent = useCallback(async (body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const token = (() => { try { return window.localStorage.getItem(OPERATOR_KEY) ?? ""; } catch { return ""; } })();
    const r = await fetch(api("/api/dex/agent"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-saos-dex-console": "1", ...(token ? { "x-saos-operator": token } : {}) },
      body: JSON.stringify(body),
    });
    return (await r.json()) as Record<string, unknown>;
  }, []);

  /** הודעה-כנה לשער-מפעיל — פותחת-את-פאנל-ה-OPERATOR בכותרת */
  const gateMsg = useCallback((err: unknown): string | null => {
    const e = String(err ?? "");
    if (e === "operator-unauthorized") { onNeedOperator(); return "נדרש אימות-מפעיל: הזן את DEX_OPERATOR_TOKEN דרך כפתור OPERATOR בכותרת"; }
    if (e === "operator-auth-unconfigured") { onNeedOperator(); return "שער-המפעיל לא-מוגדר בשרת (fail-closed) — מוטציות נעולות"; }
    return null;
  }, [onNeedOperator]);

  /* ── שליחת-סוכן: תכנון ── */
  const swapSig = `${assetIn}|${assetOut}|${amount}|${minOut}|${issuer}`;
  const doPlan = async () => {
    setSwapBusy("plan"); setSwapMsg(null); setPlan(null); setRun(null);
    try {
      const body: Record<string, unknown> = {
        kind: "plan-swap", assetIn, assetOut,
        amount: Math.floor(Number(amount) || 0), issuer,
      };
      if (minOut.trim() !== "") body.minOut = Math.max(0, Math.floor(Number(minOut) || 0));
      const j = (await postAgent(body)) as unknown as SwapPlanResp;
      if (j.ok) setPlan({ ...j, sig: swapSig });
      else {
        const gate = gateMsg(j.error);
        setSwapMsg({ ok: false, text: gate ?? `התכנון-נדחה: ${j.error ?? "no-route"}` });
      }
    } catch { setSwapMsg({ ok: false, text: "כשל-רשת בתכנון" }); }
    finally { setSwapBusy(null); }
  };

  /* ── שליחת-סוכן: ביצוע (חייב-תוכנית-תקפה-על-אותם-פרמטרים) ── */
  const planFresh = plan !== null && plan.sig === swapSig;
  const doSwap = async () => {
    if (!planFresh) return;
    setSwapBusy("exec"); setSwapMsg(null);
    try {
      const body: Record<string, unknown> = {
        kind: "swap", assetIn, assetOut,
        amount: Math.floor(Number(amount) || 0), issuer,
      };
      if (minOut.trim() !== "") body.minOut = Math.max(0, Math.floor(Number(minOut) || 0));
      const j = (await postAgent(body)) as unknown as RunResp;
      if (j.run) setRun(j.run);
      if (j.ok) setSwapMsg({ ok: true, text: "הריצה-הושלמה — בפירוט-למטה וביומן-הסוכן" });
      else {
        const gate = gateMsg(j.error);
        setSwapMsg({ ok: false, text: gate ?? `הביצוע-נדחה: ${j.error ?? "unknown"}` });
      }
    } catch { setSwapMsg({ ok: false, text: "כשל-רשת בביצוע" }); }
    finally { setSwapBusy(null); void load(); }
  };

  /* ── מסילה: תכנון (רשת+פעולה נבחרות) ── */
  const railSig = `${railNet}|${railAction}|${railQty}|${railTo}|${railPrice}`;
  const railBody = (kind: "plan-rail" | "rail"): Record<string, unknown> => {
    const body: Record<string, unknown> = { kind, network: railNet, action: railAction };
    const q = Number(railQty);
    if (railQty.trim() !== "" && Number.isFinite(q) && q > 0) {
      if (railNeedsEngine) body.quantity = q; else body.amount = q;
    }
    if (railAction === "sell" && railPrice.trim() !== "" && Number(railPrice) > 0) body.price = Number(railPrice);
    if (railAction === "transfer" && railTo.trim() !== "") body.to = railTo.trim();
    return body;
  };
  const doRailPlan = async () => {
    setRailBusy("plan"); setRailMsg(null); setRailPlan(null); setRailRun(null);
    try {
      const j = (await postAgent(railBody("plan-rail"))) as unknown as RailPlanResp;
      if (j.ok) setRailPlan({ ...j, sig: railSig });
      else {
        const gate = gateMsg(j.error);
        setRailMsg({ ok: false, text: gate ?? `תוכנית-המסילה-נדחתה: ${j.error ?? "plan-failed"}` });
      }
    } catch { setRailMsg({ ok: false, text: "כשל-רשת בתכנון-המסילה" }); }
    finally { setRailBusy(null); void load(); }
  };

  /* ── מסילה: ביצוע (חייב-תוכנית-תקפה-על-אותם-פרמטרים) ── */
  const railPlanFresh = railPlan !== null && railPlan.sig === railSig;
  const doRail = async () => {
    if (!railPlanFresh) return;
    setRailBusy("exec"); setRailMsg(null);
    try {
      const j = (await postAgent(railBody("rail"))) as unknown as RunResp;
      if (j.run) setRailRun(j.run);
      if (j.ok) setRailMsg({ ok: true, text: `הפעולה-שודרה לרשת-${railNet.toUpperCase()} — txid בפירוט-למטה` });
      else {
        const gate = gateMsg(j.error);
        setRailMsg({ ok: false, text: gate ?? `הביצוע-נדחה: ${j.error ?? "unknown"}` });
      }
    } catch { setRailMsg({ ok: false, text: "כשל-רשת בביצוע-המסילה" }); }
    finally { setRailBusy(null); void load(); }
  };

  const rail = status?.rail;
  const fleet = status?.fleet;

  return (
    <div className="space-y-4" data-testid="agent-view">
      {/* ═══ (a) ראש-הסוכן + כנות ═══ */}
      <Panel
        title="סוכן-הסוואפ · THE-SWAP-AGENT"
        icon={<Bot className="h-4 w-4 text-amber-400" />}
        action={
          <GoldButton tone="ghost" onClick={() => void refreshNow()} disabled={refreshing} testid="agent-refresh" className="px-2.5 py-1 text-[11px]">
            <RefreshCcw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} /> רענן
          </GoldButton>
        }
      >
        <p className="text-[11px] leading-snug text-zinc-500" data-testid="agent-honesty">
          {status?.honesty ?? "מתחבר לסוכן…"}
        </p>

        {/* ═══ (b) פס-היכולות — מצב-אמת-צבוע-כנה ═══ */}
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5" data-testid="agent-capabilities">
          {(["swap", "rail", "door", "fleet", "oracle"] as const).map((k) => {
            const raw = status?.capabilities?.[k];
            const tone = raw ? capTone(raw) : "zinc";
            const cls = tone === "green" ? "border-green-500/40 bg-green-500/[0.06]"
              : tone === "amber" ? "border-amber-500/40 bg-amber-500/[0.06]"
                : "border-zinc-800 bg-zinc-900/60";
            const stateCls = tone === "green" ? "text-green-300" : tone === "amber" ? "text-amber-300" : "text-zinc-500";
            return (
              <div key={k} className={`rounded-lg border px-3 py-2 ${cls}`} data-testid={`agent-cap-${k}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 font-mono text-[10px] font-black uppercase tracking-widest text-zinc-200">
                    {k === "swap" && <Activity className="h-3 w-3 text-amber-400" aria-hidden />}
                    {k === "rail" && <Waves className="h-3 w-3 text-amber-400" aria-hidden />}
                    {k === "fleet" && <Anchor className="h-3 w-3 text-amber-400" aria-hidden />}
                    {k === "oracle" && <ShieldCheck className="h-3 w-3 text-amber-400" aria-hidden />}
                    {k === "swap" ? "SWAP" : k === "rail" ? "RAIL·3NET" : k.toUpperCase()}
                  </span>
                  <span className={`font-mono text-[9px] font-bold uppercase ${stateCls}`} dir="ltr">
                    {raw ? capStateWord(raw) : "…"}
                  </span>
                </div>
                <p className="mt-1 text-[10px] leading-snug text-zinc-500">{raw ?? "ממתין למצב-הסוכן"}</p>
              </div>
            );
          })}
        </div>
      </Panel>

      {/* ═══ (c) שליחת-סוכן — סוואפ ═══ */}
      <Panel title="שליחת-סוכן · סוואפ-על-הבריכות" icon={<Activity className="h-4 w-4 text-amber-400" />}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6" data-testid="agent-swap-form">
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">נכס-פנימה</span>
            <select
              value={assetIn} onChange={(e) => setAssetIn(e.target.value)} aria-label="נכס-פנימה"
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-xs font-bold text-amber-300 outline-none focus:border-amber-500/60"
              data-testid="agent-asset-in"
            >
              {DEX_ASSETS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">נכס-החוצה</span>
            <select
              value={assetOut} onChange={(e) => setAssetOut(e.target.value)} aria-label="נכס-החוצה"
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-xs font-bold text-amber-300 outline-none focus:border-amber-500/60"
              data-testid="agent-asset-out"
            >
              {DEX_ASSETS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">כמות (µ)</span>
            <input
              value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))} inputMode="numeric" dir="ltr"
              placeholder="µ" aria-label="כמות ב-µ"
              className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-xs text-zinc-100 outline-none focus:border-amber-500/60"
              data-testid="agent-amount"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">minOut (µ · רשות)</span>
            <input
              value={minOut} onChange={(e) => setMinOut(e.target.value.replace(/[^0-9]/g, ""))} inputMode="numeric" dir="ltr"
              placeholder="0 = ללא-רצפה" aria-label="מינימום-יציאה ב-µ"
              className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-xs text-zinc-100 outline-none focus:border-amber-500/60"
              data-testid="agent-min-out"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">מנפיק</span>
            <select
              value={issuer} onChange={(e) => setIssuer(e.target.value)} aria-label="מנפיק-מבצע"
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-xs font-bold text-amber-300 outline-none focus:border-amber-500/60"
              data-testid="agent-issuer"
            >
              {EXEC_ISSUERS.map((i) => <option key={i} value={i}>{i}</option>)}
            </select>
          </label>
          <div className="flex items-end gap-2">
            <GoldButton onClick={() => void doPlan()} disabled={swapBusy !== null || !(Number(amount) > 0)} testid="agent-plan-btn" className="flex-1">
              {swapBusy === "plan" ? "מתכנן…" : "תכנן"}
            </GoldButton>
            <GoldButton tone="green" onClick={() => void doSwap()} disabled={!planFresh || swapBusy !== null} testid="agent-execute-btn" className="flex-1">
              {swapBusy === "exec" ? "מבצע…" : "בצע"}
            </GoldButton>
          </div>
        </div>
        {!planFresh && plan !== null && (
          <p className="mt-2 font-mono text-[10px] text-amber-400">הפרמטרים-השתנו מאז-התכנון — תכנן שוב לפני-ביצוע</p>
        )}

        {/* תוצאת-תכנון */}
        {plan && plan.sig === swapSig && (
          <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/70 p-3" data-testid="agent-plan-result">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-zinc-300">
                <RouteIcon className="h-3 w-3 text-amber-400" aria-hidden /> תוכנית-הסוכן
              </span>
              <span className="font-mono text-[10px] text-zinc-500" dir="ltr">
                {plan.routeVenues?.length ?? 0} venues · {plan.opsCount ?? 0} ops
              </span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
              <Stat label="מסלול" value={<span dir="ltr" className="text-[11px]">{plan.routeVenues?.join(" → ") ?? "—"}</span>} />
              <Stat label="יציאה-צפויה" value={<span dir="ltr">{plan.expectOutMu !== undefined ? `${fmt(plan.expectOutMu, 2)}µ` : "—"}</span>} sub="סימולציית-שלמים על הבריכות" />
              <Stat label="יתרה-זמינה" value={<span dir="ltr">{plan.balance ? `${fmtInt(plan.balance.availableMu)}µ` : "—"}</span>}
                sub={plan.balance ? `${plan.balance.issuer} · ${plan.balance.asset}` : undefined} />
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">בדיקת-יתרה</div>
                <div className="mt-0.5">
                  {plan.balance ? (
                    plan.balance.enough
                      ? <Pill tone="green" testid="agent-balance-ok">מספקת</Pill>
                      : <Pill tone="red" testid="agent-balance-ok">לא-מספקת</Pill>
                  ) : <span className="font-mono text-xs text-zinc-600">—</span>}
                </div>
              </div>
            </div>
            {/* פסק-דין-האורקל: aligned=ירוק · divergent=ענבר · no-oracle=אפור */}
            {plan.oracle && (
              <div className="mt-2 rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2" data-testid="agent-oracle-cross">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[10px] font-bold text-zinc-300">חציית-אורקל</span>
                  {plan.oracle.verdict === "aligned" && <Pill tone="green" testid="agent-oracle-badge">מיושר-לאורקל</Pill>}
                  {plan.oracle.verdict === "divergent" && <Pill tone="amber" testid="agent-oracle-badge">סוטה-מהאורקל</Pill>}
                  {plan.oracle.verdict === "no-oracle" && <Pill tone="zinc" testid="agent-oracle-badge">אין-אורקל</Pill>}
                  {plan.oracle.spreadBps !== null && (
                    <span className="font-mono text-[10px] text-zinc-500" dir="ltr">
                      spread {plan.oracle.spreadBps > 0 ? "+" : ""}{plan.oracle.spreadBps}bps
                      {plan.oracle.oracleMu !== null && ` · oracle ${fmt(plan.oracle.oracleMu, 4)}µ`}
                      {plan.oracle.oracleAtH !== null && ` · h${fmtInt(plan.oracle.oracleAtH)}`}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-[10px] leading-snug text-zinc-500">{plan.oracle.note}</p>
              </div>
            )}
            <p className="mt-2 text-[9px] leading-snug text-zinc-600">{plan.honesty}</p>
          </div>
        )}

        {swapMsg && (
          <div
            role="status" data-testid="agent-swap-msg"
            className={`mt-2 w-fit max-w-full break-words rounded-lg border px-3 py-1.5 text-[11px] font-semibold ${swapMsg.ok ? "border-green-500/40 bg-green-500/10 text-green-300" : "border-red-500/40 bg-red-500/10 text-red-300"}`}
          >
            {swapMsg.text}
          </div>
        )}

        {/* תוצאת-ביצוע — לוג-הריצה */}
        {run && (
          <div className="mt-3" data-testid="agent-run-result">
            <h3 className="mb-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-zinc-400">ריצת-הסוכן-האחרונה</h3>
            <RunCard run={run} defaultOpen />
          </div>
        )}
      </Panel>

      {/* ═══ (d) מסילת-הרשתות (אמת · HIVE/STEEM/BLURT) ═══ */}
      <div id="agent-rail" data-testid="agent-rail">
        <Panel title="מסילת-הרשתות (אמת) · RAIL-EXEC" icon={<Waves className="h-4 w-4 text-amber-400" />}>
          {!rail ? (
            <p className="py-2 text-center font-mono text-[11px] text-zinc-600">מודד-מסילה…</p>
          ) : !rail.configured ? (
            <div className="space-y-1">
              <p className="font-mono text-[11px] text-amber-300">אין-זהות-ריבונית-בסביבה — המסילה-כבויה-בכנות (fail-closed)</p>
              {rail.note && <p className="font-mono text-[10px] text-zinc-600">{rail.note}</p>}
            </div>
          ) : (
            <div className="space-y-3">
              {/* בורר-רשת — סטטוס-חי-פר-רשת */}
              <div className="grid grid-cols-3 gap-1.5" data-testid="agent-rail-networks">
                {(["hive", "steem", "blurt"] as const).map((net) => {
                  const ni = rail.networks?.[net];
                  const active = railNet === net;
                  const stateTone = !ni?.wif ? "border-zinc-800 bg-zinc-900/60 text-zinc-500"
                    : ni.authorityOk === true ? "border-green-500/40 bg-green-500/[0.06] text-green-300"
                      : ni.authorityOk === false ? "border-red-500/40 bg-red-500/[0.06] text-red-300"
                        : "border-amber-500/40 bg-amber-500/[0.06] text-amber-300";
                  return (
                    <button
                      key={net} type="button" onClick={() => setRailNet(net)}
                      className={`rounded-lg border px-2.5 py-2 text-right transition-colors ${stateTone} ${active ? "ring-1 ring-amber-500/60" : "hover:border-zinc-600"}`}
                      data-testid={`agent-rail-net-${net}`}
                      aria-pressed={active}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="font-mono text-[11px] font-black uppercase tracking-widest" dir="ltr">{net}</span>
                        <span className="font-mono text-[9px]" dir="ltr">
                          {ni?.wif ? (ni.authorityOk === true ? "AUTH-OK" : ni.authorityOk === false ? "AUTH-BLOCK" : "…") : "WIF-חסר"}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate font-mono text-[9px] opacity-80" dir="ltr">
                        {ni?.liquid != null ? `${ni.liquid.toFixed(3)} ${net.toUpperCase()}` : "—"} · {ni?.engineAlive ? "ENGINE" : "NO-ENGINE"}
                      </p>
                    </button>
                  );
                })}
              </div>

              {/* סטטוס-הרשת-הנבחרת */}
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4" data-testid="agent-rail-status">
                <Stat label="חשבון-מסילה" value={<span dir="ltr">{rail.account ?? "—"}</span>} sub={railNetInfo?.note ?? rail.note} />
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">סמכות-active (חי · {railNet})</div>
                  <div className="mt-0.5">
                    {railNetInfo?.authorityOk === true && <Pill tone="green">אומתה מהשרשרת</Pill>}
                    {railNetInfo?.authorityOk === false && <Pill tone="red">נכשלה — אפס-שידור</Pill>}
                    {railNetInfo?.authorityOk == null && <Pill tone="zinc">לא-נמדדה</Pill>}
                  </div>
                  {railNetInfo?.gap && <p className="mt-1 font-mono text-[9px] leading-snug text-zinc-500">{railNetInfo.gap}</p>}
                </div>
                <Stat label={railNetInfo?.rcAvailable === false ? "RC (לא-רלוונטי — מדוד)" : "RC-יעיל"} value={
                  <span className="flex items-center gap-1.5" dir="ltr">
                    {railNetInfo?.rcAvailable === false ? <span className="font-mono text-[10px] text-zinc-500">N/A</span> : <>
                      {rcAsM(railNetInfo?.rcEffective)}
                      {railNetInfo?.rcOk === true && <Pill tone="green">תקין</Pill>}
                      {railNetInfo?.rcOk === false && <Pill tone="red">מתחת-לרצפה</Pill>}
                    </>}
                  </span>
                } sub={`רצפת-המסילה ${rcAsM(rail.bounds?.rcMin ?? 200_000_000)}`} />
                <Stat label={`${railBase}-נזיל (חי)`} value={<span dir="ltr">{railNetInfo?.liquid != null ? railNetInfo.liquid.toFixed(3) : "לא-נמדד"}</span>}
                  sub={railNetInfo?.engineAlive ? "מנוע-חי" : "ללא-מנוע (מדוד)"} />
              </div>

              {/* יתרות-מנוע-חיות (רק-לרשת-עם-מנוע) */}
              {(railNetInfo?.engineBalances ?? (railNet === "hive" ? rail.engineBalances : undefined)) && Object.keys(railNetInfo?.engineBalances ?? rail.engineBalances ?? {}).length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5" data-testid="agent-rail-balances">
                  <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-zinc-500">יתרות-Engine:</span>
                  {Object.entries(railNetInfo?.engineBalances ?? rail.engineBalances ?? {}).slice(0, 8).map(([sym, bal]) => (
                    <span key={sym} className="rounded-md border border-zinc-800 bg-zinc-950/70 px-2 py-0.5 font-mono text-[10px] text-zinc-300" dir="ltr">
                      {sym} {bal}
                    </span>
                  ))}
                </div>
              )}
              <p className="font-mono text-[9px] text-zinc-600" dir="ltr">
                ops({railNet}): {railOps.join(" · ")} · rcMin {rcAsM(rail.bounds?.rcMin)} · txFloor {rail.bounds?.txFloors?.[railNet] ?? "—"} · memoMax {rail.bounds?.memoMax ?? "—"}
              </p>
              <p className="text-[10px] leading-snug text-zinc-500">{rail.honesty}</p>

              {/* פעולה-רב-רשתית: פעולה+כמות+פרמטרים */}
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3" data-testid="agent-rail-withdraw">
                <div className="flex flex-wrap items-end gap-2">
                  <label className="block min-w-[120px]">
                    <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">פעולה</span>
                    <select
                      value={railAction} onChange={(e) => setRailAction(e.target.value)}
                      aria-label="פעולת-המסילה"
                      className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-xs text-zinc-100 outline-none focus:border-amber-500/60"
                      data-testid="agent-rail-action"
                    >
                      {railOps.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </label>
                  <label className="block flex-1 min-w-[140px]">
                    <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                      {railNeedsEngine ? `${railEngineSym} (ריק = כל-היתרה)` : `כמות ${railBase}`}
                    </span>
                    <input
                      value={railQty} onChange={(e) => setRailQty(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" dir="ltr"
                      placeholder="0.000" aria-label="כמות לפעולה"
                      className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-xs text-zinc-100 outline-none focus:border-amber-500/60"
                      data-testid="agent-rail-qty"
                    />
                  </label>
                  {railAction === "sell" && (
                    <label className="block min-w-[110px]">
                      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">מחיר-מגביל</span>
                      <input
                        value={railPrice} onChange={(e) => setRailPrice(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" dir="ltr"
                        placeholder="0.000" aria-label="מחיר-מגביל למכירה"
                        className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-xs text-zinc-100 outline-none focus:border-amber-500/60"
                        data-testid="agent-rail-price"
                      />
                    </label>
                  )}
                  {railAction === "transfer" && (
                    <label className="block min-w-[140px]">
                      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">אל (חשבון)</span>
                      <input
                        value={railTo} onChange={(e) => setRailTo(e.target.value.replace(/[^a-z0-9\-.]/g, ""))} dir="ltr"
                        placeholder="account" aria-label="חשבון-יעד להעברה"
                        className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-xs text-zinc-100 outline-none focus:border-amber-500/60"
                        data-testid="agent-rail-to"
                      />
                    </label>
                  )}
                  <GoldButton tone="gold" onClick={() => void doRailPlan()} disabled={railBusy !== null} testid="agent-rail-plan-btn">
                    <span className="inline-flex items-center gap-1.5"><ArrowDownRight className="h-3.5 w-3.5" aria-hidden />{railBusy === "plan" ? "מתכנן…" : `תכנן-${railAction}`}</span>
                  </GoldButton>
                  <GoldButton tone="green" onClick={() => void doRail()} disabled={!railPlanFresh || railBusy !== null} testid="agent-rail-execute-btn">
                    {railBusy === "exec" ? "משדר…" : `בצע-${railAction}`}
                  </GoldButton>
                </div>
                {!railPlanFresh && railPlan !== null && (
                  <p className="mt-2 font-mono text-[10px] text-amber-400">הפרמטרים-השתנו מאז-התכנון — תכנן שוב לפני-ביצוע</p>
                )}

                {/* תוצאת-תוכנית-מסילה */}
                {railPlan && railPlan.sig === railSig && (
                  <div className="mt-2 rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2" data-testid="agent-rail-plan-result">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-zinc-300">תוכנית-המסילה</span>
                      <span className="flex items-center gap-2 font-mono text-[9px]" dir="ltr">
                        {railPlan.account && <span className="text-zinc-400">{railPlan.account}</span>}
                        {railPlan.authorityOk === true && <span className="text-green-400">auth-ok</span>}
                        {railPlan.authorityOk === false && <span className="text-red-400">auth-fail</span>}
                        {railPlan.rcEffective !== null && railPlan.rcEffective !== undefined && <span className="text-zinc-500">rc {rcAsM(railPlan.rcEffective)}</span>}
                      </span>
                    </div>
                    <ul className="mt-1 space-y-0.5">
                      {(railPlan.steps ?? []).map((s, i) => (
                        <li key={i} className="font-mono text-[10px] leading-snug text-zinc-300" dir="ltr">→ {s}</li>
                      ))}
                    </ul>
                    {railPlan.bound && <p className="mt-1 font-mono text-[9px] text-zinc-500" dir="ltr">bound: {railPlan.bound}</p>}
                  </div>
                )}

                {railMsg && (
                  <div
                    role="status" data-testid="agent-rail-msg"
                    className={`mt-2 w-fit max-w-full break-words rounded-lg border px-3 py-1.5 text-[11px] font-semibold ${railMsg.ok ? "border-green-500/40 bg-green-500/10 text-green-300" : "border-red-500/40 bg-red-500/10 text-red-300"}`}
                  >
                    {railMsg.text}
                  </div>
                )}

                {railRun && (
                  <div className="mt-2" data-testid="agent-rail-run">
                    <RunCard run={railRun} defaultOpen />
                  </div>
                )}
              </div>
            </div>
          )}
        </Panel>
      </div>

      {/* ═══ (e) צי-העיגון — קו-מצב-קומפקטי (הפאנל-המלא קיים-בטרמינל — לא-משוכפל) ═══ */}
      <div id="agent-fleet" data-testid="agent-fleet">
        <Panel
          title="צי-העיגון · קו-מצב"
          icon={<Anchor className="h-4 w-4 text-green-400" />}
          action={
            <GoldButton tone="ghost" onClick={onOpenFleet} testid="agent-fleet-link" className="px-2.5 py-1 text-[11px]">
              פאנל-הצי-המלא (סרוק/עגן)
            </GoldButton>
          }
        >
          {!fleet ? (
            <p className="py-2 text-center font-mono text-[11px] text-zinc-600">מתחבר לצי…</p>
          ) : !fleet.configured ? (
            <p className="font-mono text-[11px] text-amber-300">כספת-הצי לא-נמצאה — הצי כבוי-בכנות</p>
          ) : (
            <div className="space-y-1.5" data-testid="agent-fleet-line">
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone={fleet.usableCount > 0 ? "green" : "red"}>
                  <StatusDot tone={fleet.usableCount > 0 ? "green" : "red"} pulse={false} />
                  {fleet.usableCount}/{fleet.accounts.length} חיילים-שמישים
                </Pill>
                <span className="font-mono text-[10px] text-zinc-500">
                  עיגונים-צבורים: {fmtInt(fleet.accounts.reduce((s, a) => s + a.anchoredCount, 0))}
                </span>
              </div>
              <p className="font-mono text-[9px] leading-snug text-zinc-500" dir="ltr">
                {fleet.accounts.map((a) => `${a.account}${a.usable ? "✓" : "×"}`).join(" · ")}
              </p>
              <p className="text-[10px] leading-snug text-zinc-600">
                הסריקה (probe) והעיגון (anchor) עם שער-המפעיל — בפאנל-הצי-המלא בטרמינל; כאן מוצג-קו-המצב-בלבד כדי-לא-לשכפל-שליטה.
              </p>
            </div>
          )}
        </Panel>
      </div>

      {/* ═══ (f) מטריצת-ההצתה ═══ */}
      <div id="agent-ignition" data-testid="agent-ignition">
        <Panel title="מטריצת-ההצתה · מי-חי · מי-חמוש · מי-חסר-דלק" icon={<ShieldCheck className="h-4 w-4 text-amber-400" />}>
          {!status ? (
            <p className="py-2 text-center font-mono text-[11px] text-zinc-600">מרכיב-מטריצה…</p>
          ) : (
            <div className="overflow-x-auto" data-testid="agent-ignition-table">
              <table className="w-full min-w-[560px] border-separate border-spacing-0 text-[11px]">
                <thead>
                  <tr className="text-[9px] uppercase tracking-wider text-zinc-500">
                    <th className="px-2 py-1 text-right font-semibold">רשת</th>
                    <th className="px-2 py-1 text-right font-semibold">מצב</th>
                    <th className="px-2 py-1 text-right font-semibold">מפתחות</th>
                    <th className="px-2 py-1 text-right font-semibold">מה-חסר (פער-אמת)</th>
                  </tr>
                </thead>
                <tbody>
                  {status.ignition.map((row) => (
                    <tr key={row.network} className="border-t border-zinc-800/60" data-testid={`agent-ignition-${row.network}`}>
                      <td className="px-2 py-2 align-top">
                        <div className="font-mono text-[11px] font-bold text-zinc-100" dir="ltr">{row.network}</div>
                        <div className="mt-0.5 max-w-[260px] text-[9px] leading-snug text-zinc-600">{row.what}</div>
                      </td>
                      <td className="px-2 py-2 align-top">
                        <IgnitionBadge state={row.state} />
                      </td>
                      <td className={`px-2 py-2 align-top font-mono text-[10px] ${row.keys ? "text-green-400" : "text-zinc-500"}`}>
                        {row.keys ? "כן" : "לא"}
                      </td>
                      <td className="px-2 py-2 align-top text-[10px] leading-snug text-zinc-400">{row.gap}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      {/* ═══ (g) יומן-הסוכן ═══ */}
      <div id="agent-journal" data-testid="agent-journal">
        <Panel
          title="יומן-הסוכן · טבעת-40-הריצות-האחרונות"
          icon={<Bot className="h-4 w-4 text-amber-400" />}
          action={status && <span className="font-mono text-[10px] text-zinc-500" dir="ltr">{status.journal.length} runs</span>}
        >
          {!status || status.journal.length === 0 ? (
            <p className="py-2 text-center font-mono text-[11px] text-zinc-600">עדיין-שקט — שלח את הסוכן לריצה-הראשונה והיא-תירשם כאן</p>
          ) : (
            <div className="scroll-slim max-h-96 space-y-1.5 overflow-y-auto pr-1">
              {status.journal.map((j) => <RunCard key={j.id} run={j} />)}
            </div>
          )}
          <p className="mt-2 text-[9px] leading-snug text-zinc-600">
            טבעת-זיכרון-בשרת (שורדת-HMR) · אפס-סודות — שמות-חשבון, txid וכמויות-בלבד · כל-כשל-רשום-כמו-שהוא.
          </p>
        </Panel>
      </div>
    </div>
  );
}
