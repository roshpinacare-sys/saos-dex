# REVIEW-W7 · שיפוט-עזר להצעת-fabric `cmvdxs6w`

- **סוקר**: zai-code (main instance), 2026-10-18 · סמכות: advisory-בלבד — **השער-של-הבעלים-נשאר-סגור-עד-אישרור-מפורש**
- **הצעה**: `fabric/cmvdxs6w/saos-control-center-src-lib-db-ts.ts` — שכבת-התראה (POST ל-control-center) על-גבי-ה-guard-הקיים
- **פסק**: **REJECTED-AS-WRITTEN · IDEA-ENDORSED** — הרעיון-צודק-ומשלים-הגנה-חיה-בלולאה-אמיתית, אך-הקוד-ככתבו-לא-מתקמפל-ומכיל-דליפת-סוד-עדינה. **אין-לאשרר-כמות-שהוא.** גרסה-מתוקנת-מצורפת-למטה-לאשרור-מבט-אחד.

## מה-כבר-קיים (מדידה, לא-הנחה)

- `src/lib/db.ts` של saos-dex **כבר מוגן**: FIX(Roast-68 · db-scope-guard) חי — fail-closed ב-boot אם-ה-DATABASE_URL אינו-dex.db-של-המנוע; FIX(R16-a·m7) — תיאור-מסונן-בלי-גוף-הכתובת.
- ההצעה **מוסיפה-רק-את-ההתראה**: בעת-חסימת-התקשרות-בלתי-מורשית, POST-חד-פעמי-ל-`${SAOS_CONTROL_CENTER_URL}/api/alerts`. זה-סוגר-את-הלולאה: ה-guard יורה → הקונסולה רואה. ערך-אמיתי.

## ארבעת-הפגמים (מדודים, כל-אחד-חוסם-בפני-עצמו)

1. **[חוסם-קומפילציה]** `console.error"[saos-dex] Failed..."` — חסר-`(`-פותח. הקובץ-לא-יתקמפל-בשום-מצב.
2. **[דליפת-סוד-עדינה — מנוגד-לחוק-אפס-הסודות]** ה-comment טוען "hash מסונן" אך `Buffer.from(RAW_URL).toString("base64").substring(0,8)` הוא **base64 שניתן-להיפוך-מיידי** — חושף-את-6-הבייטים-הראשונים-של-הכתובת (שיכולים-לכלול `user:pass@`). חייב-digest אמיתי: `sha256` → 12-hex ראשונים.
3. **[שימוש-שגוי]** `AbortController ? AbortController.prototype.signal : undefined` — `signal`-הוא-getter-של-מופע; גישה-דרך-ה-prototype אינה-timeout-תקף. התיקון: `AbortSignal.timeout(3000)`.
4. **[עמימות-יעד — מסוכן]** שם-הקובץ מכוון-אל `saos-control-center` (הקונסולה), אך-התוכן-כתוב-למנוע-`saos-dex`. מי-שידביק-אותו-לפי-השם-לתוך-db.ts-של-הקונסולה — **ילבין-את-הקונסולה-כולה** (ה-DATABASE_URL שלה-אינו-dex.db → ה-guard יזרוק-ב-import → האתר-מת). היעד-האמיתי: **saos-dex `src/lib/db.ts` בלבד**. ככלל-קבוע-לעתיד: שם-תיקיית-fabric חייב-להצביע-במדויק על-הריפו-והקובץ.

הערה-משלימה: ה-receiver (`POST /api/alerts`) **אינו-קיים** בקונסולה. בנייתו-היא-הצעה-נפרדת-שתבוא-רק-אחרי-אשרור-ההצעה (היקף: validate-מינימלי + ledger מקומי + חשיפה-בפאנל — אפס-סודות, fail-open).

## הגרסה-המתוקנת (לאשרור-מבט-אחד — יעד: saos-dex `src/lib/db.ts`)

```ts
import { createHash } from "node:crypto";

// ...כל-ה-guard-הקיים-נשאר כמותו (Roast-68 + R16-a·m7)...
if (!isDexOwnDb) {
  const desc = /* כמו-בקוד-הקיים — ללא-שינוי */;
  // התראה fail-open: כישלון-בהתראה-אינו-מרכך-את-ההגנה (ה-throw-למטה-הוא-החוק)
  void (async () => {
    try {
      const base = process.env.SAOS_CONTROL_CENTER_URL;
      if (!base) return;
      await fetch(`${base}/api/alerts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: "unauthorized_database_connection_attempt",
          at: new Date().toISOString(),
          service_id: "saos-dex",
          url_hint: createHash("sha256").update(RAW_URL).digest("hex").slice(0, 12), // digest אמיתי — אינו-הפיך
        }),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // אל-תשבור את ה-boot בגלל התראה
    }
  })();
  throw new Error(errorMessage);
}
```

שינויים-מול-ההצעה: (1) תחביר-מתוקן, (2) sha256-digest-במקום-base64, (3) `AbortSignal.timeout`, (4) `void (async…)()`-במקום-top-level-await — נייטרלי-למודול-מערכת, (5) ה-throw-נשאר-בלתי-מותנה-בהתראה — **ההגנה-fail-closed, ההתראה-fail-open**.

## מה-נדרש-מהבעלים

אישרור-אחד: "מאשר-את-הגרסה-המתוקנת". אז: (א) ה-patch יידחף-ל-dex-במסילה-המתובעת-שלו, (ב) תיפתח-הצעת-המשך-ל-receiver-בקונסולה. עד-אז — שום-יד-לא-נוגעת.
