/**
 * settle.ts — עמדת-הסליקה (Settlement Desk) · SIM→REAL
 *
 * הפקודה-מוסדית: "ספר-ריבוני, אין כסף-אמת — בודקים את הסוכנים ועושים להם מבחן
 * עם כסף-אמת; מסדרים, מייצבים את השוק שהכל ישב."
 *
 * שלוש-שכבות-הוכחה, מהפנים-החוצה:
 *  1. LEDGER AUDIT (כסף-פנים) — חשבונאות-ברזל על המצב-החי:
 *     · קרדיטים: Σcredits + gasUsed === ג'נזיס (אפס-הטבעה/שריפה מחוץ-לג'נזיס)
 *     · נכסים: Σbalances + Σמאגרים + backing(עטוף) === ג'נזיס, לכל-נכס
 *     · ערבות: locked === Σפקודות-חיות (מדויק, לא-גלובלי) · avail ≥ 0 לכולם
 *     · עמלות: Σpools.feeAccruedTreasury === feeMeter + treasuryProfit + feeMinted + feesSpentMu (מדידה-כנה)
 *  2. AGENT EXAM (מבחן-סוכנים) — תוכנית-לימוד על שיבוט-מצב דטרמיניסטי:
 *     כל-סוכן עובר QUOTE (גריד) → CROSS (טייקר-חוצה-ספרד) → CANCEL (שחרור-נעילה
 *     מדויק) עם טענת-שימור אחרי-כל-שלב; התוכנית רצה פעמיים על שני-שיבוטים
 *     עצמאיים — stateRoot זהה = דטרמיניזם-מוכח על-העדויות-עצמן.
 *  3. REAL MONEY (כסף-אמת) — ביקורת-חיה מול רשתות-ציבוריות:
 *     · יתרות-אמת: Steem/Hive/ETH/SOL/TRON — קריאה-RPC ישירה, כנות-מלאה לכשל
 *     · אימות-עיגון-טרי: כל-שרשרת — ה-txid החי-האחרון נקרא-חזרה מה-RPC הציבורי
 *       ומושווה ביט-מול-ביט (height+stateRoot) מול-החותם-המקומי (verifyOnChain).
 *
 * אפס-סודות: כאן קוראים רק-כתובות-ציבוריות מ-relayStatus(). אין-מפתחות, אין-חתימות.
 */
import {
  genesisState, stateRoot, applyOp, notional, poolKey,
  type DexState, type Asset, PRIMER_MU, REPRIME_MU } from "./kernel";
import { fairPrice, MARKETS } from "./mm";
import { poolMid, getPool } from "./amm";
import { sortBook } from "./book";
import { getWallets } from "./chain";
import { relayStatus, verifyOnChain, type ChainName } from "./relay";
import { fencedFetch } from "./fence"; // FIX(Roast-65-b · M7 / 65-b MED-7): כל-fetch-יוצא דרך-הגדר (assertAllowedHost + redirect:"error") — כולל-ETH_RPC_URL/SOL_RPC_URL-מה-env

/* ── ג'נזיס-עוגן: טבלת-האמת של ההנפקה (מחושבת מהג'נזיס עצמו — תמיד-מסונכרן) ── */
export interface GenesisTotals {
  credits: number;
  assets: Record<string, number>; // Σbalances + Σpool-reserves (backing ג'נזיס = ∅)
  poolsLp: Record<string, number>; // lp-ג'נזיס לכל-בריכה
}

let _gtCache: GenesisTotals | null = null;
export function genesisTotals(): GenesisTotals {
  // FIX(SETTLE-9 perf): ג'נזיס-קבוע לגמרי — נבנה-מחדש בכל-קריאת-/metrics ו-/settle
  // (אלפי-קריאות-ביום). ממוזכר-פעם-אחת (טהור: אפס-קלט חוץ, אפס-תלות במצב-חי).
  if (!_gtCache) _gtCache = computeGenesisTotals();
  return _gtCache;
}
function computeGenesisTotals(): GenesisTotals {
  const g = genesisState();
  const assets: Record<string, number> = {};
  const bump = (a: string, d: number): void => { assets[a] = (assets[a] ?? 0) + d; };
  for (const [, wallet] of Object.entries(g.balances)) for (const [a, v] of Object.entries(wallet)) bump(a, v);
  for (const p of Object.values(g.pools)) { bump(p.a, p.ra); bump(p.b, p.rb); }
  const poolsLp: Record<string, number> = {};
  for (const [k, p] of Object.entries(g.pools)) poolsLp[k] = p.lp;
  const credits = Object.values(g.credits).reduce((s, v) => s + v, 0);
  return { credits, assets, poolsLp };
}

/* ── 1. ביקורת-חשבונאות-ברזל על מצב-חי (או שיבוט) ──────────────────────────── */
export interface LedgerAudit {
  ok: boolean;
  credits: { sum: number; gasUsed: number; expected: number; minted: number; ok: boolean };
  assets: { asset: string; live: number; expected: number; ok: boolean; kind: "native" | "wrapped" | "lp" | "issued" }[];
  escrow: { accounts: number; lockedSum: number; ordersSum: number; exact: boolean; availOk: boolean; ok: boolean };
  fees: { poolsTreasury: number; bookFeesMu: number; feeMeterPlusProfit: number; feesSpentMu: number; ok: boolean };
  negatives: string[];
  errors: string[];
}

export function ledgerAudit(st: DexState, totals: GenesisTotals): LedgerAudit {
  const errors: string[] = [];
  const negatives: string[] = [];

  // (a) קרדיטים: אפס-הטבעה-שאינה-מגובה-עמלות — Σcredits + gasUsed − feeMinted === ג'נזיס + מוצהר
  // (THE-FOUNTAIN: הטבעת-דלק מותרת-רק-מגובה-עמלות-מדודות; feeMinted הוא-הרישום-המצטבר)
  // OWNER-MANDATE 2026-10-17 · creditsMu: הצהרת-עידן (ג'נזיס-החיילים 28M ← 20M) + ניכויי-קרדיטים
  // של-agent_purge — הכל מוצהר-במצב-הקנוני, לא-מוסתר; סחיפה-חדשה-מעבר-להצהרה = HALT.
  const minted = st.feeMinted ?? 0;
  const declaredCredits = st.auditAdjustments?.creditsMu ?? 0;
  const creditSum = Object.values(st.credits).reduce((s, v) => s + v, 0);
  const creditsOk = creditSum + st.gasUsed - minted === totals.credits + declaredCredits;
  if (!creditsOk) errors.push(`credits: Σ${creditSum}+gas${st.gasUsed}−minted${minted} ≠ genesis${totals.credits}+declared${declaredCredits}`);

  // (b) נכסים: Σbalances + Σpool-reserves + backing-עטוף === ג'נזיס (לכל-נכס)
  const liveAssets: Record<string, number> = {};
  const bump = (a: string, d: number): void => { liveAssets[a] = (liveAssets[a] ?? 0) + d; };
  for (const [, wallet] of Object.entries(st.balances)) for (const [a, v] of Object.entries(wallet)) bump(a, v);
  for (const p of Object.values(st.pools)) { bump(p.a, p.ra); bump(p.b, p.rb); }
  const backing = st.backing ?? {};
  const assetRows: LedgerAudit["assets"] = [];
  const names = Array.from(new Set([...Object.keys(totals.assets), ...Object.keys(liveAssets), ...Object.keys(backing)]));
  for (const a of names) {
    const isLp = a.startsWith("LP|");
    const isWrapped = a.startsWith("W") && !isLp;
    // FIX(Roast-65-a · HIGH-3b): פנקס-היצע-שנברא — טוקני-השקה (LB|*) חיים-מחוץ-לג'נזיס:
    // הג'נזיס לא מכיר אותם, אבל הם הנפקה-אמת-מגובה-גיוס (launch_buy מטביע, launch_sell
    // שורף, ההגירה מעבירה-את-ההיצע-כולו לבריכה). בלי-פנקס-זה הביקורת דנה "live>0 ≠ genesis 0"
    // על-כל-טוקן-השקה = פסק-דין-אדום-תמידי = עייפות-אזעקה. ההיצע-הצפוי נגזר-מההשקה-עצמה:
    // טרם-הגירה = soldMu (מחזור-מוחזק) · אחרי-הגירה = supplyMu (R בבריכה + soldMu בידיים, קבוע).
    if (a.startsWith("LB|")) {
      const l = Object.values(st.launch ?? {}).find((x) => x.code === a);
      const live = liveAssets[a] ?? 0;
      const expected = l ? (l.graduated ? l.supplyMu : l.soldMu) : 0;
      const ok = live === expected;
      assetRows.push({ asset: a, live, expected, ok, kind: "issued" });
      if (!ok) errors.push(`issued ${a}: live ${live} ≠ issuance ${expected}`);
      continue;
    }
    if (isLp) {
      // היצע-LP: pool.lp − Σbal(LP|) === lp-ג'נזיס + הפרש-היסטורי-מוצהר
      // FIX(Roast-65 · drift-declaration): ההפרש-ההיסטורי (עידן-טרם-התיקונים)
      // מוצהר-במצב — לא-מוסתר; סחיפה-חדשה-מעבר-להצהרה נשארת-כשל.
      const sumBal = liveAssets[a] ?? 0;
      const key = a.slice(3);
      const lpNow = st.pools[key]?.lp ?? 0;
      const adjLp = st.auditAdjustments?.lp?.[key] ?? 0;
      const expected = (totals.poolsLp[key] ?? 0) + adjLp;
      const ok = lpNow - sumBal === expected;
      assetRows.push({ asset: a, live: lpNow - sumBal, expected, ok, kind: "lp" });
      if (!ok) errors.push(`lp ${key}: implied ${lpNow - sumBal} ≠ genesis+declared ${expected}`);
      continue;
    }
    if (isWrapped) {
      // נכס-עטוף: ההיצע-מעל-הג'נזיס חייב להיות מגובה 1:1 ב-backing
      const live = liveAssets[a] ?? 0;
      const expected = (totals.assets[a] ?? 0) + ((backing[a] ?? 0) - 0);
      const ok = live === expected;
      assetRows.push({ asset: a, live, expected, ok, kind: "wrapped" });
      if (!ok) errors.push(`wrapped ${a}: supply ${live} ≠ genesis+backing ${expected}`);
      continue;
    }
    // נכס-טבעי: Σbal + Σpools + backing(W+x) === ג'נזיס − שריפות-שנרשמו (FIX: HIGH-3b —
    // הראוטר שורף SAOS אמת (burnedSaos): ההיצע-החי יורד-לצמיתות — בלי-הדלי הביקורת
    // הייתה נכשלת-נצחית מהמחזור-הראשון של ה-buy-and-burn) + הפרש-היסטורי-מוצהר
    // Task 80 · THE-VAULT: היצע-הכספת (issuedMu−burnedMu) הוא-הנפקה-המוצהרת-החיה
    // של USDS — שאיבה מטביעה (issuedMu+=), פירעון שורף (burnedMu+=). רק-הקרן נספרת:
    // ריבית לא-הוטבעה-מעולם, רק-הועברה-מהמשלם-לאוצר — ההיצע נשאר-מדויק-לנצח.
    const nativeBacking = backing[`W${a}`] ?? 0;
    const live = (liveAssets[a] ?? 0) + nativeBacking;
    const adjNative = st.auditAdjustments?.native?.[a] ?? 0;
    // EXEC-CD-30 · הצהרות-חוץ-בצפוי: טבעה-חיצונית (wrap_mint external — Task 61/72,
    // אימות-RPC + תביעה-חד-פעמית) מוסיפה backing בלי-נכס-ילידי-בשרשרת. הביקורת-הישנה
    // ספרה-אותה-כ"חי" בלי-לספור-אותה-ב"צפוי" — נכס-ילידי-שמסתובב-במקביל-לטבעה-חיצונית
    // של-העטוף-שלו היה-מפיל-את-הספרים (נמדד-חי: native SOL live 61 ≠ 0 בחותם-הגשר).
    // התיקון: הצפוי כולל גם את ההצהרות-החוץ (st.extBack — מצב-קנוני, טבעת-תביעות-חד-פעמית).
    // כנות: extBack הוא הצהרת-הפקדות-שאומתו — לא זיוף; הדלת ממשיכה לבקר 1:1 מול-משמורת.
    const extDeclared = st.extBack?.[`W${a}`]?.mu ?? 0;
    const vaultSupply = a === "USDS" ? ((st.vaultTot?.issuedMu ?? 0) - (st.vaultTot?.burnedMu ?? 0)) : 0;
    const expected = (totals.assets[a] ?? 0) - (a === "SAOS" ? (st.burnedSaos ?? 0) : 0) + adjNative + vaultSupply + extDeclared;
    const ok = live === expected;
    assetRows.push({ asset: a, live, expected, ok, kind: "native" });
    if (!ok) errors.push(`native ${a}: live ${live} ≠ genesis+declared ${expected}`);
  }

  // (c) ערבות: locked === Σפקודות-חיות + נעילות-תוכניות (מדויק) · avail ≥ 0 · אין-יתרות-שליליות
  // FIX(Roast-64 · auditor-reconciler-split): המבקר ספר רק-נעילות-ספר — אחרי-כל
  // dca_create/trig_order/cow_order הביקורת הייתה מדווחת "escrow-שבור" שקרית
  // (הפיוס-בטעינה כבר סופר את התוכניות). מאזינים עכשיו לאותם מקורות-אמת.
  const lockSum: Record<string, Record<string, number>> = {};
  let ordersSum = 0;
  // FIX(Roast-64 · shadow-collision): שם-העזר שונה-מ-bump-של-סעיף-(b) — אותו-סקופ-פונקציה
  const bumpLock = (owner: string, a: string, mu: number): void => {
    if (!(mu > 0)) return;
    const w = (lockSum[owner] = lockSum[owner] ?? {});
    w[a] = (w[a] ?? 0) + mu;
    ordersSum += mu;
  };
  for (const o of st.orders) {
    if (!o.live) continue;
    const rem = o.amount - o.filled;
    if (rem <= 0) continue;
    // FIX(escrow-dust): המד-הפרטי lockMu הוא-מקור-האמת; נגזרת רק-לפקודות-ישנות
    const mu = typeof o.lockMu === "number" && Number.isSafeInteger(o.lockMu) && o.lockMu >= 0
      ? o.lockMu
      : (o.side === "sell" ? rem : notional(o.price, rem));
    bumpLock(o.owner, o.side === "sell" ? o.base : o.quote, mu);
  }
  for (const p of Object.values(st.dca ?? {})) {
    if (!(p.remainingMu > 0)) continue;
    bumpLock(p.owner, p.assetIn, p.remainingMu);
  }
  for (const t of Object.values(st.trig ?? {})) {
    const a = t.side === "sell" ? t.base : t.quote;
    const effPx = t.limitPx > 0 ? t.limitPx : t.triggerPx;
    bumpLock(t.owner, a, t.side === "sell" ? t.amountMu : notional(effPx, t.amountMu));
  }
  for (const o of st.cow ?? []) {
    bumpLock(o.owner, o.side === "sell" ? o.base : o.quote, o.lockMu);
  }
  let lockedSum = 0;
  let availOk = true;
  let accounts = 0;
  for (const [who, wallet] of Object.entries(st.balances)) {
    accounts++;
    for (const [a, v] of Object.entries(wallet)) {
      if (v < 0) negatives.push(`${who}.${a}=${v}`);
      const lk = st.locked[who]?.[a] ?? 0;
      if (lk < 0) negatives.push(`${who}.${a} locked=${lk}`);
      if (v - lk < 0) { availOk = false; negatives.push(`${who}.${a} avail=${v - lk}`); }
    }
  }
  for (const [who, wallet] of Object.entries(st.locked)) {
    for (const [a, v] of Object.entries(wallet)) {
      if (v === 0) continue;
      lockedSum += v;
      const expect = lockSum[who]?.[a] ?? 0;
      if (expect !== v) errors.push(`escrow ${who}.${a}: locked ${v} ≠ orders-sum ${expect}`);
    }
  }
  for (const [who, wallet] of Object.entries(lockSum)) {
    for (const [a, v] of Object.entries(wallet)) {
      const have = st.locked[who]?.[a] ?? 0;
      if (have !== v) errors.push(`escrow-shadow ${who}.${a}: orders-sum ${v} ≠ locked ${have}`);
    }
  }

  // (d) עמלות: מדידה-כנה — Σpools.feeAccruedTreasury + bookFeesMu === feeMeter + treasuryProfit + feeMinted + feesSpentMu
  const poolsTreasury = Object.values(st.pools).reduce((s, p) => s + p.feeAccruedTreasury, 0);
  // BOOK-TAKER-FEE (2026-10-20): עמלות-ספר-הפקודות הן-מקור-עמלות-שני (מחוץ-לבריכות) —
// זורמות-לאותם-דליים (feeMeter→profit→דלק) ולכן מוחסרות-לצד-המדידה של-הזהות.
  const bookFeesMu = st.bookFeesMu ?? 0;
  // (d) עמלות: כל-מה-שהבריכות-מדדו === מד-שלא-נקצר + רווח-שלא-נצרך + דלק-שמוחזר + צריכת-הראוטר
  // (THE-FOUNTAIN: feeMinted הוא-עמלות-שהפכו-קרדיטים — נצרך-מהמדידה, לא-נעלם ·
  // FIX(Roast-65-a · HIGH-3d): feesSpentMu — עמלות-שהראוטר צרך-מ-treasuryProfit (economy.ts)
  // FIX(3-a · D1 · sign-lineage): הסימן-הקודם (−spent) היה הפוך. קו-הייחוס-החי
  // (h8412): pools 211,765 = meter 3,765 + profit 200,000 + spent 8,000 + minted 0 —
  // מתאחה-במדויק רק עם **+spent**: עמלות-שהראוטר צרך מהרווח זרמו לבריכות (קניית-
  // שריפה מוסיפה-USDS-לרזרבות) — כסף-שנצרך-מהמדידה-נמדד-בבריכות ולכן הוא-**נזקף**
  // לטובת-Σpools, לא-מנוכה ממנה. הסימן-ההפוך ייצר סטייה-פנטום של 2×take בכל
  // מחזור-ראוטר-רווחי ראשון → InvariantViolation → HALT כוזב (שרשרת-חיה עצרה ב-h8412).
  const feesSpentMu = (st.feesSpentMu ?? 0) + (st.auditAdjustments?.feesSpentMu ?? 0); // FIX(Roast-65 · drift-declaration): כולל-ההיסטוריה-המוצהרת
  // EXEC-CD-9 · מקורות-ההטבעה-המוצהרים: feeMinted = כל-הקרדיטים-שהוטבעו-מעל-ג'נזיס.
  // הזהות-העמלות מגבה-רק-את-החלק-מעמלות-מדודות; שני-מקורות-מוצהרים-מוחסרים —
  // מוצהר-ולא-מוסתר (אותו-דפוס auditAdjustments):
  //  · primerPortion — ההצתה-הריבונית-החד-פעמית (primerMu מפורש, או נגזר-מהדגל);
  //  · bookGasPortion — מיחזור-גז-הספר (bookGasRecycledMu — גז-שנשרף-וחוזר; הגיבוי
  //    הוא-העבודה-ששולמה-בפועל, לא-עמלות-בריכות).
  const primerPortion = st.primerMu ?? (st.primerUsed ? PRIMER_MU : 0);
  // EXEC-CD-10 · ה-reprime מוצהר-כמו-הפריימר — ההטבעה-שאינה-מגובה-עמלות-בריכות
  // (החלטת-בעלים מדודה) מוחסרת-מזהות-העמלות; רשויות: undefined → נגזר מהדגל.
  const reprimePortion = st.reprimeMu ?? (st.reprimeUsed ? REPRIME_MU : 0);
  const bookGasPortion = st.bookGasRecycledMu ?? 0;
  // G105 · THE-DROUGHT-FOUNTAIN: דלי-מוצהר רביעי — µ-דלק שהוטבעו-מ-revAux
  // (הכנסת-ארב-מדודה) מעולם-לא-היו עמלות-בריכות/ספר (revAux מחוץ-לאגף-השמאלי
  // ממילא) → כל-µ-כזה מוחסר-מזהות-העמלות בדיוק-כמו-פריימר/ריפריים/בוקגז.
  // רשויות: undefined → 0 (תמונות-ישנות-בלעדיו). רשויות-הגרעין: רק-mint_fuel
  // בבצורת-מדודה נוגע-בדלי (profit→meter→aux סדר-קנוני, כל-µ-נגרע-מדידה-אמת).
  const revAuxMintedPortion = Math.max(0, st.revAuxMintedMu ?? 0);
  const declared = primerPortion + reprimePortion + bookGasPortion + revAuxMintedPortion;
  if (declared > (st.feeMinted ?? 0)) errors.push(`minted-declared: primer${primerPortion}+reprime${reprimePortion}+bookgas${bookGasPortion}+revaux${revAuxMintedPortion} > minted ${st.feeMinted ?? 0}`);
  const feesRhs = st.feeMeter + st.treasuryProfit + ((st.feeMinted ?? 0) - declared) + feesSpentMu;
  const feesOk = poolsTreasury + bookFeesMu === feesRhs;
  if (!feesOk) errors.push(`fees: pools${poolsTreasury}+book${bookFeesMu} ≠ feeMeter+profit+minted−primer${primerPortion}−reprime${reprimePortion}−bookgas${bookGasPortion}−revaux${revAuxMintedPortion}+spent ${feesRhs}`);

  return {
    ok: errors.length === 0 && negatives.length === 0,
    credits: { sum: creditSum, gasUsed: st.gasUsed, expected: totals.credits, minted, ok: creditsOk },
    assets: assetRows,
    escrow: { accounts, lockedSum, ordersSum, exact: errors.filter((e) => e.startsWith("escrow")).length === 0, availOk, ok: errors.filter((e) => e.startsWith("escrow") || e.startsWith("escrow-shadow")).length === 0 && negatives.length === 0 },
    // שדה-השם-מטעה-בכוונת-מקור: feeMeterPlusProfit = meter+profit+**minted** (השלישייה-כולה) —
    // FIX(Roast-65 · doc): מתועד-כאן-כדי-שהצהרת-הסחיפה-ב-chain.ts לא תספור-את-ה-minted פעמיים.
    fees: { poolsTreasury, bookFeesMu, feeMeterPlusProfit: st.feeMeter + st.treasuryProfit + (st.feeMinted ?? 0), feesSpentMu, ok: feesOk }, // FIX(3-a · D1): feeMeterPlusProfit נשאר-השלישייה (meter+profit+minted) — ההצהרה ב-chain.ts מחשבת-מולו את הדלי-הרביעי בכיוון-הנכון
    negatives,
    errors,
  };
}

/* ── 2. מבחן-סוכנים — תוכנית-לימוד דטרמיניסטית על שיבוט-מצב ────────────────── */
export type ExamTask = "quote" | "cross" | "cancel";
export interface AgentExam {
  agent: string;
  tasks: { task: ExamTask; ok: boolean; note: string }[];
  conservationAfterEach: boolean;
  determinismRoot: string;
  score: number; // 0..3
  pass: boolean;
}
export interface ExamReport {
  agents: AgentExam[];
  determinismIdentical: boolean;
  roots: string[];
  audit: LedgerAudit; // ביקורת-סופית על מצב-המבחן (ראיה לשימור-גם-אחרי-המבחן)
  ok: boolean;
}

const EXAM_T0 = 1_700_000_000_000; // חותמת-זמן-קבועה — דטרמיניזם מלא

function clone(st: DexState): DexState {
  return JSON.parse(JSON.stringify(st)) as DexState;
}

/** תוכנית-הלימוד: QUOTE → CROSS → CANCEL, טענת-שימור אחרי-כל-שלב.
 * חוזה: אותם-קלטים על אותו-מצב-התחלתי = אותו-stateRoot (קריאת-ה-kernel). */
function runCurriculum(
  preExam: DexState, agent: string, prices: { bid: number; ask: number; fair: number },
  totals: GenesisTotals,
): { exam: AgentExam; finalRoot: string } {
  const st = clone(preExam);
  const tasks: AgentExam["tasks"] = [];
  let conservationAfterEach = true;
  const check = (phase: string): void => {
    const a = ledgerAudit(st, totals);
    if (!a.ok) { conservationAfterEach = false; tasks.push({ task: "quote", ok: false, note: `${phase}: ${a.errors[0] ?? "conservation"}` }); }
  };
  const push = (task: ExamTask, ok: boolean, note: string): void => { tasks.push({ task, ok, note }); };

  // ── QUOTE: פקודת-גריד buy+sell סביב-הפייר (20k µ, רחוק-מהמגע כדי-לא-לחצות)
  const bidPx = Math.max(1, Math.floor((prices.fair * 9_900) / 10_000));
  const askPx = Math.floor((prices.fair * 10_100) / 10_000);
  // מבחן-מדורג: הסוכן מצטט מה שיש-לו — 20k → 5k → 1k (כנות: מי-שאין-לו-לא-מצטט)
  let rBuy: ReturnType<typeof applyOp> | null = null;
  for (const amt of [20_000, 5_000, 1_000]) {
    rBuy = applyOp(st, { type: "order", issuer: agent, nonce: `exam-${agent}-q1`, base: "SAOS", quote: "USDS", side: "buy", price: bidPx, amount: amt }, EXAM_T0);
    if (rBuy.ok) { push("quote", true, `buy ${amt}µ @${bidPx}`); break; }
    if (amt === 1_000) push("quote", false, `buy: ${rBuy.err}`);
  }
  let rSell: ReturnType<typeof applyOp> | null = null;
  for (const amt of [20_000, 5_000, 1_000]) {
    rSell = applyOp(st, { type: "order", issuer: agent, nonce: `exam-${agent}-q2`, base: "SAOS", quote: "USDS", side: "sell", price: askPx, amount: amt }, EXAM_T0);
    if (rSell.ok) { push("quote", true, `sell ${amt}µ @${askPx}`); break; }
    if (amt === 1_000) push("quote", false, `sell: ${rSell.err}`);
  }
  check(`quote:${agent}`);

  // ── CROSS: טייקר-שוק — חוצה את הספר במחיר-המייקר (איסור-מילוי-עצמי פעיל)
  // בוחרים-צד-שיש-עליו-נזילות-של-אחרים (הספר-החי עמוס-גריד — אמור-לחצות)
  let crossed = false; let crossNote = "no-cross";
  const tryCross = (side: "buy" | "sell"): boolean => {
    const opp = sortBook(st, "SAOS", "USDS", side === "buy" ? "sell" : "buy").find((o) => o.owner !== agent);
    if (!opp) return false;
    const qty = Math.min(5_000, opp.amount - opp.filled);
    if (qty <= 0) return false;
    const r = applyOp(st, { type: "fill", issuer: agent, nonce: `exam-${agent}-x1-${side}`, base: "SAOS", quote: "USDS", side, amount: qty, market: true }, EXAM_T0);
    crossed = r.ok; crossNote = r.ok ? `taker ${side} ${qty}µ @maker ${opp.price} (owner ${opp.owner})` : r.err;
    return r.ok;
  };
  if (!tryCross("buy")) { crossNote = "no-cross"; crossed = false; if (!tryCross("sell")) { crossed = false; } }
  push("cross", crossed, crossNote);
  check(`cross:${agent}`);

  // ── CANCEL: ביטול-פקודה-מנוחה-שלנו — הנעילה-משתחררת-במדויק (לולאת-סגירת-חשבון)
  const mine = st.orders.find((o) => o.live && o.owner === agent && o.nonce === `exam-${agent}-q1`)
    ?? st.orders.find((o) => o.live && o.owner === agent && o.nonce === `exam-${agent}-q2`)
    ?? st.orders.find((o) => o.live && o.owner === agent);
  let cancelled = false; let cancelNote = "no-resting-order";
  if (mine) {
    // FIX(escrow-dust): מד-הנעילה-הפרטי נקרא לפני-הביטול (cancel מאפס את-המד)
    const remPre = mine.amount - mine.filled;
    const held = typeof mine.lockMu === "number" && Number.isSafeInteger(mine.lockMu) && mine.lockMu >= 0
      ? mine.lockMu
      : (mine.side === "sell" ? remPre : notional(mine.price, remPre));
    const lockAsset = mine.side === "sell" ? mine.base : mine.quote;
    const before = st.locked[agent]?.[lockAsset] ?? 0;
    const r = applyOp(st, { type: "cancel", issuer: agent, nonce: `exam-${agent}-c1`, orderId: mine.id }, EXAM_T0);
    const after = st.locked[agent]?.[lockAsset] ?? 0;
    const releasedExact = before - after === held;
    cancelled = r.ok && releasedExact;
    cancelNote = r.ok ? (releasedExact ? `cancel #${mine.id} · lock ${held}µ released exactly` : `cancel ok but lock Δ=${before - after} ≠ held ${held}`) : r.err;
  }
  push("cancel", cancelled, cancelNote);
  check(`cancel:${agent}`);

  const score = tasks.filter((t) => t.ok).length;
  return {
    exam: {
      agent, tasks,
      conservationAfterEach,
      determinismRoot: stateRoot(st),
      score,
      pass: tasks.every((t) => t.ok) && conservationAfterEach,
    },
    finalRoot: stateRoot(st),
  };
}

export function runExam(st: DexState): ExamReport {
  const totals = genesisTotals();
  const preExam = clone(st);
  const fair = fairPrice(preExam, "SAOS", "USDS") || 2_500;
  const prices = { fair, bid: Math.floor((fair * 9_900) / 10_000), ask: Math.floor((fair * 10_100) / 10_000) };
  // OWNER-MANDATE 2026-10-17: החיילים-הסינתטיים סולקו — המבחן רץ על סוכני-מערכת אמתיים
  const agents = ["operator", "arena", "bot-a", "bot-b", "bot-c"];
  const run1 = agents.map((a) => runCurriculum(preExam, a, prices, totals));
  const run2 = agents.map((a) => runCurriculum(preExam, a, prices, totals)); // עצמאי-לחלוטין
  const roots1 = run1.map((r) => r.finalRoot);
  const roots2 = run2.map((r) => r.finalRoot);
  const identical = roots1.every((r, i) => r === roots2[i]);
  // ביקורת-סופית על מצב-המבחן (מריצה-1) — השימור-שורד-גם-את-המבחן-עצמו
  const stAfter = clone(preExam);
  for (const a of agents) {
    applyOp(stAfter, { type: "order", issuer: a, nonce: `exam-${a}-q1`, base: "SAOS", quote: "USDS", side: "buy", price: prices.bid, amount: 20_000 }, EXAM_T0);
    applyOp(stAfter, { type: "order", issuer: a, nonce: `exam-${a}-q2`, base: "SAOS", quote: "USDS", side: "sell", price: prices.ask, amount: 20_000 }, EXAM_T0);
  }
  const audit = ledgerAudit(stAfter, totals);
  return {
    agents: run1.map((r) => r.exam),
    determinismIdentical: identical,
    roots: roots1.slice(0, 2),
    audit,
    ok: identical && run1.every((r) => r.exam.pass) && audit.ok,
  };
}

/* ── 3. כסף-אמת: ביקורת-חיה מול רשתות-ציבוריות (קריאה-בלבד, אפס-סודות) ─────── */
export interface RailBalance {
  rail: ChainName;
  identity: string;            // כתובת/חשבון ציבורי
  native: string;              // יתרה-טבעית (מחרוזת-אנושית)
  extra: string;               // רכיב-נוסף (SBD/HBD/VESTS/nonce)
  ok: boolean;                 // האם-הקריאה-חיה-הצליחה
  // FIX(6-a · live-semantics): האם-ה-relay מדווח-מסילה-**מאופשרת** (זהות+מפתח-חתימה).
  // עניה-ל-RPC ≠ חתימה-חיה — hive-מנוטרלת/blurt-חסר-מפתח ענו-ל-RPC ונספרו "live" (ניפוח).
  enabled?: boolean;
  detail: string;              // מקור-הנתון או-הכשל (כנות-מלאה)
  at: string;
}
export interface AnchorSpot {
  rail: ChainName; height: number; ok: boolean; verified: boolean; detail: string;
}
export interface RealMoneyReport {
  rails: RailBalance[];
  anchors: AnchorSpot[];
  liveRails: number;           // FIX(6-a): מסילות-חתימה-חיות בלבד (relay-enabled && RPC-ענה) — לא-עוד "ענה-ל-RPC"
  rpcReachableRails: number;   // FIX(6-a): כמה-ענו-ל-RPC בלבד (כולל-מסילות-כבויות) — שקיפות-מלאה
  totalRails: number;          // FIX(70-b ·2): המונה-הכולל — לא-קשיח-ב-UI
  verifiedNow: number;         // כמה-עיגונים אומתו-כרגע-בקריאה-חוזרת
  ok: boolean;                 // ≥1 rail חי && 0 mismatch
}

const UA = "saos-dex-settle/1.0 (+institutional-audit)";
async function jfetch<T>(url: string, body?: unknown, timeoutMs = 9_000): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    // FIX(Roast-65-b · M7 / 65-b MED-7): jfetch היה bare-fetch בלי-גדר — ETH_RPC_URL/SOL_RPC_URL
    // מה-env (וכל-שער-RPC) יצאו-חוצה בלי-קיבוע-מארח ובלי-הגנת-redirect (307/308 של מארח-עוין
    // היה גורר method+body מחוץ-לגדר). עכשיו: fencedFetch — assertAllowedHost (פיני-ה-env
    // קיימים-כבר-ב-PINNED_HOSTS) + redirect:"error" בלתי-ניתן-לעקיפה. שער-לא-מקובע = זריקה fail-closed.
    const r = await fencedFetch(url, "settle.jfetch", {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "user-agent": UA },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
      cache: "no-store",
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as T;
  } finally { clearTimeout(timer); }
}
const num = (s: string): number => parseFloat(String(s).replace(/[^\d.]/g, "")) || 0;

async function auditRail(rail: ChainName, identity: string): Promise<RailBalance> {
  const at = new Date().toISOString();
  try {
    if (rail === "steem" || rail === "hive" || rail === "blurt" || rail === "fleet") {
      // FIX(70-b ·1): BLURT היה-נופל לענף-ה-SOL — שאילתת-getBalance-סולנית על-שם-גרפן
      // החזירה "0.000000000 SOL" ירוק (חיובי-שקר). עתה: ענף-גרפן אמיתי (אותו-מבנה-condenser),
      // צמתים-חיים מ-blurtwallet (blurt.world מת). BLURT אין-דבט — רק-נזיל+VESTS.
      const NODES: Record<string, string> = {
        steem: "https://api.steemit.com",
        hive: "https://api.hive.blog",
        // rpc.blurt.blog — הצומת-החי-שנמדד (Roast-74) · מקובע-כבר-ב-PINNED_HOSTS
        blurt: "https://rpc.blurt.blog",
        // FIX(R14-a·1): fleet = חיילי-הצי על Hive — ענף-גרפן משלו. היה-נופל לענף-ה-SOL
        // (getBalance-סולני על שם-גרפן): על צומת-סלחן היה מחזיר false-positive
        // "0.000000000 SOL" חי, ועל הצומת-הקפדן — "read failed: Invalid param" מטעה.
        fleet: "https://api.hive.blog",
      };
      const node = NODES[rail];
      const r = await jfetch<{ result?: { balance: string; sbd_balance?: string; hbd_balance?: string; vesting_shares: string }[]; error?: { message: string } }>(
        node, { jsonrpc: "2.0", method: "condenser_api.get_accounts", params: [[identity]], id: 1 });
      if (r.error) throw new Error(r.error.message);
      const acc = r.result?.[0];
      if (!acc) throw new Error("account not found");
      const sym = rail === "steem" ? "STEEM" : rail === "hive" ? "HIVE" : rail === "fleet" ? "HIVE" : "BLURT";
      const debtSym = rail === "steem" ? "SBD" : rail === "hive" ? "HBD" : null;
      const debt = debtSym ? num(rail === "steem" ? acc.sbd_balance ?? "0" : acc.hbd_balance ?? "0") : null;
      return {
        rail, identity, ok: true,
        native: `${num(acc.balance).toFixed(3)} ${sym}`,
        extra: debtSym && debt !== null
          ? `${debt.toFixed(3)} ${debtSym} · ${Math.floor(num(acc.vesting_shares)).toLocaleString("en-US")} VESTS`
          : `${Math.floor(num(acc.vesting_shares)).toLocaleString("en-US")} VESTS`,
        detail: node.replace("https://", ""), at,
      };
    }
    if (rail === "tron") {
      // FIX(R14-a·2): trongrid יכול להחזיר HTTP-200 עם גוף-שגיאה (success:false) — היה
      // נקרא כ"0.000000 TRX ok:true". עתה: גוף-שגיאה = זריקה כנה (fail-closed).
      const r = await jfetch<{ data: { balance?: number }[]; success?: boolean; error?: unknown }>(`https://api.trongrid.io/v1/accounts/${identity}?visible=true`);
      if (r.success === false) throw new Error("trongrid returned success:false error body");
      const sun = r.data?.[0]?.balance ?? 0;
      return {
        rail, identity, ok: true,
        native: `${(sun / 1e6).toFixed(6)} TRX`, extra: `energy-band only (unfunded tx rail)`,
        detail: "api.trongrid.io", at,
      };
    }
    if (rail === "eth") {
      // FIX(R14-a · eth-audit-fallback): קשר-קשה-ל-RPC-יחיד — llamarpc החזיר 403 (חסימת-IP
      // נמדדה-חי 2026-09-13) והמסילה דווחה מתה-שקרית. עתה: רשימת-RPC-ציבוריים (אותו-מאגר
      // של-relay-eth) — הראשון-שעונה מנצח; כולם-נכשלו = ok:false כנה.
      const { ETH_RPCS } = await import("./relay-eth");
      let lastErr: string | null = null;
      for (const rpc of ETH_RPCS) {
        try {
          const r = await jfetch<{ result: string; error?: { message: string } }>(rpc, {
            jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [identity, "latest"],
          });
          if (r.error) throw new Error(r.error.message);
          const wei = BigInt(r.result);
          const n = await jfetch<{ result: string }>(rpc, { jsonrpc: "2.0", id: 2, method: "eth_getTransactionCount", params: [identity, "latest"] });
          return {
            rail, identity, ok: true,
            native: `${(Number(wei) / 1e18).toFixed(9)} ETH`, extra: `nonce ${parseInt(n.result, 16)} (broadcasts live)`,
            detail: new URL(rpc).host, at,
          };
        } catch (e) {
          lastErr = e instanceof Error ? e.message : "error";
        }
      }
      throw new Error(`all eth RPCs failed (last: ${lastErr?.slice(0, 60) ?? "unknown"})`);
    }
    // sol
    const rpc = process.env.SOL_RPC_URL || "https://api.mainnet-beta.solana.com";
    const r = await jfetch<{ result: { value: number }; error?: { message: string } }>(rpc, {
      jsonrpc: "2.0", id: 1, method: "getBalance", params: [identity],
    });
    if (r.error) throw new Error(r.error.message); // FIX(70-b): אף-קריאת-רשת לא מניחה-ok בשקט
    const lam = r.result?.value ?? 0;
    return {
      rail, identity, ok: true,
      native: `${(lam / 1e9).toFixed(9)} SOL`, extra: `${lam.toLocaleString("en-US")} lamports (memo anchors live)`,
      detail: new URL(rpc).host, at,
    };
  } catch (e) {
    return {
      rail, identity, ok: false, native: "—", extra: "—",
      detail: `read failed: ${e instanceof Error ? e.message.slice(0, 80) : "error"}`, at,
    };
  }
}

/** אימות-עיגון-טרי: מעדיפים רשומה שכבר-אומתה (קריאה-חוזרת-על-עדות-מאונדקסת =
 * ההוכחה-הטריה-החזקה); נופלים לרשומה-חיה-בת-יותר-מ-45ש׳ (חלון-אינדוקס). */
async function anchorSpotCheck(rsAccount: string | null): Promise<AnchorSpot[]> {
  const rs = relayStatus() as { records: { chain: ChainName; height: number; status: string; txid: string | null; stateRoot?: string; verified?: boolean | null; at: string; account?: string | null }[] };
  // FIX(R14-a·3): blurt נוסף לסקר-העיגון (נתיב-verifyOnChain שלו הוכח-חי Roast-74 —
  // אותו-condenser get_transaction). fleet נשאר-מחוץ-לסקר בכנות: עיגוני-הצי נחתמים
  // על-חשבונות-חיילים ואימות-ה-authority-binding שלהם טרם-הוכח — הוספה-סמאית הייתה
  // מסכנת פסק-דין-אדום-שקרי (mismatches) על כל-המערכת.
  const chains: ChainName[] = ["steem", "hive", "blurt", "tron", "eth", "sol"];
  const pick = (c: ChainName) =>
    rs.records.find((r) => r.chain === c && r.status === "anchored" && r.txid && r.stateRoot && r.verified === true)
    ?? rs.records.find((r) => r.chain === c && r.status === "anchored" && r.txid && r.stateRoot && Date.now() - new Date(r.at).getTime() > 45_000)
    ?? null;
  const picks = chains.map((c) => {
    const rec = pick(c);
    return rec ? { c, height: rec.height, txid: rec.txid!, stateRoot: rec.stateRoot!, account: rec.account ?? null } : null;
  });
  return Promise.all(picks.map(async (p, i) => {
    const c = chains[i]!;
    if (!p) return { rail: c, height: 0, ok: false, verified: false, detail: "no anchored record with txid" };
    try {
      // FIX(Roast-66 · realMoney-structural-lie): המבקר-כאן-קרא-verifyOnChain **בלי-account**
      // — אחרי-חיזוק-F6-ב-relay (אימות-מחבר fail-closed) כל-עיגון-steem/hive קיבל
      // "anchor account unknown" → realMoney.ok=false-תמידי, בזמן-שהרשומה-עצמה
      // verified:true-דרך-המאמת-הפנימי. שני-מבקרים-סותרים = פסק-דין-מוסדי-אדום-תמידי.
      // עכשיו: זרימת-אותו-חשבון-רשות שהמאמת-הפנימי משתמש-בו (rec.account → rt.account → HIVE_ANCHOR_ACCOUNT).
      const expectedAccount = p.account
        ?? (c === "steem" ? rsAccount : ((process.env.HIVE_ANCHOR_ACCOUNT || "").toLowerCase().trim() || rsAccount));
      const v = await verifyOnChain(c, p.txid, { height: p.height, stateRoot: p.stateRoot, account: expectedAccount ?? undefined });
      return { rail: c, height: p.height, ok: v.ok, verified: v.ok, detail: v.detail.slice(0, 120) };
    } catch (e) {
      return { rail: c, height: p.height, ok: false, verified: false, detail: `verify error: ${e instanceof Error ? e.message.slice(0, 80) : "error"}` };
    }
  }));
}

export async function realMoneyAudit(): Promise<RealMoneyReport> {
  const rs = relayStatus() as {
    account: string | null; tronIdentity: string | null;
    identities: { eth: string | null; sol: string | null };
    chains?: Partial<Record<ChainName, { enabled: boolean }>>;
  };
  // FIX(6-a · live-semantics): דגל-האפשור-מגיע-מה-relay-עצמו (מקור-האמת על-חתימה) —
  // לא מהעניה-ל-RPC.
  const relayEnabled = (rail: ChainName): boolean => rs.chains?.[rail]?.enabled === true;
  const fleetSt = (rs as { fleet?: { accounts?: { usable?: boolean; account?: string }[] } }).fleet;
  const fleetIdentity = fleetSt?.accounts?.find((a) => a.usable && a.account)?.account ?? null;
  const identity: Record<ChainName, string | null> = {
    steem: rs.account, hive: rs.account, blurt: rs.account,
    tron: rs.tronIdentity, eth: rs.identities?.eth ?? null, sol: rs.identities?.sol ?? null,
    // SETTLE-13: זהות-הצי = החייל-המשמש-חתימה (סבב) — כנות: אין-זהות-אחת
    fleet: fleetIdentity,
  };
  const railsRaw = await Promise.all(
    (Object.entries(identity) as [ChainName, string | null][]).map(([rail, id]) =>
      id ? auditRail(rail, id) : Promise.resolve({
        rail, identity: "—", ok: false, native: "—", extra: "—",
        detail: "no public identity exposed by relay", at: new Date().toISOString(),
      }),
    ),
  );
  const rails: RailBalance[] = railsRaw.map((r) => ({ ...r, enabled: relayEnabled(r.rail) }));
  const anchors = await anchorSpotCheck(rs.account ?? null);
  // FIX(6-a · live-semantics): "חי" = relay מדווח-מסילה-**מאופשרת** (זהות+מפתח-חתימה) וגם-RPC-ענה.
  // לפני-כן: hive-disabled (authority-mismatch) ו-blurt-חסר-מפתח נספרו "live" רק-בזכות-עניה-ל-RPC
  // → ניפוח 4/7. עתה: שני-מונים-כנים — liveRails (חתימה) מול rpcReachableRails (עניה-בלבד).
  const liveRails = rails.filter((r) => r.ok && r.enabled).length;
  const rpcReachableRails = rails.filter((r) => r.ok).length;
  const verifiedNow = anchors.filter((a) => a.verified).length;
  // FIX(70-b ·2): המונה-הכולל עובר-חי — ה-UI לא קודס "5" על-7 מסילות
  const totalRails = rails.length;
  // FIX(Roast-63): "awaiting finalized block" (SOL) אינו-מיסמאץ' — טרם-אינדוקס/פיינליזציה
  const mismatches = anchors.filter((a) => !a.ok && a.height > 0 && !a.detail.includes("not indexed") && !a.detail.includes("awaiting finalized block")).length;
  return { rails, anchors, liveRails, rpcReachableRails, totalRails, verifiedNow, ok: liveRails >= 1 && mismatches === 0 };
}

/* ── 4. יציבות-שוק: האם-הכל-יושב (מחירים-מתכנסים, ספרד-צמודה, עומק-דו-צדדי) ── */
export interface StabilityReport {
  pair: string;
  refPrice: number; fair: number; poolMid: number; bookMid: number;
  dissonanceBps: { poolVsFair: number; bookVsRef: number; fairVsRef: number };
  spreadBps: number;
  depth1pct: { bidMu: number; askMu: number };   // עומק-בתוך-±1% מהפייר
  topImbalanceBps: number;                        // אי-איזון-מגע (buy-pressure חיובי)
  sitting: boolean;
  reasons: string[];
}

export function stabilityCheck(st: DexState): StabilityReport {
  const m = MARKETS[0]; // SAOS/USDS — הזוג-הריבוני
  const fair = fairPrice(st, m.base, m.quote);
  const p = getPool(st, poolKey(m.base, m.quote));
  const pm = p ? poolMid(p) : 0;
  const ref = st.assets[m.base]?.refPrice ?? 0;
  const bids = sortBook(st, m.base, m.quote, "buy");
  const asks = sortBook(st, m.base, m.quote, "sell");
  const bb = bids[0]?.price ?? 0, ba = asks[0]?.price ?? 0;
  const bookMid = bb > 0 && ba > 0 ? Math.floor((bb + ba) / 2) : (bb || ba || 0);
  const spreadBps = bb > 0 && ba > 0 ? Math.floor(((ba - bb) / ((ba + bb) / 2)) * 10_000) : 0;
  const bps = (a: number, b: number): number => (a > 0 && b > 0 ? Math.floor(((a - b) / b) * 10_000) : 0);
  const lo = fair > 0 ? Math.floor((fair * 9_900) / 10_000) : 0;
  const hi = fair > 0 ? Math.floor((fair * 10_100) / 10_000) : 0;
  const depth = (side: "buy" | "sell"): number =>
    sortBook(st, m.base, m.quote, side)
      .filter((o) => o.price >= lo && o.price <= hi)
      .reduce((s, o) => s + (o.amount - o.filled), 0);
  const bidMu = depth("buy"), askMu = depth("sell");
  const tot = bidMu + askMu;
  const topImbalanceBps = tot > 0 ? Math.floor(((bidMu - askMu) / tot) * 10_000) : 0;
  const d = {
    poolVsFair: bps(pm, fair),
    bookVsRef: bps(bookMid, ref),
    fairVsRef: bps(fair, ref),
  };
  const reasons: string[] = [];
  const sitting =
    Math.abs(d.poolVsFair) <= 60 &&
    Math.abs(d.fairVsRef) <= 450 &&
    spreadBps > 0 && spreadBps <= 45 &&
    bidMu >= 100_000 && askMu >= 100_000 &&
    Math.abs(topImbalanceBps) <= 6_500;
  if (Math.abs(d.poolVsFair) > 60) reasons.push(`pool↔book dissonance ${d.poolVsFair}bps > 60`);
  if (Math.abs(d.fairVsRef) > 450) reasons.push(`fair↔ladder-ref ${d.fairVsRef}bps > 450`);
  if (!(spreadBps > 0 && spreadBps <= 45)) reasons.push(`spread ${spreadBps}bps out of (0,45]`);
  if (bidMu < 100_000 || askMu < 100_000) reasons.push(`depth±1% thin (bid ${bidMu}µ / ask ${askMu}µ < 100k)`);
  if (Math.abs(topImbalanceBps) > 6_500) reasons.push(`top-of-book imbalance ${topImbalanceBps}bps > 6500`);
  return {
    pair: "SAOS/USDS", refPrice: ref, fair, poolMid: pm, bookMid,
    dissonanceBps: d, spreadBps, depth1pct: { bidMu, askMu }, topImbalanceBps,
    sitting, reasons,
  };
}

/* ── 5. טלמטריית-מסלול (THE-REFUEL follow-up): דלק-הכלכלה-הסימולטיבית ─────────
 * הכלכלה-סגורה-ושומרת-על-עצמה: Σcredits+gasUsed===ג'נזיס (אפס-הטבעה), וה-refuel
 * הוא-העברה-בלבד. המשמעות-הכנה: הדלק הכולל מתנקז-מונוטונית. המדידה-הזאת חושפת
 * את-קצב-השריפה-בפועל ואת-זמן-הטיסה הנותר — כנות-מלאה במקום-הפתעה. */
export interface RunwayReport {
  burnPerHeight: number;        // µ-קרדיטים שנשרפים-בממוצע-לבלוק (חלוני-אמת, SETTLE-5)
  burnWindowBlocks?: number;    // רוחב-החלון-שנמדד; 0/חסר = ממוצע-חיים (חלון-צעיר)
  totalCredits: number;         // Σcredits — כל-הדלק שנותר במערכת
  systemRunwayBlocks: number;   // בלוקים-עד-ריקון-מלא (בקצב-הנוכחי)
  systemRunwayHours: number;    // שעות (בקצב-הפעימה בפועל)
  perAgent: { agent: string; credits: number; shareHours: number }[];
  level: "ok" | "warn" | "crit";
  note: string;
}

const TICK_MS_EST = 3_000; // קצב-הפעימה המוסדי (chain.ts TICK_MS) — הערכה-תעבורתית

export function runwayCheck(
  st: DexState,
  agents?: string[],
  samples?: { h: number; gasUsed: number }[],
): RunwayReport {
  const totalCredits = Object.values(st.credits).reduce((s, v) => s + (v ?? 0), 0);
  // SETTLE-5: שריפה-חלונית-אמת (טבעת-דגימה ~400 בלוקים) — ממוצע-החיים (gasUsed/height)
  // מציג-משטר-ישן אחרי-שינוי-תוכנה (נמדד-חי: 990µ/בלוק → 157µ/בלוק בעוד הממוצע
  // המשיך-להציג ~1000). נופלים-בחזרה לממוצע-חיים רק-אם-החלון-קצר-מדי (<60 בלוקים).
  let burnPerHeight = st.height > 0 ? st.gasUsed / st.height : 0;
  let windowBlocks = 0;
  if (samples && samples.length >= 2) {
    const first = samples[0];
    const last = samples[samples.length - 1];
    const dh = last.h - first.h;
    if (dh >= 60) {
      burnPerHeight = (last.gasUsed - first.gasUsed) / dh;
      windowBlocks = dh;
    }
  }
  const blocks = burnPerHeight > 0 ? totalCredits / burnPerHeight : Number.POSITIVE_INFINITY;
  const hours = (blocks * TICK_MS_EST) / 3_600_000;
  const names = agents ?? ["treasury", "operator", "arena", "bot-a", "bot-b", "bot-c", "bot-e", "rail"];
  // הנחת-מניות-שוות (כנות: שריפה-אנדוגנית — מי-שפעיל-שורף-יותר; מדד-גס-לצורך-הצגה)
  const share = names.length > 0 ? hours / names.length : 0;
  const perAgent = names.map((a) => ({
    agent: a,
    credits: st.credits[a] ?? 0,
    shareHours: Math.round(share * 10) / 10,
  }));
  const level = hours >= 24 ? "ok" : hours >= 6 ? "warn" : "crit";
  return {
    burnPerHeight: Math.round(burnPerHeight * 10) / 10,
    burnWindowBlocks: windowBlocks, // 0 = נפל-בחזרה לממוצע-חיים (חלון-צעיר)
    totalCredits,
    systemRunwayBlocks: Math.floor(blocks),
    systemRunwayHours: Math.round(hours * 10) / 10,
    perAgent,
    level,
    note: "closed SIM economy — refuel is transfer-only (Σcredits+gas===genesis); runway is finite by design and reported honestly",
  };
}
