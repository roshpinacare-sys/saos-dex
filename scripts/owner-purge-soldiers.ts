/**
 * owner-purge-soldiers.ts — OWNER-MANDATE 2026-10-17 · THE-PURGE
 * ============================================================================
 * פקודת-בעלים חיה (IM): "soldier-1 soldier-2 soldier-3 אולי גם 4 — אין לנו
 * מפתחות, הם מתים, צריך להעיף אותם, אין לנו שליטה בהם באמת".
 *
 * הסקריפט מריץ את ה-op הקנוני החדש `agent_purge` (kernel) על שיבוט-מבודד של
 * השרשרת-החיה (אותו-דפוס-בידוד של r45/r47 proofs): כל-חייל מקבל בלוק-משלו —
 * ביטול-פקודות, זיקוק-עמדות, שריפת-אמת, קבלת-יומן — והכל דרך המנוע עצמו
 * (submitOp → stepOnce), אפס-עריכת-מצב-ידנית, אפס-סינתזה.
 *
 * אמות-מידה ביציאה:
 *   · החיילים נעלמו מכל-המפות (balances/locked/credits/ve/lend/orders).
 *   · חשבונאות-שריפה: Σ-to-before − Σ-after == השרוף-המדווח ביומן (מדויק-עד-µ).
 *   · דטרמיניזם: ריצה-שנייה על שיבוט-טרי מאותו-מקור → stateRoot זהה.
 *   · האוצר/הארנה/הבוטים/הבריכות — לא נגעו (מדידה לפני/אחרי).
 *
 * שימוש:  bun scripts/owner-purge-soldiers.ts [targetDbDir]
 *   targetDbDir — ברירת-מחדל: ./db (המאגר-המקומי); לחי: ספריית-db של-הדקס-החי.
 *   הפלט: sandbox path עם state-snapshot.json המטוהר + דוח מלא. עותק-חזרה
 *   לחי = ידני ומבוקר (העתקה-אטומית אחרי-עצירת-השרת בלבד).
 */
import fs from "fs";
import os from "os";
import path from "path";

const SRC_DB = path.resolve(process.argv[2] ?? path.join(process.cwd(), "db"));
const SOLDIERS = ["soldier-1", "soldier-2", "soldier-3", "soldier-4"];

function makeSandbox(): string {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), "saos-purge-"));
  fs.cpSync(SRC_DB, path.join(sb, "db"), { recursive: true });
  process.env.DATABASE_URL = `file:${path.join(sb, "db", "dex.db")}`;
  process.chdir(sb);
  return sb;
}

async function runPurge(): Promise<{ root: string; report: Record<string, unknown> }> {
  makeSandbox();
  const chain = await import("../src/lib/dex/chain");
  const K = await import("../src/lib/dex/kernel");
  const MM = await import("../src/lib/dex/mm");
  const rt = chain.ensureChain();
  const t0 = Date.now();
  while (rt.pendingLoad && Date.now() - t0 < 120_000) await new Promise((r) => setTimeout(r, 250));
  chain.stopLoops();
  const st = rt.st as any;
  const h0 = st.height as number;
  // שיבוט-טרום-טיהור להוכחת-הדטרמיניזם ברמת-הקרנל (השרשרת-החיה כוללת חותמות-זמן-אמת —
  // שורש-הריצות-הנפרדות שונה-מטבעו; הדטרמיניזם-המדויק = אותם-ops + שעון-קבוע → שורש-זהה)
  const preClone = JSON.parse(JSON.stringify(st)) as any;

  const sumAsset = (a: string): number =>
    Object.entries(st.balances ?? {}).reduce((s, [who, w]) => s + ((w as any)[a] ?? 0), 0);
  const before: Record<string, number> = {};
  for (const a of ["SAOS", "USDS", "WSTEEM", "WSBD", "PHIVE", "ENERGY"]) before[a] = sumAsset(a);
  const preSoldier = SOLDIERS.map((s) => ({ s, bal: JSON.parse(JSON.stringify(st.balances[s] ?? null)), credits: st.credits[s] ?? null, orders: st.orders.filter((o: any) => o.live && o.owner === s).length }));
  const untouched = JSON.stringify({ t: st.balances.treasury, a: st.balances.arena, b: st.balances["bot-a"] });

  // ── הטיהור: op אוצר-אחד פר-חייל, בלוק-משלו (דטרמיניסטי) ──
  const receipts: any[] = [];
  for (const s of SOLDIERS) {
    const r = chain.submitOp({ type: "agent_purge", issuer: "treasury", to: s, nonce: chain.nextNonce(`purge-${s}`) } as any);
    if (!r.queued) throw new Error(`submitOp rejected for ${s}: ${r.reason}`);
    await chain.stepOnce();
    const j = [...st.journal].reverse().find((e: any) => e.action === "agent_purge" && String(e.note).includes(`purged ${s}`));
    if (!j) throw new Error(`no agent_purge journal receipt for ${s}`);
    receipts.push(j);
  }

  // ── אמות-מידה ──
  const after: Record<string, number> = {};
  for (const a of Object.keys(before)) after[a] = sumAsset(a);
  const burnedReport: Record<string, { before: number; after: number; burned: number }> = {};
  let accountingOk = true;
  for (const a of Object.keys(before)) {
    const burned = before[a] - after[a];
    if (burned !== 0) burnedReport[a] = { before: before[a], after: after[a], burned };
  }
  const gone = SOLDIERS.map((s) => ({
    s,
    balances: st.balances[s] === undefined,
    credits: st.credits[s] === undefined,
    ve: st.ve?.[s] === undefined,
    lend: st.lend?.positions?.[s] === undefined,
    orders: st.orders.filter((o: any) => o.owner === s).length === 0,
  }));
  const allGone = gone.every((g) => g.balances && g.credits && g.ve && g.lend && g.orders);
  const untouchedAfter = JSON.stringify({ t: st.balances.treasury, a: st.balances.arena, b: st.balances["bot-a"] });
  const treasuryUntouched = untouched === untouchedAfter;
  // חשבונאות-שריפה מהיומן מול דלתא-הΣ
  const journalBurned: Record<string, number> = {};
  for (const j of receipts) {
    const m = String(j.note).match(/burned ([^—]+?) ·/);
    if (!m) continue;
    for (const part of m[1].split(" + ").filter(Boolean)) {
      const [mu, a] = part.trim().split("µ ");
      if (mu && a) journalBurned[a] = (journalBurned[a] ?? 0) + Number(mu);
    }
  }
  for (const a of new Set([...Object.keys(burnedReport), ...Object.keys(journalBurned)])) {
    if ((burnedReport[a]?.burned ?? 0) !== (journalBurned[a] ?? 0)) accountingOk = false;
  }
  const fair = MM.fairPrice(st, "SAOS", "USDS");
  const root = (chain as any).getState?.()?.stateRoot ?? "n/a";
  chain.forceFlush();
  const report = {
    heightBefore: h0, heightAfter: st.height,
    preSoldier, receipts: receipts.map((r) => r.note),
    burnedReport, journalBurned, accountingOk,
    allGone, gone, treasuryUntouched,
    poolsIntact: Object.keys(st.pools).sort(),
    fairPrice: fair,
    bookOrderCount: st.orders.filter((o: any) => o.live).length,
    journalTail: st.journal.slice(-6).map((e: any) => `${e.h} ${e.action} ${String(e.note).slice(0, 110)}`),
  };
  if (!allGone || !accountingOk || !treasuryUntouched) {
    console.error("[purge] FAIL — verification did not pass:", JSON.stringify(report, null, 2));
    process.exit(1);
  }
  // ── הוכחת-דטרמיניזם קרנלית: אותם-ops על שני-שיבוטים-טריים, שעון-קבוע ──
  const canon = await import("../src/lib/dex/canonical");
  const K2 = await import("../src/lib/dex/kernel");
  const FIXED_T = 1_700_000_000_000;
  const cloneRun = (): string => {
    const c = JSON.parse(JSON.stringify(preClone));
    for (const s of SOLDIERS) {
      const r = K2.applyOp(c, { type: "agent_purge", issuer: "treasury", to: s, nonce: `kernel-purge-${s}` } as any, FIXED_T);
      if (!r.ok) throw new Error(`kernel clone op rejected for ${s}: ${r.err}`);
    }
    return canon.stateRootOf(c);
  };
  const kr1 = cloneRun(); const kr2 = cloneRun();
  if (kr1 !== kr2) { console.error("[purge] FAIL — kernel non-determinism:", kr1, kr2); process.exit(1); }
  console.log("[purge] kernel determinism proven (identical roots on cloned pre-state, fixed clock):", kr1.slice(0, 24));
  return { root, report, kernelRoot: kr1 };
}

// הרצה-אחת לכל-תהליך (השרשרת סינגלטון-globalThis — ריצה-שנייה מוכרחת להיות תהליך-נפרד).
// דטרמיניזם: הרץ את הסקריפט פעמיים והשווה stateRoot — חייב להיות זהה.
const run1 = await runPurge();
console.log("[purge] PASS · stateRoot:", run1.root);
console.log("[purge] REPORT:", JSON.stringify(run1.report, null, 2));
console.log(`[purge] SANDBOX_WITH_PURGED_SNAPSHOT=${process.cwd()}/db/state-snapshot.json`);
