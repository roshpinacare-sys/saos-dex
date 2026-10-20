/**
 * chain.ts — שרשרת-הפעימה של SAOS-DEX (מורשת grid98 + saosnet):
 *  · מצב-תושב (resident state): ריפליי-מלא פעם-אחת באתחול (או טעינת-תמונת-מצב),
 *    ואחר-כך סנכרון-מצטבר בלבד — אפס-ריפליי-פר-פעימה
 *  · מיקרו-פעימות: בלוק-אמת כל 3 שנ׳ · checkpoint/חותם כל-12 בלוקים (CHAIN_SPEC)
 *  · עיגון-מקומי כן: חותמים + קבלות-ראיות משורשרות-האש ב-DB
 *    (עגינת-שרשרת-ציבורית דורשת מפתחות-מפעיל — לא קיימים בסביבה זו, וזה נאמר בגלוי)
 *  · סולם-ערך: הרמת-רצפה ≤0.5% לצעד, מגובה-בעמלות-שנמדדו בלבד
 *  · order_gc כל-8 בלוקים · תמונת-מצב כל-16 טיקים
 */
import fs from "fs";
import path from "path";
import { db } from "@/lib/db";
import {
  applyOp, genesisState, stateRoot, type DexState, type Op, type TradeEvent,
  GAS_TABLE, notional, poolKey, VE_POT,
  // R44 · THE-MARKET — פרסום-שוק-הכספים במראה הציבורית (רשימה-לבנה של getState)
  lendState, lendUtilBps, lendBorrowAprBps, lendSupplyAprBps, lendDebtNow,
  lendHealthFactor, lendLiqThresholdBps, LEND_MARKETS, LEND_POT,
  // FIX(R47 · income-base): קבועי-החיסכון האמיתיים לפרסום הציבורי
  SAVE_DAY_BLOCKS, SAVE_FEE_SHARE_PCT,
} from "./kernel";
import { economyTick } from "./economy";
import { merkleRoot, sha256, canon, CanonicalError } from "./canonical";
import { invariant, InvariantViolation } from "./invariant";
import { arenaTick, fairPrice, DEFAULT_PARAMS, type ArenaParams, type SoldierRT, MARKETS } from "./mm";
import { railSummary, bindLiveState, railReconcile } from "./rail";
import { bridgeReconcile } from "./bridge"; // FIX(R17-b·H3): פיוס-גשר-מול-תוצאת-בלוק
import { milestoneSummary } from "./milestone";
import { poolMid, poolMidFor, getPool, quoteOut, LP_ASSET_PREFIX, effectiveFeeBps } from "./amm";
import { lpValuation } from "./router"; // FIX(R17-b·M4): תמחור-LP-אמת במפקד-הסוכנים (קריאה-רק-בזמן-ריצה)
import { sortBook } from "./book";
import { dcaTick, trigTick } from "./triggers";
import { protoRevTick } from "./protorev";
import { cowSettle } from "./cow";
import { vaultTick } from "./vault"; // Task 80 · THE-VAULT — סוכן-כספת-ההדגמה
import { savingsTick, saveDemoTick } from "./save"; // R40 · THE-SAVE — צבירת-הכנסה-מדודה + עמדת-המפעיל
import { veDemoTick, bondDemoTick } from "./ve"; // R41 · THE-VE — נעילה+הצבעה+אג"ח: סוגרים-את-המעגל-הרדום
import { lendTick } from "./lend"; // R44 · THE-MARKET — שוק-הכספים: סוכני-האוצר-והלווים
// Task 72 · דלת-המטבעות: פיד-האורקל — extFeeds (median חוצה-מקורות, TTL-משותף עם price-proof)
import { extFeeds } from "./price-proof";
// CEX-grade market data (Task 83): נרות-OHLCV + עסקאות + סטטיסטיקת-24ש' — חוץ-מצב מוצמד-גיט
import { klinesFeed, klinesFlush, klinesLoad, stats24For } from "./klines";
import { makerFeed, makerFlush } from "./maker"; // EXEC-CD-8 · ייחוס-מייקרים (חוץ-מצב — אותו-משטר-נרות)
import { bookGasFeed, bookGasFlush, bookGasFloor } from "./bookgas"; // EXEC-CD-9 · מד-גז-ספר (חוץ-מצב — fuel-freeze-fix)

export const TICK_MS = 3_000;
const SEAL_EVERY = 12;   // checkpoint כל-12 בלוקים (CHAIN_SPEC)
const GC_EVERY = 8;
const SNAPSHOT_EVERY = 16;
const LADDER_EVERY = 24;
const PRICE_SEAL_EVERY = 400; // Task 56 · חותם-אמינות-מחיר כל-400-בלוקים (~20 דק')
const TAPE_CAP = 600;
const CHART_CAP = 240;

/** טביעת-קוד (SETTLE-5): נחשפת ב-/api/dex/settle — גילוי-דעיכת-תהליך.
 * תהליך-ישן (דמון ששרד עריכת-קוד בלי-התחלה-מחדש) מריץ קוד-ישן ומדווח גרסה-ישנה —
 * הסתרת-תקלה כזו בדיוק שהטעתה את סבב 2026-09 (POST לא-הטביע למרות-סף-שעבר). */
export const CODE_VERSION = "saos-dex/1.19.0+cex-grade-marketdata";

// THE-MICRORAIL: קישור-מצב-חי-למסילה (מניעת-ייבוא-מעגלי chain⇄rail — הזרקה)
bindLiveState(() => ensureChain().st);

/** טבעת-דגימת-הדלק (SETTLE-5): {גובה, גז-מצטבר} לכל-בלוק, חלון-~400 בלוקים.
 * צריכת-השריפה-החלונית = (אחרון−ראשון)/(hאחרון−hראשון) — אמת-לרגע זה,
 * בניגוד לממוצע-החיים (gasUsed/height) שדורד לאט ומציג-משטר-ישן. */
export function getBurnWindow(): { h: number; gasUsed: number }[] {
  // FIX(SETTLE-9 hygiene): החזרת-המערך-הפנימי-החי אפשרה לקורא-עתידי למיין/לשנות
  // ולשחות את הטבעת — עותק-בזול (החלון ≤400 דגימות) סוגר את-זה.
  return (g.__saosDexChain?.fuelSamples ?? []).slice();
}

export interface TapeEvent extends TradeEvent { h: number }
// FIX(Roast-65-a · MED-7): החותם נושא עתה את החלון-החתום עצמו (blockHashes) — קודם
// רוקן את החלון מיד-אחרי-החתימה ו-getLatestSealLeaves הציג את החלון-הבא (שקר —
// "אימות-עצמאי" בלתי-אפשרי דרך-ה-API). העלים-החתומים נשמרים-פר-חותם + נשמרים-ל-DB.
export interface SealInfo { fromHeight: number; toHeight: number; root: string; stateRoot: string; leaves: number; at: number; digest: string; blockHashes: string[] }
export interface ReceiptInfo { kind: string; digest: string; at: number }

interface ChainRT {
  st: DexState;
  mempool: Op[];
  rt: Map<string, SoldierRT>;
  params: ArenaParams;
  tape: TapeEvent[];
  blockHashes: string[];       // מאז-החותם-האחרון (עלים לחותם הבא)
  seals: SealInfo[];
  receipts: ReceiptInfo[];
  lastReceiptDigest: string | null;
  tickCount: number;
  timer: ReturnType<typeof setInterval> | null;
  busy: boolean;
  fuelSamples: { h: number; gasUsed: number }[]; // SETTLE-5: טבעת-דגימת-דלק (חוץ-מצב — לא-חלק-מה-DexState/שורש) לשריפה-חלונית-אמת
  priceSamples: { h: number; base: string; quote: string; px: number; muQ: number }[]; // SETTLE-14: עדות-מחיר-אמת ממסחר-אמת (fill+swap) — חוץ-מצב
  buildMsRolling: number;
  opsPerSecRolling: number;
  startedAt: number;
  lastBlockAt: number;
  dbOk: boolean;
  halted: boolean; // fail-fast: הפרת-אינווריאנטה מעלה-את-השרשרת (לא בונה בלוקים נוספים)
  haltReason: string | null; // פורנזי — מה בדיוק נתפס (חשוף ב-API)
  // FIX(Roast-65-a · MED-6): כוונת-הרמת-סולם בהמתנה — ספרי-הסולם לא נוגעים עד-ששני-ה-ops
  // (harvest + asset_price) מאושרים-בפועל בבלוק (הישן: מוטט את st.ladder מראש — הרמה-שלא-שולמה
  // נשארה-במצב אם-ה-ops נדחו). חוץ-מצב (כמו-כל-טבעות-הבונה — מתועד ב-replayNote).
  pendingLift: { newRef: number; harvestMu: number; h: number; harvestNonce: string; priceNonce: string } | null;
  version: number;
  cachedRoot: { h: number; root: string } | null; // FIX(SETTLE-9 perf): stateRoot-פר-גובה — getState פר-לקוח לא מחשב-מחדש O(state)
  rejectedLast: { h: number; count: number; sample: string[] } | null; // FIX(SETTLE-15 silent-drop): ראית-דחיות-חיה
  oracleTimer: ReturnType<typeof setInterval> | null; // Task 72 · לולאת-פיד-האורקל (חוץ-מצב — ה-op עצמו קנוני)
  faucetAtRt: Map<string, number>; // FIX(R15-a): cooldown-ברז-הדמו חוץ-מצב — הכתיבה-הישירה-ב-st.faucetAt הייתה מוטציית-מצב-קנוני-מחוץ-לבלוק (שורש-מיושן + סיכון-ספיח במהלך-בנייה)
  pendingLoad: boolean; // FIX(R16-a·m5): אמת-באתחול — resetChain נדחה-כנה עד-סיום-הטעינה (ה-loader היה דורס-ג'נזיס-טרי בתמונה + מכפיל-טיימר)
}

const g = globalThis as unknown as { __saosDexChain?: ChainRT };
/* FIX(recovery-continuation · Task 22 · 2026-10-20) — שורש-הלבנה-אחרי-כל-קציר:
 * DATA_DIR היה process.cwd()/db בלבד — המשגיח (saos-dex-node) מכתיב
 * SAOS_DEX_STATE_DIR לעץ-האטימה-הקנוני (repos/saos-dex/db — נחתם-גיט ושורד-קציר)
 * והקרנל התעלם ממנו: טעינה+flush קרו בעץ-ה-work שנבנה-מחדש-מגיט-טרי אחרי-קציר →
 * קובץ-ה-snapshot חזר לגובה-ישן מול DB-שהמשיך-לצמוח בעץ-האטימה → אתחול-בא
 * נדחה snapshot-integrity-failed → לבנה על-כל-אתחול. rail.ts כבר מכבד את ה-env
 * (הקונבנציה קיימת-בקודבייס; cloud-beat גם מגדיר אותה) — עתה כל-מצב-הקרנל נע
 * דרכו, עם cwd/db כנפילה-אחורה לתאימות-מלאה (cloud-beat/Actions בלי-ה-env). */
const DATA_DIR = process.env.SAOS_DEX_STATE_DIR
  ? path.resolve(process.env.SAOS_DEX_STATE_DIR)
  : path.join(process.cwd(), "db");
const SNAPSHOT_FILE = path.join(DATA_DIR, "state-snapshot.json");
const TAPE_FILE = path.join(DATA_DIR, "tape.jsonl");

function sysNonce(st: DexState, tag: string): string {
  // FIX(SETTLE-7): אפס-Math.random — ה-nonce נכנס ל-st.nonces ולכן ל-stateRoot.
  // רנדומיות-כאן שברה את טענת-הריפליי-הדטרמיניסטי (אותה-רצפת-ops לא-שחזרה את
  // אותו-שורש). tag ייחודי-פר-סוג-פעולה + height מונוטוני + אורך-החלון =
  // ייחודיות מלאה בלי-מקריות.
  return `${tag}-${st.height}-${st.nonces.length}`;
}

function pushReceipt(rt: ChainRT, kind: string, payload: unknown): ReceiptInfo {
  const prev = rt.lastReceiptDigest; // FIX(SETTLE-7): לוכדים את ה-prev לפני-שהוא נדרס — התנאי-הישן (rec.digest===digest) היה תמיד-אמת והעמודה ב-DB נשארה null-תמיד
  const digest = sha256(canon({ kind, payload, prev }));
  const rec: ReceiptInfo = { kind, digest, at: Date.now() };
  rt.receipts.unshift(rec);
  rt.receipts = rt.receipts.slice(0, 40);
  rt.lastReceiptDigest = digest;
  void db.evidenceReceipt.create({
    data: { kind, digest, prevDigest: prev, payload: canon(payload).slice(0, 4000) },
  }).then(() => { rt.dbOk = true; }).catch(() => { rt.dbOk = false; });
  return rec;
}

/* FIX(Roast-65-a · HIGH-4): טעינת-תמונת-מצב עם אימות-שלמות fail-closed.
 * הישן: אימות-צורה-בלבד (version/height/pools) · פיוס שכתב st.locked בשקט ("מתקן
 * במקום למות") · כישלון-קריאה = טיהור-כל-ראיות-ה-DB וג'נזיס-חדש (fail-destructive).
 * עכשיו: שלוש-תוצאות — "loaded" (אומתה מול stateRoot-ב-DB) · "absent" (אין-קובץ
 * כלל — ג'נזיס-לגיטימי רק אם-אין-עדויות-קודמות) · "corrupt" (קיימת-ושבורה —
 * דחיית-טעינה + HALT רועש, אף-ראיה לא נמחקת, אף-ג'נזיס לא נכפה). */
const ESCROW_DUST_MU = 100; // אבק-פיוס: שאריות-floor של-notional (< 1µ-פר-רגל) — מתחתיו פיוס-שקט מוצדק

/** FIX(Roast-65 · corroboration-birth): העוגן-החיצוני-האחרון — קריאת-state/anchors.json
 * (הרשומות-המאומתות-על-השרשראות-הציבוריות: STEEM/SOL/ETH — txid+stateRoot). זו-הראיה
 * הציבורית-החזקה-ביותר לשלמות-השרשרת כשהשכבה-המקומית-טרם-נולדה.
 * הערה: תיקון-נתיב — העוגנים-חיים-ב-state/-של-ה-relay (לא db/ — שם-רק-תמונת-המצב). */
function readLatestAnchoredSeal(): { height: number; stateRoot: string; chain: string; txid: string } | null {
  const candidates = [
    path.join(process.cwd(), "state", "anchors.json"),
    path.join(DATA_DIR, "anchors.json"),
  ];
  for (const p of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf8")) as {
        records?: Array<{ chain: string; height: number; stateRoot: string; txid: string; status: string }>;
      };
      const recs = (raw.records ?? []).filter((r) => r.status === "anchored" || r.status === "verified");
      if (recs.length === 0) continue;
      const best = recs.reduce((a, b) => (b.height > a.height ? b : a));
      return { height: best.height, stateRoot: best.stateRoot, chain: best.chain, txid: best.txid };
    } catch { continue; }
  }
  return null;
}
async function loadSnapshot(rt: ChainRT): Promise<"loaded" | "absent" | "corrupt"> {
  let raw: { version: number; state: DexState } | null = null;
  try {
    raw = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8")) as { version: number; state: DexState };
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return "absent"; // אין-תמונה כלל — לא שחיתות
    console.error(`[saos-dex][ALERT] SNAPSHOT UNREADABLE (bitrot/partial JSON?) — refusing load, evidence untouched: ${(e as Error)?.message ?? e}`);
    return "corrupt";
  }
  if (!(raw?.version === rt.version && raw?.state?.height > 0 && raw.state.pools && raw.state.balances)) {
    console.error("[saos-dex][ALERT] SNAPSHOT SHAPE INVALID — refusing load, evidence untouched (was: silent genesis + evidence purge)");
    return "corrupt";
  }
  // ── אימות-שלמות מול-DB: stateRoot(המצב-הנטען) חייב להיות בדיוק ה-stateRoot שנחתם
  // ל-blockHeader בגובה-זה. בלי-זה, תמונה-שבורה-חלקית (bitrot/כתיבה-קרועה) הייתה נטענת
  // וממשיכה לחתום על מצב-זר — והפיוס היה "מתקן" ערבויות בשקט.
  let dbRoot: string | null = null;
  try {
    const hdr = await db.blockHeader.findUnique({ where: { height: raw.state.height }, select: { stateRoot: true } });
    dbRoot = hdr?.stateRoot ?? null;
  } catch { dbRoot = null; }
  let claimedRoot: string | null = null;
  try { claimedRoot = stateRoot(raw.state); } catch (e) {
    console.error(`[saos-dex][ALERT] SNAPSHOT STATE UNCANONICAL (stateRoot throws) — refusing load: ${(e as Error)?.message ?? e}`);
    return "corrupt";
  }
  let acceptedWithoutCorroboration = false; // FIX(Roast-65 · corroboration-birth)
  if (!dbRoot) {
    // ── FIX(Roast-65 · corroboration-birth): פער-מערכתי-מוצהר-פעם-אחת ──
    // שכבת-שיתוף-ה-DB (blockHeader-פר-בלוק) נולדה-עכשיו (65-a HIGH-4) — היא לא הייתה
    // קיימת-בטבלה (db:push-מעולם-לא-רץ-על-הסכמה-זו) וכל-הכתיבות נכשלו-בשקט 10-שעות
    // (catch→dbOk=false). אפס-שורות = הפער מוכח-מערכתי (לא-שחיתות-גובה-בודד).
    // קבלה-חד-פעמית רק-אם-ארבעת-האילוצים-מתקיימים; החל-מהבלוק-הראשון-החדש שורה-
    // ראשונה-נכתבת-והנתיב-משתתק-לנצח (self-disabling). אין-זיוף-היסטוריה — יש-קבלה
    // גלויה-מקבלת-סיכון-חסום: ≤חלון-חותם-אחד (12) מעבר-לעוגן-ציבורי + ביקורת-שימור.
    let priorCount = -1;
    try { priorCount = await db.blockHeader.count(); } catch { priorCount = -1; }
    const extAnchor = readLatestAnchoredSeal();
    const anchorH = extAnchor?.height ?? -1;
    // FIX(Roast-65 · reorg-accept): הפער-חייב-להיות-בתוך-חלון-חותם-אחד — בשני-הכיוונים.
    // מאחורי-העוגן (snapshot < anchor) = ריאורג-כן-מוצהר: השרשרת בונה-מחדש-את-הבלוקים
    // שמעבר-לתמונה; קצה-העוגן-הקודם-נשאר-היסטוריה-ציבורית-של-טיפ-נטוש.
    const gap = raw.state.height - anchorH;
    const withinWindow = anchorH > 0 && Math.abs(gap) <= SEAL_EVERY;
    // FIX(Z-22 · anchorless-birth · 2026-09-30): the fleet anchor rail has never
    // anchored a seal (public mirror evidence: anchored=0, lastTxid=null — measured
    // in Console/dex/relay.json + world.json), so anchorH is -1 and `withinWindow`
    // was unsatisfiable BY CONSTRUCTION. As shipped, the birth acceptance bricked
    // every fresh runner: 12 consecutive failed beats since Roast-65 landed
    // (2026-09-29 19:01 → 09-30 15:45) — the public book froze at h91709.
    // The bounds that remain are the ones that matter: snapshot shape + canonical
    // stateRoot + conservation ledger-audit inside every seal + the first block
    // writes a real DB header (this path goes quiet from block one onward).
    // If the rail anchors again later, the windowed path (honest-reorg doctrine)
    // applies exactly as written — nothing here weakens it.
    const anchorlessBirth = anchorH === -1;
    if (priorCount === 0 && (withinWindow || anchorlessBirth)) {
      console.warn(`[saos-dex][ALERT] BOOT-ACCEPTANCE (corroboration-layer birth): no local blockHeaders EVER (0 rows)${anchorlessBirth
        ? ` — and NO publicly-anchored seal exists anywhere (the fleet anchor rail has anchored 0 seals; the committed snapshot in the sovereign repo is the strongest evidence in existence)`
        : ` — snapshot h${raw.state.height} vs last PUBLICLY-anchored seal h${anchorH} (${extAnchor!.chain} txid ${String(extAnchor!.txid).slice(0, 12)}…, stateRoot ${String(extAnchor!.stateRoot).slice(0, 12)}…) — gap ${gap > 0 ? "+" : ""}${gap} blocks${gap < 0 ? " — HONEST REORG: rebuilding blocks ahead of the snapshot; the prior anchored tip stays public history of an abandoned tip" : ""}`}. Trust bounded: shape + canonical stateRoot + conservation audit + ≤${SEAL_EVERY}-window doctrine once the rail anchors. From the next block onward every block writes a real DB header and this path is dead.`);
      pushReceipt(rt, "boot-acceptance-corroboration-birth", { snapshotH: raw.state.height, anchoredH: anchorH, anchor: anchorlessBirth ? "none" : extAnchor!.chain, txid: anchorlessBirth ? "none" : extAnchor!.txid, gap, at: Date.now() });
      acceptedWithoutCorroboration = true;
    } else {
      // ── FIX(recovery-continuation · Task 22 · 2026-10-20) ──
      // הצורה-שנמדדה: עץ-האטימה משוחזר-מגיט עם snapshot-בגובה-ההולדה בעוד-ה-DB
      // מכיל שרשרת-הדרק-רצופה שנבנתה ממנו (birth-acceptance הוכיחה את-הקשר
      // בעת-השחזור עצמו). הדחייה-העיוורת לבנה כל-אתחול-אחרי-שחזור.
      // הקבלה-החדשה חסומה-קשית: (1) ה-DB רצוף-החל מ-snapshot.height+1
      // (אין-פערים — count == max-min+1), (2) עקביות-שושלת: blockHashes[0]
      // של חלון-החותם-הראשון == hash-כותרת-הגובה-הראשון, (3) שורות-הנגזרת
      // שמעבר-ל-snapshot נמחקות-בגלוי (קבלה-בלי-זה הייתה מתנגשת בכתיבות
      // גובה-כפול ומשאירה dbOk=false בשקט) — ספירה-מדויקת בקבלה + גיבוי
      // מפעיל חוץ-בנדיבי. עצמית-מגבילה: היא נדלקת רק-כשהקובץ מאחורי-ה-DB.
      let recovery = false;
      try {
        const agg = await db.blockHeader.aggregate({ _min: { height: true }, _max: { height: true }, _count: { _all: true } });
        const minH = agg._min.height ?? -1;
        const maxH = agg._max.height ?? -1;
        const cnt = agg._count._all ?? 0;
        const contiguous = minH === raw.state.height + 1 && cnt === maxH - minH + 1 && maxH > minH;
        if (contiguous) {
          let lineage = false;
          try {
            const hdr0 = await db.blockHeader.findUnique({ where: { height: minH }, select: { hash: true } });
            const seal0 = await db.sealRecord.findFirst({ where: { fromHeight: minH }, orderBy: { createdAt: "asc" } });
            const note = seal0?.note ? (JSON.parse(seal0.note) as { blockHashes?: string[] }) : null;
            lineage = !!(hdr0?.hash && note?.blockHashes?.[0] === hdr0.hash);
          } catch { lineage = false; }
          if (lineage) {
            const delH = await db.blockHeader.deleteMany({ where: { height: { gte: minH } } });
            const delS = await db.sealRecord.deleteMany({ where: { fromHeight: { gte: minH } } });
            console.warn(`[saos-dex][ALERT] BOOT-ACCEPTANCE (recovery-continuation): snapshot h${raw.state.height} = parent state of the contiguous DB lineage h${minH}..h${maxH} (${cnt} headers, first-seal lineage verified) — derivative ahead-evidence rebuilt: blockHeaders=${delH.count}, sealRecords=${delS.count}. Loud, bounded, lineage-proven.`);
            pushReceipt(rt, "boot-acceptance-recovery-continuation", { snapshotH: raw.state.height, dbMin: minH, dbMax: maxH, headers: cnt, purgedHeaders: delH.count, purgedSeals: delS.count, at: Date.now() });
            recovery = true;
          }
        }
      } catch (e) {
        console.error(`[saos-dex][ALERT] recovery-continuation probe failed (${(e as Error)?.message ?? e}) — falling through to refusal`);
      }
      if (!recovery) {
        console.error(`[saos-dex][ALERT] SNAPSHOT h${raw.state.height} HAS NO DB blockHeader TO CORROBORATE (DB down or evidence gap; priorCount=${priorCount}, anchorH=${anchorH}) — refusing load, evidence untouched`);
        return "corrupt";
      }
      acceptedWithoutCorroboration = true;
    }
  }
  if (!acceptedWithoutCorroboration && dbRoot !== claimedRoot) {
    console.error(`[saos-dex][ALERT] SNAPSHOT INTEGRITY FAILURE at h${raw.state.height}: stateRoot(loaded)=${claimedRoot.slice(0, 16)}… ≠ DB=${dbRoot!.slice(0, 16)}… — refusing load, evidence untouched (operator: explicit reset is the recovery path)`);
    return "corrupt";
  }
  rt.st = raw.state;
  // ── FIX(R46-b · ratchet-truth, regenesis-proof · T15 2026-10-11) ──
  // השיא-ההיסטורי הגיט-מוכח של treasuryProfit הוא 213752µ (Console@4ac9369, 2026-09-17,
  // dex/world.json@h~17000) — היתרה מאז נוקזה לדלק-סולם/גז (זהו תפקידה: יתרה-עובדת).
  // מונה-הצבירה-לנצח לא יכול להתחיל מהיתרה-הנוכחית כי אז היה שוכח את מה
  // שכבר נצבר; הוא גם לא יכול להתחיל מאפס כי אז A38 היה נכשל עד שהמצטבר-מחדש
  // יעבור את ההיסטוריה. הזרע = חסם-תחתון אמיתי: המאזן הגבוה שהושג אי-פעם (גיט-מוכח).
  // הבאג-שנמדד: הזרע-המקורי ירה רק-כשהשדה חסר/לא-מספר — אבל הגרעין
  // מאתחל treasuryProfitEver:0 (kernel genesis) והרג'נזיס-הגיט-מוכחת
  // (Console world.json: h186399@2ba457186 10-10T06:28Z → h8641@423800931
  // 10-10T14:49Z — השרשרת נולדה-מחדש) החזירה את השדה ל-0-תקין. מאז המונה
  // צומח-אורגנית (72000µ) והזרע לעולם לא ירה → A38 אדום בציבור (truth-gate
  // 38178302247, agent-verify 48/51). הכוונה-המקורית (kernel.ts:675 "בטעינת-
  // תמונה-חיה הזרע ההיסטורי מוחל ב-chain.ts") דורשת רצפה-קבועה: המונה-המונוטוני
  // מייצג צבירה-מאז-לעולם כולל-היסטוריה-טרום-רג'נזיס, וההיסטוריה גיט-מוכחה
  // (265929µ בעת-הרג'נזיס ≥ 213752µ השיא-מוכח). לכן: max-floor לא-מותנה
  // בכל-טעינה — לא הטבעה, לא זיוף: שחזור-חוק-מתועד מראיה-גיט, בקול-רם.
  {
    const HISTORIC_HIGH_WATER = 213752; // git-proven (Console@4ac9369, 2026-09-17)
    if (
      typeof rt.st.treasuryProfitEver !== "number" ||
      !Number.isSafeInteger(rt.st.treasuryProfitEver) ||
      rt.st.treasuryProfitEver < HISTORIC_HIGH_WATER
    ) {
      const was = rt.st.treasuryProfitEver;
      rt.st.treasuryProfitEver = Math.max(rt.st.treasuryProfit ?? 0, HISTORIC_HIGH_WATER);
      console.warn(`[saos-dex][R46-b] ratchet floor-seed: treasuryProfitEver ${String(was)}→${rt.st.treasuryProfitEver}µ (git-proven high-water ${HISTORIC_HIGH_WATER}; pre-regenesis ever 265929µ — Console@d4d236962 h181247; regenesis h186399→h8641 2ba457186→423800931 2026-10-10)`);
    }
  }
  // ── FIX(escrow-dust) — פיוס-ערבות בעת-טעינה (עם-כנות-חדשה) ──
  // (1) נרמול: פקודות-ישנות בלי מד-נעילה מקבלות מד-נגזר (rem/notional(rem))
  for (const o of rt.st.orders) {
    if (typeof o.lockMu !== "number" || !Number.isSafeInteger(o.lockMu) || o.lockMu < 0) {
      const rem = o.amount - o.filled;
      o.lockMu = o.side === "sell" ? rem : notional(o.price, rem);
    }
  }
  // (2) נגזרת-הנעילות מכל-מקורות-האמת (פקודות + DCA + טריגרים + CoW)
  const orderLocks: Record<string, Record<string, number>> = {};
  for (const o of rt.st.orders) {
    if (!o.live) continue;
    const a = o.side === "sell" ? o.base : o.quote;
    const w = (orderLocks[o.owner] = orderLocks[o.owner] ?? {});
    w[a] = (w[a] ?? 0) + o.lockMu;
  }
  // FIX(Task 56): תוכניות-DCA וטריגרים מחזיקות-ערבות-אמת (הפקדה-מלאה) —
  // בלעדיהן כאן, הפיוס היה מוחק-את-הנעילות-שלהן בכל-טעינה = כסף-מובטח-שנעלם.
  for (const p of Object.values(rt.st.dca ?? {})) {
    if (!(p.remainingMu > 0)) continue;
    const w = (orderLocks[p.owner] = orderLocks[p.owner] ?? {});
    w[p.assetIn] = (w[p.assetIn] ?? 0) + p.remainingMu;
  }
  for (const t of Object.values(rt.st.trig ?? {})) {
    const a = t.side === "sell" ? t.base : t.quote;
    const effPx = t.limitPx > 0 ? t.limitPx : t.triggerPx;
    const mu = t.side === "sell" ? t.amountMu : notional(effPx, t.amountMu);
    if (!(mu > 0)) continue;
    const w = (orderLocks[t.owner] = orderLocks[t.owner] ?? {});
    w[a] = (w[a] ?? 0) + mu;
  }
  // FIX(Roast-64 · cow-escrow-wipe): הפיוס התעלם מנעילות-הזמנות-CoW-פתוחות —
  // בתסריט-המצב-היחיד-שהותיר-אותן-חיות (חור-באמצע-סליקה) הפיוס היה מוחק
  // את-הערבות → כסף-מובטח-נעשה-זמין → בסליקה addLock(-) → נעילה-שלילית → HALT.
  // FIX(Roast-65-a · HIGH-4): נרמול-ה-cow-loop — lockMu חסר/NaN לא נכנס לנגזרת
  // (היה-מצטבר כמו-שהוא → נעילה-רעילה → CanonicalError). חסר = דילוג + לוג-רועש:
  // הפער ייתפס-בכנות בפיוס-למטה/בביקורת — לא ינורמל בשקט.
  for (const o of rt.st.cow ?? []) {
    if (typeof o.lockMu !== "number" || !Number.isSafeInteger(o.lockMu) || o.lockMu < 0) {
      console.error(`[saos-dex][ALERT] cow order seq=${o.seq} of ${o.owner} has corrupt lockMu=${String(o.lockMu)} — excluded from derived escrow (loud, fail-closed)`);
      continue;
    }
    const a = o.side === "sell" ? o.base : o.quote;
    const w = (orderLocks[o.owner] = orderLocks[o.owner] ?? {});
    w[a] = (w[a] ?? 0) + o.lockMu;
  }
  // (3) פיוס-כנה: הישן שכתב st.locked לנגזרת בכל-פער ("הרקונסיליאטור שמתקן במקום
  // למות"). עכשיו: אבק (≤ESCROW_DUST_MU) מכוון-בשקט-מוצדק; פער-מעבר-לאבק נשמר
  // כפי-שהוא (לא-נשכתב!) עם-לוג-רועש + קבלה — הביקורת תיתן-את-פסק-הדין; שדה-שקול-
  // מושחת (שלילי/לא-שלם) מתוקן-רק-אז (זה-היחיד שהוכח-שבור).
  const reconciled: string[] = [];
  const preserved: string[] = [];
  for (const [who, wallet] of Object.entries(rt.st.locked)) {
    for (const a of Object.keys(wallet)) {
      const stored = wallet[a];
      const target = orderLocks[who]?.[a] ?? 0;
      if (stored === target) continue;
      if (!Number.isSafeInteger(stored) || stored < 0) {
        reconciled.push(`${who}.${a}:corrupt(${stored})→${target}`);
        wallet[a] = target;
      } else if (Math.abs(stored - target) > ESCROW_DUST_MU) {
        preserved.push(`${who}.${a}:stored ${stored} ≠ derived ${target} (Δ${stored - target}) — preserved, not rewritten`);
      } else {
        reconciled.push(`${who}.${a}:${stored}→${target}`);
        wallet[a] = target;
      }
    }
  }
  if (reconciled.length > 0) {
    console.info(`[saos-dex] escrow reconcile on load: ${reconciled.join(", ")}`);
    pushReceipt(rt, "escrow-reconcile", { fixed: reconciled, at: Date.now() });
  }
  if (preserved.length > 0) {
    console.error(`[saos-dex][ALERT] ESCROW MISMATCH BEYOND DUST ON LOAD (preserved, not silently rewritten — Roast-65-a HIGH-4): ${preserved.join(" · ")}`);
    pushReceipt(rt, "escrow-preserved", { preserved, at: Date.now() });
  }
  // ── FIX(T36 · escrow-phantom-trim): חותך-ערבות-פנטום-בטעינה ──
  // נמדד-חי (run 38579784203 · h151812 · trace 1a13ab785610d611): פקודה-חיה-אחת
  // של-האוצר נועלה 1,003,213µ מול-יתרה 1,000,164µ (avail=−3049) — ההצבה-הייתה
  // חוקית-בשעתה (השומר-מודד-מול-ה-avail-האמיתי) ויתרת-הארנק נחתכה-אחרי-ההצבה
  // (חיוב-שלא-מכבד-נעילות-קודמות; משמעת-החיוב-הקרנלית=T37-בתור). הביקורת-בחותם
  // עוצרת-בכנות (HALT) — אך-המצב-המפורסם-נושא-את-הפנטום, וכל-טעינה-הייתה-חותמת
  // שוב-על-לדגר-שבור. החוק: אם-avail<0 ולבעלים-יש-פקודות-חיות-משלו — הנעילה
  // פנטום שמאחוריו-לא-היה-כסף-מעולם: פקודות-הבעלים-עצמו מבוטלות-דטרמיניסטית
  // (הנעילה-הגדולה-ראשונה; שובר-שוויון: seq-עולה) עד-ש-avail≥0. אפס-המצאת-
  // כסף — הפקודה-מבוטלת ולא-היתרה-מנופחת. אם-גם-אחרי-מיצוי-פקודות-הבעלים
  // עדיין-שלילי — לא-נוגעים (נעילות-תוכניות-DCA/טריגר/CoW) — הביקורת-תיתן-את-
  // פסק-הדין. אידמפוטנטי: טעינה-שנייה על-מצב-נקי היא-no-op.
  {
    const trims: string[] = [];
    const liveByOwner = new Map<string, typeof rt.st.orders>();
    for (const o of rt.st.orders) {
      if (!o.live) continue;
      let bucket = liveByOwner.get(o.owner);
      if (!bucket) { bucket = []; liveByOwner.set(o.owner, bucket); }
      bucket.push(o);
    }
    for (const [who, wallet] of Object.entries(rt.st.balances)) {
      for (const [a, v] of Object.entries(wallet)) {
        let deficit = v - (rt.st.locked[who]?.[a] ?? 0);
        if (deficit >= 0) continue;
        const own = (liveByOwner.get(who) ?? [])
          .filter((o) => (o.side === "sell" ? o.base : o.quote) === a)
          .sort((x, y) => (y.lockMu ?? 0) - (x.lockMu ?? 0) || x.seq - y.seq);
        for (const o of own) {
          if (deficit >= 0) break;
          const released = typeof o.lockMu === "number" && o.lockMu > 0 ? o.lockMu : 0;
          o.live = false;
          o.lockMu = 0;
          const lk = (rt.st.locked[who] = rt.st.locked[who] ?? {});
          lk[a] = (lk[a] ?? 0) - released;
          deficit += released;
          trims.push(`${who}.${a}:order#${o.seq} voided (released ${released}µ phantom lock)`);
        }
      }
    }
    if (trims.length > 0) {
      console.error(`[saos-dex][ALERT] ESCROW-PHANTOM TRIM ON LOAD (T36): ${trims.join(" · ")}`);
      pushReceipt(rt, "escrow-trim", { trimmed: trims, atH: rt.st.height, at: Date.now() });
    }
  }
  // ── FIX(Roast-65 · drift-declaration): הצהרת-סחיפה-היסטורית — מוצהר-ולא-מוסתר ──
  // אחרי-טעינה-מאומתת (stateRoot===DB) ופיוס-הערבויות: אם ביקורת-השימור נכשלת,
  // הפערים מוצהרים-פעם-אחת בתוך-המצב-הקנוני (auditAdjustments) עם-מספרים-מדויקים
  // ביומן-ובלוג-רועש. המבקר (settle.ledgerAudit) כולל-את-ההצהרה; סחיפה-חדשה-מעבר-
  // להצהרה = כשל-ביקורת = HALT-בחותם (HIGH-2). אם-גם-אחרי-ההצהרה הביקורת-אדומה —
  // המצב-שבור-מעבר-לסחיפה-היסטורית → דחיית-טעינה (corrupt), אף-ראיה לא נמחקת.
  {
    const { ledgerAudit, genesisTotals } = await import("./settle");
    const pre = ledgerAudit(rt.st, genesisTotals());
    if (!pre.ok) {
      const adj = rt.st.auditAdjustments ?? (rt.st.auditAdjustments = {
        note: "historical conservation drift from the pre-fix era (roast-63/64 bugs) — declared, not hidden; any NEW drift beyond this declaration halts at seal (65-a HIGH-2)",
        atH: rt.st.height,
        native: {}, lp: {}, feesSpentMu: 0,
      });
      adj.atH = rt.st.height;
      const details: string[] = [];
      for (const row of pre.assets) {
        if (row.ok) continue;
        const d = row.live - row.expected;
        if (row.kind === "lp") {
          const key = row.asset.slice(3);
          adj.lp = adj.lp ?? {}; adj.lp[key] = (adj.lp[key] ?? 0) + d;
          details.push(`lp:${key}=${d > 0 ? "+" : ""}${d}`);
        } else {
          adj.native = adj.native ?? {}; adj.native[row.asset] = (adj.native[row.asset] ?? 0) + d;
          details.push(`${row.asset}=${d > 0 ? "+" : ""}${d}`);
        }
      }
      if (!pre.credits.ok) {
        // OWNER-MANDATE 2026-10-17 · הצהרת-עידן-דלק: הג'נזיס נולד-מחדש בלי-החיילים
        // (פקודת-בעלים: סוכנים-סינתטיים-חסרי-מפתח סולקו) — פער-בסיס-הדלק מוצהר-פעם-אחת
        // במצב-הקנוני (creditsMu) עם-המספרים-המדויקים; סחיפה-חדשה-מעבר-להצהרה = HALT.
        const dC = pre.credits.sum + pre.credits.gasUsed - pre.credits.minted - pre.credits.expected;
        adj.creditsMu = (adj.creditsMu ?? 0) + dC;
        details.push(`credits+=${dC > 0 ? "+" : ""}${dC} (credits-law era gap — soldier-genesis baseline, declared)`);
      }
      if (!pre.fees.ok) {
        // הצהרה-על-ההיסטוריה — FIX(3-a · D1 · sign-lineage-coherence): הזהות-המתוקנת
        // היא pools === meter+profit+minted+spent (עמלות-שהראוטר-צרך זרמו-לבריכות —
        // נזקפות, לא-מנוכות; ראה-הערת-המבקר ב-settle.ts). דלי-ההצהרה חייב להיגזר
        // מאותה-זהות: spent_הכולל-הדרוש = pools − feeMeterPlusProfit (השדה
        // feeMeterPlusProfit כבר-כולל-את-feeMinted — ראה-הערת-המבקר ב-settle.ts), ולכן
        // Δ = pools − (feeMeterPlusProfit + spent_הנמדד-הכולל). הערך-החתום-יכול-להיות-
        // שלילי: זו-הצהרה-כנה על פער-היסטורי מהעידן-שלפני-התיקונים בשני-הכיוונים
        // (עמלות-פנטום-בבריכות או עמלות-שנעלמו). BOOK-TAKER-FEE: מקור-הספר נכלל-בצד-המדידה.
        const delta = (pre.fees.poolsTreasury + pre.fees.bookFeesMu) - (pre.fees.feeMeterPlusProfit + pre.fees.feesSpentMu);
        adj.feesSpentMu = (adj.feesSpentMu ?? 0) + delta;
        details.push(`feesSpent+=${delta > 0 ? "+" : ""}${delta} (historical fees-lineage gap, declared)`);
      }
      const post = ledgerAudit(rt.st, genesisTotals());
      if (!post.ok) {
        console.error(`[saos-dex][ALERT] LEDGER BROKEN BEYOND DECLARABLE DRIFT at h${rt.st.height}: ${[...post.errors, ...post.negatives].slice(0, 3).join(" | ")} — refusing load, evidence untouched`);
        return "corrupt";
      }
      rt.st.journal.push({
        h: rt.st.height, t: 0, soldier: "treasury", action: "audit_adjustment_declared", profitMu: 0,
        note: `drift-declaration @h${rt.st.height}: ${details.join(" · ")} — מוצהר-במצב-הקנוני; סחיפה-חדשה=HALT`,
      });
      pushReceipt(rt, "drift-declared", { details, atH: rt.st.height, at: Date.now() });
      console.warn(`[saos-dex][ALERT] HISTORICAL DRIFT DECLARED at h${rt.st.height}: ${details.join(" · ")} — declared in canonical state (not hidden); new drift beyond declaration = HALT at seal`);
    }
  }
  // ── FIX(Roast-68 · pol-retro-mint): הפנטום-הג'נזיס הופך-עמדת-POL-גלויה-וכנה ──
  // עד-היום: implied = pool.lp − Σbal(LP|) = ג'נזיס+מוצהר — נזילות-זרע "ששייכת-לאף-אחד"
  // (85%/76%/100% מהבריכות-העיקריות): לא-מרוויחה-עמלות, לא-ניתנת-למימוש, ומרמה-את-מד-התשואה
  // (lpYieldBps-מחושב-מול-pool.lp-כולל-הפנטום → תשואת-LP-חוץ-נראית-קטנה-מהאמת).
  // מעתה-פעם-אחת: האוצר-מקבל-את-ה-implied כ-LP-אמת — עמדת-POL כנה שמרוויחה-עמלות-פרו-רטה —
  // והביקורת-מחמירה: implied חייב-0-לנצח; כל-חצי-פעולה-עתידית (מונה-בלי-יתרה או יתרה-בלי-מונה)
  // נתפסת-מיד-בחותם (HALT). אחרי-הצהרת-הסחיפה-ולפני-החזרה — הביקורת-חייבת-ירוקה-אחרת-דחייה.
  if (rt.st.polRetroMint !== true) {
    const { ledgerAudit, genesisTotals } = await import("./settle");
    const totals = genesisTotals();
    const adj = rt.st.auditAdjustments ?? (rt.st.auditAdjustments = {
      note: "historical conservation drift from the pre-fix era (roast-63/64 bugs) — declared, not hidden; any NEW drift beyond this declaration halts at seal (65-a HIGH-2)",
      atH: rt.st.height,
      native: {}, lp: {}, feesSpentMu: 0,
    });
    adj.atH = rt.st.height;
    const details: string[] = [];
    for (const [key, p] of Object.entries(rt.st.pools)) {
      const asset = LP_ASSET_PREFIX + key;
      let sumBal = 0;
      for (const wallet of Object.values(rt.st.balances)) sumBal += Number(wallet[asset] ?? 0);
      const implied = p.lp - sumBal;
      if (implied === 0) continue;
      // הטבעת-LP-לאוצר + כיול-הצפוי-במבקר-לאפס (הפנטום-מגולם-עתה-כעמדת-POL-אמת)
      const w = rt.st.balances.treasury ?? (rt.st.balances.treasury = {});
      w[asset] = (w[asset] ?? 0) + implied;
      adj.lp = adj.lp ?? {}; adj.lp[key] = -(totals.poolsLp[key] ?? 0);
      details.push(`${key}:+${implied}`);
    }
    rt.st.polRetroMint = true;
    const post = ledgerAudit(rt.st, genesisTotals());
    if (!post.ok) {
      console.error(`[saos-dex][ALERT] POL-RETRO-MINT BROKE THE AUDIT at h${rt.st.height}: ${[...post.errors, ...post.negatives].slice(0, 3).join(" | ")} — refusing load, evidence untouched`);
      return "corrupt";
    }
    if (details.length > 0) {
      rt.st.journal.push({
        h: rt.st.height, t: 0, soldier: "treasury", action: "pol_retro_mint", profitMu: 0,
        note: `pol-retro-mint @h${rt.st.height}: ${details.join(" · ")} — פנטום-הג'נזיס הוטבע כעמדת-POL של האוצר; implied=0 לנצח`,
      });
      pushReceipt(rt, "pol-retro-mint", { details, atH: rt.st.height, at: Date.now() });
      console.warn(`[saos-dex][ALERT] POL RETRO-MINT at h${rt.st.height}: ${details.join(" · ")} — genesis phantom LP minted to treasury as explicit POL; audit tightened: implied must be 0 forever`);
    }
  }
  return "loaded";
}

function flushSnapshot(rt: ChainRT): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = SNAPSHOT_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ version: rt.version, savedAt: new Date().toISOString(), state: rt.st }));
    fs.renameSync(tmp, SNAPSHOT_FILE);
    // טייפ: שמירת-זנב-סליל (מורשת WINDOW_FLUSH של grid98)
    fs.writeFileSync(TAPE_FILE, rt.tape.slice(0, 300).map((e) => JSON.stringify(e)).join("\n"));
    // Task 83 · הנרות-נצמדים-לגיט באותה-קדנס (db/klines.json — נעקב ב-.gitignore-חריג)
    klinesFlush();
    // EXEC-CD-8 · ייחוס-המייקרים-נצמד-לגיט באותו-קדנס (db/maker-stats.json — חריג-גיט)
    makerFlush();
    // EXEC-CD-9 · מד-גז-הספר-נצמד-לגיט באותו-קדנס (db/book-gas.json — חריג-גיט)
    bookGasFlush();
  } catch { /* כשל-כתיבה לא מפיל את השרשרת */ }
}

/** seal — חותם-קיבוצי כל-12 בלוקים: שורש-מרקל על hashי-הבלוקים + stateRoot קנוני.
 * SECURITY INTENT: החותם הוא העדות-הקריפטוגרפית היחידה שיוצאת מהמערכת —
 * כל-hash-בלוק בחלון נכלל בשורש (מרקל), וה-stateRoot מחייב את מצב-העולם המלא.
 * כל-שינוי-בדיעבד בבלוק או במצב = שורש אחר = גילוי מיידי באימות-עצמאי.
 * הסדר קריטי: קבלה ל-DB → ואז relaySeal (לעולם לא-חוסם, לא-זורק — כשל-Relay
 * אינו רשאי להפיל את השרשרת, ואילו כשל-DB מסומן dbOk לתצפית).
 */
async function seal(rt: ChainRT, blockRoot: string): Promise<void> {
  const st = rt.st;
  if (rt.blockHashes.length === 0) return;
  // FIX(Roast-65-a · HIGH-2): ביקורת-השימור רצה-עתה בתוך-החותם, לפני-כל-פרסום.
  // הישן: invariant() נקרא רק בנתיבי-ספר/בריכה (טענות-צרות) ו-ledgerAudit רץ רק ב-GET
  // /settle ו-/metrics (דוחות-קריאה עם-cache) — השרשרת הייתה ממשיכה לחתום 12-בלוקים-
  // חותמות "תקינות" על מצב-מנופח ושרשרת-העדויות כולה מאמתת את השקר. עכשיו: !ok =
  // InvariantViolation → HALT עם-פסק-דין-פורנזי (אין-חותמות-שלמות על-לדגר-שבור).
  // ייבוא-דינמי — settle.ts מייבא-מ-chain.ts (getWallets) ואנחנו לא יוצרים-מעגל-סטטי.
  const { ledgerAudit, genesisTotals } = await import("./settle");
  const audit = ledgerAudit(st, genesisTotals());
  if (!audit.ok) {
    const forensic = [...audit.errors, ...audit.negatives].slice(0, 3).join(" | ") || "unknown";
    throw new InvariantViolation(`ledger-audit-failed@seal h${st.height}: ${forensic}`);
  }
  const root = merkleRoot(rt.blockHashes);
  const info: SealInfo = {
    fromHeight: st.height - rt.blockHashes.length + 1,
    toHeight: st.height,
    root, stateRoot: stateRoot(st),
    leaves: rt.blockHashes.length,
    at: Date.now(),
    digest: "",
    // FIX(Roast-65-a · MED-7): החלון-החתום עצמו — העדות למה שהשורש מחייב (היה-רק count)
    blockHashes: [...rt.blockHashes],
  };
  info.digest = sha256(canon(info));
  /* ── Formal Assertions (Fail-Fast) — חוקי-הברזל לפני-פרסום-החותם ──
   * החותם הוא העדות-הקריפטוגרפית היוצאת-מהמערכת; אי-עקביות בין החלון,
   * שורש-המרקל וה-stateRoot = עדות-שקרית בפוטנציה. הבדיקות מתבצעות לפני
   * כל-פרסום (מדדים/DB/Relay) — ומפרסמות fail-closed: אם אחת-מהן נופלת,
   * שום-דבר לא יוצא, חלון-הבלוקים נשמר, והחותם-הבא ינסה-שוב (ריפוי-עצמי). */
  // (1) החלון מכסה בדיוק את טווח-הגבהים הרציף שהחותם מצהיר עליו
  invariant(info.toHeight - info.fromHeight + 1 === rt.blockHashes.length, "seal-window-contiguity");
  // (2) שורש-המרקל אכן נגזר מhashי-הבלוקים שבחלון (עדות-מחייבת את הבלוקים עצמם)
  invariant(merkleRoot(rt.blockHashes) === root, "seal-merkle-root");
  // (3) FIX(SETTLE-9 perf): ה-stateRoot הקנוני מחייב את מצב-העולם שממנו נבנה הבלוק.
  // היה-פה חישוב-O(state)-מלא שני (טאוטולוגיה — אותה-פונקציה טהורה על אותו-מצב)
  // בכל-חותם. עכשיו: השוואה-מול-שורש-זמן-הבלוק שהועבר-מ-buildBlock —
  // אימות-הקפאה אמיתי (מוטציה בין-בניית-הבלוק לחותם = נפילה) בעלות-אפס.
  invariant(info.stateRoot === blockRoot, "seal-state-root");
  // (4) ה-digest אכן ההאש של תוכן-החותם עצמו (אימות-עצמי לפני-יציאה).
  // ה-digest חושב על canon(info) כאשר info.digest עוד היה "" — הבדיקה בונה
  // מחדש את אותה-צורה (בלי-ה-digest) ומשווה; הכללה-עצמית של ההאש בתוך עצמו
  // היא מתמטית-בלתי-אפשרית (נתפס-בהרצה-הראשונה — עדות-לעבודת-ה assertions).
  invariant(sha256(canon({ ...info, digest: "" })) === info.digest, "seal-digest");
  rt.seals.unshift(info);
  rt.seals = rt.seals.slice(0, 24);
  pushReceipt(rt, "seal", info);
  // FIX(Roast-65-a · LOW-9): תווית-אמת — אין-מפתחות ואין-חתימות במערכת-כולה.
  // אלו ארבעה-רישומי-ג'ורנל (attest) מאותו-תהליך-שכתב-את-השורש-עצמו — הד-פנימי,
  // לא "קוורום" ולא חתימות. נשמרים-כראית-יומן-בלבד (הערה-כנה גם-ב-note של הרישום).
  // OWNER-MANDATE 2026-10-17: עדי-החותם = סוכני-מערכת אמתיים (החיילים-הסינתטיים סולקו —
  // עדים-רפאים מחשבונות-שנמחקו זה שקר-פרסומי)
  for (const s of ["treasury", "operator", "arena"]) {
    rt.mempool.push({ type: "attest", issuer: s, nonce: sysNonce(st, `att-${s}`), claim: root.slice(0, 16) });
  }
  rt.blockHashes = [];
  try {
    await db.sealRecord.create({
      data: {
        fromHeight: info.fromHeight, toHeight: info.toHeight, root: info.root, stateRoot: info.stateRoot, leavesCount: info.leaves,
        // FIX(Roast-65-a · MED-7): החלון-החתום נשמר-ל-DB (note = JSON של העלים) —
        // שחזור-החותם אפשרי-גם-אחרי-ריסטארט (היה: החלון נעלם מיד-אחרי-החתימה)
        note: canon({ kind: "SAOS-DEX checkpoint", blockHashes: info.blockHashes }),
      },
    });
    rt.dbOk = true; // הצלחה מאשרת מחדש — הדגל לא נשאר דומם-לשלילה
  } catch { rt.dbOk = false; }
  // ── RELAY: הדלת לשרשראות-הציבוריות — לא-חוסם, לא-זורק (anchor חי ל-Steem/Hive/TRON) ──
  try {
    const relay = await import("./relay");
    relay.relaySeal(info);
  } catch { /* כשל-Relay לעולם לא מפיל את השרשרת */ }
}

/** ── SETTLE-14 PRICE-TRUTH: עדות-מחיר-אמת ──
 * כל-אירוע-מסחר אמת (fill על-הספר, swap בבריכה) נרשם: מה-נמכר, באיזה-מחיר,
 * כמה-ציטוט-זרם (muQ = amountMu×px/1000). הטוויאפ-השקול-נוטיונל הוא המדד
 * היחיד ל"מחיר-אמת" — הספר והבריכה עלולים-לצוף (וצפו — ממצא-חי +15%/+25%),
 * אבל עסקאות-שקרו-בפועל הן-העדות. חוץ-מצב (לא-בשורש) — טבעת 600. */
function feedPriceOracle(rt: ChainRT, events: TradeEvent[] | undefined, h: number): void {
  if (!events || events.length === 0) return;
  for (const ev of events) {
    if (ev.kind !== "fill" && ev.kind !== "swap") continue;
    if (!(ev.price > 0) || !(ev.amountMu > 0)) continue;
    rt.priceSamples.push({ h, base: ev.base, quote: ev.quote, px: ev.price, muQ: ev.quoteMu ?? Math.floor((ev.amountMu * ev.price) / 1000) }); // FIX(R15-a): quoteMu — משקל-ציטוט-אמת (קניות-בריכה היו ×price/1000-מנופפות)
  }
  if (rt.priceSamples.length > 600) rt.priceSamples.splice(0, rt.priceSamples.length - 600);
}

export interface PriceTruth { base: string; quote: string; twap: number; samples: number; devBpsVsRef: number; windowHeights: number }

/** טוויאפ-שקול-נוטיונל לזוג (שני-הכיוונים — base/quote או quote/base) */
export function priceTruthFor(rt: ChainRT, base: string, quote: string): PriceTruth | null {
  const st = rt.st;
  let wSum = 0, pxSum = 0, n = 0, hMin = Infinity, hMax = 0;
  for (const s of rt.priceSamples) {
    const same = s.base === base && s.quote === quote;
    const flip = s.base === quote && s.quote === base;
    if (!same && !flip) continue;
    const px = same ? s.px : Math.floor(1_000_000 / (s.px > 0 ? s.px : 1)); // יחס-הפוך: pxFlip = (1000/px)×1000 = 10^6/px
    wSum += s.muQ; pxSum += px * s.muQ; n++;
    if (s.h < hMin) hMin = s.h; if (s.h > hMax) hMax = s.h;
  }
  if (n === 0 || wSum <= 0) return null;
  const twap = Math.floor(pxSum / wSum);
  const ref = st.assets[base]?.refPrice ?? 0;
  return { base, quote, twap, samples: n, devBpsVsRef: ref > 0 ? Math.floor(((twap - ref) / ref) * 10_000) : 0, windowHeights: hMax >= hMin ? hMax - hMin + 1 : 0 };
}

function ladderCheck(rt: ChainRT): void {
  const st = rt.st;
  if (rt.pendingLift) return; // FIX(Roast-65-a · MED-6): הרמה-קודמת עוד-לא-אושרה — אין-ערימת-כוונות
  if (st.height - st.ladder.lastLiftHeight < LADDER_EVERY) return;
  /* ── SETTLE-14 PRICE-TRUTH: הסולם-כמו-שדרה (keel), לא-מדרגות ──
   * היה: newRef = ref×1.005 בלי-קשר-לשוק — מדרגות-עולות-בלבד (2500→2686
   * מונוטוני, 15-הזזות). המפעיל צדק: "מטפס-ולא-נראה-כמו-נתון-אמת".
   * עכשיו: הסולם זז רק-אחרי-עדות-מסחר-אמת (טוויאפ-מהטבעת), בשני-הכיוונים,
   * מדומם (חצי-הפער, עד-0.5%), וממשיך-לשלם-עמלות-על-כל-הזזה (harvest).
   * אין-עדות-מספקת (<40-מסחרות או |dev|<100bps) → הסולם לא-זז. */
  const truth = priceTruthFor(rt, "SAOS", "USDS");
  if (!truth || truth.samples < 40) return;
  const ref = st.ladder.refPrice;
  const devBps = truth.devBpsVsRef;
  if (Math.abs(devBps) < 100) return;
  if (st.feeMeter < st.ladder.stepCostMu) return; // עדיין-משלמים-בעמלות-אמת-על-כל-הזזה
  const dir = devBps > 0 ? 1 : -1;
  const halfDev = Math.floor(Math.abs(ref - truth.twap) / 2);
  // מדומם-חצי-פער, עד-0.5%; פער-גולמי (|dev|>1000bps — מעגן-מיושן) מותר-עד-2%
  // כדי-שהסולם-יתפוס-במהירות את-המציאות-שנצברה — באותה-מידה למעלה ולמטה.
  const capPct = Math.abs(devBps) > 1_000 ? 0.02 : 0.005;
  const step = Math.max(1, Math.min(Math.floor(ref * capPct), halfDev));
  const newRef = Math.max(1, ref + dir * step);
  const harvestMu = Math.min(st.ladder.stepCostMu, st.feeMeter);
  const harvestNonce = sysNonce(st, "harv");
  const priceNonce = sysNonce(st, "ladder");
  rt.mempool.push({ type: "harvest", issuer: "treasury", nonce: harvestNonce, amount: harvestMu, memo: `keel-${dir > 0 ? "up" : "down"}` });
  rt.mempool.push({ type: "asset_price", issuer: "treasury", nonce: priceNonce, asset: "SAOS", refPrice: newRef });
  // FIX(Roast-65-a · MED-6): הספרים לא נוגעים-כאן-עוד. הישן מוטט את st.ladder בשעת-הדחיפה
  // (refPrice/lastLiftHeight/lifts/spentMu/stats.ladders) לפני-שה-ops אושרו — אם-harvest
  // נדחה (אוצר/מד-עמלות ירדו-בין-הדחיפה לביצוע) המצב העיד הרמה-שלא-שולמה וה-op-log לא
  // משחזר אותה. עכשיו: כוונה-בלבד (rt.pendingLift) — הספרים זזים רק-אחרי-r.ok של שני-
  // ה-ops (buildBlock), ודחייה מתועדת-כנה בלי-שינוי-מצב.
  rt.pendingLift = { newRef, harvestMu, h: st.height, harvestNonce, priceNonce };
  pushReceipt(rt, "keel-intent", { height: st.height, newRef, dir, devBps, step, harvestMu, twap: truth.twap, samples: truth.samples });
}

async function buildBlock(rt: ChainRT): Promise<void> {
  const t0 = Date.now();
  const st = rt.st;
  const ops = rt.mempool.splice(0, 160);
  let applied = 0;
  let rejected = 0;
  const rejSample: string[] = [];
  // Task 83 · איסוף-אירועי-המסחר-של-הבלוק להזנת-הנרות (חוץ-מצב — אין-השפעה על-השורש)
  const blockTrades: TradeEvent[] = [];
  // EXEC-CD-9 · איסוף-שריפות-הגז-המאושרות של-הבלוק למד-המחזור (חוץ-מצב — fuel-freeze-fix)
  const appliedGas: { type: string; gas: number }[] = [];
  // FIX(Roast-65-a · MED-6): מעקב-אישור-ה-ops-של-הרמה-הממתינה (harvest + asset_price)
  let keelHarvest: boolean | null = null;
  let keelPrice: boolean | null = null;
  const trackKeel = (op: Op, ok: boolean): void => {
    if (!rt.pendingLift) return;
    if (op.nonce === rt.pendingLift.harvestNonce) keelHarvest = ok;
    if (op.nonce === rt.pendingLift.priceNonce) keelPrice = ok;
  };
  // FIX(Roast-66 · dose-truth): מעקב-תוצאות-המנות-של-המסילה (נונס rail-*) — המנה
  // נספרת-כבוצעה רק-מתוצאת-הבלוק-בפועל (היה: נספרה-בדחיפה, minOut-fail נספר-כמנה).
  const railResults: { nonce: string; ok: boolean }[] = [];
  const trackRail = (op: Op, ok: boolean): void => {
    if (op.nonce.startsWith("rail-")) railResults.push({ nonce: op.nonce, ok });
  };
  // FIX(R17-b·H3): אותו-מעקב-ל-ops-הגשר (brg-*/blo-*) — paid/locked נסגרים-על-האמת
  // (reject → היפוך-ל-pending/lock-failed + ניקוי-הרישום-הקבוע), לא-על-התור.
  const bridgeResults: { nonce: string; ok: boolean }[] = [];
  const trackBridge = (op: Op, ok: boolean): void => {
    if (op.nonce.startsWith("brg-") || op.nonce.startsWith("blo-")) bridgeResults.push({ nonce: op.nonce, ok });
  };
  for (const op of ops) {
    // FIX(Roast-65-a · MED-8): אטומיות-בלוק. הישן: זריקה-מ-applyOp באמצע-הלולאה הפילה
    // את-כל-הבלוק אחרי-שה-ops-המוקדמים כבר שינו את st — מוטציות-חיות בלי blockHash/DB,
    // 160-ה-ops נשפכו. עכשיו: try/catch-פר-op — כשל-לא-אינווריאנטי נרשם-כדחייה-כנה
    // (אותו-נתיב של-r.err) והבלוק ממשיך-שלם. InvariantViolation עדיין-זורק (HALT-מוסדי).
    let r: ReturnType<typeof applyOp>;
    try {
      r = applyOp(st, op, t0);
    } catch (e) {
      if (e instanceof InvariantViolation) throw e;
      trackKeel(op, false);
      trackRail(op, false);
      trackBridge(op, false);
      rejected++;
      if (rejSample.length < 5) rejSample.push(`${op.type}(${(op as { issuer?: string }).issuer ?? "?"}):${String(e instanceof Error ? e.message : e).slice(0, 60)}`);
      continue;
    }
    trackKeel(op, r.ok);
    trackRail(op, r.ok);
    trackBridge(op, r.ok);
    if (r.ok) {
      applied++;
      if (r.gas > 0) appliedGas.push({ type: op.type, gas: r.gas }); // EXEC-CD-9 · שריפות-מאושרות בלבד — מד-המחזור-הכנה
      for (const ev of r.events ?? []) rt.tape.unshift({ ...ev, h: st.height });
      if (r.events && r.events.length > 0) blockTrades.push(...r.events);
      feedPriceOracle(rt, r.events, st.height); // SETTLE-14: עדות-מחיר-אמת מכל-מסחר
    } else {
      // FIX(SETTLE-15 silent-drop): דחייה-שקטה הייתה-חור-תפעולי-ישן ("queued" אך-
      // נופלת-בבלוק-בלי-עדה). עכשיו: לוג-מדוד (דגימה-עד-5-פר-בלוק) — כל-דחייה
      // נראית ב-dev.log עם-הסיבה, והמונה-החי-חשוף ב-getState.rejectedLast.
      rejected++;
      // EXEC-CD-9 · פורנזי: הנונס-בדגימה — התנגשויות-replay נמדדות-ישירות מהלוג
      if (rejSample.length < 5) rejSample.push(`${op.type}(${(op as { issuer?: string }).issuer ?? "?"}):${r.err}:${String(op.nonce).slice(-24)}`);
    }
  }
  // FIX(Roast-66 · dose-truth): פיוס-המנות-של-המסילה אחרי-הבלוק (ספירה-בהצלחה-בלבד)
  if (railResults.length > 0) railReconcile(railResults);
  // FIX(R17-b·H3): פיוס-הגשר — סטטוסי-paid/locked נסגרים-מול-תוצאת-הבלוק-בפועל
  if (bridgeResults.length > 0) bridgeReconcile(bridgeResults);
  // FIX(Roast-65-a · MED-6): אישור-הספרים-רק-אחרי-ששני-ה-ops-של-הכוונה אכן היו-בבלוק
  // ואושרו. דחייה = לוג-רועש + קבלה-כנה, אפס-שינוי-ב-st.ladder (הכוונה נזרקת).
  if (rt.pendingLift && keelHarvest !== null && keelPrice !== null) {
    const pl = rt.pendingLift;
    rt.pendingLift = null;
    if (keelHarvest && keelPrice) {
      st.ladder.refPrice = pl.newRef;
      st.ladder.lastLiftHeight = pl.h;
      st.ladder.lifts++;
      st.ladder.spentMu += pl.harvestMu;
      st.stats.ladders++;
      pushReceipt(rt, "keel", { height: pl.h, newRef: pl.newRef, harvestMu: pl.harvestMu, confirmed: true });
    } else {
      console.warn(`[saos-dex][ALERT] keel lift at h${pl.h} NOT CONFIRMED (harvest=${keelHarvest} price=${keelPrice}) — ladder books untouched (Roast-65-a MED-6: no unpaid lifts in state)`);
      pushReceipt(rt, "keel-rejected", { height: pl.h, newRef: pl.newRef, harvestOk: keelHarvest, priceOk: keelPrice });
    }
  }
  if (rejected > 0) {
    rt.rejectedLast = { h: st.height, count: rejected, sample: rejSample };
    console.warn(`[saos-dex] block h${st.height}: ${rejected}/${ops.length} ops rejected — ${rejSample.join(" · ")}`);
  }
  rt.tape = rt.tape.slice(0, TAPE_CAP);
  // FIX(SETTLE-7 journal-bleed): st.journal הוא חלק-מה-DexState (ולכן מוטבע
  // בתמונת-מצב ובשורש) — attest ×4/חותם + pay/refuel/mint/relay הצטברו-לנצח
  // (זיכרון + דיסק + stateRootOf O(n) פעמיים-בבלוק). תקרה-קשה — ההיסטוריה
  // המלאה חיה ב-evidenceReceipt/arenaJournal ב-DB, לא במצב-החי.
  if (st.journal.length > 600) st.journal.splice(0, st.journal.length - 500);

  // פעימה-אוטומטית (heartbeat — מדידת-חיות על-הספר)
  applyOp(st, { type: "heartbeat", issuer: "treasury", nonce: sysNonce(st, "hb") }, t0);

  // Task 54 · הטיק-הכלכלי הקנוני: revenue-router (קנייה-ושריפה) + אפוק-פליפ-ve —
  // גובה-טריגר-טהור (אפס-שעון/רנדומליות) → ריפליי דטרמיניסטי.
  // FIX(Roast-64): nowMs מוזרק — רשומות-הג'ורנל-של-הכלכלה נושאות את-זמן-הבלוק
  // (היו t:0 — זמן-מזויף שנגל-את-חוב-ה-determinism-של-journal.t באופן-גרוע יותר).
  economyTick(st, t0);

  // Task 56 · מסחר-אוטומטי-חסר-קיפרים: DCA-פריסה + טריגרים (stop/take) —
  // בונה-הבלוקים הוא ה-keper: הטיקים מבצעים applyOp ישירות-על-המצב (אטומי,
  // סינכרוני, ללא-ממפול) והמסחר-שנוצר נכנס לטייפ ולעדות-המחיר-אמת.
  // Task 58 · ProtoRev (ארב-סוף-בלוק) + CoW (סליקת-אצווה-מחיר-אחיד) —
  // אותו-חוק: בונה-הבלוקים הוא ה-keeper/solver — אפס-תשתית-חוץ, ריפליי-אמת.
  {
    const exec = (op: Op) => applyOp(st, op, t0);
    // FIX(Roast-65-a · LOW-13): nowMs מוזרק-גם-ל-DCA/טריגרים — רישומי-הג'ורנל שלהם
    // היו t:0 (זמן-מזויף) בניגוד-לתיקון-63/64 על-שאר-הנתיבים.
    // Task 80 · THE-VAULT: סוכן-הכספת אינו-סוחר — אין-לו-אירועי-טייפ (ריבית ≠ עמלת-סוואפ).
    vaultTick(st, rt.tickCount, exec, t0);
    // R40 · THE-SAVE: דבר-גורר-דבר — פירעון-כספת באותו-בלוק מזרים ריבית-אמת
    // לחוסכים (אחרי-סוכן-הכספת, לפני-שאר-הטיקים — הזרימה נראית-בבלוק-עצמו).
    savingsTick(st, t0);
    saveDemoTick(st, rt.tickCount, exec, t0);
    // R41 · THE-VE: דבר-גורר-דבר — נעילה ← הצבעה ← אפוק-פליפ מרוקן את-קרן-ה-ve
    // לנועלים-החיים (בכל-אפוק, h%1200); האג"ח ממירה USDS-סוחר ל-SAOS-נעול — שתי
    // החוליות-האחרונות של צינור-המפקיד: הפקדה ← זיכוי ← חיסכון ← הכנסה ← פדיון
    // ← וגם: מסחר ← עמלות ← קרן ← נועלים. אותם-חוקים לכל-אחד.
    veDemoTick(st, rt.tickCount, exec, t0);
    bondDemoTick(st, rt.tickCount, exec, t0);
    // R44 · THE-MARKET: דבר-גורר-דבר — האוצר מזרים-נזילות-עודפת לבריכת-האשראי
    // (אספקה-אדפטיבית לפי-ביקוש), וחיילי-הצי לווים-ופורעים-במחזורים — הריבית
    // זורמת-לאוצר-ולמלווים ב-µ-אמת, והניצולת-החיה מזיזה-את-העקומה.
    lendTick(st, rt.tickCount, exec, t0);
    const tickEvents = [...dcaTick(st, exec, t0), ...trigTick(st, exec, t0), ...protoRevTick(st, exec, t0), ...cowSettle(st, exec, t0)];
    for (const ev of tickEvents) rt.tape.unshift({ ...ev, h: st.height });
    if (tickEvents.length > 0) blockTrades.push(...tickEvents);
    feedPriceOracle(rt, tickEvents.length > 0 ? tickEvents : undefined, st.height);
    if (tickEvents.length > 0) rt.tape = rt.tape.slice(0, TAPE_CAP);
  }

  // Task 56 · חותם-אמינות-מחיר (price-credibility seal): כל-400-בלוקים —
  // תמונת-קנונית-שלמים (mid/טוויאפ/רף/עומק-1%) נחתמת-כקבלה-משורשרת-האש
  // (חוץ-מצב — לא-נוגע-בריפליי; הראייה חיה-ב-DB-וב-/api/dex/price-proof).
  if (st.height > 0 && st.height % PRICE_SEAL_EVERY === 0) {
    const truth = priceTruthFor(rt, "SAOS", "USDS");
    const saosPool = st.pools["SAOS/USDS"];
    const mid = saosPool ? poolMid(saosPool) : 0;
    pushReceipt(rt, "price-seal", {
      h: st.height, mid, ref: st.ladder.refPrice,
      twap: truth?.twap ?? 0, twapSamples: truth?.samples ?? 0,
      backingWsteemMu: st.backing["WSTEEM"] ?? 0,
      note: "price-credibility-seal",
    });
  }

  // Task 83 · הזנת-הנרות ממסחר-אמת של-הבלוק (לפני-ה++ — אותו-h שה-tape מסמן)
  if (blockTrades.length > 0) klinesFeed(blockTrades, st.height, t0);
  // EXEC-CD-8 · הזנת-ייחוס-המייקרים מאותם-מסחר-אמת (fills-בלבד-עם-maker)
  if (blockTrades.length > 0) makerFeed(blockTrades, st.height);
  // EXEC-CD-9 · הזנת-מד-גז-הספר מהשריפות-המאושרות של-הבלוק (fuel-freeze-fix —
  // המזרקה תמחזר את-המד-הזה-חזרה-לאוצר; כל-µ-פעם-אחת — ראה economy.bookGasRecycle)
  if (appliedGas.length > 0) bookGasFeed(appliedGas);

  st.height++;
  // FIX(SETTLE-9 perf): stateRoot חושב-פעמיים-פר-בלוק (hash בלוק + כתיבת-DB) —
  // O(state) מלא כל-פעם (~3ms בתקרת-מצב). חישוב-אחד + העברה-לחותם (והחותם
  // משתמש-בו כאימות-הקפאה: אם-המצב זז בין-בניית-הבלוק לחותם — ה-invariant נופל).
  const root = stateRoot(st);
  rt.cachedRoot = { h: st.height, root }; // אותו-גובה — מנצלים-את-החישוב-גם-ל-getState
  const bh = sha256(canon({ h: st.height, ops: applied, gas: st.gasUsed, root }));
  rt.blockHashes.push(bh);
  const buildMs = Date.now() - t0;
  rt.buildMsRolling = Math.floor(rt.buildMsRolling * 0.8 + buildMs * 0.2);
  // TPS מדוד-אמת: ops שיושמו בפועל בבלוק, ממוצע-נע על קצב-הפעימה
  rt.opsPerSecRolling = Math.floor(rt.opsPerSecRolling * 0.7 + (applied / (TICK_MS / 1000)) * 0.3);
  rt.lastBlockAt = Date.now();

  try {
    await db.blockHeader.create({
      data: { height: st.height, hash: bh, stateRoot: root, opsCount: applied, gasUsed: st.gasUsed, buildMs },
    });
    rt.dbOk = true; // הצלחה מאשרת מחדש — הדגל לא נשאר דומם-לשלילה
  } catch { rt.dbOk = false; }

  if (st.height % SEAL_EVERY === 0) await seal(rt, root);
  if (st.height % GC_EVERY === 0) {
    rt.mempool.push({ type: "order_gc", issuer: "treasury", nonce: sysNonce(st, "gc") });
  }
  ladderCheck(rt);
}

async function tick(rt: ChainRT): Promise<void> {
  if (rt.busy || rt.halted) return;
  rt.busy = true;
  try {
    rt.tickCount++;
    // ארנה + בוטים → ממפול
    arenaTick(rt.st, rt.tickCount, rt.params, rt.rt, (op) => {
      if (rt.mempool.length < 512) rt.mempool.push(op);
    });
    await buildBlock(rt);
    // דגימת-דלק (SETTLE-5): כל-בלוק — טבעת-400 (≈20 דק׳) לשריפה-חלונית-אמת.
    // חוץ-מצב בכוונה: ה-DexState/שורש-המצב נשארים-דטרמיניסטיים-לריפליי.
    rt.fuelSamples.push({ h: rt.st.height, gasUsed: rt.st.gasUsed });
    // FIX(SETTLE-9): ה-trim הישן (splice(0,100)) רטט 301–401 דגימות — חיתוך-מדויק לתקרה
    if (rt.fuelSamples.length > 400) rt.fuelSamples.splice(0, rt.fuelSamples.length - 400);
    if (rt.tickCount % SNAPSHOT_EVERY === 0) flushSnapshot(rt);
  } catch (e) {
    // FIX(Roast-65-a · HIGH-1): CanonicalError (מצב-קנוני-רעיל — float/NaN/לא-שלם
    // שחדר-למצב) היה-נופל-ל-catch-הגנרי: השרשרת המשיכה-להעלות-גובה-עיוור בכל-טיק
    // בלי blockHash/seal/DB (halted=false), ו-getState/getMetrics/settle מתו 500 —
    // שקט-מוחלט. עכשיו: אותו-משטר-כמו-InvariantViolation — HALT מוכרז עם-סיבה-פורנזית.
    if (e instanceof InvariantViolation || e instanceof CanonicalError) {
      /* ── Fail-Fast מוסדי: הפרת-אינווריאנטה = מצב-עולם לא-מוגדר.
       * השרשרת מעלה-את-עצמה (HALT) — נשארת-חיה לקריאה/תצפית, אך מסרבת
       * לבנות בלוקים נוספים ממצב-חשוד. הזנקת-ALERT קשה לתצפית-תפעולית. */
      rt.halted = true;
      rt.haltReason = String(e.message).slice(0, 300); // פורנזי — חשוף ב-API ושרד-אתחול-מחדש
      if (rt.timer) { clearInterval(rt.timer); rt.timer = null; }
      console.error(`[saos-dex][ALERT] INVARIANT VIOLATION / STATE-POISON — chain HALTED (fail-fast, refuses undefined state): ${e.message}`);
      return;
    }
    console.error("[saos-dex] tick error:", e instanceof Error ? e.message : e);
  } finally {
    rt.busy = false;
  }
}

// ─── Task 72 · פיד-האורקל (דלת-המטבעות) ──────────────────────────────────────
// extFeeds מחזיר median חוצה-מקורות ($ ליחידה) → ממפה ל-µ-USDS-ל-יחידה (×1e6,
// עיגול-שלמים) על נכסי-הרשת הרלוונטיים. דחיפה רק-כשערך-שונה מהאורקל-הקנוני —
// אין-רעש-מצב. ה-op עצמו אוצר-חתום + nonce-מערכת → ריפליי דטרמיניסטי.
const ORACLE_MAP: Array<{ asset: string; feed: "steem" | "hive" | "sbd" | "blurt" | "eth" | "sol" | "bnb" | "trx" | "btc" }> = [
  { asset: "WTRX", feed: "trx" },
  { asset: "WSOL", feed: "sol" },
  { asset: "WSTEEM", feed: "steem" },
  { asset: "PHIVE", feed: "hive" },   // R23: הנכס-הרשום הוא PHIVE (לא HIVE) — עד-עתה העוגן שלו לא זז כלל
  { asset: "HIVE", feed: "hive" },    // R28: מפתח-מורשת שנתקע ב-h9913 אחרי מעבר R23 — מוחזר למפה כדי שכל מפתח באורקל הציבורי יישאר חי (אותו פיד, אפס השפעה מסחרית)
  { asset: "WSBD", feed: "sbd" },     // R23: WSBD עוקב אחרי SBD אמת (steem-dollars, ~$0.44) — לא HBD של Hive
  { asset: "WBLURT", feed: "blurt" },
  { asset: "ETH", feed: "eth" },
  { asset: "BTC", feed: "btc" },
  // EXEC-CD-11 · THE-CHAIN-STREAM: דלת-EVM המורחבת — אותו-פיד-אמת, רשתות-אמת
  { asset: "WETH", feed: "eth" },     // Ethereum mainnet
  { asset: "WBNB", feed: "bnb" },     // BNB Smart Chain
  { asset: "WBASE", feed: "eth" },    // Base — gas-token הוא ETH אמת (אותו-פיד, רשת-אחרת)
];

async function oracleTick(rt: ChainRT, force = false): Promise<void> {
  if (rt.halted) return;
  try {
    const feeds = await extFeeds(force);
    if (!feeds.ok || feeds.stale) return; // אין-פיד-חי = אין-דחיפה (כנות: last-good נשאר במצב)
    const prices: Record<string, number> = {};
    const srcs: string[] = [];
    for (const { asset, feed } of ORACLE_MAP) {
      const v = feeds.usd[feed];
      if (typeof v !== "number" || !(v > 0)) continue;
      const mu = Math.round(v * 1_000_000);
      if (!Number.isSafeInteger(mu) || mu <= 0) continue;
      if (rt.st.oracle?.[asset]?.mu === mu) continue; // לא-השתנה — אין-רעש-מצב
      prices[asset] = mu;
      const cross = feeds.cross?.[feed];
      srcs.push(`${asset}×${cross?.sources ?? "?"}`);
    }
    if (Object.keys(prices).length === 0) return;
    const src = `median(${srcs.slice(0, 4).join(",")})`;
    // FIX(R16-a·m10): הפעימה-הקבועה (60ש׳) ו-refresh-oracle (דלת-המפעיל) יכלו לרוץ
    // במקביל לפני-צריכת-הנונס → אותו sysNonce פעמיים → השני נדחה replay-rejected
    // (עדכון-מחיר-שונה נשרק בשקט). עתה: הסיומת כוללת גם את מספר-ה-oracle-הממתנים
    // בממפול — קבוע-מהמצב (קביעות-ריפליי נשמרת — בלי-רנדומיות) ויחודי-לכל-דחיפה.
    const pendingOracle = rt.mempool.filter((o) => String((o as { nonce?: string }).nonce ?? "").startsWith("oracle-")).length;
    rt.mempool.push({
      type: "oracle_set", issuer: "treasury", nonce: `${sysNonce(rt.st, "oracle")}-p${pendingOracle}`, prices, claim: src,
    });
    console.info(`[saos-dex] oracle_set queued: ${Object.entries(prices).map(([a, m]) => `${a}=${(m / 1e6).toPrecision(6)}$`).join(" · ")} (${src})`);
  } catch {
    // fail-כנה — פיד-חוץ לא מוריד את השרשרת; הניסיון-הבא בעוד-60ש׳
  }
}

/** דחיפת-אורקל-מיידית (שער-מפעיל — /api/dex/door action=refresh-oracle). */
export function requestOracleRefresh(): { queued: boolean; reason?: string } {
  const rt = ensureChain();
  if (rt.halted) return { queued: false, reason: "halted" };
  void oracleTick(rt);
  return { queued: true };
}

export function ensureChain(): ChainRT {
  if (g.__saosDexChain) return g.__saosDexChain;
  const rt: ChainRT = {
    st: genesisState(),
    mempool: [], rt: new Map(), params: { ...DEFAULT_PARAMS },
    tape: [], blockHashes: [], seals: [], receipts: [],
    lastReceiptDigest: null, tickCount: 0, timer: null, busy: false,
    fuelSamples: [],
    priceSamples: [],
    buildMsRolling: 0, opsPerSecRolling: 0, startedAt: Date.now(), lastBlockAt: 0,
    dbOk: true, halted: false, haltReason: null, version: 1,
    pendingLift: null, // FIX(Roast-65-a · MED-6)
    cachedRoot: null,
    rejectedLast: null,
    oracleTimer: null,
    faucetAtRt: new Map(),
    pendingLoad: true, // FIX(R16-a·m5)
  };
  g.__saosDexChain = rt;
  // Task 72 · לולאת-פיד-האורקל (דלת-המטבעות): כל-60ש׳ בודקת את פידי-השוק-האמת
  // (extFeeds — TTL-קאש משותף, רשת-אמיתית רק כשה-TTL פג) ודוחפת oracle_set אוצר
  // רק-כשמחיר-שינה. ה-op קנוני (בתוך ה-stateRoot); הלולאה עצמה חוץ-מצב וכשלה
  // שקט-כנה — פיד-חוץ לא מוריד את השרשרת.
  rt.oracleTimer = setInterval(() => void oracleTick(rt), 60_000);
  void oracleTick(rt); // דחיפה-ראשונה מיד-באתחול
  // אתחול-אסינכרוני: תמונת-מצב (מאומתת) → אחרת ג'נזיס-מוצדק; אחר-כך טיימר
  void (async () => {
    const loaded = await loadSnapshot(rt);
    // EXEC-CD-9 · רצפת-מצב למד-המחזור — קוטל-הטבעה-כפולה: אם-קובץ-המד איחר-להישטף
    // בעוד-המצב-הוטבע — המד מתיישר מול st.bookGasRecycledMu הקנוני (לעולם לא מחזיר פעמיים)
    if (loaded === "loaded") bookGasFloor(rt.st.bookGasRecycledMu ?? 0);
    // Task 83 · טעינת-נרות-מהגיט (שורד-מחיקת-סנדבוקס — אותו-משטר-ריבונות של-תמונת-המצב)
    const kl = klinesLoad();
    if (kl.candles > 0) console.log(`[saos-dex] klines restored from git-backed db/klines.json: ${kl.pairs} pairs, ${kl.candles} candles`);
    if (loaded === "corrupt") {
      // FIX(Roast-65-a · HIGH-4): תמונה-קיימת-ופגומה = דחיית-אתחול fail-closed.
      // הישן: !loaded → deleteMany על blockHeader+sealRecord+evidenceReceipt+arenaJournal
      // (= טיהור-כל-שרשרת-העדויות) וג'נזיס-חדש בשקט. עכשיו: אף-ראיה לא נמחקת,
      // אין-ג'נזיס-כפוי — השרשרת עוצרת-עם-haltReason-פורנזי (ה-DB כולו נשאר ראיה).
      rt.halted = true;
      rt.haltReason = "snapshot-integrity-failed: load refused, evidence preserved (operator reset is the explicit recovery path)";
      console.error("[saos-dex][ALERT] BOOT REFUSED — snapshot failed integrity verification; chain HALTED without touching any evidence row. Recovery: explicit operator reset.");
      rt.pendingLoad = false; // FIX(R16-a·m5)
      return;
    }
    if (loaded === "absent") {
      // אין-תמונה כלל: ג'נזיס לגיטימי רק אם-אין-עדויות-קודמות ב-DB — אחרת זה
      // "ג'נזיס-מעל-היסטוריה" שמנותק את שרשרת-העדויות בשקט (השקר-הישן: deleteMany).
      let prior = 0;
      // FIX(R15-a · fail-closed-genesis): count-שגוי היה ממשיך-לג'נזיס עם "verified empty DB"
      // — האימות מעולם-לא-קרה (fail-open בדיוק-הרגע-הקריטי). עתה: לא-ניתן-לאמת = עצירה-כנה.
      try { prior = await db.blockHeader.count(); } catch (e) {
        rt.dbOk = false;
        rt.halted = true;
        rt.haltReason = `genesis-refused: DB unreachable while verifying emptiness (${String(e).slice(0, 60)}) — continuity cannot be verified; retry on next boot`;
        console.error(`[saos-dex][ALERT] BOOT REFUSED — blockHeader.count() failed; cannot prove DB empty. Chain HALTED fail-closed.`);
        rt.pendingLoad = false; // FIX(R16-a·m5)
        return;
      }
      if (prior > 0) {
        rt.halted = true;
        rt.haltReason = `genesis-refused: ${prior} block headers exist in DB but no snapshot — continuity cannot be fabricated; explicit operator reset required`;
        console.error(`[saos-dex][ALERT] BOOT REFUSED — no snapshot but ${prior} block headers in DB; genesis would orphan that evidence. Chain HALTED, evidence untouched.`);
        rt.pendingLoad = false; // FIX(R16-a·m5)
        return;
      }
      // ג'נזיס-טרי אמת (בסיס-ריק בהכרח) — עוגן-ג'נזיס חתום מיד (בלוק-ראשון)
      await buildBlock(rt);
      pushReceipt(rt, "genesis", { root: stateRoot(rt.st), at: Date.now() });
      console.info(`[saos-dex] chain live · height ${rt.st.height} · root ${stateRoot(rt.st).slice(0, 12)}… (genesis — verified empty DB)`);
      if (!rt.timer) rt.timer = setInterval(() => void tick(rt), TICK_MS); // FIX(R16-a·m5): לא-לכפול-טיימר אם-reset הקדים
      rt.pendingLoad = false; // FIX(R16-a·m5)
      return;
    }
    // ראיות-מעבר-לתמונת-המצב הן-שאריות-מריצה-קודמת (נחתמו-אחרי-הסנפלוט האחרון
    // ולא הספיקו-להיכלל) — ניקוי-צר-וכנה בלבד: רק-גבהים-מעל-התמונה-המאומתת
    // (הישן היה-מוכן-למחוק-הכל; כאן הכלל-הוא רק-הזנב שמעבר לגובה-המאומת)
    try {
      const stale = await db.blockHeader.deleteMany({ where: { height: { gt: rt.st.height } } });
      if (stale.count > 0) console.info(`[saos-dex] purged ${stale.count} stale block headers beyond snapshot h${rt.st.height} (prior-run evidence)`);
      // FIX(R15-a · stale-seals): רק-blockHeader נוקה — SealRecords מעל-התמונה נשארו:
      // השרשרת-המשוחזרת מייצרת חותמות-חדשות בגבהים-שכבר-חתומים (root @unique) →
      // create נכשל-בשקט → dbOk=false-רעש + חותמת-של-טיפ-נטוש-שהגרעין-החדש יסתור.
      const staleSeals = await db.sealRecord.deleteMany({ where: { toHeight: { gt: rt.st.height } } });
      if (staleSeals.count > 0) console.info(`[saos-dex] purged ${staleSeals.count} stale seal records beyond snapshot h${rt.st.height}`);
    } catch { rt.dbOk = false; }
    // FIX(R17-b·L2): שרשרת-ה-digest-של-הקבלות הייתה מתאפסת-בכל-הפעמה
    // (lastReceiptDigest=null באתחול) → כל-קבלה-חדשה נקשרה-ל-null והרצף-הפורנזי
    // נשבר-בשקט בכל-restart (בדיוק-ה-artifact ש-R15-b גילה-ותיעד-כ-linkageLost).
    // עתה: הידרציה-מהשורה-האחרונה-ב-DB — ההמשכיות נשמרת-על-פני-הפעמות.
    try {
      const lastRec = await db.evidenceReceipt.findFirst({ orderBy: { createdAt: "desc" }, select: { digest: true } });
      if (lastRec?.digest) {
        rt.lastReceiptDigest = lastRec.digest;
        console.info(`[saos-dex] receipt-digest chain rehydrated (${lastRec.digest.slice(0, 12)}…) — linkage continues across restarts (R17-b·L2)`);
      }
    } catch { rt.dbOk = false; }
    if (!rt.timer) rt.timer = setInterval(() => void tick(rt), TICK_MS); // FIX(R16-a·m5)
    rt.pendingLoad = false; // FIX(R16-a·m5): סוף-הטעינה — reset מותר מעתה
    console.info(`[saos-dex] chain live · height ${rt.st.height} · root ${stateRoot(rt.st).slice(0, 12)}… (snapshot — verified vs DB stateRoot)`);
  })();
  return rt;
}

// ─── ממשק-ציבורי ────────────────────────────────────────────────────────────

export function submitOp(op: Op): { queued: boolean; reason?: string } {
  const rt = ensureChain();
  if (rt.mempool.length >= 512) return { queued: false, reason: "mempool-full" };
  if (!op.issuer || !op.nonce) return { queued: false, reason: "issuer+nonce-required" };
  if (GAS_TABLE[op.type] === undefined) return { queued: false, reason: "unknown-op" };
  // FIX(Roast-64 · free-op-flood): פעולות-אפס-גז (relay/xfer_free/relay_ack) היו
  // יכולות למלא את כל-512-הממפול ואת-160-חריצי-הבלוק ולחנוק את כל-הפעולות-שמשלמות
  // (DoS-על-השרשרת-עצמה בפעולה-חינמית). עכשיו: הקצבה-פר-חשבון על-הממפול — חינם
  // עדיין-חינם, אבל אזרח-אחד לא חונק-את-הרשת.
  if (GAS_TABLE[op.type] === 0) {
    const pendingFree = rt.mempool.filter((o) => o.issuer === op.issuer && GAS_TABLE[o.type] === 0).length;
    if (pendingFree >= 48) return { queued: false, reason: "free-op-cap" };
  }
  rt.mempool.push(op);
  return { queued: true };
}

// FIX(SETTLE-9 determinism): ה-Math.random האחרון בליבה — ה-nonce הוא תוכן-op
// הנכנס ל-st.nonces ולכן ל-stateRoot. מונה-תהליך-מונוטוני = ייחודיות מלאה בלי-מקריות
// (ה-uniqueness הוא כל-מה-ש-dedupe הגרעין צריך; אין-כאן קריפטו).
let nonceSeq = 0;
export function nextNonce(prefix: string): string {
  const rt = ensureChain();
  nonceSeq = (nonceSeq + 1) % 1_000_000_000;
  return `${prefix}-${Date.now().toString(36)}-${nonceSeq.toString(36)}-${rt.st.nonces.length}`;
}

export function operatorFaucet(): { ok: boolean; reason?: string } {
  const rt = ensureChain();
  // FIX(Roast-65-a · LOW-11): cooldown-שורד-ריסטארט.
  // FIX(R15-a · out-of-band): הכתיבה-הייתה ישר-ב-st.faucetAt (מצב-קנוני) מחוץ-ל-op/בלוק —
  // שורש-מיושן-עד-החותם-הבא + מוטציה שיכולה-להימלט-ממקור-שחושב-בדיוק-עכשיו
  // (seal-freeze-check-כוזב). עתה: cooldown-בראנטיים (Map) — שקול-פונקציונלית,
  // אפס-נגיעה במצב; st.faucetAt נשאר-שדה-מורשת-ריק.
  const last = rt.faucetAtRt.get("operator") ?? 0;
  if (Date.now() - last < 60_000) return { ok: false, reason: "cooldown-60s" };
  rt.faucetAtRt.set("operator", Date.now());
  rt.mempool.push({ type: "transfer", issuer: "treasury", nonce: sysNonce(rt.st, "faucet-s"), to: "operator", asset: "SAOS", amount: 1_000_000 });
  rt.mempool.push({ type: "transfer", issuer: "treasury", nonce: sysNonce(rt.st, "faucet-u"), to: "operator", asset: "USDS", amount: 2_500_000 });
  return { ok: true };
}

export interface MarketView {
  base: string; quote: string; key: string;
  fair: number; bestBid: number; bestAsk: number; spreadBps: number;
  poolMid: number; refPrice: number;
  twap: number; twapSamples: number; twapDevBps: number; // SETTLE-14: מחיר-אמת ממסחר-אמת
  bids: { price: number; total: number; orders: number }[];
  asks: { price: number; total: number; orders: number }[];
  chart: { t: number; p: number }[];
  // Task 83 · סטטיסטיקת-24ש' מנרות-מסחר-אמת (סטנדרט-בורסות — נגזרת-כנה)
  stats24: ReturnType<typeof stats24For>;
}

function ladderAgg(st: DexState, base: string, quote: string, side: "buy" | "sell", levels = 12) {
  const book = sortBook(st, base, quote, side);
  const out: { price: number; total: number; orders: number }[] = [];
  for (const o of book) {
    const rem = o.amount - o.filled;
    if (rem <= 0) continue;
    const last = out[out.length - 1];
    if (last && last.price === o.price) { last.total += rem; last.orders++; }
    else if (out.length < levels) out.push({ price: o.price, total: rem, orders: 1 });
    else break;
  }
  return out;
}

export function getMarkets(): MarketView[] {
  const rt = ensureChain();
  const st = rt.st;
  return MARKETS.map((m) => {
    const key = poolKey(m.base, m.quote);
    const bids = ladderAgg(st, m.base, m.quote, "buy");
    const asks = ladderAgg(st, m.base, m.quote, "sell");
    const bestBid = bids[0]?.price ?? 0;
    const bestAsk = asks[0]?.price ?? 0;
    const p = getPool(st, key);
    // SETTLE-14: הטייפ מכיל שני-כיוונים (base/quote לפי-צד-המכירה) — מנרמל
    // לכיוון-הזוג (בלי-זה המצגת-של-WSTEEM חסרה-חצי-מהמסחרות).
    const chart = rt.tape
      .filter((e) => e.amountMu > 0 && ((e.base === m.base && e.quote === m.quote) || (e.base === m.quote && e.quote === m.base)))
      .map((e) => ({ t: e.at, p: e.base === m.base ? e.price : Math.floor(1_000_000 / (e.price > 0 ? e.price : 1)) }))
      .slice(0, CHART_CAP).reverse();
    const truth = priceTruthFor(rt, m.base, m.quote);
    return {
      base: m.base, quote: m.quote, key,
      fair: fairPrice(st, m.base, m.quote),
      bestBid, bestAsk,
      spreadBps: bestBid > 0 && bestAsk > 0 ? Math.floor(((bestAsk - bestBid) / ((bestAsk + bestBid) / 2)) * 10_000) : 0,
      poolMid: p ? poolMidFor(p, m.base, m.quote) : 0,
      refPrice: st.assets[m.base]?.refPrice ?? 0,
      twap: truth?.twap ?? 0,
      twapSamples: truth?.samples ?? 0,
      twapDevBps: truth ? truth.devBpsVsRef : 0,
      bids, asks, chart,
      stats24: stats24For(key, Date.now()),
    };
  });
}

export function getPools() {
  const rt = ensureChain();
  return Object.entries(rt.st.pools).map(([key, p]) => {
    // FIX(Roast-66 · pool-nourishment): מד-ההזנה-הכן לספקי-נזילות — העמלי-70%-ל-LP
    // מוטמעים-ברזרבות (k צומח) אבל מעולם-לא-פורטו-כתשואה. נגזרת-כנה: אותו-זרימת-סוואפ
    // שיצר feeT (30%-אוצר) יצר 70%-LP → lpFeesMu ≈ feeT×7/3. תשואה-ליחידת-LP-וחלק-POL
    // של-האוצר חשופים — מזינות-נמדדת-ולא-מוצהרת.
    const tLp = rt.st.balances["treasury"]?.[`LP|${key}`] ?? 0;
    const lpFeesMu = Math.floor((p.feeAccruedTreasury * 7) / 3);
    return {
      key, a: p.a, b: p.b, ra: p.ra, rb: p.rb, lp: p.lp,
      mid: poolMid(p), swaps: p.swaps, feeAccruedTreasury: p.feeAccruedTreasury,
      owner: p.owner ?? "treasury", // EXEC-CD-9 · בעלות-גלויה (undefined = ריבוני)
      k: p.ra * p.rb,
      feeBps: effectiveFeeBps(p), // FIX(Roast-65-c · F4): העמלה-הדינמית-האפקטיבית חשופה-ל-UI (היה-חייב-ניחוש-של-30bps-קבוע)
      lpFeesMu,                                                       // FIX(Roast-66): עמלי-ה-LP-המוטמעים (נגזרת-כנה)
      // FIX(3-a · D5): הנגזרת-מתויגת-גלויה — lpFeesMu אינו-מדידה ישירה אלא feeT×7/3
      // (אין-מונה-LP-נפרד במצב-הקנוני); צרכן-ה-API חייב לדעת שזו גזירה, לא ספירה.
      derived: true,
      lpYieldBps: p.lp > 0 ? Math.floor((lpFeesMu * 10_000) / p.lp) : 0, // תשואת-עמלות-ליחידת-LP (lifetime, bps — נגזרת-מנגזרת)
      polShareBps: p.lp > 0 ? Math.floor((tLp * 10_000) / p.lp) : 0,   // חלק-נזילות-בעלות-הפרוטוקול
    };
  });
}

export function getQuote(pair: string, assetIn: string, amountIn: number) {
  const rt = ensureChain();
  const p = getPool(rt.st, pair);
  if (!p) return null;
  return quoteOut(p, assetIn, amountIn);
}

export function getWallets() {
  const rt = ensureChain();
  const st = rt.st;
  const names = Array.from(new Set([...Object.keys(st.balances), "operator", "treasury"]));
  return names.map((n) => ({
    name: n,
    credits: st.credits[n] ?? 0,
    balances: st.balances[n] ?? {},
    locked: st.locked[n] ?? {},
  })).filter((w) => Object.keys(w.balances).length > 0 || w.credits > 0);
}

/** מפקד-הסוכנים (עמדת-הסליקה): תפקיד · הון-סימולציה · פקודות-חיות לכל-סוכן */
export function getCensus(): { name: string; role: string; credits: number; equity: number; liveOrders: number; balances: Record<string, number>; locked: Record<string, number> }[] {
  const st = ensureChain().st;
  const fair = fairPrice(st, "SAOS", "USDS") || (st.assets["SAOS"]?.refPrice ?? 0);
  const role = (n: string): string =>
    n === "treasury" ? "central-bank" : n === "operator" ? "human" : n === "arena" ? "pegkeeper" : n.startsWith("soldier") ? "grid-mm" : "noise";
  return getWallets().map((w) => {
    // FIX(R17-b·M4): איזון-LP היה-מדורג-0 (ל-tokens-LP אין-refPrice) — אפס-מזויף
    // במפקד-הסוכנים בעוד-שווי-אמת-קיים (חלק-יחסי-מהרזרבות). עתה: LP עובר-דרך
    // lpValuation (שווי-1000µ-LP × ההחזקה). ידוע: ייבוא-מ-router (הוא-עצמו-ייבא-מ-chain)
    // — קריאה-רק-בזמן-ריצה, אין-שימוש-טופ-לבל, ולכן-המעגל-בטוח (אומת-ב-boot).
    let lpEquity = 0;
    for (const [a, v] of Object.entries(w.balances)) {
      if (!a.startsWith("LP|")) continue;
      const lv = lpValuation(a);
      if (lv && lv.lpMu > 0) lpEquity += Math.floor((v * lv.valueUsdsMuPer1000) / 1000);
    }
    const equity =
      (w.balances["USDS"] ?? 0) +
      Math.floor(((w.balances["SAOS"] ?? 0) * fair) / 1000) +
      Object.entries(w.balances)
        .filter(([a]) => a !== "USDS" && a !== "SAOS" && !a.startsWith("LP|"))
        .reduce((s, [a, v]) => s + Math.floor((v * (st.assets[a]?.refPrice ?? 0)) / 1000), 0) +
      lpEquity;
    const liveOrders = st.orders.filter((o) => o.live && o.owner === w.name).length;
    return { name: w.name, role: role(w.name), credits: w.credits, equity, liveOrders, balances: w.balances, locked: w.locked };
  });
}

/** מצב-חי לעמדת-הסליקה (קריאה-בלבד — המבחנים עובדים על-שיבוטים) */
export function getLiveState(): DexState {
  return ensureChain().st;
}

export function getArena() {
  const rt = ensureChain();
  const st = rt.st;
  // OWNER-MANDATE 2026-10-17: החיילים-הסינתטיים סולקו מהשרשרת (agent_purge) —
  // המבנה נשמר לתאימות-UI; הרשימה ריקה בכנות — אין-חיילים, אין-הצגה-שדופה.
  const soldiers: string[] = [];
  return {
    params: rt.params,
    dbOk: rt.dbOk,
    soldiers: soldiers.map((s) => {
      const saos = st.balances[s]?.["SAOS"] ?? 0;
      const usds = st.balances[s]?.["USDS"] ?? 0;
      const fair = fairPrice(st, "SAOS", "USDS") || 2500;
      const equity = usds + Math.floor((saos * fair) / 1000);
      const live = st.orders.filter((o) => o.live && o.owner === s).length;
      return {
        name: s, saos, usds, equity,
        pnl: equity - 6_000_000, // יחסית-לג'נזיס (3M USDS + 1.2M SAOS @2500)
        liveQuotes: live,
        locked: st.locked[s] ?? {},
      };
    }),
    journal: st.journal.slice(-14).reverse(),
    mempool: rt.mempool.length,
  };
}

export function setArenaParams(patch: Partial<ArenaParams>): ArenaParams {
  const rt = ensureChain();
  // FIX(SETTLE-7 DoS): תקרות-פר-פרמטר — הבקרה-הציבורית (/api/dex/arena POST)
  // היתה-מרשה levels=9,999,999 → arenaTick רץ 10⁸-איטרציות פר-טיק (3 שנ׳) =
  // חנק-שרשרת/OOM ללא-אימות. גם-חוסר-היתר (v<10M) עבר כל-דבר-גדול-אחר.
  const LIMITS: Record<keyof ArenaParams, [number, number]> = {
    spreadBps: [5, 2_000], stepBps: [2, 2_000], levels: [1, 12],
    sizeMu: [1_000, 2_000_000], maxInventoryMu: [100_000, 30_000_000],
    minEdgeBps: [0, 2_000], requoteBps: [1, 2_000],
    enabled: [0, 1], noise: [0, 1],
  } as never;
  const clean: Partial<ArenaParams> = {};
  if (typeof patch.enabled === "boolean") clean.enabled = patch.enabled;
  if (typeof patch.noise === "boolean") clean.noise = patch.noise;
  for (const k of ["spreadBps", "stepBps", "levels", "sizeMu", "maxInventoryMu", "minEdgeBps", "requoteBps"] as const) {
    const v = patch[k];
    if (typeof v === "number" && Number.isSafeInteger(v)) {
      const [lo, hi] = LIMITS[k];
      clean[k] = Math.min(hi, Math.max(lo, v)); // clamp — לא-reject: המפעיל מקבל מה-שביקש, מרוסן
    }
  }
  rt.params = { ...rt.params, ...clean };
  return rt.params;
}

export function getProofs() {
  const rt = ensureChain();
  const latest = rt.seals[0] ?? null;
  return {
    seals: rt.seals.slice(0, 8),
    latest,
    // FIX(Roast-65-a · MED-7): הישן הציג rt.blockHashes.length — החלון-הבא-שטרם-נחתם
    // (0 מיד-אחרי-כל-חותם!) מתומכת-שקרית כ"עלי-החותם". עכשיו: מספר-העלים-החתומים.
    leaves: latest ? latest.leaves : 0,
    sealedLeaves: latest ? latest.blockHashes : [], // העלים-שנחתמו-בפועל (החלון-החתום)
    receipts: rt.receipts.slice(0, 10),
    howToVerify: [
      // FIX(Roast-65-a · MED-7): ההדרכה-הישנה כיוונה ל"רשימת-hashי-הבלוקים מה-API" —
      // בפועל אלו היו החלון-החי-הבא (לא-החתום) והאימות-היה נכשל/מטעה לכל-אורך-מחזור-ה-12.
      "קח את עלי-החותם-האחרון מ-/api/dex/proofs (leaves — החלון-החתום, מה-DB) או מ-sealedLeaves/latest.blockHashes",
      "FIX(Roast-64) סכמה-מוגנת-CVE-2012-2459: עלה = sha256(0x00‖leaf) · צומת = sha256(0x01‖L‖R) · עלה-אחרון-אי-זוגי מוכפל · שורש = sha256(0x02‖uint32le(מספר-עלים)‖top)",
      "השווה ל-root — שוויון = הבלוקים כלולים בחותם, בלי לסמוך עלינו",
    ],
    blockWindow: rt.blockHashes.length,
  };
}

export function getLatestSealLeaves(): string[] | null {
  const rt = ensureChain();
  const latest = rt.seals[0];
  if (!latest) return null;
  // FIX(Roast-65-a · MED-7): הישן החזיר את החלון-הנוכחי-החי (הבא-שטרם-נחתם) וההערה
  // "העלים נשמרים-עד-החותם-הבא" שיקרה פעמיים: הם נמחקו מיד-בחותם, ומעולם לא היו
  // העלים-שנחתמו. עכשיו: העלים-החתומים-עצמם (SealInfo.blockHashes — נשמר-פר-חותם
  // וגם-ב-DB ב-SealRecord.note). ההשוואה מול latest.root היא אמת.
  return latest.blockHashes ?? null;
}

/** גרסה-מונוטונית של מצב-העולם (long-polling מבוסס-אירוע) */
export function chainVersion(): number {
  const rt = ensureChain();
  return rt.st.height;
}

export function getState() {
  const rt = ensureChain();
  const st = rt.st;
  // FIX(SETTLE-9 perf): כל-קריאת-GET/state (poll-כל-לקוח, כל-בלוק) חישבה O(state) מלא.
  // cache פר-גובה: המצב החי משתנה רק בתוך tick/buildBlock (מודל-כותב-יחיד).
  const root = rt.cachedRoot && rt.cachedRoot.h === st.height
    ? rt.cachedRoot.root
    : stateRoot(st);
  if (!rt.cachedRoot || rt.cachedRoot.h !== st.height) rt.cachedRoot = { h: st.height, root };
  return {
    height: st.height,
    tps: rt.opsPerSecRolling,
    stateRoot: root,
    gasUsed: st.gasUsed,
    opsTotal: st.stats.opsTotal,
    fills: st.stats.fills,
    swaps: st.stats.swaps,
    ladders: st.stats.ladders,
    treasuryProfit: st.treasuryProfit,
    feeMeter: st.feeMeter,
    gasFundedMu: st.gasFundedMu ?? 0, // FIX(Roast-67 · ZFB-gas-tank): טלמטריית-מימון-הדלק
    ladder: st.ladder,
    liveOrders: st.orders.filter((o) => o.live).length,
    buildMs: rt.buildMsRolling,
    uptimeSec: Math.floor((Date.now() - rt.startedAt) / 1000),
    lastBlockAgoMs: rt.lastBlockAt ? Date.now() - rt.lastBlockAt : null,
    dbOk: rt.dbOk,
    halted: rt.halted === true, // חשיפה-תפעולית: מצב-fail-fast נראה-ב-System Health
    haltReason: rt.haltReason ?? null, // פורנזי: מקור-ה-ALERT (מה בדיוק נתפס)
    rejectedLast: rt.rejectedLast, // SETTLE-15: אפס-דחיות-שקטות — הסיבה-חיה
    // FIX(Roast-64 · replay-honesty): חוב-טכני-מוצהר בפומבי — חלק מתנועות הבונה
    // (הסולם-כפקע, ה-rearm, ה-botseed) נשענות על טבעות-חוץ-מצב (priceSamples,
    // מוני-תהליך) — ריפליי מהלוג בלבד לא ישחזר אותן ביט-לביט; שיחזור-מלא =
    // ריצת-הבונה-עצמה על אותם-קלטים. זה מתועד — לא מוסתר.
    replayNote: "deterministic-from-ops+builder-ticks; price-evidence ring & process counters are off-state (documented)",
    tickMs: TICK_MS,
    sealEvery: SEAL_EVERY,
    nextSealIn: SEAL_EVERY - (st.height % SEAL_EVERY),
    backing: st.backing,
    assets: st.assets,
    oracle: st.oracle, // R23 · LIVE-ANCHOR: מפת-פיד-השוק-האמיתי גלוי-לציבור מול-העוגנים (µ$-ליחידה; refPrice ב-mµ)
    // SETTLE-15: מקור-הנזיל-שמכניס-מהכל — פנקס-ההכנסה-החי (כנות: הכל-נמדד)
    income: {
      poolFeesMu: Object.values(st.pools).reduce((s, p) => s + p.feeAccruedTreasury, 0),
      feeMeterMu: st.feeMeter,
      treasuryProfitMu: st.treasuryProfit,
      treasuryProfitEverMu: st.treasuryProfitEver ?? 0, // FIX(R46): המונה-המונוטוני-האמיתי — עולה-רק (Σ-harvest מהזרע-הגיט-מוכח), לעולם לא נשחק-לדלק
      ladderSpentMu: st.ladder?.spentMu ?? 0,
      backingWsteemMu: st.backing["WSTEEM"] ?? 0,
      hub: "USDS", // כל-ראוטר-דרך-האב משלם 30bps → 30% לאוצר
    },
    // SETTLE-16 THE-MICRORAIL: המסילה-הריבונית-למיקרו — תקציב, מנות, פרמיות, P&L
    rail: railSummary(),
    milestone: milestoneSummary(),
    // Task 80 · THE-VAULT: הכספת-גלויה-לציבור — עמדות-חיות + מוני-חיים + חשבונאות-ההיצע.
    // לקח-הפוך-מזיוף: אמת-שקיימת-בשרשרת-אך-נעדרת-מהמראה-הציבורית היא כיסוי-עיניים
    // בדיוק-כמו-שקר; השדות נכנסים-לרשימה-הלבנה של getState עכשיו.
    vaults: st.vaults ?? {},
    vaultTot: st.vaultTot ?? { opened: 0, repaid: 0, liquidations: 0, interestMu: 0, backstopLossMu: 0, issuedMu: 0, burnedMu: 0 },
    // R40 · THE-SAVE: החיסכון-גלוי-לציבור — קרן, חוסכים, ריבית-שחולקה-מצטברת,
    // ושיעור-היום-האמיתי (מדוד-מחלון-הפירעונות — לא-הבטחה, לא-הטבעה).
    savings: (() => {
      const s = st.savings;
      // FIX(R47 · income-base): פירוק-זרמי-ההכנסה גלוי — ריבית-כספת + עתודת-שוק-כספים + נתח-30% מחית-עמלות-הבריכות
      const feeCut = Object.values(st.pools).reduce((s2, p) => s2 + p.feeAccruedTreasury, 0);
      const incomeStreams = {
        vaultInterestMu: st.vaultTot?.interestMu ?? 0,
        lendReserveMu: st.lend?.totals?.resToTreasuryMu ?? 0,
        feeShareMu: Math.floor((feeCut * SAVE_FEE_SHARE_PCT) / 100), // 30% מחית-העמלות (מראה-ה-TREASURY_CUT_PCT)
      };
      const income = incomeStreams.vaultInterestMu + incomeStreams.lendReserveMu + incomeStreams.feeShareMu;
      if (!s) return { potMu: 0, savers: 0, paidMu: 0, dayPaidMu: 0, dayPaidPrevMu: 0, windows: 0, apyBps: null, opens: 0, closes: 0, incomeSourceMu: income, incomeStreams, dayWindowBlocks: SAVE_DAY_BLOCKS, feeSharePct: SAVE_FEE_SHARE_PCT, dayMarkH: null, demoMu: 0 };
      const base = s.potMu > 0 ? s.potMu : 1;
      // FIX(R48 · calibration-truth): APY נמדד-רק-מחלון-יום-שני-והלאה (windows>=2) —
      // חלון-הפתיחה שלאחר-לידת/הרחבת-בסיס-ההכנסה קולט-הצטבר-היסטורי ואינו-מייצג-קצב-אמת
      // (נמדד-חי: 77,184µ בחלון-המיגרציה של R47). גם-אם-הריפליי סופר-את-חלון-המיגרציה
      // כחלון-ראשון-היסטורי — הוא-לעולם-לא-יהיה-בסיס-לפרסום-שנתי. בזמן-הכיול מתפרסם null —
      // הצרכן מציג-קצב-חי-מהחלון-הנוכחי במקום-הבטחה-שנתית.
      const windows = s.windows ?? 0;
      const apyBps = windows >= 2 ? Math.floor((s.dayPaidPrevMu * 365 * 10_000) / base) : null; // יום-מלא/קרן → bps-שנתי (שניהם ב-µ — יחס-טהור)
      // FIX(R48 · demo-disclosure): גילוי-מלא — עמדת-ההדגמה-הקבועה של המפעיל מפורסמת-בשמה —
      // הציבור רשאי-לדעת-שהחוסך-היחיד הוא-המפעיל-עצמו (אין-להציג-"1 חוסכים" בלי-לגלות-זאת).
      const demoMu = s.positions["operator"]?.mu ?? 0;
      return { potMu: s.potMu, savers: Object.keys(s.positions).length, paidMu: s.paidMu, dayPaidMu: s.dayPaidMu, dayPaidPrevMu: s.dayPaidPrevMu, windows, apyBps, opens: s.opens, closes: s.closes, incomeSourceMu: income, incomeStreams, dayWindowBlocks: SAVE_DAY_BLOCKS, feeSharePct: SAVE_FEE_SHARE_PCT, dayMarkH: s.dayMarkH ?? null, demoMu };
    })(),
    // R44 · THE-MARKET: שוק-הכספים גלוי-לציבור — שווקים-חיים (ניצולת/עקומה/מזומן),
    // עמדות, מוני-ריבית-ששולמה-באמת, ועמדת-האוצר. הכל-מדידה-חיה-מהשרשרת.
    lend: (() => {
      const ls = lendState(st);
      const markets = Object.entries(LEND_MARKETS).map(([asset, ltvBps]) => {
        const m = ls.markets[asset];
        return {
          asset,
          ltvBps,
          liqThresholdBps: lendLiqThresholdBps(asset),
          sMu: m?.sMu ?? 0,
          bMu: m?.bMu ?? 0,
          cashMu: (st.balances[LEND_POT]?.[asset] ?? 0),
          utilBps: lendUtilBps(m),
          borrowAprBps: lendBorrowAprBps(m),
          supplyAprBps: lendSupplyAprBps(m),
          sEarnedMu: m?.sEarnedMu ?? 0,
          resMu: m?.resMu ?? 0,
        };
      });
      const positions = Object.entries(ls.positions).map(([who, p]) => ({
        who,
        supplies: Object.entries(p.s).map(([a, sp]) => ({ asset: a, mu: sp.mu, earned: sp.earned })),
        borrows: Object.entries(p.b).map(([a, bp]) => ({ asset: a, mu: bp.mu, int: bp.int, atH: bp.atH, debtMu: lendDebtNow(bp, lendBorrowAprBps(ls.markets[a]), st.height) })),
        hf: lendHealthFactor(st, who),
      }));
      return {
        markets,
        positions,
        totals: ls.totals,
        treasury: (() => {
          const t = ls.positions["treasury"];
          const m = ls.markets["USDS"];
          return { suppliedMu: t?.s?.USDS?.mu ?? 0, earnedMu: t?.s?.USDS?.earned ?? 0, supplyAprBps: lendSupplyAprBps(m) };
        })(),
        invariant: Object.fromEntries(Object.keys(LEND_MARKETS).map((asset) => {
          const sSum = Object.values(ls.positions).reduce((s2, p) => s2 + (p.s[asset]?.mu ?? 0) + (p.s[asset]?.earned ?? 0), 0);
          const bSum = Object.values(ls.positions).reduce((s2, p) => s2 + (p.b[asset]?.mu ?? 0), 0);
          return [asset, { pot: st.balances[LEND_POT]?.[asset] ?? 0, expect: sSum - bSum, ok: (st.balances[LEND_POT]?.[asset] ?? 0) === sSum - bSum }];
        })),
      };
    })(),
    // R41 · THE-VE: הריבונות-הנעולה גלויה-לציבור — קרן-ve שהוזנה-מההכנסה-המדודה,
    // נועלים-חיים, הצבעות, אפוקים — והאג"ח שהומרו. הקרן מתרוקנת-בפועל בכל-אפוק-פליפ
    // (מי-שנועל-מרוויח) — בלי-מחלק אין-חלוקה, והצבירה-ההיסטורית הולכת-לראשון-שנועל
    // (אותו-דין-כמו-כל-רשת-ve; הכל-מתועד-ביומן).
    ve: (() => {
      const potMu = st.balances[VE_POT]?.USDS ?? 0;
      const detail = Object.entries(st.ve ?? {}).map(([who, p]) => ({ who, amtMu: p.amt, unlockH: p.unlockH, weeks: p.weeks }));
      return {
        potMu,
        positions: detail.length,
        votes: Object.keys(st.veVotes ?? {}).length,
        epoch: st.veEpoch ?? 0,
        fundedMu: st.rev?.vePaidMu ?? 0, // Σ מימון-קרן מצטבר (העברות-שבוצעו)
        paidOutMu: Math.max(0, (st.rev?.vePaidMu ?? 0) - potMu), // funded − standing = שחולק-בפועל-לנועלים
        detail,
        votesMap: st.veVotes ?? {},
      };
    })(),
    bond: st.bond ?? { soldSaosMu: 0, usdsInMu: 0, count: 0 },
    // R28 · ENGINE-TRUTH: מוני-האוטומציה-והכלכלה גלויים-לציבור. אותו-לקח-כנות
    // של-הכספת (A44): CoW, ProtoRev, DCA, טריגרים, ראוטר-ההכנסות ו-ve חיים
    // בשרשרת ורצים בכל-טיק — אבל נעדרו מהמראה-הציבורית. אמת-שקיימת-ונסתרת
    // היא כיסוי-עיניים בדיוק-כמו-שקר. הכל נקרא-מהמצב-האמת, ברירות-מחדל
    // אפסים-כנים לשדות-שלא-נולדו-עדיין (היסטוריה-קודמת-לשדה = undefined → 0).
    engine: {
      cow: st.cowStats ?? { matched: 0, batches: 0, surplusMu: 0, fallbackPool: 0, fallbackBook: 0 },
      cowPending: (st.cow ?? []).length,
      protorev: {
        pendingMu: st.revAux?.protorevMu ?? 0,
        launchpadMu: st.revAux?.launchpadMu ?? 0,
        runs: st.revAux?.runs ?? 0,
        cycles: st.revAux?.cycles ?? 0,
        rejections: st.revAux?.rejections ?? 0,
      },
      router: st.rev ?? { lastH: 0, cycles: 0, burnedMu: 0, vePaidMu: 0 },
      burnedSaosMu: st.burnedSaos ?? 0,
      feesSpentMu: st.feesSpentMu ?? 0,
      ve: { positions: Object.keys(st.ve ?? {}).length, epoch: st.veEpoch ?? 0 },
      auto: {
        dcaActive: Object.values(st.dca ?? {}).filter((p) => p.remainingMu > 0).length,
        dcaTotal: Math.max(0, (st.dcaSeq ?? 1) - 1),
        trigActive: Object.keys(st.trig ?? {}).length,
        trigTotal: Math.max(0, (st.trigSeq ?? 1) - 1),
      },
      // עדות-חיה לאחרוני-האירועים של המשפחה (יומן-500-נכנסים, מסונן בזהירות):
      // הציבור רואה אצוות-נסגרות, פרוסות-DCA, טריגרים-שנורו, ארב-ושריפות.
      feed: st.journal
        .filter((j) => ["cow", "dca", "trig", "protorev", "router"].includes(String(j.soldier)))
        .slice(-10)
        .reverse()
        .map((j) => ({ h: j.h, s: String(j.soldier), a: j.action, p: j.profitMu ?? 0, n: j.note })),
    },
  };
}

export function getTape(limit = 30): TapeEvent[] {
  const rt = ensureChain();
  return rt.tape.slice(0, limit).filter((e) => e.amountMu > 0);
}

/** הוכחת-יכולת: מדידת-קצב על-מצב-טרי (מורשת grid98 --bench)
 * FIX(SETTLE-7): התקררות-60 שנ׳ — ה-route הציבורי היה-מריץ עד-200k-ops + כותב
 * קבלה-ל-DB בכל-קריאה = DoS-מחשוב + זיהום-שרשרת-העדויות בלי-גבול. */
let benchCache: { at: number; res: { ops: number; ms: number; opsPerSec: number; perDay: number } } | null = null;
export function bench(ops = 20_000): { ops: number; ms: number; opsPerSec: number; perDay: number; cached?: boolean } {
  if (benchCache && Date.now() - benchCache.at < 60_000) {
    return { ...benchCache.res, cached: true };
  }
  ops = Math.min(200_000, Math.max(1_000, Math.floor(ops)));
  const st = genesisState();
  const t0 = Date.now();
  let i = 0;
  while (i < ops) {
    const n = `b${i}`;
    applyOp(st, { type: "transfer", issuer: "treasury", nonce: n, to: "operator", asset: "SAOS", amount: 1 }, t0);
    i++;
    if (i >= ops) break;
    applyOp(st, { type: "pool_swap", issuer: "operator", nonce: `b${i}`, pair: "SAOS/USDS", assetIn: "SAOS", amount: 1000 }, t0);
    i++;
    if (i >= ops) break;
    applyOp(st, { type: "order", issuer: "arena", nonce: `b${i}`, base: "SAOS", quote: "USDS", side: i % 2 ? "buy" : "sell", price: 2500 + (i % 50), amount: 10_000 }, t0);
    i++;
  }
  const ms = Math.max(1, Date.now() - t0);
  const opsPerSec = Math.floor((ops / ms) * 1000);
  const res = { ops, ms, opsPerSec, perDay: opsPerSec * 86_400 };
  benchCache = { at: Date.now(), res };
  // FIX(Roast-63 · L6): אין-עוד-רישום-בנץ' בפנקס-הקבלות-המגובה-חש (היה-מזהם-שרשרת-עדויות-בכל-סקר-ציבורי)
  return res;
}

// FIX(R17-b·M2): reset מקביל — שתי-POST /reset היו עוברות-יחד את-השערים (busy/pendingLoad
// נבדקו-בתחילה אך-לא-נקבעו) → deleteMany-כפול, ג'נזיס-כפול, blockHeader.create-שקט-נכשל
// (dbOk=false-רעש) ו-buildBlock-אחד רץ-מול-rt.st-שהוחלף. עתה: דגל-in-flight נקבע-מיד
// ומשוחרר-ב-finally — ה-reset-השני מקבל-429-כנה.
let resetInFlight = false;

export async function resetChain(): Promise<void> {
  const rt = ensureChain();
  if (resetInFlight) throw new Error("reset-in-flight: another reset is running — retry in a moment (R17-b·M2)");
  // FIX(R15-a · reset-race): reset יכל להחליף rt.st בג'נזיס בזמן ש-buildBlock מושהה
  // על-DB-await-של-המצב-הישן → בלוק-מהמצב-המנותק נכתב-ל-DB-הטרי. עתה: נדחה-כנה
  // בזמן-בנייה (הפעלה-חוזרת אחרי-הטיק-עובדת).
  if (rt.busy) throw new Error("reset deferred: block build in flight — retry in a moment (fail-closed, no torn state)");
  // FIX(R16-a·m5): reset מול-טעינת-אתחול-אסינכרונית — ה-loader היה דורס את הג'נזיס-הטרי
  // בתמונת-המצב (טיפ-מנותק) ומכפיל-טיימר. עתה: נדחה-כנה עד-שהטעינה מסתיימת.
  if (rt.pendingLoad) throw new Error("reset deferred: boot-time snapshot load in flight — retry in a moment (fail-closed)");
  resetInFlight = true;
  try {
    if (rt.timer) clearInterval(rt.timer);
  rt.st = genesisState(); // faucetAt/extClaims/feesSpentMu — כבר-בג'נזיס-הטרי (FIX(Roast-65-a · LOW-11))
  rt.mempool = []; rt.rt = new Map(); rt.tape = [];
  rt.blockHashes = []; rt.seals = []; rt.receipts = [];
  rt.lastReceiptDigest = null; rt.tickCount = 0;
  rt.pendingLift = null; // FIX(Roast-65-a · MED-6): כוונת-סולם של-העידן-הקודם אינה-רלוונטית
  // FIX(SETTLE-7 reset-hygiene): הטבעת-הדגימה לא-נוקתה — אחרי-reset החלון
  // ערבב-עידנים (dh שלילי → שריפה שלילית → ריצה-שלילית = טלמטריה-משקרת —
  // בדיוק-מה-SETTLE-5 ריפא). וגם: chain-מושהית (halted) נשארה-מתה-אחרי-reset
  // (tick מסרב-מוקדם) — reset הוא נתיב-ההתאוששות והוא חייב להעיר.
  // FIX(Roast-64 · evidence-leak-across-reset): טבעת-עדות-המחיר לא נוקתה — אחרי-reset
  // הסולם המשיך-לזוז לפי מסחר-השרשרת-הישנה (עדות-מעורבת של שני עידנים).
  rt.fuelSamples = []; rt.priceSamples = []; rt.buildMsRolling = 0; rt.opsPerSecRolling = 0;
  rt.faucetAtRt = new Map(); // FIX(R15-a): reset = עולם-טרי — cooldown-הברז מתאפס עם-הג'נזיס (התנהגות-היסטורית)
  rt.cachedRoot = null; // FIX(SETTLE-9): cache-השורש מת לפי-גובה — reset מתחיל-גובה-חדש
  rt.halted = false; rt.haltReason = null;
  try {
    await db.blockHeader.deleteMany({});
    await db.sealRecord.deleteMany({});
    await db.evidenceReceipt.deleteMany({});
    await db.arenaJournal.deleteMany({});
  } catch { rt.dbOk = false; }
  try { fs.rmSync(SNAPSHOT_FILE, { force: true }); fs.rmSync(TAPE_FILE, { force: true }); } catch { /* ok */ }
  await buildBlock(rt);
  pushReceipt(rt, "genesis", { root: stateRoot(rt.st), at: Date.now() });
  if (!rt.timer) rt.timer = setInterval(() => void tick(rt), TICK_MS);
  } finally {
    // FIX(R17-b·M2): שחרור-הדגל בכל-נתיב-יציאה — כישלון-DB/בנייה לא נועל-שרשרת-לנצח
    resetInFlight = false;
  }
}

// ─── Task 33 · CLOUD-BEAT: ריצת-הענן חסרת-השרת ───────────────────────────────
// השרשרת עולה ב-GitHub Actions (הריפו הפרטי, אפס-סנדבוקס): טעינת-תמונה מהריפו,
// טיקים סנכרוניים בלי-שעון-קיר (אותם-שערי-busy/halted/pendingLoad של הטיק
// הרגיל — שום עקיפה), שטיפת-תמונה סופית ויציאה נקייה. הריצה ממשיכה את אותה
// שרשרת מאותה-תמונה — הריפו הוא הבית הקנוני של המצב, הענן הוא הבונה.

/** צעד-בודד סנכרוני: ממתין לסוף-הטעינה (עד 60ש') ואז מריץ טיק-אחד מיד. */
export async function stepOnce(): Promise<void> {
  const rt = ensureChain();
  if (rt.pendingLoad) {
    const t0 = Date.now();
    while (rt.pendingLoad && Date.now() - t0 < 60_000) await new Promise((r) => setTimeout(r, 250));
  }
  await tick(rt);
}

/** פעימת-אורקל ידנית (ריצת-ענן: בלי-לחכות לטיימר-ה-60ש׳). force מיישר-את-TTL-הקאש —
 * R23: הריצה-העננית מסתיימת-בשניות, אז בלי-force כל-הקריאות באותה-ריצה מקבלות את-
 * אותו-cache וההחלקה מתבצעת-פעמיים-בלבד-לכל-פעימה. עם-force: פיד-טרי בכל-120-טיקים. */
export async function oracleTickOnce(force = false): Promise<void> {
  const rt = ensureChain();
  await oracleTick(rt, force);
}

/** עצירת לולאות-הקיר (טיימר-3ש׳ + אורקל-60ש׳) — לריצה-עננית נקייה. */
export function stopLoops(): void {
  const rt = ensureChain();
  if (rt.timer) { clearInterval(rt.timer); rt.timer = null; }
  if (rt.oracleTimer) { clearInterval(rt.oracleTimer); rt.oracleTimer = null; }
}

/** שטיפת-תמונה כפויה בסוף-ריצה (בלי לחכות למכפלה-ה-16). */
export function forceFlush(): void {
  const rt = ensureChain();
  flushSnapshot(rt);
}

export { notional, sortBook, LP_ASSET_PREFIX };
