import { NextResponse } from "next/server";
import { fleetProbe, fleetSealNow, fleetStatusPublic } from "@/lib/dex/fleet";
import { latestSealForFleet, recordFleetAnchor } from "@/lib/dex/relay";
import { consoleGuard } from "@/lib/dex/guard";
import { operatorAuth } from "@/lib/operator-auth";

export const dynamic = "force-dynamic";

/* ══ SOVEREIGN-FLEET (SETTLE-13) — צי-העיגון-הריבוני ═════════════════════════
 * GET — טלמטריית-צי (אפס-סודות): חשבונות, סמכויות-חיות, RC, שימושיות, עיגונים.
 * POST — פעולות (שער-מפעיל + קונסולה, fail-closed):
 *   · probe  — בדיקה-חיה-מיידית (סמכויות מול-get_accounts + RC-קנוני).
 *   · anchor — עיגון-צי-מיידי על החותם-המתאים-ביותר (מהתור; אחרת-הרשומה-האחרונה).
 * החתימה-מקומית-מהכספת-האטומה (agent/keys, gitignored) — POSTING-בלבד, אפס-עלות.
 * אין-הדפסת/החזרת-סודות-בשום-נתיב. */

export async function GET() {
  return NextResponse.json({ ok: true, fleet: fleetStatusPublic() });
}

export async function POST(req: Request) {
  const oa = operatorAuth(req);
  if (oa) return oa;
  const g = consoleGuard(req);
  if (g) return g;

  const body = (await req.json().catch(() => ({}))) as { action?: string };
  switch (String(body.action || "")) {
    case "probe": {
      await fleetProbe(true);
      return NextResponse.json({ ok: true, fleet: fleetStatusPublic() });
    }
    case "anchor": {
      const seal = latestSealForFleet();
      if (!seal) return NextResponse.json({ ok: false, error: "no seal available to anchor (chain not sealing yet)" }, { status: 409 });
      const payload = {
        protocol: "saos-dex/v1", action: "chain-seal", at: seal.at,
        height: seal.height, stateRoot: seal.stateRoot, digest: seal.digest,
      };
      try {
        const r = await fleetSealNow(payload);
        // SETTLE-17: סגירת-הפער-ההיסטורי — עיגון-ידני-נרשם-בפנקס-הציבורי
        // (היה: bypass-שקט — 3-עיגוני-SETTLE-13-החיים-לא-נרשמו-מעולם) + פיוס-אוטומטי.
        recordFleetAnchor(seal.height, seal.stateRoot, seal.digest, r.txid, r.account);
        return NextResponse.json({ ok: true, anchored: r, seal: { height: seal.height, stateRoot: seal.stateRoot } });
      } catch (e) {
        return NextResponse.json({ ok: false, error: String((e as Error)?.message || e).slice(0, 160) }, { status: 502 });
      }
    }
    default:
      return NextResponse.json({ ok: false, error: "unknown action (probe|anchor)" }, { status: 400 });
  }
}
