# CRAFT-ADOPTION — מפת-אימוץ craft-anything לארכיטקטורת SAOS

> מנדט-בעלים 2026-11-05 (trace `1a1a8a04051f643d`): «תראה איך לנצל אותו עבור
> הארכיטקטורה שלנו וגם כדי להבין איך ליישם דברים נכון עכשיו».
> מקור: github.com/storytold/craft-anything — מנוע clean-room ב-Rust טהור:
> Study → Build → Check → Ready, מנוע-אחד, ארבעה-פנים (אפליקציה · CLI · MCP · סוכן-AI).

## 1. מהו הפרויקט (עובדות-מדידה, לא תיאור)

· **מנוע-אחד, ארבעה-פנים**: כל-יכולת = `ToolSpec` (id, כותרת, effects, requires,
  params-מסוכמים, run) — ה-UI, ה-CLI, שרת-ה-MCP וסוכן-ה-AI כולם קוראים **ב-id**.
  "אין-צורך ב-AI כדי לבחון" — 320 כלים עובדים חשמלאים; ה-AI הוא נהג-הלולאה בלבד.
· **Evidence is the result**: כל-כלי מחזיר ראיות עם confidence-כן, limitations,
  coverage, unknowns — מתומצע ראשית, מדור-מאוחר עם offset/limit.
· **Never-crash כחוק-מהדר**: `deny(unwrap/expect/panic)` על כל-שורש-קרייט
  בקוד-פרודקשן; אריתמטיקה-בדוקה, רקורסיה-חסומה, הקצאות-מוגבלות; כל-תיקון-קריסה
  מקבל מבחן-רגרסיה. קלט-עוין = הקלט-הראשי.
· **בידוד-תהליכים**: כל-תהליך-חוץ דרך שכבת-process אחת — stdin-סגור, deadline
  (wall+idle), פלט-מרוסן-ומוגבל, kill על timeout/cancel/drop; כישלון = ToolError
  עם remediation-במשפט-אחד, לעולם לא panic/hang.
· **Clean-room vs Deep**: clean-room לעולם לא מסתכל בפנים-המקור — רק כלים-מבקרים
  מבחוץ; Deep מדווח-עצמו ב-evidence (engine+flag). ההבדל מוכרז בכל-מדידה.
· **Effects-כנים + consent**: כל-תופעת-לוואי מוכרזת; `EXECUTES_FOREIGN_CODE`/
  `MUTATES_DEVICE` מציתים שער-אישור (inbox/approvals).
· **לולאת-השיקום**: Study (בחינת-המקור בכלי-אמת) → Build (סוכן-קוד בנה חדש)
  → Check (השוואה מדודה מול-המקור: 3 רוחבי-מסך לאתר, self-test למשחק) →
  Refine (עד-קרבה). ה-check הוא-החוק — בנייה בלי-בדיקה לא נחשבת.

## 2. מה-SAOS כבר מחזיק (התאמות נמדדות)

| craft-anything | SAOS הקיים | מצב |
|---|---|---|
| Evidence-records (confidence/unknowns) | פנקסים + קבלות + מרקל + journal | **קיים-חזק** |
| Never-crash (deny/panic-free) | "never throws" כחוק-ברזל (arb-scan §5, ledger corrupt→fresh, fail-closed כללי) | **קיים-חזק** |
| Effects + consent | STASIS-brake + סמנות-בעלים + שערי-חתימה (keyless/keys) | **קיים** |
| Check-loop (build vs original) | truth-gate 9 שערים על האתר הציבורי · T15 truth-gate · selftest-ברזל ב-CI · pre-push-gate | **קיים** |
| ToolSpec registry | `docs/TOOLS-INDEX.md` (192 כלים, sovereign-builder auto) | **זרע — נדרש שדרוג** |
| Process isolation (deadline/cap/kill) | beat-loop dispatch-verify (R363) · boot-fleet · mini-services --hot | **חלקי** |
| Clean-room על רשתות-חוץ | arb-scan keyless fail-closed (STEEM/HIVE/HTX/Binance/Engine) · route-graph REF-לעולם-לא-רגל-ביצוע | **קיים** |

## 3. חמשת-האימוצים (סדר-ביצוע, מדוד)

1. **ToolSpec-כחוזה (עכשיו)** — לשדרג את TOOLS-INDEX מרשימה-אוטומטית למניפסט
   מוכרז: לכל-כלי `id · effects (SCAN/PLAN/EXECUTES/KEYS) · requires (keyless/
   owner-armed) · evidence-output · selftest-pointer`. כלל-בית חדש: **כלי בלי
   מניפסט = לא בצי** (אותה-רוח של "אין-קוד-זר" ב-fence-check).
2. **Check-לפני-Build כחוק-פריסה (עכשיו)** — אותו-סדר של craft-anything: אין
   deploy/beat בלי קבלת-בדיקה חתומה (T15/selftest/truth-gate) של **אותו-קומיט**.
   ה-pre-push-gate קיים — לחייב אותו גם על workflows-חדים (workflow-yaml-guard
   כבר קיים; להוסיף בדיקת-הוכחה לכל-yml-חדש).
3. **בידוד-תהליכים בצי (שבוע)** — תבנית-ברזל לכל-קריאה-חוץ בכלי-הצי: timeout
   מוכרז + פלט-מוגבל + כישלון-כנה-במשפט (remediation). R363 כבר מוכיח את
   הדפוס (dispatch→poll 6×8s→verify); להכליל: `runWithDeadline(cmd, {cap,
   deadline, onFail:"honest-line"})`.
4. **Clean-room להרחבה-הבין-רשתית (מתמשך)** — חקר-רשת-חוץ = תמיד keyless
   (arb-scan כבר עושה זאת); ביצוע-חוץ = תמיד owner-armed + brake. החוק-המתואר
   ב-LIQUIDITY_STRATEGY L3 (עטיפות Hive-Engine = צעד-דרך) מקבל כאן ניסוח-
   מחודד: **ה-study-ליין מעולם לא נוגע במפתחות; ה-exec-ליין מעולם לא נוגע
   בהשערות**.
5. **Refine-עד-קרבה (מתמשך)** — מדידת-פער-גלויה בכל-יעד (ladder-at-target,
   fleet-arm-target, kelly-gear) כבר קיימת; לאמץ את השם-והמשמעת: כל-יעד מוכרז
   עם `check: {measured, target, devBps, refine}` — פנל-אחיד בקונסולה.

## 4. מה-לא מאמצים (כנות)

· **לא מריצים את הבינארי** — early-alpha, build-Rust כבד, ואין-צורך: אנחנו
  מאמצים **את-השיטה והחוזים**, לא את הכלי-עצמו. הצי כבר סוכן-מנוע.
· **אין reverse-engineering של קוד-סגור** — clean-room שלנו = פידים-ציבוריים
  keyless בלבד; fence "אפס-קוד-זר" נשאר שער-ברזל.
· **אין העתקת-קוד** — Original-work-only; ההשוואות כאן הן שיטתיות, לא מילוליות.

## 5. הקשר-הפעלה (2026-11-05)

· R370 (קומיט `a9e6ecca`) ריפא את שורשי P2-A43 — הספר הפנימי דו-צדדי מחדש
  (bestAsk=51 מדידה-חיה · T15 6/6 · סוללה-מלאה ירוקה).
· R369 ריפא את שידור-הפנקסים של arb-scan (rebase+retry 4×).
· TOOLS-INDEX כבר חי (sovereign-builder, 192 כלים) — אימוץ-1 בונה עליו ישירות.

**מסקנה**: craft-anything הוא הוכחה-חיצונית שהדוקטרינה שלנו (מדידה-כנה → בנייה →
בדיקה → חידוד, עם ראיות-ציבוריות ושערי-הסכמה) היא מדרגת-תעשייה. הפער-היחיד:
חוזה-ToolSpec מוכרז + בידוד-תהליכים מוכלל. שניהם מתוכננים לעיל.
