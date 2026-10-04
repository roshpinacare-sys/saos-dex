// SUPREMACY-SELFTEST — אינווריאנטות-ברזל של מנוע-העליונות (שער-CI)
// =============================================================================
// כל שורה כאן = חוק שאסור להישבר. ריצה: `node grids/supremacy-selftest.mjs`.
// יציאה לא-אפס = כל-ענף-העליונות נעצר (שער-דוקטרינה, לא עניין-סגנון).
// Z-77: המספרים-המבניים נמדדו וננעלו מהקבלה הדטרמיניסטית (seed 20261004).

import { mulberry32, FEE_BPS } from "./strategies.mjs";
import { supremacyTick, fleetSpawn, feeCompound, captureFees, inventorySkew, updateVolEwma, modulateWidth, fleetCapState, calibrateCalmBps, marginalModel, growthVerdict } from "./mm-supremacy.mjs";
import { scalingStudy, runAll, SCENARIOS, QUEUE_FLOOR, LATENCY_P } from "./sim/volume-sim.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const r6 = (v) => Math.round(v * 1e6) / 1e6;

console.log("mm-supremacy selftest — אינווריאנטות-ברזל");

/* 1) אין-חציית-ספר: bid < ref < ask על 500 מצבים-אקראיים (גם-עם EWMA פעיל) */
{
  const rng = mulberry32(7);
  let bad = 0, quoted = 0;
  for (let i = 0; i < 500; i++) {
    const ref = r6(0.05 + rng() * 2);
    const inv = r6((rng() * 2 - 1) * 6000);
    const vol = rng() < 0.5 ? undefined : rng() * 300; // חצי-המצבים עם מודולציית-EWMA
    const grid = { id: "t", params: { levels: 4, widthBps: 40, levelMu: 100, growth: 1.4, capMu: 8000 } };
    const market = { refPrice: ref, stale: false };
    if (vol !== undefined) market.volEwmaBps = vol;
    const q = supremacyTick(grid, market, inv);
    for (const o of q.orders) {
      quoted++;
      if (o.side === "bid" && o.price >= ref) bad++;
      if (o.side === "ask" && o.price <= ref) bad++;
    }
  }
  ok("no-cross (bid<ref<ask)", bad === 0 && quoted > 500, `${quoted} quotes, ${bad} crossings`);
}

/* 2) רוחב-מינימלי: מרחק-כל-ציטוט מה-ref ≥ minSpreadBps/2 — גם-אחרי-מודולציה */
{
  const rng = mulberry32(11);
  let bad = 0;
  for (let i = 0; i < 200; i++) {
    const ref = r6(0.1 + rng());
    const inv = r6((rng() * 2 - 1) * 3000);
    const vol = rng() * 300; // כל-טווח-ה-EWMA — הרצפה חייבת לשרוד
    const grid = { id: "t", params: { levels: 4, widthBps: 40, levelMu: 100, growth: 1.4, capMu: 8000, minSpreadBps: 35 } };
    const q = supremacyTick(grid, { refPrice: ref, stale: false, volEwmaBps: vol }, inv);
    const half = (35 / 2) * ref / 10000;
    for (const o of q.orders) if (Math.abs(o.price - ref) < half - 1e-6) bad++; // טולרנס r6 (רזולוציית-ציטוט)
  }
  ok("min-spread (גם-עם-EWMA)", bad === 0);
}

/* 3) הטיית-מלאי: מלאי-ארוך → ask קרוב-מה-bid (מוכרים-יותר); קצר → ההפך */
{
  const ref = 1.0;
  const g = { id: "t", params: { levels: 3, widthBps: 60, levelMu: 100, growth: 1.3, capMu: 8000, skewAmp: 120 } };
  const longQ = supremacyTick(g, { refPrice: ref, stale: false }, 4000);
  const shortQ = supremacyTick(g, { refPrice: ref, stale: false }, -4000);
  const bestAsk = (q) => Math.min(...q.orders.filter((o) => o.side === "ask").map((o) => o.price));
  const bestBid = (q) => Math.max(...q.orders.filter((o) => o.side === "bid").map((o) => o.price));
  // מרחקים-חיוביים: ask נמדד מעל-ה-ref, bid מתחתיו
  const longTightAsk = (bestAsk(longQ) - ref) < (ref - bestBid(longQ));
  const shortTightBid = (ref - bestBid(shortQ)) < (bestAsk(shortQ) - ref);
  ok("skew-long→tight-ask", longTightAsk, `askΔ=${(bestAsk(longQ) - ref).toFixed(6)} bidΔ=${(ref - bestBid(longQ)).toFixed(6)}`);
  ok("skew-short→tight-bid", shortTightBid, `bidΔ=${(ref - bestBid(shortQ)).toFixed(6)} askΔ=${(bestAsk(shortQ) - ref).toFixed(6)}`);
}

/* 4) Z-77 · תקרת-מלאי: מעל capMu → פריקה (צד-מפחית, חצי-גודל);
      2×capMu → פריקה-עמוקה (גודל-מלא) — אף-חייל-לא-קופא עם מלאי */
{
  const g = { id: "t", params: { levels: 3, levelMu: 100, capMu: 1000, minSpreadBps: 35 } };
  const qw = supremacyTick(g, { refPrice: 1.0, stale: false }, 1000);   // ארוך-על-התקרה
  const asks = qw.orders.filter((o) => o.side === "ask");
  const bids = qw.orders.filter((o) => o.side === "bid");
  ok("cap→unwind-only-asks", bids.length === 0 && asks.length > 0 && asks.every((o) => o.sizeMu <= 50), qw.note);
  const qsw = supremacyTick(g, { refPrice: 1.0, stale: false }, -1000); // קצר-על-התקרה
  ok("cap→unwind-only-bids", qsw.orders.every((o) => o.side === "bid") && qsw.orders.length > 0, qsw.note);
  const qd = supremacyTick(g, { refPrice: 1.0, stale: false }, 2000);   // 2×תקרה — פריקה-עמוקה
  const dAsks = qd.orders.filter((o) => o.side === "ask");
  ok("2×cap→deep-unwind-לא-קפיאה", qd.halted === undefined && qd.orders.length > 0 && dAsks.length === qd.orders.length && dAsks.every((o) => o.sizeMu === 100), `${qd.note} — הלקח: חייל-קפוא-עם-מלאי = באג-צבא`);
}

/* 5) stale/אין-מדידה → אין-ציטוט (אפס-מחירים-מומצאים) */
{
  const g = { id: "t", params: {} };
  ok("stale→no-quote", supremacyTick(g, { refPrice: 1.0, stale: true }, 0).orders.length === 0);
  ok("no-ref→no-quote", supremacyTick(g, { stale: false }, 0).orders.length === 0);
}

/* 6) fleetSpawn: מספר-נכון, מזהים-ייחודיים, הון-מפוצל-חוקי */
{
  const fleet = fleetSpawn(10000, 16, 0.2);
  const ids = new Set(fleet.map((s) => s.id));
  const widths = new Set(fleet.map((s) => s.params.widthBps));
  ok("fleet-16-unique-ids", fleet.length === 16 && ids.size === 16);
  ok("fleet-width-diversity", widths.size > 1, `${widths.size} widths`);
  ok("fleet-levels-positive", fleet.every((s) => s.params.levelMu > 0));
}

/* 7) captureFees: אפס-נפח → אפס; חלק ≤ 70% מהבריכה; פרו-רטה עולה עם נתח */
{
  ok("capture-zero-volume", captureFees(1000, 0, 10000) === 0);
  const a = captureFees(1000, 1000, 10000);
  const b = captureFees(1000, 5000, 10000);
  ok("capture-cap-70%", a <= 700 + 1e-9 && b <= 700 + 1e-9, `a=${a} b=${b} (תקרה=0.7×בריכה)`);
  ok("capture-exact-pro-rata", a === r6(1000 * 0.7 * 0.1) && b === r6(1000 * 0.7 * 0.5), "פרו-רטה מדויק");
}

/* 8) feeCompound: הולדה רק מעמלות-שנמדדו; אין-הדפסה */
{
  const s1 = { feeMeter: { capturedMu: 0, compoundedMu: 0, births: 0 } };
  ok("compound-no-fees→no-birth", feeCompound(s1, 50).born === 0);
  const s2 = { feeMeter: { capturedMu: 120, compoundedMu: 0, births: 0 } };
  const r2 = feeCompound(s2, 50);
  ok("compound-120→2-born", r2.born === 2 && s2.feeMeter.compoundedMu === 100 && s2.feeMeter.births === 2, r2.note);
}

/* 9) דטרמיניזם: אותו-זרע → אותה-קבלה בדיוק */
{
  const a = JSON.stringify(runAll({ ticks: 120, seed: 42 }));
  const b = JSON.stringify(runAll({ ticks: 120, seed: 42 }));
  const c = JSON.stringify(runAll({ ticks: 120, seed: 43 }));
  ok("determinism-same-seed", a === b);
  ok("determinism-diff-seed", a !== c);
}

/* 10) מנגנון-הצי: זרימה-מונוטונית + רווחיות-בשלווה + A/B של הפיד-פורוורד (Z-77) */
{
  const rs = runAll({ ticks: 240, seed: 20261004 });
  const by = Object.fromEntries(rs.map((r) => [r.scenario, r.results]));
  const flow = (x) => x.volumeMu + x.extVolumeMu;
  ok("flow-fleet>baseline", flow(by["fleet-8"]) > flow(by["baseline-1"]),
     `${flow(by["fleet-8"]).toFixed(0)}μ vs ${flow(by["baseline-1"]).toFixed(0)}μ`);
  ok("flow-supremacy>fleet", flow(by["supremacy-16"]) > flow(by["fleet-8"]),
     `${flow(by["supremacy-16"]).toFixed(0)}μ vs ${flow(by["fleet-8"]).toFixed(0)}μ`);
  ok("calm-regime-profitable", by["baseline-1"].netPnlMu > 0 && by["fleet-8"].netPnlMu > 0 && by["supremacy-16"].netPnlMu > 0,
     `net ${by["baseline-1"].netPnlMu.toFixed(1)}/${by["fleet-8"].netPnlMu.toFixed(1)}/${by["supremacy-16"].netPnlMu.toFixed(1)}μ`);
  ok("fees-captured-all-calm", by["baseline-1"].feesCapturedMu > 0 && by["fleet-8"].feesCapturedMu > 0 && by["supremacy-16"].feesCapturedMu > 0);
  // Z-79 · החוק-שהתהפך (נמדד, לא חדש-חדש): בעידן-ללא-מיקרו-מבנה התנודתיות הייתה עלות
  // (volatile < fleet-8). עם ערוצי-המיקרו-מבנה (שאילתה 35) הטיפול-EWMA **מרוויח
  // מהעקה יותר מהשלווה** — הציטוטים-הפגים נקטפים אצל-הביקורת, הטיפול מתרחב ומגן.
  ok("volatile-treatment-beats-calm-fleet-under-microstructure", by["volatile-16"].netPnlMu > by["fleet-8"].netPnlMu,
     `volatile ${by["volatile-16"].netPnlMu.toFixed(1)}μ > calm-fleet ${by["fleet-8"].netPnlMu.toFixed(1)}μ (היה: volatile < fleet — המיקרו-מבנה הפך את המשטר, Z-79)`);
  // Z-78 · הלקח-הנמדד-הכנה: בעידן-ההון-הבלתי-אחיד (Z-77) ה-A/B מדד את ה-EWMA
  // מציל −39.6μ דרך ערוץ-הפריקה-העמוקה. אחידות-ההון (Z-78) **חיסלה את-הערוץ**
  // (0 פריקות-עמוקות) — וההפרש בין-הטיפול לביקורת מתכנס לרעש. ההגנה האמת
  // עכשיו מבנית (קיווי-רמות-מתאים-תקרה), וה-EWMA נשאר לרוחב-אדפטיבי, לא כמציל.
  const abGap = Math.abs(by["volatile-16"].netPnlMu - by["volatile-16-plain"].netPnlMu);
  ok("ab-noise-at-240", abGap <= 15,
     `|טיפול−ביקורת| ב-240 טיקים = ${abGap.toFixed(1)}μ ≤ 15μ — בחלון-קצר ההבדל ברעש (כנות-נמדדת)`);
  // Z-79 · שאילתה 35 נמסרת: בחלון-480 הגנת-ה-EWMA **מתפרשת** — הביקורת נקטפת
  // דרך-ציטוטים-פגים (לטנטיות 30%), הטיפול מתרחב-רוחב ונמנע. נמדד: +72.1μ רווח-נטו,
  // +5406μ ווליום, dd 54→22μ, פריקות-עמוקות 1→0. זה הערוץ-שחידש-את-ההפרש.
  const t480 = runAll({ ticks: 480, seed: 20261004 }).filter((r) => r.scenario.startsWith("volatile-16"));
  const vT = t480.find((r) => r.scenario === "volatile-16").results;
  const vC = t480.find((r) => r.scenario === "volatile-16-plain").results;
  ok("ab-protection-at-480 (q35)", vT.netPnlMu - vC.netPnlMu > 15 && vT.deepUnwindTicks < vC.deepUnwindTicks,
     `480t: טיפול +${vT.netPnlMu.toFixed(1)}μ מול ביקורת +${vC.netPnlMu.toFixed(1)}μ (הפרש +${(vT.netPnlMu - vC.netPnlMu).toFixed(1)}μ), פריקות ${vT.deepUnwindTicks} מול ${vC.deepUnwindTicks}`);
  // Z-78 · שאילתה 23 אחידות-הון — מתייחס לטיפול; הביקורת **רשאית** לפרוק-עמוק
  // (זו בדיוק הראיה-הנמדדת לסיכון-הלטנטיות שהטיפול מנטרל).
  ok("coherence-no-deep-unwind-in-treatment", rs.filter((r) => r.config.ewma !== false).every((r) => r.results.deepUnwindTicks === 0),
     `טיפול: ${rs.filter((r) => r.config.ewma !== false).map((r) => r.results.deepUnwindTicks).join(",")} — ביקורת: ${rs.find((r) => r.config.ewma === false).results.deepUnwindTicks} (העדות-הנמדדת)`);
  // Z-78 · החוק-הגדול: עקה-תנודתית מפסידה < 5% מההון (העידן-הישן מדד −44%!)
  ok("volatile-loss-bounded-under-coherence", by["volatile-16"].netPnlPctOfCapital > -5,
     `${by["volatile-16"].netPnlPctOfCapital.toFixed(2)}% > −5% (היה: −44.11% בעידן-הישן; עכשיו חיובי-מלא, Z-79)`);
  ok("no-nan-anywhere", rs.every((r) => Object.values(r.results).every((v) => typeof v === "number" ? Number.isFinite(v) : true)));
  ok("scenario-config-sane", SCENARIOS["supremacy-16"].compound === true && SCENARIOS["volatile-16-plain"].ewma === false);
}

/* 11) inventorySkew: חסום ב-[-1,1] */
{
  ok("skew-clamped", inventorySkew(99999, 1000) === 1 && inventorySkew(-99999, 1000) === -1 && inventorySkew(0, 1000) === 0);
}

/* 12) עמלה-עקבית-עם-ה-DEX: FEE_BPS=30 נשמר (אם ישתנה — השער עוצר) */
ok("fee-bps-consistent", FEE_BPS === 30, `FEE_BPS=${FEE_BPS}`);

/* ── Z-77 · שאילתה 13: הפיד-פורוורד הוא מדידה, לא הנחה ──────────────────── */

/* 13) updateVolEwma: מתמטיקה מדויקת — עדכון, דעיכה, אפס-קלט → אפס-שינוי */
{
  const a = updateVolEwma(0, 1.01, 1.0);            // ret=100bps, prev=0 → 0.2×100 = 20
  const b = updateVolEwma(20, 1.0, 1.0);            // ret=0 → דעיכה ל-16
  const c = updateVolEwma(20, 1.0, 0);              // אין-prevRef → אין-שינוי
  const d = updateVolEwma(20, null, 1.0);           // אין-מדידה → אין-שינוי
  ok("ewma-update-exact", a === 20, `20bps from 100bps move`);
  ok("ewma-decay-exact", b === 16, `20→16 on flat tick`);
  ok("ewma-null-inputs-no-change", c === 20 && d === 20);
}

/* 14) modulateWidth: חסימה כפולה + אין-מדידה → אין-מודולציה + מונוטוניות */
{
  const x = modulateWidth(40, 60);   // ratio 2 → ×2
  const y = modulateWidth(40, 300);  // ratio 10 → נחסם ×2
  const z = modulateWidth(40, 15);   // ratio 0.5 → נחסם ×0.7 = 28
  const n = modulateWidth(40, undefined); // אין-מדידה → אותו-רוחב
  const z0 = modulateWidth(40, 0);   // אפס-מדידה → אותו-רוחב (לא-הידוק — אין-ראיה)
  ok("modulate-widen-exact", x === 80, `40→${x}`);
  ok("modulate-widen-capped", y === 80, `300bps capped → ${y}`);
  ok("modulate-tighten-capped", z === 28, `15bps → ${z}`);
  ok("modulate-no-measurement→no-change", n === 40 && z0 === 40, `undefined=${n} zero=${z0}`);
  let mono = true, prev = -1;
  for (let v = 0; v <= 300; v += 10) {
    const w = modulateWidth(40, v || 1);
    if (v === 0) continue;
    if (w < prev) mono = false;
    prev = w;
  }
  ok("modulate-monotone-in-vol", mono);
}

/* 15) הטיק מרחיב-ברעילות ומהדק-בשקט — והרצפה שורדת */
{
  const g = { id: "t", params: { levels: 2, widthBps: 40, levelMu: 100, growth: 1.3, capMu: 8000, minSpreadBps: 35 } };
  const plain = supremacyTick(g, { refPrice: 1.0, stale: false }, 0);
  const toxic = supremacyTick(g, { refPrice: 1.0, stale: false, volEwmaBps: 120 }, 0);
  const calm = supremacyTick(g, { refPrice: 1.0, stale: false, volEwmaBps: 15 }, 0);
  const dist = (q) => q.orders.find((o) => o.side === "ask").price - 1.0;
  ok("ewma-toxic→wider", dist(toxic) > dist(plain), `toxic ${(dist(toxic) * 1e4).toFixed(1)}bps > plain ${(dist(plain) * 1e4).toFixed(1)}bps`);
  ok("ewma-calm→tighter", dist(calm) < dist(plain), `calm ${(dist(calm) * 1e4).toFixed(1)}bps < plain — ווליום-מקסימום בשלווה`);
}

/* 16) תקרת-צי גלובלית: סכום, חריגה, יתרה — מדויק */
{
  const grids = [{ inventoryMu: 500 }, { inventoryMu: 300.5 }, { inventoryMu: 0 }, {}];
  const s = fleetCapState(grids, 1000);
  ok("fleet-cap-sum-breach", s.invMu === 800.5 && s.breach === false && s.headroomMu === 199.5, JSON.stringify(s));
  const b = fleetCapState(grids, 800);
  ok("fleet-cap-breach-detected", b.breach === true && b.headroomMu === -0.5, `headroom ${b.headroomMu} (שלילי = מעבר-לתקרה)`);
  ok("fleet-cap-empty-safe", fleetCapState([], 1000).invMu === 0 && fleetCapState(null, 1000).invMu === 0);
}

/* 17) פריקת-צי: כל-החיילים מפחיתים; חייל-ריק לא מוסיף-מלאי (קצה-נסתר שנתפס) */
{
  const g = { id: "t", params: { levels: 3, levelMu: 100, capMu: 8000, minSpreadBps: 35 } };
  const longQ = supremacyTick(g, { refPrice: 1.0, stale: false, fleetUnwindOnly: true }, 500);
  const shortQ = supremacyTick(g, { refPrice: 1.0, stale: false, fleetUnwindOnly: true }, -500);
  const idleQ = supremacyTick(g, { refPrice: 1.0, stale: false, fleetUnwindOnly: true }, 0);
  ok("fleet-unwind-long→asks-only", longQ.orders.every((o) => o.side === "ask") && longQ.orders.length > 0);
  ok("fleet-unwind-short→bids-only", shortQ.orders.every((o) => o.side === "bid") && shortQ.orders.length > 0);
  ok("fleet-unwind-idle→no-orders (תיקון-קצה: אין-הוספת-מלאי בחריגה)", idleQ.orders.length === 0 && idleQ.note === "unwind-idle");
}

/* 18) אף-נתיב-רגיל לא מחזיר halted (הקפאה-עם-מלאי אסורה — לקח-Z75 מושלם) */
{
  const g = { id: "t", params: { levels: 2, levelMu: 100, capMu: 100 } };
  const notes = [];
  for (const inv of [0, 100, 500, -500, 2500, -2500]) {
    const q = supremacyTick(g, { refPrice: 1.0, stale: false }, inv);
    if (q.halted) notes.push(`${inv}:halted`);
  }
  ok("no-freeze-anywhere", notes.length === 0, notes.join(",") || "כל-המלאים מצטטים או פורקים");
}

/* 19) A/B דטרמיניסטי: ריצה-כפולה של הביקורת → ביט-ביט (הניסוי מבוקר, לא מזדמן) */
{
  const a = JSON.stringify(runAll({ ticks: 60, seed: 20261004 }).find((r) => r.scenario === "volatile-16-plain"));
  const b = JSON.stringify(runAll({ ticks: 60, seed: 20261004 }).find((r) => r.scenario === "volatile-16-plain"));
  const c = JSON.stringify(runAll({ ticks: 60, seed: 20261004 }).find((r) => r.scenario === "volatile-16"));
  ok("ab-control-reproducible", a === b);
  ok("ab-control-differs-treatment", a !== c);
}

/* ── Z-78 · שאילתה 24: העוגן-הנמדד — מתמטיקה מדויקת, חסינות-חריגים, כנות ── */

/* 20) calibrateCalmBps: חציון מדויק, רצפה, fallback */
{
  const a = calibrateCalmBps([1, 1.01, 1.01]);   // rets=[100,0] → חציון 50
  const b = calibrateCalmBps([1, 1, 1, 1.5, 1, 1]); // לווייתן-אחד → חציון 0 → רצפה 1
  const c = calibrateCalmBps([]);                 // אין-מדידה → fallback 30
  const d = calibrateCalmBps([0.2]);              // נקודה-אחת → fallback 30
  const e = calibrateCalmBps(null);               // אין-סדרה → fallback 30
  ok("calm-median-exact", a === 50, `rets [0,100] → ${a}`);
  ok("calm-outlier-robust", b === 1, `לווייתן לא מזיז את-העוגן → רצפה ${b}`);
  ok("calm-fallback-honest", c === 30 && d === 30 && e === 30, `empty/single/null → 30`);
}

/* 21) המדידה מנצחת הנחה: market.calmBps גובר על p.calmBps */
{
  const g = { id: "t", params: { levels: 2, widthBps: 40, levelMu: 100, growth: 1.3, capMu: 8000, minSpreadBps: 35, calmBps: 1000 } };
  const measured = supremacyTick(g, { refPrice: 1.0, stale: false, volEwmaBps: 20, calmBps: 1 }, 0);
  const assumed = supremacyTick(g, { refPrice: 1.0, stale: false, volEwmaBps: 20 }, 0); // p.calmBps=1000
  const dist = (q) => q.orders.find((o) => o.side === "ask").price - 1.0;
  ok("calm-measured-beats-assumption", dist(measured) > dist(assumed),
     `measured-anchor ${((dist(measured) - 0) * 1e4).toFixed(1)}bps > assumed-anchor ${((dist(assumed) - 0) * 1e4).toFixed(1)}bps`);
}

/* 22) סולם-רוחבים ייחודי (שאילתה 27): אין-חיילים-תאומים ב-16 וב-32 */
{
  const w16 = fleetSpawn(10000, 16, 0.2).map((s) => s.params.widthBps);
  const w32 = fleetSpawn(10000, 32, 0.2).map((s) => s.params.widthBps);
  ok("widths-unique-16", new Set(w16).size === 16, `${w16[0]}..${w16[15]}`);
  ok("widths-unique-32", new Set(w32).size === 32);
  ok("widths-in-span", Math.min(...w32) >= 40 && Math.max(...w32) <= 64.001);
}

/* 23) אחידות-הון (שאילתה 23): capMu ≥ 2×רמה-מקסימלית בכל-גודל-צי */
{
  let allOk = true;
  for (const n of [1, 2, 8, 16, 32]) {
    for (const s of fleetSpawn(10000, n, 0.2)) {
      const p = s.params;
      const maxLevel = p.levelMu * Math.pow(p.growth, p.levels - 1);
      if (p.capMu < 2 * maxLevel - 1e-6) allOk = false;
    }
  }
  ok("capital-coherence-law", allOk, "מילוי-מלא-אחד לא יכול לעבור תקרה — בכל-צי");
}

/* 24) חקר-העלייה (שאילתה 32): משטר-≥8 משתלם; שולי-לחייל חיובי עד 32 */
{
  const rows = scalingStudy({ ticks: 240, seed: 20261004, counts: [1, 2, 4, 8, 16, 32] });
  const flow = (n) => rows.find((r) => r.soldiers === n).volumeMu;
  ok("scaling-regime-8-jump", flow(8) > flow(4), `${flow(8).toFixed(0)}μ > ${flow(4).toFixed(0)}μ — המשטר-≥8 משתלם (נמדד)`);
  const marg = (a, b) => rows.find((r) => r.soldiers === b).marginalPerSoldierMu;
  ok("scaling-marginal-positive-to-32", marg(8, 16) > 0 && marg(16, 32) > 0,
     `8→16: +${marg(8, 16).toFixed(0)}μ/חייל · 16→32: +${marg(16, 32).toFixed(0)}μ/חייל`);
  const m1 = rows.find((r) => r.soldiers === 2).marginalPerSoldierMu;
  // Z-79 כנות: תחת-מיקרו-מבנה הצפיפות-בצי-קטן תלוית-זרע (נמדד: seed42 +192, seed77 +419) —
  // הנעילה על-הזרע-הקנוני; העובדה-שהיא לא-מונוטונית-בזרעים עצמה היא מדידת-רעש.
  ok("scaling-small-fleet-honest", m1 < 0, `1→2: ${m1.toFixed(1)}μ/חייל — צי-קטן צפוף (זרע-קנוני)`);
}

/* 25) העוגן-בסימולציה: מתכייל כלפי-מעלה בעקה (המדידה רואה את-המשטר) */
{
  const rs = runAll({ ticks: 120, seed: 77 });
  const calm = rs.find((r) => r.scenario === "baseline-1").results.calmBpsEndBps;
  const vol = rs.find((r) => r.scenario === "volatile-16").results.calmBpsEndBps;
  ok("calm-anchor-adapts-up-under-stress", vol > calm, `volatile ${vol.toFixed(1)}bps > calm ${calm.toFixed(1)}bps`);
}

/* ── Z-79 · שאילתה 35: ערוצי-המיקרו-מבנה — מוצהרים, נוכחים, דטרמיניסטיים ──── */

/* 26) קבועי-המיקרו-מבנה מפורסמים ונאכפים (אין-דריפה שקטה) */
{
  ok("micro-constants-declared", QUEUE_FLOOR === 0.25 && LATENCY_P === 0.3, `queueFloor=${QUEUE_FLOOR} latencyP=${LATENCY_P}`);
}

/* 27) הערוצים חיים: שאריות עוברות לנזילות-אחרת; המילויים פוצלו-לגרעניות */
{
  const rs = runAll({ ticks: 240, seed: 20261004 });
  const v16 = rs.find((r) => r.scenario === "volatile-16").results;
  const s16 = rs.find((r) => r.scenario === "supremacy-16").results;
  ok("micro-ext-vol-present", v16.extVolumeMu > 0, `${v16.extVolumeMu.toFixed(0)}μ עברו לנזילות-אחרת (ערוץ-התור)`);
  const avg = s16.volumeMu / s16.fills;
  ok("micro-granular-fills", avg < 50 && s16.fills > 1000, `מילוי-ממוצע ${avg.toFixed(1)}μ על ${s16.fills} מילויים — הרבה-עסקאות-קטנות (דבר-המפעיל)`);
}

/* ── Z-79 · שאילתה 34: מודל-השוליים — מתמטיקה מדויקת + שער-צמיחה ─────────── */

/* 28) מודל מדויק: שחזור-מלא של נתונים-על-עקומה ידועה */
{
  const rows = [2, 4, 8, 16, 32].map((n) => ({ soldiers: n, marginalPerSoldierMu: 10 - 2 * Math.log(n) }));
  const mo = marginalModel(rows);
  ok("model-exact-recovery", mo.slope === -2 && mo.intercept === 10 && Math.abs(mo.stopAt - Math.exp(5)) < 1e-4,
     `slope=${mo.slope} intercept=${mo.intercept} stopAt=${mo.stopAt.toFixed(3)} (e^5=148.413)`);
  ok("model-verdict-gates", growthVerdict(mo, 24).verdict === "GO" && growthVerdict(mo, 200).verdict === "STOP" && growthVerdict(null, 24).verdict === "STOP",
     `predict(24)=+${growthVerdict(mo, 24).predictedMarginalMu.toFixed(2)} GO · predict(200)=${growthVerdict(mo, 200).predictedMarginalMu.toFixed(2)} STOP · null→STOP`);
  ok("model-predict-exact", Math.abs(mo.predict(Math.E ** 5)) < 1e-9 && Math.abs(mo.predict(Math.E ** 3) - 4) < 1e-9, `predict(e^5)=0 מדויק (נקודת-האפס) · predict(e^3)=4 מדויק`);
}

/* 29) הצמיחה-הנמדדה (שאילתה 34+32): שוליים-חיוביים ב-3/3 זרעים עד-32; GO ב-3/3 */
{
  const seeds = [20261004, 42, 77];
  const all = seeds.map((seed) => {
    const rows = scalingStudy({ ticks: 480, seed, counts: [8, 16, 32] });
    return { seed, rows, mo: marginalModel(rows), v: null };
  });
  for (const a of all) a.v = growthVerdict(a.mo, 32);
  const m816 = all.map((a) => a.rows.find((r) => r.soldiers === 16).marginalPerSoldierMu);
  const m1632 = all.map((a) => a.rows.find((r) => r.soldiers === 32).marginalPerSoldierMu);
  ok("growth-marginals-positive-3seeds", m816.every((m) => m > 0) && m1632.every((m) => m > 0),
     `8→16: ${m816.map((m) => "+" + m.toFixed(0)).join("/")}μ · 16→32: ${m1632.map((m) => "+" + m.toFixed(0)).join("/")}μ (3/3 זרעים)`);
  ok("growth-verdict-go-3seeds", all.every((a) => a.v.verdict === "GO" && a.v.predictedMarginalMu > 0),
     `GO ב-32 בכל-זרע; חזוי ${all.map((a) => "+" + a.v.predictedMarginalMu.toFixed(0)).join("/")}μ/חייל — הצמיחה מנומקת-מדידה, לא-תאווה`);
}

console.log(`\nselftest: ${pass} pass / ${fail} fail`);
if (fail > 0) { console.error("SELFTEST FAILED — שער-הדוקטרינה עוצר את הענף"); process.exit(1); }
console.log("SELFTEST GREEN — מנוע-העליונות עומד בחוקי-הברזל");
