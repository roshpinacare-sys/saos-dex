import { NextResponse } from "next/server";
import { submitOp, nextNonce, getLiveState } from "@/lib/dex/chain";
import { consoleGuard } from "@/lib/dex/guard";
import { operatorAuth } from "@/lib/operator-auth";
import { vePoints, totalVePoints } from "@/lib/dex/economy";
import { effectiveFeeBps } from "@/lib/dex/amm";
import {
  EPOCH_BLOCKS, ROUTER_EVERY, VE_MAX_WEEKS, VE_MIN_WEEKS, VE_VAULT, VE_POT,
  BOND_DISC_BPS, BOND_VE_WEEKS, BOND_MIN_USDS, BOND_MAX_USDS,
  REV_BURN_PCT, REV_VE_PCT,
} from "@/lib/dex/kernel";
import { REV_TREASURY_PCT } from "@/lib/dex/economy";

export const dynamic = "force-dynamic";

/** GET — מצב-הכלכלה המלא: veSAOS · ראוטר-ההכנסות · בונדים · עמלים-דינמיים. */
export async function GET() {
  const st = getLiveState();
  const h = st.height;
  const positions = Object.entries(st.ve ?? {}).map(([who, pos]) => ({
    who,
    amtMu: pos.amt,
    unlockH: pos.unlockH,
    weeks: pos.weeks,
    vePoints: vePoints(st, who, h),
    locked: h < pos.unlockH,
  }));
  const votes = Object.entries(st.veVotes ?? {}).map(([who, pool]) => ({ who, pool, weight: vePoints(st, who, h) }));
  const pools = Object.entries(st.pools).map(([key, p]) => ({
    key, a: p.a, b: p.b,
    feeBps: effectiveFeeBps(p),
    volBpsEwma: p.volBpsEwma ?? 0,
    swaps: p.swaps,
  }));
  const price = st.pools["SAOS/USDS"] ? Math.floor((st.pools["SAOS/USDS"].rb * 1000) / st.pools["SAOS/USDS"].ra) : 0;
  const bondPrice = price > 0 ? Math.floor((price * (10_000 - BOND_DISC_BPS)) / 10_000) : 0;
  return NextResponse.json({
    ok: true,
    height: h,
    epoch: {
      index: st.veEpoch ?? 0,
      blocksLeft: EPOCH_BLOCKS - (h % EPOCH_BLOCKS),
      every: EPOCH_BLOCKS,
    },
    ve: {
      totalPoints: totalVePoints(st, h),
      vaultMu: st.balances[VE_VAULT]?.SAOS ?? 0,
      potMu: st.balances[VE_POT]?.USDS ?? 0,
      positions,
      votes,
      maxWeeks: VE_MAX_WEEKS,
      minWeeks: VE_MIN_WEEKS,
    },
    revenue: {
      ...st.rev,
      burnedSaosMu: st.burnedSaos ?? 0,
      treasuryProfitMu: st.treasuryProfit,
      every: ROUTER_EVERY,
      blocksLeft: ROUTER_EVERY - (h % ROUTER_EVERY),
      burnPct: REV_BURN_PCT,
      vePct: REV_VE_PCT,
      treasuryPct: REV_TREASURY_PCT,
      saosSupplyMu: Object.values(st.balances).reduce((s, w) => s + (w.SAOS ?? 0), 0) + (st.balances[VE_VAULT]?.SAOS ?? 0),
    },
    bonds: {
      ...st.bond,
      discBps: BOND_DISC_BPS,
      veWeeks: BOND_VE_WEEKS,
      minUsds: BOND_MIN_USDS,
      maxUsds: BOND_MAX_USDS,
      refPrice: price,
      bondPrice,
    },
    dynamicFees: pools,
  });
}

/** POST — ve_lock / ve_unlock / ve_vote / bond_buy (מנופק-כ-operator). */
export async function POST(req: Request) {
  const oa = operatorAuth(req);
  if (oa) return oa;
  const g = consoleGuard(req);
  if (g) return g;

  const body = (await req.json().catch(() => ({}))) as {
    action?: "ve_lock" | "ve_unlock" | "ve_vote" | "bond_buy";
    amount?: number; weeks?: number; pair?: string;
  };
  const amount = Math.floor(Number(body.amount ?? 0));

  switch (body.action) {
    case "ve_lock": {
      const weeks = Math.floor(Number(body.weeks ?? 0));
      if (!(amount > 0)) return NextResponse.json({ ok: false, error: "bad-amount" }, { status: 200 });
      const r = submitOp({ type: "ve_lock", issuer: "operator", nonce: nextNonce("vel"), asset: "SAOS", amount, weeks });
      return NextResponse.json({ ok: r.queued, error: r.reason });
    }
    case "ve_unlock": {
      const r = submitOp({ type: "ve_unlock", issuer: "operator", nonce: nextNonce("veu") });
      return NextResponse.json({ ok: r.queued, error: r.reason });
    }
    case "ve_vote": {
      const pair = String(body.pair ?? "");
      if (!pair) return NextResponse.json({ ok: false, error: "pair-required" }, { status: 200 });
      const r = submitOp({ type: "ve_vote", issuer: "operator", nonce: nextNonce("vev"), pair });
      return NextResponse.json({ ok: r.queued, error: r.reason });
    }
    case "bond_buy": {
      if (!(amount > 0)) return NextResponse.json({ ok: false, error: "bad-amount" }, { status: 200 });
      const r = submitOp({ type: "bond_buy", issuer: "operator", nonce: nextNonce("bnd"), asset: "USDS", amount });
      return NextResponse.json({ ok: r.queued, error: r.reason });
    }
    default:
      return NextResponse.json({ ok: false, error: "bad-action" }, { status: 200 });
  }
}
