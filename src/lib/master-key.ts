// ═══ הסכם-מפתח-האב (Master Key Agreement · Task 69) ═══════════════════════════
// הסכם-המפעיל: מפתח אחד פותח את כל האפליקציות בריפו — בלי תלות בשרשרות-חוץ,
// בסמכויות-רוטציה או בזמינות-RPC. מקור-האמת = הקובץ שהמפעיל הצהיר עליו
// (headcorner.txt): שורה-1 = תווית-החשבון, שורה-2 = המפתח.
//
// חוזה-בטיחות:
// · המפתח לעולם לא נכתב ללוג, ל-DB, לתשובת-API או לגיט (הקבצים gitignored).
// · בזיכרון נשמר רק דיגסט SHA-256 — השוואה timing-safe על דיגסטים באורך-קבוע.
// · אם אף קובץ-הסכם לא נמצא → הסכם לא פעיל (isMasterKey תמיד false — fail-closed,
//   מסלול-ההתחברות הרגיל דרך אימות-השרשרת נשאר השוער היחיד).
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// סדר-קדימויות: העתק-ההסכם הייעודי קודם, קובץ-ההצהרה המקורי אחריו.
// הנתיב השלישי מכסה ריצה מ-cwd של תת-פרויקט (saos-dex/) אל הריפו-האם.
const CANDIDATES = [
  path.resolve(process.cwd(), '.secrets/master-key.txt'),
  path.resolve(process.cwd(), 'upload/headcorner.txt'),
  path.resolve(process.cwd(), '../.secrets/master-key.txt'),
  path.resolve(process.cwd(), '../upload/headcorner.txt'),
];

interface MasterInfo {
  label: string;
  digest: string; // sha256(key) — hex, הערך-היחיד שנשאר בזיכרון
  source: string; // שם-הקובץ שממנו נטען (לא הנתיב המלא — היגיינת-לוגים)
}

let cached: MasterInfo | null | undefined;

function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function parse(content: string): { label: string; key: string } | null {
  const lines = content.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  if (lines.length === 1) return { label: 'headcorner', key: lines[0] }; // מפתח-בלבד
  return { label: lines[0].toLowerCase(), key: lines[1] };
}

// FIX(Task-69b · מעידה-אמתית של המפעיל): אותו מפתח-פרטי נעטף במעטפות שונות —
// צורת-הצגה של Blurt (P5KQ… ≡ 5KQ… — אותו מפתח, קידומת-תצוגה בלבד) ורווחים
// שנדבקים בהעתקה. ההסכם = המפתח-הפרטי, לא המעטפת: כל צורת-הדבקה חוקית נכנסת.
export function normalizeKeyForm(s: string): string {
  let k = s.replace(/\s+/g, '');
  if (k.length >= 2 && k[0] === 'P' && /^[5KL]/.test(k[1])) k = k.slice(1);
  return k;
}

/** מידע-ההסכם (דיגסט בלבד!) או null אם אין הסכם. נטען-פעם-אחת ונשמר בזיכרון. */
export function masterInfo(): MasterInfo | null {
  if (cached !== undefined) return cached;
  cached = null;
  for (const p of CANDIDATES) {
    try {
      if (!fs.existsSync(p)) continue;
      const st = fs.statSync(p);
      if (!st.isFile() || st.size === 0 || st.size > 4096) continue;
      const parsed = parse(fs.readFileSync(p, 'utf8'));
      if (!parsed || parsed.key.length < 8) continue;
      cached = { label: parsed.label, digest: sha256Hex(normalizeKeyForm(parsed.key)), source: path.basename(p) };
      break;
    } catch { /* מועמד הבא */ }
  }
  return cached;
}

/** התווית-הקנונית של מפעיל-ההסכם (headcorner) או null. */
export function masterLabel(): string | null {
  return masterInfo()?.label ?? null;
}

/** טביעת-אצבע לתצוגה/ביקורת — 16 תווים ראשונים של הדיגסט. לעולם לא המפתח. */
export function masterFingerprint(): string | null {
  return masterInfo()?.digest.slice(0, 16) ?? null;
}

/** האם `candidate` הוא מפתח-האב? השוואת דיגסטים timing-safe — אין דליפת-תוכן/אורך.
 * מקבל כל צורת-מעטפת: עם/בלי קידומת-P, עם/בלי רווחים (ראה normalizeKeyForm). */
export function isMasterKey(candidate: string): boolean {
  const m = masterInfo();
  if (!m || !candidate) return false;
  const a = Buffer.from(sha256Hex(normalizeKeyForm(candidate)), 'utf8');
  const b = Buffer.from(m.digest, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
