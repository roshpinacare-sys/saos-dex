/**
 * htlc.ts — הגשר-האטומי-הפנימי של SAOS-DEX (G70 §7.2 · wave 19.82)
 *
 * מה-שהבעלים-ציווה: "Establish local cross-asset bridge routers using atomic
 * swaps and hash-time locked contracts (HTLC) operating 100% within our
 * sovereign mesh" — אפס-RPC-חוץ לסליקה, אפס-אמון בצד-שני.
 *
 * ההשלמה-המדויקת ל-bridge.ts (SETTLE-12): הגשר-החוץ הוא-מודל-אמון-במפעיל
 * (escrow-ריבוני + שחרור-מאומת-מפעיל). כאן: הפרימיטיב-חסר-האמון — שני-צדדים
 * נועלים נכסים על אותו-hashlock; חשיפת-ה-preimage על השרשרת היא העד-ציבורי
 * שמשלים את שתי-הרגליים בלי-שום-צד-שלישי. הרכבה קלאסית: היוזם נועל עם
 * timeout ארוך, הנגד נועל עם timeout קצר; היוזם תובע מהקצר (חושף-סוד),
 * הנגד קורא את-העד-מהמצב-הציבורי ותובע מהארוך.
 *
 * שעון-המצב: timeoutH הוא **גובה-בלוקים** (השרשרת נולדת בבלוק-כל-3ש') —
 * אפס-Date.now בגרעין, דטרמיניזם-מלא (אותו-חוק של SETTLE-9).
 *
 * חוקי-הברזל (נבדקים-אחד-לאחד ב-htlc.test.ts):
 *   I1 שימור: bal(htlc-escrow, asset) === Σ חוזים-חיים (פר-נכס)
 *   I2 אין-תביעה-אחרי-פקיעה (height > timeoutH → החזר-בלבד)
 *   I3 אין-החזר-לפני-פקיעה (height <= timeoutH → תביעה-בלבד)
 *   I4 קשירת-hashlock מדויקת (sha256(preimage) === hashlock — אותו-sha256
 *      של canonical.ts, העקביות-עם-stateRoot עצמו)
 *   I5 הסתיים-פעם-אחת (claimed/refunded סופיים)
 *   I6 קשירת-צדדים (רק-`to` תובע · רק-`from` מחזיר)
 *   I7 משמעת-replay (ה-prelude של-applyOp — אותו-dedupe של-הכל)
 *
 * דחייה-לפני-נגיעה: כל-השערים לפני consume() — op-נדחה לא שורף גז, לא
 * נונס, לא נוגע במצב (חוק Roast-65-a L2).
 *
 * אין-תלות-ריצה-על-kernel (type-only בלבד) — kernel.ts קורא לכאן, לא
 * להפך; אפס-מעגל-ייבוא-ריצה.
 */
import { sha256 } from "./canonical";
import type { DexState, Op, OpResult } from "./kernel";

/** חשבון-הערבות-הייעודי — אותו-דפוס VE_VAULT: הכסף-זז-רק-דרך-הגרעין,
 * נכלל-ב-stateRoot/מרקל/אינווריאנטות-הברזל אוטומטית (דרך-applyOp). */
export const HTLC_ESCROW = "htlc-escrow";

/** תקרת-אופק-הנעילה: 1M בלוקים (~35 יום בבלוק-כל-3ש') — עוגן-צף-חסום,
 * אין-נעילות-נצחיות. */
export const HTLC_MAX_TIMEOUT_H = 1_000_000;

/** אורך-מרבי ל-preimage (מחרוזת-סוד) — חוזה-ברור, אפס-הצפת-זיכרון. */
export const HTLC_MAX_PREIMAGE_LEN = 256;

const HTLC_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
const HASHLOCK_RE = /^[0-9a-f]{64}$/;
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** אותו-סט-אסור של הגרעין (prototype-pollution · Roast-64) — כפילות-מוצדקת:
 * htlc.ts אסור שיייבא ריצה מ-kernel (מעגל). הגנה-כפולה fail-closed. */
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

export interface HtlcRecord {
  from: string; // הנועל (היוזם)
  to: string; // המוטב (רק-הוא יכול לתבוע עם ה-preimage)
  asset: string;
  amount: number; // µ
  hashlock: string; // 64-hex · sha256(preimage)
  timeoutH: number; // גובה-פקיעה: עד-וכולל height תביעה; מעליו החזר-בלבד
  createdAtH: number;
  state: "locked" | "claimed" | "refunded";
  settledAtH?: number;
  preimage?: string; // נחשף-על-השרשרת בתביעה — העד-הציבורי (I8)
}

type Consume = () => OpResult | null;

/** תוצאת-עזר צנועה — ה-case-בגרעין חותם עליה את-הגז האמיתי
 * ({ok:true,gas} · {ok:false,err,gas:0} — חוק-הגז של-OpResult). */
export type HtlcResult = { ok: true } | { ok: false; err: string };

/* ── עזרי-קריאה מקומיים (אותן-נוסחאות של-הגרעין — אפס-ייבוא-ריצה) ── */
const balOf = (st: DexState, who: string, a: string): number => st.balances[who]?.[a] ?? 0;
const lockedOf = (st: DexState, who: string, a: string): number => st.locked[who]?.[a] ?? 0;
const availOf = (st: DexState, who: string, a: string): number => balOf(st, who, a) - lockedOf(st, who, a);

/** addBal מקומי — אותו-חוזה כמו-kernel.addBal (שלם + forbidden fail-closed). */
function move(st: DexState, who: string, a: string, d: number): void {
  if (!Number.isSafeInteger(d)) throw new Error("non-integer htlc balance delta");
  if (FORBIDDEN.has(who) || FORBIDDEN.has(a)) throw new Error("forbidden-state-key");
  const b = (st.balances[who] = st.balances[who] ?? {});
  b[a] = (b[a] ?? 0) + d;
}

/** מפת-החוזים — prototype-חסר (הגנה-מבנית על מזהה-משתמש) + תאימות-תמונות-ישנות. */
function htlcMap(st: DexState): Record<string, HtlcRecord> {
  if (!st.htlcs || typeof st.htlcs !== "object") st.htlcs = {};
  return st.htlcs;
}

/* ── htlc_create · נעילת-הרגל-הראשונה ─────────────────────────────────── */
export function createHtlc(st: DexState, op: Op, consume: Consume): HtlcResult {
  const issuer = String(op.issuer);
  const id = typeof op.htlcId === "string" ? op.htlcId : "";
  if (!HTLC_ID_RE.test(id) || FORBIDDEN.has(id)) return { ok: false, err: "bad-htlc-id" };
  const map = htlcMap(st);
  if (map[id]) return { ok: false, err: "htlc-id-taken" }; // מזהה-חד-פעמי-לנצח (גם-אחרי-הסתיימות)
  const to = typeof op.to === "string" ? op.to : "";
  if (!NAME_RE.test(to)) return { ok: false, err: "bad-recipient" };
  if (to === issuer) return { ok: false, err: "recipient-must-differ" };
  const amount = op.amount ?? 0;
  if (!(amount > 0)) return { ok: false, err: "bad-amount" };
  const hashlock = typeof op.hashlock === "string" ? op.hashlock.toLowerCase() : "";
  if (!HASHLOCK_RE.test(hashlock)) return { ok: false, err: "bad-hashlock" };
  const timeoutH = op.timeoutH;
  if (
    timeoutH === undefined ||
    !Number.isSafeInteger(timeoutH) ||
    timeoutH <= st.height ||
    timeoutH > st.height + HTLC_MAX_TIMEOUT_H
  )
    return { ok: false, err: "bad-timeout" };
  const asset = String(op.asset ?? "");
  if (availOf(st, issuer, asset) < amount) return { ok: false, err: "insufficient" };

  const c = consume();
  if (c) return c;

  move(st, issuer, asset, -amount);
  move(st, HTLC_ESCROW, asset, amount);
  map[id] = {
    from: issuer,
    to,
    asset,
    amount,
    hashlock,
    timeoutH,
    createdAtH: st.height,
    state: "locked",
  };
  return { ok: true };
}

/* ── htlc_claim · מימוש-ב-preimage (העד-על-השרשרת) ────────────────────── */
export function claimHtlc(st: DexState, op: Op, consume: Consume): HtlcResult {
  const issuer = String(op.issuer);
  const id = typeof op.htlcId === "string" ? op.htlcId : "";
  const rec = htlcMap(st)[id];
  if (!rec) return { ok: false, err: "unknown-htlc" };
  if (rec.state !== "locked") return { ok: false, err: "not-locked" };
  if (issuer !== rec.to) return { ok: false, err: "not-recipient" };
  const preimage = typeof op.preimage === "string" ? op.preimage : "";
  if (!preimage || preimage.length > HTLC_MAX_PREIMAGE_LEN)
    return { ok: false, err: "bad-preimage" };
  if (sha256(preimage) !== rec.hashlock) return { ok: false, err: "hashlock-mismatch" };
  if (st.height > rec.timeoutH) return { ok: false, err: "expired" };

  const c = consume();
  if (c) return c;

  move(st, HTLC_ESCROW, rec.asset, -rec.amount);
  move(st, rec.to, rec.asset, rec.amount);
  rec.state = "claimed";
  rec.settledAtH = st.height;
  rec.preimage = preimage; // העד-הציבורי — כל-צומת מאמת sha256(preimage)===hashlock
  return { ok: true };
}

/* ── htlc_refund · החזר-אחרי-פקיעה (רשת-הבטיחות של-היוזם) ─────────────── */
export function refundHtlc(st: DexState, op: Op, consume: Consume): HtlcResult {
  const issuer = String(op.issuer);
  const id = typeof op.htlcId === "string" ? op.htlcId : "";
  const rec = htlcMap(st)[id];
  if (!rec) return { ok: false, err: "unknown-htlc" };
  if (rec.state !== "locked") return { ok: false, err: "not-locked" };
  if (issuer !== rec.from) return { ok: false, err: "not-sender" };
  if (st.height <= rec.timeoutH) return { ok: false, err: "not-expired" };

  const c = consume();
  if (c) return c;

  move(st, HTLC_ESCROW, rec.asset, -rec.amount);
  move(st, rec.from, rec.asset, rec.amount);
  rec.state = "refunded";
  rec.settledAtH = st.height;
  return { ok: true };
}

/* ── מבקר-השימור (I1) — קריאה-טהורה, אפס-נגיעה-במצב ──────────────────── */
export function htlcInvariant(st: DexState): {
  ok: boolean;
  lockedTotal: number; // Σ חוזים-חיים (µ, כל-הנכסים)
  activeTotal: number; // Σ יתרת-כספת-ה-escrow
  seams: string[]; // פר-נכס: "asset: locked=X active=Y"
} {
  const lockedPerAsset: Record<string, number> = {};
  for (const rec of Object.values(st.htlcs ?? {})) {
    if (rec?.state !== "locked") continue;
    lockedPerAsset[rec.asset] = (lockedPerAsset[rec.asset] ?? 0) + rec.amount;
  }
  const assets = new Set<string>([
    ...Object.keys(lockedPerAsset),
    ...Object.keys(st.balances[HTLC_ESCROW] ?? {}),
  ]);
  const seams: string[] = [];
  let lockedTotal = 0;
  let activeTotal = 0;
  for (const a of assets) {
    const locked = lockedPerAsset[a] ?? 0;
    const active = balOf(st, HTLC_ESCROW, a);
    lockedTotal += locked;
    activeTotal += active;
    if (locked !== active) seams.push(`${a}: locked=${locked} active=${active}`);
  }
  return { ok: seams.length === 0, lockedTotal, activeTotal, seams };
}
