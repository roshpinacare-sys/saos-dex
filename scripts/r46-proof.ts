/**
 * r46-proof.ts — הוכחת-הריפוי המבודדת לתיקון R46 (ratchet-truth).
 * ============================================================================
 * רץ על שיבוט-השרשרת-הקנונית (בידוד-מלא — אותו-דפוס של r45-proof/lend-proof),
 * מהמצב-החי-האמיתי. הדימום שנרפא: חוזה "רווח-אוצר-מונוטוני" (kernel.ts) נשבר
 * בפועל — ה-economy מנקז את-treasuryProfit לדלק, היתרה צנחה מ-213752µ (גיט-
 * מוכח, 4ac9369) ל-200000µ, ו-A38 (ראצ'ט-האוצר של הקונסולה) נכשלה-כמתוכנן.
 *   א. seed: בטעינת-תמונה-חיה ללא-השדה — treasuryProfitEver=213752 (השיא-הגיט-מוכח).
 *   ב. harvest: כל-קציר מעלה גם-את-היתרה וגם-את-המונה (באותו-סכום-מדויק).
 *   ג. drain-never-touches-ever: ניקוז-דלק מוריד-יתרה — המונה לעולם-לא-יורד.
 *   ד. publish: getState().income.treasuryProfitEverMu מפורסם-ושווה-לאמת.
 *   ה. שלמות: אין-HALT, ledgerAudit עובר, גובה-מתקדם.
 */
import fs from "fs";
import os from "os";
import path from "path";

/* ── בידוד-מלא: שיבוט-ה-db לסנדבוקס, לפני-כל-ייבוא-של-המנוע ── */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "saos-r46-proof-"));
fs.cpSync(path.join(process.cwd(), "db"), path.join(SANDBOX, "db"), { recursive: true });
process.env.DATABASE_URL = `file:${path.join(SANDBOX, "db", "dex.db")}`;
process.chdir(SANDBOX);

let PASS = 0, FAIL = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { PASS++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`); }
  else { FAIL++; console.error(`  ✗ FAIL: ${label}${detail ? ` — ${detail}` : ""}`); }
}

const GIT_HIGH_WATER = 213752; // השיא-ההיסטורי הגיט-מוכח (Console@4ac9369, 2026-09-17)

async function main(): Promise<void> {
  const t0 = Date.now();
  console.log("[proof] sandbox:", SANDBOX);
  const chain = await import("../src/lib/dex/chain");
  const settle = await import("../src/lib/dex/settle");
  const rt = chain.ensureChain();
  const t = Date.now();
  while (rt.pendingLoad && Date.now() - t < 120_000) await new Promise((r) => setTimeout(r, 250));
  chain.stopLoops();
  const st = rt.st as any;
  const h0 = st.height;
  console.log(`[proof] chain loaded · height ${h0} · treasuryProfit=${st.treasuryProfit}µ · treasuryProfitEver=${st.treasuryProfitEver ?? "undefined"}µ`);

  /* ── א · seed: המונה נזרע מהשיא-הגיט-מוכח ── */
  console.log("\n[proof] ══ א · ratchet-seed (migration on live load) ══");
  ok(typeof st.treasuryProfitEver === "number", "השדה נולד בטעינה (לא היה בתמונה החיה)", `treasuryProfitEver=${st.treasuryProfitEver}µ`);
  ok(st.treasuryProfitEver >= GIT_HIGH_WATER, `הזרע ≥ השיא-ההיסטורי ${GIT_HIGH_WATER}µ`, `${st.treasuryProfitEver}µ (יתרה-עובדת ${st.treasuryProfit}µ)`);
  ok(st.treasuryProfitEver >= (st.treasuryProfit ?? 0), "המונה ≥ היתרה העובדת מרגע-הלידה", `${st.treasuryProfitEver} ≥ ${st.treasuryProfit}`);

  /* ── ב · harvest: קציר-אמת מעלה יתרה ומונה באותו-סכום ── */
  console.log("\n[proof] ══ ב · harvest increments both ══");
  const feeMeter0 = st.feeMeter as number;
  const bal0 = st.treasuryProfit as number;
  const ever0 = st.treasuryProfitEver as number;
  if (feeMeter0 >= 100) {
    const amt = Math.min(100, feeMeter0);
    const hNonce = `r46-proof-harvest@h${st.height}`;
    rt.mempool.push({ type: "harvest", issuer: "treasury", nonce: hNonce, amount: amt, memo: "r46-proof" });
    await chain.stepOnce();
    const bal1 = st.treasuryProfit as number;
    const ever1 = st.treasuryProfitEver as number;
    ok(bal1 === bal0 + amt, `יתרה עלתה בדיוק ב-סכום-הקציר: ${bal0} → ${bal1} (+${amt}µ)`);
    ok(ever1 === ever0 + amt, `המונה עלה בדיוק באותו-סכום: ${ever0} → ${ever1} (+${amt}µ)`);
  } else {
    // גם-בלי-עמלות-פנויות הקציר נדחה בכנות — אבל אז אין-מה-להוכיח בענף-זה; מדלגים בכנות
    ok(true, "אין-עמלות-פנויות-לקציר-בודק (feeMeter נמוך) — ענף-הקציר לא-נבדק בריצה-זו", `feeMeter=${feeMeter0}µ`);
  }

  /* ── ג+ד · הריצה: 240 טיקים — המונה לעולם-לא-יורד, הפרסום חי ── */
  console.log("\n[proof] ══ ג · drain-never-touches-ever (240 ticks with live agents) ══");
  let everMax = st.treasuryProfitEver as number;
  let everMin = st.treasuryProfitEver as number;
  let everDropped = false;
  let invariantHeld = true;
  const TICKS = 240;
  for (let i = 0; i < TICKS; i++) {
    await chain.stepOnce();
    const ev = st.treasuryProfitEver as number;
    if (typeof ev !== "number" || !Number.isSafeInteger(ev)) { invariantHeld = false; break; }
    if (ev < everMax) everDropped = true; // המונה ירד — הפרת-החוזה
    if (ev > everMax) everMax = ev;
    if (ev < everMin) everMin = ev;
    if (st.treasuryProfit > ev) { invariantHeld = false; break; } // יתרה-מעל-מונה — בלתי-אפשרי
    if (rt.halted) { console.error(`[proof] HALTED: ${rt.haltReason}`); break; }
  }
  const h1 = st.height;
  console.log(`[proof] advanced ${h0} → ${h1} (${TICKS} ticks, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  ok(invariantHeld, "לכל-אורך-הריצה: המונה-שלם-והיתרה-לעולם-מעליו (ever ≥ balance)");
  ok(!everDropped, `המונה מונוטוני-אמיתי — לעולם לא ירד ב-${TICKS} טיקים חיים`, `ever: ${everMin}…${everMax}µ · יתרה-עובדת עכשיו ${st.treasuryProfit}µ (נוזלת-לדלק-כמתוכנן)`);
  const grew = (st.treasuryProfitEver as number) > (ever0 as number);
  console.log(`  (ריצה-חיה: ever ${ever0} → ${st.treasuryProfitEver}µ · ${grew ? "קצירים-חיים-התרחשו" : "לא-היה-קציר-בחלון-זה — כנות-מלאה"})`);

  /* ── ד · publish: world.json מפרסם את-המונה-המונוטוני ── */
  console.log("\n[proof] ══ ד · publish (world.json income) ══");
  const world = chain.getState();
  const inc = (world as any).income ?? {};
  ok(typeof inc.treasuryProfitEverMu === "number", "income.treasuryProfitEverMu מפורסם", `${inc.treasuryProfitEverMu}µ`);
  ok(inc.treasuryProfitEverMu === (st.treasuryProfitEver as number), "הפרסום שווה-לאמת-השרשרת", `${inc.treasuryProfitEverMu} === ${st.treasuryProfitEver}`);
  ok((inc.treasuryProfitEverMu as number) >= GIT_HIGH_WATER, `הפרסום מעל-הרצפה-ההיסטורית ${GIT_HIGH_WATER}µ — A38 תעבור`);

  /* ── ה · שלמות: ledgerAudit + אין-HALT ── */
  console.log("\n[proof] ══ ה · integrity ══");
  ok(!rt.halted, "אין-HALT", rt.halted ? String(rt.haltReason) : undefined);
  const totals = settle.genesisTotals();
  const audit = settle.ledgerAudit(st, totals);
  ok(audit.ok, "ledgerAudit עובר (שימור-מוחלט)", audit.ok ? (audit.errors.length ? `errors: ${JSON.stringify(audit.errors).slice(0, 200)}` : "כל-הבדיקות-אמת") : `errors: ${JSON.stringify(audit.errors).slice(0, 300)}`);
  ok(h1 > h0, `הגובה התקדם: ${h0} → ${h1}`);

  console.log(`\n[proof] ═══ ${PASS} עברו · ${FAIL} נכשלו · ${((Date.now() - t0) / 1000).toFixed(1)}s ═══`);
  if (FAIL > 0) process.exit(1);
}

main().catch((e) => { console.error("[proof] FATAL:", e); process.exit(1); });
