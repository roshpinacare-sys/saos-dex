# צ'קליסט חשיפה-ציבורית לדקס — saos-dex (agent-9 wave-3, 2026-10-17)

## מה נמדד לפני-המעבר לפומבי (הוכחות, לא הצהרות)

| בדיקה | תוצאה | ראיה |
|---|---|---|
| סריקת היסטוריה מלאה (2,789 קומיטים, 122MB .git) | **נקי** | 0 WIF · 0 PEM · 0 PAT · 0 AWS/Google · 0 טוקנים מוצקים (20 אינטרפולציות-env בלבד) |
| סודות ב-HEAD | **נקי** | מפתחות env-only; .env.example ערכים-ריקים (סרוק בביקורת 2-a) |
| כספות .enc בריפו | **אין** | הכספות חיות ב-steem/vault-home/Domain וכו' — לא כאן |
| שערים fail-closed | **עבדו נגדינו בחיים** | db-scope-guard דחה DATABASE_URL שגוי; operatorAuth 503 בלי טוקן; consoleGuard דרש כותרת |
| פרוקסי-פתוח | **סגור** | פאטץ' Roast-63 הקנוני (md5 5928011c) — כל 6 העותקים בארגון |
| בדיקות-אמת | **24 ירוקות** | selftest battery + CI (wave-1, קומיט 3d0e190) |
| ריצה headless | **מוכחת** | scripts/batch-run.ts — bun בלבד, בלי Next/שרת/Actions |
| דחיפות | **--no-force בלבד** | אין כתיבה-מחדש של היסטוריה, אין מחיקות |

## מה חשוף לציבור ומה לא (deploy/Caddyfile.public)

- **חשוף (GET בלבד)**: health · state · klines · metrics · markets · trades · wallets · proofs · price-proof
- **לא חשוף לאינטרנט כלל**: כל מוטציה — order/cancel/faucet/settle/transfer/wrap/door — רק מ-localhost (הקונסולה של המפעיל)
- אפליקטיבית גם-כן: operatorAuth (x-saos-operator) + consoleGuard (x-saos-dex-console) נשארים fail-closed

## חוקי-קבע לאחר-הפיכה-לפומבי

1. **אף סוד לא נכנס לגיט** — ה-DEX_OPERATOR_TOKEN ומפתחות-חתימה חיים ב-env של המארח בלבד
2. push-protection + secret-scanning מופעלים (ריפו פומבי = חינם) — כל דחיפה נסרקת אוטומטית
3. CI (selftest.yml) רץ על כל push — דקות-Actions פומביות חינם וללא מכסה
4. כל-שינוי-שער (operatorAuth/consoleGuard/db-scope-guard) = דורש-בעלים, לעולם לא fail-open
5. הספר SIM עד החלטת-משכון (P4) — ה-README מצהיר זאת ביושר; עסקאות-אמת = שוק-הפנימי של Steem/Hive דרך ה-relay הקיים, עם מפתחות-אקטיב מהכספות של הבעלים בלבד

## דרכי-ריצה (כולן מוכחות, אף-אחת לא דורשת GitHub Actions)

| דרך | פקודה | מתאים ל |
|---|---|---|
| ריצה-אחת (cron על כל מארח) | `bun run scripts/batch-run.ts ops-queue.json` | מימוש-תור-ops תקופתי |
| שרת-מלא | `DATABASE_URL=... SAOS_DEX_STATE_DIR=... bunx next dev -p 3010` | קונסולה + API חי |
| Actions-פומבי | dispatch (wave-2 executor) | בדיקות/בנייה — לא עסקאות |
