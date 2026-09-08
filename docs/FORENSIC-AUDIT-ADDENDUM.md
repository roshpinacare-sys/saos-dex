# ADDENDUM — עדכון קריטי לביקורת (נבדק אחרי FORENSIC-AUDIT.md)

**תאריך:** 2026-09-08 · **שיטה:** אימות ישיר מול GitHub API · **סטטוס:** החמרה משמעותית

> קרא את `docs/FORENSIC-AUDIT.md` קודם. זה המשך ישיר שלו.

---

## A. כספת המפתחות מודלפת ב-3 מקומות, לא באחד

| ריפו | נתיב | מפתחות | סיסמה בטקסט גלוי |
|---|---|---|---|
| `saos-sovereign-platform` | `agent/keys/fleet_keys.enc` + `.meta.json` | **7** | **כן** |
| `steem` | `agent/fleet_keys.enc` + `.meta.json` | **7** | **כן** |
| `steem` | `download/recovery/extracted/steem-main/agent/fleet_keys.enc` + `.meta.json` | **2** | **כן** |

**3/3 עותקים מכילים את הסיסמה בשדה `pass`.** אותו KDF (scrypt 2^14), אותו פורמט (SAOS-FLEET-VAULT-1), אורך סיסמה 43 תווים.

**מסקנה:** מחיקה מריפו אחד לא פותרת כלום. **כל המפתחות שרופים. אין דרך אחרת לנסח את זה.**

---

## B. ריפו steem מכיל צי שלם של סוכנים אוטונומיים

זה לא ארכיון. זה **מרכז תפעול**. כ-190 קבצים ב`steem/agent/`:

### תהליכים חיים עם קבצי PID שנושמרו לקומיט

| קובץ | PID |
|---|---|
| `agent/agent_daemon.pid` | `1970` |
| `agent/.guardian-loop-1.pid` | `25265` |
| `agent/.guardian-loop-2.pid` | `25266` |

**משמעות:** היו/יש daemons רצים. קבצי PID בקומיט = התהליכים הופעלו בפועל במכונה כלשהי. **אם הם עדיין רצים — הם פועלים עכשיו, בלי פיקוח.**

### סקריפטים פיננסיים פעילים (שמות בלבד, תוכן לא נקרא)

**מכירה / הסרה / המרה:** `he_sell.cjs`, `he_fleet_sell.cjs`, `he_unstake.cjs`, `he_powerup.cjs`, `wrapped.cjs`, `wrap96.cjs`, `microdex.cjs`, `escrow_rail.cjs`, `yield.cjs`, `mint_borrow.cjs`, `liq_seed.cjs`, `rebalance102.cjs`

**ניהול מפתחות:** `fleet_vault.cjs`, `keyrotate.cjs`, `keyscan.cjs`, `identity.cjs`, `fixpw102.cjs`

**תפעול רשת:** `hive_rc_heal.cjs`, `hive_withdraw_diag.cjs`, `hive_withdraw_trace.cjs`, `paymaster.cjs`, `fuel_line.cjs`, `gas_tank.json`, `energy_ops.cjs`, `rc_sovereign.cjs`

**אוטונומיה / פיקוח:** `guardian.cjs`, `guardian-loop.cjs`, `guardian_boot.cjs`, `sovereign_runner.cjs`, `sovereign_ops.cjs`, `cloud_heartbeat.cjs`, `cloud_takeover.json`, `muster.cjs`, `phoenix.cjs`, `rebuild.cjs`

**מסחר / שוק:** `merchant.cjs`, `merchant_state.json`, `he_ladder.cjs`, `curation_flywheel.json`, `value_lock.cjs`, `worldlog.json`, `sovereign_ledger.json`

> **אזהרה:** he_sell + he_unstake + mint_borrow + yield + rebalance, יחד עם daemon חי וכספת עם 7 מפתחות פתוחה = מערכת שעלולה לבצע פעולות כספיות אמיתיות ללא פיקוח אנושי.

---

## C. Saosmartwallet — 1,335 קבצים, ארנק שלם, מעולם לא נבדק

| נתיב | גודל (bytes) |
|---|---|
| `packages/core/src/vault/vault.ts` | 41,010 |
| `packages/core/src/vault/keys.ts` | 10,182 |
| `src/components/vault/backup-recovery-dialog.tsx` | 34,215 |
| `src/components/vault/vault-setup-wizard.tsx` | 30,769 |
| `src/components/vault/signing-dialog.tsx` | 25,625 |
| `src/lib/vault-runtime.ts` | 9,852 |
| `src/app/api/vault/keys/route.ts` | — |

זה **ארנק עם ניהול מפתחות, שחזור, וחתימה**. נדרשת בדיקת אבטחה מלאה לפני כל שימוש.

---

## D. anchor-baseline/.env — נמצא ונבדק: לא מסוכן

קובץ של שורה אחת, 50 bytes:
- `DATABASE_URL` (ערך באורך 36 תווים — נתיב קובץ SQLite מקומי)
- **אין סודות אמיתיים.** זה היה ממצא SH-3 — **אפשר לסגור אותו כלא-רגיש.**

---

## E. ה-PAT שהודלף היה בעל הרשאות מלאות

classic token עם סקופים מקסימליים: `repo`, `delete_repo`, `admin:org`, `admin:public_key`, `admin:ssh_signing_key`, `workflow`, `write:packages`, `codespace`, `audit_log`, `user`.

**משמעות:** מי שמחזיק אותו יכול למחוק ריפואים, לשנות ארגון, להוסיף מפתחות SSH, ולהזריק workflows. זה לא token לקריאה — זה מפתח מאסטר.

**פעולה:** בטל עכשיו. בעתיד — fine-grained, Contents read/write על ריפו יחיד, תוקף קצר, בלי workflows ובלי admin.

---

## F. פעולות חירום — הסדר השתנה

### עכשיו (דקות)
1. **בטל את ה-PAT של GitHub.**
2. **הרוג את ה-daemons** — חפש במכונות תהליכים עם PID 1970 / 25265 / 25266, וכל `node *guardian*` או `sovereign_runner`. **אם הם רצים, הם עלולים למכור או להעביר נכסים עכשיו.**
3. **הנח שכל המפתחות (7+7+2, עם חפיפה) שרופים.**
4. **סרוק יתרות** ב-4 הכתובות: ETH `0x2767…1b0f`, SOL `9knf…SgiL`, TRON `TYVw…ZxTy`, STEEM/HIVE `headcorner`. כל יתרה → ארנק חדש ממכשיר נקי.

### היום
5. מחק את כל `fleet_keys.*` מ**שלושת** הריפואים.
6. בדוק את `Saosmartwallet/packages/core/src/vault/keys.ts` — האם מפתחות נשמרים בצד לקוח?
7. **כבה אוטונומיה.** שום סוכן לא אמור להחזיק מפתח חי + סקריפט מכירה + daemon, בלי אישור אנושי לכל פעולה.

### השבוע
8. הפרדה מוחלטת: ריפו קוד ≠ ריפו סודות ≠ ריפו מצב ≠ ריפו תפעול.
9. מפתחות → חומרה בלבד. אף מפתח פרטי לא נוגע בדיסק של סוכן.
10. איחוד 3 המסלולים לאחד.

---

## G. מה השתנה במסקנה

**לפני התוספת:** חשבנו שיש כספת אחת דלופה וריפו אחד שמשדר.

**אחרי:** יש **3 עותקים דלופים של הכספת**, **צי שלם של סקריפטים פיננסיים אוטונומיים**, **daemon שהיה רץ עם PID בקומיט**, ו**ארנק שלם בן 1,335 קבצים שמעולם לא נבדק**.

**העוגן על Ethereum אמיתי ומוכח** (block 25,929,672, status 0x1) — זה הנכס. אבל מערכת ההפעלה שמסביבו היא **סיכון בלתי מנוהל**, לא מערכת מבוקרת.

> **השורה הקריטית:** הבעיה אינה שהקוד גרוע. הקוד טוב. הבעיה היא שיש לסוכנים שלך **גישה ישירה לנכסים + אוטונומיה + אפס בלם אנושי**. זה השילוב שמפסיד כסף.

---

*סיסמת הכספת לא שוכפלה בשום מסמך — רק מיקומה ואורכה. כל ממצא כאן אומת ישירות מול ה-GitHub API.*
