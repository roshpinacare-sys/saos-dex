/**
 * sweep-cycle.ts — מכונת-השטיפה של SAOS-DEX (SWEEP-1)
 * =============================================================================
 * שאלת-הבעלים (2026-10-13): "עמלות 0 · נפח כמעט 0 · מצטבר כלום — איך הופכים את
 * הדקס לכלי ריבוני עובד? יש לנו כסף דל — איך מעבירים אותו בדקס מהר כדי לייצר
 * נזילות? אני רוצה לראות הרבה ווליום והרבה יותר פעילות אוטונומית".
 *
 * התשובה ההנדסית: מהירות-כסף (velocity). הדקס פתוח-רק-לנו — הנזילות נבנית
 * במחזורי-שטיפה מדודים: השחקן "sweeper" מבצע ראונד-טריפים על **כל** השווקים
 * (בריכות-AMM + ספר-הפקודות), מציב רשת-טריגרים עומדת סביב המחיר-הקנוני,
 * וכל-מילוי מייצר: עמלה-אמת לבריכה (30% אוצר) · אירוע-מסחר בנרות · עומק-ספר.
 *
 * גבולות-ברזל (כנות-כלכלית — אין-הטבעה, אין-שיבוש):
 *  · אפס-הטבעה: כל-ההון מגיע מיתרות-קיימות (אוצר→sweeper, תקרת-חיים-בפנקס).
 *  · תקרת-פעימה: SWEEP_MAX_BEAT_NOTIONAL — גבול-נזק מוצהר.
 *  · מגן-החלקה: כל-סוואפ-בריכה עם minOut (≤ SWEEP_SLIP_BPS); כל-פקודת-ספר IOC.
 *  · רגל-פר-בריכה ≤ SWEEP_POOL_SHARE_PCT מהצד-הקטן — אסור לזעזע בריכה-קטנה.
 *  · fail-closed: רגל-נדחית = נרשמת-בכנות-ומדלגים; אף-כשל-לא עוצר את-הפעימה.
 *
 * ריצה: לפני cloud-beat באותו-Job (Domain dex-beat) — הטיקים של השטיפה נכנסים
 * לאותם-בלוקים, וה-commit/פרסום של-הלב ממשיך-מהמצב-המשוטף. הפנקס מתחייב-בעצמו.
 * =============================================================================
 */
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

/* ── סביבה לפני-כל-ייבוא-של-המנוע (אותו-חוזה כמו cloud-beat.ts) ── */
process.env.DATABASE_URL = `file:${path.join(process.cwd(), "db", "dex.db")}`;
process.env.SAOS_DEX_STATE_DIR = path.join(process.cwd(), "db");

const DB_DIR = path.join(process.cwd(), "db");
const LEDGER_FILE = path.join(DB_DIR, "sweep-ledger.json");
const FLOW_FILE = path.join(DB_DIR, "flow24.json");

/* ── דיאל-השטיפה (מדוד, מוצהר, ניתן-לכיוון ב-env) ── */
const SWEEP_TICKS = Math.max(30, Math.min(1_000, Number(process.env.SWEEP_TICKS ?? 180)));
const SWEEP_LEGS = Math.max(1, Math.min(8, Number(process.env.SWEEP_LEGS ?? 3)));
const SWEEP_UNIT_MU = Math.max(2_000, Math.min(200_000, Number(process.env.SWEEP_UNIT_MU ?? 30_000))); // רגל-בסיס $30
const SWEEP_MAX_BEAT_NOTIONAL = Math.max(20_000, Math.min(2_000_000, Number(process.env.SWEEP_MAX_BEAT_NOTIONAL ?? 500_000))); // $500 דו-צדדי
const SWEEP_POOL_SHARE_PCT = 1.5; // רגל ≤ 1.5% מהצד-הקטן — אסור לזעזע בריכה
const SWEEP_SLIP_BPS = 200;       // מגן-החלקה לסוואפ-בריכה
const FUND_PER_BEAT_MU = 300_000; // אוצר→sweeper עד-$300/פעימה (SAOS)
const FUND_LIFETIME_CAP_MU = 1_500_000; // תקרת-חיים-$1,500 — כל-המימון מהאוצר, אפס-הטבעה
const TRIG_REFRESH = Number(process.env.SWEEP_TRIGS ?? 1); // רשת-טריגרים עומדת (0=כבוי)

interface SweepLedger {
  version: 1;
  updatedAt: string;
  beats: number;
  lifetime: { fundedFromTreasuryMu: number; roundTrips: number; fills: number; volQuoteMu: number; feesMu: number };
  last: {
    at: string; heightFrom: number; heightTo: number; ticks: number;
    legs: number; rejected: number; fills: number; volQuoteMu: number; feesMu: number;
    fundedMu: number; perMarket: Record<string, { legs: number; volQuoteMu: number; fills: number; note?: string }>;
  } | null;
}

function loadLedger(): SweepLedger {
  try {
    const l = JSON.parse(fs.readFileSync(LEDGER_FILE, "utf-8")) as SweepLedger;
    if (l && l.version === 1) return l;
  } catch { /* פעימה-ראשונה */ }
  return {
    version: 1, updatedAt: new Date().toISOString(), beats: 0,
    lifetime: { fundedFromTreasuryMu: 0, roundTrips: 0, fills: 0, volQuoteMu: 0, feesMu: 0 },
    last: null,
  };
}

function git(args: string, allowFail = true): string {
  try {
    return execSync(`git ${args}`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    if (allowFail) return "";
    throw e;
  }
}

/** דחיפה-סבלנית: rebase-אוטומטי מול-מתחרים (סוכנים-מקבילים על-אותו-ריפו). */
function pushWithRetry(dir: string, branch: string, tries = 3): boolean {
  for (let i = 0; i < tries; i++) {
    try {
      execSync(`git push origin ${branch}`, { encoding: "utf8", cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
      return true;
    } catch {
      try { execSync(`git pull --rebase --autostash origin ${branch}`, { encoding: "utf8", cwd: dir, stdio: ["ignore", "pipe", "pipe"] }); } catch { /* ננסה-שוב */ }
    }
  }
  return false;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const chain = await import("../src/lib/dex/chain");
  const {
    ensureChain, stepOnce, stopLoops, forceFlush, submitOp, nextNonce,
    getState, getMarkets, getPools, getTape,
  } = chain as unknown as {
    ensureChain: () => { pendingLoad: boolean; halted: boolean; haltReason: string | null; st: Record<string, any> };
    stepOnce: () => Promise<void>;
    stopLoops: () => void;
    forceFlush: () => void;
    submitOp: (op: Record<string, unknown>) => { queued: boolean; reason?: string };
    nextNonce: (prefix: string) => string;
    getState: () => Record<string, any>;
    getMarkets: () => Array<Record<string, any>>;
    getPools: () => Array<Record<string, any>>;
    getTape: (n?: number) => Array<Record<string, any>>;
  };

  const rt = ensureChain();
  const waitLoad = async () => {
    const t = Date.now();
    while (rt.pendingLoad && Date.now() - t < 90_000) await new Promise((r) => setTimeout(r, 300));
  };
  await waitLoad();
  if (rt.halted) {
    console.error(`[sweep] chain HALTED — refusing. reason: ${rt.haltReason ?? "?"}`);
    process.exit(1);
  }
  stopLoops();
  const heightFrom = rt.st.height;
  const st0 = getState();
  const feeMeter0 = st0.feeMeter ?? 0;
  const fills0 = st0.fills ?? 0;
  const swaps0 = st0.swaps ?? 0;
  console.log(`[sweep] boot · h${heightFrom} · legs=${SWEEP_LEGS}/שוק · unit=${SWEEP_UNIT_MU}µ · budget=${SWEEP_MAX_BEAT_NOTIONAL}µ · ticks=${SWEEP_TICKS}`);

  const bal = (who: string, a: string): number => rt.st.balances?.[who]?.[a] ?? 0;
  const ledger = loadLedger();
  const perMarket: Record<string, { legs: number; volQuoteMu: number; fills: number; note?: string }> = {};
  const skipped: string[] = [];
  let legsSent = 0;
  let rejected = 0;
  let beatNotional = 0;
  let fundedMu = 0;

  /** שליחה-כנה: תוצאת-הדחייה נרשמת, לא נבלעת. */
  const send = (op: Record<string, unknown>, market: string, what: string): boolean => {
    const r = submitOp(op);
    if (r.queued) { legsSent++; perMarket[market] ??= { legs: 0, volQuoteMu: 0, fills: 0 }; perMarket[market].legs++; return true; }
    rejected++;
    perMarket[market] ??= { legs: 0, volQuoteMu: 0, fills: 0 };
    perMarket[market].note = `${what}: ${r.reason ?? "rejected"}`;
    return false;
  };

  /* ── שלב-א: מימון-השחקן (אפס-הטבעה — העברה-טהורה מהאוצר, תקרת-חיים-בפנקס) ── */
  const treasurySaos = bal("treasury", "SAOS");
  const sweeperSaos = bal("sweeper", "SAOS");
  const sweeperUsds = bal("sweeper", "USDS");
  const needFund = sweeperSaos < SWEEP_UNIT_MU * 2 && sweeperUsds < SWEEP_UNIT_MU;
  if (needFund && treasurySaos > FUND_PER_BEAT_MU * 2) {
    const room = FUND_LIFETIME_CAP_MU - ledger.lifetime.fundedFromTreasuryMu;
    if (room >= FUND_PER_BEAT_MU) {
      const amt = Math.min(FUND_PER_BEAT_MU, room);
      const q = submitOp({ type: "transfer", issuer: "treasury", nonce: nextNonce("swp-fund"), to: "sweeper", asset: "SAOS", amount: amt });
      if (q.queued) { fundedMu = amt; console.log(`[sweep] funded sweeper ← ${amt}µ SAOS (treasury) · lifetime ${ledger.lifetime.fundedFromTreasuryMu + amt}/${FUND_LIFETIME_CAP_MU}µ`); }
      else skipped.push(`fund:${q.reason}`);
    } else {
      skipped.push(`fund:lifetime-cap-reached(${ledger.lifetime.fundedFromTreasuryMu}µ)`);
    }
  }

  /* דלק-גז: כל-op משלם-קרדיטים (pool_swap=100) — שחקן-ריק-קרדיטים הוא-שחקן-מת
   * (נמדד-חי: insufficient-credits על-כל-רגל). refuel = העברה-טהורה-מהאוצר,
   * תקרת-REFUEL_CAP-פר-פקודה, אפס-הטבעה (Σcredits-נשמר). */
  const sweeperCredits = rt.st.credits?.["sweeper"] ?? 0;
  if (sweeperCredits < 20_000) {
    const treasuryCredits = rt.st.credits?.["treasury"] ?? 0;
    const fuel = Math.min(60_000, Math.max(0, treasuryCredits - 500_000)); // האוצר-שומר-לעצמו-רצפה
    if (fuel >= 10_000) {
      const q = submitOp({ type: "refuel", issuer: "treasury", nonce: nextNonce("swp-fuel"), to: "sweeper", amount: fuel });
      if (q.queued) console.log(`[sweep] refuel sweeper ← ${fuel}µ gas-credits (treasury)`);
      else skipped.push(`refuel:${q.reason}`);
    } else {
      skipped.push(`refuel:treasury-low(${treasuryCredits}µ)`);
    }
  }

  /* ── שלב-ב: מחזורי-שטיפה על כל-השווקים ──
   * סדר-אמת: כל-רגל נכנסת-לבלוק (טיקים-קצרים) לפני-קריאת-יתרה-הבאה — אחרת
   * המאזן-הנקרא הוא-פנטום (נמדד-חי: legs=0 בפעימה-ראשונה-לפני-התיקון).
   * בריכות: pool_swap הלוך-ושוב עם minOut מול-רזרבות-טריות.
   * ספר: IOC-לימיט חוצה-המוצע (קנייה ב-bestAsk, מכירה ב-bestBid) — מה שלא נחתך מיד מתבטל.
   * FIX(קציר-מצטבר): טבעת-הנרות היא 600 אירועים — הארנה (×10) + כבשנים-מקבילים
   * מציפים-אותה-בטיקים-בודדים ואירועי-השחקן מסתובבים-החוצה (נמדד-חי: נפח-עצמי 0
   * בפעימה-ראשונה-על-עמלות-10kµ). הקציר-מתבצע-אחרי-כל-נחיתה — מדידה, לא הערכה. */
  let sweepVol = 0, sweepFills = 0;
  const seenEv = new Set<string>();
  const harvestSweeperEvents = (): void => {
    try {
      for (const e of getTape(600)) {
        if (!e || e.taker !== "sweeper") continue;
        const k = `${(e as any).at}|${(e as any).amountMu}|${(e as any).kind}|${(e as any).base}|${(e as any).quote}`;
        if (seenEv.has(k)) continue;
        seenEv.add(k);
        sweepFills++;
        sweepVol += typeof (e as any).quoteMu === "number" ? (e as any).quoteMu as number : 0;
      }
    } catch { /* הקציר-אינו-מפיל-את-הפעימה */ }
  };
  const landOps = async (ticks: number): Promise<void> => {
    for (let i = 0; i < ticks; i++) {
      await stepOnce();
      if (rt.halted) { console.error(`[sweep] HALTED mid-run: ${rt.haltReason ?? "?"}`); break; }
    }
    harvestSweeperEvents();
  };

  /* המימון-והדלק-נכנסים-לבלוקים: לפני-כל-קריאת-מאזן/קרדיטים */
  if (fundedMu > 0) await landOps(10);

  const markets = getMarkets();
  const poolByKey = new Map(getPools().map((p) => [String(p.key), p]));

  /* ב': המרת-אתחול SAOS→USDS (רק-אם-ה-USDS של-השחקן מתחת-לרצפה) */
  const BOOTSTRAP_TICKS = 8;
  let bootstrapLegs = 0;
  const usdsFloor = SWEEP_UNIT_MU * 2;
  while (bal("sweeper", "USDS") < usdsFloor && bal("sweeper", "SAOS") >= 10_000 && bootstrapLegs < 4) {
    const poolsNow = getPools();
    const pSU = poolsNow.find((p) => String(p.key) === "SAOS/USDS");
    if (!pSU) { skipped.push("bootstrap:no-SAOS/USDS-pool"); break; }
    const smallSide = Math.min(Number(pSU.ra) || 0, Number(pSU.rb) || 0);
    const amt = Math.max(2_000, Math.min(Math.floor((smallSide * SWEEP_POOL_SHARE_PCT) / 100), Math.floor(bal("sweeper", "SAOS") / 2)));
    const out0 = Math.floor(((Number(pSU.rb) || 0) * amt) / ((Number(pSU.ra) || 0) + amt));
    const minOut = Math.floor((out0 * (10_000 - SWEEP_SLIP_BPS)) / 10_000);
    if (send({ type: "pool_swap", issuer: "sweeper", nonce: nextNonce("swp-bs"), pair: "SAOS/USDS", assetIn: "SAOS", amount: amt, minOut }, "SAOS/USDS", "bootstrap")) {
      beatNotional += Math.floor((amt * 1778) / 1000); // קירוב-אתחול בציטוט (המוצע-בזמן-ריצה-נמדד-בפנקס)
      bootstrapLegs++;
      await landOps(BOOTSTRAP_TICKS);
      if (rt.halted) break;
    } else break;
  }

  for (const mk of markets) {
    const key = String(mk.key);
    if (rt.halted) break;
    if (beatNotional >= SWEEP_MAX_BEAT_NOTIONAL) { skipped.push(`${key}:beat-budget`); continue; }
    const p = poolByKey.get(key);
    const mid = Math.max(mk.poolMid || 0, mk.fair || 0);
    if (!(mid > 0)) { skipped.push(`${key}:no-mid`); continue; }

    if (p) {
      /* בריכה-חיה: ראונד-טריפ מדוד לפי אחוז-הצד-הקטן, רזרבות-טריות-פר-רגל */
      for (let i = 0; i < SWEEP_LEGS && beatNotional < SWEEP_MAX_BEAT_NOTIONAL && !rt.halted; i++) {
        const poolsNow = getPools();
        const pNow = poolsNow.find((q) => String(q.key) === key);
        if (!pNow) { skipped.push(`${key}:pool-vanished`); break; }
        const ra = Number(pNow.ra) || 0, rb = Number(pNow.rb) || 0;
        const capByShare = Math.floor((Math.min(ra, rb) * SWEEP_POOL_SHARE_PCT) / 100);
        const legA = Math.min(SWEEP_UNIT_MU, capByShare);
        if (legA < 500) { skipped.push(`${key}:pool-too-small(${Math.min(ra, rb)}µ)`); break; }
        // כיוון: הנכס שיש-לנו מספיק ממנו (מעדיף SAOS→USDS אם-שניהם-אפשריים)
        const holdA = bal("sweeper", String(pNow.a));
        const holdB = bal("sweeper", String(pNow.b));
        const inA = holdA >= legA ? true : holdB >= Math.max(500, Math.floor((legA * mid) / 1000)) ? false : null;
        if (inA === null) { skipped.push(`${key}:no-inventory`); break; }
        const assetIn = inA ? String(pNow.a) : String(pNow.b);
        const amountIn = inA ? legA : Math.max(500, Math.floor((legA * mid) / 1000));
        const rIn = inA ? ra : rb, rOut = inA ? rb : ra;
        const out0 = Math.floor((rOut * amountIn) / (rIn + amountIn));
        const minOut = Math.floor((out0 * (10_000 - SWEEP_SLIP_BPS)) / 10_000);
        if (send({ type: "pool_swap", issuer: "sweeper", nonce: nextNonce("swp-l"), pair: key, assetIn, amount: amountIn, minOut }, key, "leg1")) {
          // תקציב-בציטוט-µ: רגל-בנכס-לא-ציטוט מתומחרת-לפי-המוצע (מדידה-דימנסיונלית-נכונה)
          beatNotional += assetIn === String(mk.quote) ? amountIn : Math.floor((amountIn * mid) / 1000);
          await landOps(6);
          if (rt.halted) break;
          // חזור: B→A על כמעט-כל-מה-שהתקבל (משאיר-אבק-לספר)
          const got = bal("sweeper", inA ? String(pNow.b) : String(pNow.a));
          if (got > 400) {
            const backIn = inA ? String(pNow.b) : String(pNow.a);
            const poolsBack = getPools();
            const pBack = poolsBack.find((q) => String(q.key) === key) ?? pNow;
            const ra2 = Number(pBack.ra) || 0, rb2 = Number(pBack.rb) || 0;
            const backIsA = backIn === String(pBack.a);
            const rIn2 = backIsA ? ra2 : rb2, rOut2 = backIsA ? rb2 : ra2;
            const out2 = Math.floor((rOut2 * got) / (rIn2 + got));
            const minOut2 = Math.floor((out2 * (10_000 - SWEEP_SLIP_BPS)) / 10_000);
            if (send({ type: "pool_swap", issuer: "sweeper", nonce: nextNonce("swp-l"), pair: key, assetIn: backIn, amount: got, minOut: minOut2 }, key, "leg2")) {
              beatNotional += backIn === String(mk.quote) ? got : Math.floor((got * mid) / 1000);
              await landOps(6);
            }
          }
        } else {
          break; // רגל-ראשונה-נדחית → הזוג-הזה-הפעם-סגור (נרשם-בכנות)
        }
      }
    } else {
      /* זוג-ספר-בלבד (הזוגות-החדשים-מול-הסטייבל): IOC-דרך-הספר */
      const bestBid = Number(mk.bestBid) || 0;
      const bestAsk = Number(mk.bestAsk) || 0;
      if (!(bestBid > 0 && bestAsk > 0)) { skipped.push(`${key}:book-empty`); continue; }
      const spreadBps = ((bestAsk - bestBid) / bestAsk) * 10_000;
      if (spreadBps > 2_000) { skipped.push(`${key}:spread-${Math.round(spreadBps)}bps`); continue; }
      const base = String(mk.base), quote = String(mk.quote);
      // קנייה: IOC ב-bestAsk
      const buyQty = Math.max(500, Math.floor((SWEEP_UNIT_MU * 1000) / bestAsk));
      if (bal("sweeper", quote) >= Math.ceil((buyQty * bestAsk) / 1000)) {
        if (send({ type: "order", issuer: "sweeper", nonce: nextNonce("swp-b"), base, quote, side: "buy", price: bestAsk, amount: buyQty, ioc: true }, key, "buy-ioc")) {
          beatNotional += SWEEP_UNIT_MU;
          await landOps(6);
          if (rt.halted) break;
          // מכירה-חזרה: IOC ב-bestBid על מה-שנקנה-בפועל (המאזן-הטרי-אחרי-הבלוק)
          const held = bal("sweeper", base);
          if (held >= 500) {
            if (send({ type: "order", issuer: "sweeper", nonce: nextNonce("swp-s"), base, quote, side: "sell", price: bestBid, amount: held, ioc: true }, key, "sell-ioc")) {
              beatNotional += Math.floor((held * bestBid) / 1000);
              await landOps(6);
            }
          }
        }
      } else {
        skipped.push(`${key}:no-${quote}`);
      }
    }
  }

  /* ── שלב-ג: רשת-טריגרים עומדת (מכשיר-התנודתיות — התעוררות אוטומטית על תזוזת-אורקל) ── */
  let trigSent = 0;
  if (TRIG_REFRESH > 0) {
    const trigs = (rt.st.trig ?? {}) as Record<string, Record<string, unknown>>;
    const mine = Object.values(trigs).filter((t) => t.owner === "sweeper");
    for (const t of mine) {
      submitOp({ type: "trig_cancel", issuer: "sweeper", nonce: nextNonce("swp-tc"), progId: String(t.id) });
    }
    const core = markets.filter((m) => ["SAOS/USDS", "USDS/WSTEEM"].includes(String(m.key)));
    for (const mk of core) {
      const mid = Math.max(mk.poolMid || 0, mk.fair || 0);
      if (!(mid > 0)) continue;
      const base = String(mk.base), quote = String(mk.quote);
      const qty = Math.max(500, Math.min(5_000, Math.floor((SWEEP_UNIT_MU * 1000) / mid)));
      // טריגר-מכירה מעל (take-profit ריבוני) + טריגר-קנייה מתחת (תפיסת-צלילה)
      const upPx = Math.floor((mid * 10_300) / 10_000);
      const dnPx = Math.floor((mid * 9_700) / 10_000);
      if (bal("sweeper", base) >= qty) {
        submitOp({ type: "trig_order", issuer: "sweeper", nonce: nextNonce("swp-t"), base, quote, side: "sell", triggerPx: upPx, limitPx: Math.floor((upPx * 9_950) / 10_000), amount: qty, expiresH: 24, trigDir: "up" }) && trigSent++;
      }
      const lockUsds = Math.ceil((qty * dnPx) / 1000);
      if (bal("sweeper", quote) >= lockUsds) {
        submitOp({ type: "trig_order", issuer: "sweeper", nonce: nextNonce("swp-t"), base, quote, side: "buy", triggerPx: dnPx, limitPx: Math.floor((dnPx * 10_050) / 10_000), amount: qty, expiresH: 24, trigDir: "down" }) && trigSent++;
      }
    }
  }

  /* ── שלב-ד: הרצה-כבדה — הטיקים שמכניסים הכל לבלוקים (הארנה מסחרת-איתנו) ── */
  for (let i = 0; i < SWEEP_TICKS; i++) {
    await stepOnce();
    if (rt.halted) { console.error(`[sweep] HALTED mid-run after ${i} ticks: ${rt.haltReason ?? "?"}`); break; }
  }
  forceFlush();

  /* ── שלב-ה: מדידה-כנה מהנרות — אפס-המצאה (הקציר-המצטבר-הוא-המקור; הטבעת
   * הסופית משלימה רק-אירועים-שעוד-על-הטבעת) ── */
  const st1 = getState();
  harvestSweeperEvents();
  const tape = getTape(2_000);
  const sweepVolFinal = sweepVol;
  const sweepFillsFinal = sweepFills;
  const dFees = Math.max(0, (st1.feeMeter ?? 0) - feeMeter0);
  const dFills = Math.max(0, (st1.fills ?? 0) - fills0);
  const dSwaps = Math.max(0, (st1.swaps ?? 0) - swaps0);
  const heightTo = rt.st.height;

  ledger.beats += 1;
  ledger.updatedAt = new Date().toISOString();
  ledger.lifetime.fundedFromTreasuryMu += fundedMu;
  ledger.lifetime.fills += sweepFillsFinal;
  ledger.lifetime.volQuoteMu += sweepVolFinal;
  ledger.lifetime.feesMu += dFees;
  ledger.last = {
    at: ledger.updatedAt, heightFrom, heightTo, ticks: SWEEP_TICKS,
    legs: legsSent, rejected, fills: sweepFillsFinal, volQuoteMu: sweepVolFinal, feesMu: dFees, fundedMu,
    perMarket,
  };
  fs.writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 1));

  /* flow24 — חלון-הנפח מהנרות (כיסוי: טבעת-הנרות שנשמרת-ב-git) */
  const nowMs = Date.now();
  const inWindow = tape.filter((e) => typeof e.at === "number" && nowMs - (e.at as number) < 86_400_000);
  const vol24 = inWindow.reduce((s, e) => s + (typeof e.quoteMu === "number" ? (e.quoteMu as number) : 0), 0);
  const byMarket: Record<string, { volQuoteMu: number; trades: number }> = {};
  for (const e of inWindow) {
    const k = `${String(e.base)}/${String(e.quote)}`;
    byMarket[k] ??= { volQuoteMu: 0, trades: 0 };
    byMarket[k].volQuoteMu += typeof e.quoteMu === "number" ? (e.quoteMu as number) : 0;
    byMarket[k].trades += 1;
  }
  fs.writeFileSync(FLOW_FILE, JSON.stringify({
    version: 1, publishedAt: ledger.updatedAt, book: "saos-dex-sweep/1",
    window: { hours: 24, coverage: "tape-ring-committed", trades: inWindow.length },
    vol24QuoteMu: vol24, feeMeterTotalMu: st1.feeMeter ?? 0,
    sweep: { beats: ledger.beats, lifetimeVolQuoteMu: ledger.lifetime.volQuoteMu, lifetimeFeesMu: ledger.lifetime.feesMu, lastVolQuoteMu: sweepVolFinal },
    markets: byMarket,
  }));

  console.log(`[sweep] done h${heightFrom}→${heightTo} · legs=${legsSent}(rejected ${rejected}) · fills=${sweepFillsFinal} · swaps=${dSwaps} · vol=${sweepVolFinal}µ · dFees=${dFees}µ · ${(Date.now() - t0) / 1000}s`);
  if (skipped.length) console.log(`[sweep] honest skips: ${skipped.slice(0, 8).join(" · ")}${skipped.length > 8 ? ` +${skipped.length - 8}` : ""}`);

  /* ── שלב-ו: התחייבות-עצמית של הפנקס (בלי-לגעת בקבצי-הלב של ה-commit-של cloud-beat) ── */
  git('config user.name "sweep-machine[bot]"');
  git('config user.email "sweep-machine[bot]@agents.roshpinacare-sys"');
  git("add -- db/sweep-ledger.json db/flow24.json");
  const staged = git("diff --cached --name-only");
  if (staged) {
    git(`commit -m "sweep-beat: h${heightFrom}→h${heightTo} · legs=${legsSent} · fills=${sweepFills} · vol=${sweepVol}µ · dFees=${dFees}µ"`);
    const ok = pushWithRetry(process.cwd(), "main");
    console.log(`[sweep] ledger ${ok ? "committed+pushed" : "commit local (push busy — next beat retries)"}`);
  }

  /* ── פרסום-פומבי של הזרימה ל-Console (שולחן-הענקים קורא משם) — כנה-גם-בלי-טוקן ── */
  const CONSOLE_TOKEN = process.env.CONSOLE_TOKEN ?? "";
  if (CONSOLE_TOKEN) {
    const PUB = "/tmp/console-sweep-publish";
    try {
      execSync(`rm -rf ${PUB} && git clone --depth 3 -q https://x-access-token:${CONSOLE_TOKEN}@github.com/roshpinacare-sys/Console.git ${PUB}`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      fs.mkdirSync(path.join(PUB, "dex"), { recursive: true });
      fs.writeFileSync(path.join(PUB, "dex", "flow.json"), fs.readFileSync(FLOW_FILE));
      execSync('git config user.name "sweep-machine[bot]"', { encoding: "utf8", cwd: PUB });
      execSync('git config user.email "sweep-machine[bot]@agents.roshpinacare-sys"', { encoding: "utf8", cwd: PUB });
      execSync("git add dex/flow.json", { encoding: "utf8", cwd: PUB, stdio: ["ignore", "pipe", "pipe"] });
      const stagedPub = execSync("git diff --cached --name-only", { encoding: "utf8", cwd: PUB }).trim();
      if (stagedPub) {
        execSync(`git commit -m "dex-flow: h${heightTo} · vol24=${vol24}µ · sweep-fills=${sweepFillsFinal} · ${ledger.updatedAt.slice(0, 16)}Z"`, { encoding: "utf8", cwd: PUB, stdio: ["ignore", "pipe", "pipe"] });
        const ok = pushWithRetry(PUB, "main");
        console.log(`[sweep] Console flow.json ${ok ? "published" : "push failed (next beat retries)"}`);
      } else {
        console.log("[sweep] Console flow.json unchanged");
      }
    } catch (e) {
      console.error(`[sweep] Console publish skipped honestly: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    console.log("[sweep] CONSOLE_TOKEN missing — public flow book NOT published (ledger still committed)");
  }

  process.exit(0);
}

main().catch((e) => {
  console.error("[sweep] FATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
