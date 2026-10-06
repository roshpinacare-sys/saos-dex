import { NextResponse } from "next/server";
import { submitOp, nextNonce, getLiveState } from "@/lib/dex/chain";
import { REFUEL_CAP } from "@/lib/dex/kernel";
import { rebateUnpaidMu, makerIdentities, isMakerIdentity, rebateMarkPaid, MAKER_REBATE_BPS } from "@/lib/dex/maker";
import { consoleGuard } from "@/lib/dex/guard";
import { operatorAuth } from "@/lib/operator-auth";

export const dynamic = "force-dynamic";

/**
 * EXEC-CD-9 · POST /api/dex/maker/rebate-settle — סליקת-ריבייטים (Maker-API).
 *
 * החוליה-שסוגרת-את-הזרם (maker.ts header): מחזור-גז-הספר מזרים קרדיטים-דלק
 * לארנק-האוצר (economy.bookGasRecycle) → הסליקה משלמת למייקרים-האמת לפי-הייחוס
 * (fills עם-attribution — מסחר-אמת-בלבד) ב-**refuel-גרעיני-אמת** — העברה-טהורה
 * אפס-הטבעה (Σcredits נשמר), אותו-op-מיומן של-סולם-הדלק.
 *
 * כנות fail-closed: אם-לאוצר אין-דלק-מספיק — הגרעין דוחה (insufficient-credits)
 * והמסלול מדווח-כנה; rebateMarkPaid נרשם **רק** על-תשלום-שנתקבל-לתור.
 * תקרות: REFUEL_CAP פר-op; בקשה-גדולה → תשלום-חלקי-כן + יתרה-נשארת-חייבת.
 *
 * גוף רשות: { issuer?: string } — מייקר-אחד; בלי-גוף = סליקת-כל-המייקרים-המיוחסים
 * (≤8-תשלומים-פר-קריאה — אותו-גבול-אצווה של-הגרעין).
 */
export async function POST(req: Request) {
  const oa = operatorAuth(req);
  if (oa) return oa;
  const g = consoleGuard(req);
  if (g) return g;

  const body = (await req.json().catch(() => ({}))) as { issuer?: string };
  const st = getLiveState();

  // רשימת-יעדים: מייקר-מבוקש או כל-המיוחסים (סדר-ממוין — דטרמיניזם-תפעולי)
  let targets: string[];
  if (body.issuer) {
    const who = String(body.issuer).toLowerCase();
    if (!isMakerIdentity(who)) {
      return NextResponse.json({ ok: false, error: "bad-identity (a-z0-9- 3..24; שמות-מערכת-אסורים)" }, { status: 200 });
    }
    targets = [who];
  } else {
    targets = makerIdentities().sort().slice(0, 8);
  }

  const results: { issuer: string; dueMu: number; paidMu: number; queued: boolean; error?: string }[] = [];
  for (const who of targets) {
    const due = rebateUnpaidMu(who);
    if (due <= 0) { results.push({ issuer: who, dueMu: 0, paidMu: 0, queued: false, error: "nothing-due" }); continue; }
    const pay = Math.min(due, REFUEL_CAP); // תקרת-הגרעין פר-op — השאר נשאר חייב (כנות)
    const treasuryFuel = st.credits["treasury"] ?? 0;
    if (treasuryFuel < pay) {
      results.push({ issuer: who, dueMu: due, paidMu: 0, queued: false, error: `treasury-fuel-dry (${treasuryFuel}µ credits — ממתין למחזור-גז-הבא)` });
      continue;
    }
    const r = submitOp({ type: "refuel", issuer: "treasury", nonce: nextNonce("mmrb"), to: who, amount: pay });
    if (r.queued) {
      // סימון-מונוטוני רק-על-תשלום-שנתקבל-לתור (הגרעין עשוי-עדיין לדחות-בבלוק —
      // אז-התשלום-לא-בוצע-בפועל; המד-הכנה: הסליקה-הבאה-תזהה-את-היתרה-ותנסה שוב)
      rebateMarkPaid(who, pay);
    }
    results.push({ issuer: who, dueMu: due, paidMu: r.queued ? pay : 0, queued: r.queued, error: r.reason });
  }

  return NextResponse.json({
    ok: results.some((r) => r.queued) || results.every((r) => r.error === "nothing-due"),
    rebateRateBps: MAKER_REBATE_BPS,
    results,
    note: "ריבייט בקרדיטי-דלק ממחזור-גז-הספר (זרם-סגור) — refuel טהור, אפס-הטבעה",
  });
}
