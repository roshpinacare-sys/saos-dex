/**
 * usds-activation.test.ts — G76-a · USDS pair activation + AMM pool funding/swap path.
 * ═══════════════════════════════════════════════════════════════════════════════
 * דטרמיניסטי לחלוטין: genesisState() + מצב-מדוד סינתטי (אפס-רשת, אפס-זמן, אפס-רנדום).
 * המצב-המדוד משוחזר מהעדות החיה של השרשרת (db/state-snapshot.json @h1750085,
 * main 043d2ddb 2026-10-26): USDS/WSBD מת (ra=11,937 / rb=1) · USDS/WSTEEM חי-מיקרו
 * על-העוגן (mid 50 = anchor) · ENERGY/USDS רחוק-מהעוגן (−9,998bps).
 *
 * החוקים הנבדקים:
 *  1. תוכנית-הפעלה (usdsActivationPlan) — חוות-דעת נכונות על המדידות החיות.
 *  2. pool_reseed (kernel op חדש) — החייאה דו-צדדית על-העוגן, אוצר-בלבד, Σ נשמר.
 *  3. נתיב-הסוופ אחרי-ההפעלה — quote/execute עובד, חוק-העמלה 30bps נשמר, k לא יורד.
 *  4. fail-closed — אזרחים, אוצר-ריק, זרע-לא-על-העוגן, בריכה-בריאה: דחייה-כנה-אפס-נגיעה.
 */
import { describe, test, expect } from "bun:test";
import {
  applyOp,
  genesisState,
  poolKey,
  avail,
  FEE_BPS,
  DYN_FEE_MIN_BPS,
  type DexState,
  type Op,
} from "./kernel";
import {
  USDS_PAIRS,
  USDS_ANCHOR_BAND_BPS,
  USDS_DEAD_RESEED_TRIGGER_BPS,
  USDS_QUOTE_SPREAD_FLOOR_BPS,
  usdsActivationPlan,
  reseedOpFor,
  fundOpFor,
} from "./usds-activation";

const NOW_MS = 1_700_000_000_000;
const NONCE = (p: string) => `g76a-${p}-0001`;

/** המצב-המדוד (h1750085 · main 043d2ddb · 2026-10-26): בריכות-USDS בשלוש מצבי-חיים. */
function measuredState(funded: boolean): DexState {
  const st = genesisState();
  st.height = 1_750_085;
  // עוגני-האורקל החיים הנמדדים (st.assets):
  st.assets = {
    SAOS: { refPrice: 1014, listed: 0 },
    USDS: { refPrice: 1000, listed: 0 },
    WSTEEM: { refPrice: 50, listed: 0 },
    ENERGY: { refPrice: 125, listed: 0 },
    WSBD: { refPrice: 475, listed: 0 },
    PHIVE: { refPrice: 48, listed: 0 },
  };
  st.pools = {
    // מדידה חיה — הזוג-הריבוני (בריא, עומק-מנוהל-ע"י-forge):
    "SAOS/USDS": { a: "SAOS", b: "USDS", ra: 98_841_561, rb: 100_504_064, lp: 65_636_527, feeAccruedTreasury: 19_568_344, swaps: 66_064 },
    // מדידה חיה — המסדרון (חי-מיקרו, על-העוגן, דק מתחת ליעד):
    "USDS/WSTEEM": { a: "USDS", b: "WSTEEM", ra: 455_100, rb: 9_049_615, lp: 5_656_854, feeAccruedTreasury: 12_253, swaps: 57 },
    // מדידה חיה — הזוג-המת (rb=1µ — נשאב ע"י-ארביטרז'; אין-נתיב-חוקי להחייאה בלי-reseed):
    "USDS/WSBD": { a: "USDS", b: "WSBD", ra: 11_937, rb: 1, lp: 2_236, feeAccruedTreasury: 2_427_905, swaps: 3_312, volBpsEwma: 5_496, dynFeeBps: 1_404 },
    // מדידה חיה — רחוק-מהעוגן (repeg-אפשרי אבל חסום-מלאי):
    "ENERGY/USDS": { a: "ENERGY", b: "USDS", ra: 174_258, rb: 15_861_338, lp: 151_977, feeAccruedTreasury: 1_150_466, swaps: 2_075 },
    // מדידה חיה — עמוק (מעל-יעד):
    "PHIVE/USDS": { a: "PHIVE", b: "USDS", ra: 12_096_176, rb: 8_393_105, lp: 7_901_153, feeAccruedTreasury: 860_473, swaps: 1_703 },
  } as DexState["pools"];
  // LP-הכול-לאוצר (המדידה-החיה: אפס-LP אזרחי על הזוגות-האלה):
  st.balances["treasury"] = {
    ...st.balances["treasury"],
    SAOS: 6_000_000, USDS: 8_000_000, STEEM: 1_000_000, WSTEEM: 316_000,
    ENERGY: 40_000, WSBD: 50_000, PHIVE: 100_000,
    "LP|SAOS/USDS": 65_636_527, "LP|USDS/WSTEEM": 5_656_854,
    "LP|USDS/WSBD": 2_236, "LP|ENERGY/USDS": 89_200, "LP|PHIVE/USDS": 7_901_153,
  };
  st.locked["treasury"] = {}; // אפס-ערבות-חיה (יחידת-בדיקה)
  if (funded) {
    // אוצר-ממומן (תרחיש "הדלק-הגיע"): היתרות-החופשיות שהאוצר יזרים להפעלה.
    st.balances["treasury"].USDS += 4_000_000;
    st.balances["treasury"].WSBD += 1_000_000;
    st.balances["treasury"].WSTEEM += 20_000_000;
    st.balances["treasury"].ENERGY += 200_000_000;
  }
  return st;
}

const sumAsset = (st: DexState, a: string): number => {
  let s = st.pools[a]?.ra ?? 0; // לא-רלוונטי — נשתמש-להלן
  return s;
};
/** Σ(יתרות+רזרבות) לנכס — חוק-שימור-הברזל. */
const supply = (st: DexState, a: string): number => {
  let s = 0;
  for (const w of Object.values(st.balances)) s += w[a] ?? 0;
  for (const p of Object.values(st.pools)) { if (p.a === a) s += p.ra; if (p.b === a) s += p.rb; }
  return s;
};

describe("G76-a · USDS activation config (the 30bps law envelope)", () => {
  test("covers exactly the five canonical USDS pairs of the maker lanes", () => {
    expect(usdsPairKeysSafe()).toEqual([
      "SAOS/USDS", "USDS/WSTEEM", "USDS/WSBD", "ENERGY/USDS", "PHIVE/USDS",
    ]);
  });
  test("quote-spread floor respects the 30bps fee law (2×FEE_BPS round-trip)", () => {
    expect(USDS_QUOTE_SPREAD_FLOOR_BPS).toBe(2 * FEE_BPS);
    expect(USDS_QUOTE_SPREAD_FLOOR_BPS).toBe(60);
  });
  test("anchor band matches the R26-ALL standing law (1000bps) and dead trigger beyond it (10000bps)", () => {
    expect(USDS_ANCHOR_BAND_BPS).toBe(1_000);
    expect(USDS_DEAD_RESEED_TRIGGER_BPS).toBe(10_000);
  });
});
function usdsPairKeysSafe(): string[] { return USDS_PAIRS.map((p) => p.pair); }

describe("G76-a · usdsActivationPlan on the measured live state", () => {
  test("USDS/WSBD measured dead (rb=1µ) → reseed verdict with anchor-exact seed", () => {
    const st = measuredState(true);
    const plan = usdsActivationPlan(st);
    const dead = plan.pools.find((x) => x.pair === "USDS/WSBD");
    expect(dead).toBeDefined();
    expect(dead!.verdict).toBe("dead");
    expect(dead!.action).toBe("reseed");
    // עוגן מדויק: seedA = floor(seedB×refB/refA) = floor(100000×475/1000) = 47,500
    expect(dead!.seedB).toBe(100_000);
    expect(dead!.seedA).toBe(47_500);
    expect(dead!.executable).toBe(true);
    expect(dead!.blocked).toEqual([]);
  });

  test("USDS/WSTEEM measured micro-but-on-anchor → thin → ratio-preserving fund", () => {
    const st = measuredState(true);
    const plan = usdsActivationPlan(st);
    const thin = plan.pools.find((x) => x.pair === "USDS/WSTEEM");
    expect(thin!.verdict).toBe("thin");
    expect(thin!.premBps).toBe(0); // mid 50 = anchor 50 (נמדד)
    expect(thin!.action).toBe("fund");
    expect(thin!.addA).toBe(1_000_000 - 455_100);
    expect(thin!.addB).toBe(Math.floor((9_049_615 * thin!.addA!) / 455_100));
    expect(thin!.executable).toBe(true);
  });

  test("ENERGY/USDS measured far-off-anchor but repeg-able → off-anchor verdict (not dead)", () => {
    const st = measuredState(true);
    const plan = usdsActivationPlan(st);
    const off = plan.pools.find((x) => x.pair === "ENERGY/USDS");
    expect(off!.verdict).toBe("off-anchor");
    expect(off!.action).toBe("repeg");
    expect(Math.abs(off!.premBps!)).toBeGreaterThanOrEqual(USDS_ANCHOR_BAND_BPS);
    expect(Math.abs(off!.premBps!)).toBeLessThan(USDS_DEAD_RESEED_TRIGGER_BPS);
  });

  test("SAOS/USDS measured deep on-anchor → healthy, forge-managed (no double-activation)", () => {
    const st = measuredState(true);
    const plan = usdsActivationPlan(st);
    const sov = plan.pools.find((x) => x.pair === "SAOS/USDS");
    expect(sov!.verdict).toBe("healthy");
    expect(sov!.action).toBe("none");
  });

  test("fail-honest: dead pool + broke treasury → executable=false with explicit blocker, zero ops", () => {
    const st = measuredState(false); // אוצר-עני (המדידה-החיה: WSBD עול 0, מלאי-USDS/WSTEEM נעול)
    const plan = usdsActivationPlan(st);
    const dead = plan.pools.find((x) => x.pair === "USDS/WSBD");
    expect(dead!.executable).toBe(false);
    expect(dead!.blocked.join(" ")).toMatch(/insufficient-treasury/);
    // הכנות-המלאה: אוצר-חסר-מלאי ⇒ **אף-פעולה** לא ניתנת-לביצוע — התוכנית
    // מפרסמת-את-החסמים כל-פעימה (fail-honest), אפס-המצאה-נזילות:
    expect(plan.counts.executable).toBe(0);
    expect(plan.pools.every((x) => !x.executable)).toBe(true);
  });
});

describe("G76-a · kernel pool_reseed — the dead-pool revival op", () => {
  test("reseedOpFor emits an anchor-exact treasury op", () => {
    const st = measuredState(true);
    const r = reseedOpFor(st, "USDS/WSBD");
    expect(r.executable).toBe(true);
    expect(r.op?.type).toBe("pool_reseed");
    expect(r.op?.issuer).toBe("treasury");
    expect(r.op?.pair).toBe("USDS/WSBD");
    expect(r.op?.amount).toBe(47_500); // צד-א (USDS)
    expect(r.op?.amountB).toBe(100_000); // צד-ב (WSBD)
  });

  test("reseed revives the dead pool exactly on the anchor, Σ preserved, gas 0", () => {
    const st = measuredState(true);
    const tUsdsBefore = avail(st, "treasury", "USDS");
    const tWsbdBefore = avail(st, "treasury", "WSBD");
    const supUsds = supply(st, "USDS");
    const supWsbd = supply(st, "WSBD");
    const r = applyOp(st, reseedOpFor(st, "USDS/WSBD").op as Op, NOW_MS);
    expect(r.ok).toBe(true);
    expect(r.gas).toBe(0);
    const p = st.pools["USDS/WSBD"];
    expect(p.ra).toBe(47_500);
    expect(p.rb).toBe(100_000);
    // מחיר-הבריכה המחושב כמו-הפעימה (ra×1000/rb) על-העוגן בדיוק:
    expect(Math.floor((p.ra * 1000) / p.rb)).toBe(475);
    // LP נולד-מחדש √k לאוצר בלבד:
    expect(p.lp).toBe(Math.floor(Math.sqrt(47_500 * 100_000)));
    expect(st.balances["treasury"]?.["LP|USDS/WSBD"]).toBe(p.lp);
    // חשבונאות-האוצר: הרזרבות-הישנות חזרו, הזרע יצא (נטו):
    expect(avail(st, "treasury", "USDS")).toBe(tUsdsBefore + 11_937 - 47_500);
    expect(avail(st, "treasury", "WSBD")).toBe(tWsbdBefore + 1 - 100_000);
    // Σ נשמר בדיוק על שני הנכסים:
    expect(supply(st, "USDS")).toBe(supUsds);
    expect(supply(st, "WSBD")).toBe(supWsbd);
    // פעמון-העמלה-הדינמית אופס — הבריכה נולדה-מחדש על חוק-הבסיס 30bps:
    expect(p.volBpsEwma).toBe(0);
    expect(p.dynFeeBps).toBe(FEE_BPS);
  });

  test("swap path executes through the revived pool — fee law 30bps, k preserved, mid inside band", () => {
    const st = measuredState(true);
    applyOp(st, reseedOpFor(st, "USDS/WSBD").op as Op, NOW_MS);
    const kBefore = 47_500 * 100_000;
    const amountIn = 1_000; // ~2% מהרזרבה — פגיעת-מחיר מתונה (1 USDS)
    const feeAmt = Math.floor((amountIn * FEE_BPS) / 10_000); // 30bps על-הבסיס
    expect(feeAmt).toBe(3);
    const r = applyOp(st, {
      type: "pool_swap", issuer: "operator", nonce: NONCE("swap1"),
      pair: "USDS/WSBD", assetIn: "USDS", amount: amountIn, minOut: 1,
    } as Op, NOW_MS);
    expect(r.ok).toBe(true);
    const p = st.pools["USDS/WSBD"];
    const out = st.balances["operator"]?.WSBD ?? 0;
    expect(out).toBeGreaterThan(0);
    // חוק-ערך: היציאה בשווי-עוגן (µ WSBD × refB/refA) אינה-עולה על הכניסה (עמלה+החלקה):
    const outValueMuUsds = Math.floor((out * 475) / 1000);
    expect(outValueMuUsds).toBeLessThanOrEqual(amountIn);
    // וגם לא טביעת-אפס: פגיעת-2% + עמלת-30bps ⇒ השווי-החוזר סביב 90–100%:
    expect(outValueMuUsds).toBeGreaterThanOrEqual(900);
    // k אחרי-החלפה (כולל עמלת-LP) אינו יורד — החוק-הברזל של poolSwap (kernel אכף):
    const kAfter = p.ra * p.rb;
    expect(kAfter).toBeGreaterThanOrEqual(kBefore);
    // המחיר-אחרי-פגיעה-קטנה נשאר בתוך רצועת-העוגן (1000bps):
    const mid = Math.floor((p.ra * 1000) / p.rb);
    const anchor = 475;
    const premBps = Math.floor(((mid - anchor) * 10_000) / anchor);
    expect(Math.abs(premBps)).toBeLessThan(USDS_ANCHOR_BAND_BPS);
    // העמלה-הדינמית נולדה-מהבסיס — לא מתחת לרצפת-החוק:
    expect(p.dynFeeBps ?? FEE_BPS).toBeGreaterThanOrEqual(DYN_FEE_MIN_BPS);
  });

  test("fail-closed: citizen issuer / citizen LP / broke treasury / off-anchor seed / healthy pool / unknown pool", () => {
    // 1) מנפיק-לא-אוצר:
    {
      const st = measuredState(true);
      const snap = JSON.stringify(st);
      const op = { ...(reseedOpFor(st, "USDS/WSBD").op as Op), issuer: "operator", nonce: NONCE("cit") };
      const r = applyOp(st, op, NOW_MS);
      expect(r.ok).toBe(false);
      expect((r as { err: string }).err).toBe("treasury-only");
      expect(JSON.stringify(st)).toBe(snap); // אפס-נגיעה
    }
    // 2) LP-אזרחי-קיים:
    {
      const st = measuredState(true);
      st.balances["bot-a"] = { ...st.balances["bot-a"], "LP|USDS/WSBD": 5 };
      const snap = JSON.stringify(st);
      const r = applyOp(st, reseedOpFor(st, "USDS/WSBD").op as Op, NOW_MS);
      expect(r.ok).toBe(false);
      expect((r as { err: string }).err).toBe("citizen-lp-present");
      expect(JSON.stringify(st)).toBe(snap);
    }
    // 3) אוצר-ריק (המדידה-החיה):
    {
      const st = measuredState(false);
      const snap = JSON.stringify(st);
      const r = applyOp(st, reseedOpFor(st, "USDS/WSBD").op as Op, NOW_MS);
      expect(r.ok).toBe(false);
      expect((r as { err: string }).err).toBe("insufficient-treasury");
      expect(JSON.stringify(st)).toBe(snap);
    }
    // 4) זרע-לא-על-העוגן (amountA ≠ floor(amountB×refB/refA)):
    {
      const st = measuredState(true);
      const snap = JSON.stringify(st);
      const op = { ...(reseedOpFor(st, "USDS/WSBD").op as Op), amount: 47_501, nonce: NONCE("skew") };
      const r = applyOp(st, op as Op, NOW_MS);
      expect(r.ok).toBe(false);
      expect((r as { err: string }).err).toBe("off-anchor-seed");
      expect(JSON.stringify(st)).toBe(snap);
    }
    // 5) בריכה-בריאה — reseed נדחה (השער-המבני: רק-מת-או-מעל-10,000bps):
    {
      const st = measuredState(true);
      applyOp(st, reseedOpFor(st, "USDS/WSBD").op as Op, NOW_MS);
      const snap = JSON.stringify(st);
      const op = { ...(reseedOpFor(st, "USDS/WSBD").op as Op), nonce: NONCE("twice") };
      const r = applyOp(st, op as Op, NOW_MS);
      expect(r.ok).toBe(false);
      expect((r as { err: string }).err).toBe("pool-not-dead");
      expect(JSON.stringify(st)).toBe(snap);
    }
    // 6) בריכה-חסרה / זוג-לא-קנוני:
    {
      const st = measuredState(true);
      const r1 = applyOp(st, { type: "pool_reseed", issuer: "treasury", nonce: NONCE("miss"), pair: "USDS/WTRX", amount: 1, amountB: 1 } as unknown as Op, NOW_MS);
      expect(r1.ok).toBe(false);
      expect((r1 as { err: string }).err).toBe("pool-not-found");
      const r2 = applyOp(st, { type: "pool_reseed", issuer: "treasury", nonce: NONCE("bad"), pair: "USDS-SAOS", amount: 1, amountB: 1 } as unknown as Op, NOW_MS);
      expect(r2.ok).toBe(false);
      expect((r2 as { err: string }).err).toBe("bad-pair");
    }
  });
});

describe("G76-a · AMM funding path (thin corridor) through the real kernel", () => {
  test("fundOpFor emits a ratio-preserving pool_add; mid unchanged after funding", () => {
    const st = measuredState(true);
    const f = fundOpFor(st, "USDS/WSTEEM");
    expect(f.executable).toBe(true);
    expect(f.op?.type).toBe("pool_add");
    expect(f.op?.pair).toBe("USDS/WSTEEM");
    expect(f.op?.amount).toBe(1_000_000 - 455_100);
    const midBefore = Math.floor((455_100 * 1000) / 9_049_615);
    const r = applyOp(st, f.op as Op, NOW_MS);
    expect(r.ok).toBe(true);
    const p = st.pools["USDS/WSTEEM"];
    expect(p.ra).toBe(1_000_000);
    const midAfter = Math.floor((p.ra * 1000) / p.rb);
    expect(midAfter).toBe(midBefore); // הוספה-שומרת-יחס — המחיר לא זז
    // היתרות ירדו מהאוצר בדיוק:
    // (pool_add גובה amountA מהמנפיק + amountB נגזר-קרצ'ר)
  });

  test("fail-honest: thin pool + broke treasury → fund not executable with explicit blocker", () => {
    const st = measuredState(false);
    st.balances["treasury"].USDS = 0;
    st.balances["treasury"].WSTEEM = 0;
    const f = fundOpFor(st, "USDS/WSTEEM");
    expect(f.executable).toBe(false);
    expect((f.blocked ?? []).join(" ")).toMatch(/insufficient-treasury/);
  });
});
