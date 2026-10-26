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
import { policyCycleGate, policyGate, effectiveCycleCap } from "./grids/policy.mjs"; // DECISIONS #17 · SAOS-POLICY-ENGINE/1 (agentic-wallet pattern, owner trace 1a137c5876e963e9) · trim-to-cap (owner approve trace 1a1629f96941f20d)
/* 9-c (2026-10-11) · שער-המפתח: אימות שה-WIF גוזר בדיוק את רשות-ה-active החיה לפני-כל-שידור.
 * המדידה-החיה (twin run 38144052862 · 2026-10-11T13:39Z): WIF-ישן בכספת (רוטציית-בעלים
 * last_owner_update 2026-10-08T17:29:09Z) → 18 שידורים-נדונים ("broadcast answered without id")
 * ופרסום-שקר verdict=ARMED-STABLE · blocker=null. מעתה: אימות-לפני-חתימה (fail-closed)
 * + כשלי-שידור מפורסמים בכנות ב-verdict. */
import { activeAuthorityOk } from "./grids/key-gate.mjs";
/* N1-חוק-המדרגות (2026-10-22, owner approve trace 1a1629f96941f20d · cycle 26): סולם-הידוק-
 * מבוסס-ראיות — המרווח מתהדק רק כשמילויי-חוץ-אמת (לא-wash, edge≠0) מצטברים-בפנקס.
 * T0=בסיס-חתום → T1(≥2)=45/80 → T2(≥5)=30/60 → T3(≥12)=18/45 דו-ספרתי. רצפות-השומר
 * (ask≥10/bid≥25) לעולם לא נחצות; לעולם לא מעל-הבסיס; המדרגה מפורסמת-בגלוי בכל-ריצה. */
import { deriveSpreadTiers } from "./grids/spread-tiers.mjs";
/* 9-c · פרמטרי-גריד נכנסים למנוע רק דרך השומר (grids/validate-params.mjs — fail-closed):
 * grids/state/grid-params.json תקין → הפרמטרים-החיים; חסר/נדחה → ברירות-המחדל-המדודות
 * למטה + הערה-גלויה בפרסום. פרמטרים-רעים לעולם לא מדורגים לספר. */
import { validateParams } from "./grids/validate-params.mjs";

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

/* ── 9-c · טעינת-פרמטרים מאומתים (fail-closed → defaults-מדודים) ─────────────── */
function loadGridParams(): {
  steem: Record<string, number>; hive: Record<string, number>; note: string | null;
} {
  const defaults = {
    steem: { commitPct: COMMIT_PCT, minKeepSteem: MIN_KEEP_STEEM, minLevelSteem: MIN_LEVEL_STEEM, minLevelSbd: MIN_LEVEL_SBD, bidLevels: BID_LEVELS, bidStepBps: BID_STEP_BPS, askLevels: ASK_LEVELS, askStepBps: ASK_STEP_BPS, parityBandBps: PARITY_BAND_BPS, expiryDays: EXPIRY_DAYS },
    hive: { commitPct: COMMIT_PCT, minKeepHive: HIVE_MIN_KEEP, minLevelHive: HIVE_MIN_LEVEL, minLevelHbd: HIVE_MIN_LEVEL_HBD, askMinRecvHbd: HIVE_ASK_MIN_RECV_HBD, bidLevels: HIVE_BID_LEVELS, bidStepBps: HIVE_BID_STEP_BPS, askLevels: HIVE_ASK_LEVELS, askStepBps: HIVE_ASK_STEP_BPS, parityBandBps: PARITY_BAND_BPS, expiryDays: EXPIRY_DAYS },
  };
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(ROOT, "grids", "state", "grid-params.json"), "utf8"));
    const v = validateParams(doc) as { ok: boolean; params?: { steem?: Record<string, number>; hive?: Record<string, number> }; errors?: string[] };
    if (v && v.ok && v.params && v.params.steem && v.params.hive) {
      return { steem: { ...defaults.steem, ...v.params.steem }, hive: { ...defaults.hive, ...v.params.hive }, note: null };
    }
    const errs = v && Array.isArray(v.errors) ? v.errors.slice(0, 2).join(" | ") : "validator answered without ok";
    return { ...defaults, note: `grids/state/grid-params.json REJECTED by grids/validate-params.mjs (fail-closed → measured defaults): ${errs}` };
  } catch (e) {
    return { ...defaults, note: `grids/state/grid-params.json unreadable (fail-closed → measured defaults): ${String((e as Error)?.message ?? e).slice(0, 80)}` };
  }
}
const GP = loadGridParams();
/* הפרמטרים-החיים: אותם-שמות שבהם כל-גוף-הרץ משתמש — עתה נגזרים מהשומר.
 * (defaults = הצהרות-המדידה-ההיסטוריות למעלה; הם גם הנפילה-הבטוחה.) */
const LIVE_COMMIT_PCT = GP.steem.commitPct;
const LIVE_MIN_KEEP_STEEM = GP.steem.minKeepSteem;
const LIVE_MIN_LEVEL_STEEM = GP.steem.minLevelSteem;
const LIVE_MIN_LEVEL_SBD = GP.steem.minLevelSbd;
const LIVE_BID_LEVELS = GP.steem.bidLevels;
const LIVE_BID_STEP_BPS = GP.steem.bidStepBps;
const LIVE_ASK_LEVELS = GP.steem.askLevels;
const LIVE_ASK_STEP_BPS = GP.steem.askStepBps;
const LIVE_PARITY_BAND_BPS = GP.steem.parityBandBps;
const LIVE_EXPIRY_DAYS = GP.steem.expiryDays;
const HIVE_COMMIT_PCT = GP.hive.commitPct;
const HIVE_MIN_KEEP_LIVE = GP.hive.minKeepHive;
const HIVE_MIN_LEVEL_LIVE = GP.hive.minLevelHive;
const HIVE_MIN_LEVEL_HBD_LIVE = GP.hive.minLevelHbd;
const HIVE_ASK_MIN_RECV_HBD_LIVE = GP.hive.askMinRecvHbd;
const HIVE_BID_LEVELS_LIVE = GP.hive.bidLevels;
const HIVE_BID_STEP_BPS_LIVE = GP.hive.bidStepBps;
const HIVE_ASK_LEVELS_LIVE = GP.hive.askLevels;
const HIVE_ASK_STEP_BPS_LIVE = GP.hive.askStepBps;
const LIVE_BID_TOUCH_HUG_BPS = typeof GP.steem.bidTouchHugBps === "number" && GP.steem.bidTouchHugBps >= 1 ? GP.steem.bidTouchHugBps : 10; // N8-b: התחבקות-מגע (round-27)
const LIVE_MM_GUARD_BAND_BPS = typeof GP.steem.mmGuardBandBps === "number" && GP.steem.mmGuardBandBps >= 1 ? GP.steem.mmGuardBandBps : 10; // N8-f: מעטפת-מחיר-שבור (round-27b)
const HIVE_PARITY_BAND_BPS = GP.hive.parityBandBps;
const HIVE_EXPIRY_DAYS = GP.hive.expiryDays;

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

/* ── G76-a · מדידת-אמת-מצטברת: ledger.fills חלון-נע (slice(-300)) — הודעת-הקומיט
 * "300 fills counted" הייתה מציגה-את-התקרה ולא-את-הפעילות האמת. המונה-המצטבר
 * האמיתי (observe.mjs → feeMeter.realFills, מוזן-מילויי-fill_order של-השרשרת)
 * חי ב-grids/state/state.json — קריאה-בלבד, fail-honest ל-0 על-קובץ-חסר. */
function realFillsCumulative(): number {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(ROOT, "grids", "state", "state.json"), "utf8")) as { feeMeter?: { realFills?: number } };
    const v = Number(s?.feeMeter?.realFills);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  } catch { return 0; }
}

/* ── EDGE-FLOOR (2026-10-21 · מהמדידה-החיה) ────────────────────────────────────
 * המדידה שחשפה את הדימום: pnl-desk (Domain dex/pnl-desk.json 2026-10-20):
 * sellVwap 0.100346 < buyVwap 0.102346 = edge -2% מדוד — הגריד מכר זול יותר
 * משקנה, כי סולם-האסקים נפרש סביב המגע-החי ולא סביב בסיס-העלות של המלאי.
 * החוק-החדש (מקביל לעיקרון-1 שכבר קיים): אף-אסק לא מתחת לבסיס-עלות-המלאי
 * + שולי-קצה מינימליים (100bps). מעל-זה הסולם חופשי; מתחת — נהדק-מעלה.
 * בסיס-העלות = ריפליי-נטו של פנקס-המילויים (אותו-חוק-ריפליי של pnl-book). */
const MIN_ASK_EDGE_BPS = 100; // 1% מעל בסיס-עלות — הרווח-החוץ המינימלי המותר למכירה
function inventoryCostBasis(fills: LedgerFill[], chain: "steem" | "hive" = "steem"): { qty: number; costSbd: number; avgCostSbd: number | null } {
  const amtOf = (s: string): number => parseFloat(String(s).replace(/[A-Za-z ]+/g, "")) || 0;
  let qty = 0, costSbd = 0; // qty=יחידות-נכס (STEEM/HIVE), costSbd=SBD ששולם-ולא-הושב
  for (const f of fills) {
    if ((f.chain ?? "steem") !== chain) continue;
    if (f.direction === "bought-steem" || f.direction === "bought-hive") {
      const got = amtOf(f.received); // יחידות-הנכס שנקנו
      const paid = amtOf(f.paid);    // SBD ששולם
      qty += got; costSbd += paid;
    } else if (f.direction === "sold-steem" || f.direction === "sold-hive") {
      const sold = amtOf(f.paid);    // יחידות-הנכס שנמכרו
      if (qty <= 0) { continue; }    // מכירה בלי בסיס-קנייה מתועד — לא משפיעה על הבסיס
      const avg = costSbd / qty;
      const take = Math.min(sold, qty);
      qty -= take; costSbd -= take * avg;
      if (qty <= 1e-9) { qty = 0; costSbd = 0; }
    }
  }
  return { qty, costSbd, avgCostSbd: qty > 1e-9 ? costSbd / qty : null };
}

/* ── שער-הפר-פעולה (2026-10-21 · FIX(cycle-vs-perop)) ────────────────────────
 * כל-הצבה בודדת עוברת policyGate משלה כ-limit_order_create עם ה-notional שלה.
 * HALT ⇒ אותה-הצבה מדולגת בגלוי + נספרת בקבלה (fail-closed פר-פעולה ממשי —
 * ההגנה שהייתה עד-היום רק תאורטית על סך-המחזור). אפס-סודות. */
function perOpAllow(tool: string, account: string, chain: "steem" | "hive", kind: "bid" | "ask", notionalSbd: number, price: number, amount: number): { allow: boolean; why: string | null } {
  const g = policyGate({ tool, lane: "grid", kind: "limit_order_create", account, amount, price, notionalSbd, meta: { chain, levelSide: kind } });
  if (g.allow) return { allow: true, why: null };
  return { allow: false, why: (g.reasons ?? []).join(" ; ").slice(0, 200) };
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
  // W34 fail-honest (same law as cloud-beat's W33 patch): the grid lane's ledger push
  // could die silently — a book that cannot publish must SAY why, in the log, forever.
  for (let i = 0; i < tries; i++) {
    try {
      execSync(`git push origin ${branch}`, { encoding: "utf8", cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
      return true;
    } catch (e) {
      const why = String((e as { stderr?: string; message?: string }).stderr ?? (e as { message?: string }).message ?? e).split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 300);
      console.error(`[grid-beat] push try ${i + 1}/${tries} FAILED: ${why || "(no stderr — inspect runner)"}`);
      try {
        execSync(`git pull --rebase --autostash origin ${branch}`, { encoding: "utf8", cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
      } catch (e2) {
        console.error(`[grid-beat] rebase try ${i + 1} failed: ${String((e2 as { stderr?: string }).stderr ?? e2).split("\n").slice(-2).join(" | ").slice(0, 200)}`);
        // R-GRID-WAR (2026-10-22, measured live 04:33Z): ריבייט-כושל משאיר rebase-in-progress
        // → הצעדים-הבאים ב-workflow (evidence commits) נופלים על "unresolved conflict" בכל-ריצה.
        // עתה: abort → עץ-נקי; הקבלה-שלנו נשארת-קומיט-מקומי — הריצה-הבאה מריבייטת מחדש.
        try { execSync(`git rebase --abort`, { encoding: "utf8", cwd: dir, stdio: ["ignore", "pipe", "pipe"] }); console.error(`[grid-beat] rebase aborted — tree clean for next steps`); } catch { /* אין-ריבייט-פעיל */ }
      }
      await new Promise((r) => setTimeout(r, 1_500));
    }
  }
  return false;
}

/* W34 fail-honest: git() with allowFail returns "" for BOTH success and failure —
 * the ledger commit path could lose a whole run's orders with zero words in the log
 * (measured live 2026-10-21T16:50Z: 6 real on-chain placements, ledger never landed,
 * log silent). gitLoud speaks: same call, but failures print the real stderr. */
function gitLoud(args: string, opts: { cwd?: string } = {}): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execSync(`git ${args}`, { encoding: "utf8", cwd: opts.cwd ?? ROOT, stdio: ["ignore", "pipe", "pipe"] }).trim() };
  } catch (e) {
    const why = String((e as { stderr?: string; message?: string }).stderr ?? (e as { message?: string }).message ?? e).split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 300);
    console.error(`[grid-beat] git ${args.split(" ").slice(0, 2).join(" ")} FAILED: ${why || "(no stderr — inspect runner)"}`);
    return { ok: false, out: "" };
  }
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

  /* N8 · PRICE-TRUTH (round-27, owner mandate trace 1a163d4124276b39): קו-הערך-המשולש.
   * valueLine = min(feed-רפואי-על-השרשרת, פאריטי-USD-חוץ) — התביעה-השמרנית-משתי-סמכויות.
   * מדוד-חי 10-22: chainFeed 0.10408 · usdParity 0.1052 (binance 0.0527 ÷ sbdUsd 0.501 —
   * SBD-דה-פג-מדוד-ומפורסם) · מגע 0.1028. העוגן-הישן היה נכון — מה שהיה-שבור זה
   * המדף (parity+60bps ≈ 400bps-מעל-המגע — אפס-מילויים) והבידים (100bps-מתחת-המגע —
   * אפס-זרימה). נפילה-כנה: מדידה-שנכשלה → parity-הישן (התנהגות-קודמת). */
  const priceTruthMod = await import("./grids/price-truth.mjs");
  const PT = await (priceTruthMod as { measurePriceTruth: (o?: unknown) => Promise<{ valueLineSbdPerSteem: number | null; bandRefSbdPerSteem: number | null; verdict: string; marks: Record<string, unknown>; notes: string[]; law?: string; measuredAt?: string } | null> }).measurePriceTruth({ steemUsd, sbdUsd }).catch(() => null);
  const valueLine = PT?.valueLineSbdPerSteem ?? parity;
  const bandRef = PT?.bandRefSbdPerSteem ?? parity;
  console.log(`[grid-beat] PRICE-TRUTH ${PT?.verdict ?? "unmeasured"}: valueLine ${valueLine?.toFixed(5) ?? "∅"} SBD/STEEM (chain ${String(PT?.marks.chainFeedSbdPerSteem ?? "∅")} · usdParity ${String(PT?.marks.usdParitySbdPerSteem ?? "∅")}) · sbdUsd ${String(PT?.marks.measuredSbdUsd ?? "∅")} (implied ${String(PT?.marks.impliedSbdUsdFromFeed ?? "∅")} · depeg ${String(PT?.marks.sbdDepegBps ?? "∅")}bps)${PT?.notes.length ? ` · ${PT.notes.join(" · ")}` : ""}`);

  /* N1 · המדרגה-החיה: נגזרת-מהראיות-בפנקס (מילויי-חוץ מצטברים) מעל הבסיס-החתום.
   * הערכים-החיים של רגל-STEEM: אסקים/בידים נפרשים לפי TIER, לא לפי הבסיס ישירות —
   * כך ההידוק-אל-דו-ספרתי-bps קורה רק כשהשוק-החוץ באמת משלם. */
  const TIER = deriveSpreadTiers(ledger.fills, { askStepBps: LIVE_ASK_STEP_BPS, bidStepBps: LIVE_BID_STEP_BPS }, "steem");
  console.log(`[grid-beat] SPREAD-TIER ${TIER.tier}: ask ${TIER.askStepBps}bps / bid ${TIER.bidStepBps}bps (base ${TIER.baseAskStepBps}/${TIER.baseBidStepBps}) · ${TIER.evidence}${TIER.nextTier ? ` · next: ${TIER.nextTier.name} after ${TIER.nextTier.needs} more third-party fills` : " · at top tier"}`);

  /* 9-c · כנות-ספר: פקודות-פתוחות-על-השרשרת שהמעקה לא מכיר (זומבים — ריצה שהמעקה-שלה
   * אבד ב-push-מקביל, או סוחר-אחר בחשבון). לא משנים-התנהגות — רק מפרסמים את-הסתירה,
   * כדי שהריצה-הבאה תדע שהמעקה והשרשרת לא מסונכרנים (הסירון-השקט של 10-08..10-11). */
  const ledgerKnownSteem = new Set(ledger.orders.filter((o) => (o.chain ?? "steem") === "steem").map((o) => o.id));
  const zombieOrders = snap.openOrders.filter((o) => !ledgerKnownSteem.has(o.id)).map((o) => o.id);

  /* ── הפעולות (רק כשחמוש וכשהספר והמדדים חיים) ── */
  let placed = 0, cancelled = 0;
  const blocker: string[] = [];
  if (!armed) blocker.push("STEEM_ACTIVE_WIF secret missing: one operator action to arm the external grid");
  /* N8: קו-ערך-חי מספיק — גם CHAIN-ONLY (ה-USD-פידים-נפלו, ה-feed-הרפואי-חי) עדיין מצייר
   * קו-ערך-אמת; חסימה-מלאה רק-כשאין-אף-סמכות (UNMEASURED). */
  if (!valueLine) blocker.push("no measured value line (chain feed down AND USD feeds down): no marking, no trading");
  if (!snap.book.bestBid || !snap.book.bestAsk) blocker.push("public book one-sided or unreachable");
  if (bandRef && snap.book.mid) {
    const devBps = Math.floor(((snap.book.mid - bandRef) / bandRef) * 10_000);
    if (Math.abs(devBps) > LIVE_PARITY_BAND_BPS) blocker.push(`book mid deviates ${devBps}bps from the measured value line (chain feed): refusing to trade a broken market`);
  }
  /* R25 · שער-STASIS: הבלם נקרא טרי בכל-ריצה, לפני-כל-מסילת-חתימה —
   * active=true → חוסם-כנה (no-op בריא) עם הסיבה-מפורסמת בגלוי. */
  if (stasisHalt("grid-beat:steem")) blocker.push("STASIS capital brake active (owner directive 2026-10-04): signing lanes halt — see grids/state/STASIS.json");

  /* POLICY-ENGINE (SAOS-POLICY-ENGINE/1, DECISIONS #17) · שער-מחזור אטומי — דפוס agentic-wallet:
   * כל-הרענון (ביטולים+הצבות) = כוונה-אחת. HALT ⇒ blocker ⇒ אפס-ביטולים ואפס-הצבות
   * (הסולם נשאר נוגע-שלם — אין-מצב-ביניים). תקרות מדודות מ-grid-params (לכל-פעולה ~4 SBD,
   * למחזור ~12 SBD) עם מרווח ×6–×10. fail-closed: פוליסה-חסרה/זרה = עצירה. */
  const polAmt = (s: string): number => parseFloat(String(s).replace(/[A-Za-z ]+/g, "")) || 0;
  const polSteemReturned = snap.openOrders.filter((o) => o.sell.includes("STEEM")).reduce((s, o) => s + polAmt(o.sell), 0);
  const polSbdReturned = snap.openOrders.filter((o) => o.sell.includes("SBD")).reduce((s, o) => s + polAmt(o.sell), 0);
  const polNotionalUpper = Math.max(0, snap.balances.steem + polSteemReturned - LIVE_MIN_KEEP_STEEM) * LIVE_COMMIT_PCT * (parity ?? valueLine ?? 0)
    + Math.max(0, snap.balances.sbd + polSbdReturned) * LIVE_COMMIT_PCT;
  /* Trim-to-cap (2026-10-22, owner approve trace 1a1629f96941f20d): חריגת-תקרת-מחזור לא תזרוק
   * HALT-מלא — הגריד מתאים-את-עצמו מטה (גורם-התאמה ≤1) אל-תוך התקרה. המשמעת-הון-נשמרת
   * במלואה (פחות-הון-על-השולחן, לעולם-לא-יותר) והמלכודת (בלי-הצבות → אין-קבלות-ACTED
   * → הילוך-לא-עולה → cap-צמוד-לנצח) נסגרת. גורם-ההתאמה-מפורסם-בכנות בלוג ובספר. */
  const cycleCapSbd = effectiveCycleCap("grid");
  let commitScale = 1;
  if (cycleCapSbd != null && polNotionalUpper > cycleCapSbd && polNotionalUpper > 0) {
    commitScale = Math.max(0, cycleCapSbd / polNotionalUpper);
    console.log(`[grid-beat] POLICY-FIT (trim-to-cap): cycle upper ${polNotionalUpper.toFixed(3)} SBD > cap ${cycleCapSbd} SBD — commit scaled ×${commitScale.toFixed(3)} (down only; gearbox climbs on receipts)`);
  }
  const polGate = policyCycleGate({ tool: "grid-beat:steem", lane: "grid", account: ACCOUNT, opsEst: snap.openOrders.length + LIVE_ASK_LEVELS + LIVE_BID_LEVELS, notionalSbdUpper: polNotionalUpper * commitScale, chain: "steem" });
  if (!polGate.allow) blocker.push(`POLICY-HALT (steem leg): ${polGate.reasons.join(" ; ")} — atomic refresh skipped, ladder untouched`);

  /* 9-c · שער-המפתח (fail-closed לפני-כל-שידור): WIF שאינו גוזר את רשות-ה-active החיה
   * = חסימה-כנה עם הסיבה. המדידה-החיה (run 38144052862): בלי-השער הזה 18 שידורים-נדונים
   * יצאו לשרשרת וכולם נדחו — והרץ פרסם ARMED-STABLE. עתה: אפס-שידורים + verdict-אמת.
   * קריאת-רשות-נכשלת = גם-חסימה (לא חותמים על-ספק). אין-סוד בפרסום — רק ok/reason
   * והמפתח-הציבורי-החי (כבר-פומבי על-השרשרת). */
  let keyGate: Awaited<ReturnType<typeof activeAuthorityOk>> | null = null;
  if (armed) {
    keyGate = await activeAuthorityOk({ account: ACCOUNT, wif: process.env.STEEM_ACTIVE_WIF || "", rpc: (method, params) => (rm as unknown as { rpcAny: <T>(m: string, p: unknown[]) => Promise<T> }).rpcAny(method, params) });
    if (!keyGate.ok) {
      blocker.push(`key gate: ${keyGate.reason}`);
      console.warn(`[grid-beat] KEY-GATE BLOCK: ${keyGate.reason}`);
    } else {
      console.log(`[grid-beat] key gate ok — WIF derives the live active authority of ${ACCOUNT}`);
    }
  }

  if (armed && valueLine && snap.book.bestBid && snap.book.bestAsk && blocker.length === 0) {
    const { realPlaceOrder, realCancelOrder } = rm as unknown as {
      realPlaceOrder: (p: { orderid: number; amountToSell: string; minToReceive: string; expirationDays?: number }) => Promise<{ txid: string; block: number | null }>;
      realCancelOrder: (orderid: number) => Promise<{ txid: string; block: number | null; recovered?: boolean }>;
    };
    /* 9-c · מונה-שידורים: כל-כישלון-שידור ייספר ויפורסם — אסור-שריצה שכל-שידוריה
     * נדחו תירשם כ-ARMED-STABLE (השקר-המדוד של 10-08..10-11). */
    let bcAttempted = 0, bcFailed = 0;

    /* Z-81 · שני-שערים-חדשים על-בסיס-פענוח-הפקודות-שלנו מהתמונה:
     * (1) שימור-תור — סולם שלם-ומעל-קו-הערך לא מבוטל (ביטול-הצבה כל-30-דק'
     *     שורף-RC ומאבד-מקום-בתור-ההתאמה — המיקרו-מבנה המדוד-חי); רענון רק
     *     כשנעקפנו-מהמגע או כשקו-הערך עלה מעל האסק-שלנו.
     * (2) תיקון-רעב-האסקים — הדלק נמדד אחרי-הביטולים: ה-STEEM/SBD הנעולים
     *     בפקודות-שלנו חוזרים-לנזיל עם הביטול, ולכן נספרים. הבאג החי-שנמדד:
     *     צילום-מצב לפני-ביטול → 24 STEEM נעולים נראו "אפס-דלק" → האסקים
     *     נבלעו והסולם נשאר בלי-צד-מכירה שעות. */
    const amtOfStr = (s: string): number => parseFloat(String(s).replace(/[A-Za-z ]+/g, "")) || 0;
    /* R-GRID-WAR תיקון-מלחמה-עצמית (2026-10-22): "ourAsks" כללה את כל הפקודות-על-החשבון —
     * כולל אסקים-מתחת-לפאריטי של army-ladder/אחרים → bestOurAsk הורעל → ladderIntact שקרי
     * → cancel-all שנתן-מכות לכל-הספר בכל-ריצה. עתה: רק פקודות-ידועות-בפנקס נחשבות-שלנו;
     * זרים-תואמי-מדיניות לא נוגעים; חוק-מעל-הכל: אסק-מתחת-לפאריטי = דימום-אמת ומבוטל בהגנה. */
    const ledgerKnownIds = new Set(ledger.orders.filter((o) => (o.chain ?? "steem") === "steem").map((o) => o.id));
    const ourAsks = snap.openOrders.filter((o) => o.sell.includes("STEEM") && ledgerKnownIds.has(o.id)).map((o) => ({ id: o.id, px: amtOfStr(o.receive) / amtOfStr(o.sell), steem: amtOfStr(o.sell) }));
    const ourBids = snap.openOrders.filter((o) => o.sell.includes("SBD") && ledgerKnownIds.has(o.id)).map((o) => ({ id: o.id, px: amtOfStr(o.sell) / amtOfStr(o.receive), sbd: amtOfStr(o.sell) }));
    const bestOurAsk = ourAsks.length ? Math.min(...ourAsks.map((a) => a.px)) : null;
    const bestOurBid = ourBids.length ? Math.max(...ourBids.map((b) => b.px)) : null;
    const TOUCH_EPS = 1e-4; // סובלנות-השוואת-מגע (0.01%)
    const ownsAsk = bestOurAsk != null && Math.abs(bestOurAsk - snap.book.bestAsk) <= snap.book.bestAsk * TOUCH_EPS;
    const ownsBid = bestOurBid != null && Math.abs(bestOurBid - snap.book.bestBid) <= snap.book.bestBid * TOUCH_EPS;
    const askValueLine = valueLine * (1 + TIER.askStepBps / 10_000); // N1: מדרגה-חיה מבוססת-ראיות, על-קו-הערך-המדוד (N8)
    const ladderIntact = ownsAsk && ownsBid && bestOurAsk !== null && bestOurAsk >= askValueLine && bestOurBid !== null && bestOurBid <= valueLine;

    if (ladderIntact) {
      console.log(`[grid-beat] ladder intact & above value line — queue preserved · ask ${bestOurAsk?.toFixed(5)} ≥ ${askValueLine.toFixed(5)} · bid ${bestOurBid?.toFixed(5)} ≤ valueLine ${valueLine.toFixed(5)} · ${snap.openOrders.length} orders untouched`);
    }
    /* R-GRID-WAR הגנת-ערך — N8-f פיצול-היקפים (round-27b · המלחמה-המדודה 14:39–14:40Z):
     * שני-מנדטים-של-הבעלים על-חשבון-אחד: מדף-הערך (grid-beat) מול מנדט-הנפח (market-exec —
     * מכירה-שווקית-במגע+0.1% · המנוע-היחיד-שלכד-מילוי-חוץ-אמת היום: cashly 13:37:51Z).
     * השומר-עתה עוצר **מחירים-שבורים בלבד** (עמוק-מתחת-מעטפת-המגע) — לא-את-מנוע-המילויים;
     * קו-הערך נשאר-שולט-בכל-מה-ש-grid-beat-עצמו מציב (מדף ≥ valueLine+TIER · בידים ≤ valueLine)
     * והפנקס-מסמן-כל-edge-ב-USD-חי. אחווה-בין-מנדטים-במקום-רצח-אחים. */
    if (valueLine > 0) {
      const mmEnvelope = snap.book.bestBid ? snap.book.bestBid * (1 + LIVE_MM_GUARD_BAND_BPS / 10_000) : 0;
      const guardFloor = mmEnvelope > 0 ? Math.min(valueLine, mmEnvelope) : valueLine;
      for (const o of snap.openOrders) {
        const sellAmt = amtOfStr(o.sell), recvAmt = amtOfStr(o.receive);
        const isAsk = o.sell.includes("STEEM");
        const px = isAsk ? recvAmt / sellAmt : sellAmt / recvAmt;
        if (isAsk && px < guardFloor) {
          bcAttempted++;
          try {
            const r = await realCancelOrder(o.id);
            cancelled++;
            const rec = ledger.orders.find((x) => x.id === o.id);
            if (rec) { rec.status = "cancelled"; rec.lastSeenAt = new Date().toISOString(); }
            // N2-b · כנות-השתקמות: txid של recovered-cancel מסומן-בגלוי — לא נראה כישלון מה שנחת-והושג
            console.log(`[grid-beat] VALUE-GUARD cancel #${o.id}${r.recovered ? " [RECOVERED-no-id]" : ""}: ask @${px.toFixed(6)} < guardFloor ${guardFloor.toFixed(6)} (broken-price envelope bestBid+${LIVE_MM_GUARD_BAND_BPS}bps · valueLine ${valueLine.toFixed(6)}) — N8-f scope-split · txid ${r.txid.slice(0, 26)}`);
          } catch (e) {
            bcFailed++;
            console.warn(`[grid-beat] value-guard cancel #${o.id} failed: ${String(e).slice(0, 80)}`);
          }
        }
      }
    }
    if (!ladderIntact) {
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
    /* N8-e (round-27 · מדוד-חי: שני-רצים-על-אותו-חשבון עם סכימת-התאריך×100+seq התנגשו
     * באותה-דקה (14:18-מול-14:20) — אותם-orderids-בדיוק, הפקודות-שלי נדחו-וה-recovery
     * העניק-קרדיט-שקרי-לפקודות-האחר). עתה: מרחב-epoch-שניות — רץ-בשנייה-אחרת = מרחב-אחר;
     * slot 1..8 לרצף-בתוך-השנייה. גבול-uint32 נשמר (≤ 4.29e9). התנגשות-אפשרית-רק-באותה-
     * שנייה-בדיוק — ואז-השרשרת דוחה-בכנה (כישלון-גלוי, לא-פנטום). */
    const nextId = (): number => {
      const epochSec = Math.floor(Date.now() / 1000) % 500_000_000; // ≤ 4e9 עם slot×8
      let id = (epochSec * 8 + (seq % 8)) >>> 0;
      while (ledger.orders.some((x) => x.id === id) || id === 0) { seq++; id = (epochSec * 8 + (seq % 8)) >>> 0; }
      return id;
    };

    // מדף-המכירה: מעל קו-הזהות החיצוני — אף-פעם לא מתחת (עיקרון 1)
    // Z-81: הדלק = נזיל-עכשיו + מה שהביטולים-שביצענו-מעלה מחזירים (אסקים נעולים)
    // EDGE-FLOOR (2026-10-21): ומעל בסיס-עלות-המלאי + 100bps — אף-מכירה מתחת-לעלות (הדימום-המדוד: edge -2%)
    const steemReturned = ourAsks.reduce((s, a) => s + a.steem, 0);
    const steemAvail = snap.balances.steem + steemReturned - LIVE_MIN_KEEP_STEEM;
    const steemCommit = Math.max(0, Math.floor(steemAvail * LIVE_COMMIT_PCT * commitScale * 1000) / 1000); // commitScale: trim-to-cap (owner approve 1a1629f96941f20d)
    const invBasis = inventoryCostBasis(ledger.fills, "steem");
    const costFloor = invBasis.avgCostSbd != null ? invBasis.avgCostSbd * (1 + MIN_ASK_EDGE_BPS / 10_000) : 0;
    if (steemCommit >= LIVE_MIN_LEVEL_STEEM * LIVE_ASK_LEVELS) {
      const per = Math.floor((steemCommit / LIVE_ASK_LEVELS) * 1000) / 1000;
      /* Z-80 חוק-הספר: רמה-1 נהדקת אל המגע-החי אם-הפאריטי מתחתיו; הרמות נפרשות
       * כלפי-מעלה מהבסיס-המהודק — אף-אסק לא נופל מתחת ל-bestAsk (אין-taker-דימום).
       * EDGE-FLOOR: הבסיס מרים גם את רצפת-העלות — אסק שלם לא נפרש מתחתיה. */
      const touchAsk = snap.book.bestAsk ?? 0;
      const baseAsk = Math.max(valueLine * (1 + TIER.askStepBps / 10_000), touchAsk, costFloor);
      for (let k = 1; k <= LIVE_ASK_LEVELS; k++) {
        const px = baseAsk * (1 + (TIER.askStepBps * (k - 1)) / 10_000);
        const sellAmt = per;
        const recv = Math.floor(sellAmt * px * 1000) / 1000;
        if (recv < LIVE_MIN_LEVEL_SBD) continue;
        const perOpNotional = sellAmt * px; // ערך-SBD של ההצבה הבודדת
        const opGate = perOpAllow("grid-beat:steem", ACCOUNT, "steem", "ask", perOpNotional, px, sellAmt);
        if (!opGate.allow) {
          console.warn(`[grid-beat] ask level ${k} POLICY-SKIP (per-op): ${opGate.why}`);
          continue;
        }
        const id = nextId(); seq++;
        bcAttempted++;
        try {
          const r = await realPlaceOrder({ orderid: id, amountToSell: `${dp3(sellAmt)} STEEM`, minToReceive: `${dp3(recv)} SBD`, expirationDays: LIVE_EXPIRY_DAYS });
          placed++;
          ledger.orders.push({ id, at: new Date().toISOString(), txid: r.txid, side: "ask", sell: `${dp3(sellAmt)} STEEM`, receive: `${dp3(recv)} SBD`, priceSbdPerSteem: sbdPerSteemOf(sellAmt, recv), status: "open", lastSeenAt: new Date().toISOString() });
          console.log(`[grid-beat] ask #${id}: ${dp3(sellAmt)} STEEM -> ${dp3(recv)} SBD @${px.toFixed(6)} (parity+${(TIER.askStepBps * k) / 100}% · tier ${TIER.tier}${costFloor > 0 && baseAsk === costFloor ? ` · cost-floor ${invBasis.avgCostSbd?.toFixed(6)}+${MIN_ASK_EDGE_BPS}bps` : ""}) txid ${r.txid.slice(0, 12)}`);
        } catch (e) {
          bcFailed++;
          console.warn(`[grid-beat] ask #${id} rejected: ${String(e).slice(0, 90)}`);
        }
      }
    } else {
      blocker.push(`sell-side waiting for fuel: ${steemCommit.toFixed(3)} STEEM commitable < ${LIVE_MIN_LEVEL_STEEM * LIVE_ASK_LEVELS} needed (next powerdown: ${snap.powerdown.nextPayout ?? "?"})`);
    }

    // מדף-הקנייה: מתחת לביד הטוב — כולן מעל-ערך מדוד מול הציון (עיקרון 2)
    // Z-81: גם-כאן — ה-SBD הנעול בבידים-שבוטלו חוזר לפני-ההצבה
    const sbdReturned = ourBids.reduce((s, b) => s + b.sbd, 0);
    const sbdCommit = Math.max(0, Math.floor((snap.balances.sbd + sbdReturned) * LIVE_COMMIT_PCT * commitScale * 1000) / 1000); // commitScale: trim-to-cap (owner approve 1a1629f96941f20d)
    if (sbdCommit >= LIVE_MIN_LEVEL_SBD * LIVE_BID_LEVELS && snap.book.bestBid) {
      const per = Math.floor((sbdCommit / LIVE_BID_LEVELS) * 1000) / 1000;
      /* N8-b · התחבקות-מגע (bidTouchHugBps, round-27): רמה-1-מתחבקת-מגע (ברירת-מחדל
       * 10bps) במקום-100bps-מתחתיו — הביד-המדוד-היה-90bps-מאחורי-הביד-המתחרה-ולא-ראה
       * אף-זרימת-מוכרים. ראש-התור = זרימה. רמות-עמוקות-ממשיכות-לרדת-ב-TIER-החי.
       * תקרת-הדוקטרינה-נשמרת: אף-ביד מעל קו-הערך (valueLine) לא-יוצא-לעולם. */
      const hugBps = Math.min(LIVE_BID_TOUCH_HUG_BPS, TIER.bidStepBps);
      const bidBase = Math.min(snap.book.bestBid * (1 - hugBps / 10_000), valueLine);
      for (let k = 1; k <= LIVE_BID_LEVELS; k++) {
        // Z-80: ביד לא עולה על המגע — תמיד (כפול-ביטחון; bidBase כבר מתחתיו)
        const px = Math.min(bidBase * (1 - (TIER.bidStepBps * (k - 1)) / 10_000), snap.book.bestBid); // N8-b: התחבקות-מגע + N1 מדרגה-חיה
        const recv = Math.floor(per / px * 1000) / 1000; // STEEM
        if (recv < LIVE_MIN_LEVEL_STEEM) continue;
        const perOpNotional = per; // ערך-SBD של ההצבה הבודדת (ה-BID מוכר SBD)
        const opGate = perOpAllow("grid-beat:steem", ACCOUNT, "steem", "bid", perOpNotional, px, per);
        if (!opGate.allow) {
          console.warn(`[grid-beat] bid level ${k} POLICY-SKIP (per-op): ${opGate.why}`);
          continue;
        }
        const id = nextId(); seq++;
        bcAttempted++;
        try {
          const r = await realPlaceOrder({ orderid: id, amountToSell: `${dp3(per)} SBD`, minToReceive: `${dp3(recv)} STEEM`, expirationDays: LIVE_EXPIRY_DAYS });
          placed++;
          ledger.orders.push({ id, at: new Date().toISOString(), txid: r.txid, side: "bid", sell: `${dp3(per)} SBD`, receive: `${dp3(recv)} STEEM`, priceSbdPerSteem: px, status: "open", lastSeenAt: new Date().toISOString() });
          console.log(`[grid-beat] bid #${id}: ${dp3(per)} SBD -> ${dp3(recv)} STEEM @${px.toFixed(6)} txid ${r.txid.slice(0, 12)}`);
        } catch (e) {
          bcFailed++;
          console.warn(`[grid-beat] bid #${id} rejected: ${String(e).slice(0, 90)}`);
        }
      }
    } else {
      blocker.push(`buy-side waiting for SBD inventory: ${sbdCommit.toFixed(3)} SBD commitable < ${(LIVE_MIN_LEVEL_SBD * LIVE_BID_LEVELS).toFixed(2)} needed`);
    }
    } /* סוף-מסלול-הרענון (Z-81: שימור-תור מדלג על ביטול+פריסה בשלמותם) */
    /* 9-c · כנות-שידור: שרשרת דחתה את-כל-השידורים = אין-מצב-יציב — מפרסמים-חסימה */
    if (bcAttempted > 0 && bcFailed > 0) {
      blocker.push(`broadcast failing: ${bcFailed}/${bcAttempted} chain ops rejected this run ("broadcast answered without id") — stale key/authority or node fault; verdict cannot be stable until signing succeeds`);
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
      // R-GRID-WAR (task-20, measured 01:31–01:43Z): צמד-עצמי (wash) — שני-הצדדים
      // שלנו; ההצלבה מנוטרלת-כלכלית (0-עמלות בספר-STEEM) ואינה רווח-חוץ. נרשם
      // בפנקס עם edge=0 ומוצא מה-externalFlowUsd — כנות-מעל-ווליום.
      const wash = (f as { selfCross?: boolean }).selfCross === true;
      ledger.fills.push({
        key, at: f.at, side: f.side === "maker" ? "maker" : "taker",
        direction: recvSteem ? "bought-steem" : "sold-steem",
        paid: f.paid, received: f.received, steemUsd, sbdUsd, paidUsd, recvUsd,
        edgeBps: wash ? 0 : edgeBps,
        // N1 · הדגל-המכריע: wash-מילויים מסומנים-על-הפנקס — סולם-המדרגות (spread-tiers)
        // סופר-רק מילויי-חוץ-אמת; בלי-הדגל ההיסטוריה-הישנה תישאר עמומה. fail-honest.
        ...(wash ? { selfCross: true as const } : {}),
      });
      const oid = f.openOrderid ?? f.currentOrderid;
      if (oid) {
        const rec = ledger.orders.find((x) => x.id === oid && x.status === "open");
        if (rec) { rec.status = "filled"; rec.lastSeenAt = new Date().toISOString(); ledger.filledTotal++; }
      }
      if (wash) {
        console.log(`[grid-beat] SELF-CROSS (wash) fill recorded at edge 0: ${f.paid} -> ${f.received} — volume only, NOT external profit (R-GRID-WAR honesty)`);
      } else {
        ledger.externalFlowUsd = Math.round((ledger.externalFlowUsd + (recvUsd - paidUsd)) * 1e6) / 1e6;
        console.log(`[grid-beat] REAL FILL counted: ${f.paid} -> ${f.received} · edge ${edgeBps}bps vs live marks (marked-at-detection)`);
      }
    }
  }
  /* ── R99 · רגל-HIVE — אותה דוקטרינה, אותו חוק, שוק-פנימי אמת שני ─────────── */
  const hm = await import("./src/lib/dex/hivemarket");
  const hiveUsd = feeds?.usd.hive ?? null;
  const hbdUsd = feeds?.usd.hbd ?? null;
  const hiveParity = hiveUsd && hbdUsd && hiveUsd > 0 && hbdUsd > 0 ? hiveUsd / hbdUsd : null; // HBD ל-1-HIVE בזהות-חוץ
  let hivePlaced = 0, hiveCancelled = 0;
  const hiveBlocker: string[] = [];
  /* N3 · כנות-הצהרתית (cycle 28): שוק-שבור אינו "המתנה" — הוא נחמה-מפורשת.
   * הרגל אינה נכשלת כשהיא מסרבת לסחור בשוק-שבור: היא מכריזה DISARMED-
   * BROKEN-MARKET עם חוק-ריארמון אוטומטי (אין-מגע-ידני, אין-שקר של ARMED-WAITING). */
  let hiveMarketBroken = false;
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
      if (Math.abs(devBps) > HIVE_PARITY_BAND_BPS) {
        hiveMarketBroken = true; // N3: מסרבים-בגלוי לסחור בשוק-שבור — זו כנות, לא-כישלון
        hiveBlocker.push(`hive book mid deviates ${devBps}bps from external parity: refusing to trade a broken market`);
      }
    }

    /* POLICY-ENGINE (SAOS-POLICY-ENGINE/1, DECISIONS #17) · שער-מחזור גם על רגל-ה-HIVE —
     * אותו-חוק, אותו-fail-closed; HALT ⇒ hiveBlocker ⇒ אפס-חתימות ברגל-ה-HIVE. */
    const hivePgate = policyCycleGate({ tool: "grid-beat:hive", lane: "grid", account: ACCOUNT, opsEst: hs.openOrders.length + HIVE_ASK_LEVELS_LIVE + HIVE_BID_LEVELS_LIVE, notionalSbdUpper: (hs.balances.hive * (hiveParity ?? 0) + hs.balances.hbd) * HIVE_COMMIT_PCT, chain: "hive" });
    if (!hivePgate.allow) hiveBlocker.push(`POLICY-HALT (hive leg): ${hivePgate.reasons.join(" ; ")} — atomic refresh skipped`);
    if (hiveArmed && hiveParity && hs.book.bestBid && hs.book.bestAsk && hs.rc.ok && hiveBlocker.length === 0) {
      /* 9-c · מונה-שידורים גם-כאן — כנות זהה לרגל-ה-STEEM */
      let hbcAttempted = 0, hbcFailed = 0;
      /* 1) ביטול ההזמנות שלנו — רענון אטומי (HIVE) */
      for (const o of hs.openOrders) {
        hbcAttempted++;
        try {
          await hm.hiveCancelOrder(o.id);
          hiveCancelled++;
          const rec = ledger.orders.find((x) => x.id === o.id && x.chain === "hive");
          if (rec) { rec.status = "cancelled"; rec.lastSeenAt = new Date().toISOString(); }
          console.log(`[grid-beat] hive cancelled #${o.id} (${o.sell} -> ${o.receive})`);
        } catch (e) {
          hbcFailed++;
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
      const hiveAvail = hs.balances.hive - HIVE_MIN_KEEP_LIVE;
      const hiveCommit = Math.max(0, Math.floor(hiveAvail * HIVE_COMMIT_PCT * 1000) / 1000);
      if (hiveCommit >= HIVE_MIN_LEVEL_LIVE * HIVE_ASK_LEVELS_LIVE) {
        const per = Math.floor((hiveCommit / HIVE_ASK_LEVELS_LIVE) * 1000) / 1000;
        for (let k = 1; k <= HIVE_ASK_LEVELS_LIVE; k++) {
          const px = hiveParity * (1 + (HIVE_ASK_STEP_BPS_LIVE * k) / 10_000);
          const sellAmt = per;
          // R99-מדוד (מילויים חיים על השרשרת): הרצפה על 0.001 HBD הפילה את מחיר האבק מתחת
          // לכוונה — מכירה מתחת לערך אסורה. עתה: ceil על התקבול (לעולם לא מתחת לכוונה)
          // + רמה שהמיל-צעד שלה מעוות את המחיר ביותר מ-0.5% נדלגת בכנות.
          const recvTrue = sellAmt * px;
          const recv = Math.ceil(recvTrue * 1000) / 1000;
          if (recv < HIVE_ASK_MIN_RECV_HBD_LIVE) continue; // גרעיניות-מחיר לא נשמרת — המלאי בונה
          if (recv / recvTrue > 1.005) continue; // עיוות-מיל מעבר לצעד הפריסה — דלג בכנות
          const hiveOpGate = perOpAllow("grid-beat:hive", ACCOUNT, "hive", "ask", sellAmt * px, px, sellAmt);
          if (!hiveOpGate.allow) { console.warn(`[grid-beat] hive ask level ${k} POLICY-SKIP (per-op): ${hiveOpGate.why}`); continue; }
          const id = nextHiveId(); hseq++;
          hbcAttempted++;
          try {
            const r = await hm.hivePlaceOrder({ orderid: id, amountToSell: `${dp3(sellAmt)} HIVE`, minToReceive: `${dp3(recv)} HBD`, expirationDays: HIVE_EXPIRY_DAYS });
            hivePlaced++;
            ledger.orders.push({ id, at: new Date().toISOString(), txid: r.txid, side: "ask", chain: "hive", sell: `${dp3(sellAmt)} HIVE`, receive: `${dp3(recv)} HBD`, priceSbdPerSteem: px, status: "open", lastSeenAt: new Date().toISOString() });
            console.log(`[grid-beat] hive ask #${id}: ${dp3(sellAmt)} HIVE -> ${dp3(recv)} HBD @${px.toFixed(6)} (parity+${(HIVE_ASK_STEP_BPS_LIVE * k) / 100}%) txid ${r.txid.slice(0, 12)}`);
          } catch (e) {
            hbcFailed++;
            console.warn(`[grid-beat] hive ask #${id} rejected: ${String(e).slice(0, 90)}`);
          }
        }
      } else {
        hiveBlocker.push(`hive sell-side waiting for price-grade inventory: ${hiveCommit.toFixed(3)} HIVE commitable; ask levels need ≥ ${HIVE_ASK_MIN_RECV_HBD_LIVE} HBD recv each (HBD mill-tick price fidelity, measured R99)`);
      }

      // מדף-הקנייה: מתחת לביד הטוב — כולן מעל-ערך מדוד מול הציון (עיקרון 2, גם ב-HIVE)
      const hbdCommit = Math.max(0, Math.floor(hs.balances.hbd * HIVE_COMMIT_PCT * 1000) / 1000);
      if (hbdCommit >= HIVE_MIN_LEVEL_HBD_LIVE * HIVE_BID_LEVELS_LIVE && hs.book.bestBid) {
        const per = Math.floor((hbdCommit / HIVE_BID_LEVELS_LIVE) * 1000) / 1000;
        for (let k = 1; k <= HIVE_BID_LEVELS_LIVE; k++) {
          const px = hs.book.bestBid * (1 - (HIVE_BID_STEP_BPS_LIVE * k) / 10_000);
          // חוק-הזהות (R99): רק קנייה מתחת לקו-הזהות החיצוני נספרת כעודף —
          // רמה מעל הקו (פרימיום-HBD חריגה) נדלגת בכנות. לעולם לא משלמים מעל-ערך.
          if (hiveParity !== null && px >= hiveParity) continue;
          const recv = Math.floor(per / px * 1000) / 1000; // HIVE
          if (recv < HIVE_MIN_LEVEL_LIVE) continue;
          const hiveBidGate = perOpAllow("grid-beat:hive", ACCOUNT, "hive", "bid", per, px, per);
          if (!hiveBidGate.allow) { console.warn(`[grid-beat] hive bid level ${k} POLICY-SKIP (per-op): ${hiveBidGate.why}`); continue; }
          const id = nextHiveId(); hseq++;
          hbcAttempted++;
          try {
            const r = await hm.hivePlaceOrder({ orderid: id, amountToSell: `${dp3(per)} HBD`, minToReceive: `${dp3(recv)} HIVE`, expirationDays: HIVE_EXPIRY_DAYS });
            hivePlaced++;
            ledger.orders.push({ id, at: new Date().toISOString(), txid: r.txid, side: "bid", chain: "hive", sell: `${dp3(per)} HBD`, receive: `${dp3(recv)} HIVE`, priceSbdPerSteem: px, status: "open", lastSeenAt: new Date().toISOString() });
            console.log(`[grid-beat] hive bid #${id}: ${dp3(per)} HBD -> ${dp3(recv)} HIVE @${px.toFixed(6)} txid ${r.txid.slice(0, 12)}`);
          } catch (e) {
            hbcFailed++;
            console.warn(`[grid-beat] hive bid #${id} rejected: ${String(e).slice(0, 90)}`);
          }
        }
      } else {
        hiveBlocker.push(`hive buy-side waiting for HBD inventory: ${hbdCommit.toFixed(3)} HBD commitable < ${(HIVE_MIN_LEVEL_HBD_LIVE * HIVE_BID_LEVELS_LIVE).toFixed(3)} needed`);
      }
      /* 9-c · כנות-שידור HIVE */
      if (hbcAttempted > 0 && hbcFailed > 0) {
        hiveBlocker.push(`hive broadcast failing: ${hbcFailed}/${hbcAttempted} chain ops rejected this run — stale key/authority or node fault; verdict cannot be stable`);
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
        // R-GRID-WAR (task-20): wash-עצמי — edge 0, מחוץ-ל-externalFlowUsd (כנות)
        const wash = (f as { selfCross?: boolean }).selfCross === true;
        ledger.fills.push({
          key, at: f.at, side: f.side === "maker" ? "maker" : "taker", chain: "hive",
          direction: recvHive ? "bought-hive" : "sold-hive",
          paid: f.paid, received: f.received, steemUsd: hiveUsd, sbdUsd: hbdUsd, paidUsd, recvUsd,
          edgeBps: wash ? 0 : edgeBps,
          ...(wash ? { selfCross: true as const } : {}), // N1: הדגל-המכריע גם-על-רגל-HIVE
        });
        const oid = f.openOrderid ?? f.currentOrderid;
        if (oid) {
          const rec = ledger.orders.find((x) => x.id === oid && x.chain === "hive" && x.status === "open");
          if (rec) { rec.status = "filled"; rec.lastSeenAt = new Date().toISOString(); ledger.filledTotal++; }
        }
        if (wash) {
          console.log(`[grid-beat] HIVE SELF-CROSS (wash) fill recorded at edge 0: ${f.paid} -> ${f.received} — volume only, NOT external profit`);
        } else {
          ledger.externalFlowUsd = Math.round((ledger.externalFlowUsd + (recvUsd - paidUsd)) * 1e6) / 1e6;
          console.log(`[grid-beat] HIVE REAL FILL counted: ${f.paid} -> ${f.received} · edge ${edgeBps}bps vs live marks (marked-at-detection)`);
        }
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
      verdict: !hiveArmed ? "DISARMED-NO-KEY"
        : hiveMarketBroken ? "DISARMED-BROKEN-MARKET" // N3: הצהרה-מפורשת — לא ARMED-WAITING שקרי
        : hivePlaced > 0 ? "ARMED-LIVE"
        : hiveBlocker.length ? "ARMED-WAITING"
        : "ARMED-STABLE",
      /* N3 · חוק-הריארמון: הרגל חוזרת-לחיים לבד בפעימה-הבאה כשהשוק מתיישר —
       * אפס-מגע-ידני, ההצהרה עצמה היא-החוזה. */
      reArm: hiveMarketBroken
        ? "leg re-arms automatically on the next beat when |bookMid − externalParity| ≤ parity band — declarative honesty, zero manual intervention"
        : null,
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
  // 24-e (2026-10-13) · aggregate-only law at the writer itself — restores the exec-22/22-b minimization upstream:
  // the public book publishes verdict + status + summary + freshness + chain labels ONLY (saos/grid-truth/4-aggregate style):
  // zero account identity (the account field removed — the verdict and the counters are the public identifier) and zero keys
  // (the keyGate live-authority pubkey removed — authority is measured as ok/authorityOk booleans only).
  // measured: the public consumers (Domain index loadGrid, receipts wall) read publishedAt/verdict/chains/chain/blocker only.
  const publicDoc = {
    ok: true,
    publishedAt: new Date().toISOString(),
    engine: "saos-dex/1.1 grid-beat · R24 external flow + R99 HIVE leg",
    chain: "STEEM-internal-market",
    chains: ["STEEM", "HIVE"],
    real: true,
    armed,
    /* 9-c · verdict-אמת: ARMED-KEY-STALE כשה-WIF לא גוזר את הרשות-החיה — אף-שידור לא נוסה.
     * ARMED-BROADCAST-FAILING כשהשרשרת דחתה-שידורים. לעולם לא ARMED-STABLE עם-כישלונות. */
    verdict: !armed ? "DISARMED-NO-KEY"
      : keyGate && !keyGate.ok ? "ARMED-KEY-STALE"
      : placed + hivePlaced > 0 ? "ARMED-LIVE"
      : blocker.length ? "ARMED-WAITING"
      : "ARMED-STABLE",
    blocker: blocker.length ? blocker : null,
    keyGate: keyGate ? { ok: keyGate.ok, authorityOk: keyGate.authorityOk } : null,
    zombieOrders: zombieOrders.length ? { count: zombieOrders.length, ids: zombieOrders.slice(0, 12), note: "open on-chain but not known-open in the ledger — ledger/chain drift surfaced honestly (lost concurrent push, or another actor trading this account)" } : null,
    hive: hiveLeg,
    policy: {
      principle: "never sell STEEM below its external USD value; every buy below parity is measured surplus",
      commitPct: LIVE_COMMIT_PCT, bidLevels: LIVE_BID_LEVELS, bidStepBps: LIVE_BID_STEP_BPS,
      askLevels: LIVE_ASK_LEVELS, askStepBps: LIVE_ASK_STEP_BPS, expiryDays: LIVE_EXPIRY_DAYS,
      /* N1 · המדרגה-החיה מפורסמת-בגלוי: tier/steps/evidence — אין-הידוק-סמוי */
      spreadTiers: TIER,
      hiveCommitPct: HIVE_COMMIT_PCT,
      paramsSource: GP.note ?? "grids/state/grid-params.json (validated fail-closed by grids/validate-params.mjs before every run)",
      directiveR24: "powerdown is read-only here: never opened, never replaced, fleet RC is sacred",
    },
    marks: { steemUsd, sbdUsd, paritySbdPerSteem: parity },
    /* N8 · PRICE-TRUTH מפורסם-בגלוי: הקו-המשולש + הדה-פג-המדוד של SBD — אין-קו-ערך-סמוי */
    priceTruth: PT ? { verdict: PT.verdict, valueLineSbdPerSteem: PT.valueLineSbdPerSteem, marks: PT.marks, notes: PT.notes, measuredAt: PT.measuredAt, law: PT.law } : null,
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
    // G76-a · מדידת-אמת: החלון-הנע מוצג-לצד-המונה-המצטבר (אפס-הסתרת-פעילות):
    realFillsCumulative: realFillsCumulative(),
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
    execSync('git config user.email "grid-beat[bot]@agents.roshpinacare-sys"', { encoding: "utf8", cwd: PUB });
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
  // W34 fail-honest: המסלול הזה היה שקט-לחלוטין בכשל (allowFail בולע) — נמדד-חי
  // 2026-10-21T16:50Z: 6 הצבות אמיתיות על-השרשרת וה-ledger מעולם לא הגיע ל-origin/main
  // בלי מילה אחת בלוג. כל-צעד מדבר עתה: add, staged, commit, push — ושקט-אמיתי נשאר שקט.
  gitLoud('config user.name "grid-beat[bot]"');
  gitLoud('config user.email "grid-beat[bot]@agents.roshpinacare-sys"');
  // W34 root-cure (measured live 17:03Z): git add is all-or-nothing — the missing
  // optional pathspec grids/state/policy-arm.json (the owner arm file, absent from
  // the tree) fatals the WHOLE add, staged stayed EMPTY, and every run's ledger with
  // its real placements died quietly for days. Per-file adds now: optional state
  // files may be absent (honest skip, said out loud), core books must add or scream.
  let coreAddOk = true;
  for (const f of ["db/grid-ledger.json", "db/grid-public.json"]) {
    if (!gitLoud(`add -- "${f}"`).ok) coreAddOk = false; // DECISIONS #17 core books
  }
  for (const f of ["grids/state/policy-ledger.jsonl", "grids/state/policy-arm.json"]) {
    const r = gitLoud(`add -- "${f}"`); // DECISIONS #17: policy verdict receipts + owner arm file live in git when present (auditable)
    if (!r.ok) console.log(`[grid-beat] optional state file absent — honest skip: ${f}`);
  }
  const staged = git("diff --cached --name-only", { allowFail: true });
  if (staged) {
    const cRes = gitLoud(`commit -m "grid-beat: ${placed + hivePlaced} placed (steem ${placed} / hive ${hivePlaced}) · ${cancelled + hiveCancelled} cancelled · ${ledger.fills.length} fills in window · ${realFillsCumulative()} realFills cumulative · ${new Date().toISOString().slice(0, 16)}Z"`);
    const ok = await pushWithRetry(ROOT, "main");
    console.log(`[grid-beat] ledger lane: coreAdd=${coreAddOk ? "ok" : "FAILED"} · staged=[${staged.split("\n").join(",")}] · commit=${cRes.ok ? "ok" : "FAILED"} · push=${ok ? "ok" : "FAILED — next run rebases and continues"}`);
    if (!ok) console.warn("[grid-beat] ledger push rejected (concurrent run) — next run rebases and continues");
  } else if (placed + hivePlaced + cancelled + hiveCancelled > 0 || !coreAddOk) {
    console.error(`[grid-beat] ledger lane BUG (W34): ${placed + hivePlaced} placed / ${cancelled + hiveCancelled} cancelled executed on-chain but staged is EMPTY (coreAdd ${coreAddOk ? "ok — investigate no-diff path" : "FAILED — see error above"}) · fills=${ledger.fills.length} — the ledger is not allowed to lose chain ops quietly`);
  } else {
    console.log("[grid-beat] ledger lane: nothing changed (0 ops) — clean skip");
  }
  console.log(`[grid-beat] done in ${((Date.now() - t0) / 1000).toFixed(1)}s · verdict=${publicDoc.verdict} · hive=${(hiveLeg as { verdict?: string }).verdict ?? "?"}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("[grid-beat] FATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
