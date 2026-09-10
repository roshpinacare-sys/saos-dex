/**
 * triggers.ts — מסחר-אוטומטי-חסר-קיפרים (Task 56) · keeperless execution
 * ═════════════════════════════════════════════════════════════════════════════
 * מקורות: GMX TP/SL (טריגרים) · Jupiter/Brink DCA (פריסה-פרוגרמטית).
 *
 * התרגום-הקנוני על הגרעין: **בונה-הבלוקים הוא ה-keeper**. ב-DEX-ים חיצוניים
 * טריגרים ו-DCA דורשים keepers חוץ (bot פרטי שצריך-לשלם-לו ושיכול-להיעלם);
 * אצלנו הסריקה היא השוואת-שלמים-טהורה על המחיר-הקנוני בתוך buildBlock —
 * אפס-float · אפס-random · אפס-Date.now · אפס-תשתית-חוץ · ריפליי-אמת.
 *
 *  1. DCA: הפקדה-מלאה-מראע (נעולה-על-הבעלים) → כל-everyK-בלוקים פרוסה-אחת
 *     מבוצעת-דרך-הראוטר (מסלול-הטוב-ביותר, batch אטומי, מגן-minOut לכל-רגל).
 *     הפרוסות-עצמן הן מסחר-אמת — נכנסות לטייפ ולעדות-המחיר (feedPriceOracle).
 *  2. טריגרים (stop/take): נעולים-מראע; סריקה-כל-בלוק מול mid-הבריכה
 *     (המחיר-הקנוני); בטריגר → שחרור-ערבות → פקודת-לימיט-חוצת-ספר
 *     (חופפת-מיד-כ-taker במחיר-המייקר, שארית-נחה בספר).
 *  3. ביצוע-ישיר: הטיק קורא ל-applyOp סינכרונית בתוך-אותו-בלוק (לא-ממפול) —
 *     אטומי, ללא-מרוץ-בין-בלוקים, ואם-הביצוע-נדחה (מגן-minOut / גז) —
 *     הערבות חוזרת-לנעילה והתוכנית מנסה-שוב-במחזור-הבא (כנות: נראה-בדחיות).
 */
import type { DexState, Op, TradeEvent } from "./kernel";
import { addLock, notional } from "./kernel";
import { getPool, poolMidFor } from "./amm";
import { walkRoutes } from "./router";

/** עותק-מקומי של הלג — אותו-חוזה-ציבורי של הראוטר */
type Leg = { kind: "pool" | "wrap"; venue: string; from: string; to: string; inMu: number; outMu: number };

/** המרת-לג-ראוטר לתת-op ביצוע (pool_swap / wrap_mint / wrap_burn) — עם מגן-minOut.
 * FIX(Task 56): תתי-ops נדרשים-issuer+nonce מלאים (הגרעין דוחה מחרוזת-ריקה)
 * והנונסים-המאומצים-נכנסים-לשורש — נונס-ייחודי-דטרמיניסטי לכל-רגל.
 * Task 58: מיוצא-לשימוש-חוזר-ב-CoW-fallback (אותה-מתמטיקה, מקור-אמת-אחד). */
export function legToOp(leg: Leg, minOutBps: number, nonce: string): Op | null {
  const minOut = Math.floor((leg.outMu * (10_000 - minOutBps)) / 10_000);
  if (leg.kind === "pool") {
    // venue = "POOL:SAOS/USDS"
    const pair = leg.venue.slice("POOL:".length);
    if (!pair) return null;
    return { type: "pool_swap", issuer: "", nonce, pair, assetIn: leg.from as never, amount: leg.inMu, minOut };
  }
  // מסדרון-עיגון 1:1 — מ-wrapped ל-native = פריקה; מ-native ל-wrapped = עטיפה
  if (leg.from.startsWith("W")) return { type: "wrap_burn", issuer: "", nonce, wrapAsset: leg.from as never, amount: leg.inMu };
  return { type: "wrap_mint", issuer: "", nonce, wrapAsset: leg.to as never, amount: leg.inMu };
}

const DCA_MAX_SLICES_PER_BLOCK = 2; // תקרת-פרוסות-פר-בלוק (דטרמיניסטי)

/** טיק-DCA — נקרא מ-buildBlock (אחרי-ה-ops, לפני-העלאת-הגובה).
 * exec = applyOp ישירות-על-המצב-החי. מחזיר אירועי-מסחר-אמת לטייפ/עדות-מחיר.
 * FIX(Roast-65-a · LOW-13): nowMs מוזרק-מ-buildBlock — רישומי-הג'ורנל כאן היו t:0
 * (זמן-מזויף) בניגוד-לחוק-63/64 שקבע journal.t=זמן-הבלוק-בכל-הנתיבים האחרים. */
export function dcaTick(st: DexState, exec: (op: Op) => ReturnType<typeof import("./kernel").applyOp>, nowMs: number): TradeEvent[] {
  const h = st.height;
  if (h <= 0) return [];
  const events: TradeEvent[] = [];
  let budget = DCA_MAX_SLICES_PER_BLOCK;
  // סדר-קנוני: לפי-מזהה (הוקם-מונוטונית) — אפס-אקראיות
  const progs = Object.values(st.dca ?? {}).sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const prog of progs) {
    if (budget <= 0) break;
    if (prog.remainingMu <= 0) continue;
    if (prog.lastH !== 0 && h - prog.lastH < prog.everyK) continue;
    if (prog.done >= prog.slicesMax) continue;
    const slice = Math.min(prog.perSliceMu, prog.remainingMu);
    if (!(slice > 0)) continue;
    // שחרור-הפרוסה-מהנעילה (הכסף של-הבעלים — הופך-זמין-לbatch שלו)
    addLock(st, prog.owner, prog.assetIn, -slice);
    // מסלול-הטוב-ביותר-עכשיו (קריאה-בלבד על אותו-מצב שה-batch ייצג עליו)
    const routes = walkRoutes(prog.assetIn, prog.assetOut, slice);
    let batchOp: Op | null = null;
    if (routes.length > 0) {
      routes.sort((a, b) => b.inMu - a.inMu);
      const best = routes[0];
      const subs = best.legs
        .map((l, li) => legToOp(l, prog.minOutBps, `dca-leg-${prog.id}-${prog.done}-${h}-${li}`))
        .filter((x): x is Op => x !== null);
      if (subs.length > 0) {
        batchOp = {
          type: "batch", issuer: prog.owner,
          nonce: `dca-${prog.id}-${prog.done}-${h}`,
          ops: subs,
        };
      }
    }
    const r = batchOp ? exec(batchOp) : { ok: false as const, err: "no-route", gas: 0 };
    // FIX(Task 56 object-identity): applyOp(batch) מאמץ-עותק-צל (Object.assign(st,trial))
    // — st.dca מוחלף-בשיבוט; מוטציה-ישירה-על-האובייקט-הישן פוגעת-באובייקט-מנותק.
    // קוראים-מחדש-מהמצב-המאומץ ומעדכנים-שם.
    const applied = st.dca?.[prog.id];
    if (r.ok) {
      if (applied) {
        applied.done += 1;
        applied.remainingMu -= slice;
        applied.lastH = h;
      }
      if (r.ok && r.events) events.push(...r.events);
      st.journal.push({ h, t: nowMs, soldier: "dca", action: "dca_slice", note: `${prog.id} פרוסה-${(applied?.done ?? 1)}: ${slice}µ ${prog.assetIn}→${prog.assetOut}` });
    } else {
      // נדחה — הערבות חוזרת-לנעילה, התוכנית ממתינה-למחזור-הבא (כנות-מלאה)
      addLock(st, prog.owner, prog.assetIn, slice);
      st.journal.push({ h, t: nowMs, soldier: "dca", action: "dca_slice_reject", note: `${prog.id}: ${r.err}` });
    }
    budget -= 1;
  }
  return events;
}

const TRIG_MAX_FIRES_PER_BLOCK = 3; // תקרת-ביצועים-פר-בלוק (דטרמיניסטי)

/** טיק-טריגרים — סריקה-כל-בלוק מול-המחיר-הקנוני (mid-בריכה).
 * sell נורה כשהמחיר ≤ trigger (stop-loss/take-profit על-עמדה-ארוכה);
 * buy נורה כשהמחיר ≥ trigger. תפוגה משחררת-ערבות-בכנות. */
export function trigTick(st: DexState, exec: (op: Op) => ReturnType<typeof import("./kernel").applyOp>, nowMs: number): TradeEvent[] {
  const h = st.height;
  if (h <= 0) return [];
  const events: TradeEvent[] = [];
  let budget = TRIG_MAX_FIRES_PER_BLOCK;
  const trigs = Object.values(st.trig ?? {}).sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const trg of trigs) {
    if (budget <= 0) break;
    // תפוגה → שחרור-כנה ומחיקה
    if (trg.expiresH > 0 && h >= trg.expiresH) {
      const lockAsset = trg.side === "sell" ? trg.base : trg.quote;
      const effPx = trg.limitPx > 0 ? trg.limitPx : trg.triggerPx;
      addLock(st, trg.owner, lockAsset, -(trg.side === "sell" ? trg.amountMu : notional(effPx, trg.amountMu)));
      const map = { ...(st.trig ?? {}) }; delete map[trg.id]; st.trig = map;
      st.journal.push({ h, t: nowMs, soldier: "trig", action: "trig_expire", note: `${trg.id} פג-תוקף, ערבות שוחררה` });
      continue;
    }
    const pool = getPool(st, [trg.base, trg.quote].sort().join("/"));
    const mid = pool ? poolMidFor(pool, trg.base, trg.quote) : 0;
    if (!(mid > 0)) continue;
    const fire = trg.side === "sell" ? mid <= trg.triggerPx : mid >= trg.triggerPx;
    if (!fire) continue;
    // ביצוע: שחרור-הערבות → פקודת-לימיט (חופפת-מיד-כ-taker, שארית-נחה)
    const lockAsset = trg.side === "sell" ? trg.base : trg.quote;
    const effPx = trg.limitPx > 0 ? trg.limitPx : trg.triggerPx;
    const lockMu = trg.side === "sell" ? trg.amountMu : notional(effPx, trg.amountMu);
    addLock(st, trg.owner, lockAsset, -lockMu);
    const r = exec({
      type: "order", issuer: trg.owner,
      nonce: `trg-${trg.id}-fire-${h}`,
      base: trg.base as never, quote: trg.quote as never,
      side: trg.side, price: effPx, amount: trg.amountMu,
    });
    // FIX(Task 56 object-identity): פקודת-order אינה מאמצת-עותק-צל (עובדת-על-
    // המצב-החי ישירות) — אבל המיפוי st.trig הוחלף-בשיבוט ביצירת-המפה; עובדים-מול-
    // st.trig-החי-בעת-המחיקה.
    if (r.ok) {
      if (r.events) events.push(...r.events);
      st.journal.push({ h, t: nowMs, soldier: "trig", action: "trig_fire", note: `${trg.id} נורה @${mid} (trigger ${trg.triggerPx})` });
    } else {
      // נדחה — הערבה חוזרת, ניסיון-חוזר-בבלוק-הבא (כנות)
      addLock(st, trg.owner, lockAsset, lockMu);
      st.journal.push({ h, t: nowMs, soldier: "trig", action: "trig_fire_reject", note: `${trg.id}: ${r.err}` });
      st.trig = { ...(st.trig ?? {}), [trg.id]: trg };
      budget -= 1;
      continue;
    }
    const liveMap = { ...(st.trig ?? {}) };
    delete liveMap[trg.id];
    st.trig = liveMap;
    budget -= 1;
  }
  return events;
}
