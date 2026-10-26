/**
 * liquidity-receipt.ts — G77-c · קבלת-נזילות-USDS אחת-אמת (מדידה טהורה, אפס-המצאה).
 * ═══════════════════════════════════════════════════════════════════════════════
 * מה-נמדד-חי (evidence state-snapshot @h993 · 2026-10-26T15:40:33Z — השרשרת-המקומית
 * אחרי-הג'נזיס של G76): אחרי-הג'נזיס יש רק 3 בריכות (SAOS/USDS · USDS/WSTEEM ·
 * ENERGY/SAOS) — שלושת-זוגות-ה-USDS הקנוניים USDS/WSBD · ENERGY/USDS · PHIVE/USDS
 * **חסרים** מהמצב. תוכנית-ההפעלה של G76-a (usds-activation.ts) מטפלת בבריכות-קיימות
 * (reseed/fund/repeg) ומדווחת "pool-missing" בלי-נתיב. החוק-הזה משלים אותה מבלי-
 * לגעת בה: לבריכה-חסרה הנתיב-החוקי הוא `pool_open` ריבוני (issuer=treasury, האוצר
 * פטור משער-הערבות — kernel EXEC-CD-9) עם זרע-דו-צדדי-על-העוגן — **אותו-מתמטיקת-
 * זרע** של reseedOpFor: seedB = reseedTargetBMu של הזוג, seedA = floor(refB×seedB/refA).
 *
 * חוקי-ברזל:
 *   · שלמים-בלבד (אין-float במדידה, כמו-הגרעין).
 *   · fail-honest: כל-חסימה מפרסמת את **החסר-המדויק במיקרו** (need/free/missing) —
 *     הקבלה היא המדידה; אפס-נזילות-מדומה, אפס-עודף-שלילי.
 *   · אפס-הפעלה-כפולה: העמקת SAOS/USDS שייכת ל-forgePhase (חוק-T25) — מדווח, לא-מבוצע.
 *   · הקבלה טהורה ודטרמיניסטית — הפעימה (cloud-beat) והמדידות-החיות קוראות אותה
 *     על אותו-מצב ומקבלות אותם-מספרים.
 */
import type { DexState, Op } from "./kernel";
import { avail } from "./kernel";
import {
  USDS_PAIRS,
  poolHealth,
  reseedOpFor,
  fundOpFor,
  type UsdsPoolVerdict,
  type UsdsPoolActionKind,
} from "./usds-activation";

/** חוק-הזרע לבריכה-חסרה (pool_open ריבוני) — מתועד-כאן-כדי-שהקבלה תהיה-מקור-האמת. */
export const MISSING_POOL_SEED_LAW =
  "pool_open · issuer=treasury · anchor-exact seedA=floor(refB*seedB/refA) · reseedTargetBMu as seedB";

// ── עזרי-מצב ─────────────────────────────────────────────────────────────────

export interface TreasuryAssetFloat {
  asset: string;
  bal: number;
  locked: number;
  free: number;
}

export interface TreasuryFloat {
  who: "treasury";
  assets: TreasuryAssetFloat[];
}

/** הצף-החופשי של האוצר לכל-נכס בחמישייה + STEEM (חופשי = יתרה − נעול). */
export function treasuryFloatOf(st: DexState): TreasuryFloat {
  const assets = [...USDS_PAIRS.map((c) => c.pair.split("/")[0]), ...USDS_PAIRS.map((c) => c.pair.split("/")[1]), "STEEM"]
    .filter((a, i, arr) => arr.indexOf(a) === i)
    .map((asset) => {
      const bal = st.balances["treasury"]?.[asset] ?? 0;
      const locked = st.locked["treasury"]?.[asset] ?? 0;
      return { asset, bal, locked, free: bal - locked };
    });
  return { who: "treasury", assets };
}

export interface Shortfall {
  asset: string;
  needMu: number;
  freeMu: number;
  missingMu: number;
}

/** פער-מלאי מדויק לכל-נכס: missing = max(0, need − free). אפס-המצאה. */
export function shortfallOf(st: DexState, needs: { asset: string; needMu: number }[]): Shortfall[] {
  return needs.map(({ asset, needMu }) => {
    const freeMu = avail(st, "treasury", asset);
    return { asset, needMu, freeMu, missingMu: Math.max(0, needMu - freeMu) };
  });
}

// ── חוק-הזרע לבריכה-חסרה ──────────────────────────────────────────────────────

export interface OpenSeedPlan {
  pair: string;
  seedA: number;
  seedB: number;
  op: Op | null;
  executable: boolean;
  blocked: string[];
  missing: Shortfall[] | null;
}

/** זרע-פתיחה דו-צדדי-על-העוגן לבריכה-**חסרה** ממלאי-אוצר-חופשי.
 * אותו-מתמטיקת-זרע של reseedOpFor (seedB=יעד-הזוג, seedA=עוגן-מדויק), אבל על
 * pool_open (אין-רזרבות-ישנות-להחזיר — הבריכה-פשוט-לא-קיימת אחרי-הג'נזיס).
 * fail-closed: בריכה-קיימת אינה-עניין-החוק-הזה; אין-עוגן → אין-זרע. */
export function openSeedForMissing(st: DexState, pair: string, nonce?: string): OpenSeedPlan {
  const cfg = USDS_PAIRS.find((c) => c.pair === pair);
  const [aS, bS] = pair.split("/");
  const blocked: string[] = [];
  if (!cfg) return { pair, seedA: 0, seedB: 0, op: null, executable: false, blocked: ["pair-not-canonical"], missing: null };
  if (st.pools[pair]) return { pair, seedA: 0, seedB: 0, op: null, executable: false, blocked: ["pool-not-missing"], missing: null };
  const refA = st.assets[aS]?.refPrice ?? 0;
  const refB = st.assets[bS]?.refPrice ?? 0;
  const seedB = cfg.reseedTargetBMu;
  const seedA = refA > 0 && refB > 0 ? Math.floor((refB * seedB) / refA) : 0;
  if (!(seedA > 0)) {
    return { pair, seedA: 0, seedB, op: null, executable: false, blocked: ["seed-dust(no-anchor)"], missing: null };
  }
  const missing = shortfallOf(st, [
    { asset: aS, needMu: seedA },
    { asset: bS, needMu: seedB },
  ]);
  if (missing.some((m) => m.missingMu > 0)) {
    blocked.push(
      `insufficient-treasury: need ${aS}+${seedA}µ/${bS}+${seedB}µ free`,
    );
  }
  const op: Op | null = blocked.length === 0
    ? ({
        type: "pool_open",
        issuer: "treasury",
        nonce: nonce ?? `openseed:${pair}:${st.height}:${seedA}:${seedB}`,
        pair,
        amount: seedA,
        amountB: seedB,
      } as Op)
    : null;
  return { pair, seedA, seedB, op, executable: blocked.length === 0, blocked, missing };
}

// ── הקבלה-האחת ────────────────────────────────────────────────────────────────

export interface ReceiptPair {
  pair: string;
  role: string;
  verdict: UsdsPoolVerdict;
  action: UsdsPoolActionKind | "open-seed";
  midMu: number;
  anchorMidMu: number;
  premBps: number;
  executable: boolean;
  blocked: string[];
  seedA?: number;
  seedB?: number;
  addA?: number;
  addB?: number;
  missing: Shortfall[] | null;
}

export interface ExtraPool {
  pair: string;
  midMu: number;
  anchorMidMu: number;
  premBps: number;
}

export interface LiquidityReceipt {
  pairs: ReceiptPair[];
  extraPools: ExtraPool[];
  treasury: TreasuryFloat;
  counts: { healthy: number; thin: number; offAnchor: number; dead: number; missing: number; executable: number };
  verdict: "FULL" | "PARTIAL" | "ALL-BLOCKED";
}

/** קבלת-הנזילות הקנונית: חמשת-הזוגות + בריכות-עודפיות + הצף-האוצר + פסיקה-כנה.
 * זו-המדידה שהפעימה והכתבות מפרסמים — אותו-קלט → אותה-קבלה (דטרמיניזם ברזל). */
export function liquidityReceipt(st: DexState): LiquidityReceipt {
  const treasury = treasuryFloatOf(st);
  const pairs: ReceiptPair[] = USDS_PAIRS.map((cfg) => {
    const h = poolHealth(st, cfg.pair);
    const base: ReceiptPair = {
      pair: cfg.pair,
      role: cfg.role,
      verdict: h.verdict,
      action: "none",
      midMu: h.midMu,
      anchorMidMu: h.anchorMidMu,
      premBps: h.premBps,
      executable: false,
      blocked: [],
      missing: null,
    };
    if (h.verdict === "missing") {
      const s = openSeedForMissing(st, cfg.pair);
      return {
        ...base,
        action: "open-seed",
        executable: s.executable,
        blocked: s.blocked,
        seedA: s.seedA,
        seedB: s.seedB,
        missing: s.missing,
      };
    }
    if (h.verdict === "dead") {
      const r = reseedOpFor(st, cfg.pair);
      const needs = [
        { asset: cfg.pair.split("/")[0], needMu: Math.max(0, r.seedA - (st.pools[cfg.pair]?.ra ?? 0)) },
        { asset: cfg.pair.split("/")[1], needMu: Math.max(0, r.seedB - (st.pools[cfg.pair]?.rb ?? 0)) },
      ];
      return {
        ...base,
        action: "reseed",
        executable: r.executable,
        blocked: r.blocked,
        seedA: r.seedA,
        seedB: r.seedB,
        missing: r.executable ? null : shortfallOf(st, needs),
      };
    }
    if (h.verdict === "off-anchor") {
      const [aS] = cfg.pair.split("/");
      const p = st.pools[cfg.pair];
      const raNew = Math.floor(((st.assets[p.b]?.refPrice ?? 0) * p.rb) / (st.assets[p.a]?.refPrice ?? 1));
      const need = Math.max(0, raNew - p.ra);
      const blocked: string[] = [];
      if (!(st.assets[p.a]?.refPrice > 0) || !(st.assets[p.b]?.refPrice > 0)) blocked.push("no-anchor");
      else if (avail(st, "treasury", aS) < need) blocked.push(`insufficient-treasury-repeg: need ${aS}+${need}µ`);
      return {
        ...base,
        action: "repeg",
        executable: blocked.length === 0,
        blocked,
        missing: blocked.some((b) => b.startsWith("insufficient")) ? shortfallOf(st, [{ asset: aS, needMu: need }]) : null,
      };
    }
    if (h.verdict === "thin") {
      if (cfg.managedBy === "forge") {
        return { ...base, action: "none", executable: false, blocked: ["deepening-owned-by-forge-phase"] };
      }
      const f = fundOpFor(st, cfg.pair);
      const needs = f.addA > 0
        ? [
            { asset: cfg.pair.split("/")[0], needMu: f.addA },
            { asset: cfg.pair.split("/")[1], needMu: f.addB },
          ]
        : [];
      return {
        ...base,
        action: "fund",
        executable: f.executable,
        blocked: f.blocked,
        addA: f.addA,
        addB: f.addB,
        missing: needs.length > 0 && !f.executable ? shortfallOf(st, needs) : null,
      };
    }
    return base; // healthy
  });
  // בריכות-חיות מחוץ-לחמישייה — מדווחות-בכנות (מדידה בלבד, אין-פעולה):
  const extraPools: ExtraPool[] = Object.keys(st.pools)
    .filter((k) => !USDS_PAIRS.some((c) => c.pair === k))
    .sort()
    .map((k) => {
      const h = poolHealth(st, k);
      return { pair: k, midMu: h.midMu, anchorMidMu: h.anchorMidMu, premBps: h.premBps };
    });
  const counts = {
    healthy: pairs.filter((x) => x.verdict === "healthy").length,
    thin: pairs.filter((x) => x.verdict === "thin").length,
    offAnchor: pairs.filter((x) => x.verdict === "off-anchor").length,
    dead: pairs.filter((x) => x.verdict === "dead").length,
    missing: pairs.filter((x) => x.verdict === "missing").length,
    executable: pairs.filter((x) => x.executable).length,
  };
  const verdict: LiquidityReceipt["verdict"] =
    counts.executable === pairs.length ? "FULL" : counts.executable > 0 ? "PARTIAL" : "ALL-BLOCKED";
  return { pairs, extraPools, treasury, counts, verdict };
}
