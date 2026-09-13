/* milestone.ts — THE-MILESTONE (SETTLE-17) · עיגון-אבני-דרך-P&L-על-Hive-באופן-אוטומטי
 * ═══════════════════════════════════════════════════════════════════════════════════
 * ההצעד-הבא-שהמפעיל-אישר ("אור-ירוק-מלא — תמשיך"): רווחי-המסילה נמדדים-בכנות
 * (MTM — mark-to-anchor) אך-עד-עת רק-בתוך-הרשת. העדות-האמיתית-היא-על-שרשרת-
 * חוץ-ציבורית. לצי-הריבוני (SETTLE-13) יש-קיבולת-RC-מדודה ~26-עיגונים-חינם/יום —
 * אבל-שני-פערים-היו:
 *   ① עיגוני-הצי-הידניים (route POST anchor) עקפו-בשקט-את-פנקס-העיגון-הציבורי
 *      (state/anchors.json) — 3-עיגוני-SETTLE-13-החיים-עם-txid-אמת-מעולם-לא-נרשמו.
 *   ② אין-עיגון-שגרתי-של-אבני-דרך-P&L — הרווח-חי-רק-בטלמטריה-פנימית.
 *
 * התיקון-והמנוע:
 *   · relay.recordFleetAnchor() — כל-עיגון-צי (ידני/אוטומטי) נרשם-כעת-בפנקס
 *     הציבורי + נכנס-לפיוס-האוטומטי (קריאה-חוזרת-get_transaction-מאמתת).
 *   · milestoneWatchdog — פעימה-דקתית-בתוך-תהליך-הבורסה-החי (globalThis-סינגלטון
 *     — לקח-SETTLE-12/16: אפס-split-brain). מעגן-אבן-דרך כש:
 *       - לצי-חשבון-שמיש (פרובה-TTL; אפס-RC-מת = דילוג-כן, אפס-ניסיון-שווא);
 *       - עברו ≥55 דקות מהעיגון-הקודם (תקציב-RC: ≤24/יום, מקום-לתור-החותמות);
 *       - הנטו חצה מדרגת 100kµ מאז-העיגון-הקודם, או חצי-יום-שלם-שקט (דופק).
 *   · המטען הציבורי: {protocol, action:"rail-milestone", height, stateRoot,
 *     digest, netMu, equityMu, fundedMu, doses} — כל-אחד-יכול-להשוות-מול-הרשת.
 *
 * אפס-סודות · אפס-הטבעה · כשל-שקט-מתועד (דילוג-אינו-כישלון-פעולה). */
import fs from "fs";
import path from "path";
import { railSummary } from "./rail";

export interface MilestoneLogEntry {
  at: string;
  height: number;
  netMu: number;
  txid: string;
  account: string;
}

export interface MilestoneSummary {
  enabled: boolean;
  started: boolean;
  lastAnchorAt: string | null;
  lastNetMu: number | null;
  lastHeight: number | null;
  lastTxid: string | null;
  lastAccount: string | null;
  anchored: number;
  skippedNoRc: number;
  skippedGap: number;
  errors: number;
  lastError: string | null;
  log: MilestoneLogEntry[];
  note: string;
}

/* תקציב-RC-מודע: הקיבולת-המדודה-של-הצי ~26-עיגונים/יום; תור-החותמות (chain-seal)
 * חולק-את-אותו-תקציב. 55 דקות → עד ~24-אבני-דרך/יום-תיאורטי, בפועל-פחות
 * כי-המדרגה-100kµ-מגבילה-עוד-לפני. */
const BEAT_MS = 60_000;
const MIN_GAP_MS = 55 * 60_000;
const STEP_MU = 100_000;
const HEARTBEAT_MS = 12 * 60 * 60_000;
const LOG_CAP = 12;

/* התמדה-קלה (state/milestone.json — אותה-משמעת-אטומית של-bridge.json):
 * בלעדיה, כל-התחלה-מחדש-של-הדמון-הייתה-מתייגת-"firstEver"-ושורפת-RC-על-עיגון-
 * כפול. המטבעות-לא-נוגעים — זו-רק-ראית-מתזמן (העדות-הציבורית-היא-על-Hive). */
const MARKER_FILE = path.join(process.cwd(), "state", "milestone.json");
interface Marker { lastAnchorAt: number; lastNetMu: number | null; anchored: number }
/* FIX(3-a · D8): קריאת-המארקר ממוזגת-TTL-60ש׳ — milestoneSummary() רץ בכל-תשובת
 * /api/dex/state (getState→milestone) ולא היה צריך fs-סינכרוני-חוזר. אותו-דפוס-TTL
 * של-הצי (fleet.ts PROBE_TTL_MS). saveMarker מעדכן-מיד-את-המטמון — אפס-עיגון-כפול. */
const MARKER_TTL_MS = 60_000;
const gMarker = globalThis as unknown as { __saosMilestoneMarker?: { at: number; marker: Marker } };
function loadMarker(): Marker {
  const c = gMarker.__saosMilestoneMarker;
  if (c && Date.now() - c.at < MARKER_TTL_MS) return c.marker;
  try {
    const raw = JSON.parse(fs.readFileSync(MARKER_FILE, "utf8")) as Marker;
    if (typeof raw?.lastAnchorAt === "number") {
      gMarker.__saosMilestoneMarker = { at: Date.now(), marker: raw };
      return raw;
    }
  } catch { /* אין-מארקר — חדש */ }
  const fresh: Marker = { lastAnchorAt: 0, lastNetMu: null, anchored: 0 };
  gMarker.__saosMilestoneMarker = { at: Date.now(), marker: fresh };
  return fresh;
}
function saveMarker(m: MilestoneRT): void {
  try {
    fs.mkdirSync(path.dirname(MARKER_FILE), { recursive: true });
    const tmp = MARKER_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ lastAnchorAt: m.lastAnchorAt, lastNetMu: m.lastNetMu, anchored: m.anchored }));
    fs.renameSync(tmp, MARKER_FILE);
    gMarker.__saosMilestoneMarker = { at: Date.now(), marker: { lastAnchorAt: m.lastAnchorAt, lastNetMu: m.lastNetMu, anchored: m.anchored } }; // FIX(3-a · D8): המטמון-מסונכרן-מיד-אחרי-כתיבה-מוצלחת
  } catch { /* כשל-כתיבה לא מפיל — העדות-החיה-על-Hive */ }
}

interface MilestoneRT {
  timer: ReturnType<typeof setInterval> | null;
  started: boolean;
  inFlight: boolean;
  lastAnchorAt: number;
  lastNetMu: number | null;
  lastHeight: number | null;
  lastTxid: string | null;
  lastAccount: string | null;
  anchored: number;
  skippedNoRc: number;
  skippedGap: number;
  errors: number;
  lastError: string | null;
  log: MilestoneLogEntry[];
}

/* לקח-SETTLE-12/16: RT-מודולי-מוכפל-בין-מופעי-באנדל — הכל-על-globalThis. */
const g = globalThis as unknown as { __saosMilestone?: MilestoneRT };
function rt(): MilestoneRT {
  if (!g.__saosMilestone) {
    const mk = loadMarker(); // התמדה-חוצה-הפעלות — אפס-עיגוני-כפילות-אחרי-restart
    g.__saosMilestone = {
      timer: null, started: false, inFlight: false, lastAnchorAt: mk.lastAnchorAt, lastNetMu: mk.lastNetMu,
      lastHeight: null, lastTxid: null, lastAccount: null, anchored: mk.anchored, skippedNoRc: 0,
      skippedGap: 0, errors: 0, lastError: null, log: [],
    };
  }
  return g.__saosMilestone;
}

/* הערה-על-סדר-הייבוא: כאן-אין-ייבוא-סטטי-של chain/fleet/relay (chain→milestone
 * היה-יוצר-מעגל; הכל-מגיע-דינמית-בזמן-ריצה — אותה-משמעת-של-bindLiveState). */

async function beat(): Promise<void> {
  const m = rt();
  if (m.inFlight) return;
  m.inFlight = true;
  try {
    // 1) תקציב-RC-קודם-הכל — אפס-ניסיונות-שווא-על-צי-ריק (היה: תור-דחיות-מתמיד)
    const { fleetStatusPublic, fleetSealNow, fleetProbe } = await import("./fleet");
    const { latestSealForFleet, recordFleetAnchor } = await import("./relay");
    await fleetProbe(false); // TTL-כפוי — RC-טרי-לפני-השער (מפחית-מרוץ-מול-תור-החותמות)
    const pub = fleetStatusPublic();
    if (!pub.configured || pub.usableCount === 0) {
      m.skippedNoRc += 1;
      return; // צי-ריק-כרגע (RC-מתחדש ~720M/יום-לחשבון) — דילוג-כן, לא-כישלון
    }
    // 2) חותם-חי-לעיגון (height/stateRoot/digest — אותם-בייטים-כמו-עיגון-חותמת)
    const seal = latestSealForFleet();
    if (!seal) { m.skippedGap += 1; return; }
    // 3) גייט-קצב+מדרגה — על-הנטו-החי-המסומן-לעוגן
    const rail = railSummary();
    const netMu = Math.floor(rail.netMu);
    const now = Date.now();
    const gapOk = now - m.lastAnchorAt >= MIN_GAP_MS;
    const lastNet = m.lastNetMu;
    const firstEver = lastNet === null;
    const stepOk = lastNet !== null && Math.abs(netMu - lastNet) >= STEP_MU;
    const heartbeatOk = m.lastAnchorAt > 0 && now - m.lastAnchorAt >= HEARTBEAT_MS;
    if (!firstEver && !gapOk) { m.skippedGap += 1; return; }
    if (!firstEver && !stepOk && !heartbeatOk) { m.skippedGap += 1; return; }
    // 4) עיגון-הצי — חתימה-מקומית-POSTING-בלבד, אפס-עלות, fail-closed
    const payload = {
      protocol: "saos-dex/v1", action: "rail-milestone", at: seal.at,
      height: seal.height, stateRoot: seal.stateRoot, digest: seal.digest,
      netMu, equityMu: Math.floor(rail.equityMu), fundedMu: Math.floor(rail.fundedMu),
      doses: rail.doses,
    };
    const r = await fleetSealNow(payload);
    // FIX(Roast-66 · milestone-double-anchor): מהרגע-הזה-השידור-הציבורי-קרה — המארקר
    // חייב-להישמר-לפני-כל-פעולה-שיכולה-לזרוק. הישן: recordFleetAnchor (קריאת-חוזר
    // לפיוס) יכלה-לזרוק → catch-החיצוני-היה-משאיר-מארקר-ישן → הטיק-הבא (60ש׳) עובר
    // gap/step ומעגן-**שוב**-את-אותה-אבן-דרך (ראיה-ציבורית-כפולה + RC). עכשיו:
    // מארקר-נשמר-מיד; הפיוס-ב-try-משלו — כישלון-פיוס = אזהרה, לא-עיגון-כפול.
    m.lastAnchorAt = now;
    m.lastNetMu = netMu;
    m.lastHeight = seal.height;
    m.lastTxid = r.txid;
    m.lastAccount = r.account;
    m.anchored += 1;
    m.lastError = null;
    m.log.unshift({ at: new Date(now).toISOString(), height: seal.height, netMu, txid: r.txid, account: r.account });
    m.log = m.log.slice(0, LOG_CAP);
    saveMarker(m);
    try {
      recordFleetAnchor(seal.height, seal.stateRoot, seal.digest, r.txid, r.account);
    } catch (recErr) {
      console.warn(`[saos-milestone] anchor-ok-but-reconcile-failed (marker saved, no double anchor): ${String((recErr as Error)?.message || recErr).slice(0, 140)}`);
    }
    console.info(`[saos-milestone] anchored rail-milestone h${seal.height} net=${netMu}µ via ${r.account} tx ${r.txid.slice(0, 12)}…`);
  } catch (e) {
    m.errors += 1;
    m.lastError = String((e as Error)?.message || e).slice(0, 160);
    console.warn(`[saos-milestone] skip/err: ${m.lastError}`);
  } finally {
    m.inFlight = false;
  }
}

/** הפעלת-הנגן — globalThis-גארד (לקח-ה-GUARDIAN): פעימה-אחת-לתהליך, לא-לבאנדל. */
export function startMilestoneWatchdog(): void {
  const m = rt();
  if (m.started) return;
  m.started = true;
  m.timer = setInterval(() => { void beat(); }, BEAT_MS);
  // פעימה-ראשונה-מיידית (לא-חוסמת) — כשיש-RC-חופף-ומדרגה-חוצה, העדות-יוצאת-עכשיו
  setTimeout(() => { void beat(); }, 4_000);
}

export function milestoneSummary(): MilestoneSummary {
  const m = rt();
  return {
    enabled: m.started,
    started: m.started,
    lastAnchorAt: m.lastAnchorAt ? new Date(m.lastAnchorAt).toISOString() : null,
    lastNetMu: m.lastNetMu,
    lastHeight: m.lastHeight,
    lastTxid: m.lastTxid,
    lastAccount: m.lastAccount,
    anchored: m.anchored,
    skippedNoRc: m.skippedNoRc,
    skippedGap: m.skippedGap,
    errors: m.errors,
    lastError: m.lastError,
    log: m.log,
    note: "אבני-דרך-P&L-נעגנות-אוטומטית-על-Hive-דרך-צי-העיגון (posting-only, אפס-עלות) — תקציב-RC-מודע: מדרגת-100kµ, פער-≥55 דק', דופק-12 ש'. כל-עיגון-נרשם-בפנקס-הציבורי-ומאומת-קריאה-חוזרת.",
  };
}
