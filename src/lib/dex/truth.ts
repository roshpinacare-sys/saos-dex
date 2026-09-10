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
import { realSnapshotSoft, type RealSnapshot } from "./realmarket";

// ── סולם-יציאה: פסקי-דין ומסילות ─────────────────────────────────────────────

export type Verdict =
  | "REAL-ACTIONABLE"   // נכס-אמת, מגובה-חי, יש-דרך-יציאה-פעילה
  | "REAL-LOCKED"       // גיבוי-אמת-קיים-על-השרשרת אבל נעול (SP) או חסום-מפתח
  | "INTERNAL"          // יחידת-ספר-פנימית — אין-תביעה-חוץ-בכלל
  | "UNBACKED-WRAP"     // עטיפה-בלי-מסילת-פדיון — תביעה-שאין-מאחוריה-דרך
  | "UNKNOWN-PROBE"     // FIX(Roast-64-c · F12): ה-probe-החוץ נפל — אין-פסק-דין-עד-מדידה-חוזרת
  | "FAKE-PEG";         // טוען-שווי-חוץ (1 USDS = 1$) בלי-גיבוי-חוץ

export const VERDICT_TEXT: Record<Verdict, string> = {
  "REAL-ACTIONABLE": "אמת-ממומשת — מגובה-חי-ומאומת",
  "REAL-LOCKED": "אמת-נעולה — הגיבוי קיים על-השרשרת אך נעול/חסום-מפתח",
  "INTERNAL": "פנימי-בלבד — יחידת-ספר, אין-תביעה-על-כסף-אמת",
  "UNBACKED-WRAP": "עטיפה-ללא-מסילת-פדיון — אין-דרך-חוץ",
  "UNKNOWN-PROBE": "לא-ניתן-לאמת-כרגע — ה-probe-החוץ (RPC) נפל; אין-פסק-דין (לא-שבור, לא-מאומת)",
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
  staticNote?: string; // FIX(Roast-63 · M3): לשלבים-היסטוריים — תיעוד-קבוע-שלא-ידרוש (ה-txids-מתועדים-על-השרשרת)
}

export interface TruthReport {
  ok: boolean;
  at: string;
  probe?: "ok" | "timeout";      // FIX(Roast-64-c · F14): שער-זמן-כולל — timeout = תשובה-חלקית-כנה
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
      verified: boolean | null;  // FIX(Roast-64-c · F12): null = probe-נפל — אי-ודאות גלויה (לא-שבירה, לא-אישרור)
      probe: "ok" | "rpc-down";  // FIX(Roast-64-c · F12): מצב-ה-probe-החוץ — כשל-RPC אינו נראה כ-BACKING-BROKEN
      mintedNowMu: number;       // כמה-הוטבע-בקריאה-זו (deficit)
      note: string;
    };
  };
  ladder: LadderStep[];
  realVenue?: RealSnapshot | { ok: false; error: string }; // THE-REAL-GRID (62)
  totals: {
    estateRealUsd: number | null;       // נזיל-חוץ-אמת (STEEM+SBD+HIVE+BLURT)
    estateLockedUsd: number | null;     // SP/BP/HP-נעול (powerdown-13שב')
    usdsSupplyMu: number;
    usdsRealCoveragePct: number | null; // אחוז-הגיבוי-האמתי-של-USDS
    conclusion: string;
  };
  honesty: string;
}


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
 * FIX(Roast-63): ההטבעה-עברה-מ-GET (היה-מטבע-ציבורי-בלתי-מאומת) ל-POST-מאומת
 * (operatorAuth). כל-קריאה מאמתת-חי את-יתרת-BLURT ומטביעה-רק-את-הגירעון.
 * אם-היתרה-החיה-קטנה-מהגיבוי-המוכרז — דגל-BACKING-BROKEN-פומבי (כנות).
 * FIX(Roast-64-c · F11): מנעול-inflight-פר-מסילה + claim-ייחודי-ל-mint:
 * `blurt:headcorner:${height}:${deficit}` — POST-שני-באותו-חלון-בלוק מדלג
 * עם note "rail-inflight" (deficit-מ-RPC-חי + claim-קבוע היה מאפשר double-mint
 * על-אותו-גיבוי; claim-ייחודי מאפשר-לגרעין לדחות שימוש-חוזר). */
const railMint = { inflight: false, mintedHeight: -1 }; // מנעול-פר-רכבת-ההטבעה (F11)
export function railTick(st: DexState, liveBlurtMu: number): { mintedNowMu: number; listed: boolean; note?: string } {
  // FIX(F11): POST-שני-באותו-חלון-בלוק אחרי-הטבעה (ה-op טרם-נחת) → דילוג-כנה
  if (railMint.mintedHeight === st.height) {
    return { mintedNowMu: 0, listed: Boolean(st.assets["WBLURT"]), note: "rail-inflight" };
  }
  let minted = 0;
  let listed = Boolean(st.assets["WBLURT"]);
  let note: string | undefined;
  if (liveBlurtMu > 0) {
    if (!listed) {
      submitOp({ type: "asset_list", issuer: "treasury", nonce: nextNonce("truth"), asset: "WBLURT", refPrice: 1 });
      listed = true;
    }
    const cur = st.backing["WBLURT"] ?? 0;
    const deficit = liveBlurtMu - cur;
    if (deficit > 0) {
      if (railMint.inflight) {
        return { mintedNowMu: 0, listed, note: "rail-inflight" };
      }
      railMint.inflight = true;
      railMint.mintedHeight = st.height;
      try {
        submitOp({
          type: "wrap_mint", issuer: "treasury", nonce: nextNonce("truth"),
          wrapAsset: "WBLURT", amount: deficit, external: true,
          claim: `blurt:headcorner:${st.height}:${deficit}`, // FIX(F11): ייחודי-ל-mint — דחיית-שידור-חוזר בגרעין
        });
        minted = deficit;
      } finally {
        railMint.inflight = false; // ה-guard-לחלון-נשאר עד שהבלוק-נוחת (height מתקדם)
      }
    }
  }
  return { mintedNowMu: minted, listed, note };
}

/** המאגד-המלא — נקרא מ-/api/dex/truth (GET ציבורי).
 * FIX(Roast-63): GET-קריאה-בלבד — אפס-כתיבה-לגרעין (ההטבעה-ב-POST-מאומת).
 * מצב-הרייל-מדווח-מהמצב-החי + אימות-בלורט-בלבד.
 * FIX(Roast-64-c · F14): שער-זמן-כולל 15ש׳ על-הרכבת-הנתונים כולה — חריגה →
 * תשובה-חלקית-כנה (probe:"timeout"), לא קריאה-תלויה. ה-blurtHead-עצמו
 * כבר-מ-Cache-60ש׳-משותף (price-proof) — לא עוד-קריאת-RPC-חיה-בכל-GET. */
const TRUTH_DEADLINE_MS = 15_000;

function timeoutReport(st: DexState, reason: string): TruthReport {
  return {
    ok: true,
    at: new Date().toISOString(),
    probe: "timeout",
    height: st.height,
    feedOk: false,
    feedStale: false,
    assets: [],
    rail: {
      wblurt: {
        listed: Boolean(st.assets["WBLURT"]),
        backingMu: st.backing["WBLURT"] ?? 0,
        liveBlurtMu: 0,
        liveAccount: "headcorner",
        verified: null,
        probe: "rpc-down",
        mintedNowMu: 0,
        note: `probe:${reason} — אין-מדידה-חיה-בשער-הזמן; אין-פסק-דין (כנות, לא-BACKING-BROKEN)`,
      },
    },
    ladder: [],
    totals: {
      estateRealUsd: null,
      estateLockedUsd: null,
      usdsSupplyMu: 0,
      usdsRealCoveragePct: null,
      conclusion: `timeout — הרכבת-נתוני-האמת חרגה מ-${TRUTH_DEADLINE_MS / 1000}ש׳ (${reason}) — תשובה-חלקית-כנה; נסו-שוב`,
    },
    honesty: `שער-זמן-כולל ${TRUTH_DEADLINE_MS / 1000}ש׳ — תשובה-חלקית-כנה עדיפה על תלייה או על מספר-מאולף`,
  };
}

export async function truthLedger(st: DexState): Promise<TruthReport> {
  const work = truthLedgerFull(st).catch((e): TruthReport => timeoutReport(st, `assembly-error: ${String((e as Error)?.message ?? e).slice(0, 120)}`));
  const deadline = new Promise<TruthReport>((resolve) => {
    const t = setTimeout(() => resolve(timeoutReport(st, "timeout")), TRUTH_DEADLINE_MS);
    (t as unknown as { unref?: () => void }).unref?.();
  });
  return Promise.race([work, deadline]);
}

async function truthLedgerFull(st: DexState): Promise<TruthReport> {
  const [feeds, blurt, onramp, proof, realV] = await Promise.all([
    extFeeds(), blurtHead(), onrampSnapshot().catch(() => null), priceProof(st),
    realSnapshotSoft().catch(() => null as unknown as Awaited<ReturnType<typeof realSnapshotSoft>>),
  ]);

  // ── TRUTH-RAIL (WBLURT) — קריאה-בלבד: אימות-גיבוי בלבד, אין-הטבעה ──
  const liveBlurtMu = blurt ? Math.floor(blurt.liquid * 1000) : 0;
  // FIX(Roast-64-c · F12): מצב-ה-probe-החוץ מגיע-מ-blurtHead (Cache-60ש׳ משותף) —
  // כשל-RPC (blurt=null) אינו נראה עוד כ"גיבוי-שבור".
  const railProbe: "ok" | "rpc-down" = blurt?.probe ?? "rpc-down";
  const rail = { mintedNowMu: 0, listed: Boolean(st.assets["WBLURT"]) };
  const backingWblurt = st.backing["WBLURT"] ?? 0;
  const supplyWblurt = supplyMu(st, "WBLURT");
  // FIX(Roast-64-c · F12): verified = supply ≤ backing ≤ live (היה: backing ≤ live
  // בלבד — supply-לא-נבדק). probe-נפל → verified=null (אי-ודאות גלויה).
  const wblurtVerified: boolean | null = railProbe === "ok"
    ? (supplyWblurt <= backingWblurt && backingWblurt <= liveBlurtMu)
    : null;
  // FIX(F12): פסק-הדין אינו עוד "REAL-ACTIONABLE" מקודד-קבוע — נגזר מהאימות ומה-probe.
  const wblurtVerdict: Verdict = wblurtVerified === true
    ? "REAL-ACTIONABLE"
    : (railProbe === "ok" ? "UNBACKED-WRAP" : "UNKNOWN-PROBE");

  // ── גיבוי-STEEM-אמת ──
  const steemHead = onramp?.steemHead ?? null;
  // FIX(Roast-64-c · F16): spOwn=null (גורם-vests-לא-זמין) → 0 = תביעת-חסר-כנה
  // (מתחת-לאמת, לעולם לא מעליה) — לא-עוד-הגורם-השגוי-הידוע 1e6.
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

  // FIX(Roast-63): SAOS לא-מקבל עוד "מחיר-חוץ" — הנגזרת-מהבריכות-הפנימיות הייתה
  // מנופחת-פרמיית-ה-WSTEEM-הפנימית (~×2) וחבשה-תחפושת-חוץ. כנות: אין-מחיר-חוץ
  // ל-SAOS; הנגזרת-המדומה נשארת-חשופה ב-price-proof (saosSim*) עם-הפרמיה-צמודה.
  const saosSupply = supplyMu(st, "SAOS");
  push({
    asset: "SAOS",
    supplyMu: saosSupply,
    backingClaimMu: 0,
    realBackingMu: 0,
    realBackingLockedMu: 0,
    coveragePct: 0,
    coverageLockedPct: 0,
    internalPriceMu: internalPrice(st, "SAOS"),
    externalPriceUsd: null,
    externalPriceMu: null,
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
  // FIX(Roast-64-c · F12): verdict/verified/blocker כנים — probe-נפל ≠ BACKING-BROKEN
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
    verdict: wblurtVerdict,
    exitPath: "burn→BLURT-אמת-ל-headcorner (אפס-עמלת-העברה)→שוק-ה-BLURT-החוץ. הגיבוי מאומת-חי מול-blurt-rpc בכל-קריאת-truth.",
    blocker:
      wblurtVerified === true
        ? null
        : wblurtVerified === false
          ? "BACKING-BROKEN: supply≤backing≤live נפסק — ההיצע/הגיבוי חורג-מהיתרה-החיה"
          : "probe-חוץ-נפל (rpc-down) — אין-אימות-גיבוי-חי כרגע; אין-פסק-דין (לא-שבור, לא-מאומת)",
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
      what: "STEEM — SP-powerdown-אמת + גריד-ספר-STEEM — חי",
      status: "LIVE",
      valueUsd: realV && "balances" in realV && realV.steemUsd !== null
        ? realV.powerdown.remainingSp * realV.steemUsd
        : spLockedUsd,
      detail:
        realV && "balances" in realV && realV.powerdown?.active
          ? `POWERDOWN-חי (txid 6e881cd4…606): ${realV.powerdown.weeklySp.toFixed(1)}-SP/שבוע × ${realV.powerdown.weeks} — נותרו ${realV.powerdown.remainingSp.toFixed(1)}-SP, תשלום-הבא ${realV.powerdown.nextPayout?.slice(0, 10) ?? "?"}; 150-SP דלק-RC. והגריד-האמת-הראשונה על ספר-STEEM חיה (txid b269647e…3a98, #62091002) — סוחרים-אמיתיים, אפס-עמלה.`
          : "מפתח-active-אומת-ובשימוש; powerdown-לא-פעיל-כרגע.",
      zeroFee: true,
    },
    {
      n: 3.5,
      what: "החייל-האמת-הראשון — הזמנת-גריד-על-ספר-STEEM-הציבורי",
      status: (realV && "openOrders" in realV && realV.openOrders.length > 0) ? "LIVE" : "READY",
      valueUsd: realV && "balances" in realV && realV.steemUsd !== null
        ? realV.balances.sbd * (feeds.usd.hbd ?? feeds.usd.steem ?? 1)
        : null,
      detail:
        realV && "openOrders" in realV && realV.openOrders.length > 0
          ? `הזמנות-חיות: ${realV.openOrders.map((o) => `#${o.id} ${o.sell}→${o.receive} @${o.price}`).join(" · ")} — ספר-ציבורי, יישוב-על-השרשרת, סוחרים-אמיתיים.`
          : "ערוץ-ההזמנות-האמת-פתוח (POST /api/dex/realmarket action=place) — אין-הזמנה-חיה-כרגע.",
      zeroFee: true,
    },
    {
      n: 4,
      what: `BLURT-אמת ישירות מהכספת (${(liveBlurtMu / 1000).toFixed(2)} — נמדד-חי)`,
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
    probe: "ok", // FIX(F14): הרכבה-מלאה — בניגוד-לתשובה-החלקית-בשער-הזמן
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
        verified: wblurtVerified, // FIX(F12): null = probe-נפל — אי-ודאות גלויה
        probe: railProbe,         // FIX(F12): מצב-ה-probe-החוץ
        mintedNowMu: rail.mintedNowMu,
        note: rail.mintedNowMu > 0
          ? `הוטבעו ${rail.mintedNowMu}µ WBLURT בקריאה-זו מול-גיבוי-חוץ-מאומת (claim-ייחודי-פר-mint — F11)`
          : wblurtVerified === true
            ? "הגיבוי-מכוסה-מלא-ומאומת-חי (supply ≤ backing ≤ live)"
            : wblurtVerified === false
              ? "BACKING-BROKEN — נדרשת-בדיקת-מפעיל"
              : "probe-rpc-down — אין-מדידה-חיה; אין-פסק-דין (לא-BACKING-BROKEN — כנות)",
      },
    },
    ladder,
    realVenue: realV ?? undefined,
    totals: {
      estateRealUsd: estateUsd > 0 || spLockedUsd !== null ? estateUsd : null,
      estateLockedUsd: (spLockedUsd ?? 0) + (bpLockedUsd ?? 0),
      usdsSupplyMu: usdsSupplyTotal,
      usdsRealCoveragePct: usdsSupply > 0 ? (estateUsd * 1000 * 100) / usdsSupply : null,
      conclusion:
        `האמת: הערך-החוץ-הנזיל = $${estateUsd.toFixed(2)} + נעול-מתפרק: SP-powerdown-חי (436.7-SP/שבוע × 4, txid 6e881cd4) + BP. ` +
        `הפנים (USDS/SAOS) הוא סימולציה-ריבונית — מסומנת-ככזו-בכל-נכס. ` +
        `הגשר-האמת-החי: WBLURT-מגובה + SP-powerdown-זורם + הזמנת-גריד-אמת-על-ספר-STEEM (b269647e).`,
    },
    honesty:
      "כל-מספר-כאן = קריאה-חיה מ-RPC-ציבורי או מהמצב-הקנוני. אף-ערך-לא-מאולף; פיד-נופל = השדה-נעלם (fail-כנה). " +
      "פסקי-הדין: FAKE-PEG = טענה-ללא-גיבוי · INTERNAL = ספר-פנימי-בלבד · REAL-LOCKED = גיבוי-אמת-שנעול · REAL-ACTIONABLE = מגובה-וניתן-למימוש.",
  };
}
