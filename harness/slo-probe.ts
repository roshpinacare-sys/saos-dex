/**
 * slo-probe.ts — GOLDEN-PATH SLO MEASUREMENT · מדידת-SLO נתיבי-זהב (Google-SRE)
 * ══════════════════════════════════════════════════════════════════════════════
 * רמת-הענקים: Google-SRE לא מצהירה "המערכת אמינה" — היא מודדת SLO מול יעד,
 * מחשבת תקציב-שגיאה, והחלטות-תפעול נגזרות-מהמדידה. כאן: נתיבי-הזהב של-הריבונות,
 * 30-מדידות-כל-אחד, פרצנטילים אמיתיים:
 *
 *   SLO-A · availability ≥ 99.0%  (יעד-הצמיחה: השערים חייבים-להיות-שם)
 *   SLO-B · p95 ≤ 1,500ms         (dev-servers — יעד-כנה לסביבה-זו)
 *
 * ריצה: bun harness/slo-probe.ts  → audit-package/proof-pack/slo.json
 */
interface PathDef { name: string; url: string; critical: boolean }
interface Sample { ms: number; ok: boolean; status: number }
const N = 30;
const paths: PathDef[] = [
  { name: "mother:health", url: "http://127.0.0.1:3000/api/health", critical: true },
  { name: "engine:state", url: "http://127.0.0.1:3010/saos-dex/api/dex/state", critical: true },
  { name: "engine:reserve", url: "http://127.0.0.1:3010/saos-dex/api/dex/reserve", critical: true },
  { name: "mother:value-engine(GET)", url: "http://127.0.0.1:3000/api/saos/value-engine", critical: false },
  { name: "mother:saos-status", url: "http://127.0.0.1:3000/api/saos/status", critical: false },
];

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return -1;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function main(): Promise<void> {
  console.log(`\n════ GOLDEN-PATH SLO · ${N}×${paths.length} measurements ════`);
  const report: { name: string; critical: boolean; n: number; ok: number; availability: number; p50: number; p95: number; p99: number; max: number }[] = [];
  for (const p of paths) {
    const samples: Sample[] = [];
    for (let i = 0; i < N; i++) {
      const t = performance.now();
      try {
        const r = await fetch(p.url, { signal: AbortSignal.timeout(10_000) });
        const ms = performance.now() - t;
        let ok = r.status >= 200 && r.status < 400;
        if (ok) { try { const j = await r.json() as { ok?: boolean }; ok = j.ok !== false; } catch { /* non-json 2xx counts ok */ } }
        samples.push({ ms, ok, status: r.status });
      } catch {
        samples.push({ ms: performance.now() - t, ok: false, status: 0 });
      }
      await new Promise((r) => setTimeout(r, 60));
    }
    const lat = samples.map((s) => s.ms).sort((a, b) => a - b);
    const okCount = samples.filter((s) => s.ok).length;
    const row = {
      name: p.name, critical: p.critical, n: samples.length, ok: okCount,
      availability: Math.round((okCount / samples.length) * 10_000) / 100,
      p50: Math.round(pct(lat, 50)), p95: Math.round(pct(lat, 95)), p99: Math.round(pct(lat, 99)),
      max: Math.round(lat[lat.length - 1]),
    };
    report.push(row);
    console.log(`  ${p.name.padEnd(26)} avail=${row.availability.toFixed(2).padStart(6)}%  p50=${row.p50}ms p95=${row.p95}ms p99=${row.p99}ms max=${row.max}ms`);
  }
  // SLO-דין
  const critical = report.filter((r) => r.critical);
  const availWorst = Math.min(...critical.map((r) => r.availability));
  const p95Worst = Math.max(...report.map((r) => r.p95));
  const sloA = availWorst >= 99.0;
  const sloB = p95Worst <= 1_500;
  // תקציב-שגיאה: 1% לנתיב-קריטי
  const errorBudgetUsed = Math.max(0, 100 - availWorst);
  const verdict = sloA && sloB ? "PASS" : "FAIL";
  console.log(`\n── SLO VERDICT: ${verdict} ──`);
  console.log(`  SLO-A availability (critical paths): worst=${availWorst.toFixed(2)}% ≥ 99.0% → ${sloA ? "PASS" : "FAIL"} · error-budget used ${errorBudgetUsed.toFixed(2)}% of 1%`);
  console.log(`  SLO-B latency p95 (all paths):       worst=${p95Worst}ms ≤ 1500ms → ${sloB ? "PASS" : "FAIL"}`);
  await Bun.write("audit-package/proof-pack/slo.json", JSON.stringify({
    instrument: "slo-probe", at: new Date().toISOString(), n: N,
    sloA: { target: "availability ≥ 99%", worst: availWorst, pass: sloA, errorBudgetUsedPct: errorBudgetUsed },
    sloB: { target: "p95 ≤ 1500ms", worst: p95Worst, pass: sloB },
    paths: report, verdict,
  }, null, 2));
  console.log("artifact → audit-package/proof-pack/slo.json");
  if (verdict !== "PASS") process.exit(1);
}

await main();
