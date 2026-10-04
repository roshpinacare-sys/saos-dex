// MM-SUPREMACY — מנוע-העליונות: להיות מייקר-הגריד הגדול ביותר על הרשתות שלנו
// =============================================================================
// דבר-המפעיל (2026-10-04): "שנהיה השחקנים של market maker וגריד הכי גדולים
// ומרווחים על הרשתות שאנחנו פועלים... לוודא רווחיות גם אם היא קטנה, ולנסות
// להשיג כמה שיותר תנועה עם כמה שיותר חיילים בצי... ניקח גם את העמלות של
// המשתמשים האחרים שסוחרים או מחליפים על הרשת."
//
// העיקרון: כל חייל בצי מצטט שני-צדדים סביב ה-ref החי, עם הטיית-מלאי
// (inventory skew) שמקטינה סיכון ומגדילה תנועה. העמלות נתפסות משני נתיבים:
//   (1) ספרד — כל מילוי מייקר נסחר מעל/מתחת ה-ref החי (פאריטי חוץ);
//   (2) בריכת-עמלות — טייקרים-חוץ משלמים FEE_BPS על ה-AMM/ספר, והמייקרים
//       לוקחים את חלקם פרו-רטה לפי נפח-מילוי (דוקטרינת 70% AMM ב-LIQUIDITY_STRATEGY).
//
// חוקי-ברזל (אותם-חוקים של grid-pulse R83 + הדוקטרינה הקיימת):
//   · clamp bid < fair < ask — לעולם לא חוצים את הספר;
//   · רוחב-מינימלי minSpreadBps — לא מצטטים רוחב שאינו מכסה עמלה+סליפ;
//   · תקרת-מלאי capMu — מעליה מצב-פריקה (צד-מפחית-בלבד, חצי-גודל); עצירה-מלאה
//     רק ב-2×capMu (מפסק-חירום) — חייל-עצור-עם-מלאי-תקוע הוא באג-צבא (תוקן 2026-10-04);
//   · אפס-מחירים-מומצאים — refPrice חייב מדידה אמת או stale מפורסם;
//   · דטרמיניזם — אותו-זרע → אותו-עולם (mulberry32).

import { FEE_BPS } from "./strategies.mjs";

const r6 = (v) => Math.round(v * 1e6) / 1e6;

/* ── הטיית-מלאי: כמה להזיז את הציטוטים כדי להחזיר מלאי לאפס ────────────────
   skew ∈ [-1,1]: חיובי = מלאי-ארוך (דוחף ask זול יותר, bid רחוק יותר),
   שלילי = מלאי-קצר (ההפך). ליניארי, חתום, חסום — קל לביקורת. */
export function inventorySkew(inventoryMu, capMu) {
  const s = capMu > 0 ? inventoryMu / capMu : 0;
  return Math.max(-1, Math.min(1, s));
}

/* ── supremacyTick: ציטוט שני-צדדים מטה-תנועה עם הטיית-מלאי ────────────────
   פרמטרים: levels, widthBps (רוחב-בסיס), levelMu (רמה-בסיסית), growth,
   capMu (תקרת-מלאי לחייל), minSpreadBps (רוחב-מינימלי), skewAmp (עוצמת-הטיה).
   כל רמה i רחוקה יותר; הגודל גדל גיאומטרית — עומק אמת סביב השורש. */
export function supremacyTick(grid, market, inventoryMu) {
  const p = grid.params ?? {};
  const {
    levels = 4,
    widthBps = 40,        // 0.4% מה-ref — רוחב-בסיס לרמה-ראשונה
    levelMu = 100,
    growth = 1.4,
    capMu = 8000,
    minSpreadBps = 35,    // חייב לכסות FEE_BPS(30) + משמעות
    skewAmp = 120,        // bps נוספים-מקסימום בהטיה מלאה
  } = p;
  const ref = market.refPrice;
  if (!ref || market.stale) return { orders: [], note: "no-fresh-ref" };
  const abs = Math.abs(inventoryMu);
  if (abs >= capMu * 2) return { orders: [], note: "emergency-halt", halted: true };
  const unwindOnly = abs >= capMu; // מצב-פריקה: לא עוד-מלאי, רק פריקה

  const skew = inventorySkew(inventoryMu, capMu);
  const orders = [];
  for (let i = 1; i <= levels; i++) {
    // רוחב נכנס: ארוך → bid רחוק, ask קרוב (מוכרים יותר); קצר → ההפך
    const bidW = Math.max(minSpreadBps / 2, widthBps * i + skewAmp * skew) * ref / 10000;
    const askW = Math.max(minSpreadBps / 2, widthBps * i - skewAmp * skew) * ref / 10000;
    const bid = r6(ref - bidW);
    const ask = r6(ref + askW);
    if (bid >= ref || ask <= ref) continue; // חוק-ברזל: bid<fair<ask
    const size = r6(levelMu * Math.pow(growth, i - 1));
    if (size <= 0) continue;
    if (unwindOnly) {
      // מצב-פריקה: רק הצד שמקטין מלאי, חצי-גודל, ברוחב-המינימום (הצמוד ביותר)
      const wMin = (minSpreadBps / 2) * ref / 10000;
      const sz = r6(levelMu * 0.5);
      if (inventoryMu > 0) orders.push({ side: "ask", price: r6(ref + wMin), sizeMu: sz, gridId: grid.id, strat: "supremacy-unwind" });
      else orders.push({ side: "bid", price: r6(ref - wMin), sizeMu: sz, gridId: grid.id, strat: "supremacy-unwind" });
      break; // רמה-אחת צמודה מספיקה לפריקה
    }
    orders.push({ side: "bid", price: bid, sizeMu: size, gridId: grid.id, strat: "supremacy" });
    orders.push({ side: "ask", price: ask, sizeMu: size, gridId: grid.id, strat: "supremacy" });
  }
  const note = unwindOnly ? `unwind-only inv=${inventoryMu}` : `supremacy skew=${skew.toFixed(2)} levels=${orders.length / 2}`;
  return { orders, note };
}

/* ── fleetSpawn: חלוקת-הון לצי חיילים על סולם-המחיר ────────────────────────
   המפעיל: "להשיג כמה שיותר תנועה עם כמה שיותר חיילים". חלוקה שווה-שקלית
   עם גיוון-פרמטרים דטרמיניסטי: כל חייל מקבל רוחב/רמה שונה-מעט (index-based)
   כדי שהצי יפרוש עומק על פני הסולם — לא 8 חיילים על אותו-מחיר. */
export function fleetSpawn(totalMu, count, refPrice, opts = {}) {
  const n = Math.max(1, Math.floor(count));
  const per = r6(totalMu / n);
  const widthJitter = opts.widthJitterBps ?? 6;   // 6bps דרגת-גיוון
  const sizeJitter = opts.sizeJitter ?? 0.15;
  const soldiers = [];
  for (let k = 0; k < n; k++) {
    const w = 40 + (k % 5) * widthJitter;          // 40..64 bps
    const lvl = r6(per * (1 + ((k % 3) - 1) * sizeJitter));
    soldiers.push({
      id: `sup-${k + 1}`,
      params: {
        levels: 3 + (k % 2),                       // 3 או 4 רמות
        widthBps: w,
        levelMu: Math.max(1, lvl),
        growth: 1.3 + (k % 3) * 0.05,              // 1.30..1.40
        capMu: opts.capMu ?? Math.max(100, Math.round((totalMu * 0.25) / n)),
        minSpreadBps: 35,
        skewAmp: 120,
      },
      refPrice,
    });
  }
  return soldiers;
}

/* ── feeCompound: אבן-דרך-עמלות → הולדת-מיקרו-גריד (הרשת-שמרחיבה-את-עצמה) ──
   כנות: מוסיפים הון-ציטוט רק מעמלות-שנמדדו (feeMeter.capturedMu). אין-הדפסה. */
export function feeCompound(state, milestoneMu = 50) {
  const fm = state.feeMeter ?? { capturedMu: 0, compoundedMu: 0, births: 0 };
  const available = (fm.capturedMu ?? 0) - (fm.compoundedMu ?? 0);
  if (available < milestoneMu) return { born: 0, note: `need ${milestoneMu}μ, have ${Math.floor(available)}μ` };
  const born = Math.floor(available / milestoneMu);
  fm.compoundedMu = (fm.compoundedMu ?? 0) + born * milestoneMu;
  fm.births = (fm.births ?? 0) + born;
  return { born, note: `${born} micro-grid(s) born from measured fees` };
}

/* ── captureFees: חלק-המייקרים מבריכת-עמלות הטייקרים (פרו-רטה לפי נפח) ─────
   בריכה = עמלות-טייקרים-חוץ שנמדדו; מחלקים 70% למייקרים לפי נתח-נפח
   (אותה-דוקטרינת 70/30 של LIQUIDITY_STRATEGY). כנות: אפס-נפח → אפס-חלק. */
export function captureFees(feePoolMu, ourVolumeMu, totalVolumeMu) {
  if (totalVolumeMu <= 0 || ourVolumeMu <= 0) return 0;
  const share = Math.min(1, ourVolumeMu / totalVolumeMu);
  return r6(feePoolMu * 0.7 * share);
}

export const SUPREMACY_FEE_BPS = FEE_BPS;
