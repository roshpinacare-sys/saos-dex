/**
 * liquidity-receipt.test.ts — G77-c · USDS liquidity receipt + missing-pool seed law.
 * ═══════════════════════════════════════════════════════════════════════════════
 * דטרמיניסטי לחלוטין: genesisState() + מצב-מדוד סינתטי (אפס-רשת, אפס-זמן, אפס-רנדום).
 * המצב-המדוד משוחזר מהעדות החיה של השרשרת-המקומית אחרי-הג'נזיס (evidence
 * /tmp/g77c-snapshot-evidence.json ← db/state-snapshot.json @h993 · 2026-10-26T15:40:33Z):
 *   · SAOS/USDS — חי, −68bps, עומק-מנוהל-ע"י-forge (הפעלה-כפולה אסורה).
 *   · USDS/WSTEEM — המסדרון: על-העוגן (prem 0bps) ודק (ra=419,345 < יעד 1,000,000).
 *   · ENERGY/SAOS — בריכה-חיה מחוץ לחמישיית-ה-USDS (מדווחת בכנות, אין-פעולה).
 *   · USDS/WSBD · ENERGY/USDS · PHIVE/USDS — **חסרות** מהג'נזיס: החוק הוא
 *     pool_open ריבוני עם זרע-דו-צדדי-על-העוגן (אותו-מתמטיקת-זרע של reseedOpFor).
 *
 * החוקים הנבדקים:
 *  1. treasuryFloatOf — חופשי = יתרה − נעול, שלמים בלבד, חשבון-חסר = 0.
 *  2. openSeedForMissing — זרע-על-העוגן לבריכה-חסרה: seedA = floor(refB×seedB/refA);
 *     fail-closed (אין-עוגן / אוצר-לא-מכסה) עם חסר-מדויק במיקרו.
 *  3. shortfallOf — פער-מלאי מדויק לכל נכס (need − free), אפס-המצאה.
 *  4. liquidityReceipt — קבלה אחת: כל זוג-קנוני + בריכות-עודפיות + אוצר + פסיקה.
 *  5. דטרמיניזם — אותו-מצב → אותו-JSON קנוני פעמיים.
 */
import { describe, test, expect } from "bun:test";
import { genesisState, type DexState } from "./kernel";
import {
  treasuryFloatOf,
  openSeedForMissing,
  shortfallOf,
  liquidityReceipt,
  MISSING_POOL_SEED_LAW,
  type LiquidityReceipt,
} from "./liquidity-receipt";

/** המצב-המדוד (h993 · 2026-10-26T15:40:33Z — העדות הקפואה של הגל G77-c). */
function g77State(funded: boolean): DexState {
  const st = genesisState();
  st.height = 993;
  st.assets = {
    SAOS: { refPrice: 1_687, listed: 700 },
    USDS: { refPrice: 1_000, listed: 0 },
    WSTEEM: { refPrice: 54, listed: 0 },
    ENERGY: { refPrice: 125, listed: 0 },
    WSBD: { refPrice: 536, listed: 0 },
    PHIVE: { refPrice: 49, listed: 0 },
  };
  st.pools = {
    "SAOS/USDS": { a: "SAOS", b: "USDS", ra: 10_418_154, rb: 17_700_738, lp: 13_433_878, feeAccruedTreasury: 78_321, swaps: 492 },
    "USDS/WSTEEM": { a: "USDS", b: "WSTEEM", ra: 419_345, rb: 7_624_459, lp: 5_656_854, feeAccruedTreasury: 5_703, swaps: 59 },
    "ENERGY/SAOS": { a: "ENERGY", b: "SAOS", ra: 67_454, rb: 4_947, lp: 14_142, feeAccruedTreasury: 5_680, swaps: 57 },
  } as DexState["pools"];
  st.balances["treasury"] = {
    ...st.balances["treasury"],
    SAOS: 5_515_563, USDS: 400_000, STEEM: 101_709, WSTEEM: 19_455,
    ENERGY: 1, WSBD: 41_939, PHIVE: 113,
    "LP|SAOS/USDS": 784_768,
  };
  st.locked["treasury"] = {};
  if (funded) {
    // תרחיש "הדלק-הגיע": האוצר מכסה את זרע-USDS/WSBD (53,600µ/100,000µ) + מילוי-המסדרון.
    st.balances["treasury"].USDS += 200_000;
    st.balances["treasury"].WSBD += 100_000;
    st.balances["treasury"].WSTEEM += 11_000_000;
  }
  return st;
}

describe("G77-c · treasury float (עזרי-מצב, שלמים-בלבד)", () => {
  test("free = balance − locked for every treasury asset", () => {
    const st = g77State(false);
    st.locked["treasury"] = { USDS: 10_000, WSBD: 1_939 } as DexState["locked"]["treasury"];
    const f = treasuryFloatOf(st);
    const usds = f.assets.find((a) => a.asset === "USDS");
    const wsbd = f.assets.find((a) => a.asset === "WSBD");
    const saos = f.assets.find((a) => a.asset === "SAOS");
    expect(usds).toEqual({ asset: "USDS", bal: 400_000, locked: 10_000, free: 390_000 });
    expect(wsbd).toEqual({ asset: "WSBD", bal: 41_939, locked: 1_939, free: 40_000 });
    expect(saos).toEqual({ asset: "SAOS", bal: 5_515_563, locked: 0, free: 5_515_563 });
  });
  test("missing treasury account = zero float (fail-honest, no invention)", () => {
    const st = g77State(false);
    delete st.balances["treasury"];
    const f = treasuryFloatOf(st);
    expect(f.assets.every((a) => a.bal === 0 && a.locked === 0 && a.free === 0)).toBe(true);
  });
  test("every µ field is an integer (the iron law)", () => {
    const f = treasuryFloatOf(g77State(true));
    for (const a of f.assets) {
      expect(Number.isInteger(a.bal)).toBe(true);
      expect(Number.isInteger(a.locked)).toBe(true);
      expect(Number.isInteger(a.free)).toBe(true);
    }
  });
});

describe("G77-c · missing-pool seed law (USDS/WSBD after the genesis)", () => {
  test("the law: seed side-b = the reseed target, side-a = anchor-exact floor(refB×seedB/refA)", () => {
    expect(MISSING_POOL_SEED_LAW).toBe("pool_open · issuer=treasury · anchor-exact seedA=floor(refB*seedB/refA) · reseedTargetBMu as seedB");
  });
  test("USDS/WSBD missing: seed 53,600µ USDS / 100,000µ WSBD — treasury WSBD short by exactly 58,061µ", () => {
    const st = g77State(false);
    const r = openSeedForMissing(st, "USDS/WSBD");
    expect(r.seedA).toBe(53_600); // floor(536×100,000/1000)
    expect(r.seedB).toBe(100_000);
    expect(r.executable).toBe(false);
    expect(r.blocked).toEqual([
      "insufficient-treasury: need USDS+53600µ/WSBD+100000µ free",
    ]);
    expect(r.missing).toEqual([
      { asset: "USDS", needMu: 53_600, freeMu: 400_000, missingMu: 0 },
      { asset: "WSBD", needMu: 100_000, freeMu: 41_939, missingMu: 58_061 },
    ]);
  });
  test("funded treasury → executable pool_open op (treasury exempt from the margin gate)", () => {
    const st = g77State(true);
    const r = openSeedForMissing(st, "USDS/WSBD");
    expect(r.executable).toBe(true);
    expect(r.blocked).toEqual([]);
    expect(r.op).not.toBeNull();
    expect(r.op?.type).toBe("pool_open");
    expect(r.op?.issuer).toBe("treasury");
    expect(r.op?.pair).toBe("USDS/WSBD");
    expect(r.op?.amount).toBe(53_600);
    expect(r.op?.amountB).toBe(100_000);
    expect(typeof r.op?.nonce).toBe("string");
  });
  test("no anchor (refPrice 0) → seed-dust blocker, executable=false, op=null", () => {
    const st = g77State(false);
    st.assets.WSBD = { refPrice: 0, listed: 0 };
    const r = openSeedForMissing(st, "USDS/WSBD");
    expect(r.executable).toBe(false);
    expect(r.blocked).toEqual(["seed-dust(no-anchor)"]);
    expect(r.op).toBeNull();
  });
  test("existing pool is never re-seeded by the missing-pool law (fail-honest)", () => {
    const st = g77State(false);
    const r = openSeedForMissing(st, "SAOS/USDS");
    expect(r.executable).toBe(false);
    expect(r.blocked).toEqual(["pool-not-missing"]);
    expect(r.op).toBeNull();
  });
});

describe("G77-c · shortfall accounting (החסר-המדויק — אפס-המצאה)", () => {
  test("shortfall = max(0, need − free) per asset", () => {
    const st = g77State(false);
    expect(shortfallOf(st, [{ asset: "USDS", needMu: 580_655 }, { asset: "WSTEEM", needMu: 10_557_369 }])).toEqual([
      { asset: "USDS", needMu: 580_655, freeMu: 400_000, missingMu: 180_655 },
      { asset: "WSTEEM", needMu: 10_557_369, freeMu: 19_455, missingMu: 10_537_914 },
    ]);
  });
  test("covered need → missing 0 (not negative — no fabricated surplus)", () => {
    const st = g77State(true);
    expect(shortfallOf(st, [{ asset: "WSBD", needMu: 100_000 }])).toEqual([
      { asset: "WSBD", needMu: 100_000, freeMu: 141_939, missingMu: 0 },
    ]);
  });
});

describe("G77-c · the one receipt (liquidityReceipt over the measured state)", () => {
  test("blocked state: zero executable ops, exact shortfall lines for every canonical pair", () => {
    const st = g77State(false);
    const r: LiquidityReceipt = liquidityReceipt(st);
    // חמשת-הזוגות-הקנוניים תמיד נמדדים — חסרים לא נופלים מהקבלה:
    expect(r.pairs.map((p) => p.pair)).toEqual([
      "SAOS/USDS", "USDS/WSTEEM", "USDS/WSBD", "ENERGY/USDS", "PHIVE/USDS",
    ]);
    const byPair = new Map(r.pairs.map((p) => [p.pair, p]));
    expect(byPair.get("SAOS/USDS")?.verdict).toBe("thin");
    expect(byPair.get("SAOS/USDS")?.premBps).toBe(-68);
    expect(byPair.get("SAOS/USDS")?.blocked).toEqual(["deepening-owned-by-forge-phase"]);
    expect(byPair.get("USDS/WSTEEM")?.verdict).toBe("thin");
    expect(byPair.get("USDS/WSTEEM")?.premBps).toBe(0); // על-העוגן מת (העוגן זז עם-האורקל)
    expect(byPair.get("USDS/WSTEEM")?.missing).toEqual([
      { asset: "USDS", needMu: 580_655, freeMu: 400_000, missingMu: 180_655 },
      { asset: "WSTEEM", needMu: 10_557_369, freeMu: 19_455, missingMu: 10_537_914 },
    ]);
    expect(byPair.get("USDS/WSBD")?.verdict).toBe("missing");
    expect(byPair.get("USDS/WSBD")?.missing).toEqual([
      { asset: "USDS", needMu: 53_600, freeMu: 400_000, missingMu: 0 },
      { asset: "WSBD", needMu: 100_000, freeMu: 41_939, missingMu: 58_061 },
    ]);
    expect(byPair.get("ENERGY/USDS")?.verdict).toBe("missing");
    expect(byPair.get("PHIVE/USDS")?.verdict).toBe("missing");
    expect(r.counts.executable).toBe(0);
    expect(r.verdict).toBe("ALL-BLOCKED");
    // בריכה-חיה מחוץ-לחמישייה מדווחת-בכנות בלי-פעולה:
    expect(r.extraPools).toEqual([
      { pair: "ENERGY/SAOS", midMu: 13_635, anchorMidMu: 13_496, premBps: 102 },
    ]);
  });
  test("funded state: the executable ops surface with their exact µ", () => {
    const st = g77State(true);
    const r = liquidityReceipt(st);
    const wsbd = r.pairs.find((p) => p.pair === "USDS/WSBD");
    expect(wsbd?.action).toBe("open-seed");
    expect(wsbd?.executable).toBe(true);
    expect(wsbd?.seedA).toBe(53_600);
    expect(wsbd?.seedB).toBe(100_000);
    // המסדרון עדיין דק — ה-WSTEEM הוזרם מכסה את ה-addB:
    const wst = r.pairs.find((p) => p.pair === "USDS/WSTEEM");
    expect(wst?.executable).toBe(true);
    expect(r.counts.executable).toBe(2);
    expect(r.verdict).toBe("PARTIAL"); // 2 מתוך-5 ברי-ביצוע — השאר חסומים-בכנות
  });
  test("determinism: identical state → byte-identical canonical receipt JSON", () => {
    const a = liquidityReceipt(g77State(false));
    const b = liquidityReceipt(g77State(false));
    expect(JSON.stringify(a) === JSON.stringify(b)).toBe(true);
  });
  test("integer law across the whole receipt", () => {
    const r = liquidityReceipt(g77State(false));
    for (const p of r.pairs) {
      for (const v of [p.midMu, p.anchorMidMu, p.premBps]) expect(Number.isInteger(v)).toBe(true);
      for (const m of p.missing ?? []) {
        for (const v of [m.needMu, m.freeMu, m.missingMu]) expect(Number.isInteger(v)).toBe(true);
      }
    }
  });
});
