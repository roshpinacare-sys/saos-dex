# CHAOS_TEST_RESULTS — מבחן-כאוס מבוקר · SAOS-DEX Relay

> נוצר אוטומטית ע"י `scripts/chaos-test.ts` · ריצה: 2026-09-11T16:24:21.671Z · משך: 104.4s
> הזרקות דרך `src/lib/dex/chaos.ts` (נקודת-הזרקה אינרטית בפרודקשן). מצב-הבדיקה מבודד בתיקיית-זמן — אפס נגיעה ב-`state/anchors.json` החי.

## תרחיש A — ניתוק-RPC יזום (60 שניות, Steem+Hive+TRON)

- 5 חותמות הוזרמו ל-Relay במהלך המחיצה (t=0/15/30/45/58s) — כמו-בפרודקשן.
- כל-ניסיון-שידור נפל על שער-הכאוס לפני-כל-פעילות-רשת/מפתח (כשל-קשי — נספר ל-breaker).

ציר-זמן נצפה:

```
+31s · steem.breaker → OPEN (failures=4, trips=1)
+46s · hive.breaker → OPEN (failures=4, trips=1)
+46s · tron.breaker → OPEN (failures=4, trips=1)
```

## תרחיש B — הזרקת stateRoot מזויף (קריאה-חוזרת מה-RPC הציבורי)

- וקטור-בדיקה: steem · height 48084 · txid `04771b9c643ea900f4e28529cbc527582a1966f4` (עיגון-אמת מ-anchors.json)
- stateRoot מוזרק: `23b61e35df0ece216f46a0d4f420c902ed443d9e838ea52c25916db0b324ae08`
- המערכת זיהתה מיסמאץ', הדליקה `[saos-relay][ALERT]`, ספרה mismatch, וסירבה לאשר.

## תרחיש C — txid לא-קיים

- `not indexed` נשאר כנה: verified=null, אין-mismatch, אין-ALERT שקרי — נכנס לתור-הפיוס.

## תוצאות

| # | בדיקה | תוצאה | פירוט |
|---|---|---|---|
| 1 | A1 · process survived 60s partition | PASS | chaos script still executing |
| 2 | A2 · steem circuit breaker OPEN | PASS | state=open failures=4 trips=1 |
| 3 | A3 · hive circuit breaker OPEN | PASS | state=open failures=4 |
| 4 | A4 · tron circuit breaker OPEN | PASS | state=open failures=4 |
| 5 | A5 · breaker OPEN blocks new attempts (honest queue) | PASS | queue=5 jobs waiting for half-open probe (cooldown 5min) |
| 6 | A6 · zero real network attempts (all errors are injected chaos failures) | PASS | 26 record(s) · every error starts with 'chaos:' — gate fired inside the normal failure path (no RPC/key use) |
| 7 | A7 · breaker trips counted | PASS | trips=7 |
| 8 | B1 · positive control: real stateRoot verifies on-chain | PASS | steem h48084 txid 04771b9c643ea900… |
| 9 | B2 · forged stateRoot DETECTED (mismatch) | PASS | detail="mismatch: on-chain h48084/efdca7c8bfdf… vs local h48084/23b61e35df0e…" |
| 10 | B3 · forged stateRoot REJECTED (not approved as verified) | PASS | verified=false |
| 11 | B4 · ALERT logged on mismatch | PASS | 8 alert line(s) captured |
| 12 | B5 · mismatch counted in metrics | PASS | mismatches 0 → 1 |
| 13 | C1 · not-indexed stays honest (verified=null, no mismatch) | PASS | detail="not indexed (pending reconciliation)" · mismatches unchanged (1) |

**סה"כ: 13/13 עברו · VERDICT: PASS — ה-Relay שורד כאוס ומסרב לאשר שקר**

## כנות

- אפס שידורים אל-השרשראות במבחן: ההזרקה זורקת לפני-כל-גישה לרשת/מפתח (הוכח ע"י A6).
- קריאות-ה-RPC בתרחישים B/C הן קריאה-בלבד (`get_transaction`) — אימות-ציבורי בלתי-תלוי.
- מפתחות: זיכרון-בלבד; אפס סודות בפלט/בדוח.
