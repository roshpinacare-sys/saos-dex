/**
 * usds-activation.ts — G76-a · הפעלת-זוגות-USDS ובריכות-AMM (מנדט §4: USDS trading
 * pairs + AMM liquidity pools, מקושרות-לפעימת-הדק).
 * ═══════════════════════════════════════════════════════════════════════════════
 * מה-נמדד-חי (db/state-snapshot.json @h1750085 · main 043d2ddb · 2026-10-26):
 *   · USDS/WSBD — **מת**: rb=1µ בלבד (נשאב-ע"י-ארביטרז' אחרי-פתיחה-הפוכה), mid
 *     11,937,000mµ מול עוגן 475mµ. אין-נתיב-חוקי-קיים להחייאה: pool_repeg מחשב
 *     raNew = refB×rb/refA = 0 → "bad-anchor" (נדחה-כל-פעימה); pool_add נופל
 *     ב"דאסט" (amountB = floor(1×addA/11937) = 0 → dust-add). זוג-USDS שהדק
 *     מפרסם-אבל-אי-אפשר-לצטט-דרכו.
 *   · USDS/WSTEEM — המסדרון: חי, על-העוגן (mid 50 = anchor 50), אבל מיקרו
 *     (ra=455,100µ ≈ 455 USDS עומק).
 *   · ENERGY/USDS — רחוק-מהעוגן (−9,998bps) אבל repeg-אפשרי (חסום-מלאי-אוצר).
 *
 * הפתרון (טהור, דטרמיניסטי, שלמים-בלבד):
 *   1. `usdsActivationPlan(st)` — חוות-דעת פר-בריכה: healthy / thin / off-anchor /
 *      dead + פעולה-מחייבת אחת (none/repeg/fund/reseed) + חסמים-כנים (fail-honest).
 *   2. `reseedOpFor` — op `pool_reseed` (חדש בגרעין): החייאה דו-צדדית על-העוגן
 *      ממלאי-אוצר חופשי, הרזרבות-הישנות חוזרות-לאוצר, Σ נשמר, LP-אזרחי = דחייה.
 *   3. `fundOpFor` — pool_add שומר-יחס להעמקת-מסדרון-דק.
 *
 * חוק-הפרסות: העמלה-הבסיסית של הבריכות היא FEE_BPS=30 (עמלי-30bps, dex-facts) —
 * אין-בריכה-מופעלת שמציעה-סיבוב-מלא בפחות מ-2×30bps (USDS_QUOTE_SPREAD_FLOOR_BPS),
 * ואין-ציטוט-מחוץ-לרצועת-העוגן (USDS_ANCHOR_BAND_BPS = 1000bps, חוק R26-ALL).
 * מעבר-ל-POOL_RESEED_TRIGGER_BPS (10,000bps) או raRepeg≤0 — הבריכה "מתה": רק
 * reseed-דו-צדדי-על-העוגן מחייה אותה (ה-repeg אינו-מסוגל).
 */
import type { DexState, Op } from "./kernel";
import { FEE_BPS, POOL_RESEED_TRIGGER_BPS, avail } from "./kernel";

/** רצועת-העוגן של כל-בריכת-USDS (חוק R26-ALL: |premBps| < 1000 = מצוטט-כשר). */
export const USDS_ANCHOR_BAND_BPS = 1_000;
/** מעבר-לזה (או raRepeg≤0) הבריכה מתה — repeg לא-מסוגל, רק reseed דו-צדדי. */
export const USDS_DEAD_RESEED_TRIGGER_BPS = POOL_RESEED_TRIGGER_BPS;
/** חוק-הפרסה: סיבוב-מלא בבריכה-מופעלת ≥ 2×עמלת-הבסיס (30bps) — אחרת-טחינה-מובטחת. */
export const USDS_QUOTE_SPREAD_FLOOR_BPS = 2 * FEE_BPS;

export interface UsdsPairConfig {
  pair: string;
  role: string;
  /** יעד-עומק צד-a (µ) — מתחתיו = thin. SAOS/USDS מנוהל-ע"י-forgePhase (70M חוק-T25). */
  targetRaMu: number;
  /** זרע-צד-b ל-reseed של בריכה-מתה (µ). */
  reseedTargetBMu: number;
  /** מי מעמיק את הבריכה — forge (cloud-beat) או הפעלה-זו (fundOpFor). */
  managedBy: "forge" | "activation";
}

/** חמשת-הזוגות-הקנוניים מול-היציב (mm.ts MARKETS) — התצורה-החיה של G76-a.
 * יעדים-מדודים: המסדרון USDS/WSTEEM חי-היום על 455Kµ (מדידה h1750085) — יעד-1Mµ
 * = העמקה-מציאותית ממלאי-הצף; הזרע-המינימלי ל-USDS/WSBD = 100Kµ WSBD (100 WSBD
 * — בגודל-גיבוי-ה-R42-SBD-rail החי ~85Kµ) עם צד-USDS נגזר-עוגן 47.5Kµ. */
export const USDS_PAIRS: UsdsPairConfig[] = [
  { pair: "SAOS/USDS", role: "sovereign-pair", targetRaMu: 70_000_000, reseedTargetBMu: 50_000_000, managedBy: "forge" },
  { pair: "USDS/WSTEEM", role: "steem-corridor", targetRaMu: 1_000_000, reseedTargetBMu: 5_000_000, managedBy: "activation" },
  { pair: "USDS/WSBD", role: "sbd-stable-corridor", targetRaMu: 1_000_000, reseedTargetBMu: 100_000, managedBy: "activation" },
  { pair: "ENERGY/USDS", role: "utility-corridor", targetRaMu: 2_000_000, reseedTargetBMu: 20_000_000, managedBy: "activation" },
  { pair: "PHIVE/USDS", role: "utility-corridor", targetRaMu: 2_000_000, reseedTargetBMu: 5_000_000, managedBy: "activation" },
];

export type UsdsPoolVerdict = "healthy" | "thin" | "off-anchor" | "dead" | "missing";
export type UsdsPoolActionKind = "none" | "repeg" | "fund" | "reseed";

export interface UsdsPoolAction {
  pair: string;
  role: string;
  verdict: UsdsPoolVerdict;
  action: UsdsPoolActionKind;
  /** מחיר-הבריכה כמו-שהפעימה מחשבת (mµ של a ל-1 יחידת-b) + עוגן + סטייה ב-bps. */
  midMu: number;
  anchorMidMu: number;
  premBps: number;
  /** reseed: הזרע הדו-צדדי המדויק-על-העוגן. fund: הוספה שומרת-יחס. */
  seedA?: number; seedB?: number; addA?: number; addB?: number;
  /** fail-honest: חסמים-גלויים — התוכנית מפרסמת-אותם כל-פעימה עד-שהדלק מגיע. */
  executable: boolean;
  blocked: string[];
}

export interface UsdsActivationPlan {
  pools: UsdsPoolAction[];
  counts: { healthy: number; thin: number; offAnchor: number; dead: number; executable: number };
  quoteSpreadFloorBps: number;
  anchorBandBps: number;
}

/** מחיר-בריכה + עוגן + סטייה — אותו-נוסח של R26-ALL בפעימה, שלמים-בלבד. */
export function poolHealth(st: DexState, pair: string): {
  verdict: UsdsPoolVerdict; midMu: number; anchorMidMu: number; premBps: number; raRepeg: number;
} {
  const p = st.pools[pair];
  const [cfgA, cfgB] = pair.split("/");
  const refA = st.assets[cfgA]?.refPrice ?? 0;
  const refB = st.assets[cfgB]?.refPrice ?? 0;
  if (!p) return { verdict: "missing", midMu: 0, anchorMidMu: 0, premBps: 0, raRepeg: 0 };
  if (!(refA > 0) || !(refB > 0)) {
    // אין-עוגן = אין-ציטוט-כשר; הפעימה מפרסמת-זאת בכנות (fail-honest).
    return { verdict: "off-anchor", midMu: 0, anchorMidMu: 0, premBps: 0, raRepeg: 0 };
  }
  const anchorMidMu = Math.floor((refB * 1000) / refA);
  const midMu = p.rb > 0 ? Math.floor((p.ra * 1000) / p.rb) : 0;
  const premBps = midMu > 0 && anchorMidMu > 0 ? Math.floor(((midMu - anchorMidMu) * 10_000) / anchorMidMu) : 0;
  const raRepeg = Math.floor((refB * p.rb) / refA); // מה-repeg-הקיים יניב (0 = אינו-מסוגל)
  let verdict: UsdsPoolVerdict;
  if (!(p.rb > 0) || !(p.ra > 0)) verdict = "dead";
  else if (raRepeg <= 0 || Math.abs(premBps) >= USDS_DEAD_RESEED_TRIGGER_BPS) verdict = "dead";
  else if (Math.abs(premBps) >= USDS_ANCHOR_BAND_BPS) verdict = "off-anchor";
  else {
    // על-העוגן — נחלט מול יעד-העומק: thin / healthy.
    const cfg = USDS_PAIRS.find((c) => c.pair === pair);
    verdict = cfg && p.ra < cfg.targetRaMu ? "thin" : "healthy";
  }
  return { verdict, midMu, anchorMidMu, premBps, raRepeg };
}

/** op `pool_reseed` לבריכה-מתה: זרע דו-צדדי מדויק-על-העוגן ממלאי-אוצר חופשי.
 * הרזרבות-הישנות חוזרות-לאוצר (אידמפוטנטי-כנה); הגרעין אוכף את-כל-השערים. */
export function reseedOpFor(st: DexState, pair: string, nonce?: string): {
  op: Op | null; executable: boolean; blocked: string[]; seedA: number; seedB: number;
} {
  const cfg = USDS_PAIRS.find((c) => c.pair === pair);
  const p = st.pools[pair];
  const [aS, bS] = pair.split("/");
  const blocked: string[] = [];
  if (!cfg || !p) return { op: null, executable: false, blocked: ["pool-not-found"], seedA: 0, seedB: 0 };
  const h = poolHealth(st, pair);
  if (h.verdict !== "dead") blocked.push(`pool-not-dead(${h.verdict})`);
  const refA = st.assets[aS]?.refPrice ?? 0;
  const refB = st.assets[bS]?.refPrice ?? 0;
  const seedB = cfg.reseedTargetBMu;
  const seedA = refA > 0 && refB > 0 ? Math.floor((refB * seedB) / refA) : 0;
  if (!(seedA > 0)) blocked.push("seed-dust(no-anchor)");
  if (seedA > 0) {
    const needA = Math.max(0, seedA - p.ra);
    const needB = Math.max(0, seedB - p.rb);
    if (avail(st, "treasury", aS) < needA || avail(st, "treasury", bS) < needB) {
      blocked.push(`insufficient-treasury: need ${aS}+${needA}µ/${bS}+${needB}µ free (reserves returned first)`);
    }
  }
  const op: Op = {
    type: "pool_reseed",
    issuer: "treasury",
    nonce: nonce ?? `reseed:${pair}:${st.height}:${seedA}:${seedB}`,
    pair,
    amount: seedA,
    amountB: seedB,
  } as Op;
  return { op, executable: blocked.length === 0, blocked, seedA, seedB };
}

/** op `pool_add` שומר-יחס להעמקת-בריכה-דקה (thin) עד-יעד-העומק. */
export function fundOpFor(st: DexState, pair: string, nonce?: string): {
  op: Op | null; executable: boolean; blocked: string[]; addA: number; addB: number;
} {
  const cfg = USDS_PAIRS.find((c) => c.pair === pair);
  const p = st.pools[pair];
  const [aS, bS] = pair.split("/");
  const blocked: string[] = [];
  if (!cfg || !p) return { op: null, executable: false, blocked: ["pool-not-found"], addA: 0, addB: 0 };
  const addA = Math.max(0, cfg.targetRaMu - p.ra);
  if (!(addA > 0)) blocked.push("already-at-target");
  const addB = addA > 0 && p.ra > 0 ? Math.floor((p.rb * addA) / p.ra) : 0;
  if (addA > 0 && !(addB > 0)) blocked.push("dust-add");
  if (addA > 0 && addB > 0) {
    if (avail(st, "treasury", aS) < addA || avail(st, "treasury", bS) < addB) {
      blocked.push(`insufficient-treasury: need ${aS}+${addA}µ/${bS}+${addB}µ free`);
    }
  }
  const op: Op = {
    type: "pool_add",
    issuer: "treasury",
    nonce: nonce ?? `fund:${pair}:${st.height}:${addA}`,
    pair,
    amount: addA,
  } as Op;
  return { op, executable: blocked.length === 0, blocked, addA, addB };
}

/** תוכנית-ההפעלה המלאה — מה שהפעימה (cloud-beat) מפרסמת-ומבצעת כל-ריצה. */
export function usdsActivationPlan(st: DexState): UsdsActivationPlan {
  const pools: UsdsPoolAction[] = USDS_PAIRS.map((cfg) => {
    const h = poolHealth(st, cfg.pair);
    const base: UsdsPoolAction = {
      pair: cfg.pair, role: cfg.role, verdict: h.verdict, action: "none",
      midMu: h.midMu, anchorMidMu: h.anchorMidMu, premBps: h.premBps,
      executable: false, blocked: [],
    };
    if (h.verdict === "dead") {
      const r = reseedOpFor(st, cfg.pair);
      return { ...base, action: "reseed", seedA: r.seedA, seedB: r.seedB, executable: r.executable, blocked: r.blocked };
    }
    if (h.verdict === "off-anchor") {
      // repeg קיים — כשירות-מלאי נבדקת-כאן-כנה (הגרעין ידחה-אחרת בכל-פעימה):
      const [aS] = cfg.pair.split("/");
      const p = st.pools[cfg.pair];
      const raNew = Math.floor((st.assets[p.b]?.refPrice ?? 0) * p.rb / (st.assets[p.a]?.refPrice ?? 1));
      const need = Math.max(0, raNew - p.ra);
      const blocked: string[] = [];
      if (!(st.assets[p.a]?.refPrice > 0) || !(st.assets[p.b]?.refPrice > 0)) blocked.push("no-anchor");
      else if (avail(st, "treasury", aS) < need) blocked.push(`insufficient-treasury-repeg: need ${aS}+${need}µ`);
      return { ...base, action: "repeg", executable: blocked.length === 0, blocked };
    }
    if (h.verdict === "thin") {
      if (cfg.managedBy === "forge") {
        // העמקת-הזוג-הריבוני שייכת-ל-forgePhase (חוק-T25) — אין-הפעלה-כפולה.
        return { ...base, action: "none", executable: false, blocked: ["deepening-owned-by-forge-phase"] };
      }
      const f = fundOpFor(st, cfg.pair);
      return { ...base, action: "fund", addA: f.addA, addB: f.addB, executable: f.executable, blocked: f.blocked };
    }
    if (h.verdict === "missing") return { ...base, action: "none", executable: false, blocked: ["pool-missing"] };
    return base; // healthy
  });
  const counts = {
    healthy: pools.filter((x) => x.verdict === "healthy").length,
    thin: pools.filter((x) => x.verdict === "thin").length,
    offAnchor: pools.filter((x) => x.verdict === "off-anchor").length,
    dead: pools.filter((x) => x.verdict === "dead").length,
    executable: pools.filter((x) => x.executable).length,
  };
  return { pools, counts, quoteSpreadFloorBps: USDS_QUOTE_SPREAD_FLOOR_BPS, anchorBandBps: USDS_ANCHOR_BAND_BPS };
}
