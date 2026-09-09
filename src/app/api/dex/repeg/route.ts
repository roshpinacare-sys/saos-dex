import { NextResponse } from "next/server";
import { nextNonce, submitOp, getLiveState } from "@/lib/dex/chain";
import { getPool, quoteOut, poolMidFor } from "@/lib/dex/amm";
import { FREE_XFER_CAP, REFUEL_CAP, type Asset, type Op } from "@/lib/dex/kernel";
import { consoleGuard } from "@/lib/dex/guard";
import { operatorAuth } from "@/lib/operator-auth";

export const dynamic = "force-dynamic";

/* ══ THE-REPEG (SETTLE-15) — נזילות-חוץ שמשפשפת את המחיר-אל-האמת ═════════════
 * דבר-המפעיל: "שנוכל לשרשר את המערכת עם נזילות מבחוץ כדי לשפשף את העסקאות".
 *
 * האבחנה-החיה (h≈10,800): בריכת-USDS/WSTEEM נסחרת mid≈917µ בעוד העיגון-אמת
 * של WSTEEM הוא STEEM (עטיפה 1:1 מגובה-גיבוי-נעול) — refPrice≈360µ. פרמיה
 * שקרית של ~2.5x שהמערכת-הישנה יצרה ואף-משחק-חוץ-לא-יכול-לתקן-כי-אין-שחקן-חוץ.
 *
 * התיקון-הכנה: מקור-נזילות-ארב-חוץ (`arb-ext` — סימולציית-שחקן-חוץ) מושכת-
 * את-הבריכה-אל-מסדרון-העיגון: מוכר-WSTEEM-לתוך-הבריכה בצ'אנקים-מדודים עם
 * minOut fail-closed לכל-צ'אנק, ב-batch-אטומי (דבר-גורר-דבר) — עד-ש-mid ≤
 * refSTEEM×(1+band). כל-המהלכים מגוללים-על-הספר (journal) ומייצרים עדות-
 * TWAP-מכוונת-מטה שהסולם-הסימטרי (SETTLE-14) עוקב-אחריה.
 *
 * המלאי: שקית-ה-WSTEEM-של-בוט-a (שנצברה-בעידן-המוטה) עוברת-בהעברות-חינם
 * (THE-SWEEP, תקרה-פר-פקודה) אל arb-ext. אפס-הטבעה — העברה-טהורה בין-יתרות. */

const ARB = "arb-ext";
const BAG_HOLDER = "bot-a";
const DEFAULT_BAND_BPS = 1_000; // מסדרון +10% מעל-העיגון
const DEFAULT_CHUNK = 1_000_000; // µ-מקסימום-לצ'אנק-מכירה (גבול-נזק)
const MAX_SELL_CAP = 6_000_000; // תקרת-בטיחות-קשה ל-invocation
const BATCH_MAX = 8;

function simSell(ra: number, rb: number, dwMu: number): { ra2: number; rb2: number; out: number } {
  // שחזור-מדויק של מתמטיקת poolSwap (שלמים) על-עותק-וירטואלי — לתכנון-צ'אנקים.
  // FIX(SETTLE-15, נתפס-בלוג-הדחיות-החי): מכנה-ה-out הוא rIn+inAfterFee = **rb**+
  // inAfterFee (עתודת-הקלט), לא-ra. ra במכנה-בלבד — ה-8%-אינפלציה-הזאת קבעה
  // minOut-שקט-גבוה-מהמציאות → batch-atomic-fail@0:min-out בכל-הרצה.
  const feeAmt = Math.floor((dwMu * 30) / 10_000);
  const inAfterFee = dwMu - feeAmt;
  const lpFee = feeAmt - Math.floor((feeAmt * 30) / 100);
  const poolIn = inAfterFee + lpFee;
  const out = Math.floor((ra * inAfterFee) / (rb + inAfterFee));
  return { ra2: ra - out, rb2: rb + poolIn, out };
}

function pegInfo() {
  const st = getLiveState();
  const p = getPool(st, "USDS/WSTEEM");
  const pegRef = st.assets["STEEM"]?.refPrice ?? st.assets["WSTEEM"]?.refPrice ?? 0;
  const mid = p ? poolMidFor(p, "WSTEEM", "USDS") : 0;
  const bag = (st.balances[BAG_HOLDER]?.["WSTEEM"] ?? 0) - (st.locked[BAG_HOLDER]?.["WSTEEM"] ?? 0);
  return { st, p, pegRef, mid, bag };
}

/** GET — מצב-הפרמיה ותוכנית-החזר-לעיגון (ציבורי, קריאה-בלבד) */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const bandBps = Math.max(0, Math.floor(Number(url.searchParams.get("band") ?? DEFAULT_BAND_BPS)));
  const { p, pegRef, mid, bag } = pegInfo();
  const target = Math.floor((pegRef * (10_000 + bandBps)) / 10_000);
  // תכנון: חיפוש-בינארי על Δ-המכירה שמביא mid אל המסדרון
  let sellPlanMu = 0;
  if (p && mid > target) {
    let lo = 0, hi = Math.min(bag, MAX_SELL_CAP);
    for (let i = 0; i < 48; i++) {
      const d = Math.floor((lo + hi) / 2);
      const { ra2, rb2 } = simSell(p.ra, p.rb, d);
      if (Math.floor((ra2 * 1000) / rb2) <= target) hi = d; else lo = d;
    }
    sellPlanMu = hi;
  }
  return NextResponse.json({
    ok: true,
    pool: p ? { key: "USDS/WSTEEM", ra: p.ra, rb: p.rb, mid } : null,
    peg: { native: "STEEM", wrapped: "WSTEEM", refPriceMu: pegRef, bandBps, targetMidMu: target },
    premiumPct: mid > 0 && pegRef > 0 ? Math.floor(((mid - pegRef) * 10_000) / pegRef) / 100 : null,
    bagHolderBalanceMu: bag,
    plan: mid > target ? { sellTotalMu: sellPlanMu, chunks: Math.ceil(sellPlanMu / DEFAULT_CHUNK), chunkMu: DEFAULT_CHUNK, onTarget: false }
      : { sellTotalMu: 0, chunks: 0, chunkMu: DEFAULT_CHUNK, onTarget: true },
    honesty: "ארב-חוץ מדומה על הרשת שלנו: מכירות-מדודות minOut-fail-closed · אפס-הטבעה · העברות-חינם · הכל-מגולל-ב-journal",
  });
}

/** POST — הרצת-מנת-ארב (שער-מפעיל): refuel + sweeps + batch-מכירות מדוד */
export async function POST(req: Request) {
  const oa = operatorAuth(req);
  if (oa) return oa;
  const g = consoleGuard(req);
  if (g) return g;

  const body = (await req.json().catch(() => ({}))) as { bandBps?: number; maxSellMu?: number; chunkMu?: number };
  const bandBps = Math.max(0, Math.floor(Number(body.bandBps ?? DEFAULT_BAND_BPS)));
  const maxSellMu = Math.min(MAX_SELL_CAP, Math.max(1, Math.floor(Number(body.maxSellMu ?? MAX_SELL_CAP))));
  const chunkMu = Math.min(DEFAULT_CHUNK, Math.max(10_000, Math.floor(Number(body.chunkMu ?? DEFAULT_CHUNK))));

  const { st, p, pegRef, mid, bag } = pegInfo();
  const target = Math.floor((pegRef * (10_000 + bandBps)) / 10_000);
  if (!p) return NextResponse.json({ ok: false, error: "pool-missing" }, { status: 200 });
  if (mid <= target) {
    return NextResponse.json({ ok: true, onTarget: true, mid, target, note: "הבריכה-כבר-בתוך-מסדרון-העיגון — אין-פעולה" });
  }

  // תכנון-מנה: Δ-עד-היעד, מוגבל-תקרות
  let lo = 0, hi = Math.min(bag, maxSellMu);
  for (let i = 0; i < 48; i++) {
    const d = Math.floor((lo + hi) / 2);
    const { ra2, rb2 } = simSell(p.ra, p.rb, d);
    if (Math.floor((ra2 * 1000) / rb2) <= target) hi = d; else lo = d;
  }
  const sellTotal = Math.min(hi, maxSellMu, bag);
  if (sellTotal <= 0) return NextResponse.json({ ok: false, error: "no-bag-to-sell" }, { status: 200 });

  // 1) דלק-ל-arb-ext (פעם-אחת, תקרת-REFUEL)
  const queued: string[] = [];
  const credits = st.credits[ARB] ?? 0;
  if (credits < 5_000) {
    const r = submitOp({ type: "refuel", issuer: "treasury", nonce: nextNonce("rf"), to: ARB, amount: 10_000 });
    queued.push(`refuel→${ARB}:10,000µ-credits ${r.queued ? "✔" : `✘ ${r.reason}`}`);
  }
  // 2) העברות-חינם מנות-השקית (THE-SWEEP, תקרה-פר-פקודה)
  let moved = 0;
  const arbNow = (st.balances[ARB]?.["WSTEEM"] ?? 0);
  let need = Math.max(0, sellTotal - arbNow);
  while (need > 0 && moved < 3 * FREE_XFER_CAP) {
    const c = Math.min(need, FREE_XFER_CAP);
    const r = submitOp({ type: "xfer_free", issuer: BAG_HOLDER, nonce: nextNonce("sw"), to: ARB, asset: "WSTEEM" as Asset, amount: c });
    if (!r.queued) { queued.push(`sweep ✘ ${r.reason}`); break; }
    queued.push(`sweep ${BAG_HOLDER}→${ARB}:${c}µ WSTEEM ✔`);
    need -= c; moved += c;
  }
  // 3) מכירות-מדודות ב-batch-אטומי: סימולציה-רציפה על-עותק-וירטואלי — כל-צ'אנק
  //    מחושב-מול-השאריות-אחרי-הצ'אנק-הקודם (בתוך-batch אין-שזירה — בלוק-אחד)
  const sells: Op[] = [];
  let simRa = p.ra, simRb = p.rb, left = Math.min(sellTotal, arbNow + moved);
  while (left > 0 && sells.length < BATCH_MAX) {
    const c = Math.min(left, chunkMu);
    const s = simSell(simRa, simRb, c);
    sells.push({
      type: "pool_swap", issuer: ARB, nonce: nextNonce("rp"),
      pair: "USDS/WSTEEM", assetIn: "WSTEEM" as Asset, amount: c,
      // FIX(SETTLE-15 live): 4%-רוחב — ה-plan-מבוסס-על-רזרבות-של-1-2-בלוקים-לפני-
      // הביצוע (זרימת-ארנה זזה ~0.5%/בלוק); 1% היה-מוחק-את-ה-batch-כולו (נמדד:
      // batch-atomic-fail@0:min-out). ה-batch-עצמו דטרמיניסטי-פנימית — רק-סטיית-
      // כניסה-נחתכת, לכן-4% מספיקים-בנדיבות. fail-closed נשמר: הכל-או-כלום.
      minOut: Math.floor((s.out * 96) / 100),
    });
    simRa = s.ra2; simRb = s.rb2; left -= c;
  }
  if (sells.length > 0) {
    const r = submitOp({ type: "batch", issuer: ARB, nonce: nextNonce("rb"), ops: sells });
    queued.push(`batch-sell:${sells.length}-chunks totaling ${sellTotal - left}µ ${r.queued ? "✔" : `✘ ${r.reason}`}`);
  }
  // 4) יישור-הייחוס: WSTEEM≡STEEM (עטיפה-1:1) — refPrice זהים (אמת-חשבונית)
  const wRef = st.assets["WSTEEM"]?.refPrice ?? 0;
  if (wRef !== pegRef && pegRef > 0) {
    const r = submitOp({ type: "asset_price", issuer: "treasury", nonce: nextNonce("ap"), asset: "WSTEEM" as Asset, refPrice: pegRef });
    queued.push(`asset_price WSTEEM:=${pegRef}µ (≡STEEM 1:1) ${r.queued ? "✔" : `✘ ${r.reason}`}`);
  }
  const expectMid = sells.length > 0 ? Math.floor((simRa * 1000) / simRb) : mid;
  return NextResponse.json({
    ok: true, onTarget: false,
    executed: { midBefore: mid, sellPlannedMu: sellTotal, chunks: sells.length, expectMidAfter: expectMid, target },
    queued,
    note: "מנת-ארב-חוץ הועברה לממפול — העדות-המכוונת-מטה תיקלט בסולם-הסימטרי (keel) תוך-דקות",
  });
}
