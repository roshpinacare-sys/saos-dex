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
// חוקי-ברזל (אותם-חוקים של grid-pulse R83 + הדוקטרינה הקיימת + Z-77):
//   · clamp bid < fair < ask — לעולם לא חוצים את הספר;
//   · רוחב-מינימלי minSpreadBps — לא מצטטים רוחב שאינו מכסה עמלה+סליפ;
//   · תקרת-מלאי capMu — מעליה מצב-פריקה (צד-מפחית-בלבד, חצי-גודל);
//   · Z-77 פריקה-עמוקה: ב-2×capMu אין קפיאה — פריקה-עמוקה בגודל-מלא.
//     הלקח-הנמדד: "עצירה-מלאה ב-2×cap" משאירה חייל-קפוא-עם-מלאי-תקוע
//     (גרסה-מתקדמת של באג-הצבא מ-Z-75) — חייל-קפוא לא מפחית סיכון, הוא מקפיא אותו.
//     כל-עוד ה-ref חי — מפחיתים; השער-הקשה נשאר ב-estate (מעל 2×cap מילוי-אמת = HALT בעלים).
//   · Z-77 תקרת-צי גלובלית (fleetCap): סכום-המלאי של כל-החיילים חסום —
//     תקרה-פר-חייל מגינה על חייל-בודד; תקרת-צי מגינה על הארמייה (שאילתה 19);
//   · Z-77 פיד-פורוורד EWMA (שאילתה 13): רוחב-הציטוט לומד מהתנודתיות-הנמדדת —
//     רעילות מתרחבת-רוחב, שקט מהדק-רוחב (ווליום-מקסימום בשלווה);
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

/* ── Z-77 · EWMA של תנודתיות-נמדדת (שאילתה 13 — פיד-פורוורד) ──────────────
   עדכון אקספוננציאלי של |תשואה| לטיק (bps). המנוע לומד את קצב-השוק מהמדידה
   האמת — לא מהנחות. alpha=0.2: חצי-חיים ≈ 3 טיקים — מהיר מספיק לרעילות,
   יציב מספיק לא לרדוף אחרי רעש. אפס-קלט → אפס-שינוי (כנות). */
export function updateVolEwma(prevBps, refPrice, prevRefPrice, alpha = 0.2) {
  if (!prevRefPrice || prevRefPrice <= 0 || !refPrice || refPrice <= 0) return prevBps ?? 0;
  const ret = Math.abs(refPrice / prevRefPrice - 1) * 10000;
  const prev = prevBps ?? ret;
  return r6(prev + alpha * (ret - prev));
}

/* ── Z-77 · מודולציית-רוחב לפי תנודתיות-נמדדת ────────────────────────────
   ratio = volEwma / calmBps: 1 = נורמלי. רעיל (ratio>1) → מתרחב עד 1+maxWiden;
   שקט (ratio<1) → מתהדק עד 1−maxTighten (ווליום-מקסימום בשלווה — דבר-המפעיל).
   רציף, חסום, דטרמיניסטי. רצפת minSpreadBps נאכפת בהמשך (אחרי-המודולציה). */
export function modulateWidth(widthBps, volEwmaBps, opts = {}) {
  const calmBps = opts.calmBps ?? 30;        // תנודתיות-עוגן של הרשת (bps/טיק)
  const maxWiden = opts.maxWiden ?? 1.0;     // עד ×2 בתנודתיות-קיצון
  const maxTighten = opts.maxTighten ?? 0.3; // עד ×0.7 בשקט-עמוק
  if (!(volEwmaBps > 0) || calmBps <= 0) return r6(widthBps); // אין-מדידה → אין-מודולציה
  const ratio = volEwmaBps / calmBps;
  const f = Math.max(1 - maxTighten, Math.min(1 + maxWiden, ratio));
  return r6(widthBps * f);
}

/* ── Z-77 · תקרת-צי גלובלית (שאילתה 19) ──────────────────────────────────
   מדינת-הצי: סכום-מלאי, חריגה, יתרת-מקום. חריגה רכה → כל-הצי בפריקה
   (market.fleetUnwindOnly, מנוהל ב-engine); חריגה קשה (>2×globalCap) →
   אינווריאנט-estate עוצר-הכל (HALT בעלים). */
export function fleetCapState(grids, globalCapMu) {
  const invMu = r6((grids ?? []).reduce((a, g) => a + (g.inventoryMu ?? 0), 0));
  return { invMu, breach: invMu > globalCapMu, headroomMu: r6(globalCapMu - invMu) };
}

/* ── Z-78 · שאילתה 24: כיול-עצמי של עוגן-התנודתיות ממדידה אמת ─────────────
   העיקרון: **מדידה מנצחת הנחה.** במקום calmBps=30 קבוע, העוגן מחושב
   מסדרת-המחירים-הנמדדת (חלון 64): **חציון** התשואות המוחלטות — חסין-חריגים
   (לווייתן-אחד לא מזיז את-העוגן), רצפה 1bps (שוק-סטטי: כל-תזוזה = אירוע
   ולא-נורמה), fallback 30 רק-באין-מדידה. דטרמיניסטי, זול (≤64 ערכים). */
export function calibrateCalmBps(series, opts = {}) {
  const window = opts.window ?? 64;
  const fallback = opts.fallback ?? 30;
  const floorBps = opts.floorBps ?? 1;
  const w = (series ?? []).filter((v) => typeof v === "number" && v > 0).slice(-window);
  if (w.length < 2) return fallback;
  const rets = [];
  for (let i = 1; i < w.length; i++) rets.push(Math.abs(w[i] / w[i - 1] - 1) * 10000);
  rets.sort((a, b) => a - b);
  const mid = Math.floor(rets.length / 2);
  const median = rets.length % 2 ? rets[mid] : (rets[mid - 1] + rets[mid]) / 2;
  return r6(Math.max(floorBps, median));
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
  // Z-77: אין-קפיאה-עם-מלאי. 2×capMu = פריקה-עמוקה (גודל-מלא), לא עצירה.
  const deep = abs >= capMu * 2;
  // פריקה: חייל-מעל-התקרה שלו, או שהצי-כולו מעל התקרה-הגלובלית (שאילתה 19)
  const unwindOnly = deep || market.fleetUnwindOnly === true || abs >= capMu;

  // Z-77 פיד-פורוורד: רוחב-בסיס מתכייל לפי תנודתיות-נמדדת (undefined = אין-מדידה → קבוע)
  // Z-78 · שאילתה 24: **המדידה מנצחת** — calmBps שנמדד (market.calmBps) גובר על
  // הנחה (p.calmBps) ועל-ברירת-המחדל (30). פרמטר-מפורש מוצמד רק-באין-מדידה.
  const wBase = modulateWidth(widthBps, market.volEwmaBps, { ...p, calmBps: market.calmBps ?? p.calmBps });

  const skew = inventorySkew(inventoryMu, capMu);
  const orders = [];
  for (let i = 1; i <= levels; i++) {
    // רוחב נכנס: ארוך → bid רחוק, ask קרוב (מוכרים יותר); קצר → ההפך
    const bidW = Math.max(minSpreadBps / 2, wBase * i + skewAmp * skew) * ref / 10000;
    const askW = Math.max(minSpreadBps / 2, wBase * i - skewAmp * skew) * ref / 10000;
    const bid = r6(ref - bidW);
    const ask = r6(ref + askW);
    if (bid >= ref || ask <= ref) continue; // חוק-ברזל: bid<fair<ask
    const size = r6(levelMu * Math.pow(growth, i - 1));
    if (size <= 0) continue;
    if (unwindOnly) {
      // מצב-פריקה: רק הצד שמקטין מלאי, ברוחב-המינימום (הצמוד ביותר).
      // תיקון-Z77 (קצה-נסתר): חייל-אפס-מלאי בפריקת-צי לא מוסיף-מלאי —
      // הענף-הישן היה דוחף bid לחייל-ריק (else של >0) = הוספת-סיכון בדיוק
      // ברגע-החריגה הגלובלית. ריק → אפס-פקודות.
      if (abs < 1e-9) return { orders: [], note: "unwind-idle" };
      const wMin = (minSpreadBps / 2) * ref / 10000;
      const sz = deep ? r6(levelMu) : r6(levelMu * 0.5); // פריקה-עמוקה = גודל-מלא
      if (inventoryMu > 0) orders.push({ side: "ask", price: r6(ref + wMin), sizeMu: sz, gridId: grid.id, strat: deep ? "supremacy-deep-unwind" : "supremacy-unwind" });
      else orders.push({ side: "bid", price: r6(ref - wMin), sizeMu: sz, gridId: grid.id, strat: deep ? "supremacy-deep-unwind" : "supremacy-unwind" });
      break; // רמה-אחת צמודה מספיקה לפריקה
    }
    orders.push({ side: "bid", price: bid, sizeMu: size, gridId: grid.id, strat: "supremacy" });
    orders.push({ side: "ask", price: ask, sizeMu: size, gridId: grid.id, strat: "supremacy" });
  }
  const note = deep ? `deep-unwind inv=${inventoryMu}`
    : unwindOnly ? `unwind-only inv=${inventoryMu}`
    : `supremacy skew=${skew.toFixed(2)} levels=${orders.length / 2} w=${wBase.toFixed(1)}`;
  return { orders, note };
}

/* ── fleetSpawn: חלוקת-הון לצי חיילים על סולם-המחיר ────────────────────────
   המפעיל: "להשיג כמה שיותר תנועה עם כמה שיותר חיילים". חלוקה שווה-שקלית
   עם גיוון-פרמטרים דטרמיניסטי.
   Z-78 · חוק-ריווח (שאילתה 27): סולם-רוחבים **רציף** — כל-חייל מקבל רוחב-ייחודי
   (span 24bps חלוק באופן שווה) — הסכימה הישנה (k%5) שכפלה רוחבים מ-n≥6
   = קניבליזציה-מובנית (חיילים-תאומים נלחמים על אותן-פקודות).
   Z-78 · חוק-אחידות-הון (שאילתה 23): capMu ≥ 2×גודל-הרמה-המקסימלי —
   מילוי-מלא-אחד **לא יכול** לעבור-תקרה (הבאג-הנמדד: levelMu≈4×capMu
   בברירת-המחדל הישנה — כל-מילוי הכניס לפריקה-עמוקה מיד). */
export function fleetSpawn(totalMu, count, refPrice, opts = {}) {
  const n = Math.max(1, Math.floor(count));
  const widthSpanBps = opts.widthSpanBps ?? 24;      // רוחבים 40..40+span, ייחודיים
  const step = n > 1 ? widthSpanBps / (n - 1) : 0;
  const capShare = opts.capShare ?? 0.25;            // חלק-התקרה מההון-הכולל
  const sizeJitter = opts.sizeJitter ?? 0.15;
  const soldiers = [];
  for (let k = 0; k < n; k++) {
    const levels = 3 + (k % 2);                      // 3 או 4 רמות
    const growth = 1.3 + (k % 3) * 0.05;             // 1.30..1.40
    const share = Math.max(100, Math.round((totalMu * capShare) / n));
    const capMu = opts.capMu ?? share;
    const lvlRaw = Math.max(1, r6(share * (1 + ((k % 3) - 1) * sizeJitter)));
    // floor (לא-r6) — עיגול-מעלה יכול לשבור את האי-שוויון הקפדני של האחידות
    const levelMu = Math.max(1, Math.min(lvlRaw, Math.floor((capMu / (2 * Math.pow(growth, levels - 1))) * 1e6) / 1e6));
    soldiers.push({
      id: `sup-${k + 1}`,
      params: {
        levels,
        widthBps: r6(40 + k * step),                 // Z-78: ייחודי-תמיד
        levelMu,
        growth,
        capMu,
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

/* ── Z-79 · שאילתה 34: מודל-השוליים — נקודת-העצירה מחוזה מהמדידה ──────────
   חקר-העלייה (שאילתה 32) מדד דעיכת-שוליים (619→480→325μ/חייל). שאילתה 34
   שואלת: איזה מודל מציב את נקודת-העצירה **לפני** שהשוליים נהיים שליליים?
   המודל (מוצהר, מקומי, פשוט-לביקורת): m(n) = a − b·ln(n) — דעיכה לוגריתמית
   (זרימת-השוק מתפזרת בין-חיילים בקצב תת-ליניארי). רגרסיה ליניארית על
   (ln n, m) → חיזוי m(n) לכל-n, ונקודת-האפס n* = exp(−a/b) = נקודת-העצירה.
   כנות: מודל-חוזה אינו אמת — הוא חייב אימות על-עוד-זרעים (selftest, שאילתה 34). */
export function marginalModel(rows) {
  const pts = (rows ?? [])
    .filter((r) => r && r.marginalPerSoldierMu != null && Number.isFinite(r.marginalPerSoldierMu))
    .map((r) => ({ n: r.soldiers, m: r.marginalPerSoldierMu }))
    .filter((p) => p.n > 1);
  if (pts.length < 2) return null;
  const N = pts.length;
  const sx = pts.reduce((a, p) => a + Math.log(p.n), 0);
  const sy = pts.reduce((a, p) => a + p.m, 0);
  const sxx = pts.reduce((a, p) => a + Math.log(p.n) * Math.log(p.n), 0);
  const sxy = pts.reduce((a, p) => a + Math.log(p.n) * p.m, 0);
  const d = N * sxx - sx * sx;
  if (Math.abs(d) < 1e-12) return null;
  const slope = (N * sxy - sx * sy) / d;      // שיפוע b — שלילי = דעיכה
  const intercept = (sy - slope * sx) / N;    // חיתוך a
  const predict = (n) => intercept + slope * Math.log(Math.max(2, n));
  const stopAt = slope < -1e-12 ? Math.exp(-intercept / slope) : Infinity; // m=0 → n*
  return {
    slope: r6(slope), intercept: r6(intercept), stopAt: r6(Math.min(stopAt, 1e9)),
    predict,
    model: "m(n)=intercept−|slope|·ln(n) (declared, verified across seeds in selftest)",
  };
}

/* ── Z-79 · פס-דין-צמיחה: GO רק אם השוליים-החזויים ביעד חיוביים ולפני-n* ──
   מדד-העצירה שנעול ב-Z-78 ("כל-צעד-צמיחה חייב שולי-חיובי") הופך כאן לפונקציה.
   STOP = אין-צמיחה. זו לא המלצה — זה שער. */
export function growthVerdict(model, targetCount) {
  if (!model || !(targetCount > 1)) return { verdict: "STOP", predictedMarginalMu: null, note: "no-model-or-target" };
  const m = model.predict(targetCount);
  const go = m > 0 && targetCount < model.stopAt;
  return {
    verdict: go ? "GO" : "STOP",
    predictedMarginalMu: r6(m),
    stopAt: model.stopAt,
    note: go
      ? `predicted +${m.toFixed(1)}μ/soldier at n=${targetCount} (stop-point ${model.stopAt.toFixed(0)}) — growth measured-justified`
      : `predicted ${m.toFixed(1)}μ/soldier at n=${targetCount} — past/below the measured stop-point, growth denied`,
  };
}
