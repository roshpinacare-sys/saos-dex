/**
 * grid-beat.ts — THE-REAL-GRID · רץ-הענן של הזרימה החוץ (R24 · צעד-1 בנתיב הכסף)
 * =============================================================================
 * דבר-המפעיל: "איך פותחים את הבורסה והבוטים לעולם הכסף האמיתי, שהנזילות
 * תזרום דרך המערכת שלנו". התשובה של צעד 0 (R23) סגרה את העוגן; צעד 1 הוא
 * הצינור: גריד-אמת שבועי-יומי על ספר-STEEM הפנימי הציבורי — סוחרים אמיתיים,
 * יישוב-על-השרשרת, אפס-עמלת-מסחר — וכל מילוי הוא נזילות חוץ שנספרת בכנות.
 *
 * עקרונות המדיניות (מדודים מול הספר החי, לא תיאוריה):
 *  1. אף-פעם לא מוכרים STEEM מתחת לערכו החיצוני: מדף-המכר נפרש מעל קו-הזהות
 *     steemUsd/sbdUsd (במדידה החיה: פאריטי 0.124 SBD/STEEM מול מיד 0.102 —
 *     ה-SBD נסחר בפרימיום פנימית; מכירה מתחת לקו = הפסד מדוד מול הציון החוץ).
 *     מדף-המכר הוא אופציה חינמית: אם הפרימיות תיסגר — נמכרנו ברווח מדוד.
 *  2. כל קניית-STEEM ב-SBD מתחת לקו-הזהות היא עודף מדוד (+18%-29% במדידה
 *     החיה, וכך גם העסקה המוכחת מ-62: 0.260 SBD -> 2.708 STEEM, +29% מול ציון).
 *  3. דלק-המסילה: תשלומי-powerdown הפעילים של headcorner (מדידה חיה: ~431
 *     SP/שבוע, התשלום הבא ביומן). DIRECTIVE-R24 בתוקף: לא נפתח, לא מוחלף,
 *     לא נוגעים — רק קוראים ומודדים. ה-SP הוא דלק-RC של הצי.
 *  4. רענון יומי-אטומי: מבטלים את ההזמנות שלנו ופורשים גריד מחדש סביב
 *     המציאות החיה. מייקר-בלבד — אף פעם לא חוצים את הספר.
 *  5. אי-חימוש כנה: בלי STEEM_ACTIVE_WIF (סוד-ריפו) אין חתימה ואין שידור —
 *     המצב מתפרסם בגלוי עם הסיבה. שום דבר לא מדומה.
 *
 * אפס-מגע-שרשרת-פנימית: הרץ קורא-בלבד מה-RPC הציבורי + מפרסם dex/grid.json
 * ל-Console. השרשרת הקנונית, ה-dex-beat והספר-החי לא מעורבים כלל.
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
/* R25 · בלם-ההון בזמן-חתימה (owner directive 2026-10-04, trace 1a108e28015b0451):
 * הרץ-הזה מסוגל-הון (realmarket/hivemarket + STEEM/HIVE_ACTIVE_WIF) והיה המסילה
 * האחרונה-שלא-מוקשה בקוד (עד-כה רק שער-workflow). החוק-המעוגן ב-Domain/steem:
 * כל-חותם שואל את-הבלם בטרם-חתימה — fail-closed, קריאה-טרייה בכל-ריצה. */
import { stasisHalt } from "./grids/brake.mjs";

/* ── סביבה לפני-כל-ייבוא-מנוע (אותו-כוח-ולא-ב-??= של-cloud-beat): שומר-ה-db
 * מאמת בטעינת-מודול (שרשרת-הייבוא של-realmarket מגיעה אליו דרך-fleet).
 * הרץ הזה צד-ג': לא כותב ל-db כלל — ההצבה רק מרגיעה את-השומר. */
process.env.DATABASE_URL = `file:${path.join(process.cwd(), "db", "dex.db")}`;

const ROOT = process.cwd();
const LEDGER_FILE = path.join(ROOT, "db", "grid-ledger.json");
const ACCOUNT = process.env.SAOS_RELAY_AGENT_ACCOUNT || "headcorner";

/* ── מדיניות (כולה מדודה מול הספר; שום קסם) ────────────────────────────────── */
const COMMIT_PCT = 0.9;          // לעולם לא מתחייבים על יותר מ-90% מהמלאי הנזיל
const MIN_KEEP_STEEM = 0.5;      // אבק-מינימום שנשאר בחשבון
const MIN_LEVEL_STEEM = 1.0;     // מתחת לזה אין רמה (סינון-אבק)
const MIN_LEVEL_SBD = 0.05;
const BID_LEVELS = 3;            // רמות-קנייה מתחת לביד הטוב
const BID_STEP_BPS = 200;        // מרווח בין רמות (2%)
const ASK_LEVELS = 3;            // רמות-מכירה מעל קו-הזהות החיצוני
const ASK_STEP_BPS = 50;         // 0.5% מעל הקו, ומעלה
const PARITY_BAND_BPS = 5_000;   // סטיית-מיד מול קו-הזהות מעבר ל-50% = ספר/פיד שבור
const EXPIRY_DAYS = 27;          // תקרת-STEEM לתוקף הזמנה

/* ── R99 · מדיניות רגל-HIVE (מיקרו-סקאלות — היתרון המדוד) ────────────────────
 * המלאי החי של headcorner ב-HIVE הוא מיקרו (0.072 HIVE / 0.074 HBD במדידת-R99)
 * — וזה בדיוק יתרון-המיקרו של הרשת: רצפות-אבק בהתאמה, הדוקטרינה לא מתפשרת. */
const HIVE_MIN_KEEP = 0.005;     // אבק שנשאר תמיד בחשבון-HIVE
const HIVE_MIN_LEVEL = 0.010;   // מצומצם — רמה נספרת מ-0.01 HIVE
const HIVE_MIN_LEVEL_HBD = 0.001; // מילי-HBD נספר — ספר-ה-HIVE חי בדיוק ברזולוציה הזו
const HIVE_ASK_MIN_RECV_HBD = 0.2; // R99-מדוד: מילת-הרצף של HBD (0.001) מעוותת מחירי-אבק — רמת-מכירה נספרת רק מ-0.2 HBD (עיוות ≤ 0.5%, כצעד-הפריסה)
const HIVE_BID_LEVELS = 3;
const HIVE_BID_STEP_BPS = 200;   // 2% בין רמות-קנייה
const HIVE_ASK_LEVELS = 3;
const HIVE_ASK_STEP_BPS = 50;    // 0.5% מעל קו-הזהות, ומעלה

interface LedgerOrder {
  id: number; at: string; txid: string; side: "ask" | "bid";
  chain?: "steem" | "hive";      // R99: רב-שרשרתי; v1 ישן = steem
  sell: string; receive: string; priceSbdPerSteem: number;
  status: "open" | "filled" | "cancelled" | "unknown"; lastSeenAt: string;
}
interface LedgerFill {
  key: string; at: string; side: "maker" | "taker"; direction: "sold-steem" | "bought-steem" | "sold-hive" | "bought-hive";
  chain?: "steem" | "hive";      // R99
  paid: string; received: string; steemUsd: number; sbdUsd: number;
  paidUsd: number; recvUsd: number; edgeBps: number;
}
interface GridLedger {
  version: 1 | 2;
  orders: LedgerOrder[];
  fills: LedgerFill[];
  placedTotal: number; filledTotal: number; cancelledTotal: number;
  externalFlowUsd: number; // סכום-נזילות-החוץ הנטו שנספרה (received-paid בדולר ציון)
}
function loadLedger(): GridLedger {
  try {
    const raw = JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8")) as GridLedger;
    if (raw && (raw.version === 1 || raw.version === 2) && Array.isArray(raw.orders) && Array.isArray(raw.fills)) {
      // הגירה v1→v2: כל רשומה קיימת היא STEEM מעצם מהותה עד-R99
      for (const o of raw.orders) if (!o.chain) o.chain = "steem";
      for (const f of raw.fills) if (!f.chain) f.chain = "steem";
      raw.version = 2;
      return raw;
    }
  } catch { /* ראשון */ }
  return { version: 2, orders: [], fills: [], placedTotal: 0, filledTotal: 0, cancelledTotal: 0, externalFlowUsd: 0 };
}
function saveLedger(l: GridLedger): void {
  l.orders = l.orders.slice(-300);
  l.fills = l.fills.slice(-300);
  fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
  const tmp = LEDGER_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(l, null, 1));
  fs.renameSync(tmp, LEDGER_FILE);
}

/* ── עזרי-git (הריצה חיה בתוך-checkout של-Actions) ─────────────────────────── */
function git(args: string, opts: { allowFail?: boolean; cwd?: string } = {}): string {
  try {
    return execSync(`git ${args}`, { encoding: "utf8", cwd: opts.cwd ?? ROOT, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    if (opts.allowFail) return "";
    throw e;
  }
}
async function pushWithRetry(dir: string, branch: string, tries = 3): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      execSync(`git push origin ${branch}`, { encoding: "utf8", cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
      return true;
    } catch {
      try { execSync(`git pull --rebase --autostash origin ${branch}`, { encoding: "utf8", cwd: dir, stdio: ["ignore", "pipe", "pipe"] }); } catch { /* שוב */ }
      await new Promise((r) => setTimeout(r, 1_500));
    }
  }
  return false;
}

const dp3 = (v: number): string => v.toFixed(3);
function sbdPerSteemOf(sellSteem: number, minSbd: number): number {
  return sellSteem > 0 ? minSbd / sellSteem : 0;
}

/* ═════════════════════════════ main ═════════════════════════════ */
async function main(): Promise<void> {
  const t0 = Date.now();
  console.log(`[grid-beat] boot · account=${ACCOUNT} · steem-armed=${process.env.STEEM_ACTIVE_WIF ? "yes" : "no (honest)"} · hive-armed=${process.env.HIVE_ACTIVE_WIF ? "yes" : "no (honest)"}`);

  const rm = await import("./src/lib/dex/realmarket");
  const pp = await import("./src/lib/dex/price-proof");
  const { realSnapshotSoft, activeWif } = rm as unknown as {
    realSnapshotSoft: () => Promise<Record<string, unknown>>;
    activeWif: () => string | null;
  };
  const extFeeds = (pp as unknown as { extFeeds: (force?: boolean) => Promise<{ ok: boolean; usd: { steem: number | null; sbd: number | null; hive: number | null; hbd: number | null } }> }).extFeeds;

  const snapRaw = await realSnapshotSoft();
  if (!("ok" in snapRaw) || snapRaw.ok !== true) {
    console.error(`[grid-beat] snapshot failed honestly: ${String((snapRaw as { error?: string }).error ?? "?")}`);
    process.exit(0); // כישלון-כנה: לא פעולה, לא פרסום שקרי
  }
  const snap = snapRaw as {
    balances: { steem: number; sbd: number };
    powerdown: { active: boolean; weeklySp: number; remainingSp: number; remainingWeeks: number; nextPayout: string | null; rcFuelSp: number };
    book: { bestBid: number | null; bestAsk: number | null; mid: number | null; spreadBps: number | null };
    openOrders: { id: number; sell: string; receive: string; price: string; created: string }[];
    fills: { at: string; side: string; paid: string; received: string; price: string; openOrderid?: number; currentOrderid?: number }[];
    verdict: string;
  };

  const feeds = await extFeeds(true).catch(() => null);
  const steemUsd = feeds?.usd.steem ?? null;
  const sbdUsd = feeds?.usd.sbd ?? null;
  const parity = steemUsd && sbdUsd && steemUsd > 0 && sbdUsd > 0 ? steemUsd / sbdUsd : null; // SBD ל-1-STEEM בזהות-חוץ

  const ledger = loadLedger();
  const armed = !!activeWif();

  /* ── הפעולות (רק כשחמוש וכשהספר והמדדים חיים) ── */
  let placed = 0, cancelled = 0;
  const blocker: string[] = [];
  if (!armed) blocker.push("STEEM_ACTIVE_WIF secret missing: one operator action to arm the external grid");
  if (!parity) blocker.push("external USD marks unavailable (steem/sbd feeds down): no marking, no trading");
  if (!snap.book.bestBid || !snap.book.bestAsk) blocker.push("public book one-sided or unreachable");
  if (parity && snap.book.mid) {
    const devBps = Math.floor(((snap.book.mid - parity) / parity) * 10_000);
    if (Math.abs(devBps) > PARITY_BAND_BPS) blocker.push(`book mid deviates ${devBps}bps from external parity: refusing to trade a broken market`);
  }
  /* R25 · שער-STASIS: הבלם נקרא טרי בכל-ריצה, לפני-כל-מסילת-חתימה —
   * active=true → חוסם-כנה (no-op בריא) עם הסיבה-מפורסמת בגלוי. */
  if (stasisHalt("grid-beat:steem")) blocker.push("STASIS capital brake active (owner directive 2026-10-04): signing lanes halt — see grids/state/STASIS.json");

  if (armed && parity && snap.book.bestBid && snap.book.bestAsk && blocker.length === 0) {
    const { realPlaceOrder, realCancelOrder } = rm as unknown as {
      realPlaceOrder: (p: { orderid: number; amountToSell: string; minToReceive: string; expirationDays?: number }) => Promise<{ txid: string; block: number | null }>;
      realCancelOrder: (orderid: number) => Promise<{ txid: string; block: number | null }>;
    };

    /* Z-81 · שני-שערים-חדשים על-בסיס-פענוח-הפקודות-שלנו מהתמונה:
     * (1) שימור-תור — סולם שלם-ומעל-קו-הערך לא מבוטל (ביטול-הצבה כל-30-דק'
     *     שורף-RC ומאבד-מקום-בתור-ההתאמה — המיקרו-מבנה המדוד-חי); רענון רק
     *     כשנעקפנו-מהמגע או כשקו-הערך עלה מעל האסק-שלנו.
     * (2) תיקון-רעב-האסקים — הדלק נמדד אחרי-הביטולים: ה-STEEM/SBD הנעולים
     *     בפקודות-שלנו חוזרים-לנזיל עם הביטול, ולכן נספרים. הבאג החי-שנמדד:
     *     צילום-מצב לפני-ביטול → 24 STEEM נעולים נראו "אפס-דלק" → האסקים
     *     נבלעו והסולם נשאר בלי-צד-מכירה שעות. */
    const amtOfStr = (s: string): number => parseFloat(String(s).replace(/[A-Za-z ]+/g, "")) || 0;
    const ourAsks = snap.openOrders.filter((o) => o.sell.includes("STEEM")).map((o) => ({ id: o.id, px: amtOfStr(o.receive) / amtOfStr(o.sell), steem: amtOfStr(o.sell) }));
    const ourBids = snap.openOrders.filter((o) => o.sell.includes("SBD")).map((o) => ({ id: o.id, px: amtOfStr(o.sell) / amtOfStr(o.receive), sbd: amtOfStr(o.sell) }));
    const bestOurAsk = ourAsks.length ? Math.min(...ourAsks.map((a) => a.px)) : null;
    const bestOurBid = ourBids.length ? Math.max(...ourBids.map((b) => b.px)) : null;
    const TOUCH_EPS = 1e-4; // סובלנות-השוואת-מגע (0.01%)
    const ownsAsk = bestOurAsk != null && Math.abs(bestOurAsk - snap.book.bestAsk) <= snap.book.bestAsk * TOUCH_EPS;
    const ownsBid = bestOurBid != null && Math.abs(bestOurBid - snap.book.bestBid) <= snap.book.bestBid * TOUCH_EPS;
    const askValueLine = parity * (1 + ASK_STEP_BPS / 10_000);
    const ladderIntact = ownsAsk && ownsBid && bestOurAsk !== null && bestOurAsk >= askValueLine && bestOurBid !== null && bestOurBid <= parity;

    if (ladderIntact) {
      console.log(`[grid-beat] ladder intact & above value line — queue preserved · ask ${bestOurAsk?.toFixed(5)} ≥ ${askValueLine.toFixed(5)} · bid ${bestOurBid?.toFixed(5)} ≤ parity ${parity.toFixed(5)} · ${snap.openOrders.length} orders untouched`);
    } else {
    /* 1) ביטול ההזמנות שלנו — רענון אטומי */
    for (const o of snap.openOrders) {
      try {
        await realCancelOrder(o.id);
        cancelled++;
        const rec = ledger.orders.find((x) => x.id === o.id);
        if (rec) { rec.status = "cancelled"; rec.lastSeenAt = new Date().toISOString(); }
        console.log(`[grid-beat] cancelled #${o.id} (${o.sell} -> ${o.receive})`);
      } catch (e) {
        console.warn(`[grid-beat] cancel #${o.id} failed: ${String(e).slice(0, 80)}`);
      }
    }

    /* Z-81 התאמת-מעקה: פקודה שנרשמה פתוחה אבל כבר לא על-השרשרת (נאכלה/
     * פגה/בוטלה ע"י-רץ-אח) — נחשפת בכנות כ-unknown, לא ממשיכה להיספר פתוחה. */
    for (const rec of ledger.orders) {
      if (rec.chain !== "hive" && rec.status === "open" && !snap.openOrders.some((o) => o.id === rec.id)) {
        rec.status = "unknown";
        rec.lastSeenAt = new Date().toISOString();
      }
    }

    /* 2) פריסת הגריד */
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    let seq = 1;
    const nextId = (): number => {
      let id = Number(today) * 100 + seq;
      while (ledger.orders.some((x) => x.id === id)) { seq++; id = Number(today) * 100 + seq; }
      return id;
    };

    // מדף-המכירה: מעל קו-הזהות החיצוני — אף-פעם לא מתחת (עיקרון 1)
    // Z-81: הדלק = נזיל-עכשיו + מה שהביטולים-שביצענו-מעלה מחזירים (אסקים נעולים)
    const steemReturned = ourAsks.reduce((s, a) => s + a.steem, 0);
    const steemAvail = snap.balances.steem + steemReturned - MIN_KEEP_STEEM;
    const steemCommit = Math.max(0, Math.floor(steemAvail * COMMIT_PCT * 1000) / 1000);
    if (steemCommit >= MIN_LEVEL_STEEM * ASK_LEVELS) {
      const per = Math.floor((steemCommit / ASK_LEVELS) * 1000) / 1000;
      /* Z-80 חוק-הספר: רמה-1 נהדקת אל המגע-החי אם-הפאריטי מתחתיו; הרמות נפרשות
       * כלפי-מעלה מהבסיס-המהודק — אף-אסק לא נופל מתחת ל-bestAsk (אין-taker-דימום). */
      const touchAsk = snap.book.bestAsk ?? 0;
      const baseAsk = Math.max(parity * (1 + ASK_STEP_BPS / 10_000), touchAsk);
      for (let k = 1; k <= ASK_LEVELS; k++) {
        const px = baseAsk * (1 + (ASK_STEP_BPS * (k - 1)) / 10_000);
        const sellAmt = per;
        const recv = Math.floor(sellAmt * px * 1000) / 1000;
        if (recv < MIN_LEVEL_SBD) continue;
        const id = nextId(); seq++;
        try {
          const r = await realPlaceOrder({ orderid: id, amountToSell: `${dp3(sellAmt)} STEEM`, minToReceive: `${dp3(recv)} SBD`, expirationDays: EXPIRY_DAYS });
          placed++;
          ledger.orders.push({ id, at: new Date().toISOString(), txid: r.txid, side: "ask", sell: `${dp3(sellAmt)} STEEM`, receive: `${dp3(recv)} SBD`, priceSbdPerSteem: sbdPerSteemOf(sellAmt, recv), status: "open", lastSeenAt: new Date().toISOString() });
          console.log(`[grid-beat] ask #${id}: ${dp3(sellAmt)} STEEM -> ${dp3(recv)} SBD @${px.toFixed(6)} (parity+${(ASK_STEP_BPS * k) / 100}%) txid ${r.txid.slice(0, 12)}`);
        } catch (e) {
          console.warn(`[grid-beat] ask #${id} rejected: ${String(e).slice(0, 90)}`);
        }
      }
    } else {
      blocker.push(`sell-side waiting for fuel: ${steemCommit.toFixed(3)} STEEM commitable < ${MIN_LEVEL_STEEM * ASK_LEVELS} needed (next powerdown: ${snap.powerdown.nextPayout ?? "?"})`);
    }

    // מדף-הקנייה: מתחת לביד הטוב — כולן מעל-ערך מדוד מול הציון (עיקרון 2)
    // Z-81: גם-כאן — ה-SBD הנעול בבידים-שבוטלו חוזר לפני-ההצבה
    const sbdReturned = ourBids.reduce((s, b) => s + b.sbd, 0);
    const sbdCommit = Math.max(0, Math.floor((snap.balances.sbd + sbdReturned) * COMMIT_PCT * 1000) / 1000);
    if (sbdCommit >= MIN_LEVEL_SBD * BID_LEVELS && snap.book.bestBid) {
      const per = Math.floor((sbdCommit / BID_LEVELS) * 1000) / 1000;
      for (let k = 1; k <= BID_LEVELS; k++) {
        // Z-80: ביד לא עולה על המגע — תמיד (כפול-ביטחון; הנוסחה כבר מתחתיו)
        const px = Math.min(snap.book.bestBid * (1 - (BID_STEP_BPS * k) / 10_000), snap.book.bestBid);
        const recv = Math.floor(per / px * 1000) / 1000; // STEEM
        if (recv < MIN_LEVEL_STEEM) continue;
        const id = nextId(); seq++;
        try {
          const r = await realPlaceOrder({ orderid: id, amountToSell: `${dp3(per)} SBD`, minToReceive: `${dp3(recv)} STEEM`, expirationDays: EXPIRY_DAYS });
          placed++;
          ledger.orders.push({ id, at: new Date().toISOString(), txid: r.txid, side: "bid", sell: `${dp3(per)} SBD`, receive: `${dp3(recv)} STEEM`, priceSbdPerSteem: px, status: "open", lastSeenAt: new Date().toISOString() });
          console.log(`[grid-beat] bid #${id}: ${dp3(per)} SBD -> ${dp3(recv)} STEEM @${px.toFixed(6)} txid ${r.txid.slice(0, 12)}`);
        } catch (e) {
          console.warn(`[grid-beat] bid #${id} rejected: ${String(e).slice(0, 90)}`);
        }
      }
    } else {
      blocker.push(`buy-side waiting for SBD inventory: ${sbdCommit.toFixed(3)} SBD commitable < ${(MIN_LEVEL_SBD * BID_LEVELS).toFixed(2)} needed`);
    }
    } /* סוף-מסלול-הרענון (Z-81: שימור-תור מדלג על ביטול+פריסה בשלמותם) */
  }

  /* 3) הצלבת-מילויים: כל fill_order שלנו נספר במעקה עם ציון-דולר-חי */
  if (steemUsd && sbdUsd) {
    for (const f of snap.fills) {
      const key = `${f.at}|${f.paid}|${f.received}`;
      if (ledger.fills.some((x) => x.key === key)) continue;
      const amtOf = (s: string): number => parseFloat(String(s).replace(/[A-Za-z ]+/g, "")) || 0;
      const paidAmt = amtOf(f.paid), recvAmt = amtOf(f.received);
      const paidSteem = f.paid.includes("STEEM"), recvSteem = f.received.includes("STEEM");
      if (!paidSteem && !recvSteem) continue;
      const paidUsd = paidSteem ? paidAmt * steemUsd : paidAmt * sbdUsd;
      const recvUsd = recvSteem ? recvAmt * steemUsd : recvAmt * sbdUsd;
      const edgeBps = paidUsd > 0 ? Math.floor(((recvUsd - paidUsd) / paidUsd) * 10_000) : 0;
      ledger.fills.push({
        key, at: f.at, side: f.side === "maker" ? "maker" : "taker",
        direction: recvSteem ? "bought-steem" : "sold-steem",
        paid: f.paid, received: f.received, steemUsd, sbdUsd, paidUsd, recvUsd, edgeBps,
      });
      const oid = f.openOrderid ?? f.currentOrderid;
      if (oid) {
        const rec = ledger.orders.find((x) => x.id === oid && x.status === "open");
        if (rec) { rec.status = "filled"; rec.lastSeenAt = new Date().toISOString(); ledger.filledTotal++; }
      }
      ledger.externalFlowUsd = Math.round((ledger.externalFlowUsd + (recvUsd - paidUsd)) * 1e6) / 1e6;
      console.log(`[grid-beat] REAL FILL counted: ${f.paid} -> ${f.received} · edge ${edgeBps}bps vs live marks (marked-at-detection)`);
    }
  }
  /* ── R99 · רגל-HIVE — אותה דוקטרינה, אותו חוק, שוק-פנימי אמת שני ─────────── */
  const hm = await import("./src/lib/dex/hivemarket");
  const hiveUsd = feeds?.usd.hive ?? null;
  const hbdUsd = feeds?.usd.hbd ?? null;
  const hiveParity = hiveUsd && hbdUsd && hiveUsd > 0 && hbdUsd > 0 ? hiveUsd / hbdUsd : null; // HBD ל-1-HIVE בזהות-חוץ
  let hivePlaced = 0, hiveCancelled = 0;
  const hiveBlocker: string[] = [];
  let hiveLeg: Record<string, unknown>;
  const hsnapRaw = await hm.hiveSnapshotSoft();
  if (!("ok" in hsnapRaw) || hsnapRaw.ok !== true) {
    const err = String((hsnapRaw as { error?: string }).error ?? "?");
    hiveBlocker.push(`hive snapshot failed honestly: ${err}`);
    hiveLeg = { ok: false, chain: "HIVE-internal-market", error: err };
    console.error(`[grid-beat] hive snapshot failed honestly: ${err}`);
  } else {
    const hs = hsnapRaw as Exclude<typeof hsnapRaw, { ok: false }>;
    const hiveArmed = hm.hiveActiveWif() !== null;
    if (!hiveArmed) hiveBlocker.push("HIVE_ACTIVE_WIF secret missing (R99: או שהרץ הזה מקומי בלי הסוד, או שהכספת נקתה — כנות, לא סימולציה)");
    /* R25 · שער-STASIS גם על רגל-ה-HIVE — אותו-בלם, אותו-חוק */
    if (stasisHalt("grid-beat:hive")) hiveBlocker.push("STASIS capital brake active (owner directive 2026-10-04): signing lanes halt — see grids/state/STASIS.json");
    if (hiveArmed && hs.authorityOk === false) hiveBlocker.push("hive key does not derive the live active authority — refusing to trade (fail-closed)");
    if (!hs.rc.ok) hiveBlocker.push(hs.rc.reason ?? "hive rc gated (honest skip)");
    if (!hiveParity) hiveBlocker.push("external USD marks unavailable (hive/hbd feeds down): no marking, no trading");
    if (!hs.book.bestBid || !hs.book.bestAsk) hiveBlocker.push("hive public book one-sided or unreachable");
    if (hiveParity && hs.book.mid) {
      const devBps = Math.floor(((hs.book.mid - hiveParity) / hiveParity) * 10_000);
      if (Math.abs(devBps) > PARITY_BAND_BPS) hiveBlocker.push(`hive book mid deviates ${devBps}bps from external parity: refusing to trade a broken market`);
    }

    if (hiveArmed && hiveParity && hs.book.bestBid && hs.book.bestAsk && hs.rc.ok && hiveBlocker.length === 0) {
      /* 1) ביטול ההזמנות שלנו — רענון אטומי (HIVE) */
      for (const o of hs.openOrders) {
        try {
          await hm.hiveCancelOrder(o.id);
          hiveCancelled++;
          const rec = ledger.orders.find((x) => x.id === o.id && x.chain === "hive");
          if (rec) { rec.status = "cancelled"; rec.lastSeenAt = new Date().toISOString(); }
          console.log(`[grid-beat] hive cancelled #${o.id} (${o.sell} -> ${o.receive})`);
        } catch (e) {
          console.warn(`[grid-beat] hive cancel #${o.id} failed: ${String(e).slice(0, 80)}`);
        }
      }

      /* 2) פריסת הגריד — HIVE */
      const todayH = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      let hseq = 1;
      const nextHiveId = (): number => {
        let id = Number(todayH) * 100 + hseq;
        while (ledger.orders.some((x) => x.id === id && x.chain === "hive")) { hseq++; id = Number(todayH) * 100 + hseq; }
        return id;
      };

      // מדף-המכירה: מעל קו-הזהות החיצוני — לעולם לא מתחת (עיקרון 1, גם ב-HIVE)
      const hiveAvail = hs.balances.hive - HIVE_MIN_KEEP;
      const hiveCommit = Math.max(0, Math.floor(hiveAvail * COMMIT_PCT * 1000) / 1000);
      if (hiveCommit >= HIVE_MIN_LEVEL * HIVE_ASK_LEVELS) {
        const per = Math.floor((hiveCommit / HIVE_ASK_LEVELS) * 1000) / 1000;
        for (let k = 1; k <= HIVE_ASK_LEVELS; k++) {
          const px = hiveParity * (1 + (HIVE_ASK_STEP_BPS * k) / 10_000);
          const sellAmt = per;
          // R99-מדוד (מילויים חיים על השרשרת): הרצפה על 0.001 HBD הפילה את מחיר האבק מתחת
          // לכוונה — מכירה מתחת לערך אסורה. עתה: ceil על התקבול (לעולם לא מתחת לכוונה)
          // + רמה שהמיל-צעד שלה מעוות את המחיר ביותר מ-0.5% נדלגת בכנות.
          const recvTrue = sellAmt * px;
          const recv = Math.ceil(recvTrue * 1000) / 1000;
          if (recv < HIVE_ASK_MIN_RECV_HBD) continue; // גרעיניות-מחיר לא נשמרת — המלאי בונה
          if (recv / recvTrue > 1.005) continue; // עיוות-מיל מעבר לצעד הפריסה — דלג בכנות
          const id = nextHiveId(); hseq++;
          try {
            const r = await hm.hivePlaceOrder({ orderid: id, amountToSell: `${dp3(sellAmt)} HIVE`, minToReceive: `${dp3(recv)} HBD`, expirationDays: EXPIRY_DAYS });
            hivePlaced++;
            ledger.orders.push({ id, at: new Date().toISOString(), txid: r.txid, side: "ask", chain: "hive", sell: `${dp3(sellAmt)} HIVE`, receive: `${dp3(recv)} HBD`, priceSbdPerSteem: px, status: "open", lastSeenAt: new Date().toISOString() });
            console.log(`[grid-beat] hive ask #${id}: ${dp3(sellAmt)} HIVE -> ${dp3(recv)} HBD @${px.toFixed(6)} (parity+${(HIVE_ASK_STEP_BPS * k) / 100}%) txid ${r.txid.slice(0, 12)}`);
          } catch (e) {
            console.warn(`[grid-beat] hive ask #${id} rejected: ${String(e).slice(0, 90)}`);
          }
        }
      } else {
        hiveBlocker.push(`hive sell-side waiting for price-grade inventory: ${hiveCommit.toFixed(3)} HIVE commitable; ask levels need ≥ ${HIVE_ASK_MIN_RECV_HBD} HBD recv each (HBD mill-tick price fidelity, measured R99)`);
      }

      // מדף-הקנייה: מתחת לביד הטוב — כולן מעל-ערך מדוד מול הציון (עיקרון 2, גם ב-HIVE)
      const hbdCommit = Math.max(0, Math.floor(hs.balances.hbd * COMMIT_PCT * 1000) / 1000);
      if (hbdCommit >= HIVE_MIN_LEVEL_HBD * HIVE_BID_LEVELS && hs.book.bestBid) {
        const per = Math.floor((hbdCommit / HIVE_BID_LEVELS) * 1000) / 1000;
        for (let k = 1; k <= HIVE_BID_LEVELS; k++) {
          const px = hs.book.bestBid * (1 - (HIVE_BID_STEP_BPS * k) / 10_000);
          // חוק-הזהות (R99): רק קנייה מתחת לקו-הזהות החיצוני נספרת כעודף —
          // רמה מעל הקו (פרימיום-HBD חריגה) נדלגת בכנות. לעולם לא משלמים מעל-ערך.
          if (hiveParity !== null && px >= hiveParity) continue;
          const recv = Math.floor(per / px * 1000) / 1000; // HIVE
          if (recv < HIVE_MIN_LEVEL) continue;
          const id = nextHiveId(); hseq++;
          try {
            const r = await hm.hivePlaceOrder({ orderid: id, amountToSell: `${dp3(per)} HBD`, minToReceive: `${dp3(recv)} HIVE`, expirationDays: EXPIRY_DAYS });
            hivePlaced++;
            ledger.orders.push({ id, at: new Date().toISOString(), txid: r.txid, side: "bid", chain: "hive", sell: `${dp3(per)} HBD`, receive: `${dp3(recv)} HIVE`, priceSbdPerSteem: px, status: "open", lastSeenAt: new Date().toISOString() });
            console.log(`[grid-beat] hive bid #${id}: ${dp3(per)} HBD -> ${dp3(recv)} HIVE @${px.toFixed(6)} txid ${r.txid.slice(0, 12)}`);
          } catch (e) {
            console.warn(`[grid-beat] hive bid #${id} rejected: ${String(e).slice(0, 90)}`);
          }
        }
      } else {
        hiveBlocker.push(`hive buy-side waiting for HBD inventory: ${hbdCommit.toFixed(3)} HBD commitable < ${(HIVE_MIN_LEVEL_HBD * HIVE_BID_LEVELS).toFixed(3)} needed`);
      }
    }

    /* 3) הצלבת-מילויים HIVE — כל fill_order שלנו נספר במעקה עם ציון-דולר-חי */
    if (hiveUsd && hbdUsd) {
      for (const f of hs.fills) {
        const key = `hive|${f.at}|${f.paid}|${f.received}`;
        if (ledger.fills.some((x) => x.key === key)) continue;
        const amtOf = (s: string): number => parseFloat(String(s).replace(/[A-Za-z ]+/g, "")) || 0;
        const paidAmt = amtOf(f.paid), recvAmt = amtOf(f.received);
        const paidHive = f.paid.includes("HIVE"), recvHive = f.received.includes("HIVE");
        if (!paidHive && !recvHive) continue;
        const paidUsd = paidHive ? paidAmt * hiveUsd : paidAmt * hbdUsd;
        const recvUsd = recvHive ? recvAmt * hiveUsd : recvAmt * hbdUsd;
        const edgeBps = paidUsd > 0 ? Math.floor(((recvUsd - paidUsd) / paidUsd) * 10_000) : 0;
        ledger.fills.push({
          key, at: f.at, side: f.side === "maker" ? "maker" : "taker", chain: "hive",
          direction: recvHive ? "bought-hive" : "sold-hive",
          paid: f.paid, received: f.received, steemUsd: hiveUsd, sbdUsd: hbdUsd, paidUsd, recvUsd, edgeBps,
        });
        const oid = f.openOrderid ?? f.currentOrderid;
        if (oid) {
          const rec = ledger.orders.find((x) => x.id === oid && x.chain === "hive" && x.status === "open");
          if (rec) { rec.status = "filled"; rec.lastSeenAt = new Date().toISOString(); ledger.filledTotal++; }
        }
        ledger.externalFlowUsd = Math.round((ledger.externalFlowUsd + (recvUsd - paidUsd)) * 1e6) / 1e6;
        console.log(`[grid-beat] HIVE REAL FILL counted: ${f.paid} -> ${f.received} · edge ${edgeBps}bps vs live marks (marked-at-detection)`);
      }
    }

    hiveLeg = {
      ok: true,
      publishedAt: new Date().toISOString(),
      chain: "HIVE-internal-market",
      real: true,
      armed: hiveArmed,
      authorityOk: hs.authorityOk,
      rc: hs.rc,
      verdict: !hiveArmed ? "DISARMED-NO-KEY" : hivePlaced > 0 ? "ARMED-LIVE" : hiveBlocker.length ? "ARMED-WAITING" : "ARMED-STABLE",
      blocker: hiveBlocker.length ? hiveBlocker : null,
      marks: { hiveUsd, hbdUsd, parityHbdPerHive: hiveParity },
      inventory: { hive: hs.balances.hive, hbd: hs.balances.hbd, hp: hs.balances.hpOwn },
      book: hs.book,
      openOrdersNow: hs.openOrders.length,
      run: { placed: hivePlaced, cancelled: hiveCancelled },
      fills: hs.fills.slice(-8),
      powerdown: hs.powerdown,
    };
  }

  ledger.placedTotal += placed + hivePlaced;
  ledger.cancelledTotal += cancelled + hiveCancelled;
  saveLedger(ledger);

  /* ── הפרסום הציבורי: dex/grid.json ב-Console ── */
  const openNow = snap.openOrders.filter(() => true).length; // נספר מהתמונה שלפני-הפעולות; הריצה הבאה מראה את החדשות
  const publicDoc = {
    ok: true,
    publishedAt: new Date().toISOString(),
    engine: "saos-dex/1.1 grid-beat · R24 external flow + R99 HIVE leg",
    account: ACCOUNT,
    chain: "STEEM-internal-market",
    chains: ["STEEM", "HIVE"],
    real: true,
    armed,
    verdict: !armed ? "DISARMED-NO-KEY" : placed + hivePlaced > 0 ? "ARMED-LIVE" : blocker.length ? "ARMED-WAITING" : "ARMED-STABLE",
    blocker: blocker.length ? blocker : null,
    hive: hiveLeg,
    policy: {
      principle: "never sell STEEM below its external USD value; every buy below parity is measured surplus",
      commitPct: COMMIT_PCT, bidLevels: BID_LEVELS, bidStepBps: BID_STEP_BPS,
      askLevels: ASK_LEVELS, askStepBps: ASK_STEP_BPS, expiryDays: EXPIRY_DAYS,
      directiveR24: "powerdown is read-only here: never opened, never replaced, fleet RC is sacred",
    },
    marks: { steemUsd, sbdUsd, paritySbdPerSteem: parity },
    fuel: {
      powerdownActive: snap.powerdown.active,
      weeklySp: snap.powerdown.weeklySp,
      weeklyUsd: snap.powerdown.weeklySp && steemUsd ? Math.round(snap.powerdown.weeklySp * steemUsd * 100) / 100 : null,
      remainingSp: snap.powerdown.remainingSp,
      remainingWeeks: snap.powerdown.remainingWeeks,
      nextPayout: snap.powerdown.nextPayout,
      rcFuelSp: snap.powerdown.rcFuelSp,
    },
    inventory: { steem: snap.balances.steem, sbd: snap.balances.sbd },
    book: snap.book,
    openOrdersNow: openNow,
    run: { placed, cancelled, placedTotal: ledger.placedTotal, cancelledTotal: ledger.cancelledTotal, filledTotal: ledger.fills.length },
    externalFlowUsd: ledger.externalFlowUsd,
    fills: ledger.fills.slice(-12),
    orders: ledger.orders.slice(-24),
    vault: {
      // R99: מצב הכספת כפי שהרץ רואה אותו — כנות מלאה על מה שחמוש
      steemActive: !!process.env.STEEM_ACTIVE_WIF,
      steemPosting: !!process.env.STEEM_POSTING_WIF,
      hiveActive: !!process.env.HIVE_ACTIVE_WIF,
      hivePosting: !!process.env.HIVE_POSTING_WIF,
      blurtActive: !!process.env.BLURT_ACTIVE_WIF,
    },
    honesty: "מדוד מול ספר-STEEM הציבורי ופידי-USD חיים. מילויים מסומנים בזמן-הגילוי (marked-at-detection); המעקה מתעד את הציון שנמדד. ה-SBD הפנימי נסחר בפרימיום מול הציון החיצוני; קו-הזהות מוצג בגלוי כדי שכל אחד יוכל לאמת שאנחנו לא מוכרים מתחת לערך.",
  };

  const CONSOLE_TOKEN = process.env.CONSOLE_TOKEN ?? "";
  fs.writeFileSync(path.join(ROOT, "db", "grid-public.json"), JSON.stringify(publicDoc, null, 1));
  if (!CONSOLE_TOKEN) {
    console.warn("[grid-beat] CONSOLE_TOKEN missing — public grid state NOT published (ledger committed)");
  } else {
    const PUB = "/tmp/console-grid";
    execSync(`rm -rf ${PUB} && git clone --depth 5 -q https://x-access-token:${CONSOLE_TOKEN}@github.com/roshpinacare-sys/Console.git ${PUB}`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    fs.mkdirSync(path.join(PUB, "dex"), { recursive: true });
    fs.writeFileSync(path.join(PUB, "dex", "grid.json"), JSON.stringify(publicDoc));
    execSync('git config user.name "grid-beat[bot]"', { encoding: "utf8", cwd: PUB });
    execSync('git config user.email "grid-beat[bot]@users.noreply.github.com"', { encoding: "utf8", cwd: PUB });
    execSync("git add dex/grid.json", { encoding: "utf8", cwd: PUB, stdio: ["ignore", "pipe", "pipe"] });
    const staged = execSync("git diff --cached --name-only", { encoding: "utf8", cwd: PUB }).trim();
    if (staged) {
      execSync(`git commit -m "grid-beat: ${placed + hivePlaced} placed (steem ${placed} / hive ${hivePlaced}) · ${cancelled + hiveCancelled} cancelled · ${new Date().toISOString().slice(0, 16)}Z"`, { encoding: "utf8", cwd: PUB, stdio: ["ignore", "pipe", "pipe"] });
      const ok = await pushWithRetry(PUB, "main");
      console.log(`[grid-beat] public grid state ${ok ? "published" : "PUSH FAILED (next run retries)"}`);
    } else {
      console.log("[grid-beat] public grid state unchanged");
    }
  }

  /* ── המעקה לריפו (הבית הקנוני) ── */
  git('config user.name "grid-beat[bot]"', { allowFail: true });
  git('config user.email "grid-beat[bot]@users.noreply.github.com"', { allowFail: true });
  git("add -- db/grid-ledger.json db/grid-public.json", { allowFail: true });
  const staged = git("diff --cached --name-only", { allowFail: true });
  if (staged) {
    git(`commit -m "grid-beat: ${placed + hivePlaced} placed (steem ${placed} / hive ${hivePlaced}) · ${cancelled + hiveCancelled} cancelled · ${ledger.fills.length} fills counted · ${new Date().toISOString().slice(0, 16)}Z"`, { allowFail: true });
    const ok = await pushWithRetry(ROOT, "main");
    if (!ok) console.warn("[grid-beat] ledger push rejected (concurrent run) — next run rebases and continues");
  }
  console.log(`[grid-beat] done in ${((Date.now() - t0) / 1000).toFixed(1)}s · verdict=${publicDoc.verdict} · hive=${(hiveLeg as { verdict?: string }).verdict ?? "?"}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("[grid-beat] FATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
