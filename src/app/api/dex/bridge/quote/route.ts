import { NextResponse } from "next/server";
import { fixedfloatGetRate } from "@/lib/dex/fixedfloat";
import { sovereignQuote, SOVEREIGN_PAIRS } from "@/lib/dex/sovereign-quote";

export const dynamic = "force-dynamic";

/* ══ BRIDGE QUOTE (directive §4 foundation · task E12 · W-FRELEASE) ═════════
 * הבעלים (2026-11-05, trace 1a1ab989d8db0a91): "Fixedfloat בנתיים לא עובד בוא
 * נשחרר את זה ונמצא דרכים שאתה יכול ליישם דרך הבלוקצ'יין שלנו לשם זה במקום".
 *
 * מאז-השחרור (W-FRELEASE) הניתוב-ברירת-המחדל הוא **מסילת-השרשרת-שלנו**:
 *   GET /api/dex/bridge/quote?from=steem&to=sbd[&amount=1]
 *     → { ok:true, provider:"steem-chain", rail:"sovereign", rate, book/median }
 *   זוגות-על-השרשרת: steem/sbd · sbd/steem · steem/usd · usd/steem · sbd/usd · usd/sbd.
 *   זוג-חוץ (btc/eth/…): 503 כן עם released:true — אין-ספק-חוץ פעיל, אין-המצאה.
 *
 * מסילת-FixedFloat (קריאה-בלבד) נשארת בקוד להפעלה-מחדש-עתידית:
 *   FF_RELEASED=0 בסביבה מחזיר את הניתוב-הישן (provider:"fixedfloat").
 * לא מוזז כסף, לא נחשף חומר-מפתח. no-store: ציטוט הוא רגע. */

const FF_RELEASED = process.env.FF_RELEASED !== "0"; // ברירת-המחדל: שוחרר (הוראת-הבעלים 2026-11-05)

export async function GET(req: Request) {
  const url = new URL(req.url);
  const from = (url.searchParams.get("from") || "").trim();
  const to = (url.searchParams.get("to") || "").trim();
  const amount = Number(url.searchParams.get("amount") || "1");
  const type = url.searchParams.get("type") === "fixed" ? "fixed" : "float";

  if (!from || !to) {
    return NextResponse.json(
      { ok: false, provider: FF_RELEASED ? "steem-chain" : "fixedfloat", error: "missing query params: ?from=<ccy>&to=<ccy> (e.g. from=steem&to=sbd)" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  /* ══ מסילת-השרשרת-שלנו (ברירת-המחדל אחרי-השחרור) ══ */
  if (FF_RELEASED) {
    try {
      const q = await sovereignQuote(from, to, Number.isFinite(amount) && amount > 0 ? amount : 1);
      if (q) {
        return NextResponse.json(
          {
            ok: true,
            provider: "steem-chain",
            rail: "sovereign",
            from: q.from,
            to: q.to,
            rate: q.rate,
            book: q.book ?? null,
            median: q.median ?? null,
            notes: q.notes,
            releasedProvider: "fixedfloat (W-FRELEASE 2026-11-05 — מאוחסן-חתום בכספת, לא-פעיל)",
            fetchedAt: q.fetchedAt,
          },
          { headers: { "Cache-Control": "no-store" } }
        );
      }
      return NextResponse.json(
        {
          ok: false,
          provider: "none",
          released: true,
          error: `W-FRELEASE: ספק-החוץ שוחרר (הוראת-בעלים 2026-11-05) — המסילות-הילידות מכסות ${SOVEREIGN_PAIRS.join(" · ")}; זוג-חוץ (${from}/${to}) יחזור עם-הפעלה-עתידית של הבעלים בלבד`,
          supported: SOVEREIGN_PAIRS,
        },
        { status: 503, headers: { "Cache-Control": "no-store" } }
      );
    } catch (e) {
      return NextResponse.json(
        { ok: false, provider: "steem-chain", released: true, error: e instanceof Error ? e.message : String(e) },
        { status: 503, headers: { "Cache-Control": "no-store" } }
      );
    }
  }

  /* ══ מסילת-FixedFloat הלגאצי (קריאה-בלבד · מופעלת-מחדש רק ע"י FF_RELEASED=0) ══ */
  try {
    const q = await fixedfloatGetRate(from, to, {
      amount: Number.isFinite(amount) && amount > 0 ? amount : 1,
      type,
    });
    return NextResponse.json(
      {
        ok: true,
        provider: "fixedfloat",
        legacy: true,
        from: q.from.code,
        to: q.to.code,
        networkFrom: q.from.network,
        networkTo: q.to.network,
        rate: q.from.rate, // measured live: /price puts the pair rate on data.from.rate (toCcy per 1 fromCcy)
        minAmount: q.from.min,
        maxAmount: q.from.max,
        toMin: q.to.min,
        toMax: q.to.max,
        type,
        amount: q.from.amount,
        fetchedAt: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, provider: "fixedfloat", error: e instanceof Error ? e.message : String(e) },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
