/**
 * bookgas.ts — מד-גז-הספר + המחזור-הכנה (EXEC-CD-9 · fuel-freeze-fix) — חוץ-מצב קנוני.
 * ═════════════════════════════════════════════════════════════════════════════
 * הממצא-המבני-המדוד (EXEC-CD-8, docs/MAKER-API.md): הספר-הריבוני גובה גז
 * (order=60 · fill=60 · cancel=15 · cancel_all=15 · order_gc=30) אבל המזרקה
 * ממחזרת **רק-עמלות-בריכות** — גז-הספר-עצמו בורח-מהמחזור → מלכות-מוות-דלקית
 * איטית בכלכלה ספר-מרכזית בלי זרימה-חוץ (נמדד חי: אפס-fills, feeMeter על
 * רצפת-8000, כל-ממני-הסולם על FUNDER_KEEP).
 *
 * התיקון (אושר-מפעיל: "תקן הכל ולייעל"): מד-חוץ-מצב-דטרמיניסטי של גז-הספר
 * שנגבה-בפועל → המזרקה מחזירה אותו לאוצר (אוצר-מפיץ-דרך-סולם-refuel) —
 * **כל-µ-נגרע-מהמד פעם-אחת בלבד** · אפס-שינוי-בחוזי-המצב (feeMinted באותן-
 * סמנטיקות-של-mint_fuel → האינווריאנטה Σcredits+gasUsed−feeMinted===ג'נזיס
 * נשמרת בדיוק) · אפס-הטבעה-כפולה (רצפת-מצב: bookGasFloor — המד-מתיישר
 * מול st.bookGasRecycledMu הקנוני בטעינה).
 *
 * כנות: מונה-רק **שריפות-מאושרות** (ops שהתקבלו; r.gas-האמת של-חוזה-ה-{ok,gas})
 * → סחיפה-אפשרית-היא-תחת-ספירה בלבד (fail-closed — לעולם לא-מחזר-יותר-משנשרף).
 *
 * חוץ-מצב בכוונה (אותו-משטר של klines.ts/maker.ts): ה-DexState/שורש-המצב
 * נשארים דטרמיניסטיים-לריפליי. ריבונות: db/book-gas.json **נעקב ב-git**
 * (אותו-בית-מצב של klines.json/maker-stats.json) — שורד מחיקת-סנדבוקס.
 */
import fs from "node:fs";
import path from "node:path";

/** סוגי-ה-op-שגז-שלהם הוא גז-ספר (המחזור-מכסה אותם — ורק אותם). */
export const BOOK_GAS_KINDS: ReadonlySet<string> = new Set([
  "order", "fill", "cancel", "cancel_all", "order_gc",
]);

/** תקרת-מחזור-פר-טיק-מחזור (אותו-גבול-נזק של MINT_FUEL_CAP בגרעין). */
export const BOOKGAS_RECYCLE_CAP = 100_000;

export interface BookGasRT {
  collectedMu: number;               // Σ גז-ספר שנגבה (מונוטוני)
  recycledMu: number;                // Σ גז-ספר שהוחזר-לאוצר (מונוטוני, ≤ collected)
  byKind: Record<string, number>;    // פירוק-כנה פר-סוג-op
  dirty: boolean;
}

const BOOKGAS_FILE = path.join(process.cwd(), "db", "book-gas.json");

const g = globalThis as unknown as { __saosDexBookGas?: BookGasRT };

function rt(): BookGasRT {
  if (!g.__saosDexBookGas) {
    g.__saosDexBookGas = { collectedMu: 0, recycledMu: 0, byKind: {}, dirty: false };
    try {
      if (fs.existsSync(BOOKGAS_FILE)) {
        const raw = JSON.parse(fs.readFileSync(BOOKGAS_FILE, "utf8")) as Partial<BookGasRT>;
        if (raw && typeof raw === "object") {
          g.__saosDexBookGas.collectedMu = Math.max(0, Math.floor(raw.collectedMu ?? 0));
          g.__saosDexBookGas.recycledMu = Math.max(0, Math.floor(raw.recycledMu ?? 0));
          g.__saosDexBookGas.byKind = raw.byKind ?? {};
          // תיקון-עצמי-כנה: מד-סוטה (recycled>collected) מתיישר-לגבול האמת
          if (g.__saosDexBookGas.recycledMu > g.__saosDexBookGas.collectedMu) {
            g.__saosDexBookGas.recycledMu = g.__saosDexBookGas.collectedMu;
          }
        }
      }
    } catch { /* קובץ-פגום = פתיחה-כנה-מאפס (הדוקטרינה: אפסים-כנים) */ }
  }
  return g.__saosDexBookGas;
}

/** רצפת-מצב: מיושרת-מול st.bookGasRecycledMu (הקנוני) בטעינת-שרשרת —
 * קוטל-הטבעה-כפולה: גם-אם-קובץ-המד איחר-להישטף, המד לא ימחזר µ-שהמצב-כבר-מצהיר-עליו. */
export function bookGasFloor(stateRecycledMu: number): void {
  const r = rt();
  const floor = Math.max(0, Math.floor(stateRecycledMu));
  if (floor > r.recycledMu) {
    r.recycledMu = Math.min(floor, r.collectedMu);
    r.dirty = true;
  }
}

/** הזנת-שריפות-מאושרות מהבלוק (נקרא מ-buildBlock — אותו-מקום-של-klinesFeed/makerFeed). */
export function bookGasFeed(applied: { type: string; gas: number }[]): void {
  if (!applied || applied.length === 0) return;
  const r = rt();
  for (const { type, gas } of applied) {
    if (!BOOK_GAS_KINDS.has(type)) continue;
    const mu = Math.max(0, Math.floor(gas));
    if (mu <= 0) continue;
    r.collectedMu += mu;
    r.byKind[type] = (r.byKind[type] ?? 0) + mu;
    r.dirty = true;
  }
  // התיישרות-עצמית מול רצפת-מצב (אם-נטען-אחרי-המד — אין-פגיעה; אם-המד-קודם — מתיישר)
  r.recycledMu = Math.min(r.recycledMu, r.collectedMu);
}

/** זמין-למחזור: מה-שנגבה ומעולם לא הוחזר — כל-µ-פעם-אחת. */
export function bookGasRecycleAvail(): number {
  const r = rt();
  return Math.max(0, r.collectedMu - r.recycledMu);
}

/** צריכת-מחזור (פעם-אחת!): מנכה מהמד ומחזיר את הסכום-שאושר. */
export function bookGasTake(mu: number): number {
  const amt = Math.max(0, Math.floor(mu));
  if (amt <= 0) return 0;
  const r = rt();
  const take = Math.min(amt, bookGasRecycleAvail());
  if (take <= 0) return 0;
  r.recycledMu += take;
  r.dirty = true;
  return take;
}

/** שטיפה-לגיט (נקרא מ-flushSnapshot — אותו-קדנס של-klinesFlush/makerFlush). */
export function bookGasFlush(): void {
  const r = rt();
  if (!r.dirty) return;
  try {
    fs.mkdirSync(path.dirname(BOOKGAS_FILE), { recursive: true });
    const tmp = BOOKGAS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ collectedMu: r.collectedMu, recycledMu: r.recycledMu, byKind: r.byKind }));
    fs.renameSync(tmp, BOOKGAS_FILE);
    r.dirty = false;
  } catch { /* כשל-כתיבה לא מפיל את השרשרת */ }
}

/** טלמטריה-כנה ל-API (GET — שקיפות). */
export function bookGasStats(): {
  collectedMu: number; recycledMu: number; pendingMu: number; byKind: Record<string, number>;
} {
  const r = rt();
  return {
    collectedMu: r.collectedMu,
    recycledMu: r.recycledMu,
    pendingMu: bookGasRecycleAvail(),
    byKind: { ...r.byKind },
  };
}
