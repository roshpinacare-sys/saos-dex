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

interface LedgerOrder {
  id: number; at: string; txid: string; side: "ask" | "bid";
  sell: string; receive: string; priceSbdPerSteem: number;
  status: "open" | "filled" | "cancelled" | "unknown"; lastSeenAt: string;
}
interface LedgerFill {
  key: string; at: string; side: "maker" | "taker"; direction: "sold-steem" | "bought-steem";
  paid: string; received: string; steemUsd: number; sbdUsd: number;
  paidUsd: number; recvUsd: number; edgeBps: number;
}
interface GridLedger {
  version: 1;
  orders: LedgerOrder[];
  fills: LedgerFill[];
  placedTotal: number; filledTotal: number; cancelledTotal: number;
  externalFlowUsd: number; // סכום-נזילות-החוץ הנטו שנספרה (received-paid בדולר ציון)
}
function loadLedger(): GridLedger {
  try {
    const raw = JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8")) as GridLedger;
    if (raw && raw.version === 1 && Array.isArray(raw.orders) && Array.isArray(raw.fills)) return raw;
  } catch { /* ראשון */ }
  return { version: 1, orders: [], fills: [], placedTotal: 0, filledTotal: 0, cancelledTotal: 0, externalFlowUsd: 0 };
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
  console.log(`[grid-beat] boot · account=${ACCOUNT} · armed=${process.env.STEEM_ACTIVE_WIF ? "yes" : "no (honest)"}`);

  const rm = await import("./src/lib/dex/realmarket");
  const pp = await import("./src/lib/dex/price-proof");
  const { realSnapshotSoft, activeWif } = rm as unknown as {
    realSnapshotSoft: () => Promise<Record<string, unknown>>;
    activeWif: () => string | null;
  };
  const extFeeds = (pp as unknown as { extFeeds: (force?: boolean) => Promise<{ ok: boolean; usd: { steem: number | null; sbd: number | null } }> }).extFeeds;

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
  if (!armed) blocker.push("STEEM_ACTIVE_WIF secret missing — one operator action to arm the external grid");
  if (!parity) blocker.push("external USD marks unavailable (steem/sbd feeds down) — no marking, no trading");
  if (!snap.book.bestBid || !snap.book.bestAsk) blocker.push("public book one-sided or unreachable");
  if (parity && snap.book.mid) {
    const devBps = Math.floor(((snap.book.mid - parity) / parity) * 10_000);
    if (Math.abs(devBps) > PARITY_BAND_BPS) blocker.push(`book mid deviates ${devBps}bps from external parity — refusing to trade a broken market`);
  }

  if (armed && parity && snap.book.bestBid && snap.book.bestAsk && blocker.length === 0) {
    const { realPlaceOrder, realCancelOrder } = rm as unknown as {
      realPlaceOrder: (p: { orderid: number; amountToSell: string; minToReceive: string; expirationDays?: number }) => Promise<{ txid: string; block: number | null }>;
      realCancelOrder: (orderid: number) => Promise<{ txid: string; block: number | null }>;
    };

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

    /* 2) פריסת הגריד */
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    let seq = 1;
    const nextId = (): number => {
      let id = Number(today) * 100 + seq;
      while (ledger.orders.some((x) => x.id === id)) { seq++; id = Number(today) * 100 + seq; }
      return id;
    };

    // מדף-המכירה: מעל קו-הזהות החיצוני — אף-פעם לא מתחת (עיקרון 1)
    const steemAvail = snap.balances.steem - MIN_KEEP_STEEM;
    const steemCommit = Math.max(0, Math.floor(steemAvail * COMMIT_PCT * 1000) / 1000);
    if (steemCommit >= MIN_LEVEL_STEEM * ASK_LEVELS) {
      const per = Math.floor((steemCommit / ASK_LEVELS) * 1000) / 1000;
      for (let k = 1; k <= ASK_LEVELS; k++) {
        const px = parity * (1 + (ASK_STEP_BPS * k) / 10_000);
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
    const sbdCommit = Math.max(0, Math.floor(snap.balances.sbd * COMMIT_PCT * 1000) / 1000);
    if (sbdCommit >= MIN_LEVEL_SBD * BID_LEVELS && snap.book.bestBid) {
      const per = Math.floor((sbdCommit / BID_LEVELS) * 1000) / 1000;
      for (let k = 1; k <= BID_LEVELS; k++) {
        const px = snap.book.bestBid * (1 - (BID_STEP_BPS * k) / 10_000);
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
  ledger.placedTotal += placed;
  ledger.cancelledTotal += cancelled;
  saveLedger(ledger);

  /* ── הפרסום הציבורי: dex/grid.json ב-Console ── */
  const openNow = snap.openOrders.filter(() => true).length; // נספר מהתמונה שלפני-הפעולות; הריצה הבאה מראה את החדשות
  const publicDoc = {
    ok: true,
    publishedAt: new Date().toISOString(),
    engine: "saos-dex/1.0 grid-beat · R24 external flow",
    account: ACCOUNT,
    chain: "STEEM-internal-market",
    real: true,
    armed,
    verdict: !armed ? "DISARMED-NO-KEY" : placed > 0 ? "ARMED-LIVE" : blocker.length ? "ARMED-WAITING" : "ARMED-STABLE",
    blocker: blocker.length ? blocker : null,
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
    honesty: "מדוד מול ספר-STEEM הציבורי ופידי-USD חיים. מילויים מסומנים בזמן-הגילוי (marked-at-detection) — המעקה מתעד את הציון שנמדד. ה-SBD הפנימי נסחר בפרימיום מול הציון החיצוני; קו-הזהות מוצג בגלוי כדי שכל אחד יוכל לאמת שאנחנו לא מוכרים מתחת לערך.",
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
      execSync(`git commit -m "grid-beat: ${placed} placed · ${cancelled} cancelled · ${new Date().toISOString().slice(0, 16)}Z"`, { encoding: "utf8", cwd: PUB, stdio: ["ignore", "pipe", "pipe"] });
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
    git(`commit -m "grid-beat: ${placed} placed · ${cancelled} cancelled · ${ledger.fills.length} fills counted · ${new Date().toISOString().slice(0, 16)}Z"`, { allowFail: true });
    const ok = await pushWithRetry(ROOT, "main");
    if (!ok) console.warn("[grid-beat] ledger push rejected (concurrent run) — next run rebases and continues");
  }
  console.log(`[grid-beat] done in ${((Date.now() - t0) / 1000).toFixed(1)}s · verdict=${publicDoc.verdict}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("[grid-beat] FATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
