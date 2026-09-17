/**
 * rail.ts — THE-MICRORAIL (SETTLE-16): המסילה הריבונית-למיקרו.
 *
 * דבר-המפעיל: "תמצא תקציב ותפעיל את המסילה גם למיקרו — ברשת שלנו אין עמלה על
 * עסקאות ויש לנו תקשורת ייחודית עם חוזים חכמים, אז אפשר למצוא יתרון במיקרו-
 * טריידים רווחיים. מצא עוד יתרונות. תפעל היטב את המיקרו על התקציב הקיים בתיקיות
 * בריפו. טפל בכל החסמים. פתרונות ריבוניים על הרשת שלנו כדי לגשר."
 *
 * ── היתרון-המדוד (למה מיקרו מרוויח דווקא פה) ────────────────────────────────
 *  · אפס-עמלת-רשת: מנת-מסילה 150kµ שורפת גז 100µ = 0.067% — על-רשת-ציבורית
 *    (ETH-mainnet gas $1-5/tx) מנה-כזאת חדלת-כדאיות; עלינו היא רווחית-מכל-גודל.
 *  · תקשורת-חוזים-ישירה: ה-op נכנס לגרעין באותו-טיק — אין-RPC-latency, אין-
 *    mempool-ציבורי (אין-sandwich/MEV), סדר-דטרמיניסטי על הספר.
 *  · אטומיות: pool_swap בודד עם minOut fail-closed; רב-רגליים דרך batch
 *    (SETTLE-12) — אין-ביצוע-חלקי.
 *  · מסדרון-העיגון (wrap 1:1): המלאי לא נתקע — STEEM⇄WSTEEM חינם.
 *  · עיגון-צי חינם (SETTLE-13): אבני-דרך של ה-P&L נעוגנות-ל-Hive ב-RC (26/יום).
 *
 * ── התקציב (מה שכבר-קיים בתיקיות — אפס-הטבעה) ──────────────────────────────
 *  · USDS 2.6Mµ יושב-ישן ב-arb-ext (תוצרי-הסוויפ של THE-REPEG) → הון-עובד.
 *  · WSTEEM 2.0Mµ יושב-ישן ב-bot-a (שקית-העידן-המוטה) → מלאי-מכירה (בסיס-עלות
 *    = העיגון — כל-מכירה-מעליו היא לכידת-פרמיה אמת).
 *  · ENERGY 100kµ אצל bot-c → מלאי-צד-המיקרו.
 *  · הכל בהעברות-חינם (xfer_free) על הרשת-הריבונית — הריבונות היא המוצר.
 *
 * ── המנוע ───────────────────────────────────────────────────────────────────
 *  · שוקי-המסילה (עוגני-אמת, לא-פייר-צף):
 *     1. USDS/WSTEEM — עוגן refPrice(WSTEEM)=360µ ≡ STEEM 1:1 (גיבוי-נעול).
 *     2. ENERGY/SAOS — עוגן צולב: refPrice(ENERGY) ביחס למחיר-החי של SAOS.
 *  · כל-8-טיקים (הפרדה-בין-השוקים): מדידת-פרמיה; |פרמיה| ≥ 200bps (מכסה
 *    עמלת-30bps+גז+השפעה) → מנת-מיקרו-מדודה לכיוון-העוגן, minOut fail-closed
 *    (4% — השיעור-מ-SETTLE-15), גודל-לינארי-חצי-פער בתקרת-מנה.
 *  · זהו-שפשוף-TWAP: מנות-קטנות-חוזרות שוחקות-את-הפרמיה-אל-העוגן בלי-לרסק-
 *    את-הבריכה — ומכניסות-חיים-מתמדת-לבריכה-המיקרו (עמלות-לאוצר כל-מנה).
 *  · העקירה-המוסדית: pegkeeper (mm.ts) מוותר-על-נעילת-USDS/WSTEEM — המסילה
 *    היא בעלת-המשמעת-שלו (מנוע-אחד-לעוגן, אפס-מלחמת-סוכנים).
 *  · P&L כנה: סימון-לעוגן (MTM) — הון-המסילה במחירי-עוגן מול-סך-המימון
 *    (בסיס-האתחול+הזרמות). אפס-הטבעה — Σ שומר על-ידי העברות-טהורות בלבד.
 *
 * אפס-float במצב · אפס-מפתחות · קריאה-על-המצב-החי בלבד.
 */
import fs from "fs";
import path from "path";
import type { DexState, Op, Asset } from "./kernel";
import { getPool, quoteOut, poolMidFor } from "./amm";
import { poolKey, avail } from "./kernel";

export const RAIL = "rail";
export const RAIL_MIN_EDGE_BPS = 200; // מתחת-לזה המנה לא משלמת (עמלה+גז+השפעה)
export const RAIL_SLIP_BAND = 96; // minOut = 96% מהציטוט — fail-closed (SETTLE-15)
export const RAIL_OWNED_POOLS = new Set([poolKey("WSTEEM", "USDS")]); // נשלפים מנעילת-pegkeeper

interface RailMarket {
  id: string;
  base: Asset;
  quote: Asset;
  pair: string;
  minDoseMu: number;
  maxDoseMu: number;
  tickPhase: number; // tick % 8 === phase
}

const RAIL_MARKETS: RailMarket[] = [
  { id: "wsteem", base: "WSTEEM", quote: "USDS", pair: poolKey("WSTEEM", "USDS"), minDoseMu: 5_000, maxDoseMu: 200_000, tickPhase: 0 },
  { id: "energy", base: "ENERGY", quote: "SAOS", pair: poolKey("ENERGY", "SAOS"), minDoseMu: 1_000, maxDoseMu: 20_000, tickPhase: 4 },
];

// ── עוגני-אמת ────────────────────────────────────────────────────────────────

/** מחיר-עוגן של SAOS (µ-USDS ל-1-SAOS): mid-בריכת-SAOS/USDS, נפילה-לספר. */
function saosPxMu(st: DexState): number {
  const p = getPool(st, poolKey("SAOS", "USDS"));
  const mid = p ? poolMidFor(p, "SAOS", "USDS") : 0;
  return mid > 0 ? mid : st.assets["SAOS"]?.refPrice ?? 0;
}

/** עוגן-הבסיס בµ-quote ל-1-יחידת-בסיס (לא µ-quote ל-µ — סקאלת-היחידות של הספר). */
export function railAnchorMu(st: DexState, m: RailMarket): number {
  if (m.id === "wsteem") return st.assets["WSTEEM"]?.refPrice ?? 0; // ≡STEEM 1:1
  if (m.id === "energy") {
    const eRef = st.assets["ENERGY"]?.refPrice ?? 0; // µ-USDS ל-1-ENERGY
    const sPx = saosPxMu(st); // µ-USDS ל-1-SAOS
    if (eRef <= 0 || sPx <= 0) return 0;
    return Math.max(1, Math.floor((eRef * 1000) / sPx)); // µ-SAOS ל-1-ENERGY
  }
  return 0;
}

/** פרמיית-בריכה מעל-העוגן בbps (חיוב = בריכה-יקרה). */
export function railPremiumBps(st: DexState, m: RailMarket): { mid: number; anchor: number; premBps: number } {
  const p = getPool(st, m.pair);
  const mid = p ? poolMidFor(p, m.base, m.quote) : 0;
  const anchor = railAnchorMu(st, m);
  const premBps = mid > 0 && anchor > 0 ? Math.floor(((mid - anchor) * 10_000) / anchor) : 0;
  return { mid, anchor, premBps };
}

// ── טלמטריה (חוץ-מצב — בדיוק-כמו arenaRearm/botSeedCaps) ────────────────────

export interface RailDoseRec {
  tick: number;
  pair: string;
  side: "sell" | "buy";
  inMu: number;
  midMu: number;
  anchorMu: number;
  premBps: number;
  // FIX(Roast-66 · dose-truth): המנה-נרשמת-"pending"-בדחיפה ומתאשרת-רק-מתוצאת-הבלוק
  // (היה: נספרה-כבוצעה-מיד — minOut-fail נספר-כמנה-וה-P&L/אבני-הדרך נפחו).
  nonce?: string;
  ok?: boolean | null;
}

/** FIX(Roast-67 · funding-truth): מימון-מסילה בהמתנה-לתוצאת-הבלוק. */
interface RailFundPend {
  nonce: string;
  key: "usds" | "wsteem" | "energy" | "saos";
  amt: number; // µ-יחידות-הנכס
  inflowMu: number; // שווי-עוגן-אינדיקטיבי (נמדד-בעת-הדחיפה)
  tick: number;
}

interface RailRT {
  baseEquityMu: number | null; // הון-עוגן באתחול-התהליך (נטו-מתאפס-פר-ריצה — כנות)
  inflowMu: number; // הזרמות-מימון-מאז-האתחול (בשווי-עוגן µ-USDS)
  doses: number; // FIX(Roast-66): מנות-ש**בוצעו** בפועל (r.ok) — לא-נספרות-עוד-בדחיפה
  dosesPushed: number; // FIX(Roast-66): מנות-שנדחפו-לממפול (כולל-דחויות) — כנות-מלאה
  doseLog: RailDoseRec[];
  // FIX(Roast-67 · funding-truth): היה — lifetime+inflowMu נקומיטו-מיד-בדחיפה; op-שנדחה
  // בגרעין היה מנפח-funded, בולע-תקרת-חיים, ומציג-מימון-שמעולם-לא-הגיע. עתה — pending
  // עד-אישור-הבלוק: קומיט-רק-על-ok, דחייה/נפילה = אפס-צריכת-תקרה.
  fundingPending: RailFundPend[];
  fundingCommitted: number;
  fundingRejected: number;
  fundingDropped: number;
}
// FIX(SETTLE-16 split-brain, הלקה-מ-SETTLE-12): RT-ברמת-מודול שוכפל-בין-מופעי-
// מודול-שונים-של-dev-server (instrumentation מול-route) — הטלמטריה-הראתה-0-מנות
// בזמן-שהמסילה-סחרה. globalThis = מופע-אחד-לכל-הבאנדלים (אותו-דפוס של ensureChain).
const g = globalThis as unknown as { __saosRailRT?: RailRT; __saosRailLife?: Record<string, number> };
const railRt: RailRT = g.__saosRailRT ?? (g.__saosRailRT = { baseEquityMu: null, inflowMu: 0, doses: 0, dosesPushed: 0, doseLog: [], fundingPending: [], fundingCommitted: 0, fundingRejected: 0, fundingDropped: 0 });
// FIX(SETTLE-16 legacy): מופע-ישן-ששרד-חימום-חוזר עשוי-לחסר-את-השדות-החדשים
if (!railRt.fundingPending) railRt.fundingPending = [];
if (!railRt.fundingCommitted) railRt.fundingCommitted = 0;
if (!railRt.fundingRejected) railRt.fundingRejected = 0;
if (!railRt.fundingDropped) railRt.fundingDropped = 0;

/** מחיר-עוגן לסימון-הון (µ-USDS ל-1-יחידה; credits ו-USDS = 1000). */
function markMu(st: DexState, a: string): number {
  if (a === "USDS") return 1000;
  if (a === "WSTEEM" || a === "STEEM") return st.assets["WSTEEM"]?.refPrice ?? st.assets["STEEM"]?.refPrice ?? 0;
  if (a === "ENERGY") return st.assets["ENERGY"]?.refPrice ?? 0;
  if (a === "SAOS") return saosPxMu(st);
  const ref = st.assets[a]?.refPrice ?? 0; // WSBD/PHIVE — רצפת-ספר (כנות)
  return ref;
}

/** הון-המסילה מסומן-לעוגן (µ-USDS). */
export function railEquityMu(st: DexState): number {
  let eq = st.credits[RAIL] ?? 0; // credits = µ-USDS
  const b = st.balances[RAIL] ?? {};
  for (const [a, amt] of Object.entries(b)) {
    if (!(amt > 0)) continue;
    const px = markMu(st, a);
    if (px <= 0) continue; // LP/נכסים-ללא-עוגן — לא-מדומים (כנות)
    eq += Math.floor((amt * px) / 1000);
  }
  return eq;
}

export interface RailSummary {
  enabled: true;
  equityMu: number;
  fundedMu: number;
  netMu: number;
  doses: number;
  doseLog: RailDoseRec[];
  premiums: { id: string; pair: string; mid: number; anchor: number; premBps: number; active: boolean }[];
  budget: { credits: number; usdsMu: number; wsteemMu: number; energyMu: number; saosMu: number };
  funding: { pending: number; committed: number; rejected: number; dropped: number }; // FIX(Roast-67)
  note: string;
}

export function railSummary(): RailSummary {
  const st = getLiveStateRef();
  if (railRt.baseEquityMu === null) railRt.baseEquityMu = railEquityMu(st);
  const premiums = RAIL_MARKETS.map((m) => {
    const r = railPremiumBps(st, m);
    return { id: m.id, pair: m.pair, mid: r.mid, anchor: r.anchor, premBps: r.premBps, active: Math.abs(r.premBps) >= RAIL_MIN_EDGE_BPS };
  });
  const b = st.balances[RAIL] ?? {};
  const eq = railEquityMu(st);
  const funded = (railRt.baseEquityMu ?? 0) + railRt.inflowMu;
  return {
    enabled: true,
    equityMu: eq,
    fundedMu: funded,
    netMu: eq - funded,
    doses: railRt.doses,
    doseLog: railRt.doseLog.slice(-8).reverse(),
    premiums,
    budget: {
      credits: st.credits[RAIL] ?? 0,
      usdsMu: b["USDS"] ?? 0,
      wsteemMu: b["WSTEEM"] ?? 0,
      energyMu: b["ENERGY"] ?? 0,
      saosMu: b["SAOS"] ?? 0,
    },
    funding: {
      pending: railRt.fundingPending.length,
      committed: railRt.fundingCommitted,
      rejected: railRt.fundingRejected,
      dropped: railRt.fundingDropped,
    },
    note: "מסילת-המיקרו הריבונית: אפס-עמלת-רשת · מנות-מדודות-לעוגן minOut-fail-closed · P&L מסומן-לעוגן (MTM, אתחול-פר-ריצה) · אפס-הטבעה · מימון-אמת Roast-67: קומיט-רק-מאישור-בלוק",
  };
}

// קישור-מצב-חי — מוזרק-מ-chain.ts (מניעת-ייבוא-מעגלי chain⇄rail)
let liveStateRef: (() => DexState) | null = null;
export function bindLiveState(fn: () => DexState): void { liveStateRef = fn; }
function getLiveStateRef(): DexState {
  if (!liveStateRef) throw new Error("rail: live-state-not-bound");
  return liveStateRef();
}

// ── מימון-המסילה (התקציב-מהתיקיות — העברות-טהורות, אפס-הטבעה) ────────────────

const FLOOR_USDS = 250_000;
const FLOOR_WSTEEM = 100_000;
const FLOOR_ENERGY = 5_000;
const FLOOR_SAOS = 100_000; // צד-קנייה-לבריכת-המיקרו (ENERGY/SAOS)
const TRANCHE_USDS = 500_000;
const TRANCHE_WSTEEM = 300_000;
const TRANCHE_ENERGY = 30_000;
const TRANCHE_SAOS = 200_000;
const LIFETIME_USDS = 6_000_000; // arb-ext 2.6M + גיבוי-אוצר/מפעיל — תקרה-כנה
const LIFETIME_WSTEEM = 5_000_000; // שקיות-הבוטים 4.2M + שאריות-אוצר — תקרה-כנה
const LIFETIME_ENERGY = 300_000; // bot-c 100k + רכישות-חוזרות — תקרה-כנה
const LIFETIME_SAOS = 2_000_000; // הארנה/האוצר שופעים-SAOS — תקרה-כנה-לכל-חיי-התהליך
const railLifetime: Record<string, number> = g.__saosRailLife ?? (g.__saosRailLife = { usds: 0, wsteem: 0, energy: 0, saos: 0 });

/* ── FIX(Roast-64-c · F10): תקרות-החיים שורדות-הפעלות ──
 * ההיסטוריה: המונים-חיו-ב-globalThis בלבד → כל-ריסטארט איפס אותם וה-"תקרות
 * כנות" היו תיאטרון-פר-תהליך (ניתן-לזריעה-חוזרת-מלאה). עתה: state/rail-lifetime.json
 * — נטען-באתחול-המודול (max עם הזיכרון — תקרה-לעולם-לא-מתאפסת), נשמר-אטומית
 * (tmp+rename — אותו-משמעת של flushSnapshot) בכל-עדכון. */
const RAIL_STATE_DIR = process.env.SAOS_DEX_STATE_DIR
  ? path.resolve(process.env.SAOS_DEX_STATE_DIR)
  : path.join(process.cwd(), "state");
const RAIL_LIFETIME_FILE = path.join(RAIL_STATE_DIR, "rail-lifetime.json");
const LIFETIME_KEYS = ["usds", "wsteem", "energy", "saos"] as const;

function loadRailLifetime(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(RAIL_LIFETIME_FILE, "utf8")) as Partial<Record<string, number>>;
    for (const k of LIFETIME_KEYS) {
      const v = Number(raw[k]);
      if (Number.isFinite(v) && v >= 0) railLifetime[k] = Math.max(railLifetime[k] ?? 0, v); // max — אף-פעם-לא-איפוס
    }
  } catch { /* אין-קובץ — התחלה-נקייה */ }
}

function saveRailLifetime(): void {
  try {
    fs.mkdirSync(RAIL_STATE_DIR, { recursive: true });
    const tmp = RAIL_LIFETIME_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(railLifetime, null, 1));
    fs.renameSync(tmp, RAIL_LIFETIME_FILE);
  } catch { /* כשל-שמירה לא מפיל את המסילה (ההזרמה-עצמה נרשמת-בגרעין) */ }
}

loadRailLifetime(); // אתחול-מודול — המוני-החיים חוזרים מהדיסק

/** מקור-מימון: התיק-הקיים-הגדול קודם (דבר-גורר-דבר), אוצר-גיבוי. */
function fundingSource(st: DexState, asset: "USDS" | "WSTEEM" | "ENERGY" | "SAOS"): string | null {
  const pools: Record<string, string[]> = {
    USDS: ["arb-ext", "treasury", "operator"],
    WSTEEM: ["bot-a", "bot-b", "bot-c", "treasury", "operator"],
    ENERGY: ["bot-c", "treasury", "operator"],
    SAOS: ["arena", "treasury", "operator"],
  };
  for (const src of pools[asset]) {
    if (avail(st, src, asset) >= 10_000) return src; // ≥10kµ — יש-מה להזרים
  }
  return null;
}

function pushFunding(st: DexState, tick: number, pushOp: (op: Op) => void, asset: "USDS" | "WSTEEM" | "ENERGY" | "SAOS", floorMu: number, trancheMu: number, lifetimeKey: "usds" | "wsteem" | "energy" | "saos", lifetimeCap: number): void {
  if (avail(st, RAIL, asset) >= floorMu) return;
  if (railLifetime[lifetimeKey] + trancheMu > lifetimeCap) return;

  /** ── SETTLE-18 (rail-WSTEEM wrap bridge · starved-rail cure) ──
   * ממצא-חי (R29): המסילה מעולם-לא-ביצעה-מנה-אחת על-קו-WSTEEM (doses=0) בעוד
   * premium של +82,777bps בער-מעליה. שורש: מקורות-המימון התרוקנו-מבנית —
   * שקיות-הבוטים ריקות, לאופרטור אין, ושארית-האוצר (18.3Kµ) נפלה-מתחת-לשער-
   * הרעש (floor/5=20Kµ) — ההזרמה נדחית-לנצח בזמן-ש-316Kµ STEEM-טבעי-כנה
   * יושבים-באוצר חסרי-תפקיד. הטיפול: לפני-ניסיון-ההעברה — האוצר עוטף-STEEM
   * טבעי ל-WSTEEM (1:1 כנה, הגיבוי-נרשם ב-backing, אותו-פעולת-wrap_mint
   * של-קו-ה-rearm SETTLE-14). ריקוד-שני-חלונות-כמו-שם: העטיפה נוחתת-בחלון-
   * הזה, ההעברה-למסילה נפרקת-בחלון-הבא מתוך-מלאי-קיים-בלבד — אפס-ספירה-
   * כפולה, אפס-הטבעה, הגרעין-אוכף-בעצמו. */
  if (asset === "WSTEEM") {
    const tw = avail(st, "treasury", "WSTEEM");
    const need = Math.min(trancheMu, lifetimeCap - railLifetime[lifetimeKey]);
    if (tw < need && avail(st, "treasury", "STEEM") >= need - tw) {
      pushOp({ type: "wrap_mint", issuer: "treasury", nonce: `rail-wrap-${tick}`, wrapAsset: "WSTEEM", amount: need - tw });
    }
  }

  const src = fundingSource(st, asset);
  if (!src) return;
  const amt = Math.min(trancheMu, lifetimeCap - railLifetime[lifetimeKey], avail(st, src, asset));
  if (amt < floorMu / 5) return; // מנה-שווה-שמה (אפס-רעש-ממפול)
  // מימון-בהעברה-חינם (xfer_free — אפס-גז, תקרה-2M); האוצר/מפעיל ב-transfer רגיל.
  if (src === "treasury" || src === "operator") {
    if ((st.credits[src] ?? 0) < 100) return; // דלק-להעברה
    pushOp({ type: "transfer", issuer: src, nonce: `rail-fund-${asset}-${tick}`, to: RAIL, asset, amount: amt });
  } else {
    pushOp({ type: "xfer_free", issuer: src, nonce: `rail-fund-${asset}-${tick}`, to: RAIL, asset, amount: amt });
  }
  // FIX(Roast-67 · funding-truth): אין-קומיט-בדחיפה — המנה נרשמת-pending עד-תוצאת-הבלוק.
  // railLifetime ו-inflowMu מתעדכנים רק ב-railReconcile כשה-op אושר בפועל (אפס-נפיחה).
  const nonce = `rail-fund-${asset}-${tick}`;
  const px = markMu(st, asset);
  sweepStaleFunding(tick);
  railRt.fundingPending.push({ nonce, key: lifetimeKey, amt, inflowMu: px > 0 ? Math.floor((amt * px) / 1000) : 0, tick });
}

/** FIX(Roast-67): פינוי-pendings-מתים — מחזור-מימון (16-טיק) וחצי בלי-פיוס =
 * ה-op מת-מעבר-לתהליך; פינוי = אפס-צריכת-תקרה (המנה חוזרת-לזמינה). */
const FUNDING_STALE_TICKS = 40;
function sweepStaleFunding(tick: number): void {
  for (let i = railRt.fundingPending.length - 1; i >= 0; i--) {
    if (tick - railRt.fundingPending[i].tick > FUNDING_STALE_TICKS) {
      railRt.fundingPending.splice(i, 1);
      railRt.fundingDropped++;
    }
  }
}

// ── הטיק ─────────────────────────────────────────────────────────────────────

/** railTick — מריץ-מתוך arenaTick (mm.ts) אחרי-pegkeeper. כל-ההחלטות מהמצב-החי. */
export function railTick(st: DexState, tick: number, pushOp: (op: Op) => void): void {
  // (1) מימון-רצפות — כל-16-טיק
  if (tick % 16 === 0) {
    pushFunding(st, tick, pushOp, "USDS", FLOOR_USDS, TRANCHE_USDS, "usds", LIFETIME_USDS);
    pushFunding(st, tick, pushOp, "WSTEEM", FLOOR_WSTEEM, TRANCHE_WSTEEM, "wsteem", LIFETIME_WSTEEM);
    pushFunding(st, tick, pushOp, "ENERGY", FLOOR_ENERGY, TRANCHE_ENERGY, "energy", LIFETIME_ENERGY);
    pushFunding(st, tick, pushOp, "SAOS", FLOOR_SAOS, TRANCHE_SAOS, "saos", LIFETIME_SAOS);
  }

  // (2) מנות-שפשוף — כל-שוק בפאזה-משלו (כל-8-טיקים, מופרדים)
  for (const m of RAIL_MARKETS) {
    if (tick % 8 !== m.tickPhase) continue;
    const { mid, anchor, premBps } = railPremiumBps(st, m);
    if (mid <= 0 || anchor <= 0) continue;
    if (Math.abs(premBps) < RAIL_MIN_EDGE_BPS) continue;

    const sell = premBps > 0; // בריכה-יקרה → מוכרים-בסיס-פנימה (מורידים-לעוגן)
    const assetIn = (sell ? m.base : m.quote) as Asset;
    const p = getPool(st, m.pair);
    if (!p) continue;
    const rIn = assetIn === p.a ? p.ra : p.rb;
    // גודל-לינארי-חצי-פער (אותה-ליניאריזציה של pegkeeper) בתקרת-מנה,
    // ותקרת-ריכוז 25%-מעתודת-הקלט (הבריכה-המיקרו צרה — מנה-ענקית = סליפאג')
    const halfGap = Math.floor(Math.abs(Math.floor((rIn * premBps) / 10_000)) / 2);
    const size = Math.min(Math.max(halfGap, m.minDoseMu), m.maxDoseMu, Math.floor(rIn / 4), avail(st, RAIL, assetIn));
    if (size < m.minDoseMu) continue;

    // minOut fail-closed על-ציטוט-חי (4% — רוחב-SETTLE-15)
    const q = quoteOut(p, assetIn, size);
    if (!q || q.out <= 0) continue;
    const rec: RailDoseRec = { tick, pair: m.pair, side: sell ? "sell" : "buy", inMu: size, midMu: mid, anchorMu: anchor, premBps, nonce: `rail-${m.id}-${tick}`, ok: null };
    pushOp({ type: "pool_swap", issuer: RAIL, nonce: `rail-${m.id}-${tick}`, pair: m.pair, assetIn, amount: size, minOut: Math.floor((q.out * RAIL_SLIP_BAND) / 100) });
    railRt.dosesPushed++;
    railRt.doseLog.push(rec);
    if (railRt.doseLog.length > 32) railRt.doseLog.splice(0, railRt.doseLog.length - 32);
  }
}

/** FIX(Roast-66 · dose-truth): פיוס-תוצאות-המנות — נקרא-מ-buildBlock אחרי-ביצוע-ה-ops.
 * מנה-שה-op-שלה אושר בגרעין (r.ok) נספרת-כבוצעה; נדחית-נשארת-בלוג-עם ok:false —
 * כנות-מלאה: גם-הניסיונות (dosesPushed) וגם-הביצועים (doses) חשופים. */
export function railReconcile(rs: { nonce: string; ok: boolean }[]): void {
  if (rs.length === 0) return;
  const byNonce = new Map(rs.map((x) => [x.nonce, x.ok]));
  for (const rec of railRt.doseLog) {
    if (rec.ok !== null || !rec.nonce) continue;
    const ok = byNonce.get(rec.nonce);
    if (ok === undefined) continue;
    rec.ok = ok;
    if (ok) railRt.doses++;
  }
  // FIX(Roast-67 · funding-truth): פיוס-המימון — קומיט-רק-על-אישור-בלוק-אמת.
  for (let i = railRt.fundingPending.length - 1; i >= 0; i--) {
    const p = railRt.fundingPending[i];
    const ok = byNonce.get(p.nonce);
    if (ok === undefined) continue;
    railRt.fundingPending.splice(i, 1);
    if (ok) {
      railLifetime[p.key] += p.amt; // התקרה נצרכת-רק-על-כסף-שבאמת-זרם
      saveRailLifetime(); // FIX(Roast-64-c): השמירה-האטומית עוברת-לרגע-הקומיט (לא-הדחיפה)
      railRt.inflowMu += p.inflowMu;
      railRt.fundingCommitted++;
    } else {
      railRt.fundingRejected++; // דחייה = אפס-צריכת-תקרה, אפס-inflow — כנות-מלאה
    }
  }
}
