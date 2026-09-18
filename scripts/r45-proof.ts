/**
 * r45-proof.ts — הוכחת-הריפוי המבודדת לתיקוני R45.
 * ============================================================================
 * רץ על שיבוט-השרשרת-הקנונית (בידוד-מלא — אותו-דפוס של lend-proof.ts), מהמצב-
 * החי-האמיתי (h29308 + בריכת-ENERGY/SAOS של-3,162µ SAOS — הקיפאון-האמיתי):
 *   א. noise-pool-guard: אפס דחיות pool_swap(insufficient) של בוטי-רעש לאורך הריצה.
 *   ב. thin-pool-cure: הרייל יורה מנות-ENERGY אמת (doses>0), הפרמיה נשחקת-כלפי-העוגן.
 *   ג. THE-PEERS: soldier-2/4 מפקידים אספקה-אדפטיבית משלהם בשוק-הכספים.
 *   ד. nonce-height + inflight-escrow: אפס replay-rejected של סוכנים, אפס insufficient-escrow של הזמנות-צי.
 *   ה. שלמות: אין-HALT, אינווריאנטת-ספרי-הלוואות, גובה-מתקדם.
 */
import fs from "fs";
import os from "os";
import path from "path";

/* ── בידוד-מלא: שיבוט-ה-db לסנדבוקס, לפני-כל-ייבוא-של-המנוע ── */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "saos-r45-proof-"));
fs.cpSync(path.join(process.cwd(), "db"), path.join(SANDBOX, "db"), { recursive: true });
process.env.DATABASE_URL = `file:${path.join(SANDBOX, "db", "dex.db")}`;
process.chdir(SANDBOX);

let PASS = 0, FAIL = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { PASS++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`); }
  else { FAIL++; console.error(`  ✗ FAIL: ${label}${detail ? ` — ${detail}` : ""}`); }
}

async function main(): Promise<void> {
  const t0 = Date.now();
  console.log("[proof] sandbox:", SANDBOX);
  const chain = await import("../src/lib/dex/chain");
  const rail = await import("../src/lib/dex/rail");
  const amm = await import("../src/lib/dex/amm");
  const K = await import("../src/lib/dex/kernel");
  const rt = chain.ensureChain();
  const t = Date.now();
  while (rt.pendingLoad && Date.now() - t < 120_000) await new Promise((r) => setTimeout(r, 250));
  chain.stopLoops();
  const st = rt.st as any;
  const h0 = st.height;
  const pool0 = st.pools["ENERGY/SAOS"];
  const rb0 = pool0.rb as number, ra0 = pool0.ra as number;
  const mid0 = amm.poolMidFor(pool0, "ENERGY", "SAOS") as number;
  console.log(`[proof] chain loaded · height ${h0} · ENERGY/SAOS ra=${ra0} rb=${rb0} mid=${mid0}`);

  const ls0 = K.lendState(st);
  const s2Before = ls0.positions["soldier-2"]?.s?.USDS?.mu ?? 0;
  const s4Before = ls0.positions["soldier-4"]?.s?.USDS?.mu ?? 0;
  const railBefore = rail.railSummary();
  console.log(`[proof] before · rail doses=${railBefore.doses} · s2=${s2Before} · s4=${s4Before}`);

  // ── הריצה: 240 טיקים סנכרוניים עם התיקונים ──
  const REJECTIONS_SEEN: string[] = [];
  const TICKS = 240;
  for (let i = 0; i < TICKS; i++) {
    await chain.stepOnce();
    if (rt.rejectedLast && rt.rejectedLast.h === st.height) {
      for (const s of rt.rejectedLast.sample) REJECTIONS_SEEN.push(`h${st.height}:${s}`);
    }
    if (rt.halted) { console.error(`[proof] HALTED: ${rt.haltReason}`); break; }
  }
  const h1 = st.height;
  console.log(`[proof] advanced ${h0} → ${h1} (${TICKS} ticks, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  console.log("\n[proof] ══ א · noise-pool-guard ══");
  const noiseSwapRej = REJECTIONS_SEEN.filter((s) => /pool_swap\(bot-[abc]\):insufficient/.test(s));
  ok(noiseSwapRej.length === 0, `אפס pool_swap(bot):insufficient ב-${TICKS} טיקים`, noiseSwapRej.length ? `נמצאו: ${noiseSwapRej.slice(0, 3).join(", ")}` : REJECTIONS_SEEN.length ? `(${REJECTIONS_SEEN.length} דחיות-אחרות — כנות-מלאה)` : "(אפס-דחיות-כלל)");

  console.log("\n[proof] ══ ב · thin-pool-cure — הרייל-יורה ══");
  const railAfter = rail.railSummary();
  const energyDoses = (railAfter.doseLog as any[]).filter((d) => String(d.pair).includes("ENERGY"));
  ok(railAfter.doses > 0, `מנות-רייל-שבוצעו: ${railAfter.doses} (היו-0 מ-יולדת-השרשרת)`);
  ok(energyDoses.length > 0, `מנות-ENERGY-שנדחפו: ${energyDoses.length} — הקיפאון-נשבר`, energyDoses.slice(0, 3).map((d) => `${d.side} in=${d.inMu}µ prem=${d.premBps}bps ok=${d.ok}`).join(" | "));
  const pool1 = st.pools["ENERGY/SAOS"];
  const mid1 = amm.poolMidFor(pool1, "ENERGY", "SAOS") as number;
  ok(mid1 > mid0, `פרמיית-ENERGY-נשחקת-כלפי-העוגן: mid ${mid0} → ${mid1} (עוגן ~94)`);
  ok((pool1.rb as number) > rb0, `צד-ה-SAOS-של-הבריכה-העמיק: ${rb0} → ${pool1.rb}µ — המנה-הבאה-גדולה-יותר`);
  const railWallet1 = st.balances["rail"] ?? {};
  console.log(`  (רייל-אוחז: ${JSON.stringify(railWallet1)})`);

  console.log("\n[proof] ══ ג · THE-PEERS — ספקי-הצי-חיים ══");
  const ls1 = K.lendState(st);
  const s2After = ls1.positions["soldier-2"]?.s?.USDS?.mu ?? 0;
  const s4After = ls1.positions["soldier-4"]?.s?.USDS?.mu ?? 0;
  ok(s2After > 0, `soldier-2 מספק: ${s2Before} → ${s2After}µ USDS`);
  ok(s4After > 0, `soldier-4 מספק: ${s4Before} → ${s4After}µ USDS`);
  const suppliers = Object.entries(ls1.positions).filter(([who, p]: any) => (p?.s?.USDS?.mu ?? 0) > 0 && who !== "treasury");
  ok(suppliers.length >= 2, `מלווים-עצמאיים-פרט-לאוצר: ${suppliers.map(([w]) => w).join(", ")}`);
  const usdsMkt = ls1.markets["USDS"];
  ok(usdsMkt.sMu > 20_000, `אספקת-USDS-כוללת-העמיקה: ${usdsMkt?.sMu}µ (הייתה-20,000 — אוצר-לבד)`);
  // אינווריאנטת-ספרים: pot = Σקרן+Σרווחים−Σחוב (בכל-נכס-רשום)
  let invOk = true, invDetail = "";
  for (const asset of Object.keys(K.LEND_MARKETS)) {
    const pot = st.balances[K.LEND_POT]?.[asset] ?? 0;
    let expect = 0;
    for (const p of Object.values(ls1.positions) as any[]) expect += (p.s[asset]?.mu ?? 0) + (p.s[asset]?.earned ?? 0);
    for (const b of Object.values(ls1.positions) as any[]) expect -= (b.b[asset]?.mu ?? 0) + (b.b[asset]?.int ?? 0);
    expect -= ls1.markets[asset]?.resMu ?? 0;
    if (pot !== expect) { invOk = false; invDetail += ` ${asset}: pot=${pot}≠${expect}`; }
  }
  ok(invOk, `אינווריאנטת-ספרי-הלוואות בכל-הנכסים${invDetail}`);

  console.log("\n[proof] ══ ד · nonce-height + inflight-escrow ══");
  const replayRej = REJECTIONS_SEEN.filter((s) => /replay-rejected/.test(s));
  ok(replayRej.length === 0, `אפס replay-rejected ב-${TICKS} טיקים`, replayRej.length ? replayRej.slice(0, 3).join(", ") : "(הסוכנים לא-נעלמים-עוד-על-מנעולי-ריצה-קודמת)");
  const escrowRej = REJECTIONS_SEEN.filter((s) => /insufficient-escrow/.test(s));
  ok(escrowRej.length === 0, `אפס insufficient-escrow של הזמנות-צי`, escrowRej.length ? escrowRej.slice(0, 3).join(", ") : "(חשבון-הבטיסה סוגר-את-המירוץ)");
  if (REJECTIONS_SEEN.length) console.log(`  (כל-הדחיות-שנותרו — כנות-שוק: ${[...new Set(REJECTIONS_SEEN.map((s) => s.split(":")[1]))].join(" · ")})`);

  console.log("\n[proof] ══ ה · שלמות-השרשרת ══");
  ok(!rt.halted, `אין-HALT (${rt.haltReason ?? "—"})`);
  ok(h1 - h0 >= TICKS - 1, `הגובה-התקדם: ${h0} → ${h1} (${h1 - h0} בלוקים)`);

  console.log(`\n[proof] ══ תוצאה: ${PASS} עברו · ${FAIL} נכשלו · ${((Date.now() - t0) / 1000).toFixed(1)}s ══`);
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
