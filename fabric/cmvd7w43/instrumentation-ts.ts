import { NextRequest, NextResponse } from 'next/server';

/**
 * instrumentation.ts — הדמון-נלווה: השרשרת קמה עם-השרת (מורשת guardian_boot).
 * SETTLE-17: נגן-אבני-הדרך עולה-עמה — P&L-מסומן-לעוגן נעגן-אוטומטית-על-Hive
 * דרך-צי-העיגון (globalThis-סינגלטון — אפס-split-brain בין-מופעי-באנדל).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { ensureChain } = await import("@/lib/dex/chain");
    ensureChain();
    const { startMilestoneWatchdog } = await import("@/lib/dex/milestone");
    startMilestoneWatchdog();
  }
}
