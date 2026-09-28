// EVENTS — אפיק-האירועים של רשת-הטריגרים (JSONL append-only)
//
// דוקטרינה: כל אירוע הוא רשומה בלתי-הפיכה ביומן. האירועים הם הדבר-שגורר-דבר:
// פעולה של גריד מייצרת אירוע, האירוע מצית כלל, הכלל מריץ פעולה, הפעולה
// מייצרת אירוע חדש. היומן כולו ניתן-לשחזור מהזרע + הקלטות-השוק.
//
// כנות: כל אירוע נושא `sim:true` כל עוד הוא נוצר בסביבה חסרת-מפתחות.
// אירוע אמת-על-השרשרת יישא sim:false רק כשהמפעיל חימש את המכונה.

import { appendFileSync, existsSync, readFileSync } from "node:fs";

/** המזהה הבא ביומן — מונוטוני לנצח. */
export function nextSeq(logPath) {
  if (!existsSync(logPath)) return 1;
  const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  if (lines.length === 0) return 1;
  try {
    const last = JSON.parse(lines[lines.length - 1]);
    return (last.seq ?? lines.length) + 1;
  } catch {
    return lines.length + 1;
  }
}

/** הוספת אירוע ליומן (append-only; אין עריכה, אין מחיקה). */
export function appendEvent(logPath, ev) {
  const seq = nextSeq(logPath);
  const full = {
    seq,
    ts: new Date().toISOString(),
    type: ev.type,
    source: ev.source ?? "engine",
    sim: ev.sim !== false, // ברירת-מחדל כנה: סימולציה עד שנאמר אחרת
    ...ev,
    seq,
  };
  appendFileSync(logPath, JSON.stringify(full) + "\n");
  return full;
}

/** קריאת אירועים מאז seq (כולל). */
export function readEvents(logPath, { since = 0, types = null, limit = Infinity } = {}) {
  if (!existsSync(logPath)) return [];
  const out = [];
  const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    let ev;
    try {
      ev = JSON.parse(lines[i]);
    } catch {
      continue; // שורה פגומה לא עוצרת את הצי — נדלג בכנות
    }
    if ((ev.seq ?? 0) < since) break;
    if (types && !types.includes(ev.type)) continue;
    out.push(ev);
  }
  return out.reverse();
}

/** ספירת אירועים לפי טיפוס (לדוחות ולבדיקות-איות). */
export function countByType(logPath) {
  const counts = {};
  for (const ev of readEvents(logPath)) counts[ev.type] = (counts[ev.type] ?? 0) + 1;
  return counts;
}
