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
  GAS_TABLE, notional, poolKey,
} from "./kernel";
import { merkleRoot, sha256, canon } from "./canonical";
import { invariant, InvariantViolation } from "./invariant";
import { arenaTick, fairPrice, DEFAULT_PARAMS, type ArenaParams, type SoldierRT, MARKETS } from "./mm";
import { railSummary, bindLiveState } from "./rail";
import { milestoneSummary } from "./milestone";
import { poolMid, poolMidFor, getPool, quoteOut, LP_ASSET_PREFIX } from "./amm";
import { sortBook } from "./book";

const TICK_MS = 3_000;
const SEAL_EVERY = 12;   // checkpoint כל-12 בלוקים (CHAIN_SPEC)
const GC_EVERY = 8;
const SNAPSHOT_EVERY = 16;
const LADDER_EVERY = 24;
const TAPE_CAP = 600;
const CHART_CAP = 240;

/** טביעת-קוד (SETTLE-5): נחשפת ב-/api/dex/settle — גילוי-דעיכת-תהליך.
 * תהליך-ישן (דמון ששרד עריכת-קוד בלי-התחלה-מחדש) מריץ קוד-ישן ומדווח גרסה-ישנה —
 * הסתרת-תקלה כזו בדיוק שהטעתה את סבב 2026-09 (POST לא-הטביע למרות-סף-שעבר). */
export const CODE_VERSION = "saos-dex/1.16.0+settle17-milestone-onramp";

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
export interface SealInfo { fromHeight: number; toHeight: number; root: string; stateRoot: string; leaves: number; at: number; digest: string }
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
  faucetAt: Record<string, number>;
  dbOk: boolean;
  halted: boolean; // fail-fast: הפרת-אינווריאנטה מעלה-את-השרשרת (לא בונה בלוקים נוספים)
  haltReason: string | null; // פורנזי — מה בדיוק נתפס (חשוף ב-API)
  version: number;
  cachedRoot: { h: number; root: string } | null; // FIX(SETTLE-9 perf): stateRoot-פר-גובה — getState פר-לקוח לא מחשב-מחדש O(state)
  rejectedLast: { h: number; count: number; sample: string[] } | null; // FIX(SETTLE-15 silent-drop): ראית-דחיות-חיה
}

const g = globalThis as unknown as { __saosDexChain?: ChainRT };
const DATA_DIR = path.join(process.cwd(), "db");
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

async function loadSnapshot(rt: ChainRT): Promise<boolean> {
  try {
    const raw = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8")) as { version: number; state: DexState };
    if (raw?.version === rt.version && raw?.state?.height > 0 && raw.state.pools && raw.state.balances) {
      rt.st = raw.state;
      // ── FIX(escrow-dust) — פיוס-ערבות בעת-טעינה ──
      // (1) נרמול: פקודות-ישנות בלי מד-נעילה מקבלות מד-נגזר (rem/notional(rem))
      for (const o of rt.st.orders) {
        if (typeof o.lockMu !== "number" || !Number.isSafeInteger(o.lockMu) || o.lockMu < 0) {
          const rem = o.amount - o.filled;
          o.lockMu = o.side === "sell" ? rem : notional(o.price, rem);
        }
      }
      // (2) פיוס: locked := Σ מדי-הנעילה של-פקודות-חיות — מחיקת-אבק-רצפה
      // היסטורי (נתפס-ע"י ביקורת-הסליקה; notional-floor אינו-אדיטיבי). האבק
      // חוזר-לזמין — הוא-מעולם לא היה מובטח-לאף-אחד. נרשם-כראיה.
      const orderLocks: Record<string, Record<string, number>> = {};
      for (const o of rt.st.orders) {
        if (!o.live) continue;
        const a = o.side === "sell" ? o.base : o.quote;
        const w = (orderLocks[o.owner] = orderLocks[o.owner] ?? {});
        w[a] = (w[a] ?? 0) + o.lockMu;
      }
      const reconciled: string[] = [];
      for (const [who, wallet] of Object.entries(rt.st.locked)) {
        for (const a of Object.keys(wallet)) {
          const target = orderLocks[who]?.[a] ?? 0;
          if (wallet[a] !== target) {
            reconciled.push(`${who}.${a}:${wallet[a]}→${target}`);
            wallet[a] = target;
          }
        }
      }
      if (reconciled.length > 0) {
        console.info(`[saos-dex] escrow reconcile on load: ${reconciled.join(", ")}`);
        pushReceipt(rt, "escrow-reconcile", { fixed: reconciled, at: Date.now() });
      }
      return true;
    }
  } catch { /* אין-תמונת-מצב — ג'נזיס */ }
  return false;
}

function flushSnapshot(rt: ChainRT): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = SNAPSHOT_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ version: rt.version, savedAt: new Date().toISOString(), state: rt.st }));
    fs.renameSync(tmp, SNAPSHOT_FILE);
    // טייפ: שמירת-זנב-סליל (מורשת WINDOW_FLUSH של grid98)
    fs.writeFileSync(TAPE_FILE, rt.tape.slice(0, 300).map((e) => JSON.stringify(e)).join("\n"));
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
  const root = merkleRoot(rt.blockHashes);
  const info: SealInfo = {
    fromHeight: st.height - rt.blockHashes.length + 1,
    toHeight: st.height,
    root, stateRoot: stateRoot(st),
    leaves: rt.blockHashes.length,
    at: Date.now(),
    digest: "",
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
  // עדי-חיילים: 4 חתימות attest על שורש-החותם (קוורום CHAIN_SPEC=3, אנחנו 4)
  for (const s of ["soldier-1", "soldier-2", "soldier-3", "soldier-4"]) {
    rt.mempool.push({ type: "attest", issuer: s, nonce: sysNonce(st, `att-${s}`), claim: root.slice(0, 16) });
  }
  rt.blockHashes = [];
  try {
    await db.sealRecord.create({
      data: { fromHeight: info.fromHeight, toHeight: info.toHeight, root: info.root, stateRoot: info.stateRoot, leavesCount: info.leaves, note: "SAOS-DEX checkpoint" },
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
    rt.priceSamples.push({ h, base: ev.base, quote: ev.quote, px: ev.price, muQ: Math.floor((ev.amountMu * ev.price) / 1000) });
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
  rt.mempool.push({ type: "harvest", issuer: "treasury", nonce: sysNonce(st, "harv"), amount: harvestMu, memo: `keel-${dir > 0 ? "up" : "down"}` });
  rt.mempool.push({ type: "asset_price", issuer: "treasury", nonce: sysNonce(st, "ladder"), asset: "SAOS", refPrice: newRef });
  st.ladder.refPrice = newRef; // צפי-מקומי (ה-op יאשר על-הספר)
  st.ladder.lastLiftHeight = st.height;
  st.ladder.lifts++;
  st.ladder.spentMu += harvestMu;
  st.stats.ladders++;
  pushReceipt(rt, "keel", { height: st.height, newRef, dir, devBps, step, harvestMu, twap: truth.twap, samples: truth.samples });
}

async function buildBlock(rt: ChainRT): Promise<void> {
  const t0 = Date.now();
  const st = rt.st;
  const ops = rt.mempool.splice(0, 160);
  let applied = 0;
  let rejected = 0;
  const rejSample: string[] = [];
  for (const op of ops) {
    const r = applyOp(st, op, t0);
    if (r.ok) {
      applied++;
      for (const ev of r.events ?? []) rt.tape.unshift({ ...ev, h: st.height });
      feedPriceOracle(rt, r.events, st.height); // SETTLE-14: עדות-מחיר-אמת מכל-מסחר
    } else {
      // FIX(SETTLE-15 silent-drop): דחייה-שקטה הייתה-חור-תפעולי-ישן ("queued" אך-
      // נופלת-בבלוק-בלי-עדה). עכשיו: לוג-מדוד (דגימה-עד-5-פר-בלוק) — כל-דחייה
      // נראית ב-dev.log עם-הסיבה, והמונה-החי-חשוף ב-getState.rejectedLast.
      rejected++;
      if (rejSample.length < 5) rejSample.push(`${op.type}(${(op as { issuer?: string }).issuer ?? "?"}):${r.err}`);
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
    if (e instanceof InvariantViolation) {
      /* ── Fail-Fast מוסדי: הפרת-אינווריאנטה = מצב-עולם לא-מוגדר.
       * השרשרת מעלה-את-עצמה (HALT) — נשארת-חיה לקריאה/תצפית, אך מסרבת
       * לבנות בלוקים נוספים ממצב-חשוד. הזנקת-ALERT קשה לתצפית-תפעולית. */
      rt.halted = true;
      rt.haltReason = String(e.message).slice(0, 300); // פורנזי — חשוף ב-API ושרד-אתחול-מחדש
      if (rt.timer) { clearInterval(rt.timer); rt.timer = null; }
      console.error(`[saos-dex][ALERT] INVARIANT VIOLATION — chain HALTED (fail-fast, refuses undefined state): ${e.message}`);
      return;
    }
    console.error("[saos-dex] tick error:", e instanceof Error ? e.message : e);
  } finally {
    rt.busy = false;
  }
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
    faucetAt: {}, dbOk: true, halted: false, haltReason: null, version: 1,
    cachedRoot: null,
    rejectedLast: null,
  };
  g.__saosDexChain = rt;
  // אתחול-אסינכרוני: תמונת-מצב → אחרת ג'נזיס; אחר-כך טיימר
  void (async () => {
    const loaded = await loadSnapshot(rt);
    if (!loaded) {
      // ג'נזיס-טרי מחייב ניקוי-ראיות-DB (שורות-מריצה-קודמת = עדות-שקרית)
      try {
        await db.blockHeader.deleteMany({});
        await db.sealRecord.deleteMany({});
        await db.evidenceReceipt.deleteMany({});
        await db.arenaJournal.deleteMany({});
      } catch { rt.dbOk = false; }
      // עוגן-ג'נזיס חתום מיד (בלוק-ראשון)
      await buildBlock(rt);
      pushReceipt(rt, "genesis", { root: stateRoot(rt.st), at: Date.now() });
    } else {
      // ראיות-מעבר-לתמונת-המצב הן-שאריות-מריצה-קודמת (נחתמו-אחרי-הסנפלוט האחרון
      // ולא הספיקו-להיכלל) — ניקוי-כנה כדי-שהכתיבה-החוזרת לא תתנגש (unique-height)
      try {
        const stale = await db.blockHeader.deleteMany({ where: { height: { gt: rt.st.height } } });
        if (stale.count > 0) console.info(`[saos-dex] purged ${stale.count} stale block headers beyond snapshot h${rt.st.height} (prior-run evidence)`);
      } catch { rt.dbOk = false; }
    }
    rt.timer = setInterval(() => void tick(rt), TICK_MS);
    console.info(`[saos-dex] chain live · height ${rt.st.height} · root ${stateRoot(rt.st).slice(0, 12)}… ${loaded ? "(snapshot)" : "(genesis)"}`);
  })();
  return rt;
}

// ─── ממשק-ציבורי ────────────────────────────────────────────────────────────

export function submitOp(op: Op): { queued: boolean; reason?: string } {
  const rt = ensureChain();
  if (rt.mempool.length >= 512) return { queued: false, reason: "mempool-full" };
  if (!op.issuer || !op.nonce) return { queued: false, reason: "issuer+nonce-required" };
  if (GAS_TABLE[op.type] === undefined) return { queued: false, reason: "unknown-op" };
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
  const last = rt.faucetAt["operator"] ?? 0;
  if (Date.now() - last < 60_000) return { ok: false, reason: "cooldown-60s" };
  rt.faucetAt["operator"] = Date.now();
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
    };
  });
}

export function getPools() {
  const rt = ensureChain();
  return Object.entries(rt.st.pools).map(([key, p]) => ({
    key, a: p.a, b: p.b, ra: p.ra, rb: p.rb, lp: p.lp,
    mid: poolMid(p), swaps: p.swaps, feeAccruedTreasury: p.feeAccruedTreasury,
    k: p.ra * p.rb,
  }));
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
    const equity =
      (w.balances["USDS"] ?? 0) +
      Math.floor(((w.balances["SAOS"] ?? 0) * fair) / 1000) +
      Object.entries(w.balances)
        .filter(([a]) => a !== "USDS" && a !== "SAOS")
        .reduce((s, [a, v]) => s + Math.floor((v * (st.assets[a]?.refPrice ?? 0)) / 1000), 0);
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
  const soldiers = ["soldier-1", "soldier-2", "soldier-3", "soldier-4"];
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
    leaves: latest ? rt.blockHashes.length : 0,
    receipts: rt.receipts.slice(0, 10),
    howToVerify: [
      "קח את רשימת hashי-הבלוקים (leaves) מה-API",
      "מרקל: לכל זוג sha256(a+b) · מפלג-אי-זוגי העלה-האחרון מוכפל",
      "השווה ל-root — שוויון = הבלוקים כלולים בחותם, בלי לסמוך עלינו",
    ],
    blockWindow: rt.blockHashes.length,
  };
}

export function getLatestSealLeaves(): string[] | null {
  const rt = ensureChain();
  const latest = rt.seals[0];
  if (!latest) return null;
  // העלים של-החותם-האחרון נשמרים-עד-החותם-הבא — אנחנו מחזיקים את-החלון הנוכחי;
  // לשחזור-חוצה-חלון: BlockHeader.hash ב-DB (ראיות-מתמשכות)
  return rt.blockHashes;
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
    ladder: st.ladder,
    liveOrders: st.orders.filter((o) => o.live).length,
    buildMs: rt.buildMsRolling,
    uptimeSec: Math.floor((Date.now() - rt.startedAt) / 1000),
    lastBlockAgoMs: rt.lastBlockAt ? Date.now() - rt.lastBlockAt : null,
    dbOk: rt.dbOk,
    halted: rt.halted === true, // חשיפה-תפעולית: מצב-fail-fast נראה-ב-System Health
    haltReason: rt.haltReason ?? null, // פורנזי: מקור-ה-ALERT (מה בדיוק נתפס)
    rejectedLast: rt.rejectedLast, // SETTLE-15: אפס-דחיות-שקטות — הסיבה-חיה
    tickMs: TICK_MS,
    sealEvery: SEAL_EVERY,
    nextSealIn: SEAL_EVERY - (st.height % SEAL_EVERY),
    backing: st.backing,
    assets: st.assets,
    // SETTLE-15: מקור-הנזיל-שמכניס-מהכל — פנקס-ההכנסה-החי (כנות: הכל-נמדד)
    income: {
      poolFeesMu: Object.values(st.pools).reduce((s, p) => s + p.feeAccruedTreasury, 0),
      feeMeterMu: st.feeMeter,
      treasuryProfitMu: st.treasuryProfit,
      ladderSpentMu: st.ladder?.spentMu ?? 0,
      backingWsteemMu: st.backing["WSTEEM"] ?? 0,
      hub: "USDS", // כל-ראוטר-דרך-האב משלם 30bps → 30% לאוצר
    },
    // SETTLE-16 THE-MICRORAIL: המסילה-הריבונית-למיקרו — תקציב, מנות, פרמיות, P&L
    rail: railSummary(),
    milestone: milestoneSummary(),
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
  const rt = ensureChain();
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
  pushReceipt(rt, "bench", res);
  return res;
}

export async function resetChain(): Promise<void> {
  const rt = ensureChain();
  if (rt.timer) clearInterval(rt.timer);
  rt.st = genesisState();
  rt.mempool = []; rt.rt = new Map(); rt.tape = [];
  rt.blockHashes = []; rt.seals = []; rt.receipts = [];
  rt.lastReceiptDigest = null; rt.tickCount = 0; rt.faucetAt = {};
  // FIX(SETTLE-7 reset-hygiene): הטבעת-הדגימה לא-נוקתה — אחרי-reset החלון
  // ערבב-עידנים (dh שלילי → שריפה שלילית → ריצה-שלילית = טלמטריה-משקרת —
  // בדיוק-מה-SETTLE-5 ריפא). וגם: chain-מושהית (halted) נשארה-מתה-אחרי-reset
  // (tick מסרב-מוקדם) — reset הוא נתיב-ההתאוששות והוא חייב להעיר.
  rt.fuelSamples = []; rt.buildMsRolling = 0; rt.opsPerSecRolling = 0;
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
}

export { notional, sortBook, LP_ASSET_PREFIX };
