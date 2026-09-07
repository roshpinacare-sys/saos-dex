/**
 * canonical.ts — סריאליזציה קנונית + sha256 (מורשת kernel.cjs):
 * מפתחות-ממוינים רקורסיבית, אין רווחים, שלמים-בלבד, fail-closed.
 */
import { createHash } from "crypto";

export class CanonicalError extends Error {}

export function canon(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canon(o[k])).join(",") + "}";
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

/** עץ-מרקל קנוני מעל hex (מורשת merkle.cjs — קיפול-זוגי, עלה-אחרון מוכפל במפלג-אי-זוגי) */
export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return sha256(canon({ empty: true }));
  let lvl = [...leaves];
  while (lvl.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < lvl.length; i += 2) {
      const a = lvl[i]!;
      const b = i + 1 < lvl.length ? lvl[i + 1]! : a; // odd-fold
      next.push(sha256(a + b));
    }
    lvl = next;
  }
  return lvl[0]!;
}
