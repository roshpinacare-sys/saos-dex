/**
 * door-money-market.ts — R44 · THE-MARKET: הלידה של שוק-הכספים על השרשרת-הקנונית
 * =============================================================================
 * הפעם הראשונה שהרשת שלנו מרוויחה ריבית מעצמה — בלי-הטבעה, בלי-תיאטרון:
 *
 *   1. האוצר מפקיד 20,000µ USDS לבריכת-האשראי (היעד-האדפטיבי: 3× ביקוש-חי)
 *   2. soldier-1 מפקיד בטחונות-WSTEEM מיתרתו-האמיתית-הפנויה
 *   3. soldier-1 שואל USDS ב-40% מערך-הבטחונות (HF ≈ 1.65) — השאילה-הראשונה-בהיסטוריה
 *   4. המחזור נסגר: פירעון-מלא (ריבית → 90% מלווים + 10% אוצר) + שחרור-בטחונות
 *   5. העמדות-העומדות של הסוכנים נשארות-חיות: האוצר ממשיך-להזרים אדפטיבית,
 *      soldier-1/3 במחזורי-אשראי מתמשכים — דבר-גורר-דבר, לנצח, בלי-יד-אנוש
 *
 * כנות-מלאה: הכל-העברות-טהורות. הריבית נגבית-רק-מלווים-שמשלמים-בפועל.
 * הוכחה-מוקדמת: scripts/lend-proof.ts — 45/45 (יחידת-קרנל + שרשרת-חיה-על-שיבוט).
 *
 * הרצה: bun run door-money-market.ts   (מושך-קודם — השרשרת-הקנונית היא-האמת)
 */
import path from "path";

/* ── סביבה לפני-כל-ייבוא-של-המנוע (אותו-דפוס-הגנה של cloud-beat) ── */
process.env.DATABASE_URL = `file:${path.join(process.cwd(), "db", "dex.db")}`;
process.env.SAOS_DEX_STATE_DIR = path.join(process.cwd(), "db");

interface Receipt { [k: string]: unknown }

async function main(): Promise<void> {
  const t0 = Date.now();
  console.log("[market-door] boot · R44 THE-MARKET — first sovereign money-market cycle");

  const chain = await import("./src/lib/dex/chain");
  const rt = chain.ensureChain();
  const waitLoad = async () => {
    const t = Date.now();
    while (rt.pendingLoad && Date.now() - t < 90_000) await new Promise((r) => setTimeout(r, 300));
  };
  await waitLoad();
  if (rt.halted) {
    console.error(`[market-door] chain HALTED — refusing. reason: ${rt.haltReason ?? "?"}`);
    process.exit(1);
  }
  chain.stopLoops();
  const { submitOp, nextNonce } = chain as unknown as {
    submitOp: (op: Record<string, unknown>) => { queued: boolean; reason?: string };
    nextNonce: (p: string) => string;
  };
  const K = await import("./src/lib/dex/kernel");
  const st = rt.st as unknown as {
    height: number;
    balances: Record<string, Record<string, number>>;
    locked: Record<string, Record<string, number>>;
    lend?: any;
    journal: { h: number; t: number; soldier: string; action: string; note?: string }[];
    assets: Record<string, { refPrice: number }>;
  };
  const h0 = st.height;
  const before = {
    treasuryUsds: st.balances.treasury?.USDS ?? 0,
    pot: st.balances["lend-pot"]?.USDS ?? 0,
  };
  console.log(`[market-door] chain loaded · h${h0} · treasury USDS ${before.treasuryUsds}µ · lend-pot ${before.pot}µ`);

  /* ── 1) האוצר פותח את השוק: 20,000µ — יעד-הסוכן האדפטיבי ── */
  const TR_SUPPLY = 20_000;
  let r = submitOp({ type: "lend_supply", issuer: "treasury", nonce: nextNonce("r44-t1"), asset: "USDS", amount: TR_SUPPLY });
  if (!r.queued) { console.error("[market-door] treasury supply REJECTED:", r.reason); process.exit(4); }
  await chain.stepOnce();
  if (st.lend?.markets?.USDS?.sMu !== TR_SUPPLY) { console.error("[market-door] treasury supply not applied"); process.exit(4); }
  console.log(`[market-door] h${st.height} · treasury supplied ${TR_SUPPLY}µ USDS · pool ${st.lend.markets.USDS.sMu}µ`);

  /* ── 2) הלווה בטחונות-אמת מהיתרה-הפנויה-בלבד ──
     OWNER-MANDATE 2026-10-17: היה soldier-1 — החיילים-הסינתטיים סולקו (אין-מפתחות, אין-שליטה);
     הארנה: מחזיקת-ה-WSTEEM-האמתי במצב-החי. */
  const S1 = "arena";
  const s1Free = (st.balances[S1]?.WSTEEM ?? 0) - (st.locked?.[S1]?.WSTEEM ?? 0);
  const S1_COL = Math.min(60_000, Math.floor(s1Free * 0.9));
  if (S1_COL < 20_000) { console.error(`[market-door] soldier-1 free WSTEEM too low (${s1Free}µ) — refusing`); process.exit(4); }
  r = submitOp({ type: "lend_supply", issuer: S1, nonce: nextNonce("r44-s1c"), asset: "WSTEEM", amount: S1_COL });
  if (!r.queued) { console.error("[market-door] soldier-1 collateral REJECTED:", r.reason); process.exit(4); }
  await chain.stepOnce();
  console.log(`[market-door] h${st.height} · ${S1} supplied ${S1_COL}µ WSTEEM collateral (free was ${s1Free}µ)`);

  /* ── 3) השאילה-הראשונה-בהיסטוריה: 40% מערך-הבטחונות ── */
  const colVal = Math.floor((S1_COL * (st.assets.WSTEEM?.refPrice ?? 56)) / 1000);
  const DRAW = Math.floor((colVal * 4000) / 10_000);
  r = submitOp({ type: "lend_borrow", issuer: S1, nonce: nextNonce("r44-s1b"), asset: "USDS", amount: DRAW });
  if (!r.queued) { console.error("[market-door] borrow REJECTED:", r.reason); process.exit(4); }
  await chain.stepOnce();
  const lsAfter = st.lend;
  const bPos = lsAfter?.positions?.[S1]?.b?.USDS;
  if (!bPos || bPos.mu !== DRAW) { console.error(`[market-door] borrow not applied: ${JSON.stringify(bPos)}`); process.exit(4); }
  const hfOpen = (K as any).lendHealthFactor(st, S1);
  console.log(`[market-door] h${st.height} · ${S1} borrowed ${DRAW}µ USDS (FIRST BORROW EVER) · HF ${(hfOpen / 100).toFixed(2)} · util ${((K as any).lendUtilBps(lsAfter.markets.USDS) / 100).toFixed(2)}% · APR ${((K as any).lendBorrowAprBps(lsAfter.markets.USDS) / 100).toFixed(2)}%`);

  /* ── 4) סגירת-המחזור-הראשון: פירעון + שחרור (הריבית באמת-הכנה של הסקאלה) ── */
  const debtAtClose = (K as any).lendDebtNow(bPos, (K as any).lendBorrowAprBps(lsAfter.markets.USDS), st.height);
  const interest = debtAtClose - DRAW; // µ-בודדים או אפס — האמת-של-דקות-ספורות-ב-~1.5% APR
  r = submitOp({ type: "lend_repay", issuer: S1, nonce: nextNonce("r44-s1r"), asset: "USDS", amount: -1 });
  if (!r.queued) { console.error("[market-door] repay REJECTED:", r.reason); process.exit(4); }
  await chain.stepOnce();
  r = submitOp({ type: "lend_withdraw", issuer: S1, nonce: nextNonce("r44-s1w"), asset: "WSTEEM", amount: -1 });
  if (!r.queued) { console.error("[market-door] withdraw REJECTED:", r.reason); process.exit(4); }
  await chain.stepOnce();
  const lsClosed = st.lend;
  if (lsClosed?.positions?.[S1]) { console.error("[market-door] soldier-1 position not closed"); process.exit(4); }
  console.log(`[market-door] h${st.height} · cycle-1 closed: repaid ${debtAtClose}µ (interest ${interest}µ → 90% suppliers + 10% treasury) · collateral released`);

  /* ── 5) העמדות-העומדות: מחזור-שני שנשאר-חי (הסוכנים ימשיכו-מכאן-לבד) ── */
  r = submitOp({ type: "lend_supply", issuer: S1, nonce: nextNonce("r44-s1c2"), asset: "WSTEEM", amount: S1_COL });
  if (!r.queued) { console.error("[market-door] cycle-2 collateral REJECTED:", r.reason); process.exit(4); }
  await chain.stepOnce();
  r = submitOp({ type: "lend_borrow", issuer: S1, nonce: nextNonce("r44-s1b2"), asset: "USDS", amount: DRAW });
  if (!r.queued) { console.error("[market-door] cycle-2 borrow REJECTED:", r.reason); process.exit(4); }
  await chain.stepOnce();
  const lsStanding = st.lend;
  const standing = lsStanding?.positions?.[S1]?.b?.USDS;
  if (!standing || standing.mu !== DRAW) { console.error("[market-door] standing position not open"); process.exit(4); }
  console.log(`[market-door] h${st.height} · STANDING position open: ${S1} owes ${standing.mu}µ · treasury ${lsStanding.positions.treasury?.s?.USDS?.mu ?? 0}µ supplied · agents continue from here autonomously`);

  /* ── קבלה ── */
  const myJournal = st.journal.filter((j) => String(j.action).startsWith("lend_")).map((j) => ({ h: j.h, who: j.soldier, action: j.action, note: j.note?.slice(0, 140) }));
  const invCheck = Object.fromEntries(Object.keys((K as any).LEND_MARKETS).map((asset: string) => {
    let expect = 0;
    for (const p of Object.values(st.lend?.positions ?? {}) as any[]) expect += (p.s[asset]?.mu ?? 0) + (p.s[asset]?.earned ?? 0) - (p.b[asset]?.mu ?? 0);
    return [asset, { pot: st.balances["lend-pot"]?.[asset] ?? 0, expect, ok: (st.balances["lend-pot"]?.[asset] ?? 0) === expect }];
  }));
  const receipt: Receipt = {
    ok: true,
    door: "R44-money-market-first-cycle",
    at: new Date().toISOString(),
    heightStart: h0,
    heightEnd: st.height,
    cycle: {
      treasurySupplyMu: TR_SUPPLY,
      soldier1CollateralMu: S1_COL,
      firstBorrowMu: DRAW,
      hfAtOpen: hfOpen / 100,
      interestPaidMu: interest,
      utilizationBps: (K as any).lendUtilBps(lsStanding.markets.USDS),
      borrowAprBps: (K as any).lendBorrowAprBps(lsStanding.markets.USDS),
      supplyAprBps: (K as any).lendSupplyAprBps(lsStanding.markets.USDS),
      standingDebtMu: standing.mu,
    },
    invariant: invCheck,
    journal: myJournal,
    evidence: {
      proof: "scripts/lend-proof.ts — 45/45 (kink curve · 90/10 split · pro-rata · liquidation · conservation)",
      world: "world.json → state.lend (markets/positions/totals/treasury/invariant)",
    },
  };
  console.log("\n[market-door] ═══ RECEIPT ═══");
  console.log(JSON.stringify({ ...receipt, journal: `${myJournal.length} entries` }, null, 2));
  require("fs").writeFileSync("/home/z/r44-door-receipt.json", JSON.stringify(receipt, null, 2));

  chain.forceFlush();
  console.log(`\n[market-door] db flushed · h${h0}→${st.height} · ${(Date.now() - t0) / 1000 | 0}s`);
  console.log("[market-door] next: commit db + push, then cloud-beat publishes to Console");
  process.exit(0);
}

main().catch((e) => {
  console.error("[market-door] FATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
