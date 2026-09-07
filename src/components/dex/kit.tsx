/**
 * kit.tsx — רכיבי-בסיס של הקונסולה הריבונית (זהות: zinc-950 + זהב)
 */
"use client";

import { clsx } from "clsx";
import type { ReactNode } from "react";

export function Panel({ title, icon, children, className, action }: {
  title: string; icon?: ReactNode; children: ReactNode; className?: string; action?: ReactNode;
}) {
  return (
    <section className={clsx("rounded-xl border border-zinc-800 bg-zinc-900/60 backdrop-blur", className)}>
      <header className="flex items-center justify-between gap-2 border-b border-zinc-800 px-4 py-2.5">
        <h2 className="flex items-center gap-2 text-sm font-bold tracking-wide text-zinc-200">
          {icon}
          {title}
        </h2>
        {action}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Pill({ tone = "zinc", children, pulse }: {
  tone?: "gold" | "emerald" | "rose" | "zinc" | "amber"; children: ReactNode; pulse?: boolean;
}) {
  const tones: Record<string, string> = {
    gold: "border-amber-500/40 bg-amber-500/10 text-amber-300",
    emerald: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
    rose: "border-rose-500/40 bg-rose-500/10 text-rose-300",
    amber: "border-amber-600/40 bg-amber-600/10 text-amber-200",
    zinc: "border-zinc-700 bg-zinc-800/60 text-zinc-300",
  };
  return (
    <span className={clsx("inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold", tones[tone], pulse && "animate-pulse-gold")}>
      {children}
    </span>
  );
}

export function GoldButton({ children, onClick, disabled, tone = "gold", className, type }: {
  children: ReactNode; onClick?: () => void; disabled?: boolean;
  tone?: "gold" | "emerald" | "rose" | "ghost"; className?: string; type?: "button" | "submit";
}) {
  const tones: Record<string, string> = {
    gold: "bg-amber-500 text-zinc-950 hover:bg-amber-400 disabled:bg-zinc-700 disabled:text-zinc-400",
    emerald: "bg-emerald-600 text-white hover:bg-emerald-500 disabled:bg-zinc-700 disabled:text-zinc-400",
    rose: "bg-rose-600 text-white hover:bg-rose-500 disabled:bg-zinc-700 disabled:text-zinc-400",
    ghost: "border border-zinc-700 text-zinc-300 hover:border-amber-500/60 hover:text-amber-300 disabled:opacity-40",
  };
  return (
    <button
      type={type ?? "button"}
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        "rounded-lg px-3 py-2 text-sm font-bold transition-colors disabled:cursor-not-allowed",
        tones[tone], className
      )}
    >
      {children}
    </button>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{label}</div>
      <div className={clsx("mt-0.5 font-mono text-sm font-bold", tone ?? "text-zinc-100")}>{value}</div>
      {sub && <div className="mt-0.5 text-[10px] text-zinc-500">{sub}</div>}
    </div>
  );
}

/** µ → יחידות-קריאות (1,000µ = 1 יחידה) */
export function fmt(mu: number, digits = 2): string {
  const v = mu / 1000;
  return v.toLocaleString("he-IL", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function fmtInt(n: number): string {
  return n.toLocaleString("he-IL");
}

export function shortHash(h: string, n = 10): string {
  return h ? `${h.slice(0, n)}…` : "—";
}
