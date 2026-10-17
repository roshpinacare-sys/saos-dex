/**
 * envelope.ts — המתרגם הקנוני: מעטפת מחתימה (wallet ציבורי / שער-מאורח) → op-גרעין.
 * ================================================================================
 * עד-היום הלב קיפל רק dex.order/dex.cancel/deposit.claim — בזמן שה-wallet הציבורי
 * מחתים dex.offer {cur,units,price} · token.transfer {symbol,to,amount} ·
 * wallet.create {nick?}. התוצאה נמדדה: פקודות משתמש חתומות נבלעו בשקט —
 * הבורסה "לא עובדת" למרות שהמנוע אמיתי. מודול זה הוא החוזה האחד:
 *
 *   · אפס סודות, אפס I/O, אפס מצב — פונקציה טהורה, נבדקת-מקצה-לקצה.
 *   · יחידות: dex.offer.units ו-token.transfer.amount הם µ-מחרוזות (כבר-×1000,
 *     ה-wallet חותם אותן כך מ-toUnits(x,3)); dex.order.price/amount הם אדם-קריא
 *     ומוכפלים לכאן ×1000 (החוזה של השער-המאורח, זהה לליבת cloud-beat הקיימת).
 *   · מחיר-גרעין = µ-ציטוט ליחידת-בסיס שלמה (kernel.ts case "order").
 *   · issuer/to מנורמלים לחוק-החשבון-הקנוני R33: "u:" + כתובת-קטנה.
 *   · דחייה היא תשובה כנה עם סיבה — אף דממה, אף בליעה.
 *
 * לא כאן: אימות-חתימה saos1 (cloud-beat verifyEnvelope לפני התרגום), וגז/escrow
 * (השרשרת עצמה אוכפת — דחיית-בלוק היא תשובה כנה, התביעה נשארת פתוחה).
 */

/** סוגי-המעטפות שה-wallet הציבורי (Domain/wallet.html · saos-live.js) מחתים ומשדר. */
export type EnvelopeKind =
  | "wallet.create" | "dex.order" | "dex.offer" | "dex.cancel"
  | "token.transfer" | "deposit.claim";

/** op-גרעין מוכן (submitOp ישלים issuer/nonce — הם נגזרים מהמעטפת, לא מהמתרגם). */
export interface TranslatedOp {
  type: "order" | "cancel" | "transfer";
  base?: string; quote?: string; side?: "buy" | "sell"; price?: number; amount?: number;
  orderId?: number;
  to?: string; asset?: string;
}

export type EnvelopeTranslation =
  | { ok: true; kind: "order" | "cancel" | "transfer"; op: TranslatedOp }
  | { ok: true; kind: "ack"; note: string }
  | { ok: false; reason: string };

const CUR_RE = /^[A-Z]{2,10}$/;
const MU_RE = /^\d{1,15}$/; // µ-מחרוזת (ה-wallet שולח toUnits(x,3) — ספרות-בלבד)
const isFin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const humanToMu = (v: unknown): number | null => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const mu = Math.round(n * 1000);
  return mu > 0 ? mu : null;
};
const muFromStr = (v: unknown): number | null => {
  if (typeof v !== "string" || !MU_RE.test(v)) return null;
  const n = Number(v);
  return n > 0 && Number.isSafeInteger(n) ? n : null;
};
/** חוק-החשבון-הקנוני (R33): "u:" + אותיות-קטנות. saos1 רגיש-רישיות — הגרעין מנרמל. */
export const canonicalAccount = (addr: unknown): string | null => {
  if (typeof addr !== "string") return null;
  const a = addr.trim().toLowerCase();
  if (/^saos1[1-9a-hj-np-z1-9km-z]{33,35}$/.test(a)) return "u:" + a;
  if (/^u:saos1[1-9a-hj-np-z1-9km-z]{33,35}$/.test(a)) return a;
  return null;
};

/** סוגי-המעטפות שמתרגם זה מבין (deposit.claim מטופל בלולאת-הזיכויים, לא כאן). */
export const TRANSLATED_KINDS: readonly string[] = [
  "dex.order", "dex.offer", "dex.cancel", "token.transfer",
];

/**
 * התרגום הקנוני. דחייה = סיבה מפורשת (הלב מתעד ומשאיר-פתוח או סוגר-בכנות).
 * הערה כנה: dex.offer הוא תמיד מכירה של SAOS (base=SAOS) — כך חתם אותו
 * ה-wallet מהיום-הראשון; dex.order הוא החוזה המוסדי המלא (base/quote/side).
 */
export function envelopeToKernelOp(env: Record<string, unknown>): EnvelopeTranslation {
  const k = String(env?.k ?? "");
  if (k === "wallet.create") return { ok: true, kind: "ack", note: "wallet.create — self-serve: החשבון חי מהזיכוי/הפעולה הראשונה (R33), אין op-רישום בגרעין" };
  if (k === "dex.offer") {
    const quote = String(env.cur ?? "").toUpperCase();
    const amount = muFromStr(env.units);
    const price = humanToMu(env.price);
    if (!CUR_RE.test(quote)) return { ok: false, reason: "dex.offer: bad-cur" };
    if (quote === "SAOS") return { ok: false, reason: "dex.offer: quote==base" };
    if (amount === null) return { ok: false, reason: "dex.offer: bad-units (µ expected)" };
    if (price === null) return { ok: false, reason: "dex.offer: bad-price" };
    return { ok: true, kind: "order", op: { type: "order", base: "SAOS", quote, side: "sell", price, amount } };
  }
  if (k === "dex.order") {
    const base = String(env.base ?? "").toUpperCase();
    const quote = String(env.quote ?? "").toUpperCase();
    const side = env.side === "buy" ? "buy" : env.side === "sell" ? "sell" : "";
    const price = humanToMu(env.price);
    const amount = humanToMu(env.amount);
    if (!CUR_RE.test(base) || !CUR_RE.test(quote) || base === quote) return { ok: false, reason: "dex.order: bad-pair" };
    if (side !== "buy" && side !== "sell") return { ok: false, reason: "dex.order: bad-side" };
    if (price === null || amount === null) return { ok: false, reason: "dex.order: bad-price-amount" };
    return { ok: true, kind: "order", op: { type: "order", base, quote, side, price, amount } };
  }
  if (k === "dex.cancel") {
    // שני השמות בשטח: ה-wallet שולח offerId, השער-המאורח שולח orderId — אותה משמעות.
    const raw = env.orderId ?? env.offerId;
    const orderId = Number(raw);
    if (!Number.isSafeInteger(orderId) || orderId <= 0) return { ok: false, reason: "dex.cancel: bad-order-id" };
    return { ok: true, kind: "cancel", op: { type: "cancel", orderId } };
  }
  if (k === "token.transfer") {
    const asset = String(env.symbol ?? "").toUpperCase();
    const to = canonicalAccount(env.to);
    const amount = muFromStr(env.amount);
    if (!CUR_RE.test(asset)) return { ok: false, reason: "token.transfer: bad-symbol" };
    if (!to) return { ok: false, reason: "token.transfer: bad-to (saos1 expected)" };
    if (amount === null) return { ok: false, reason: "token.transfer: bad-amount (µ expected)" };
    return { ok: true, kind: "transfer", op: { type: "transfer", asset, to, amount } };
  }
  return { ok: false, reason: `unknown-kind:${k || "∅"} — לא נסגר כמעובד (מהדורה-עתידית עשויה להבין)` };
}
