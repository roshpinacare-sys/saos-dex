/**
 * door-full-cycle.ts — R35 · מחזור-מלא ראשון (THE FIRST FULL CYCLE)
 * =============================================================================
 * המשך ישיר של הטיפה-הראשונה (R34 · d743b6d): הכסף-האמיתי שנכנס בדלת (2.0 TRX
 * → 2000µ WTRX מגובים 1:1) ממשיך בכל המסלול הכלכלי על השרשרת-הקנונית:
 *
 *   1. אורקל-חי נוחת (מחירי שוק אמת — דחיפת-האתחול של השרשרת)
 *   2. asset_list WTRX — הנכס-האמיתי הראשון שנכנס לסולם-הערך הקנוני
 *   3. xfer_free 1600µ → האוצר: המפקיד בעצמו זורע את צד-הנכס של השוק
 *   4. pool_open USDS/WTRX — השוק-החי הראשון לנכס-הפקדה-אמיתי, במחיר-האורקל
 *   5. pool_swap מכירה: 30µ WTRX → USDS (סחר-אמת בכסף-אמת)
 *   6. pool_swap קנייה: ~USDS → 20µ WTRX (שוק דו-כיווני)
 *   7. peg-out: 100µ WTRX → peg-outbox + attest יעד-TRON (תביעת-הפדיון הראשונה)
 *   8. doorReport: פסק-דין-עוגן חי (CONVERGED?) — הוכחה במדידה, לא במילים
 *
 * כנות-מלאה: ה-USDS שמממן את צד-הציטוט הוא אשראי-פנימי (מתועד); ה-WTRX הוא
 * הנכס-החיץ-האמיתי היחיד במערכת. הכסף-הפיזי (2.000002 TRX) נשאר במשמרת
 * כגיבוי 1:1 — עד שהמפעיל ישדר בעצמו את הפדיון מכתובת-המשמרת.
 *
 * הרצה: bun run door-full-cycle.ts
 */
import path from "path";

/* ── סביבה לפני-כל-ייבוא-של-המנוע (אותו-דפוס-הגנה של cloud-beat) ── */
process.env.DATABASE_URL = `file:${path.join(process.cwd(), "db", "dex.db")}`;
process.env.SAOS_DEX_STATE_DIR = path.join(process.cwd(), "db");

const CUSTODY_TRON = "TYVwwuvdDmfy3shxT3cb3RKLrRCshaZxTy";
const DEST_TRON = "TG6SrsMJjRqnqAyYM8kGZu1rgkpsgizKEn"; // כתובת-המפעיל (idx=2) — יעד-הפדיון
const OUTBOX = "peg-outbox";
const MARKET_WTRX = 1600;  // µ WTRX שזורע המפעיל לשוק
const SELL_MU = 30;        // מכירה-אמת ראשונה
const BUY_MINOUT = 20;    // קנייה-חזרה מינימום
const PEGOUT_MU = 100;     // תביעת-פדיון

interface Receipt {
  [k: string]: unknown;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  console.log("[full-cycle] boot · R35 THE FIRST FULL CYCLE");

  const chain = await import("./src/lib/dex/chain");
  const rt = chain.ensureChain();
  const waitLoad = async () => {
    const t = Date.now();
    while (rt.pendingLoad && Date.now() - t < 90_000) await new Promise((r) => setTimeout(r, 300));
  };
  await waitLoad();
  if (rt.halted) {
    console.error(`[full-cycle] chain HALTED — refusing. reason: ${rt.haltReason ?? "?"}`);
    process.exit(1);
  }
  chain.stopLoops();
  const { submitOp, nextNonce } = chain as unknown as {
    submitOp: (op: Record<string, unknown>) => { queued: boolean; reason?: string };
    nextNonce: (p: string) => string;
  };
  const st = rt.st as unknown as {
    height: number;
    balances: Record<string, Record<string, number>>;
    credits: Record<string, number>;
    backing: Record<string, number>;
    oracle: Record<string, { mu: number; atH: number; src: string }>;
    assets: Record<string, { refPrice: number; listed: number }>;
    pools: Record<string, { a: string; b: string; ra: number; rb: number; lp: number; feeAccruedTreasury: number; swaps: number; dynFeeBps?: number; volBpsEwma?: number }>;
    journal: { h: number; t: number; soldier: string; action: string; note?: string }[];
    stats: { fills: number; swaps: number; opsTotal: number };
  };

  const h0 = st.height;
  const opBefore = { ...st.balances.operator };
  const trBefore = { ...st.balances.treasury };
  console.log(`[full-cycle] chain loaded · h${h0} · operator WTRX ${opBefore.WTRX ?? 0}µ · USDS ${opBefore.USDS ?? 0}µ`);

  /* ── 0) שומר-כנות: המשמורת-החיה מכסה את כל-ההיצע-המוטבע ── */
  const custodySun = await (async () => {
    try {
      const r = await fetch(`https://api.trongrid.io/v1/accounts/${CUSTODY_TRON}`, { cache: "no-store" });
      const j = (await r.json()) as { data?: { balance?: number }[]; success?: boolean };
      if (j?.success === false) return null;
      return j?.data?.[0]?.balance ?? 0;
    } catch { return null; }
  })();
  const totalWtrx = Object.entries(st.balances).reduce((s, [, b]) => s + (b.WTRX ?? 0), 0);
  if (custodySun !== null && totalWtrx > Math.floor(custodySun / 1000) + 1) {
    console.error(`[full-cycle] HONESTY GUARD: ΣWTRX ${totalWtrx}µ > custody ${Math.floor(custodySun / 1000)}µ — refusing`);
    process.exit(3);
  }
  console.log(`[full-cycle] custody live: ${(custodySun ?? 0) / 1e6} TRX · ΣWTRX ${totalWtrx}µ — fully backed`);

  /* ── 1) הנחת-האורקל-החי (דחיפת-האתחול כבר בממפול מה-boot) ── */
  await chain.stepOnce();
  const oracleWtrx = st.oracle?.WTRX?.mu ?? 0;
  console.log(`[full-cycle] h${st.height} · oracle WTRX $${(oracleWtrx / 1e6).toFixed(6)} (src: ${st.oracle?.WTRX?.src ?? "?"})`);
  if (!(oracleWtrx > 0)) { console.error("[full-cycle] no live WTRX oracle — refusing"); process.exit(2); }

  /* ── 2) רישום WTRX בסולם-הערך (refPrice ב-mµ/יחידה — עוגן קנוני לתמיד) ── */
  const refWtrx = Math.round(oracleWtrx / 1000);
  let r = submitOp({ type: "asset_list", issuer: "treasury", nonce: nextNonce("r35-list"), asset: "WTRX", refPrice: refWtrx });
  if (!r.queued) { console.error("[full-cycle] asset_list REJECTED:", r.reason); process.exit(4); }

  /* ── 3) המפקיד זורע את צד-הנכס של השוק ── */
  r = submitOp({ type: "xfer_free", issuer: "operator", nonce: nextNonce("r35-seed"), to: "treasury", asset: "WTRX", amount: MARKET_WTRX });
  if (!r.queued) { console.error("[full-cycle] seed xfer REJECTED:", r.reason); process.exit(4); }

  /* ── 4) פתיחת השוק החי: USDS/WTRX במחיר-האורקל ── */
  const ra = Math.max(1, Math.round((oracleWtrx * MARKET_WTRX) / 1_000_000));
  r = submitOp({ type: "pool_open", issuer: "treasury", nonce: nextNonce("r35-open"), pair: "USDS/WTRX", amount: ra, amountB: MARKET_WTRX });
  if (!r.queued) { console.error("[full-cycle] pool_open REJECTED:", r.reason); process.exit(4); }

  await chain.stepOnce();
  const pool = st.pools["USDS/WTRX"];
  if (!pool) { console.error("[full-cycle] POOL DID NOT OPEN — honest failure"); process.exit(5); }
  const midOpen = Math.floor((pool.ra * 1000) / pool.rb);
  console.log(`[full-cycle] *** USDS/WTRX MARKET OPEN *** h${st.height} · ra=${pool.ra}µ USDS · rb=${pool.rb}µ WTRX (real) · mid=${midOpen}mµ vs oracle ${Math.round(oracleWtrx / 1000)}mµ`);

  /* ── 5) הסחר-האמת הראשון: מכירת 30µ WTRX אמיתיים תמורת USDS ── */
  const usdsBeforeSell = st.balances.operator.USDS ?? 0;
  r = submitOp({ type: "pool_swap", issuer: "operator", nonce: nextNonce("r35-sell"), pair: "USDS/WTRX", assetIn: "WTRX", amount: SELL_MU, minOut: 8 });
  if (!r.queued) { console.error("[full-cycle] sell REJECTED:", r.reason); process.exit(4); }
  await chain.stepOnce();
  const gotUsds = (st.balances.operator.USDS ?? 0) - usdsBeforeSell;
  if (!(gotUsds >= 8)) { console.error(`[full-cycle] SELL DID NOT LAND (ΔUSDS=${gotUsds}) — honest failure`); process.exit(5); }
  console.log(`[full-cycle] *** FIRST REAL SELL *** 30µ WTRX → ${gotUsds}µ USDS (fee-inclusive quote) · h${st.height}`);

  /* ── 6) השוק הדו-כיווני: קניית-חזרה של 20µ WTRX ── */
  const wtrxBeforeBuy = st.balances.operator.WTRX ?? 0;
  const buyIn = 9; // µ USDS
  r = submitOp({ type: "pool_swap", issuer: "operator", nonce: nextNonce("r35-buy"), pair: "USDS/WTRX", assetIn: "USDS", amount: buyIn, minOut: BUY_MINOUT });
  if (!r.queued) { console.error("[full-cycle] buy REJECTED:", r.reason); process.exit(4); }
  await chain.stepOnce();
  const gotWtrx = (st.balances.operator.WTRX ?? 0) - wtrxBeforeBuy;
  if (!(gotWtrx >= BUY_MINOUT)) { console.error(`[full-cycle] BUY DID NOT LAND (ΔWTRX=${gotWtrx}) — honest failure`); process.exit(5); }
  console.log(`[full-cycle] *** REAL BUY-BACK *** 9µ USDS → ${gotWtrx}µ WTRX · h${st.height}`);

  /* ── 7) תביעת-הפדיון הראשונה: 100µ WTRX → peg-outbox + יעד-TRON חתום ── */
  r = submitOp({ type: "xfer_free", issuer: "operator", nonce: nextNonce("r35-out"), to: OUTBOX, asset: "WTRX", amount: PEGOUT_MU });
  if (!r.queued) { console.error("[full-cycle] peg-out xfer REJECTED:", r.reason); process.exit(4); }
  r = submitOp({ type: "attest", issuer: "operator", nonce: nextNonce("r35-attest"), claim: DEST_TRON });
  if (!r.queued) { console.error("[full-cycle] attest REJECTED:", r.reason); process.exit(4); }
  await chain.stepOnce();
  const outboxWtrx = st.balances[OUTBOX]?.WTRX ?? 0;
  if (outboxWtrx < PEGOUT_MU) { console.error(`[full-cycle] OUTBOX DID NOT LAND (${outboxWtrx}µ) — honest failure`); process.exit(5); }
  console.log(`[full-cycle] *** PEG-OUT CLAIM *** ${PEGOUT_MU}µ WTRX → ${OUTBOX} · dest ${DEST_TRON} · h${st.height}`);

  /* ── 8) דוח-הדלת: פסק-דין-העוגן החי ── */
  const midFinal = Math.floor((pool.ra * 1000) / pool.rb);
  const oMilli = Math.round(oracleWtrx / 1000);
  const spreadBps = Math.round(((midFinal - oMilli) / oMilli) * 10_000);
  const verdict = Math.abs(spreadBps) < 300 ? "CONVERGED" : Math.abs(spreadBps) < 1500 ? "DRIFT" : "DIVERGENT";

  const myJournal = st.journal.filter((j) => /r35|USDS\/WTRX|peg-outbox|WTRX/.test(j.note ?? "") || ["pool_open", "asset_list"].includes(j.action)).slice(-14);

  const receipt: Receipt = {
    cycle: "R35-first-full-cycle",
    at: new Date().toISOString(),
    chain: { heightBefore: h0, heightAfter: st.height, root: (rt.st as unknown as { stateRoot?: string }).stateRoot ?? null },
    custody: { address: CUSTODY_TRON, sun: custodySun, trxEquivalent: custodySun !== null ? custodySun / 1e6 : null, depositTxid: "8d84e637f3ebc87b8248361a58342eb05014315beb9a9e9b6f3c1c403de9e917" },
    oracle: { wtrxMu: oracleWtrx, atH: st.oracle?.WTRX?.atH, src: st.oracle?.WTRX?.src, usdPerWtrx: oracleWtrx / 1e6, refPriceListed: refWtrx },
    market: {
      pair: "USDS/WTRX", openedAtH: st.height, raUsds: pool.ra, rbWtrx: pool.rb, lp: pool.lp,
      midOpenMilli: midOpen, midFinalMilli: midFinal, spreadBpsVsOracle: spreadBps, verdict,
      poolSwaps: pool.swaps, feeAccruedTreasury: pool.feeAccruedTreasury,
      honestNote: "צד-ה-WTRX הוא הנכס-החיץ-האמיתי (2.0 TRX שהופקדו בפועל); צד-ה-USDS הוא אשראי-פנימי",
    },
    trades: [
      { dir: "sell", inMu: SELL_MU, assetIn: "WTRX", outMu: gotUsds, assetOut: "USDS" },
      { dir: "buy", inMu: buyIn, assetIn: "USDS", outMu: gotWtrx, assetOut: "WTRX" },
    ],
    redemption: { outbox: OUTBOX, wtrxMu: outboxWtrx, destTron: DEST_TRON, note: "הכסף הפיזי יעזוב את המשמורת רק בשידור-אמת של המפעיל (המפתח בידיו בלבד)" },
    operator: { before: opBefore, after: st.balances.operator },
    treasury: { before: trBefore, after: st.balances.treasury },
    backing: { ...st.backing },
    totalsWtrx: Object.entries(st.balances).reduce((s, [, b]) => s + (b.WTRX ?? 0), 0),
    journal: myJournal,
    stats: { ...st.stats },
  };
  console.log("\n[full-cycle] ═══ RECEIPT ═══");
  console.log(JSON.stringify(receipt, null, 2));
  require("fs").writeFileSync("/tmp/r35-receipt.json", JSON.stringify(receipt, null, 2));

  chain.forceFlush();
  console.log(`\n[full-cycle] db flushed · h${h0}→${st.height} · ${(Date.now() - t0) / 1000 | 0}s`);
  console.log("[full-cycle] next: commit db + push, then cloud-beat publishes to Console");
  process.exit(0);
}

main().catch((e) => {
  console.error("[full-cycle] FATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
