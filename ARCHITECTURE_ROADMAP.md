# ARCHITECTURE_ROADMAP — מפרוטוטייפ למערכת מוסדית

> תיעוד-הפער ההנדסי שזוהה בביקורת ("The Architectural Roast") ומסלול-הסגירה שלו.
> מתועד בכנות: מה נעשה במהדורה זו, מה נשאר, ומהו הסדר-העדיפויות המוסדי.

## 1. מצב-הפתיחה מול הסטנדרט המוסדי

| תחום | היה (PoC) | נדרש (Institutional) | סטטוס |
|---|---|---|---|
| **גרף-מחיר** | recharts SVG בסיסי | lightweight-charts (TradingView) | ✅ נסגר — `chart.tsx`, AreaSeries, mono-צירים, crosshair-מגנט |
| **זרימת-נתונים ל-UI** | Polling עיוור כל-2ש׳ | WebSocket או long-polling יעיל | ✅ נסגר — long-poll מבוסס-גרסה (`/api/dex/state?v=`) + `AbortController` בכל-הזרמים; עדכון-אירוע, אפס-השהיה מלאכותית |
| **היררכיה-ויזואלית** | "דשבורד עם נתונים" | טרמינל מסחרי צפוף ומדויק | ✅ נסגר — zinc-950 טהור, border-zinc-800, mono לנתונים, ירוק/אדום-מסחר · סגול-עמוק-מערכת · אפס אימוג'ים (StatusDot/lucide) |
| **תצפיתיות** | לוג-קונסולה | Metrics חיים | 🟡 חלקי — פאנל System Health: TPS מדוד, גיל-בלוק, מדדי-Relay, breakers, אימות-על-שרשרת. חסר: קצה `/metrics` ל-Prometheus |
| **חוסן-Relay** | "המתנה-כנה" נאיבית | Circuit breakers + backoff + reconciliation | ✅ נסגר — breaker per-chain (closed/open/half-open, סף-4, צינון-5ד׳), backoff אקספוננציאלי עם jitter ±20%, `verifyOnChain` (קריאה-חוזרת מה-RPC + השוואת stateRoot/height + ALERT בלוג), לולאת-פיוס תקופתית שמאמתת-בדיעבד ושורדת הפעלות-מחדש (שחזור `state/anchors.json`) |
| **אבטחת-מפתחות** | מפתחות ב-.env + זיכרון | HSM / הפרדת Signer–Executor | 🔴 פתוח — הארכיטקטורה מוכנה (החתימה מרוכזת במודול-Relay), נדרש מימוש-Adaptor |
| **סמנטיקת ספר** | limit = מנוחה-בלבד (ספר-יכול להישאר חצוי) | crossing בעת-הצבה | ✅ נסגר — פקודת-לימיט חוצה מיד כ-taker במחיר-מייקר, שארית נחה; נעילות-escrow מדויקות-לאורך כל-הדרך |

## 2. מהדורה זו — פירוט שינויים

### UI — "Sovereign Terminal"
- **lightweight-charts 5** (`src/components/dex/chart.tsx`): גרף-אזור זהוב, dedupe-שניות, ResizeObserver, אפס-אנימציה.
- **מנוע-זרימה** (`useWorldStream`): long-polling מבוסס-גרסה-מונוטונית; השרת מחזיר רק-כשהשרשרת התקדמה (keepalive כל-12ש׳); ניתוק-נקי עם AbortController; רענון-מיידי אחרי-כל-פעולת-משתמש. הזמנות-שלי/ציטוט-סוואג'/Relay נשלפים בכל-גרסת-עולם — מנוע-אירוע, לא סקר-תקופתי.
- **System Health** (`SystemHealthPanel`): 5 אריחים — מנוע (TPS מדוד-אמת + גיל-בלוק), ראיות-DB, Relay (נוריות לכל-שרשרת), Circuit Breakers (מצב + trips), אימות-על-שרשרת (ok/mismatch/latency). סגול-עמוק = סטטוס-מערכת.
- **עיצוב**: רקע-טהור #09090b (בלי-גרדיאנטים), scrollbar-ניטרלי, כל-הסימנים-טקסטואליים (● ✓ ✕ ⇄) הוחלפו ברכיבים (StatusDot, lucide Check/X/ArrowLeftRight).

### Relay — "The Door, hardened"
- `verifyOnChain(chain, txid, expected)`: Steem/Hive — `condenser_api.get_transaction` → השוואת `stateRoot`+`height` מול-החותם המקומי; TRON — אישור-בלוק + התאמת `extra_data`.
- ALERT בלוג (`[saos-relay][ALERT]`) על: אי-התאמת-stateRoot ופתיחת-breaker.
- Circuit breaker per-chain: כשלים-קשים-רצופים ≥4 → OPEN (הפסקה-מלאה) → half-open (פרובה-יחידה אחרי 5ד׳) → CLOSED. תנאי-תקציב (RC-low/unfunded) אינו כשל-מערכת ואינו סופר.
- Reconciliation: מחזור-ראשון אחרי 8ש׳, אחר-כך כל-90ש׳, עד-3 אימותים-בדיעבד למחזור; שורד הפעלות-מחדש דרך שחזור-רשומות-ציבוריות; פסיקות-שמורות שאינן `true` נגזרות-מחדש מה-RPC (ריפוי-עצמי).
- מדדים: broadcasts / verified / mismatches / breakerTrips / economicWaits / lastVerifyLatencyMs.

### Chaos & Audit Readiness
- **מבחן-כאוס מבוקר** (`src/lib/dex/chaos.ts` — נקודת-הזרקה אינרטית בפרודקשן + `scripts/chaos-test.ts`): ניתוק-RPC יזום 60ש׳ → כל-3 ה-breakers OPEN תוך 31–46ש׳, תור-כנה, אפס-תעבורת-רשת בפועל; הזרקת stateRoot מזויף → קריאה-חוזרת מה-RPC הציבורי, ALERT, מיסמאץ' במדדים, סירוב-אישור-עיגון; txid רפאים → "not indexed" כנה (לא-מיסמאץ'). תוצאות-אמת: `CHAOS_TEST_RESULTS.md` (13/13).
- **ממצאים-שהכאוס תפס ותוקנו**: שער-ההזרקה חייב-לעבור בנתיב-הכשל הרגיל (catch → breaker → backoff — לא-מעל-ה-try), והמדד-הגלובלי `breakerTrips` קושר-לפסקת-ה-breaker (היה-מת-על-הנייר).
- **ניקיון-ביקורת**: אפס TODO/FIXME; אפס `console.log` בקוד-הייצור (info/error לפי-חומרה); תיעוד SECURITY INTENT (JSDoc) ל-`matchBook` / `verifyOnChain` / `seal` ולשער-הכאוס.

### מנוע — סמנטיקת-ספר מוסדית
- **Crossing בעת-הצבה**: `order` → נעילת-מראה → `matchBook` כ-taker (מחיר-מייקר) → שארית נחה. אין-חפיפה → מנוחה-מלאה. ספר-לא-חצוי-עוד (self-healing).
- **בוטי-רעש**: טייק-שוק בגודל-תקציב-אמת (`affordable`), היגיינת-פקודות (עד-פקודת-רעש אחת פר-בוט-פר-זוג — ביטול-ישנות), קצבת-מלאי תחומה כל-24 טיקים לסוחרים שנדלדלו (זרימה-חופשית מתמשכת על שני-הזוגות).

## 3. מסלול-ההמשך (Milestones)

### M1 — Observability חיצונית
- קצה `/api/dex/metrics` בפורמט-Prometheus (ops/sec, relay latency histogram, breaker state gauge, anchor success ratio).
- דשבורד-Grafana בסיסי; ALERTmanagers ל-mismatch ול-breaker-open.

### M2 — הפרדת Signer–Executor
- מודול-`Signer` מבודד: ממשק `sign(payload) → signature` עם Adaptors:
  - `EnvSigner` (היום — זיכרון-בלבד),
  - `FileSigner` (keyfile מוצפן + passphrase בזמן-ריצה),
  - `HsmSigner` (PKCS#11 / cloud-KMS) — אותו-ממשק, אפס-שינויים ב-Executor.
- מדיניות: ה-Executor מקבל חתימות-מוכנות; מפתחות-גולמיים לעולם לא מגיעים לנתיב-השידור.

### M3 — WebSocket אמת
- ה-long-polling הנוכחי עומד בתקן (עדכון-אירוע, בלי-השהיה); לקצה-עליון-מוחלט: שירות-WS נפרד (מיני-שירות) שמשדר delta-של-ספר-וסליל. ה-long-poll נשאר fallback.

### M4 — קול-קוח-עצמאי לאימות
- CLI ציבורי (`verify-anchor <txid>`): מוריד את ה-custom_json מה-RPC, משווה ל-stateRoot מקומי — אימות-צד-שלישי בלי לסמוך עלינו.
- ✅ **נסגר (2026-10-06) — `scripts/verify-anchor.ts` (`bun run verify:anchor`)**: כלי-עצמאי לגמרי (אפס יבוא מ-src/, אפס תלות מעבר ל-bun) — נייד לכל צד-שלישי. מקורות-אמת: `--height/--root` ידני · `--anchors state/anchors.json` · `--db db/dex.db` (SealRecord). פסקי-דין: VERIFIED / MISMATCH / SELF-REPORT (בלי מקור-השוואה — כנות: קריאה איננה אימות) / NOT-INDEXED. קודי-יציאה 0/1/2/3 לאוטומציה.
- **מדידה-חי מעל ה-RPC הציבורי (api.steemit.com / api.hive.blog):** 4 עיגונים היסטוריים מתועדי-STATUS נקראו-חזרה ופורקו בהצלחה (headcorner, chain-seal) · **עקביות-בין-שרשראות הוכחה בפקודה אחת**: stateRoot `a54a51c7…` זהה ביט-מול-ביט בין Steem h1416 (בלוק 10,937,411) ל-Hive h1416 (בלוק 10,970,856) · נתיב-VERIFIED נמדד (exit 0) מול ציפייה-ידנית.

## 4. כנות

- הספר הוא SIM (מדומה) — אין כסף אמת, אין הבטחות תשואה.
- העיגון אמת: custom_json חתום בסמכות-active על Steem/Hive (אפס-עלות RC) ו-TRON מותנה-מימון; כל-txid מאומת-חזרה מה-RPC הציבורי.
- מפתחות: זיכרון-בלבד מ-.env (gitignored-אומת); אפס סודות בלוג/פלט/git.
