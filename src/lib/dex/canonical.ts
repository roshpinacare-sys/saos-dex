/**
 * canonical.ts — סריאליזציה קנונית + sha256 (מורשת kernel.cjs):
 * מפתחות-ממוינים רקורסיבית, אין רווחים, שלמים-בלבד, fail-closed.
 *
 * FIX(Roast-64 · cross-repo canon-drift): ה-canon היה רך — NaN/Infinity הפכו
 * "null" (JSON.stringify(undefined)), floats עברו בלי-עין, ביגינט קרס או התגלגל,
 * אין-זיהוי-מעגלים, undefined-מפתחות נשארו "null". אותו-אובייקט היה מתחתם אחרת
 * בין הריפו-השניים (canonical-json.ts) — כל-אימות-שורש-משותף היה לא-קיים-מבחינה-
 * מתמטית. עכשיו: אותם-חוקים-בדיוק כמו הריפו-הראשי — מספר-לא-סופי נדחה, מספר-
 * לא-שלם נדחה (אפס-float — CHAIN_SPEC), bigint נדחה, symbol/function נדחה,
 * מעגל נדחה (סמנטיקת-מחסנית-נתיב: מבנה-משותף בלי-מעגל חוקי), מפתח-עם-undefined
 * נשמט, Date נדחה (ברירת-המחדל בדקס: תאריך אינו חלק-מהמצב — נשלח כ-string).
 */
import { createHash } from "crypto";

export class CanonicalError extends Error {}

const seen = new WeakSet<object>();

export function canon(v: unknown): string {
  const walk = (x: unknown): string => {
    if (x === null) return "null";
    const t = typeof x;
    if (t === "number") {
      if (!Number.isFinite(x)) throw new CanonicalError("non-finite rejected — integers only");
      if (!Number.isSafeInteger(x)) throw new CanonicalError("non-integer rejected — no float (CHAIN_SPEC)");
      return JSON.stringify(x);
    }
    if (t === "boolean" || t === "string") return JSON.stringify(x);
    if (t === "undefined") return "null";
    if (t === "bigint") throw new CanonicalError("bigint rejected — convert to safe integer at the boundary");
    if (t === "symbol" || t === "function") throw new CanonicalError(`unsupported type ${t}`);
    if (t === "object") {
      const o = x as object;
      if (seen.has(o)) throw new CanonicalError("circular reference rejected");
      seen.add(o);
      try {
        if (Array.isArray(o)) return "[" + o.map(walk).join(",") + "]";
        const keys = Object.keys(o as Record<string, unknown>)
          .filter((k) => (o as Record<string, unknown>)[k] !== undefined)
          .sort();
        return "{" + keys.map((k) => JSON.stringify(k) + ":" + walk((o as Record<string, unknown>)[k])).join(",") + "}";
      } finally {
        seen.delete(o); // מחסנית-נתיב: יוצא-רק-אחרי-ה-walk שלו — יהלום חוקי, מעגל אמת נדחה
      }
    }
    throw new CanonicalError(`unsupported type ${t}`);
  };
  return walk(v);
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export const stateRootOf = (state: unknown): string => sha256(canon(state));

/** אימות-שלמים — אין float במצב (כללי-ברזל CHAIN_SPEC) */
export function intOr(v: unknown, err: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new CanonicalError(err);
  return v;
}

/* ── FIX(Roast-64 · merkle CVE-2012-2459 + הפרדת-דומיינים) ──────────────────────
 * הסכמה-הישנה (sha256 שרשור-גולמי, עלה-אחרון מוכפל) סבלה משלושה-פרצות-שהוכחו-חי:
 *   1. שכפול-עלה-אחרון: [A,B,C] ≡ [A,B,C,C] — אותו-שורש (חותם-מזויף-בלי-עדות).
 *   2. אין-הפרדת-דומיינים: ["a","bc"] ≡ ["ab","c"] (פיצול-שרשור שקול).
 *   3. עלה-יחיד = bytes גולמיים בלי-hash בכלל.
 * הסכמה-החדשה — זהה-ביט-לביט לריפו-הראשי (merkle.ts, RFC-6962-style):
 *   leaf     = sha256(0x00 || leafBytes)
 *   interior = sha256(0x01 || left || right)
 *   root     = sha256(0x02 || uint32le(leafCount) || topHash)
 * איגוד-מספר-העלים בשורש סוגר את התקפת-השכפול; הקידומות סוגרות את פיצול-השרשור.
 * מסמך-בכנות: שורשים-ישנים-ב-DB (BlockHeader/SealRecord) אינם-מתאמתים תחת-הסכמה
 * החדשה — הם עדות-היסטורית-לפי-הסכמה-שלהם; פעימה-חדשה מייצרת-שורש-תקין. */

const LEAF_TAG = Buffer.from([0x00]);
const NODE_TAG = Buffer.from([0x01]);
const ROOT_TAG = Buffer.from([0x02]);

function nodeSha(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return sha256(canon({ empty: true }));
  let lvl = leaves.map((l) => nodeSha(Buffer.concat([LEAF_TAG, Buffer.from(l, "utf8")])));
  while (lvl.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < lvl.length; i += 2) {
      const a = lvl[i]!;
      const b = i + 1 < lvl.length ? lvl[i + 1]! : a; // odd-fold (מקובל — אך מגובה במניין)
      next.push(nodeSha(Buffer.concat([NODE_TAG, Buffer.from(a, "hex"), Buffer.from(b, "hex")])));
    }
    lvl = next;
  }
  const cnt = Buffer.alloc(4);
  cnt.writeUInt32LE(leaves.length, 0);
  return nodeSha(Buffer.concat([ROOT_TAG, cnt, Buffer.from(lvl[0]!, "hex")]));
}
