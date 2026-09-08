import { NextResponse } from "next/server";
import { ensureChain, getState, getLiveState, getBurnWindow, CODE_VERSION } from "@/lib/dex/chain";
import { genesisTotals, ledgerAudit, runwayCheck } from "@/lib/dex/settle";
import { relayStatus } from "@/lib/dex/relay";

export const dynamic = "force-dynamic";

/**
 * /api/dex/metrics — נקודת-תצפית-תפעולית (M1 מה-ROADMAP — SETTLE-7 מממש-אותה).
 * Prometheus-text (scrape-ready) + JSON מלא ב-?format=json. אפס-סודות:
 * רק-מדדים ציבוריים — שרשרת, דלק/ריצה, אינוואריאנטות, פסי-עיגון.
 * ממצא-הסקר (SETTLE-7): כל-הנתונים כבר-היו-חיים ב-relayStatus()/chain — היה
 * חסר רק קצה-אחיד לגרירה-חיצונית (DEPLOYMENT_CHECKLIST B2 דרש-את-זה).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const rt = ensureChain();
  const st = getLiveState();
  const s = getState();
  const audit = ledgerAudit(st, genesisTotals());
  const runway = runwayCheck(st, undefined, getBurnWindow());
  const relay = relayStatus() as {
    enabled: boolean; queue: number; metrics: Record<string, number>;
    chains: Record<string, { enabled?: boolean; breaker?: string; openUntil?: number | null; attempts?: number }>;
  };

  const lines: string[] = [];
  const push = (name: string, value: number | string, help?: string, type = "gauge"): void => {
    if (help) lines.push(`# HELP ${name} ${help}`);
    if (type) lines.push(`# TYPE ${name} ${type}`);
    lines.push(`${name} ${typeof value === "string" ? JSON.stringify(value) : value}`);
  };

  // ── שרשרת ──
  push("saos_height", s.height, "current block height");
  push("saos_ops_total", s.opsTotal);
  push("saos_fills_total", s.fills, undefined, "counter");
  push("saos_swaps_total", s.swaps, undefined, "counter");
  push("saos_ladders_total", s.ladders, undefined, "counter");
  push("saos_tps_rolling", s.tps);
  push("saos_build_ms_rolling", s.buildMs);
  push("saos_uptime_seconds", s.uptimeSec);
  push("saos_live_orders", s.liveOrders);
  push("saos_mempool", rt.mempool.length);
  push("saos_db_ok", s.dbOk ? 1 : 0, "evidence DB reachable");
  push("saos_halted", s.halted ? 1 : 0, "fail-fast halt (invariant violation)");
  push("saos_halting_reason", s.haltReason ?? "none");
  push("saos_code_version", CODE_VERSION, undefined, "info");
  push("saos_next_seal_in_blocks", s.nextSealIn);

  // ── דלק/סיבולת (SETTLE-5/7) ──
  push("saos_credits_total", runway.totalCredits, "Σ fuel credits in the closed SIM economy");
  push("saos_burn_per_block", runway.burnPerHeight, "windowed burn (fuelSamples ring) — honest current-regime burn");
  push("saos_burn_window_blocks", runway.burnWindowBlocks ?? 0, "0 = fell back to lifetime average (young window)");
  push("saos_runway_hours", runway.systemRunwayHours, "hours of life at current burn");
  push("saos_runway_level", runway.level);
  push("saos_gas_used_total", s.gasUsed, undefined, "counter");

  // ── אוצר/עמלות ──
  push("saos_treasury_profit", s.treasuryProfit);
  push("saos_fee_meter", s.feeMeter, "unharvested measured fees");

  // ── אינוואריאנטות (ברזל) ──
  push("saos_invariant_credits_ok", audit.credits.ok ? 1 : 0, "Σcredits+gasUsed−feeMinted === genesis");
  push("saos_invariant_escrow_ok", audit.escrow.ok ? 1 : 0, "Σlocks === Σorder lockMu, avail ≥ 0");
  push("saos_invariant_fees_ok", audit.fees.ok ? 1 : 0, "poolsTreasury === feeMeter+profit+minted");
  push("saos_invariant_negatives", audit.negatives.length, "accounts with negative balances (must stay 0)");

  // ── פסי-עיגון (relay) ──
  push("saos_relay_enabled", relay.enabled ? 1 : 0, "operator keys present");
  push("saos_relay_queue", relay.queue);
  for (const [chain, cs] of Object.entries(relay.chains ?? {})) {
    push(`saos_relay_chain_enabled{chain="${chain}"}`, cs?.enabled ? 1 : 0);
    push(`saos_relay_chain_breaker{chain="${chain}"}`, cs?.breaker ?? "closed");
  }
  for (const [k, v] of Object.entries(relay.metrics ?? {})) {
    if (typeof v === "number") push(`saos_relay_${k}`, v, undefined, "counter");
  }

  if (url.searchParams.get("format") === "json") {
    return NextResponse.json({ ok: true, at: Date.now(), codeVersion: CODE_VERSION, chain: s, runway, audit, relay });
  }
  return new NextResponse(lines.join("\n") + "\n", {
    headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" },
  });
}
