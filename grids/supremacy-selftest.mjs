// SUPREMACY-SELFTEST — אינווריאנטות-ברזל של מנוע-העליונות (שער-CI)
// =============================================================================
// כל שורה כאן = חוק שאסור להישבר. ריצה: `node grids/supremacy-selftest.mjs`.
// יציאה לא-אפס = כל-ענף-העליונות נעצר (שער-דוקטרינה, לא עניין-סגנון).
// Z-77: המספרים-המבניים נמדדו וננעלו מהקבלה הדטרמיניסטית (seed 20261004).

import { mulberry32, FEE_BPS } from "./strategies.mjs";
import { supremacyTick, fleetSpawn, feeCompound, captureFees, inventorySkew, updateVolEwma, modulateWidth, fleetCapState } from "./mm-supremacy.mjs";
import { runAll, SCENARIOS } from "./sim/volume-sim.mjs";

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
  ok("volatility-cost-measured", by["volatile-16"].netPnlMu < by["fleet-8"].netPnlMu,
     `volatile ${by["volatile-16"].netPnlMu.toFixed(1)}μ < calm ${by["fleet-8"].netPnlMu.toFixed(1)}μ — adverse-selection נמדד`);
  // Z-77 · A/B מבוקר: אותו-שוק (אותו-זרע, אותן-הגעות), רק-הציטוטים שונים:
  ok("ewma-ab-win", by["volatile-16"].netPnlMu > by["volatile-16-plain"].netPnlMu,
     `${by["volatile-16"].netPnlMu.toFixed(1)}μ > ${by["volatile-16-plain"].netPnlMu.toFixed(1)}μ — פיד-פורוורד חוסך דימום`);
  ok("ewma-ab-magnitude-locked", by["volatile-16"].netPnlMu - by["volatile-16-plain"].netPnlMu >= 20,
     `+${(by["volatile-16"].netPnlMu - by["volatile-16-plain"].netPnlMu).toFixed(1)}μ ≥ 20μ (נעול)`);
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

console.log(`\nselftest: ${pass} pass / ${fail} fail`);
if (fail > 0) { console.error("SELFTEST FAILED — שער-הדוקטרינה עוצר את הענף"); process.exit(1); }
console.log("SELFTEST GREEN — מנוע-העליונות עומד בחוקי-הברזל");
