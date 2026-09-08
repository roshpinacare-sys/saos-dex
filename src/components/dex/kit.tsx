/**
 * kit.tsx — רכיבי-בסיס של הטרמינל הריבוני (זהות מוסדית: zinc-950 · גבולות-דקים ·
 * monospace לנתונים-מספריים · ירוק/אדום = מסחר · סגול = סטטוס-מערכת · אפס אימוג'ים)
 *
 * Zero-Tolerance Visual Overhaul: טונים מילוליים green/red (bg-green-600 / bg-red-600)
 * כדרישת-המפעיל — הצבעים נבדקים ישירות ב-DOM.
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

export function Pill({ tone = "zinc", children, pulse, testid }: {
  tone?: "gold" | "green" | "red" | "zinc" | "amber" | "violet"; children: ReactNode; pulse?: boolean; testid?: string;
}) {
  const tones: Record<string, string> = {
    gold: "border-amber-500/40 bg-amber-500/10 text-amber-300",
    green: "border-green-500/40 bg-green-500/10 text-green-300",
    red: "border-red-500/40 bg-red-500/10 text-red-300",
    amber: "border-amber-600/40 bg-amber-600/10 text-amber-200",
    zinc: "border-zinc-700 bg-zinc-800/60 text-zinc-300",
    violet: "border-violet-500/40 bg-violet-500/10 text-violet-300",
  };
  return (
    <span data-testid={testid} className={clsx("inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold", tones[tone], pulse && "animate-pulse-gold")}>
      {children}
    </span>
  );
}

/** נורית-סטטוס (מחליפת סימני-טקסט — זהות-מוסדית ללא אימוג'ים) */
export function StatusDot({ tone = "zinc", pulse }: { tone?: "green" | "red" | "amber" | "zinc" | "violet"; pulse?: boolean }) {
  const tones: Record<string, string> = {
    green: "bg-green-400",
    red: "bg-red-400",
    amber: "bg-amber-400",
    zinc: "bg-zinc-600",
    violet: "bg-violet-400",
  };
  return <span aria-hidden className={clsx("inline-block h-1.5 w-1.5 shrink-0 rounded-full", tones[tone], pulse && "animate-pulse-gold")} />;
}

export function GoldButton({ children, onClick, disabled, tone = "gold", className, type, testid }: {
  children: ReactNode; onClick?: () => void; disabled?: boolean;
  tone?: "gold" | "green" | "red" | "ghost"; className?: string; type?: "button" | "submit"; testid?: string;
}) {
  const tones: Record<string, string> = {
    gold: "bg-amber-500 text-zinc-950 hover:bg-amber-400 disabled:bg-zinc-700 disabled:text-zinc-400",
    green: "bg-green-600 text-white hover:bg-green-500 disabled:bg-zinc-700 disabled:text-zinc-400",
    red: "bg-red-600 text-white hover:bg-red-500 disabled:bg-zinc-700 disabled:text-zinc-400",
    ghost: "border border-zinc-700 text-zinc-300 hover:border-amber-500/60 hover:text-amber-300 disabled:opacity-40",
  };
  return (
    <button
      type={type ?? "button"}
      onClick={onClick}
      disabled={disabled}
      data-testid={testid}
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

/** µ → יחידות-קריאות (1,000µ = 1 יחידה) — פלט-stable למנוע-המסחר (לא-locale) */
export function fmt(mu: number, digits = 2): string {
  const v = mu / 1000;
  return v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

export function shortHash(h: string, n = 10): string {
  return h ? `${h.slice(0, n)}…` : "—";
}
