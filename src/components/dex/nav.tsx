"use client";

/**
 * nav.tsx — Roast-73 · ניווט-הטרמינל-הריבוני (Roast-73 · תצוגות-על-גבי-הטרמינל)
 * ═════════════════════════════════════════════════════════════════════════════
 * דפוס-זהה ל-nav של UI-האם (nav.tsx): טאבים-שולחניים (hidden md:flex) + סרגל-תחתון
 * נייד (md:hidden · grid + גיליון "עוד") — בשפה-המוסדית של הטרמינל (zinc-950 ·
 * אמבר · monospace · אפס-אימוג'ים). RTL: הפריטים נפתחים-מימין; הגיליון-תחתון
 * עם safe-area-inset (הכלל-הקבוע של האפליקציה).
 */

import { useState } from "react";
import { Activity, Bot, ChevronDown, Menu, X } from "lucide-react";

export type ViewId = "terminal" | "agent";

export interface NavItem { id: ViewId; label: string; icon: React.ComponentType<{ className?: string }> }
export interface QuickJump { label: string; icon: React.ComponentType<{ className?: string }>; onClick: () => void }

/** רישום-התצוגות בניווט — מקור-אמת-אחד לשולחני ולנייד (בדיוק כמו EXCHANGE_NAV באם) */
export const DEX_VIEWS: NavItem[] = [
  { id: "terminal", label: "טרמינל", icon: Activity },
  { id: "agent", label: "סוכן", icon: Bot },
];

/* ── שולחני: טאבים מתחת לכותרת ─────────────────────────────────────────────── */
export function TopTabs({ view, onNavigate }: { view: ViewId; onNavigate: (v: ViewId) => void }) {
  return (
    <nav aria-label="ניווט-ראשי" className="hidden items-center gap-1.5 md:flex" data-testid="top-tabs">
      {DEX_VIEWS.map((v) => {
        const Icon = v.icon;
        const active = view === v.id;
        return (
          <button
            key={v.id} type="button" onClick={() => onNavigate(v.id)}
            aria-current={active ? "page" : undefined}
            className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3.5 font-mono text-[11px] font-bold transition-colors ${
              active
                ? "border-amber-500/60 bg-amber-500/10 text-amber-300"
                : "border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
            }`}
            data-testid={`tab-${v.id}`}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden /> {v.label}
          </button>
        );
      })}
    </nav>
  );
}

/* ── נייד: סרגל-תחתון-קבוע + גיליון "עוד" ──────────────────────────────────── */
export function MobileNav({ view, onNavigate, quickJumps }: {
  view: ViewId; onNavigate: (v: ViewId) => void; quickJumps: QuickJump[];
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <>
      <nav
        aria-label="ניווט-תחתון"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-zinc-800 bg-zinc-950/95 backdrop-blur md:hidden"
        data-testid="mobile-nav"
      >
        <div className="grid grid-cols-3 pt-1 pb-[max(env(safe-area-inset-bottom),6px)]">
          {DEX_VIEWS.map((v) => {
            const Icon = v.icon;
            const active = view === v.id;
            return (
              <button
                key={v.id} type="button" onClick={() => onNavigate(v.id)}
                aria-current={active ? "page" : undefined}
                className="flex min-h-[44px] flex-col items-center justify-center gap-0.5 py-1.5"
                data-testid={`mobile-tab-${v.id}`}
              >
                <Icon className={`h-[18px] w-[18px] ${active ? "text-amber-400" : "text-zinc-500"}`} aria-hidden />
                <span className={`text-[9px] font-bold ${active ? "text-amber-300" : "text-zinc-500"}`}>{v.label}</span>
              </button>
            );
          })}
          {/* עוד — גיליון-כל-התצוגות (בדיוק-כמו-האם) */}
          <button
            type="button" onClick={() => setOpen(true)}
            aria-haspopup="dialog" aria-expanded={open}
            className="flex min-h-[44px] flex-col items-center justify-center gap-0.5 py-1.5"
            data-testid="mobile-more"
          >
            <Menu className={`h-[18px] w-[18px] ${open ? "text-amber-400" : "text-zinc-500"}`} aria-hidden />
            <span className={`text-[9px] font-bold ${open ? "text-amber-300" : "text-zinc-500"}`}>עוד</span>
          </button>
        </div>
      </nav>

      {open && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="כל-התצוגות" data-testid="more-sheet">
          <div className="absolute inset-0 bg-black/60" onClick={close} aria-hidden />
          <div className="animate-rise absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-zinc-800 bg-zinc-950 px-4 pt-3 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-1.5 text-sm font-bold text-zinc-200">
                <ChevronDown className="h-4 w-4 text-amber-400" aria-hidden /> כל-התצוגות
              </h2>
              <button
                type="button" onClick={close} aria-label="סגור"
                className="flex h-8 w-8 items-center justify-center rounded-full border border-zinc-800 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {DEX_VIEWS.map((v) => {
                const Icon = v.icon;
                const active = view === v.id;
                return (
                  <button
                    key={v.id} type="button"
                    onClick={() => { onNavigate(v.id); close(); }}
                    className={`flex min-h-[64px] flex-col items-center justify-center gap-1.5 rounded-lg border p-3 text-[11px] font-bold transition-colors ${
                      active ? "border-amber-500/50 bg-amber-500/[0.06] text-amber-300" : "border-zinc-800 bg-zinc-900/70 text-zinc-300 hover:border-zinc-600"
                    }`}
                    data-testid={`more-item-${v.id}`}
                  >
                    <Icon className="h-4 w-4 text-zinc-400" aria-hidden /> {v.label}
                  </button>
                );
              })}
              {quickJumps.map((q) => {
                const Icon = q.icon;
                return (
                  <button
                    key={q.label} type="button"
                    onClick={() => { q.onClick(); close(); }}
                    className="flex min-h-[64px] flex-col items-center justify-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/70 p-3 text-[11px] font-bold text-zinc-300 transition-colors hover:border-zinc-600"
                  >
                    <Icon className="h-4 w-4 text-zinc-400" aria-hidden /> {q.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
