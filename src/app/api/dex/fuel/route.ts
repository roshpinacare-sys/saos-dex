import { NextResponse } from "next/server";
import { ensureChain, submitOp, nextNonce } from "@/lib/dex/chain";
import { funderFor, REFUEL_CAP, FUEL_FUNDERS, type FuelFunder } from "@/lib/dex/kernel";
import { consoleGuard } from "@/lib/dex/guard";
import { operatorAuth } from "@/lib/operator-auth";

export const dynamic = "force-dynamic";

/* ══ עירוי-דלק-סוכן (EXEC-CD-22 · THE-LEGION תשתית) ═════════════════════════
 * POST /api/dex/fuel {to, amount?} → op refuel (העברת-קרדיטים-טהורה, אפס-הטבעה,
 * Σcredits נשמר — האינווריאנטה עומדת). סולם-המממנים הקנוני funderFor:
 * arena → בוטים → אוצר → מפעיל. תקרת-REFUEL_CAP פר-פקודה (גבול-נזק).
 * שער-מפעיל + שער-קונסולה. מיועד לחיילים-אמיתיים-ממומנים (מנדט msg-8):
 * בלי-גז אין-פקודות — ובלי-פקודות אין-עומק-אמת. */

const idOk = (s: string): boolean => /^[a-z0-9][a-z0-9-]{0,30}$/.test(s);

export async function POST(req: Request) {
  const oa = operatorAuth(req);
  if (oa) return oa;
  const g = consoleGuard(req);
  if (g) return g;

  const body = (await req.json().catch(() => ({}))) as { to?: string; amount?: number };
  const to = String(body.to || "").toLowerCase();
  if (!idOk(to)) return NextResponse.json({ ok: false, error: "bad-agent" }, { status: 200 });
  const rt = ensureChain();
  const st = rt.st;
  const have = st.credits[to] ?? 0;
  const want = Math.floor(Number(body.amount) || 1_000);
  const amt = Math.min(Math.max(0, want - have), REFUEL_CAP);
  if (amt <= 0) return NextResponse.json({ ok: true, note: `ל-${to} כבר יש ${have}µ credits — אין-צורך` });
  let funder: FuelFunder | null = funderFor(st, amt, to);
  if (!funder) {
    // סולם-חירום (conservation-true): רק-ממני-דלק-חוקיים (FUEL_FUNDERS — הגרעין
    // דוחה כל-מנפיק-אחר "funder-only", ולכן-הסולם-חייב-להישאר-בתוך-הרשימה-הקנונית),
    // העשיר-ביותר-ראשון. שמות-מטוהרים (agent_purge) וחיילים-מתים נשללים-ממילא —
    // מחוץ-לרשימה. העברה-טהורה — Σcredits נשמר מעצמו.
    const rich = Object.entries(st.credits ?? {})
      .filter(([n, c]) => (FUEL_FUNDERS as readonly string[]).includes(n) && n !== to && Number(c) >= amt)
      .sort((a, b) => Number(b[1]) - Number(a[1]))[0];
    funder = (rich?.[0] as FuelFunder) ?? null;
  }
  if (!funder) return NextResponse.json({ ok: false, error: "no-funder (הסולם יבש — המזרקה תמלא כשעמלות-אמת יימדדו)" }, { status: 200 });
  const r = submitOp({ type: "refuel", issuer: funder, nonce: nextNonce("rf"), to, amount: amt });
  return NextResponse.json({ ok: r.queued, error: r.reason ?? undefined, note: r.queued ? `${to} +${amt}µ credits ← ${funder} (had ${have})` : undefined });
}
