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

## הטבלה-המלאה

| תיקייה | יעד | רעיון | חוסמים (מאומתים) | פסק |
|---|---|---|---|---|
| cmvdg33u | src/lib/db.ts (+RBAC) | wrapper-RBAC ל-Prisma | tsc: 9×TS1005/1128; catch-על-unknown; spread-מאבד-prototype; PrismaClient-שני | REJECT-AS-WRITTEN |
| cmvdj3bn | src/middleware.ts | לוג-winston | winston-לא-מותקן; fs-ב-Edge; מוחק-את-ה-rate-limit-החי (EXEC-CD-44) | REJECT-AS-WRITTEN |
| cmvdkj2e | src/middleware.ts | התראה-על-תנועה-חשודה | קריסה-על-מערך-ריק; setInterval-טופ-לבל; חייב-merge-ולא-החלפה | ENDORSE-WITH-FIXES |
| cmvdr25d | src/middleware.ts | winston+prom-client | deps-חסרים; Edge-לא-תואם; bucket.push-חסר (429-לא-נאכף); סטטוס-תמיד-200 | REJECT-AS-WRITTEN |
| cmvd7w43 | src/instrumentation.ts | — | שכפול-byte-של-הקובץ-החי; no-op | ENDORSE |
| cmvd6si1 | src/instrumentation.ts | cache-WIF-קצר-טווח | cache-WIF-ב-Map-גלובלי (הרחבת-שטח-סוד); מוות-שקט-בלי-WIFs | REJECT-AS-WRITTEN |
| cmvdxs6w | saos-dex src/lib/db.ts | התראת-guard | נשפט-לעומק-W7 (4 חוסמים; גרסה-מתוקנת-מוצעת) | REJECT-AS-WRITTEN · W7 |
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
| cmvdi78i | src/lib/dex | IDS-בזיכרון | מקמפל; addFailedAttempt-אף-פעם-לא-נקרא (אבטחה-למראית-עין); GET-לא-מאומת | ENDORSE-WITH-FIXES |
| cmvdl266 | src/lib logging | audit-log-עם-טרנזקציות | uuid-חסר; db.auditLog-חסר; **מתמיד-כל-ה-headers-כולל-Authorization** (דליפת-סוד); ReadableStream.toString | REJECT-AS-WRITTEN |
| cmvdk5x1 | src/lib/dex | אנומליות+ack | db.anomalyEvent-חסר; DDL-של-TIMESTAMPTZ/JSONB-על-**SQLite**; setInterval-טופ-לבל | REJECT-AS-WRITTEN |
| cmvdmuf6 | src/lib/dex | AccessMonitor-סינגלטון | db.accessAttempt-חסר (החוסם-היחיד); דוח-any | REJECT-AS-WRITTEN (רעיון-מאושר) |
| cmvdn0tb | src/middleware.ts | לוג-429-כ-JSON | מקמפל; עותק-מהימן; רק-matcher-ה-proxy שנפל | ENDORSE-WITH-FIXES |
| cmvdl8jh | src/middleware.ts | threat+apiLog | db.apiLog-חסר; req.ip-הוסר-ב-Next-15/16; התראות-ל-placeholder-קשיח (הוצאת-מידע) | REJECT-AS-WRITTEN |
| cmvdg9ji | src/lib/dex | AccessMonitor-מדורג | **new PrismaClient חשוף-עוקף-את-guard-Roast-68** (וקטור-הנזק-עצמו); db.accessLog-חסר; appendFileSync-סינכרוני-לכל-בקשה | REJECT-AS-WRITTEN |
| cmvdw017 | api/dex/agent | לוג-אנומליה-לפני-agent | import-prisma-שלא-קיים (החי-הוא-db); Agent-model-חסר; אין-operatorAuth; שם-מבטיח-sentry/prometheus-ואין | REJECT-AS-WRITTEN |
| cmvdot73 | src/middleware.ts | warn-על-429 | winston-לא-מותקן (חוסם-יחיד; השאר-עותק-מהימן) | REJECT-AS-WRITTEN (רעיון-מאושר) |
| cmvd8rvh | src/instrumentation.ts | SecureKeyManager | **base64-"הצפנה"**; GET-מחזיר-מפתחות-מפוענחים; `Bearer undefined`-עובר-בדיקה-כש-TOKEN-חסר | REJECT-AS-WRITTEN |
| cmvdeasb | src/lib/dex | policies+events | POST-לא-מאומת-ולא-מתוקף (auth-מוער); GET-מחזיר-לוגים-מדומים (אפס-מוק) | REJECT-AS-WRITTEN |
| cmvd4adr | api/dex/swap | validator-ללא-zod | ה-validator-נקי-אך-**מחזיר-"Swap executed successfully"-מדומה** בלי-לגעת ב-getQuote/submitOp → רגרסיה-קטסטרופלית-לבורסה-החיה | REJECT-AS-WRITTEN (ה-validator-בנפרד-מאושר) |
| cmvdaos6 | src/lib/db.ts | allowlist-env | זריקה-עם-**ערך-WIF-גולמי-בהודעה** (דליפת-סוד); דורש-SAOS_DEX_STATE_DIR-שאינו-מוגדר-בענן | REJECT-AS-WRITTEN |
| cmvdj9rv | src/middleware.ts | access-log+patterns | db.accessLog-חסר; `!!authHeader`-מסמיך-הכל → **401-לכל-ה-API-הציבורי** | REJECT-AS-WRITTEN |
| cmvdww18 | src/lib/db.ts | התראת-guard-מודולרית | רק-`import("./dex/alert")`-שטרם-נוצר; אין-דליפה; שומר-על-fail-closed | ENDORSE-WITH-FIXES |
| cmvdlfbq | src/middleware.ts | סריקה+bruteforce-מעל-הקיים | matcher `:pat`-מכסה-מקטע-אחד (צריך `:path*`); סף-סריקה-עלול-לחסום-מכות-UI-לגיטימיות; אחרת-עטיפה-נכונה | ENDORSE-WITH-FIXES |
| cmvdbegu | src/lib/db.ts | RBAC-Proxy | בודק-props-טופ-לבל: כל-`db.<model>.find*/create*`-**עוקף**-את-הבדיקה; `$transaction`-נדחה-שלא-לצורך | REJECT-AS-WRITTEN |
| cmvdz1f2 | src/lib logger | logger-winston+uuid | שני-deps-חסרים; ערך-מועט | REJECT-AS-WRITTEN |
| cmvd9o1o | src/lib/db.ts | מרחב-env-מותר | זורק-על-כל-env-מחוץ-ל-6-מותרים — PATH/HOME-תמיד-קיימים → **boot-תמיד-נכשל** | REJECT-AS-WRITTEN |
| cmve03yr | src/middleware.ts | IDS+Prometheus-מותנה-env | winston+prom-client (Edge); geo-jump-מת (`updateIpHistory(ip, ip)`); באג-קדימות-gauge; מוחק-matcher | REJECT-AS-WRITTEN (הרעיון-בין-הטובים) |
| cmvdb7zm | deploy/ | cgroups-v1-עברית | **bash -n נכשל: מרכאה-לא-מאוזנת (EOF 227)**; waitEOF-פגום; `"50%"`-ב-cpu.cfs_quota_us; heredoc-שבור | REJECT-AS-WRITTEN |
| cmvdo3gm | src/middleware.ts | IDS/IPS-מותנה-env | מקמפל; שומר-על-ה-rate-limit-מילה-במילה; IDS-כבוי-כברירת-מחדל (כנה); נדרש: matcher-proxy+ספי-סף; tracker-לא-חסום-זיכרון-כשמופעל | ENDORSE-WITH-FIXES |
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

- **כיסוי-מלא**: 7-ההצעות-החדשות-נקראו-כולן-במלואן-על-ידי-zai-code (W9 — 6-בגל-הראשון + cmvefklm-שהגיעה-במהלך-השיפוט-עצמו). מעתה **47/47-משופטים** (40-באינדקס-המקורי + 7-בדלתא-זו; cmvdxs6w-עומק-W7). אפס-הצעות-מחוץ-למפה.
- **תבנית-הגל**: ה-7-כולן-ממשפחות-החוסמים-הידועות — תלותי-פנטזיה (winston/prom-client/`@prometheus/client`), מודלי-Prisma-דמיוניים, ו-capture-על-placeholder-שלעולם-לא-יורה. אפס-דליפות-סוד-חדשות בגל-זה.

| תיקייה | יעד | רעיון | חוסמים (מאומתים) | פסק |
|---|---|---|---|---|
| cmvee7v2 | src/lib (exporter) | יצוא-אירועי-אבטחה (syslog/CEF/webhook) | 3-מודלי-פנטזיה (securityExportTarget/History/securityEvent); **סודות-plaintext-ב-DB** (`auth.value`-משורשר-ללא-הצפנה); Basic-auth-מקודד-ערך-יחיד (ללא user:pass); Prisma+Buffer-ב-Edge-אם-מחובר-כ-middleware → לבנה; setTimeout-retry-אובד-במחזור-תהליך | REJECT-AS-WRITTEN |
| cmveeblf | src/lib (monitor) | ניטור-התנהגותי-ל-DEX (front-run/sandwich) | **לבנת-קומפילציה מתועדת**: `logger`-ו-`prometheus`-מוגדרים-פעמיים (import-בראש + export const-בזנב → TS2300); winston+prom-client-חסרים; `@/lib/logging`+`@/lib/metrics`-לא-קיימים; statusCode=200-מזויף-לפני-התשובה-האמיתית; סף-3-בקשות/5-שנ'-מדגיש-מכות-UI | REJECT-AS-WRITTEN |
| cmveei30 | src/middleware.ts | מגבלת-קצב-עם-ציון-חריגות | **החלפה-מלאה של EXEC-CD-44-החי** (לא-עטיפה); avgRate-מתמקסס-ב-100 (חלון-חתוך-ל-100-רשומות) ו-firstSeen-אף-פעם-לא-מתאפס → ציוני-חריגות-מטפסים-ללקוחות-ותיקים-לגיטימיים; regex-ה-traversal `../../`-בלא-החמקה (מוגבל-לפרמטרי-שאילתה); regex-ה-suspicious-פוגע-בפרמטרי-DEX-לגיטימיים (update/drop/exec) | REJECT-AS-WRITTEN |
| cmveeogv | src/middleware.ts | סינון-תקיפות-ידועות (SQLi/XSS/SSRF) | **`req.text()`-ללא-await` → צריכת-גוף-הבקשה → כל-POST/PUT/PATCH-נשבר** (והסריקה-בודקת-`[object Promise]`); regex-ה-SSRF-פוגע-ב-x-forwarded-for-פנימי (10./172.16-31./192.168.) → 403-המוני-ברגלי-ענן; `\b--\b`-פוגע-ב-tokens-base64url-ב-Authorization → 403-למאומתים; סריקת-כל-ה-headers-כולל-מחרוזות-אימות | REJECT-AS-WRITTEN |
| cmvef1d7 | src/lib/db.ts | מונה-Prometheus-לשגיאות-DB | winston+prom-client-חסרים → **import-של-db.ts-מלבנה-את-כל-המנוע** (db.ts-מיובא-בכל-route); ה-"תיקונים" (Roast-68/R16-a·m7) **כבר-חיים** ב-db.ts-האמיתי — הדלתא-האמיתית-היא-רק-התלות-הפנטזית; file-logging-ברגל-אפמרלית; הדבקה-מלאה-על-קובץ-חי | REJECT-AS-WRITTEN |
| cmvefe91 | src/app/api (monitor) | ניטור-API-ודוח-חודשי | `@prometheus/client`-**שם-חבילה-שאינו-קיים** (האמיתי: prom-client) + winston; db.apiLog+db.monthlyReport-מדומיינים; capture-על-`NextResponse.next()`-placeholder-שלעולם-לא-יורה (מחלת-cmvdkvpg); 4xx-יחיד-מתויג-"High error rate"-שקרית; setInterval-חודשי-בלי-מחזור-חיים | REJECT-AS-WRITTEN |
| cmvefklm | src/middleware.ts | ניטור-התנהגותי-ל-DEX (sandwich/front-run/reentrancy) | `@prometheus/client`-**בפעם-השלישית** (חבילה-שאינה-קיימת); `await req.json()`-בתוך-middleware **צורך-את-גוף-הבקשה → כל-swap/order-נשבר** (בלי-clone); `getCurrentPrice()`-מחזיר-**1.0 קבוע** (מוק-גלוי — sandwich/front-run-מחושבים-מול-מחיר-פיקטיבי); החלפה-מלאה-של-EXEC-CD-44; Map-התנהגותי-ללא-ניקוי (זליגת-זיכרון); middleware.ts-מייצא-GET-/metrics-שלעולם-לא-יושג | REJECT-AS-WRITTEN |

- **ראוי-לציון**: cmveei30-ו-cmveeogv-מצטרפים-למשפחת-"החלפה-במקום-עטיפה" (סה"כ-עתה 8-מהתור); cmveeogv-הוא-הבלתי-נסבל-מכולם — היה-ממית-כל-POST-אם-היה-מודבק.
