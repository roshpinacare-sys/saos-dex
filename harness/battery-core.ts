/**
 * battery-core.ts — THE INVARIANT BATTERY · סוללת-האינוואריאנטות (מוזרקת-תלויות)
 * ═══════════════════════════════════════════════════════════════════════════════
 * EXEC-CD-35 · "בדוק את הטענות שלך כאילו הן שקר" — המכשיר הבא אחרי ה-fuzzer:
 * **ביקורת-המבקר (mutation testing)**. הסוויט הישנה יכלה להריץ 960-op ולהציג PASS
 * גם כשהגרעין שבור — אף-אחד לא בדק **אותה**. עכשיו הסוללה מוזרקת-תלויות:
 * הגרעין הנבדק (kernel/canonical/settle) מוזרק מבחוץ — כך הריצה הקנונית והריצה
 * מול-גרסה-מוטנטית של הגרעין עוברות דרך אותו-קוד-בדיקה בדיוק, והמוטנט חייב
 * להיתפס. ערכת mutation-test.ts מזריקה באגים מכוונים ודורשת: כל-מוטנט = מת
 * (נתפס באינוואריאנטה או חריגה-נצפית-מהבזל) — אחרת ה-PASS שלנו הוא שקר.
 *
 * אינוואריאנטות (I1-I8 מורשת-ה-fuzzer + החדשות שנולדו מהמבחן):
 *   I1  REJECT-ATOMICITY     — op נדחה ⇒ canon(state) שווה-בתים.
 *   I2  CREDIT-IDENTITY      — Σcredits + gasUsed − feeMinted === בזל (דיפרנציאלי).
 *   I3  TRANSFER-CONSERVE    — משפחות-טהורות: F(asset) לכל-נכס נשמר.
 *   I4  NO-NEGATIVE/NO-FLOAT — אף-ערך-כסף שלילי/לא-שלם/NaN.
 *   I5  ENGINE-AUDITOR       — האודיטור המוזרק נקי כל-15 ops.
 *   I6  DETERMINISM          — אותו-seed ⇒ אותו-root (ריצה-תאומה).
 *   I7  REPLAY-CLOSED        — op-מקובל שחוזר ⇒ נדחה.
 *   I8  DEFENSE-PROBES       — 24 התקפות-מוכרות נדחות בדלת ובלי-נגיעה במצב.
 *   I9  FEE-TRUTH (חדש)      — לכל-pool_swap מקובל: הסוללה **מחשבת בעצמה** את
 *       מתמטיקת-ההחלפה (עמלה=floor(size·bps/10⁴), חיתוך-אוצר 30%, out=CPMM,
 *       שימור-k, feeMeter/feeAccruedTreasury/יתרות) מהקבועים-**שלה** — לא
 *       מייבאת כלום מהגרעין. מוטנט-עמלה/עיגול/רזרבה סוטה ב-1µ ⇒ נתפס.
 *   I10 AUDITOR-CANARY (חדש) — בסוף: משחיתים +7µ קרדיט במצב-סופי ו**דורשים**
 *       שהאודיטור המוזרק יחזיר ok:false. אודיטור-מנוטרל = כשל-סוללה.
 *   I11 CANON-CANONICALITY (חדש) — סדר-מפתחות לא משנה, undefined נשמט, float/
 *       bigint/non-finite נדחים — על ה-canon המוזרק עצמו.
 *   I12 TRANSFER-EFFECT (חדש) — לכל-transfer מקובל: Δrecipient === amount &&
 *       Δsender === −amount (אפקט בפועל — לא רק "שום-דבר לא נעלם").
 *
 * ערכת-הבזל (golden trace): 10 ops קנוניים על שיבוט-טרי — ה-root, feeMeter,
 * feeAccruedTreasury ותוצאות-ok/err שלהם הן **טביעת-האצבע** שה-mutation-harness
 * משווה מול-הבזל: מוטנט שעבר את כל-האינוואריאנטות אך שינה תצפית-נצפית-כלשהי =
 * נתפס-בדיפרנציאל; מוטנט שגם-שם זהה = שקול-מתועד.
 *
 * נקודת-ה-FEE_BPS: לבריכות-החיות יש dynFeeBps מוצב — מוטנט-קבוע-סטטי היה
 * שקול-נצפית. לכן fundClone מוחק dynFeeBps מבריכת ENERGY/SAOS (ומזרים ל-fuzz-a
 * 15,000 ENERGY מהרזרבות — Σ נשמר): ה-swap הקנוני עליה (12,334) עובר דרך
 * `p.dynFeeBps ?? FEE_BPS` — נתיב-הקבוע-הסטטי — ו-I9-exact דורש בדיוק feeAmt=37
 * (12,334×30/10⁴ — 29bps→35·0bps→0 סוטים; חושב-מתמטית: ב-12,334 גם-החיתוך-לאוצר
 * נבדל (11 מול 10) וגם-הרזרבות — אין-שקילות-נצפית; ב-1,000 היה-שורד (poolIn/out זהים)).
 */
import type { DexState, Op, OpKind } from "../src/lib/dex/kernel";

/* ── קבועי-הסוללה — אסור לייבא מהגרעין! מוטנט-קבוע חייב להיתפס מול-אמת-חיצונית ── */
export const BAT_FEE_BPS = 30;
export const BAT_TREASURY_CUT_PCT = 30;
export const BAT_DYN_FEE_MAX_BPS = 1_500;

export interface BatteryMods {
  applyOp(st: DexState, op: Op, now: number): { ok: boolean; err?: string; gas?: number };
  canon(v: unknown): string;
  stateRootOf(v: unknown): string;
  ledgerAudit(st: DexState, totals: unknown): { ok: boolean; errors?: string[] };
  genesisTotals(): unknown;
  InvariantViolation: abstract new (...args: never[]) => Error;
  /** הפרימיטיבה עצמה נבדקת ישירות (I13) — מוטנט שמנטרל את invariant() נתפס */
  invariantFn(cond: unknown, msg: string): void;
}

export interface BatteryOpts {
  seed: number;
  seqs: number;
  opsPerSeq: number;
  quiet?: boolean;
}

export interface Violation { code: string; detail: string; seq?: number; i?: number; opType?: string }
export interface ProbeResult { name: string; pass: boolean; detail: string }

export interface BatteryOutcome {
  verdict: "PASS" | "FAIL";
  violations: Violation[];
  probes: ProbeResult[];
  determinismOk: boolean;
  auditFailures: string[];
  canaryOk: boolean;
  canonPropsOk: boolean;
  canonProps: ProbeResult[];
  golden: { name: string; ok: boolean; err: string }[];
  summary: {
    ops: number; accepted: number; rejected: number; thrown: number;
    finalRoot: string; feeMeter: number;
    feeAcc: Record<string, number>;
  };
  famCount: Record<string, { ok: number; no: number; thr: number }>;
}

/* ── PRNG דטרמיניסטי (mulberry32) ──────────────────────────────────────────── */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FUZZERS = ["fuzz-a", "fuzz-b", "fuzz-c"];
const FUZZ_ALL = ["fuzz-a", "fuzz-b", "fuzz-c", "fuzz-d"]; // fuzz-d = ארנק-נעילות-ריק (קוטל-573)
const ATTACKERS = ["attacker", "", "__proto__", "constructor", "שלום", "a".repeat(300)];
const ADV_NUMS: (number | undefined)[] = [0, -1, -1_000_000, 1, 3, 17, 500, 9_999, 1_000_000, 500_000_000, 9_007_199_254_740_991, 1.5, -0.5, Number.MAX_SAFE_INTEGER];
/* גבולות-ve_lock (קוטל-בדיקת-הגבול): מוטנט `<`→`<=` נצפה רק ב-weeks===MIN בדיוק
 * (וה-`>`→`>=` ב-weeks===MAX) — ערכי-הגבול עצמם חייבים להיות בערכת-ההתקפה.
 * קבועי-הסוללה — אסור לייבא מהגרעין (מוטנט-קבוע חייב להיתפס). */
const BAT_VE_MIN_WEEKS = 1;
const BAT_VE_MAX_WEEKS = 208;
const REAL_ASSETS = ["SAOS", "USDS", "WSTEEM", "WTRX", "WUSDC"];
const NOW = 1_700_000_000_000;

function pick<T>(r: () => number, arr: T[]): T { return arr[Math.floor(r() * arr.length)]; }

function sum(obj: Record<string, unknown> | undefined): number {
  if (!obj) return 0;
  let s = 0;
  for (const v of Object.values(obj)) if (typeof v === "number") s += v;
  return s;
}

function numAt(bal: DexState["balances"], who: unknown, a: unknown): number {
  if (typeof who !== "string" || typeof a !== "string") return 0;
  const w = bal[who];
  if (!w || typeof w[a] !== "number") return 0;
  return w[a];
}

interface PoolLike { a: string; b: string; ra: number; rb: number; dynFeeBps?: number; feeAccruedTreasury?: number; swaps?: number; [k: string]: unknown }
function findPool(st: DexState, pair: string, assetIn: string): PoolLike | null {
  for (const p of Object.values(st.pools as Record<string, PoolLike>)) {
    if ((p.a === assetIn || p.b === assetIn) && (pair === `${p.a}/${p.b}` || pair === `${p.b}/${p.a}`)) return p;
  }
  return null;
}

/* ── מימון-עולם-הבדיקה (Σ נשמר — האודיטור לא נשבר) ──────────────────────────── */
export function fundClone(live: DexState): DexState {
  const st = structuredClone(live) as DexState;
  const opCredits = st.credits["operator"] ?? 0;
  const fuzzEach = Math.floor(opCredits * 0.5 / FUZZERS.length);
  const attacker = Math.min(1_500, Math.floor(opCredits * 0.1));
  let moved = 0;
  for (const f of FUZZERS) { st.credits[f] = fuzzEach; moved += fuzzEach; }
  st.credits["attacker"] = attacker; moved += attacker;
  st.credits["operator"] = opCredits - moved;

  const donor = Object.entries(st.balances)
    .filter(([w]) => !["treasury", "reserve-vault", "arena"].includes(w))
    .sort((x, y) => Object.values(y[1]).reduce((s, v) => s + v, 0) - Object.values(x[1]).reduce((s, v) => s + v, 0))[0]?.[0];
  if (donor) {
    const pool = st.balances[donor] ?? {};
    for (const [a, v] of Object.entries(pool)) {
      if (typeof v !== "number" || v <= 0 || a.startsWith("LP|")) continue;
      const take = Math.floor(v * 0.25);
      if (take <= 0) continue;
      st.balances[donor][a] = v - take;
      const fa = st.balances["fuzz-a"] ?? (st.balances["fuzz-a"] = {});
      fa[a] = (fa[a] ?? 0) + Math.floor(take * 0.6);
      const fb = st.balances["fuzz-b"] ?? (st.balances["fuzz-b"] = {});
      fb[a] = (fb[a] ?? 0) + (take - Math.floor(take * 0.6));
    }
  }
  // FIX-KILL-RELEASELOCK: אבק-אפס סינתטי בנעילות fuzz-c (האיפוס-עצמו למטה — אחרי
  // מימון-הדלק, שלא יידרס): משחזר את תנאי-F-1 (order→addLock→consume-fail→
  // releaseLockClean עם pre.hadKey && w[a]===0): מוטנט-|| בשחזור-הניקוי (F-1b)
  // מוחק את מפתח-האבק → כסף-מצב זז בדחייה (I1) ובשורש-הבזל (K2) — נצפה.
  const lc = (st.locked as Record<string, Record<string, number>>)["fuzz-c"] ?? ((st.locked as Record<string, Record<string, number>>)["fuzz-c"] = {});
  lc["SAOS"] = 0; lc["USDS"] = 0;
  // מימון-דלק (FIX-FUZZ-STARVE · נלמד-חי): operator יכול להיות 0-קרדיט בסנאפשוט
  // — סוללה-רעבה (ok=0) מציגה PASS ריק: כל-האינוואריאנטות-החיוביות (I2/I3/I7/I9/I12)
  // לא-מתאמנות. העברה (לא-הטבעה!) מבעל-הקרדיטים-הגדול — Σ נשמר, האודיטור (a) ירוק.
  const creditDonor = Object.entries(st.credits)
    .filter(([w]) => !FUZZERS.includes(w) && w !== "attacker" && typeof w === "string")
    .sort((x, y) => (y[1] ?? 0) - (x[1] ?? 0))[0];
  if (creditDonor && (creditDonor[1] ?? 0) > 3_000) {
    const donorName = creditDonor[0];
    const take = Math.floor((creditDonor[1] ?? 0) * 0.6);
    const fuzzEach = Math.floor(take * 0.85 / FUZZERS.length);
    const att = Math.min(1_500, take - fuzzEach * FUZZERS.length);
    let moved = 0;
    for (const f of FUZZERS) { st.credits[f] = fuzzEach; moved += fuzzEach; }
    st.credits["attacker"] = att; moved += att;
    st.credits[donorName] = (creditDonor[1] ?? 0) - moved;
    // FIX-KILL-RELEASELOCK (אחרי-מימון-הדלק — שהאיפוס שלו לא יידרס): fuzz-c חסר-דלק
    // (0-קרדיט) — חלקו עובר ל-attacker; ויתרת-SAOS אמיתית עוברת מ-fuzz-a (Σ נשמר):
    st.credits["fuzz-c"] = 0;
    st.credits["attacker"] = (st.credits["attacker"] ?? 0) + fuzzEach;
    const faB = st.balances["fuzz-a"] ?? (st.balances["fuzz-a"] = {});
    const fcB = st.balances["fuzz-c"] ?? (st.balances["fuzz-c"] = {});
    const saosMove = Math.min(500, faB["SAOS"] ?? 0);
    if (saosMove > 0) { faB["SAOS"] = (faB["SAOS"] ?? 0) - saosMove; fcB["SAOS"] = (fcB["SAOS"] ?? 0) + saosMove; }
    // KILL-CHARGEGAS-BOUNDARY (קוטל O-LT#chargeGas): fuzz-b עם קרדיט שווה-בדיוק
    // לגז-transfer (100µ): `credits < gas` מאפשר (100<100=כזב) — מוטנט `<=` דוחה →
    // ערכת-הבזל נבדלת. **Σ נשמר**: העודף (fuzzEach−100) עובר ל-attacker — אסור
    // להשמיד קרדיט (האודיטור תופס מיד — הוכח-חי!).
    st.credits["fuzz-b"] = 100;
    st.credits["attacker"] = (st.credits["attacker"] ?? 0) + Math.max(0, fuzzEach - 100);
    // KILL-EMPTY-LOCK-WALLET (קוטל O-AND#releaseLock-who): fuzz-d עם ארנק-נעילות-
    // ריק-מראש + אפס-קרדיט (אי-קיום = אפס — בלי-מפתח-מיותר) + יתרת-SAOS:
    // ה-order-הנדחה-אחרי-הנעילה מגיע לניקוי-הארנק — מוטנט-|| מוחק את המפתח-הריק →
    // שורש-הבזל נבדל (I1 גם).
    delete st.credits["fuzz-d"];
    const fdB = st.balances["fuzz-d"] ?? (st.balances["fuzz-d"] = {});
    const saosD = Math.min(300, faB["SAOS"] ?? 0);
    if (saosD > 0) { faB["SAOS"] = (faB["SAOS"] ?? 0) - saosD; fdB["SAOS"] = (fdB["SAOS"] ?? 0) + saosD; }
    (st.locked as Record<string, Record<string, number>>)["fuzz-d"] = {};
  }
  // נתיב-העמלה-הסטטית: מחיקת- dynFeeBps מבריכת-האנרגיה כדי שה-swap עליה יעבור
  // דרך `p.dynFeeBps ?? FEE_BPS` — ו-I9-exact יצפה 30bps בדיוק.
  const ep = (st.pools as Record<string, Record<string, unknown>>)["ENERGY/SAOS"];
  if (ep) delete ep.dynFeeBps;
  // מימון-הבריכה: 15,000 ENERGY עוברים מהרזרבות ל-fuzz-a (Σ נשמר — האודיטור נקי)
  // — מספיק ל-swap-הקנוני של 12,334 (שבו-העמלה-הסטטית נצפית-במדויק: feeAmt=37,
  // treasuryFee=11 — 29bps מוותר 35/10 = שורד-נתפס; ראה-הערת-השקילות במסמך-הפתיחה)
  if (ep && typeof ep.ra === "number" && ep.ra > 16_000) {
    ep.ra = ep.ra - 15_000;
    const fa = st.balances["fuzz-a"] ?? (st.balances["fuzz-a"] = {});
    fa["ENERGY"] = (fa["ENERGY"] ?? 0) + 15_000;
  }
  return st;
}

/* ── מחולל-ההתקפות ──────────────────────────────────────────────────────────── */
function mkOp(r: () => number, st: DexState, n: number): Op {
  const who = pick(r, [...FUZZ_ALL, ...FUZZERS, "attacker", "operator", "arena", "treasury", pick(r, ATTACKERS)]);
  const adv = r() < 0.45;
  // FIX-COVERAGE: op-לא-אדיברסרי צריך להגיע-באמת-למנוע (נכס-אמת/נמען-אמת) —
  // אחרת המחולל מייצר גוש-דחיות-מוקדמות שמרוקן את הכיסוי (נמדד-חי: transfer ok=0).
  const asset = adv ? pick(r, [...REAL_ASSETS, "ENERGY", "FAKE", "", "WFAKE", "LP|X"]) : pick(r, [...REAL_ASSETS, "ENERGY"]);
  const to = adv ? pick(r, [...FUZZERS, "attacker", "operator", "arena", "reserve-vault", pick(r, ATTACKERS)]) : pick(r, [...FUZZERS, "operator", "arena"]);
  const amount = adv ? pick(r, ADV_NUMS) : Math.floor(r() * 250_000) + 1;
  const nonce = `fz-${n}`;
  const fam = pick(r, ["transfer", "transfer", "transfer", "xfer_free", "xfer_free", "order", "order", "cancel", "pool_swap", "pool_add", "wrap_mint", "wrap_burn", "refuel", "mint_fuel", "oco_place", "trig_order", "dca_create", "ve_lock", "bond_buy", "cow_order", "heartbeat", "asset_list", "oracle_set", "harvest", "order_gc", "cancel_all", "vault_open", "batch"]);
  switch (fam) {
    case "transfer":
    case "xfer_free":
      return { type: fam, issuer: who, nonce, to, asset, amount: adv ? amount : Math.floor(r() * 50_000) + 1, memo: adv ? pick(r, ["", "x".repeat(300), "\u0000null", "../../etc/passwd"]) : "fz" } as Op;
    case "order": {
      const side = r() < 0.5 ? "buy" : "sell";
      const price = adv ? pick(r, [0, -1300, 1.5, Number.MAX_SAFE_INTEGER, 1e15]) : Math.floor(1300 * (0.85 + r() * 0.3));
      return { type: "order", issuer: who, nonce, base: adv ? pick(r, ["SAOS", "USDS", "WSTEEM", "FAKE"]) : "SAOS", quote: adv ? pick(r, ["USDS", "SAOS", ""]) : "USDS", side, price, amount: adv ? amount : Math.floor(r() * 5_000) + 50, postOnly: r() < 0.3, ioc: r() < 0.2 } as Op;
    }
    case "cancel":
      return { type: "cancel", issuer: who, nonce, orderId: adv ? pick(r, [-1, 0, 999999, 1.5]) : Math.floor(r() * 500) } as Op;
    case "cancel_all":
      return { type: "cancel_all", issuer: who, nonce, pair: r() < 0.5 ? "SAOS/USDS" : undefined } as Op;
    case "pool_swap": {
      const realPair = pick(r, ["SAOS/USDS", "ENERGY/SAOS"]);
      return { type: "pool_swap", issuer: who, nonce, pair: adv ? pick(r, ["SAOS/USDS", "WSTEEM/USDS", "ENERGY/SAOS", "X/Y", ""]) : realPair, assetIn: adv ? asset : (r() < 0.5 ? realPair.split("/")[0] : realPair.split("/")[1]), amount: adv ? amount : Math.floor(r() * 3_000) + 1, minOut: adv ? Number.MAX_SAFE_INTEGER : 0 } as Op;
    }
    case "pool_add":
      return { type: "pool_add", issuer: who, nonce, pair: pick(r, ["SAOS/USDS", "ENERGY/SAOS", "X/Y"]), asset, amount } as Op;
    case "wrap_mint":
    case "wrap_burn":
      return { type: fam, issuer: who, nonce, wrapAsset: pick(r, ["WSTEEM", "WTRX", "WUSDC", "WFAKE"]), amount, external: r() < 0.5, claim: r() < 0.3 ? "fake-claim-hash" : undefined } as Op;
    case "refuel":
      return { type: "refuel", issuer: who, nonce, to, amount } as Op;
    case "mint_fuel":
      return { type: "mint_fuel", issuer: who, nonce, to, amount } as Op;
    case "oco_place":
      return { type: "oco_place", issuer: who, nonce, base: "SAOS", quote: "USDS", side: r() < 0.5 ? "buy" : "sell", amount, triggerPx: adv ? -5 : Math.floor(1300 * (0.7 + r() * 0.6)), limitPx: adv ? 0 : Math.floor(1300 * (0.7 + r() * 0.6)), trigDir: r() < 0.5 ? "down" : "up" } as Op;
    case "trig_order":
      return { type: "trig_order", issuer: who, nonce, base: "SAOS", quote: "USDS", side: r() < 0.5 ? "buy" : "sell", amount, triggerPx: adv ? Number.MAX_SAFE_INTEGER : 1250, limitPx: 1300 } as Op;
    case "dca_create":
      return { type: "dca_create", issuer: who, nonce, asset: "USDS", to: "SAOS", everyK: adv ? -3 : 10, perSlice: adv ? 0 : 1_000, slicesMax: adv ? 1e9 : 5, minOutBps: 9_700 } as Op;
    case "ve_lock":
      return { type: "ve_lock", issuer: who, nonce, asset: "SAOS", amount, weeks: adv ? pick(r, [0, -4, 1.5, 999, BAT_VE_MIN_WEEKS, BAT_VE_MAX_WEEKS]) : 12 } as Op;
    case "bond_buy":
      return { type: "bond_buy", issuer: who, nonce, asset: "USDS", amount: adv ? pick(r, [10, -5, 1e12]) : Math.floor(r() * 2_000_000) + 50_000 } as Op;
    case "cow_order":
      return { type: "cow_order", issuer: who, nonce, base: "SAOS", quote: "USDS", side: r() < 0.5 ? "buy" : "sell", price: adv ? 0 : 1320, amount } as Op;
    case "heartbeat":
      return { type: "heartbeat", issuer: who, nonce } as Op;
    case "asset_list":
      return { type: "asset_list", issuer: who, nonce, name: pick(r, ["FAKE", "WFAKE", ""]), refPrice: adv ? -1 : 1_000 } as Op;
    case "oracle_set":
      return { type: "oracle_set", issuer: who, nonce, prices: { SAOS: adv ? -1 : 1_300, USDS: 1_000, [pick(r, ["__proto__", "evils", "SAOS"])]: 5 } } as unknown as Op;
    case "harvest":
      return { type: "harvest", issuer: who, nonce } as Op;
    case "order_gc":
      return { type: "order_gc", issuer: who, nonce } as Op;
    case "vault_open":
      return { type: "vault_open", issuer: who, nonce, drawMu: adv ? pick(r, [-1, 0, 1e12]) : Math.floor(r() * 400_000) } as Op;
    case "batch": {
      const inner: Op[] = [];
      const cnt = adv ? pick(r, [0, 1, 9, 30]) : 2;
      for (let k = 0; k < cnt; k++) inner.push({ type: "heartbeat", issuer: who, nonce: `${nonce}-i${k}` } as Op);
      const b = { type: "batch", issuer: who, nonce, ops: inner } as unknown as Op;
      if (adv && r() < 0.4) (b as unknown as { ops: unknown[] }).ops = [(b as unknown as { ops: unknown[] }).ops];
      if (adv && r() < 0.3) inner.push({ type: "heartbeat", issuer: "operator", nonce: `${nonce}-x` } as Op);
      return b;
    }
    default:
      return { type: "heartbeat", issuer: who, nonce } as Op;
  }
}

/* ── I4 · סריקת-שלילי/לא-שלם ────────────────────────────────────────────────── */
function scanNoNegative(st: DexState, ctx: { seq: number; i: number; opType: string; out: Violation[] }): void {
  const bad = (name: string, v: unknown): void => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      ctx.out.push({ code: "I4-no-negative/integer", detail: `${name} = ${String(v)} (${typeof v})`, seq: ctx.seq, i: ctx.i, opType: ctx.opType });
    }
  };
  for (const [w, wallet] of Object.entries(st.balances)) for (const [a, v] of Object.entries(wallet)) bad(`balances[${w}][${a}]`, v);
  for (const [, wallet] of Object.entries(st.locked ?? {})) for (const [a, v] of Object.entries(wallet)) bad(`locked[·][${a}]`, v);
  for (const [w, v] of Object.entries(st.credits)) bad(`credits[${w}]`, v);
  for (const [k, p] of Object.entries(st.pools)) {
    bad(`pool[${k}].ra`, p.ra); bad(`pool[${k}].rb`, p.rb);
    if (typeof p.lp === "number") bad(`pool[${k}].lp`, p.lp);
    for (const [f, v] of Object.entries(p)) if (f.startsWith("feeAccrued")) bad(`pool[${k}].${f}`, v);
  }
}

/* ── I8 · פרובות-הגנה ──────────────────────────────────────────────────────── */
export function defenseProbes(): { name: string; op: Op }[] {
  const mk = (o: Partial<Op> & { type: OpKind }): Op => ({ issuer: "fuzz-a", nonce: `dp-${Math.random().toString(36).slice(2)}`, ...o } as Op);
  return [
    { name: "P01 negative-amount", op: mk({ type: "transfer", to: "fuzz-b", asset: "USDS", amount: -5 }) },
    { name: "P02 zero-amount", op: mk({ type: "transfer", to: "fuzz-b", asset: "USDS", amount: 0 }) },
    { name: "P03 float-amount", op: mk({ type: "transfer", to: "fuzz-b", asset: "USDS", amount: 1.5 }) },
    { name: "P04 proto-issuer", op: mk({ type: "heartbeat", issuer: "__proto__" }) },
    { name: "P05 proto-recipient", op: mk({ type: "transfer", to: "__proto__", asset: "USDS", amount: 5 }) },
    { name: "P06 constructor-issuer", op: mk({ type: "heartbeat", issuer: "CONSTRUCTOR" }) },
    { name: "P07 over-balance-transfer", op: mk({ type: "transfer", to: "fuzz-b", asset: "USDS", amount: 500_000_000_000 }) },
    { name: "P08 negative-price-order", op: mk({ type: "order", base: "SAOS", quote: "USDS", side: "buy", price: -1300, amount: 100 }) },
    { name: "P09 wrap_mint-external-non-treasury", op: mk({ type: "wrap_mint", wrapAsset: "WSTEEM", amount: 1_000_000, external: true, claim: "op-claim-fake" }) },
    { name: "P10 mint_fuel-non-treasury", op: mk({ type: "mint_fuel", to: "fuzz-a", amount: 100_000 }) },
    { name: "P11 primer-non-treasury", op: mk({ type: "primer" }) },
    { name: "P12 oracle_set-non-treasury", op: mk({ type: "oracle_set", prices: { SAOS: 9_999 } }) },
    { name: "P13 asset_list-non-treasury", op: mk({ type: "asset_list", name: "EVIL", refPrice: 1 }) },
    { name: "P14 xfer_free-over-cap", op: mk({ type: "xfer_free", to: "fuzz-b", asset: "USDS", amount: 3_000_000 }) },
    { name: "P15 batch-nested", op: mk({ type: "batch", ops: [{ type: "batch", issuer: "fuzz-a", nonce: "nest", ops: [] } as Op] }) },
    { name: "P16 batch-over-8", op: mk({ type: "batch", ops: Array.from({ length: 9 }, (_, k) => ({ type: "heartbeat", issuer: "fuzz-a", nonce: `b${k}` } as Op)) }) },
    // P17 עבר לבדיקה-סמנטית-משופרת (P17' batch-issuer-pinning) ב-runBattery:
    // העיצוב-המתועד הוא **צמידה** (תת-ה-op רץ כחותם) ולא דחייה — הפרובה-הישנה
    // דרשה דחייה והציגה PASS-שקר בעידן-הרעב (insufficient-credits לפני-הדלת).
    { name: "P18 unknown-op", op: { type: "steal_funds", issuer: "fuzz-a", nonce: "u1" } as unknown as Op },
    { name: "P19 no-nonce", op: { type: "heartbeat", issuer: "fuzz-a", nonce: "" } as Op },
    { name: "P20 huge-ve-weeks", op: mk({ type: "ve_lock", asset: "SAOS", amount: 100, weeks: 999 }) },
    { name: "P21 pool_swap-absurd-minOut", op: mk({ type: "pool_swap", pair: "SAOS/USDS", assetIn: "SAOS", amount: 1_000, minOut: Number.MAX_SAFE_INTEGER }) },
    { name: "P22 negative-refPrice", op: mk({ type: "asset_price", name: "SAOS", refPrice: -1 }) },
  ];
}

/* ── ערכת-הבזל (golden trace) — טביעת-האצבע של הגרעין הבריא ────────────────── */
export function goldenTrace(st: DexState, M: BatteryMods): { name: string; ok: boolean; err: string }[] {
  const g = (o: Partial<Op> & { type: OpKind }, name: string): { name: string; ok: boolean; err: string } => {
    const op = { issuer: "fuzz-a", nonce: `gt-${name}`, ...o } as Op;
    let ok = false, err = "";
    try { const rr = M.applyOp(st, op, NOW); ok = rr.ok === true; err = rr.ok ? "" : String(rr.err); }
    catch (e) { ok = false; err = `threw:${e instanceof Error ? e.name : "?"}`; }
    return { name, ok, err };
  };
  return [
    g({ type: "transfer", to: "fuzz-b", asset: "USDS", amount: 1_001 }, "t-usds-1001"),
    g({ type: "transfer", to: "fuzz-b", asset: "SAOS", amount: 17 }, "t-saos-17"),
    g({ type: "pool_swap", pair: "SAOS/USDS", assetIn: "SAOS", amount: 101, minOut: 0 }, "swap-saos-101"),
    g({ type: "pool_swap", pair: "SAOS/USDS", assetIn: "USDS", amount: 5_003, minOut: 0 }, "swap-usds-5003"),
    g({ type: "pool_swap", pair: "ENERGY/SAOS", assetIn: "ENERGY", amount: 12_334, minOut: 0 }, "swap-energy-static-fee"),
    g({ type: "order", base: "SAOS", quote: "USDS", side: "buy", price: 1250, amount: 50 }, "order-buy-1250"),
    g({ type: "order", issuer: "fuzz-c", base: "SAOS", quote: "USDS", side: "sell", price: 1200, amount: 100 }, "order-fuzz-c-zero-credit-reject"),
    g({ type: "order", issuer: "fuzz-d", base: "SAOS", quote: "USDS", side: "sell", price: 1200, amount: 100 }, "order-fuzz-d-empty-lock-wallet"),
    g({ type: "transfer", issuer: "fuzz-b", to: "fuzz-a", asset: "USDS", amount: 1 }, "transfer-fuzz-b-exact-gas"),
    g({ type: "cancel_all", pair: "SAOS/USDS" }, "cancel-all"),
    g({ type: "xfer_free", to: "fuzz-b", asset: "USDS", amount: 1_000 }, "xfer-free-1000"),
    g({ type: "ve_lock", asset: "SAOS", amount: 100, weeks: 12 }, "ve-lock-12w"),
    g({ type: "heartbeat" }, "heartbeat"),
  ];
}

/* ── I11 · קנוניות-הקנון — על ה-canon המוזרק עצמו ──────────────────────────── */
export function canonProps(M: BatteryMods): ProbeResult[] {
  const out: ProbeResult[] = [];
  const t = (name: string, pass: boolean, detail: string): void => { out.push({ name, pass, detail }); };
  const msg = (e: unknown): string => String(e instanceof Error ? e.message : e).slice(0, 60);
  try { t("key-order-independence", M.stateRootOf({ a: 1, b: 2 }) === M.stateRootOf({ b: 2, a: 1 }), "shallow"); } catch (e) { t("key-order-independence", false, msg(e)); }
  try {
    const x1 = { x: { p: 1, q: [1, 2, { z: 3, y: 4 }] }, m: 5 };
    const x2 = { m: 5, x: { q: [1, 2, { y: 4, z: 3 }], p: 1 } };
    t("nested-key-order", M.stateRootOf(x1) === M.stateRootOf(x2), "deep");
  } catch (e) { t("nested-key-order", false, msg(e)); }
  try { t("undefined-omitted", M.canon({ a: 1, b: undefined }) === M.canon({ a: 1 }), "undefined-key"); } catch (e) { t("undefined-omitted", false, msg(e)); }
  const mustThrow: [string, unknown][] = [["float", 1.5], ["nan", NaN], ["inf", Infinity], ["bigint", 10n]];
  for (const [nm, bad] of mustThrow) {
    try { M.canon({ v: bad } as unknown as Record<string, unknown>); t(`reject-${nm}`, false, "canon accepted it!"); }
    catch { t(`reject-${nm}`, true, "threw"); }
  }
  try { M.canon({ v: () => 1 } as unknown as Record<string, unknown>); t("reject-function", false, "canon accepted fn"); }
  catch { t("reject-function", true, "threw"); }
  return out;
}

/* ── הרצה ──────────────────────────────────────────────────────────────────── */
export async function runBattery(rawState: DexState, M: BatteryMods, opts: BatteryOpts): Promise<BatteryOutcome> {
  const log = (...a: unknown[]): void => { if (!opts.quiet) console.log(...a); };
  const violations: Violation[] = [];
  const auditFailures: string[] = [];
  const famCount = new Map<string, { ok: number; no: number; thr: number }>();
  const rejReasons = new Map<string, number>();
  const totals = M.genesisTotals();

  // I13 · הפרימיטיבה עצמה: invariant(false) חייב לזרוק, invariant(true) חייב לעבור
  const invProbe: ProbeResult = { name: "I13 invariant-primitive", pass: false, detail: "" };
  try { M.invariantFn(true, "battery-ok"); invProbe.pass = true; } catch (e) { invProbe.detail = `invariant(true) threw: ${e instanceof Error ? e.name : "?"}`; }
  try { M.invariantFn(false, "battery-must-throw"); invProbe.pass = false; if (!invProbe.detail) invProbe.detail = "invariant(false) did NOT throw — assertion neutered!"; }
  catch (e) { if (invProbe.pass) invProbe.detail = e instanceof M.InvariantViolation ? "throws on false ✓" : `threw non-InvariantViolation: ${e instanceof Error ? e.name : "?"}`; }

  const assetF = (s: DexState, a: string): number => {
    let x = 0;
    for (const w of Object.values(s.balances)) x += (w[a] ?? 0);
    for (const p of Object.values(s.pools)) { if (p.a === a) x += p.ra; if (p.b === a) x += p.rb; }
    return x + (s.backing?.[a] ?? 0);
  };

  /* I1-דיוק-אמת (FINDING-1 · נלמד-חי מהסוללה-הממומנת): החוק-הישן "דחייה ⇒
   * canon שווה-בתים" היה **טענה-שגויה** שהסתתרה מאחורי ארנקים-רעבים — עם-דלק,
   * דחייה-אחרי-consume גובה-גז + שורפת-נונס + מזיזה-טלמטריה (סמנטיקת-Ethereum:
   * עסקה-שנכשלה-אחרי-ה-gas משלמת-gas — וזו התנהגות-נכונה). החוק-האמיתי:
   * **דחייה לא נוגעת בכסף** — יתרות/נעילות/בריכות/ספרים/סדרים/backing/feeMeter/
   * feeMinted שווים-בתים; רק gasUsed/credits/stats/nonces רשאים לזוז, וזהות-הקרדיט
   * (I2) חייבת לעמוד גם-שם (chargeGas מזיז credits→gasUsed 1:1 — בלי-דליפה). */
  const stripVolatile = (s: DexState): string => {
    const c = structuredClone(s) as Record<string, unknown>;
    delete c.gasUsed; delete c.credits; delete c.stats; delete c.nonces;
    return M.canon(c);
  };

  /* רצף-מעקב אחד — מזריק before-state לפי כל-op ומפעיל את כל-האינוואריאנטות */
  const runSeqTracked = (seed: number, nOps: number): { root: string; accepted: number; rejected: number; thrown: number } => {
    const st = fundClone(structuredClone(rawState));
    const r = mulberry32(seed);
    const C0 = sum(st.credits) + (st.gasUsed ?? 0) - (st.feeMinted ?? 0);
    let accepted = 0, rejected = 0, thrown = 0;
    const snapBalances = (): Record<string, Record<string, number>> => {
      const out: Record<string, Record<string, number>> = {};
      for (const [w, wallet] of Object.entries(st.balances)) {
        out[w] = {};
        for (const [a, v] of Object.entries(wallet)) if (typeof v === "number") out[w][a] = v;
      }
      return out;
    };
    let preBal: Record<string, Record<string, number>> = {};
    let preFeeMeter = 0;
    let prePool: PoolLike | null = null;

    for (let i = 0; i < nOps; i++) {
      const op = mkOp(r, st, seed % 1000 * 1000 + i);
      const beforeMoney = stripVolatile(st);
      const tracked = new Set<string>([...REAL_ASSETS, ...Object.keys(st.backing ?? {}), "WUSDC", "ENERGY"]);
      const F_BEFORE = new Map<string, number>();
      for (const a of tracked) F_BEFORE.set(a, assetF(st, a));
      preBal = snapBalances();
      preFeeMeter = st.feeMeter ?? 0;
      prePool = op.type === "pool_swap"
        ? (() => { const p = findPool(st, String(op.pair), String(op.assetIn)); return p ? JSON.parse(JSON.stringify(p)) as PoolLike : null; })()
        : null;

      let res: { ok: boolean; err?: string } | null = null;
      try { res = M.applyOp(st, op, NOW); }
      catch (e) {
        thrown++;
        const isInv = e instanceof M.InvariantViolation;
        const isCanon = e instanceof Error && e.name === "CanonicalError";
        if (!isInv && !isCanon) violations.push({ code: `CRASH-${e instanceof Error ? e.constructor.name : typeof e}`, detail: `${op.type}: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`, seq: seed % 1000, i, opType: op.type });
        if (stripVolatile(st) !== beforeMoney) violations.push({ code: "THREW-BUT-MUTATED", detail: `${op.type} threw AND touched money-state`, seq: seed % 1000, i, opType: op.type });
        continue;
      }
      const fam = op.type as string;
      const fc = famCount.get(fam) ?? { ok: 0, no: 0, thr: 0 };
      if (res.ok) { accepted++; fc.ok++; } else { rejected++; fc.no++; const rk = `${fam}:${String(res.err).slice(0, 24)}`; rejReasons.set(rk, (rejReasons.get(rk) ?? 0) + 1); }
      famCount.set(fam, fc);

      if (!res.ok) {
        // I1 · reject-atomicity (הגרסה-האמיתית: אפס-נגיעה **בכסף**)
        if (stripVolatile(st) !== beforeMoney) violations.push({ code: "I1-REJECT-MUTATED-STATE", detail: `${op.type} rejected (${res.err}) touched MONEY-state (יתרות/נעילות/בריכות/ספרים)`, seq: seed % 1000, i, opType: op.type });
        // I2-דחייה · זהות-הקרדיט חייבת לעמוד גם-בדחייה-שחובה-גז (אין-דליפה ב-chargeGas)
        const C1r = sum(st.credits) + (st.gasUsed ?? 0) - (st.feeMinted ?? 0);
        if (C1r !== C0) violations.push({ code: "I2-CREDIT-IDENTITY-BROKEN", detail: `${op.type} REJECTED (${res.err}): C ${C1r} ≠ C0 ${C0} (Δ=${C1r - C0}) — דליפת-גז בנתיב-הדחייה`, seq: seed % 1000, i, opType: op.type });
      } else {
        // I2 · זהות-הקרדיט
        const C1 = sum(st.credits) + (st.gasUsed ?? 0) - (st.feeMinted ?? 0);
        if (C1 !== C0) violations.push({ code: "I2-CREDIT-IDENTITY-BROKEN", detail: `${op.type}: C ${C1} ≠ C0 ${C0} (Δ=${C1 - C0})`, seq: seed % 1000, i, opType: op.type });
        // I3 · שימור-העברות (משפחות-טהורות)
        if (["transfer", "pay", "xfer_free", "heartbeat", "cancel", "cancel_all", "order_gc", "attest", "refuel"].includes(fam)) {
          for (const [a, f0] of F_BEFORE) {
            const f1 = assetF(st, a);
            if (f1 !== f0) violations.push({ code: "I3-TRANSFER-CONSERVE", detail: `${op.type}: asset ${a} F ${f1} ≠ before ${f0} (Δ=${f1 - f0})`, seq: seed % 1000, i, opType: op.type });
          }
        }
        // I12 · אפקט-העברה בפועל
        if (fam === "transfer" || fam === "xfer_free") {
          const amt = op.amount ?? 0;
          const self = op.issuer === op.to;
          const dSender = numAt(st.balances, op.issuer, op.asset) - numAt(preBal as DexState["balances"], op.issuer, op.asset);
          const dTo = numAt(st.balances, op.to, op.asset) - numAt(preBal as DexState["balances"], op.to, op.asset);
          if (self) {
            if (dSender !== 0) violations.push({ code: "I12-TRANSFER-EFFECT", detail: `${fam} self-transfer Δ=${dSender} ≠ 0`, seq: seed % 1000, i, opType: fam });
          } else if (dTo !== amt || dSender !== -amt) {
            violations.push({ code: "I12-TRANSFER-EFFECT", detail: `${fam}: Δto=${dTo} ≠ amount=${amt} או Δsender=${dSender} ≠ -${amt}`, seq: seed % 1000, i, opType: fam });
          }
        }
        // I9 · FEE-TRUTH — חישוב-עצמאי מלא של pool_swap
        if (fam === "pool_swap" && prePool) {
          const amt = op.amount ?? 0;
          if (amt > 0) {
            const pB = prePool;
            const feeBps = typeof pB.dynFeeBps === "number" ? pB.dynFeeBps : BAT_FEE_BPS;
            const feeAmt = Math.floor((amt * feeBps) / 10_000);
            const lpFee = feeAmt - Math.floor((feeAmt * BAT_TREASURY_CUT_PCT) / 100);
            const treasuryFee = feeAmt - lpFee;
            const inAfterFee = amt - feeAmt;
            const rIn = pB.a === op.assetIn ? pB.ra : pB.rb;
            const rOut = pB.a === op.assetIn ? pB.rb : pB.ra;
            const outExp = Math.floor((rOut * inAfterFee) / (rIn + inAfterFee));
            const pA = findPool(st, String(op.pair), String(op.assetIn));
            const assetOut = pB.a === op.assetIn ? pB.b : pB.a;
            const selfT = op.issuer === "treasury";
            const dSenderIn = numAt(st.balances, op.issuer, op.assetIn) - numAt(preBal as DexState["balances"], op.issuer, op.assetIn);
            const dSenderOut = numAt(st.balances, op.issuer, assetOut) - numAt(preBal as DexState["balances"], op.issuer, assetOut);
            const dTreasury = numAt(st.balances, "treasury", op.assetIn) - numAt(preBal as DexState["balances"], "treasury", op.assetIn);
            const feeAcc = pA ? ((pA.feeAccruedTreasury ?? 0) - (pB.feeAccruedTreasury ?? 0)) : NaN;
            const feeMeterD = (st.feeMeter ?? 0) - preFeeMeter;
            const bads: string[] = [];
            if (!selfT) {
              if (dSenderIn !== -amt) bads.push(`Δsender[in]=${dSenderIn} ≠ -${amt}`);
              if (dSenderOut !== outExp) bads.push(`Δsender[out]=${dSenderOut} ≠ out=${outExp}`);
              if (dTreasury !== treasuryFee) bads.push(`Δtreasury=${dTreasury} ≠ fee=${treasuryFee}`);
            } else if (dSenderIn !== outExp - amt) bads.push(`Δtreasury-net=${dSenderIn} ≠ ${outExp - amt}`);
            if (pA && pB) {
              const dInPool = pB.a === op.assetIn ? (pA.ra - pB.ra) : (pA.rb - pB.rb);
              const dOutPool = pB.a === op.assetIn ? (pA.rb - pB.rb) : (pA.ra - pB.ra);
              if (dInPool !== inAfterFee + lpFee) bads.push(`Δpool[in]=${dInPool} ≠ ${inAfterFee + lpFee}`);
              if (dOutPool !== -outExp) bads.push(`Δpool[out]=${dOutPool} ≠ -${outExp}`);
              if (feeAcc !== treasuryFee) bads.push(`ΔfeeAccrued=${feeAcc} ≠ ${treasuryFee}`);
            }
            if (feeMeterD !== treasuryFee) bads.push(`ΔfeeMeter=${feeMeterD} ≠ ${treasuryFee}`);
            if (bads.length) violations.push({ code: "I9-FEE-TRUTH", detail: `${op.type} ${op.pair} in=${amt}: ${bads.join(" · ")}`, seq: seed % 1000, i, opType: fam });
          }
        }
        // I7 · replay-closed
        const rr = M.applyOp(st, op, NOW);
        if (rr.ok) violations.push({ code: "I7-REPLAY-ACCEPTED", detail: `${op.type} replay accepted (nonce=${op.nonce})`, seq: seed % 1000, i, opType: op.type });
      }
      // I4 · כל-op
      scanNoNegative(st, { seq: seed % 1000, i, opType: String(op.type), out: violations });
      // I5 · האודיטור המוזרק — כל-15 ops
      if (i % 15 === 14) {
        const audit = M.ledgerAudit(st, totals);
        if (audit.ok === false && Array.isArray(audit.errors) && audit.errors.length) auditFailures.push(`seed${seed}/op${i}: ${audit.errors.slice(0, 2).join(" | ")}`);
      }
    }
    return { root: M.stateRootOf(st), accepted, rejected, thrown };
  };

  // ריצה ראשית + תאומת-דטרמיניזם (I6) על-seed הראשון
  const dets: { seed: number; a: string; b: string }[] = [];
  let last = { root: "", accepted: 0, rejected: 0, thrown: 0 };
  for (let s = 0; s < Math.max(1, opts.seqs); s++) {
    const seed = (opts.seed + s * 7919) >>> 0;
    last = runSeqTracked(seed, opts.opsPerSeq);
    if (s === 0) {
      const b = runSeqTracked(seed, opts.opsPerSeq); // ריצה-תאומה: אותו-seed ⇒ אותו-root
      dets.push({ seed, a: last.root, b: b.root });
    }
  }
  const determinismOk = dets.every((d) => d.a === d.b);

  // I8 · פרובות-הגנה (P99 בגרסת-האמת: אפס-נגיעה **בכסף** — גז/נונס/טלמטריה מותרים)
  const probeState = fundClone(structuredClone(rawState));
  const probes: ProbeResult[] = [];
  {
    const beforeMoney = stripVolatile(probeState);
    for (const p of defenseProbes()) {
      let rejected = false, err = "";
      try { const rr = M.applyOp(probeState, p.op, NOW); rejected = !rr.ok; err = rr.ok ? "ACCEPTED(!)" : String(rr.err); }
      catch (e) { rejected = true; err = `threw:${e instanceof Error ? e.name : "?"}`; }
      probes.push({ name: p.name, pass: rejected, detail: err.slice(0, 80) });
    }
    probes.push({ name: "P99 probes-left-money-state-unchanged", pass: stripVolatile(probeState) === beforeMoney, detail: "" });
  }

  // P17' · batch-issuer-pinning — בדיקת-הסמנטיקה-האמיתית (חזקה-מדחייה): op-זר
  // בתוך-batch חייב לרוץ **כחותם** — הכסף זז מהחותם, חשבון-המנפיק-הזר נוגע-לא-נגע.
  // (ההפך = חור-זיוף-מנפיק קריטי.) דחייה-מלאה גם-היא תקפה (בטוח-לא-פחות).
  {
    const s17 = fundClone(structuredClone(rawState));
    const before = {
      op: numAt(s17.balances, "operator", "USDS"),
      a: numAt(s17.balances, "fuzz-a", "USDS"),
      b: numAt(s17.balances, "fuzz-b", "USDS"),
    };
    const bop = { type: "batch", issuer: "fuzz-a", nonce: "sp17", ops: [
      { type: "transfer", issuer: "operator", nonce: "sp17-i0", to: "fuzz-b", asset: "USDS", amount: 5 },
    ] } as unknown as Op;
    let accepted = false;
    try { const rr = M.applyOp(s17, bop, NOW); accepted = rr.ok === true; } catch { accepted = false; }
    const after = {
      op: numAt(s17.balances, "operator", "USDS"),
      a: numAt(s17.balances, "fuzz-a", "USDS"),
      b: numAt(s17.balances, "fuzz-b", "USDS"),
    };
    let pass = false, detail = "";
    if (accepted) {
      pass = after.op === before.op && after.b === before.b + 5 && after.a === before.a - 5;
      detail = pass ? "accepted-as-signer (pinning) — operator untouched ✓" : `PINNING BROKEN — operator Δ=${after.op - before.op} fuzz-a Δ=${after.a - before.a} fuzz-b Δ=${after.b - before.b}`;
    } else { pass = true; detail = "rejected-by-design (גם-בטוח)"; }
    probes.push({ name: "P17 batch-issuer-pinning (op-זר רץ כחותם)", pass, detail });
  }

  // ערכת-הבזל (golden trace) על שיבוט-טרי
  const goldenSt = fundClone(structuredClone(rawState));
  const golden = goldenTrace(goldenSt, M);

  // I10 · קנריית-האודיטור: משחיתים +7µ ודורשים ok:false
  let canaryOk = false;
  try {
    const canary = structuredClone(goldenSt);
    canary.credits["fuzz-a"] = (canary.credits["fuzz-a"] ?? 0) + 7;
    const audit = M.ledgerAudit(canary, totals);
    canaryOk = audit.ok === false && Array.isArray(audit.errors) && audit.errors.length > 0;
    probes.push({ name: "I10 auditor-canary(+7µ→must-fail)", pass: canaryOk, detail: canaryOk ? "audit caught the corruption" : `audit said ok=${String(audit.ok)} — auditor blind!` });
  } catch (e) { probes.push({ name: "I10 auditor-canary(+7µ→must-fail)", pass: false, detail: `threw:${e instanceof Error ? e.name : "?"}` }); }

  // I11 · קנוניות-הקנון
  const canonPropsRes = canonProps(M);
  probes.push({ name: "I11 canon-canonicality", pass: canonPropsRes.every((p) => p.pass), detail: `${canonPropsRes.filter((p) => p.pass).length}/${canonPropsRes.length}` });
  const canonPropsOk = canonPropsRes.every((p) => p.pass) && invProbe.pass;
  probes.push(invProbe);

  const famRec: Record<string, { ok: number; no: number; thr: number }> = {};
  for (const [k, v] of famCount) famRec[k] = v;

  const finalSummary = {
    ops: last.accepted + last.rejected,
    accepted: last.accepted, rejected: last.rejected, thrown: last.thrown,
    finalRoot: last.root,
    goldenRoot: M.stateRootOf(goldenSt),
    feeMeter: goldenSt.feeMeter ?? 0,
    feeAcc: {
      "SAOS/USDS": ((goldenSt.pools as Record<string, PoolLike>)["SAOS/USDS"]?.feeAccruedTreasury ?? 0),
      "ENERGY/SAOS": ((goldenSt.pools as Record<string, PoolLike>)["ENERGY/SAOS"]?.feeAccruedTreasury ?? 0),
    },
  };

  const probesPass = probes.filter((p) => p.pass).length;
  // שומר-רעב: סוללה שאפס-מקובלות בה היא סוללה שלא בדקה-כלום — פסק-דין FAIL
  // (ה-BUG-שהוכח-חי: operator=0-קרדיט ⇒ ok=0 ⇒ PASS-ריק-מתוך-הסוויט-הישנה)
  if (finalSummary.accepted < Math.max(3, Math.floor(finalSummary.ops * 0.08))) {
    violations.push({ code: "BATTERY-STARVED", detail: `accepted=${finalSummary.accepted}/${finalSummary.ops} — אין-דלק/מצב-מקולקל: PASS-של-אפס-מקובלות הוא-שקר`, opType: "battery" });
  }
  // שומר-ערכת-הבזל: לפחות-חצי מהערכה-הקנונית חייבת-לעבור (דלת-מתה = גרעין-מת)
  const goldenOk = golden.filter((g) => g.ok).length;
  if (goldenOk < 5) {
    violations.push({ code: "GOLDEN-STARVED", detail: `golden ${goldenOk}/10 ok — הדרך-המאושרת מתה, הבזל לא רלוונטית`, opType: "golden" });
  }
  const verdict: "PASS" | "FAIL" =
    violations.length === 0 && determinismOk && probesPass === probes.length && auditFailures.length === 0 && canonPropsOk
      ? "PASS" : "FAIL";

  log(`\n── FAMILY ACCEPT/REJECT (הדלת מדברת) ──`);
  if (!opts.quiet) for (const [f, c] of Object.entries(famRec).sort()) log(`  ${f.padEnd(12)} ok=${c.ok} no=${c.no} thr=${c.thr}`);
  log(`── סיבות-דחייה מובילות ──`);
  for (const [rk, n] of [...rejReasons].sort((a, b) => b[1] - a[1]).slice(0, 12)) log(`  ${String(n).padStart(4)}× ${rk}`);
  log(`\n── DEFENSE PROBES: ${probesPass}/${probes.length} ──`);
  if (!opts.quiet) for (const p of probes) log(`  ${p.pass ? "✓" : "✗"} ${p.name} → ${p.detail}`);
  log(`── GOLDEN TRACE: ${golden.filter((g) => g.ok).length}/${golden.length} ok ──`);
  if (!opts.quiet) for (const g of golden) log(`  ${g.ok ? "✓" : "·"} ${g.name} ${g.err ? `(${g.err})` : ""}`);
  log(`── VERDICT: ${verdict} ──  ops=${finalSummary.ops} ok=${finalSummary.accepted} no=${finalSummary.rejected} thr=${finalSummary.thrown} violations=${violations.length} auditFails=${auditFailures.length}`);
  if (violations.length) for (const v of violations.slice(0, 12)) log(`  ✗ ${v.code} [${v.opType}] ${v.detail.slice(0, 180)}`);
  if (auditFailures.length) for (const e of auditFailures.slice(0, 5)) log(`  ✗ AUDIT ${e.slice(0, 200)}`);

  return {
    verdict, violations, probes, determinismOk, auditFailures,
    canaryOk, canonPropsOk, canonProps: canonPropsRes, golden,
    summary: finalSummary, famCount: famRec,
  };
}
