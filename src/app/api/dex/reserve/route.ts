import { NextResponse } from "next/server";
import { submitOp, nextNonce, getLiveState, chainVersion } from "@/lib/dex/chain";
import { consoleGuard } from "@/lib/dex/guard";
import { operatorAuth } from "@/lib/operator-auth";
import {
  reserveMeasure, RESERVE_PHASES, RESERVE_VAULT, LADDER_EVERY,
  RESERVE_REDEEM_WINDOW_CAP_BPS, EPOCH_BLOCKS,
} from "@/lib/dex/kernel";

export const dynamic = "force-dynamic";

/**
 * GET /saos-dex/api/dex/reserve — סולם-הגיבוי (EXEC-CD-21) · מטבעות-הבית → כסף-אמת.
 * GET ציבורי לחלוטין — "השקיפות-היא-המוצר": כל-הנתונים נמדדים-חי מהמצב-הקנוני
 * (reserveMeasure) ואין בו אף-טענה שאי-אפשר לאמת מה-wallets/census.
 */
export async function GET() {
  const st = getLiveState();
  const m = reserveMeasure(st);
  const r = st.reserve ?? null;
  const phase = r?.phase ?? 0;
  const cur = RESERVE_PHASES[phase] ?? null;
  const next = RESERVE_PHASES.find((p) => p.id === phase + 1) ?? null;
  const ph3 = RESERVE_PHASES[3];
  const redeemOpen = phase >= 3 && ph3 !== undefined && m.unitBps >= ph3.unitBps;
  return NextResponse.json({
    ok: true,
    height: st.height,
    version: chainVersion(),
    vault: RESERVE_VAULT,
    phase,
    phaseName: cur?.name ?? "—",
    phaseNote: cur?.note ?? "",
    sinceH: r?.sinceH ?? 0,
    measure: m,
    unitPct: m.unitBps / 100,
    realPct: m.realBps / 100,
    next: next
      ? {
          id: next.id,
          name: next.name,
          unitBps: next.unitBps,
          realBps: next.realBps,
          unitGapMu: Math.max(0, Math.floor((next.unitBps * m.supplyMu) / 10_000) - m.unitMu),
          realGapMu: Math.max(0, Math.floor((next.realBps * m.supplyMu) / 10_000) - m.realMu),
          note: next.note,
        }
      : null,
    streak: r?.streak ?? 0,
    streakTarget: r?.streakTarget ?? 0,
    every: LADDER_EVERY,
    blocksLeft: LADDER_EVERY - (st.height % LADDER_EVERY),
    totals: {
      sweptMu: r?.sweptMu ?? 0,
      routerSlicedMu: r?.routerSlicedMu ?? 0,
      realSwappedMu: r?.realSwappedMu ?? 0,
      redeemMu: r?.redeemMu ?? 0,
    },
    redeem: {
      open: redeemOpen,
      windowCapMu: Math.floor((m.unitMu * RESERVE_REDEEM_WINDOW_CAP_BPS) / 10_000),
      windowUsedMu: r?.redeemWindowMu ?? 0,
      windowBlocks: EPOCH_BLOCKS,
    },
    events: (r?.events ?? []).slice(-24).reverse(),
    phases: RESERVE_PHASES,
  });
}

/** POST — redeem_saos (פדיון-מדרגה-3+): שריפת-SAOS מול כספת-העתודה.
 * הזהות = `as` (אזרח-מאומת-מהקונסולה) או operator — אותו-משטר-שערים כמו-כל-המוטציות. */
export async function POST(req: Request) {
  const oa = operatorAuth(req);
  if (oa) return oa;
  const g = consoleGuard(req);
  if (g) return g;

  const body = (await req.json().catch(() => ({}))) as { action?: string; amount?: number; as?: string };
  const amount = Math.floor(Number(body.amount ?? 0));
  const who = String(body.as ?? "operator").trim().toLowerCase() || "operator";

  switch (body.action) {
    case "redeem_saos": {
      if (!(amount > 0)) return NextResponse.json({ ok: false, error: "bad-amount" }, { status: 200 });
      const r = submitOp({ type: "redeem_saos", issuer: who, nonce: nextNonce("rdm"), amount });
      return NextResponse.json({ ok: r.queued, error: r.reason });
    }
    default:
      return NextResponse.json({ ok: false, error: "unknown-action" }, { status: 200 });
  }
}
