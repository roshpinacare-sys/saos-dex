/**
 * usds-refloat.test.ts — G77-e · רכבת-ההצפה-מחדש של-האוצר (TREASURY REFLOAT).
 * ═══════════════════════════════════════════════════════════════════════════════
 * דטרמיניסטי לחלוטין: genesisState() + המצב-המדוד-החי (db/state-snapshot.json
 * @h1753690 · main 521de810 · 2026-10-26T14:56Z). אפס-רשת · אפס-זמן-קיר · אפס-רנדום.
 *
 * הממצא-החי שהמודול נכתב-בשבילו (מדידה h1753690):
 *   · האוצר מחזיק +1,000,999µ USDS אבל **999,948µ נעולים** בפקודת-ENERGY/USDS-buy
 *     מחיר 54,636µ/ENERGY — **437x מהעוגן** (prem +4,360,880bps) — פצצת-הדמדומים
 *     של-הספר: כל-מוכר-שייכנס אליה משלם-את-עצמו 437x על-חשבון-האוצר.
 *   · ו-+99,230µ WSBD נעולים בפקודת-WSBD/USDS-sell מחיר 7,164,802µ/WSBD —
 *     **15,147x מהעוגן** — מלכודת-מחיר חיה מול-קונה-תמים.
 *   · בדיוק-הנעילות-האלה חוסמות-את-reseed-של-USDS/WSBD (הבריכה-המתה rb=1µ).
 *
 * החוקים-הנבדקים:
 *  1. מיחזור (recycle): פקודת-אוצר שמחירה ±5,000bps מהעוגן = מתה-מבנית/מסוכנת —
 *     op-cancel-פר-פקודה (הגרעין תומך-ביטול — owner-check fail-closed), הנעילה
 *     חוזרת-לצף, Σ נשמר. ציטוט-בריא (148bps) לא-נגע.
 *  2. reseed-רוחב-חלקי (partial-width): כשהזרע-המלא חסום-מלאי — זריעה-שומרת-יחס
 *     בגודל-הצף-האמיתי, שער-אבק 10,000µ-צד-b fail-closed, חסמים-כנים-מדויקים.
 *  3. pool_add-רוחב-חלקי: העמקה-שומרת-יחס בגודל-הצף, אותו-שער-אבק, מחיר-בריכה לא זז.
 *  4. usdsSidesOnce — החוות-דעת של --once: מיחזור→reseed→fund→repeg ברצף על
 *     עותק-מצב-אמת דרך-הגרעין-האמיתי (אפס-מוק) — EXECUTED/BLOCKED-בגירעון-המדויק,
 *     דלק-מגולה (fuelTopMu = גז-הגרעין-המדויק בלבד).
 */
import { describe, test, expect } from "bun:test";
import {
  applyOp,
  genesisState,
  avail,
  type DexState,
  type Op,
} from "./kernel";
import {
  USDS_RESEED_DUST_B_MU,
  USDS_FUND_DUST_A_MU,
  USDS_RECYCLE_OFFBOOK_BPS,
  anchorBookPxMu,
  parkedTreasuryOrders,
  recycleOpsFor,
  partialReseedOpFor,
  partialFundOpFor,
  usdsSidesOnce,
} from "./usds-refloat";

const NOW_MS = 1_700_000_000_000;

/** Σ(יתרות+רזרבות) לנכס — חוק-שימור-הברזל. */
const supply = (st: DexState, a: string): number => {
  let s = 0;
  for (const w of Object.values(st.balances)) s += w[a] ?? 0;
  for (const p of Object.values(st.pools)) { if (p.a === a) s += p.ra; if (p.b === a) s += p.rb; }
  return s;
};

/**
 * המצב-המדוד-החי (h1753690 · main 521de810 · 2026-10-26T14:56:33Z) — כל-מספר
 * מהמדידה, אפס-המצאה. שני-פקודות-האוצר החיות מוצבות כשהן בספר (ids אמת).
 * opts קובע-תרחיש-צף: כשערך-ניתן — הנעילה של-אותו-נכס מתאפסת ("הדלק-הגיע");
 * בלי-opts — המדידה-החיה המלאה (הנעילות-העומדות במקומן).
 */
function measuredState(opts?: { wsbdMu?: number; usdsMu?: number; wsteemMu?: number }): DexState {
  const st = genesisState();
  st.height = 1_753_690;
  st.assets = {
    SAOS: { refPrice: 1014, listed: 694852 },
    USDS: { refPrice: 1000, listed: 0 },
    WSTEEM: { refPrice: 50, listed: 0 },
    ENERGY: { refPrice: 125, listed: 0 },
    WSBD: { refPrice: 473, listed: 0 },
    PHIVE: { refPrice: 48, listed: 0 },
  };
  st.pools = {
    "SAOS/USDS": { a: "SAOS", b: "USDS", ra: 98_841_561, rb: 100_504_064, lp: 65_636_527, feeAccruedTreasury: 19_568_344, swaps: 66_064 },
    "USDS/WSTEEM": { a: "USDS", b: "WSTEEM", ra: 455_100, rb: 9_049_615, lp: 5_656_854, feeAccruedTreasury: 12_253, swaps: 57 },
    "ENERGY/SAOS": { a: "ENERGY", b: "SAOS", ra: 3_927, rb: 318_997, lp: 14_142, feeAccruedTreasury: 43_892, swaps: 282 },
    "USDS/WSBD": { a: "USDS", b: "WSBD", ra: 11_937, rb: 1, lp: 2_236, feeAccruedTreasury: 2_427_905, swaps: 3_312 },
    "ENERGY/USDS": { a: "ENERGY", b: "USDS", ra: 174_258, rb: 15_861_338, lp: 151_977, feeAccruedTreasury: 1_150_466, swaps: 2_075 },
    "PHIVE/USDS": { a: "PHIVE", b: "USDS", ra: 12_096_176, rb: 8_393_105, lp: 7_901_153, feeAccruedTreasury: 860_473, swaps: 1_703 },
  } as DexState["pools"];
  st.balances["treasury"] = {
    ...st.balances["treasury"],
    SAOS: 30_002_482, USDS: opts?.usdsMu ?? 1_000_999, STEEM: 0, WSTEEM: opts?.wsteemMu ?? 46_621,
    ENERGY: 15, WSBD: opts?.wsbdMu ?? 99_230, PHIVE: 298,
    "LP|SAOS/USDS": 65_636_527, "LP|USDS/WSTEEM": 5_656_854, "LP|ENERGY/SAOS": 14_142,
    "LP|USDS/WSBD": 2_236, "LP|ENERGY/USDS": 89_200, "LP|PHIVE/USDS": 7_901_153,
  };
  // הנעילות-החיות של-שתי-פקודות-האוצר (המדידה: st.locked.treasury);
  // תרחיש-צף (opts) מניח-שהפקודה-העומדת של-אותו-נכס נמחזרה-כבר (נעילה 0):
  st.locked["treasury"] = {
    USDS: opts?.usdsMu !== undefined ? 0 : 999_948,
    WSTEEM: opts?.wsteemMu !== undefined ? 0 : 0,
    WSBD: opts?.wsbdMu !== undefined ? 0 : 99_230,
    PHIVE: 0, ENERGY: 0, SAOS: 0,
  };
  // הפקודות-החיות בספר (ids/מחירים/כמויות מהמדידה החיה):
  st.orders = [
    { seq: 1327834, id: 1327834, owner: "treasury", base: "WSBD", quote: "USDS", side: "sell", price: 7_164_802, amount: 99_230, filled: 0, live: true, nonce: "measured-1327834", at: 1_792_476_698_322, lockMu: 99_230 },
    { seq: 1327836, id: 1327836, owner: "treasury", base: "ENERGY", quote: "USDS", side: "buy", price: 54_636, amount: 18_302, filled: 0, live: true, nonce: "measured-1327836", at: 1_792_476_698_322, lockMu: 999_948 },
    // ציטוט-בריא להשוואה (החוק: ±148bps — לא-נוגעים):
    { seq: 1327900, id: 1327900, owner: "treasury", base: "WSBD", quote: "USDS", side: "sell", price: 480, amount: 5_000, filled: 0, live: true, nonce: "measured-1327900", at: 1_792_476_698_322, lockMu: 5_000 },
  ] as DexState["orders"];
  st.credits = { ...st.credits, treasury: 10_000 }; // דלק-יחידת-בדיקה (הגרעין גובה-גז-אמת)
  return st;
}

describe("G77-e · the recycle law (treasury hazard-order float recovery)", () => {
  test("anchorBookPxMu — the measured anchors (WSBD 473 · ENERGY 125 vs USDS)", () => {
    const st = measuredState();
    expect(anchorBookPxMu(st, "WSBD", "USDS")).toBe(473);
    expect(anchorBookPxMu(st, "ENERGY", "USDS")).toBe(125);
    expect(anchorBookPxMu(st, "USDS", "USDS")).toBe(1000);
    expect(anchorBookPxMu(st, "WSBD", "SAOS")).toBe(Math.floor((473 * 1000) / 1014));
  });

  test("parked: exactly the two measured hazard orders are recyclable (prem ≥ 5000bps), the healthy quote is not", () => {
    const st = measuredState();
    const rows = parkedTreasuryOrders(st);
    const rec = rows.filter((r) => r.recyclable);
    expect(rec.map((r) => r.orderId).sort((a, b) => a - b)).toEqual([1327834, 1327836]);
    const wsbd = rec.find((r) => r.orderId === 1327834)!;
    expect(wsbd.market).toBe("WSBD/USDS");
    expect(wsbd.lockAsset).toBe("WSBD");
    expect(wsbd.lockMu).toBe(99_230);
    expect(wsbd.premBps).toBe(Math.floor(((7_164_802 - 473) * 10_000) / 473));
    const en = rec.find((r) => r.orderId === 1327836)!;
    expect(en.lockAsset).toBe("USDS");
    expect(en.lockMu).toBe(999_948);
    // הציטוט-הבריר 148bps — נשאר על הספר (החוק לא בוטל ציטוט-שוק):
    const healthy = rows.find((r) => r.orderId === 1327900)!;
    expect(healthy.recyclable).toBe(false);
    expect(Math.abs(healthy.premBps)).toBeLessThan(USDS_RECYCLE_OFFBOOK_BPS);
  });

  test("recycleOpsFor emits one treasury cancel op per hazard order with exact freed amounts", () => {
    const st = measuredState();
    const r = recycleOpsFor(st);
    expect(r.ops.length).toBe(2);
    expect(r.freedMuByAsset["WSBD"]).toBe(99_230);
    expect(r.freedMuByAsset["USDS"]).toBe(999_948);
    for (const o of r.ops) {
      expect(o.op.type).toBe("cancel");
      expect(o.op.issuer).toBe("treasury");
      expect(o.op.orderId).toBeDefined();
    }
  });

  test("recycle through the real kernel: locks return to float, Σ preserved, healthy quote untouched", () => {
    const st = measuredState();
    const supUsds = supply(st, "USDS");
    const supWsbd = supply(st, "WSBD");
    const freeUsdsBefore = avail(st, "treasury", "USDS");
    const freeWsbdBefore = avail(st, "treasury", "WSBD");
    const r = recycleOpsFor(st);
    for (const o of r.ops) {
      const res = applyOp(st, o.op as Op, NOW_MS);
      expect(res.ok).toBe(true);
    }
    expect(avail(st, "treasury", "USDS")).toBe(freeUsdsBefore + 999_948);
    expect(avail(st, "treasury", "WSBD")).toBe(freeWsbdBefore + 99_230);
    expect(st.locked["treasury"]?.USDS ?? 0).toBe(0);
    expect(st.locked["treasury"]?.WSBD ?? 0).toBe(0);
    expect(supply(st, "USDS")).toBe(supUsds);
    expect(supply(st, "WSBD")).toBe(supWsbd);
    // הציטוט-הבריר עוד-חי:
    expect(st.orders.find((o) => o.id === 1327900)?.live).toBe(true);
  });

  test("fail-closed: the kernel refuses a recycle-cancel by a non-owner (the law holds without us)", () => {
    const st = measuredState();
    const r = recycleOpsFor(st);
    const op = { ...r.ops[0]!.op, issuer: "arena", nonce: "g77e-not-owner" } as Op;
    const res = applyOp(st, op, NOW_MS);
    expect(res.ok).toBe(false);
    expect((res as { err: string }).err).toBe("not-owner");
  });

  test("no-anchor market: a treasury order whose anchor cannot be computed is recyclable (no lawful quote without an oracle)", () => {
    const st = measuredState();
    st.assets["WSBD"] = { refPrice: 0, listed: 0 }; // העוגן מת — אין-ציטוט-כשר אפשרי
    const rows = parkedTreasuryOrders(st);
    const wsbd = rows.find((r) => r.orderId === 1327834)!;
    expect(wsbd.anchorMu).toBe(0);
    expect(wsbd.recyclable).toBe(true); // בלי-עוגן אין-הוכחה-לציטוט — הצף משוחרר
    const r = recycleOpsFor(st);
    expect(r.ops.map((o) => o.orderId)).toContain(1327834);
    const res = applyOp(st, r.ops.find((o) => o.orderId === 1327834)!.op as Op, NOW_MS);
    expect(res.ok).toBe(true); // הביטול עצמו חוקי-תמיד — Σ נשמר
    expect(st.locked["treasury"]?.WSBD ?? 0).toBe(0);
  });
});

describe("G77-e · partial-width reseed (the lawful fractional revival)", () => {
  test("post-recycle float (99,231µ WSBD affordable) → fractional reseed at width 99, on-anchor", () => {
    const st = measuredState();
    for (const o of recycleOpsFor(st).ops) applyOp(st, o.op as Op, NOW_MS);
    const r = partialReseedOpFor(st, "USDS/WSBD");
    expect(r.executable).toBe(true);
    // affordableB = צף-חופשי-אחרי-מיחזור 99,230 + רזרבה-חוזרת 1 = 99,231 < יעד-100,000
    expect(r.seedB).toBe(99_231);
    expect(r.seedA).toBe(Math.floor((473 * 99_231) / 1000)); // 46,936 — עוגן-מדויק
    expect(r.seedB).toBeLessThan(100_000); // הזרע-המלא נשאר-חסום (G76-a): צריך 99,999µ WSBD חופשי, יש 99,230:
    expect(r.fullBlocked.join(" ")).toContain("WSBD+99999µ");
    expect(r.widthPct).toBe(99);
  });

  test("broke-treasury float → fractional seed at exactly the affordable width, on-anchor", () => {
    const st = measuredState({ wsbdMu: 50_000, usdsMu: 40_000 });
    const r = partialReseedOpFor(st, "USDS/WSBD");
    expect(r.executable).toBe(true);
    // affordableB = 50,000+1 = 50,001 → seedB = 50,001; seedA = floor(473×50,001/1000) = 23,650
    expect(r.seedB).toBe(50_001);
    expect(r.seedA).toBe(Math.floor((473 * 50_001) / 1000));
    expect(r.widthPct).toBe(Math.floor((50_001 * 100) / 100_000));
    // הגרעין מקבל — על-העוגן (שלמים: mid בטווח ±1mµ מהעוגן, בתוך-רצועת-החוק), Σ נשמר:
    const supU = supply(st, "USDS");
    const supW = supply(st, "WSBD");
    const res = applyOp(st, r.op as Op, NOW_MS);
    expect(res.ok).toBe(true);
    const p = st.pools["USDS/WSBD"];
    expect(p.ra).toBe(r.seedA);
    expect(p.rb).toBe(r.seedB);
    const mid = Math.floor((p.ra * 1000) / p.rb);
    expect(Math.abs(mid - 473)).toBeLessThanOrEqual(1); // דיוק-השלמים של-הנגזרת-הקנונית
    const prem = Math.floor(((mid - 473) * 10_000) / 473);
    expect(Math.abs(prem)).toBeLessThan(1_000); // בתוך-רצועת-העוגן (R26-ALL)
    expect(supply(st, "USDS")).toBe(supU);
    expect(supply(st, "WSBD")).toBe(supW);
  });

  test("fail-closed under the dust floor (10000µ B): honest exact deficits, zero ops", () => {
    const st = measuredState({ wsbdMu: 5_000, usdsMu: 2_000_000 });
    const snap = JSON.stringify(st);
    const r = partialReseedOpFor(st, "USDS/WSBD");
    expect(r.executable).toBe(false);
    expect(r.op).toBeNull();
    // affordableB = 5,000+1 → גירעון בדויק: 10,000−5,001
    expect(r.blocked.join(" ")).toContain(`B+${USDS_RESEED_DUST_B_MU - 5_001}µ`);
    // seedA-מינימלי על העוגן: floor(473×10,000/1000)=4,730 — הצף מכסה (defA=0)
    expect(r.blocked.join(" ")).not.toMatch(/A\+\d+µ/);
    expect(JSON.stringify(st)).toBe(snap); // אפס-נגיעה
  });
});

describe("G77-e · partial-width fund (ratio-preserving corridor deepening)", () => {
  test("USDS/WSTEEM thin + fat WSTEEM/USDS float → fund at full target through the kernel", () => {
    const st = measuredState({ wsteemMu: 11_000_000, usdsMu: 2_000_000 });
    const f = partialFundOpFor(st, "USDS/WSTEEM");
    expect(f.executable).toBe(true);
    expect(f.addA).toBe(1_000_000 - 455_100);
    expect(f.addB).toBe(Math.floor((9_049_615 * f.addA!) / 455_100));
    expect(f.widthPct).toBe(100);
    const midBefore = Math.floor((455_100 * 1000) / 9_049_615);
    const res = applyOp(st, f.op as Op, NOW_MS);
    expect(res.ok).toBe(true);
    const p = st.pools["USDS/WSTEEM"];
    expect(p.ra).toBe(1_000_000);
    expect(Math.floor((p.ra * 1000) / p.rb)).toBe(midBefore); // שומר-יחס — המחיר לא זז
  });

  test("thin WSTEEM float → ratio-preserving partial add capped by float, above the dust floor", () => {
    const st = measuredState({ wsteemMu: 500_000, usdsMu: 2_000_000 });
    const f = partialFundOpFor(st, "USDS/WSTEEM");
    expect(f.executable).toBe(true);
    // התקרה מצד-b: floor(((500,000+1)×455,100−1)/9,049,615) = 25,144
    expect(f.addA).toBe(25_144);
    expect(f.addB).toBe(Math.floor((9_049_615 * 25_144) / 455_100)); // 499,985 ≤ 500,000
    expect(f.addB).toBeLessThanOrEqual(500_000);
    expect(f.widthPct).toBe(Math.floor((25_144 * 100) / (1_000_000 - 455_100)));
    const res = applyOp(st, f.op as Op, NOW_MS);
    expect(res.ok).toBe(true);
  });

  test(`fail-closed under the dust floor (${USDS_FUND_DUST_A_MU}µ A): honest exact deficit of the binding side`, () => {
    const st = measuredState({ wsteemMu: 46_621, usdsMu: 2_000_000 }); // המדידה-החיה
    const snap = JSON.stringify(st);
    const f = partialFundOpFor(st, "USDS/WSTEEM");
    expect(f.executable).toBe(false);
    expect(f.op).toBeNull();
    // הרוחב-המינימלי-החוקי: addA=10,000 → addB=floor(9,049,615×10,000/455,100)=198,857
    // הצף-WSTEEM-חופשי 46,621 → גירעון 152,236µ בדויק:
    const minB = Math.floor((9_049_615 * USDS_FUND_DUST_A_MU) / 455_100);
    expect(f.blocked.join(" ")).toContain(`B+${minB - 46_621}µ`);
    expect(JSON.stringify(st)).toBe(snap);
  });
});

describe("G77-e · usdsSidesOnce — the honest --once verdict on the measured live state", () => {
  test("recycle→reseed→fund→repeg in order: 3 EXECUTED (2 cancels + full reseed) and 3 BLOCKED with exact deficits", () => {
    const st = measuredState();
    const once = usdsSidesOnce(st);
    expect(once.atH).toBe(1_753_690);
    // הצף-החופשי הנמדד:
    const fl = Object.fromEntries(once.treasuryFloat.map((f) => [f.asset, f.freeMu]));
    expect(fl["USDS"]).toBe(1_051); // 1,000,999−999,948
    expect(fl["WSBD"]).toBe(0);
    // המיחזור ראשון — שתי-הפקודות EXECUTED (על עותק-אמת דרך-הגרעין):
    const rec = once.ops.filter((o) => o.kind === "recycle-cancel");
    expect(rec.length).toBe(2);
    expect(rec.every((o) => o.verdict === "EXECUTED")).toBe(true);
    expect(once.counts.freedMuByAsset["USDS"]).toBe(999_948);
    expect(once.counts.freedMuByAsset["WSBD"]).toBe(99_230);
    // USDS/WSBD: אחרי-המיחזור הזרע-המלא-עדיין-חסום (99,231µ אפשרי) — reseed-חלקי 99% EXECUTED:
    const rs = once.ops.find((o) => o.pair === "USDS/WSBD");
    expect(rs?.kind).toBe("pool-reseed-partial");
    expect(rs?.verdict).toBe("EXECUTED");
    expect(rs?.detail?.seedB).toBe(99_231);
    expect(rs?.detail?.seedA).toBe(46_936);
    expect(rs?.detail?.widthPct).toBe(99);
    // USDS/WSTEEM: thin — חסום-אבק-WSTEEM בגירעון-המדויק:
    const fu = once.ops.find((o) => o.pair === "USDS/WSTEEM");
    expect(fu?.verdict).toBe("BLOCKED");
    expect(fu?.blocked.join(" ")).toContain("B+152227µ");
    // ENERGY/USDS + PHIVE/USDS: off-anchor — repeg חסום-מלאי בגירעון-המדויק:
    const en = once.ops.find((o) => o.pair === "ENERGY/USDS");
    expect(en?.verdict).toBe("BLOCKED");
    expect(en?.blocked.join(" ")).toContain("A+126716431µ");
    const ph = once.ops.find((o) => o.pair === "PHIVE/USDS");
    expect(ph?.verdict).toBe("BLOCKED");
    expect(ph?.blocked.join(" ")).toContain("A+162759880µ");
    expect(once.counts.executed).toBe(3);
    expect(once.counts.blocked).toBe(3);
  });

  test("Σ-preservation through the whole once-plan (recycle + reseed landed on the verification clone)", () => {
    const st = measuredState();
    const once = usdsSidesOnce(st);
    const clone = JSON.parse(JSON.stringify(st)) as DexState;
    for (const row of once.ops) {
      if (row.verdict !== "EXECUTED" || !row.op) continue;
      const r = applyOp(clone, row.op as Op, NOW_MS);
      expect(r.ok).toBe(true);
    }
    for (const a of ["USDS", "WSBD", "WSTEEM", "ENERGY", "PHIVE", "SAOS"]) {
      expect(supply(clone, a)).toBe(supply(st, a)); // הברזל: אף-µ לא נולד ולא נעלם
    }
  });

  test("determinism: two runs produce byte-identical receipts (no wall-clock in the plan)", () => {
    const a = usdsSidesOnce(measuredState());
    const b = usdsSidesOnce(measuredState());
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe("G77-e · tape settlement — USDS fills/swaps land on the public tape rows", () => {
  /** חוק-הסליל: כל-מילוי-ספר (book.ts:217) וכל-החלפת-בריכה (amm.ts:138) מניבים
   * שורת-TapeEvent (kind fill/swap · base/quote · price · amountMu) שהפעימה
   * דוחפת-לסליל-הציבורי (chain.ts:879). הבדיקה מוכיחה שהזוגות-המופעלים של-USDS
   * זורמים-לסליל בדיוק-כמו-SAOS — אין-מסנן-נכסים, אין-שורות-חסרות. */
  test("book fill on WSBD/USDS emits a tape row (kind fill · quote USDS · maker price)", () => {
    const st = measuredState();
    for (const o of recycleOpsFor(st).ops) expect(applyOp(st, o.op as Op, NOW_MS).ok).toBe(true);
    // האוצר מצטט-מחדש-חוקי על-העוגן אחרי-המיחזור (הצף-המשוחרר עובד):
    const pl = applyOp(
      st,
      { type: "order", issuer: "treasury", nonce: "g77e-requote", base: "WSBD", quote: "USDS", side: "sell", price: 480, amount: 5_000 } as Op,
      NOW_MS,
    );
    expect(pl.ok).toBe(true);
    const fillsBefore = st.stats.fills;
    // ארנה חוצה-את-הציטוט-הטרי של-האוצר (WSBD sell @480 · +148bps על-העוגן 473):
    const r = applyOp(
      st,
      { type: "fill", issuer: "arena", nonce: "g77e-tape-fill", base: "WSBD", quote: "USDS", side: "buy", amount: 2_000, market: true } as Op,
      NOW_MS,
    );
    expect(r.ok).toBe(true);
    const evs = (r as { events?: { kind: string; base: string; quote: string; price: number; amountMu: number; taker: string; maker?: string }[] }).events ?? [];
    const row = evs.find((e) => e.kind === "fill");
    expect(row).toBeDefined();
    expect(row!.base).toBe("WSBD");
    expect(row!.quote).toBe("USDS");
    expect(row!.price).toBe(480); // מילוי-תמיד במחיר-המייקר
    expect(row!.amountMu).toBe(2_000);
    expect(row!.taker).toBe("arena");
    expect(row!.maker).toBe("treasury");
    expect(st.stats.fills).toBe(fillsBefore + 1); // fillsTotal סופר USDS בדיוק-כמו-SAOS
  });

  test("AMM swap on the revived USDS/WSBD pool emits a tape row (kind swap · quoteMu dimensional)", () => {
    const st = measuredState();
    for (const o of recycleOpsFor(st).ops) expect(applyOp(st, o.op as Op, NOW_MS).ok).toBe(true);
    const pr = partialReseedOpFor(st, "USDS/WSBD");
    expect(applyOp(st, pr.op as Op, NOW_MS).ok).toBe(true); // הבריכה חיה על-העוגן
    const swapsBefore = st.stats.swaps;
    const r = applyOp(
      st,
      { type: "pool_swap", issuer: "arena", nonce: "g77e-tape-swap", pair: "USDS/WSBD", assetIn: "USDS", amount: 10_000 } as Op,
      NOW_MS,
    );
    expect(r.ok).toBe(true); // המסדרון-המוחזר מצטט ומקבל-מסחר אמת
    const evs = (r as { events?: { kind: string; base: string; quote: string; amountMu: number; quoteMu?: number }[] }).events ?? [];
    const row = evs.find((e) => e.kind === "swap");
    expect(row).toBeDefined();
    expect(row!.base).toBe("USDS");
    expect(row!.quote).toBe("WSBD");
    expect(row!.amountMu).toBe(10_000);
    expect(row!.quoteMu).toBe(10_000); // קנייה (assetIn=quote) → quoteMu=amountIn
    expect(st.stats.swaps).toBe(swapsBefore + 1);
  });
});
