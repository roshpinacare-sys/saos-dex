/**
 * maker.ts — מיוחס-מייקרים + מסגרת-ריבייטים (Maker-API framework) — חוץ-מצב קנוני.
 * ═════════════════════════════════════════════════════════════════════════════
 * EXEC-CD-8 · המאפשר-הקודי לפער-הנזילות (docs/COMPETITIVE-ANALYSIS-2026-10-06.md):
 * מייקרים-מקצועיים (חוץ או ארנה) צריכים ייחוס-אמת: מי סיפק את הצד-ההפוך בכל מילוי,
 * באיזה נפח, ומה מגיע לו. סטנדרט-בורסות (Binance maker-rebates / dYdX maker-rewards):
 * מדידה-תמידית → תשלום לפי-תעריף.
 *
 * כנות-עיצוב (אפס-מספרים-מזויפים):
 *  · הייחוס מוזן **ממסחר-אמת בלבד** — אותם TradeEvent של-הגרעין (kind:"fill" עם
 *    attribution maker) שמזינים את-הנרות (klines.ts). אין-הנחות, אין-אומדנים.
 *  · volMu = נומינל-ציטוט (price × amountMu) בשלמים — מדד-הריבייט הסטנדרטי.
 *  · EXEC-CD-9: התשלום ב-**קרדיטי-דלק** (מטבע-הגז) ממחזור-גז-הספר — הזרם-הסגור
 *    (מייקרים → גז → מד → אוצר → סליקה → מייקרים); אפס-אוצר-אמת-מסתכן.
 *    הסליקה: /api/dex/maker/rebate-settle — refuel-גרעיני-אמת (העברה-טהורה
 *    אפס-הטבעה) + rebateMarkPaid מונוטוני. המזרקה-יבשה = דיווח-כן, אף-שקר.
 *
 * חוץ-מצב בכוונה (אותו-משטר של klines.ts): ה-DexState/שורש-המצב נשארים
 * דטרמיניסטיים-לריפליי; הייחוס הוא נגזרת-תצפית. ריבונות: db/maker-stats.json
 * **נעקב ב-git** (אותו-בית-מצב של klines.json) — שורד מחיקת-סנדבוקס.
 */
import fs from "node:fs";
import path from "node:path";
import type { TradeEvent } from "./kernel";

/** EXEC-CD-9 · תעריף-הריבייט (bps מנומינל-ציטוט) — 10bps על-ספר-אפס-עמלות,
 * ממומן-ממחזור-גז-הספר (הזרם-הסגור: מייקרים → גז → מד → אוצר → ריבייט → מייקרים).
 * אישור-מפעיל: "מצא פתרון גם ל-2 — לא אכפת לי שיהיה מה-שצריך". */
export const MAKER_REBATE_BPS = 10;

export interface MakerRec {
  fills: number;    // מספר-מילויים שבהם סיפק-נזילות (maker)
  volMu: number;    // Σ נומינל-ציטוט ב-µ (price × amountMu)
  lastAt: number;   // ms epoch של-המילוי-האחרון
  lastH: number;    // גובה-הבלוק של-המילוי-האחרון
}

interface MakerRT {
  recs: Record<string, MakerRec>;      // issuer → ייחוס-חי
  paidMu: Record<string, number>;      // issuer → ריבייט-ששולם-בפועל (מונוטוני)
  dirty: boolean;
}

const MAKER_FILE = path.join(process.env.SAOS_DEX_STATE_DIR ? path.resolve(process.env.SAOS_DEX_STATE_DIR) : path.join(process.cwd(), "db"), "maker-stats.json"); // FIX(recovery-continuation · Task 22): כיבוד-SAOS_DEX_STATE_DIR כמו-chain.ts

const g = globalThis as unknown as { __saosDexMaker?: MakerRT };

function rt(): MakerRT {
  if (!g.__saosDexMaker) {
    g.__saosDexMaker = { recs: {}, paidMu: {}, dirty: false };
    try {
      if (fs.existsSync(MAKER_FILE)) {
        const raw = JSON.parse(fs.readFileSync(MAKER_FILE, "utf8")) as Partial<MakerRT>;
        if (raw && typeof raw === "object") {
          g.__saosDexMaker.recs = raw.recs ?? {};
          g.__saosDexMaker.paidMu = raw.paidMu ?? {};
        }
      }
    } catch { /* קובץ-פגום = פתיחה-כנה-מאפס (הדוקטרינה: אפסים-כנים) */ }
  }
  return g.__saosDexMaker;
}

/** הזנת-ייחוס מאירועי-מסחר-אמת של-הבלוק (נקרא מ-buildBlock — אותו-מקום-של-klinesFeed). */
export function makerFeed(events: TradeEvent[] | undefined, h: number): void {
  if (!events || events.length === 0) return;
  const r = rt();
  for (const ev of events) {
    if (ev.kind !== "fill" || !ev.maker) continue; // רק-מילויים-עם-ייחוס-מייקר
    const who = String(ev.maker);
    // FIX(SCALE-R1 · trace 1a185071c4aab695): נומינל-ציטוט בחוק-ה-kernel — notional =
    // floor(price × amountMu / 1000) (kernel.ts חוק-ה-notional). קודם-לכן חסר-ה-/1000
    // ניפח-את-volMu ×1000 והיה-משלם-ריבייט-×1000 מעבר-לקרן-האוצר. נמדד: ΣpaidMu=0
    // עד-היום — אפס-חוב-היסטורי, התיקון-נקי.
    const volMu = Math.max(0, Math.floor(((ev.price ?? 0) * (ev.amountMu ?? 0)) / 1000));
    if (volMu <= 0) continue;
    const rec = r.recs[who] ?? { fills: 0, volMu: 0, lastAt: 0, lastH: 0 };
    rec.fills += 1;
    rec.volMu += volMu;
    rec.lastAt = ev.at;
    rec.lastH = h;
    r.recs[who] = rec;
    r.dirty = true;
  }
}

/** שטיפה-לגיט (נקרא מ-persistSnapshot — אותו-קדנס של-klinesFlush). */
export function makerFlush(): void {
  const r = rt();
  if (!r.dirty) return;
  try {
    fs.mkdirSync(path.dirname(MAKER_FILE), { recursive: true });
    const tmp = MAKER_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ recs: r.recs, paidMu: r.paidMu }));
    fs.renameSync(tmp, MAKER_FILE);
    r.dirty = false;
  } catch { /* כשל-כתיבה לא מפיל את השרשרת */ }
}

/** ריבייט-שנצבר-ולא-שולם (טהור): floor(volMu × rateBps / 10_000). rateBps=0 → 0-כנה. */
export function rebateDueMu(issuer: string, rateBps: number = MAKER_REBATE_BPS): number {
  const rec = rt().recs[issuer];
  if (!rec || rateBps <= 0) return 0;
  return Math.floor((rec.volMu * rateBps) / 10_000);
}

/** EXEC-CD-9 · יתרת-ריבייט-שצברה-וטרם-שולמה (הסכום-שהסליקה חייבת עכשיו) —
 * due − paid, לעולם לא שלילי (paid מסומן-רק-על-תשלום-בפועל — מונוטוני). */
export function rebateUnpaidMu(issuer: string, rateBps: number = MAKER_REBATE_BPS): number {
  return Math.max(0, rebateDueMu(issuer, rateBps) - (rt().paidMu[issuer] ?? 0));
}

/** EXEC-CD-9 · זהויות-מייקר-חוץ (אישור-מפעיל — פריט-3 של EXEC-CD-8):
 * חשבון-אזרח-רגיל שהמפעיל מצטט-מטעמו (המפתח-האחד-חתום; הזהות היא חשבון — לא סיסמה-חדשה).
 * היגיינה fail-closed: שמות-מערכת-אסורים + אותיות-קטנות/ספרות/מקף-בלבד (3..24). */
export const SYSTEM_ACCOUNTS: ReadonlySet<string> = new Set([
  "treasury", "operator", "arena", "bot-a", "bot-b", "bot-c", "router",
  "ve-vault", "ve-pot", "vault-pot", "save-pot", "lend-pot",
]);
const IDENTITY_RE = /^[a-z0-9][a-z0-9-]{2,23}$/;
export function isMakerIdentity(name: string): boolean {
  return IDENTITY_RE.test(name) && !SYSTEM_ACCOUNTS.has(name);
}

/** EXEC-CD-9 · רשימת-המייקרים-המיוחסים (לסליקה — המייקרים-האמת-בלבד). */
export function makerIdentities(): string[] {
  return Object.keys(rt().recs);
}

/** סימון-ריבייט-כשולם (מונוטוני — לתשלום-עתידי דרך-op-אוצר כשהמימון ייפתח). */
export function rebateMarkPaid(issuer: string, mu: number): void {
  if (!(mu > 0)) return;
  const r = rt();
  r.paidMu[issuer] = (r.paidMu[issuer] ?? 0) + Math.floor(mu);
  r.dirty = true;
}

/** תמונת-מייקר ל-API (GET /api/dex/maker/snapshot). */
export function makerStatsFor(issuer: string): {
  fills: number; volMu: number; lastAt: number; lastH: number;
  rebateRateBps: number; rebateDueMu: number; rebatePaidMu: number;
} {
  const rec = rt().recs[issuer] ?? { fills: 0, volMu: 0, lastAt: 0, lastH: 0 };
  return {
    fills: rec.fills, volMu: rec.volMu, lastAt: rec.lastAt, lastH: rec.lastH,
    rebateRateBps: MAKER_REBATE_BPS,
    rebateDueMu: rebateDueMu(issuer),
    rebatePaidMu: rt().paidMu[issuer] ?? 0,
  };
}
