import { NextResponse } from "next/server";
import { submitOp, nextNonce } from "@/lib/dex/chain";
import { consoleGuard } from "@/lib/dex/guard";
import { operatorAuth } from "@/lib/operator-auth";
import { POOL_OPEN_MIN_SIDE_MU } from "@/lib/dex/kernel";
import { isMakerIdentity } from "@/lib/dex/maker"; // EXEC-CD-9 · אותו-שער-זהויות

export const dynamic = "force-dynamic";

/** ניהול-בריכות:
 *  · open   — פתיחת-בריכה-חדשה (Roast-71). EXEC-CD-9 · חצי-פתוח (אישור-מפעיל):
 *             issuer=treasury (ברירת-מחדל) = הנתיב-הריבוני (זריעה-מהאוצר, LP=√k לאוצר,
 *             בלי-שער) · issuer=<אזרח> = הנתיב-הפתוח — זריעה-דו-צדדית-מהיתרות-של-הפותח
 *             עצמו, LP=√k כולו-לפותח, **שער-הערבות**: מינימום POOL_OPEN_MIN_SIDE_MU
 *             (${POOL_OPEN_MIN_SIDE_MU}µ) פר-צד + תקרת-בריכות-פר-פותח (8 בגרעין).
 *             אפס-כסף-אוצר-בסיכון; האוצר-רק-מרוויח (נתח-ה-30% מעמלי-הסוואפ).
 *  · add    — הוספת-נזילות (פרופורציונלי) — מנפיק operator (ברירת-מחדל) או treasury.
 *  · remove — פריקה pro-rata LP. */
export async function POST(req: Request) {
  // P0(25-a): שער-מפעיל — מוטציה דורשת טוקן x-saos-operator (בלי DEX_OPERATOR_TOKEN: 503 fail-closed)
  const oa = operatorAuth(req);
  if (oa) return oa;

  // FIX(FOUNDRY top-bug): שער-קונסולה — מוטציה-דורשת-כותרת-מנהלת
  const g = consoleGuard(req);
  if (g) return g;

  const body = (await req.json().catch(() => ({}))) as {
    action?: "open" | "add" | "remove";
    pair?: string; amountA?: number; amountB?: number; lp?: number; issuer?: string;
  };
  const pair = body.pair;
  if (!pair) return NextResponse.json({ ok: false, error: "pair-required" }, { status: 200 });

  if (body.action === "open") {
    // Roast-71 · POOL-OPEN: pair קנוני — amountA=צד-שמאל, amountB=צד-ימין.
    const amountA = Math.floor(Number(body.amountA));
    const amountB = Math.floor(Number(body.amountB));
    if (!(amountA > 0) || !(amountB > 0)) {
      return NextResponse.json({ ok: false, error: "bad-open (נדרש pair קנוני + amountA>0 + amountB>0)" }, { status: 200 });
    }
    // EXEC-CD-9 · נתיב-אזרחי חצי-פתוח: issuer רשות (ברירת-מחדל: treasury = ריבוני).
    // הגרעין אוכף את שער-הערבות (מינימום-פר-צד) ואת תקרת-הבריכות — הכל fail-closed שם.
    const opener = body.issuer ? String(body.issuer).toLowerCase() : "treasury";
    if (opener !== "treasury" && !isMakerIdentity(opener)) {
      return NextResponse.json({ ok: false, error: "bad-issuer (אזרח: a-z0-9- 3..24; או treasury)" }, { status: 200 });
    }
    const citizen = opener !== "treasury";
    if (citizen && (amountA < POOL_OPEN_MIN_SIDE_MU || amountB < POOL_OPEN_MIN_SIDE_MU)) {
      return NextResponse.json({
        ok: false,
        error: `below-margin-gate (שער-הערבות: מינימום ${POOL_OPEN_MIN_SIDE_MU}µ פר-צד — נתיב-אזרחי; האוצר פטור)`,
      }, { status: 200 });
    }
    const r = submitOp({
      type: "pool_open", issuer: opener, nonce: nextNonce("po"),
      pair, amount: amountA, amountB,
    });
    return NextResponse.json({
      ok: r.queued, error: r.reason,
      path: citizen ? "citizen (LP=√k לפותח · owner=מנפיק)" : "sovereign (LP=√k לאוצר)",
    });
  }

  if (body.action === "add") {
    const amountA = Math.floor(Number(body.amountA));
    if (!(amountA > 0)) return NextResponse.json({ ok: false, error: "bad-amount" }, { status: 200 });
    // FIX(Roast-71 · issuer-whitelist): היה-מוכתב-operator — שהפיל-הוספות-אוצר
    // (למשל-העמקת-ENERGY-מהיתרות-של-האוצר) על-insufficient. רשימה-סגורה fail-closed.
    const issuer = String(body.issuer || "operator").toLowerCase();
    if (issuer !== "operator" && issuer !== "treasury") {
      return NextResponse.json({ ok: false, error: "bad-issuer" }, { status: 200 });
    }
    const r = submitOp({
      type: "pool_add", issuer, nonce: nextNonce("pa"),
      pair, amount: amountA,
    });
    return NextResponse.json({ ok: r.queued, error: r.reason });
  }

  if (body.action === "remove") {
    const lp = Math.floor(Number(body.lp));
    if (!(lp > 0)) return NextResponse.json({ ok: false, error: "bad-lp" }, { status: 200 });
    const r = submitOp({
      type: "pool_rmw", issuer: "operator", nonce: nextNonce("pr"),
      pair, lp,
    });
    return NextResponse.json({ ok: r.queued, error: r.reason });
  }

  return NextResponse.json({ ok: false, error: "bad-action" }, { status: 200 });
}
