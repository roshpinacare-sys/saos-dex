/**
 * exec-route.ts — Roast-71 · מנוע-הביצוע-האטומי-המשותף.
 *
 * FIX(תקינות-רואסט-71): עד-עכשיו היו שני-מנועי-ביצוע-נפרדים:
 *  · POST /api/dex/route — batch-אטומי (דבר-גורר-דבר) עם minOut לכל-רגל ✓
 *  · POST /api/dex/convert — שרשור-פקודות-עוקבות (pool_swap ×hops) — אם-רגל-2
 *    נדחית-אחרי-שרגל-1 בוצעה, המפעיל-נשאר-עם-נכס-תלוש-באמצע-שרשרת ✗
 * עכשיו: מנוע-אחד-משותף — שני-השערים מרכיבים את אותו-batch-אטומי מאותו-ציטוט.
 *
 * FIX(תקפות-רואסט-71): שער-הנכסים-היה `ASSETS.includes(...)` — רשימה-קבועה.
 * נכסי-השקות (LB|LA) רשומים-בקנוני (st.assets) אבל-לא-ב-ASSETS → ה-GET-הציג
 * ציטוט-תקין-וה-POST דחה-אותו (bad-request) — פער-אמת-בין-ציטוט-לביצוע.
 * עכשיו: knownAsset(st) — אותה-רשימה-שהראוטר-עצמו-מהלך-עליה. */
import { getLiveState, nextNonce } from "./chain";
import { quoteRoute } from "./router";
import { knownAsset, BATCH_MAX_OPS, type Asset, type Op } from "./kernel";

export const EXEC_ISSUERS = ["operator", "treasury", "arena", "portfolio-b"] as const;
export type ExecIssuer = (typeof EXEC_ISSUERS)[number];

export interface ExecRoutePlan {
  ok: boolean;
  error?: string;
  /** תתי-ops מוכנים-ל-batch (בלי issuer/nonce — מושלמים-בשער) */
  sub?: (
    | { type: "pool_swap"; pair: string; assetIn: Asset; amount: number; minOut: number }
    | { type: "wrap_mint" | "wrap_burn"; wrapAsset: Asset; amount: number }
  )[];
  routeVenues?: string[];
  expectOutMu?: number;
  effPriceMu?: number;
}

/** בניית-תוכנית-ביצוע-אטומית מהציטוט-הטוב-ביותר (קריאה-בלבד — ללא-נגיעה-במצב). */
export function buildAtomicRoutePlan(
  assetIn: string, assetOut: string, amount: number,
  minOut: number | undefined,
): ExecRoutePlan {
  const st = getLiveState();
  if (!knownAsset(st, assetIn) || !knownAsset(st, assetOut) || assetIn === assetOut || !(amount > 0)
    || (minOut !== undefined && !Number.isFinite(minOut))) {
    return { ok: false, error: "bad-request" };
  }
  const q = quoteRoute(assetIn, assetOut, amount);
  if (!q) return { ok: false, error: "no-route" };
  if (minOut !== undefined && q.amountOutMu < minOut) {
    return { ok: false, error: `quote-below-minOut (${q.amountOutMu} < ${minOut})` };
  }
  if (q.legs.length > BATCH_MAX_OPS) return { ok: false, error: "route-too-long" };

  // minOut לכל-רגל = 99% מפלט-הציטוט-שלה (fail-closed), והרגל-האחרונה מקבלת
  // את minOut-המפעיל (קפדן-יותר) כשנמסר.
  const sub: NonNullable<ExecRoutePlan["sub"]> = q.legs.map((l, i) => {
    const last = i === q.legs.length - 1;
    const floorMu = Math.floor((l.outMu * 99) / 100);
    if (l.kind === "pool") {
      return {
        type: "pool_swap" as const,
        pair: l.venue.slice(5),
        assetIn: l.from as Asset,
        amount: l.inMu,
        minOut: last && minOut !== undefined ? minOut : floorMu,
      };
    }
    // רגל-עטיפה 1:1 — הכיוון נגזר מהרגל: to=wrapped → mint, to=native → burn
    const wrapped = l.to.startsWith("W") ? l.to : l.from;
    return {
      type: l.to.startsWith("W") ? ("wrap_mint" as const) : ("wrap_burn" as const),
      wrapAsset: wrapped as Asset,
      amount: l.inMu,
    };
  });

  return {
    ok: true,
    sub,
    routeVenues: q.legs.map((l) => l.venue),
    expectOutMu: q.amountOutMu,
    effPriceMu: q.effPriceMu,
  };
}

/** שער-מנפיק fail-closed — אותו-רשימה-לשני-השערים. */
export function isExecIssuer(x: string): x is ExecIssuer {
  return (EXEC_ISSUERS as readonly string[]).includes(x);
}

/** השלמת-תתי-ops-ל-batch-מוכן-לשליחה (nonces דטרמיניסטיים-למחצה כמו-שאר-השערים). */
export function toBatchOps(sub: NonNullable<ExecRoutePlan["sub"]>, issuer: string, noncePrefix: string): Op[] {
  return sub.map((s, i) => ({ ...s, issuer, nonce: nextNonce(`${noncePrefix}${i}`) })) as Op[];
}
