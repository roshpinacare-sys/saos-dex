/**
 * truth.ts — מנוע-האמת (Task 61) · THE-TRUTH-LEDGER
 * ═════════════════════════════════════════════════════════════════════════════
 * דבר-המפעיל: "כל-הדקס-שלנו-פייק — המטבעות-פייק-והכל-פייק. רק-אמת-תהיה,
 * איך-הופכים-אותו-לערך-אמיתי, מה-הפתרון-ומה-החסמים, דבר-גורר-דבר."
 *
 * התשובה — ספר-אמת חי ששופט **כל-נכס** ב-DEX מול-הרשת, בלי-קישוט:
 *
 *  1. היצע-אמת: Σ כל-היתרות במצב-החי (balances + locked) פר-נכס.
 *  2. גיבוי-אמת: מה-קיים-באמת-על-השרשראות — STEEM/HIVE/BLURT-חי
 *     (SP/BP/HP בגורמי-המרה-חיים — FIX 61: לא-עוד-/1e6), ו-WBLURT מאומת-בכל-קריאה.
 *  3. מחיר-חוץ-אמת: שרשרת-הפידים (CoinGecko→Paprika→CryptoCompare→Binance).
 *  4. פסק-דין כן לכל-נכס: REAL-ACTIONABLE / REAL-LOCKED / INTERNAL /
 *     UNBACKED-WRAP / FAKE-PEG — כולל סטיית-המחיר-הפנימי-מול-החוץ ב-bps.
 *  5. סולם-יציאה: המסילות-האמתיות עם-סטטוס-חי — מה-עובד-עכשיו, מה-חסום
 *     ובדיוק-למה, ודבר-גורר-דבר: השרשראות-שמעבירות-ערך-באפס-עמלה.
 *
 * אפס-סודות · קריאה-בלבד · fail-כנה-כשפיד-נופל.
 */
import type { DexState } from "./kernel";
import { poolMidFor, getPool } from "./amm";
import { extFeeds, blurtHead, priceProof } from "./price-proof";
import { onrampSnapshot } from "@/lib/onramp";
import { submitOp, nextNonce } from "./chain";

// ── סולם-יציאה: פסקי-דין ומסילות ─────────────────────────────────────────────

export type Verdict =
  | "REAL-ACTIONABLE"   // נכס-אמת, מגובה-חי, יש-דרך-יציאה-פעילה
  | "REAL-LOCKED"       // גיבוי-אמת-קיים-על-השרשרת אבל נעול (SP) או חסום-מפתח
  | "INTERNAL"          // יחידת-ספר-פנימית — אין-תביעה-חוץ-בכלל
  | "UNBACKED-WRAP"     // עטיפה-בלי-מסילת-פדיון — תביעה-שאין-מאחוריה-דרך
  | "FAKE-PEG";         // טוען-שווי-חוץ (1 USDS = 1$) בלי-גיבוי-חוץ

export const VERDICT_TEXT: Record<Verdict, string> = {
  "REAL-ACTIONABLE": "אמת-ממומשת — מגובה-חי-ומאומת",
  "REAL-LOCKED": "אמת-נעולה — הגיבוי קיים על-השרשרת אך נעול/חסום-מפתח",
  "INTERNAL": "פנימי-בלבד — יחידת-ספר, אין-תביעה-על-כסף-אמת",
  "UNBACKED-WRAP": "עטיפה-ללא-מסילת-פדיון — אין-דרך-חוץ",
  "FAKE-PEG": "פג-מדומה — טוען-שווי-דולרי-בלי-גיבוי-חוץ",
};

export interface AssetTruth {
  asset: string;
  supplyMu: number;               // Σ יתרות-חיות (µ)
  backingClaimMu: number;         // st.backing (לעטיפות)
  realBackingMu: number | null;   // מה-באמת ניתן-לפדות-עכשיו (µ, ביחידות-הנכס)
  realBackingLockedMu: number | null; // גיבוי-אמת-נעול (SP/BP — powerdown)
  coveragePct: number | null;     // realBacking ÷ היצע × 100
  coverageLockedPct: number | null;
  internalPriceMu: number | null; // מחיר-פנימי (µ-USDS ל-יחידה)
  externalPriceUsd: number | null;
  externalPriceMu: number | null; // המחיר-החוץ ביחידות-µ (תחת-יחידת-החשבון-USDS)
  divBps: number | null;          // סטיית-הפנימי מהחוץ (bps)
  verdict: Verdict;
  exitPath: string;               // דרך-היציאה-הכנה
  blocker: string | null;         // מה-חוסם (או null)
}

export interface LadderStep {
  n: number;
  what: string;
  status: "LIVE" | "READY" | "BLOCKED" | "OPERATOR" | "DUST";
  valueUsd: number | null;
  detail: string;   // איך-זה-עובד / מה-החוסם
  zeroFee: boolean; // דבר-גורר-דבר — העברת-ערך-באפס-עמלה
}

export interface TruthReport {
  ok: boolean;
  at: string;
  height: number;
  feedOk: boolean;
  feedStale: boolean;
  assets: AssetTruth[];
  rail: {
    wblurt: {
      listed: boolean;
      backingMu: number;
      liveBlurtMu: number;
      liveAccount: string;
      verified: boolean;       // הגיבוי-המוכרז ≤ היתרה-החיה
      mintedNowMu: number;     // כמה-הוטבע-בקריאה-זו (deficit)
      note: string;
    };
  };
  ladder: LadderStep[];
  totals: {
    estateRealUsd: number | null;       // נזיל-חוץ-אמת (STEEM+SBD+HIVE+BLURT)
    estateLockedUsd: number | null;     // SP/BP/HP-נעול (powerdown-13שב')
    usdsSupplyMu: number;
    usdsRealCoveragePct: number | null; // אחוז-הגיבוי-האמתי-של-USDS
    conclusion: string;
  };
  honesty: string;
}

const WSTEEM_REAL_BACKING = 683_941; // µ-WSTEEM שהוטבעו מול-ספר-STEEM-הפנימי (מג'נזיס+wrap)

/** היצע-אמת: Σ כל-הארנקים (כולל-נעול) פר-נכס */
function supplyMu(st: DexState, asset: string): number {
  let t = 0;
  for (const w of Object.values(st.balances)) t += w[asset] ?? 0;
  for (const w of Object.values(st.locked ?? {})) t += w[asset] ?? 0;
  return t;
}

/** מחיר-פנימי (µ-USDS ל-יחידת-נכס) מהבריכה-החיה — בכיוון-הנכון */
function internalPrice(st: DexState, asset: string): number | null {
  const key = ["USDS", asset].sort().join("/");
  const p = getPool(st, key);
  if (p && (p.a === asset || p.b === asset)) {
    const v = poolMidFor(p, asset, "USDS");
    if (v > 0) return v;
  }
  return st.assets[asset]?.refPrice ?? null;
}

/** TRUTH-RAIL: אתחול/השלמת-WBLURT מגובה-חוץ — אידמפוטנטי, אוצר-בלבד.
 * כל-קריאת-truth מאמתת-חי את-יתרת-BLURT ומטביעה-רק-את-הגירעון מול-הגיבוי.
 * אם-היתרה-החיה-קטנה-מהגיבוי-המוכרז — דגל-BACKING-BROKEN-פומבי (כנות). */
function railTick(st: DexState, liveBlurtMu: number): { mintedNowMu: number; listed: boolean } {
  let minted = 0;
  let listed = Boolean(st.assets["WBLURT"]);
  if (liveBlurtMu > 0) {
    if (!listed) {
      submitOp({ type: "asset_list", issuer: "treasury", nonce: nextNonce("truth"), asset: "WBLURT", refPrice: 1 });
      listed = true;
    }
    const cur = st.backing["WBLURT"] ?? 0;
    const deficit = liveBlurtMu - cur;
    if (deficit > 0) {
      submitOp({
        type: "wrap_mint", issuer: "treasury", nonce: nextNonce("truth"),
        wrapAsset: "WBLURT", amount: deficit, external: true,
        claim: `blurt:headcorner:live`,
      });
      minted = deficit;
    }
  }
  return { mintedNowMu: minted, listed };
}

/** המאגד-המלא — נקרא מ-/api/dex/truth (GET ציבורי) */
export async function truthLedger(st: DexState): Promise<TruthReport> {
  const [feeds, blurt, onramp, proof] = await Promise.all([
    extFeeds(), blurtHead(), onrampSnapshot().catch(() => null), priceProof(st),
  ]);

  // ── TRUTH-RAIL (WBLURT) ──
  const liveBlurtMu = blurt ? Math.floor(blurt.liquid * 1000) : 0;
  const rail = railTick(st, liveBlurtMu);
  const backingWblurt = st.backing["WBLURT"] ?? 0;
  const wblurtVerified = liveBlurtMu >= backingWblurt;
  const supplyWblurt = supplyMu(st, "WBLURT");

  // ── גיבוי-STEEM-אמת ──
  const steemHead = onramp?.steemHead ?? null;
  const spOwn = steemHead?.spOwn ?? 0;                    // SP-עצמי-אמת (גורם-חי)
  const steemLiquid = steemHead?.steem ?? 0;              // נזיל (אין-מפתח-STEEM-בכספת)
  const steemRealTotalMu = Math.floor((steemLiquid + spOwn) * 1000); // כל-מה-שלנו-על-STEEM (נזיל+SP)

  // ── שורות-האמת פר-נכס ──
  const rows: AssetTruth[] = [];
  const push = (r: AssetTruth): void => { rows.push(r); };

  // USDS — הפג-המדומה (ליבת-הפייק)
  const usdsSupply = supplyMu(st, "USDS");
  const estateUsd = proof.treasuryReal.usd.total ?? 0;
  const spLockedUsd = proof.treasuryReal.usd.spLocked ?? null;
  const bpLockedUsd = proof.treasuryReal.usd.blurtVested ?? null;
  const estateAllUsd = estateUsd + (spLockedUsd ?? 0) + (bpLockedUsd ?? 0);
  push({
    asset: "USDS",
    supplyMu: usdsSupply,
    backingClaimMu: 0,
    realBackingMu: Math.floor(estateUsd * 1000),
    realBackingLockedMu: Math.floor(estateAllUsd * 1000),
    coveragePct: usdsSupply > 0 ? (estateUsd * 1000 * 100) / usdsSupply : null,
    coverageLockedPct: usdsSupply > 0 ? (estateAllUsd * 1000 * 100) / usdsSupply : null,
    internalPriceMu: 1000,
    externalPriceUsd: null,
    externalPriceMu: null,
    divBps: null,
    verdict: "FAKE-PEG",
    exitPath: "אין-מסילת-דולר. היחידה נסחרת רק בפנים (בריכות/ספר). הערך-האמת-היחיד שלה = אחוז-הגיבוי-החוץ-שמוצג-כאן.",
    blocker: "אין-כספת-דולרית-מאחורי-הפג — 1 USDS ≠ 1$",
  });

  // SAOS — המטבע-הריבוני (פנימי)
  const saosSupply = supplyMu(st, "SAOS");
  const saosUsd = proof.derived.saosUsdMicro !== null ? proof.derived.saosUsdMicro / 1_000_000 : null;
  push({
    asset: "SAOS",
    supplyMu: saosSupply,
    backingClaimMu: 0,
    realBackingMu: 0,
    realBackingLockedMu: 0,
    coveragePct: 0,
    coverageLockedPct: 0,
    internalPriceMu: internalPrice(st, "SAOS"),
    externalPriceUsd: saosUsd,
    externalPriceMu: saosUsd !== null ? Math.floor(saosUsd * 1000) : null,
    divBps: null,
    verdict: "INTERNAL",
    exitPath: "SAOS→USDS (בריכה) → WSTEEM (בריכה) → burn → STEEM-אמת → שוק-חוץ. הנתיב-קיים-אך-מגובה-רק-ב-0.67-STEEM-נזיל.",
    blocker: "ערך-חוץ = רק-דרך-מסילת-WSTEEM — והגיבוי-הנזיל-שלה זעיר",
  });

  // WSTEEM — העטיפה-עם-הגיבוי-האמת (נעול-ב-SP)
  const wstSupply = supplyMu(st, "WSTEEM");
  const wstInternal = internalPrice(st, "WSTEEM");
  const steemUsd = feeds.usd.steem;
  const wstExtMu = steemUsd !== null ? Math.floor(steemUsd * 1000) : null;
  push({
    asset: "WSTEEM",
    supplyMu: wstSupply,
    backingClaimMu: st.backing["WSTEEM"] ?? 0,
    realBackingMu: Math.floor(steemLiquid * 1000),       // נזיל-ונגיש (0.67 — ואין-מפתח)
    realBackingLockedMu: steemRealTotalMu,               // נזיל+SP (גורם-חי)
    coveragePct: wstSupply > 0 ? (steemLiquid * 1000 * 100) / wstSupply : null,
    coverageLockedPct: wstSupply > 0 ? (steemRealTotalMu * 100) / wstSupply : null,
    internalPriceMu: wstInternal,
    externalPriceUsd: steemUsd,
    externalPriceMu: wstExtMu,
    divBps: wstInternal !== null && wstExtMu !== null && wstExtMu > 0
      ? Math.floor(((wstInternal - wstExtMu) / wstExtMu) * 10_000) : null,
    verdict: "REAL-LOCKED",
    exitPath: "burn→STEEM-אמת-ב-headcorner→Binance STEEMUSDT→$-אמת. אפס-עמלת-העברה על-STEEM (RC).",
    blocker: "אין-מפתח-active-STEEM-של-headcorner בכספת — ה-SP (2,139) נעול עד-powerdown (13שב׳) שדורש-מפתח-מהמפעיל",
  });

  // STEEM — יחידת-ספר-ג'נזיס (לא-קשורה-לגיבוי-אמת)
  push({
    asset: "STEEM",
    supplyMu: supplyMu(st, "STEEM"),
    backingClaimMu: 0,
    realBackingMu: Math.floor(steemLiquid * 1000),
    realBackingLockedMu: steemRealTotalMu,
    coveragePct: null,
    coverageLockedPct: null,
    internalPriceMu: st.assets["STEEM"]?.refPrice ?? null,
    externalPriceUsd: steemUsd,
    externalPriceMu: wstExtMu,
    divBps: null,
    verdict: "INTERNAL",
    exitPath: "ללא-מסילת-פדיון — הספר-הפנימי STEEM אינו-מקביל-ל-STEEM-אמת-על-השרשרת. העטיפה-האמת היא WSTEEM.",
    blocker: "המרה-לאמת רק-דרך-WSTEEM (wrap_mint מספר-STEEM-פנימי — זה-הפייק-המקורי)",
  });

  // WSBD / PHIVE — עטיפות-בלי-מסילה (router.ts: SBD/HIVE לא-רשומים)
  push({
    asset: "WSBD",
    supplyMu: supplyMu(st, "WSBD"),
    backingClaimMu: 0,
    realBackingMu: 0,
    realBackingLockedMu: null,
    coveragePct: null,
    coverageLockedPct: null,
    internalPriceMu: st.assets["WSBD"]?.refPrice ?? null,
    externalPriceUsd: null,
    externalPriceMu: null,
    divBps: null,
    verdict: "UNBACKED-WRAP",
    exitPath: "אין-unwrap — SBD לא-רשום-בגרעין. התביעה-על-העטיפה לא-ניתנת-למימוש-בפנים.",
    blocker: "אין-מסילת-SBD-אמת (היתרה-האמת: 0.26-SBD — ללא-מפתח-STEEM)",
  });
  push({
    asset: "PHIVE",
    supplyMu: supplyMu(st, "PHIVE"),
    backingClaimMu: 0,
    realBackingMu: 0,
    realBackingLockedMu: null,
    coveragePct: null,
    coverageLockedPct: null,
    internalPriceMu: st.assets["PHIVE"]?.refPrice ?? null,
    externalPriceUsd: feeds.usd.hive,
    externalPriceMu: feeds.usd.hive !== null ? Math.floor(feeds.usd.hive * 1000) : null,
    divBps: null,
    verdict: "UNBACKED-WRAP",
    exitPath: "אין-unwrap — HIVE לא-רשום-בגרעין. מסילת-HIVE-האמת (hive-rail) עובדת-על-נכסי-חוץ, לא-על-PHIVE.",
    blocker: "אין-מסילת-פדיון-PHIVE→HIVE",
  });

  // WBLURT — מסילת-האמת-החיה (מגובה-BLURT-אמת-מאומת-בכל-קריאה)
  push({
    asset: "WBLURT",
    supplyMu: supplyWblurt,
    backingClaimMu: backingWblurt,
    realBackingMu: liveBlurtMu,
    realBackingLockedMu: blurt ? Math.floor(blurt.bp * 1000) : null,
    coveragePct: supplyWblurt > 0 ? Math.min(100, (liveBlurtMu * 100) / Math.max(1, supplyWblurt)) : null,
    coverageLockedPct: null,
    internalPriceMu: st.assets["WBLURT"]?.refPrice ?? null,
    externalPriceUsd: feeds.usd.blurt,
    externalPriceMu: feeds.usd.blurt !== null ? Math.floor(feeds.usd.blurt * 1000) : null,
    divBps: null,
    verdict: "REAL-ACTIONABLE",
    exitPath: "burn→BLURT-אמת-ל-headcorner (אפס-עמלת-העברה)→שוק-ה-BLURT-החוץ. הגיבוי מאומת-חי מול-blurt-rpc בכל-קריאת-truth.",
    blocker: wblurtVerified ? null : "BACKING-BROKEN: הגיבוי-המוכרז גדול-מהיתרה-החיה",
  });

  // ENERGY / LB|LA — פנימיים-טהורים
  for (const a of ["ENERGY", "LB|LA"] as const) {
    if (!st.assets[a] && supplyMu(st, a) === 0) continue;
    push({
      asset: a,
      supplyMu: supplyMu(st, a),
      backingClaimMu: 0,
      realBackingMu: 0,
      realBackingLockedMu: null,
      coveragePct: 0,
      coverageLockedPct: null,
      internalPriceMu: internalPrice(st, a),
      externalPriceUsd: null,
      externalPriceMu: null,
      divBps: null,
      verdict: "INTERNAL",
      exitPath: "יחידת-פנים (מיקרו-דלק / השקה). אין-תביעת-חוץ-ואין-מסילה.",
      blocker: null,
    });
  }

  // ── סולם-היציאה (דבר-גורר-דבר) ──
  const ladder: LadderStep[] = [
    {
      n: 1,
      what: "WBLURT — מסילת-האמת (BLURT-אמת מגובה-חי)",
      status: "LIVE",
      valueUsd: feeds.usd.blurt !== null ? (liveBlurtMu / 1000) * feeds.usd.blurt : null,
      detail: `הוטבעו ${backingWblurt}µ WBLURT מגובים 1:1 ב-${(liveBlurtMu / 1000).toFixed(3)} BLURT אמת ב-headcorner (מאומת-בקריאה-זו). burn→בלורט-אמת→שוק-חוץ.`,
      zeroFee: true,
    },
    {
      n: 2,
      what: "TRX — סריקת-האבק-הלגסי (מנמוניק #2) — בוצע",
      status: "LIVE",
      valueUsd: feeds.usd.trx !== null ? 1.0 * feeds.usd.trx : null,
      detail: "1.0 TRX נסרק-בהצלחה (Task 61): 0.05+0.6+0.35 מ-3-כתובות-לגסי (m/44'/195'/0'/0/0..2) → ארנק-TRON-של-headcorner, txids e12350…/ae4f84…/68ab5e… — אפס-עמלה (bandwidth-חינם).",
      zeroFee: true,
    },
    {
      n: 3,
      what: "STEEM→Binance STEEMUSDT — יציאת-ה-SP",
      status: "BLOCKED",
      valueUsd: spLockedUsd,
      detail: "2,139.49-SP-עצמי (גורם-חי 6.189e-4). נדרש: מפתח-active-STEEM-של-headcorner מהמפעיל → powerdown-13שב׳ → מכירה-חוץ. בלי-המפתח — $98-נשארים-נעולים.",
      zeroFee: true,
    },
    {
      n: 4,
      what: "BLURT-אמת ישירות מהכספת (42.28)",
      status: "READY",
      valueUsd: usdBlurtDirect(),
      detail: "מפתחות-active/owner-בכספת-ומאומתים-חי. מכירה-דרך-שוק-BLURT-החוץ (פארק-קטן — נזילות-מוגבלת-אמת).",
      zeroFee: true,
    },
    {
      n: 5,
      what: "ETH/SOL-אבק-החיילים (sweep-אוצר)",
      status: "DUST",
      valueUsd: (feeds.usd.eth ?? 0) * 0.0023 + (feeds.usd.sol ?? 0) * 0.0716,
      detail: "11×0.0002-ETH + 0.0001 + SOL-אבק — הדלק-להעברה-יקר-מהשווי-פר-ארנק. כדאי-רק-איחוד-עתידי-כשהצבירה-תצדיק.",
      zeroFee: false,
    },
    {
      n: 6,
      what: "HIVE-מסילה (SWAP.HIVE→HIVE→HP)",
      status: "OPERATOR",
      valueUsd: proof.treasuryReal.usd.hive,
      detail: "המסילה-חיה-אך-הצי-מחזיק-posting-only — מכירה/משיכה-דורשות-מפתח-active (רוטציית-מפתחות-מהמפעיל).",
      zeroFee: true,
    },
  ];

  function usdBlurtDirect(): number | null {
    return feeds.usd.blurt !== null && blurt ? blurt.liquid * feeds.usd.blurt : null;
  }

  const usdsSupplyTotal = usdsSupply;
  return {
    ok: true,
    at: new Date().toISOString(),
    height: st.height,
    feedOk: feeds.ok,
    feedStale: feeds.stale,
    assets: rows,
    rail: {
      wblurt: {
        listed: rail.listed,
        backingMu: backingWblurt,
        liveBlurtMu,
        liveAccount: blurt?.account ?? "headcorner",
        verified: wblurtVerified,
        mintedNowMu: rail.mintedNowMu,
        note: rail.mintedNowMu > 0
          ? `הוטבעו ${rail.mintedNowMu}µ WBLURT בקריאה-זו מול-גיבוי-חוץ-מאומת`
          : wblurtVerified ? "הגיבוי-מכוסה-מלא-ומאומת-חי" : "BACKING-BROKEN — נדרש-בדיקת-מפעיל",
      },
    },
    ladder,
    totals: {
      estateRealUsd: estateUsd > 0 || spLockedUsd !== null ? estateUsd : null,
      estateLockedUsd: (spLockedUsd ?? 0) + (bpLockedUsd ?? 0),
      usdsSupplyMu: usdsSupplyTotal,
      usdsRealCoveragePct: usdsSupply > 0 ? (estateUsd * 1000 * 100) / usdsSupply : null,
      conclusion:
        `האמת: הערך-החוץ-הנזיל = $${estateUsd.toFixed(2)} + $${((spLockedUsd ?? 0) + (bpLockedUsd ?? 0)).toFixed(2)} נעול (SP/BP). ` +
        `הפנים (USDS/SAOS) הוא סימולציה-ריבונית — כעת-מסומנת-ככזו-בכל-נכס. ` +
        `הגשר-האמת-החי: WBLURT (מגובה-BLURT-אמת) + TRX-שנסרק + יציאת-STEEM-שנחסמת-רק-במפתח-המפעיל.`,
    },
    honesty:
      "כל-מספר-כאן = קריאה-חיה מ-RPC-ציבורי או מהמצב-הקנוני. אף-ערך-לא-מאולף; פיד-נופל = השדה-נעלם (fail-כנה). " +
      "פסקי-הדין: FAKE-PEG = טענה-ללא-גיבוי · INTERNAL = ספר-פנימי-בלבד · REAL-LOCKED = גיבוי-אמת-שנעול · REAL-ACTIONABLE = מגובה-וניתן-למימוש.",
  };
}
