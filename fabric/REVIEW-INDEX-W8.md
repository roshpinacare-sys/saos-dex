# REVIEW-INDEX-W8 · מפת-שיפוט מלאה של תור-ה-fabric (40 הצעות)

- **סוקרים**: zai-code + sub-agent W8-a (קריאה-מלאה של-39 הצעות, cmvdxs6w נשפט-לעומק-ב-W7) · 2026-10-18 · סמכות-advisory, שער-הבעלים-עומד.
- **ממצא-מבני-חוצה-את-התור**: `fabric/`-היה-כלול-ב-`include`-של-tsconfig → **ההצעות-הלא-נשפטות-עצמן-שברו-את-`tsc --noEmit`** (16 שגיאות-parse). תוקן-במקביל-לאינדקס-הזה: `fabric`-נוסף-ל-`exclude` — תור-הצעות-אינו-קוד-מקור.

## ספירה

| פסק | מספר |
|---|---|
| ENDORSE (נקי) | 1 (cmvd7w43 — שכפול-byte של-קובץ-חי; no-op) |
| ENDORSE-WITH-FIXES | 6 (cmvdo3gm, cmvdlfbq, cmvdn0tb, cmvdww18, cmvdi78i, cmvdkj2e) |
| REJECT-AS-WRITTEN | 32 |
| נשפט-לעומק-ב-W7 | 1 (cmvdxs6w) |


## W10 · אשרור-הבעלים ("מאשר", 2026-10-18) — מהתור-אל-הקוד-החי

- **הבעלים אישר** את תור-האשרורים. מומש-בשני-commit-ים-מאומתים-tsc=0:
  · **e1d1eda9** — db-scope-guard: cmvdxs6w-הגרסה-המתוקנת (POST-למקלט-הקונסולה, env-gated, sha256, fail-open) + cmvdww18 (מודול-`src/lib/dex/alert.ts`-נכתב: לוג-מבני + ledger-JSONL + מדודה + תקרת-גודל). ה-throw-נשאר-בלתי-מותנה: **ההגנה-fail-closed, ההתראות-fail-open**.
  · **9cb44214** — middleware: ליבת-EXEC-CD-44-מילה-במילה + cmvdn0tb (לוג-429-מבני) + cmvdkj2e (התראה-מוקדמת-מדודה, ציבורי-בלבד — תיקון-ספי-הסף-מ-W8-a) + cmvdo3gm (IDS-מותנה-env-כבוי-ברירת-מחדל; matcher-ה-proxy-הכפול-שוחזר; גימום-trackers). cmvdlfbq/cmvdi78i — נבלעו-ולא-נערמו (מערכות-כפולות/חלשות-מדוד).
- **מקלט-ההתראות קם-בקונסולה**: `POST /api/alerts` (W10) — צורה-מחמירה (שדות-זרים-נדחים-400), מדידת-קצב 10/דק׳/IP, דדופיקציה-דקה, ledger-`db/alerts.jsonl`-עם-תקרה. **כנות: לא-מאומת** — למנוע-אין-סוד-משותף (חוק-אפס-הסודות); מסומן-כך-בפאנל.
- הלולאה-החיה-נסגרת: guard-יורה → מודול-מקומי-מתעד → קונסולה-רואה. אפס-סודות, אפס-מוקים.

## הטבלה-המלאה

| תיקייה | יעד | רעיון | חוסמים (מאומתים) | פסק |
|---|---|---|---|---|
| cmvdg33u | src/lib/db.ts (+RBAC) | wrapper-RBAC ל-Prisma | tsc: 9×TS1005/1128; catch-על-unknown; spread-מאבד-prototype; PrismaClient-שני | REJECT-AS-WRITTEN |
| cmvdj3bn | src/middleware.ts | לוג-winston | winston-לא-מותקן; fs-ב-Edge; מוחק-את-ה-rate-limit-החי (EXEC-CD-44) | REJECT-AS-WRITTEN |
| cmvdkj2e | src/middleware.ts | התראה-על-תנועה-חשודה | קריסה-על-מערך-ריק; setInterval-טופ-לבל; חייב-merge-ולא-החלפה | ENDORSE-WITH-FIXES → נבלע-בהרכב (9cb44214): התראה-מוקדמת-מדודה-100/דק׳-לציבורי-בלבד |
| cmvdr25d | src/middleware.ts | winston+prom-client | deps-חסרים; Edge-לא-תואם; bucket.push-חסר (429-לא-נאכף); סטטוס-תמיד-200 | REJECT-AS-WRITTEN |
| cmvd7w43 | src/instrumentation.ts | — | שכפול-byte-של-הקובץ-החי; no-op | ENDORSE |
| cmvd6si1 | src/instrumentation.ts | cache-WIF-קצר-טווח | cache-WIF-ב-Map-גלובלי (הרחבת-שטח-סוד); מוות-שקט-בלי-WIFs | REJECT-AS-WRITTEN |
| cmvdxs6w | saos-dex src/lib/db.ts | התראת-guard | נשפט-לעומק-W7 (4 חוסמים; גרסה-מתוקנת-מוצעת) | REJECT-AS-WRITTEN · W7 → **אושר-על-ידי-הבעלים ומומש** (e1d1eda9): הגרסה-המתוקנת-חיה |
| cmvdq26s | src/middleware.ts | סריקה+חסימת-IP | tsc-אומת: host.match-תחביר; buckets-לא-מוצהר; חוסם-/api/dex/showcase-לגיטימי; קורופציה-"při" | REJECT-AS-WRITTEN |
| cmvdpcn2 | src/middleware.ts | לוג-אבטחה-מובנה | filter-על-IterableIterator (TS2339+TypeError); מוחק-matcher; לוג-כל-ה-query-strings | REJECT-AS-WRITTEN |
| cmvdik4k | route/lib חדש | IDS-עם-DB | models-לא-קיימים ב-Prisma; הכל-בקובץ-אחד; toggles-ללא-auth | REJECT-AS-WRITTEN |
| cmvdkcfc | route/lib חדש | התראות-zod | zod-לא-מותקן; db.alert-חסר; POST-לא-מאומת | REJECT-AS-WRITTEN |
| cmvdzxgt | src/middleware.ts | WAF (SQLi/XSS) | winston-חסר; `;`-פוגע-בכל-UA-לגיטימי (403-המוני); securityMiddleware-שאינו-נקרא | REJECT-AS-WRITTEN |
| cmvdjmmf | src/lib/dex | ניטור-API-מדורג | db.apiMonitor-חסר; כתיבת-DB-לכל-בקשה | REJECT-AS-WRITTEN |
| cmvda5b0 | src/lib/db.ts | regex-קפדני-ל-URL | regex-דוחה-את-`file:/home/…`-החי → **לבנית-boot**; מאבד-singleton | REJECT-AS-WRITTEN |
| cmvdkp9b | api/dex route | מעקב-סף-לכל-נקודה | date-fns-חסר; models-חסרים; GET-לא-מאומת-שופך-IPs | REJECT-AS-WRITTEN |
| cmvdfwov | deploy/ | cgroups+namespaces | cgroup-v1-על-מארח-v2; `memory.current_bytes`-לא-קיים; systemd-run-סינכרוני; EXIT-הורג-את-השרת-שהוקם | REJECT-AS-WRITTEN |
| cmvdv3t4 | src/lib/db.ts | התראת-guard-מרכזית | import-מודול-לא-קיים; **payload-נושא-DATABASE_URL-גולמי** (דליפה, מנוגד-ל-R16-a·m7-שלו-עצמו) | REJECT-AS-WRITTEN |
| cmvdi78i | src/lib/dex | IDS-בזיכרון | מקמפל; addFailedAttempt-אף-פעם-לא-נקרא (אבטחה-למראית-עין); GET-לא-מאומת | ENDORSE-WITH-FIXES → נבלע-ב-cmvdo3gm, לא-נערם (XFF-ראשון-ניתן-לזיוף-נגד-קונבנציית-הקצה-האחרון; setInterval-ב-Edge) |
| cmvdl266 | src/lib logging | audit-log-עם-טרנזקציות | uuid-חסר; db.auditLog-חסר; **מתמיד-כל-ה-headers-כולל-Authorization** (דליפת-סוד); ReadableStream.toString | REJECT-AS-WRITTEN |
| cmvdk5x1 | src/lib/dex | אנומליות+ack | db.anomalyEvent-חסר; DDL-של-TIMESTAMPTZ/JSONB-על-**SQLite**; setInterval-טופ-לבל | REJECT-AS-WRITTEN |
| cmvdmuf6 | src/lib/dex | AccessMonitor-סינגלטון | db.accessAttempt-חסר (החוסם-היחיד); דוח-any | REJECT-AS-WRITTEN (רעיון-מאושר) |
| cmvdn0tb | src/middleware.ts | לוג-429-כ-JSON | מקמפל; עותק-מהימן; רק-matcher-ה-proxy שנפל | ENDORSE-WITH-FIXES → נבלע-בהרכב (9cb44214): logUnauthorizedAccess-על-כל-429 |
| cmvdl8jh | src/middleware.ts | threat+apiLog | db.apiLog-חסר; req.ip-הוסר-ב-Next-15/16; התראות-ל-placeholder-קשיח (הוצאת-מידע) | REJECT-AS-WRITTEN |
| cmvdg9ji | src/lib/dex | AccessMonitor-מדורג | **new PrismaClient חשוף-עוקף-את-guard-Roast-68** (וקטור-הנזק-עצמו); db.accessLog-חסר; appendFileSync-סינכרוני-לכל-בקשה | REJECT-AS-WRITTEN |
| cmvdw017 | api/dex/agent | לוג-אנומליה-לפני-agent | import-prisma-שלא-קיים (החי-הוא-db); Agent-model-חסר; אין-operatorAuth; שם-מבטיח-sentry/prometheus-ואין | REJECT-AS-WRITTEN |
| cmvdot73 | src/middleware.ts | warn-על-429 | winston-לא-מותקן (חוסם-יחיד; השאר-עותק-מהימן) | REJECT-AS-WRITTEN (רעיון-מאושר) |
| cmvd8rvh | src/instrumentation.ts | SecureKeyManager | **base64-"הצפנה"**; GET-מחזיר-מפתחות-מפוענחים; `Bearer undefined`-עובר-בדיקה-כש-TOKEN-חסר | REJECT-AS-WRITTEN |
| cmvdeasb | src/lib/dex | policies+events | POST-לא-מאומת-ולא-מתוקף (auth-מוער); GET-מחזיר-לוגים-מדומים (אפס-מוק) | REJECT-AS-WRITTEN |
| cmvd4adr | api/dex/swap | validator-ללא-zod | ה-validator-נקי-אך-**מחזיר-"Swap executed successfully"-מדומה** בלי-לגעת ב-getQuote/submitOp → רגרסיה-קטסטרופלית-לבורסה-החיה | REJECT-AS-WRITTEN (ה-validator-בנפרד-מאושר) |
| cmvdaos6 | src/lib/db.ts | allowlist-env | זריקה-עם-**ערך-WIF-גולמי-בהודעה** (דליפת-סוד); דורש-SAOS_DEX_STATE_DIR-שאינו-מוגדר-בענן | REJECT-AS-WRITTEN |
| cmvdj9rv | src/middleware.ts | access-log+patterns | db.accessLog-חסר; `!!authHeader`-מסמיך-הכל → **401-לכל-ה-API-הציבורי** | REJECT-AS-WRITTEN |
| cmvdww18 | src/lib/db.ts | התראת-guard-מודולרית | רק-`import("./dex/alert")`-שטרם-נוצר; אין-דליפה; שומר-על-fail-closed | ENDORSE-WITH-FIXES → **יושם** (e1d1eda9): המודול-החסר-נכתב (src/lib/dex/alert.ts — לוג-מבני+ledger-JSONL+מדודה) |
| cmvdlfbq | src/middleware.ts | סריקה+bruteforce-מעל-הקיים | matcher `:pat`-מכסה-מקטע-אחד (צריך `:path*`); סף-סריקה-עלול-לחסום-מכות-UI-לגיטימיות; אחרת-עטיפה-נכונה | ENDORSE-WITH-FIXES → נבלע-ב-cmvdo3gm, לא-נערם (מערכת-זיהוי-כפולה-על-אותם-יעדים) |
| cmvdbegu | src/lib/db.ts | RBAC-Proxy | בודק-props-טופ-לבל: כל-`db.<model>.find*/create*`-**עוקף**-את-הבדיקה; `$transaction`-נדחה-שלא-לצורך | REJECT-AS-WRITTEN |
| cmvdz1f2 | src/lib logger | logger-winston+uuid | שני-deps-חסרים; ערך-מועט | REJECT-AS-WRITTEN |
| cmvd9o1o | src/lib/db.ts | מרחב-env-מותר | זורק-על-כל-env-מחוץ-ל-6-מותרים — PATH/HOME-תמיד-קיימים → **boot-תמיד-נכשל** | REJECT-AS-WRITTEN |
| cmve03yr | src/middleware.ts | IDS+Prometheus-מותנה-env | winston+prom-client (Edge); geo-jump-מת (`updateIpHistory(ip, ip)`); באג-קדימות-gauge; מוחק-matcher | REJECT-AS-WRITTEN (הרעיון-בין-הטובים) |
| cmvdb7zm | deploy/ | cgroups-v1-עברית | **bash -n נכשל: מרכאה-לא-מאוזנת (EOF 227)**; waitEOF-פגום; `"50%"`-ב-cpu.cfs_quota_us; heredoc-שבור | REJECT-AS-WRITTEN |
| cmvdo3gm | src/middleware.ts | IDS/IPS-מותנה-env | מקמפל; שומר-על-ה-rate-limit-מילה-במילה; IDS-כבוי-כברירת-מחדל (כנה); נדרש: matcher-proxy+ספי-סף; tracker-לא-חסום-זיכרון-כשמופעל | ENDORSE-WITH-FIXES → **יושם** (9cb44214): matcher-ה-proxy-שוחזר + trimTracker-לכל-ה-trackers (תיקוני-W8-a) |
| cmvdkvpg | src/lib/dex route | monitor-עם-ציד-תשובה | db.apiLog-חסר; Proxy-לא-רואה-body (תמיד-ריק); updateMany-לפי-חלון-שנייה-**דורס-שורות-אחיות**; responseTime~0; "auth"-הוא-הערה | REJECT-AS-WRITTEN |

## שלושת-המעמיקים-הבאים (המלצת-המשפט)

1. **cmvdo3gm** — IDS/IPS-מותנה-env-ששומר-על-ה-rate-limit-החי-byte-מילה-והגון-בכיבוי-ברירת-מחדל; העבודה-האמיתית: matcher-ה-proxy-וספי-הסף.
2. **cmvdlfbq** — הארכיטקטורה-הנכונה "עטוף-את-ה-middleware-הקיים" עם-לוגי-סריקה-מובנים; תיקון-`:pat`→`:path*`+רשימת-לבנה.
3. **cmvdww18** — היורש-הבטוח-של-שושלת-התראת-ה-guard-מ-W7 (בלי-דליפת-URL, fail-closed-נשמר); אשרור-ברגע-ש-`src/lib/dex/alert.ts`-יכתב.

## תבנית-חוזרת-שנמדדה (למערכת-הלומדת)

1. deps/מודלים-מדומיינים (winston/zod/uuid/db.*) — הלומד-מציע-לגבי-קודבייס-דמיוני.
2. החלפת-ה-rate-limit-החי-במקום-עטיפתו — מסוכן-במיוחד.
3. לוגים-שבולעים-headers/body-גולמיים — מנוגד-לחוק-אפס-הסודות.
4. מוקים-מזויפים ("Swap executed successfully") — נגד-דוקטרינת-אפס-המוקים.
5. שמות-יעד-שאינם-תואמים-תוכן — מסוכן-בהדבקה-לפי-שם.

## W9-DELTA · הגל-השני (2026-10-18, 6 הצעות-שהגיעו-אחרי-הפרסום)

- **כיסוי-מלא**: 9-ההצעות-החדשות-נקראו-כולן-במלואן-על-ידי-zai-code (W9 — התור-צמח-במהלך-השיפוט-עצמו: 45→49). מעתה **49/49-משופטים** (40-באינדקס-המקורי + 9-בדלתא-זו; cmvdxs6w-עומק-W7). אפס-הצעות-מחוץ-למפה.
- **תבנית-הגל**: ה-9-כולן-ממשפחות-החוסמים-הידועות — תלותי-פנטזיה (winston/prom-client/`@prometheus/client`), מודלי-Prisma-דמיוניים, ו-capture-על-placeholder-שלעולם-לא-יורה. אפס-דליפות-סוד-חדשות בגל-זה.

| תיקייה | יעד | רעיון | חוסמים (מאומתים) | פסק |
|---|---|---|---|---|
| cmvee7v2 | src/lib (exporter) | יצוא-אירועי-אבטחה (syslog/CEF/webhook) | 3-מודלי-פנטזיה (securityExportTarget/History/securityEvent); **סודות-plaintext-ב-DB** (`auth.value`-משורשר-ללא-הצפנה); Basic-auth-מקודד-ערך-יחיד (ללא user:pass); Prisma+Buffer-ב-Edge-אם-מחובר-כ-middleware → לבנה; setTimeout-retry-אובד-במחזור-תהליך | REJECT-AS-WRITTEN |
| cmveeblf | src/lib (monitor) | ניטור-התנהגותי-ל-DEX (front-run/sandwich) | **לבנת-קומפילציה מתועדת**: `logger`-ו-`prometheus`-מוגדרים-פעמיים (import-בראש + export const-בזנב → TS2300); winston+prom-client-חסרים; `@/lib/logging`+`@/lib/metrics`-לא-קיימים; statusCode=200-מזויף-לפני-התשובה-האמיתית; סף-3-בקשות/5-שנ'-מדגיש-מכות-UI | REJECT-AS-WRITTEN |
| cmveei30 | src/middleware.ts | מגבלת-קצב-עם-ציון-חריגות | **החלפה-מלאה של EXEC-CD-44-החי** (לא-עטיפה); avgRate-מתמקסס-ב-100 (חלון-חתוך-ל-100-רשומות) ו-firstSeen-אף-פעם-לא-מתאפס → ציוני-חריגות-מטפסים-ללקוחות-ותיקים-לגיטימיים; regex-ה-traversal `../../`-בלא-החמקה (מוגבל-לפרמטרי-שאילתה); regex-ה-suspicious-פוגע-בפרמטרי-DEX-לגיטימיים (update/drop/exec) | REJECT-AS-WRITTEN |
| cmveeogv | src/middleware.ts | סינון-תקיפות-ידועות (SQLi/XSS/SSRF) | **`req.text()`-ללא-await` → צריכת-גוף-הבקשה → כל-POST/PUT/PATCH-נשבר** (והסריקה-בודקת-`[object Promise]`); regex-ה-SSRF-פוגע-ב-x-forwarded-for-פנימי (10./172.16-31./192.168.) → 403-המוני-ברגלי-ענן; `\b--\b`-פוגע-ב-tokens-base64url-ב-Authorization → 403-למאומתים; סריקת-כל-ה-headers-כולל-מחרוזות-אימות | REJECT-AS-WRITTEN |
| cmvef1d7 | src/lib/db.ts | מונה-Prometheus-לשגיאות-DB | winston+prom-client-חסרים → **import-של-db.ts-מלבנה-את-כל-המנוע** (db.ts-מיובא-בכל-route); ה-"תיקונים" (Roast-68/R16-a·m7) **כבר-חיים** ב-db.ts-האמיתי — הדלתא-האמיתית-היא-רק-התלות-הפנטזית; file-logging-ברגל-אפמרלית; הדבקה-מלאה-על-קובץ-חי | REJECT-AS-WRITTEN |
| cmvefe91 | src/app/api (monitor) | ניטור-API-ודוח-חודשי | `@prometheus/client`-**שם-חבילה-שאינו-קיים** (האמיתי: prom-client) + winston; db.apiLog+db.monthlyReport-מדומיינים; capture-על-`NextResponse.next()`-placeholder-שלעולם-לא-יורה (מחלת-cmvdkvpg); 4xx-יחיד-מתויג-"High error rate"-שקרית; setInterval-חודשי-בלי-מחזור-חיים | REJECT-AS-WRITTEN |
| cmvefklm | src/middleware.ts | ניטור-התנהגותי-ל-DEX (sandwich/front-run/reentrancy) | `@prometheus/client`-**בפעם-השלישית** (חבילה-שאינה-קיימת); `await req.json()`-בתוך-middleware **צורך-את-גוף-הבקשה → כל-swap/order-נשבר** (בלי-clone); `getCurrentPrice()`-מחזיר-**1.0 קבוע** (מוק-גלוי — sandwich/front-run-מחושבים-מול-מחיר-פיקטיבי); החלפה-מלאה-של-EXEC-CD-44; Map-התנהגותי-ללא-ניקוי (זליגת-זיכרון); middleware.ts-מייצא-GET-/metrics-שלעולם-לא-יושג | REJECT-AS-WRITTEN |
| cmvefr4b | src/lib (wrapper) | ניטור-התנהגותי-בעטיפת-handler | **הטובה-בגל — ארכיטקטורת-עטיפה נכונה, מקמפלת, בלי-deps-פנטזיים**; אבל: regex-ה-SQLi-פוגע-ב-URL-לגיטימי (`;`/`*`/`..`/מילות-מפתח-בפרמטרים → סיווג-שקרי); bot-תמים-מסווג-"injection-attempt"; UA+IP-ללוג-לכל-דגל; שער-הניקוי `%100`-רשלני | REJECT-AS-WRITTEN (מועמד-השדרוג-הראשון-ל-EWF) |
| cmvefxhq | src/lib/db.ts | Sentry-לשגיאות-DB | `@sentry/node`-חסר → **import-brick-של-כל-המנוע**; צורת-log-config-של-Prisma-שגויה (`error:`-בתוך-PrismaClientOptions — שגיאת-קומפילציה + excess-property `target`); `Sentry.init`-**אחרי**-ה-throw-של-fail-closed → ההתראות-מאבדות-בשקט (מוות-בלתי-נראה); ה-guard-מוחלש-מ-dex.db-ספציפי-ל-**כל-.db-שהוא** (נסיגה-מול-Roast-68-החי); תוכן-db.ts-בשם-קובץ-זר → הדבקה-לפי-שם = שני-`export const db` | REJECT-AS-WRITTEN |

- **ראוי-לציון**: cmveei30-ו-cmveeogv-מצטרפים-למשפחת-"החלפה-במקום-עטיפה" (סה"כ-עתה 8-מהתור); cmveeogv-הוא-הבלתי-נסבל-מכולם — היה-ממית-כל-POST-אם-היה-מודבק.

## W-11 · wave-19.44 (2026-10-20 · trace 1a159f309db70225) — שיפוט-שלוש-ההצעות-החדשות · capability-gate לפי החלטה #29 (ארכיטקטורה, לא-תור-בעלים)

| תיקייה | יעד | רעיון | חוסמים (מאומתים) | פסק |
|---|---|---|---|---|
| cmvfl14p + cmvfmzwr | src/middleware.ts | זיהוי-חריגות-התנהגותי (v1+v2, אותה-משפחה) | (1) `req.ip` הוסר-ב-Next-15/16 → כל-ה-IP-ים "unknown" (הניטור-מת) — כ-cmvdl8jh; (2) XFF-קצה-אחרון סותר-את-קונבנציית-קצה-ראשון-שנחתמה (cmvdi78i); (3) מפות-per-IP בלתי-חסומות-ב-Edge בלי-פינוי; (4) `pathname.split("/")[3]` = undefined ל-/api/dex/settle → `includes(undefined)` — גלאי-החזרות-מת; (5) משכפל-מערכות-שנחתמו (EXEC-CD-44 + IDS-cmvdo3gm + early-alert-cmvdkj2e) — תקדים-W8: נבלעים-ולא-נערמים; (6) גלאי-ריפליי-x-nonce על-כותרת-שה-API-החי-לא-משתמש-בה — פיצ'ר-מת; (7) כותרת-x-anomaly-monitored = חשיפת-טביעת-אצבע-פנימית | REJECT-AS-WRITTEN |
| cmvgt298 | src/lib/dex | Alert-Router מרכזי (dedup+suppression) | (1) import-"./alert" לא-נפתר-מהתיקייה-החונה (שבירת-tsc-בהכללה — פצע-ה-include-של-W8); (2) **rawUrl גולמי ב-payload** לקונסולה — וקטור-הדליפה-של-cmvvdv3t4 (מפתח-ה-dedup בלבד מוצפן); (3) הצורה-מפרה-את-הסכימה-המחמירה-של-POST-/api/alerts (שדות-זרים=400) → התראות-מתות; (4) משכפל-את-הדדופיקציה-הדקתית-שנחתמה-W10. חילוץ-לעתיד: hash-only-URL + צורה-מחמירה | REJECT-AS-WRITTEN |
| cmvdp69f | api/dex | ניטור-פעולות-מסוכנות-בזמן-אמת | (1) `req.ip` (אותה-מחלקה); (2) `await req.json()`-ב-middleware צורך-את-הגוף ומעביר-בקשה-בלועה-הלאה — שובר-את-ה-handlers-של-order/swap/agent; (3) "המגביל" לעולם-לא-מחזיר-429 ומשתמש-במפת-ההתראות-כמפת-דליים — הטמעה-כ-middleware הייתה-מחליפה-את-מגביל-EXEC-CD-44-החי-ב-no-op (מחלקת-הפצע-של-cmvj3bn); (4) EARLY_WARN_THRESHOLD לעולם-לא-נבדק — התראה-על-כל-בקשה-ראשונה-בחלון (ספאם) — ה-cmvdkj2e-שנחתם אוכף-את-הסף-כנה; (5) isInternal=XFF-חסר — היוריסטיקה-שגויה-מול-הקונבנציה | REJECT-AS-WRITTEN |

הערה-מבנית: exclude-ה-fabric/ ב-tsconfig (ממצא-W8) החזיק — שלוש-ההצעות-הבלתי-נשפטות לא-שברו-tsc-הפעם.
