# RUNBOOKS — saos-dex · נהלי-תפעול (EXEC-CD-37)

> הענקים מתעדים **מה עושים כשדברים נשברים** — לא רק איך בונים. כל-נוהל כאן
> נולד מאירוע-אמת-מדוד (F-1..F-12, chaos matrices, breaker events). פורמט:
> SYMPTOM → DIAGNOSIS (פקודה) → REMEDY (פקודה) → VERIFY (פקודה+תוצאה-צפויה).
> כלל-ברזל: אף-נוהל לא דורש חומר-מפתח בפלט; אף-תיקון לא עוקף fail-closed.

---

## RB-1 · המנוע-מת (פורט 3010 לא-עונה)
- **SYMPTOM**: `ss -tlnp | grep 3010` ריק · `/saos-dex/api/dex/state` timeout · proof-runner מדווח `engine-down`.
- **DIAGNOSIS**: `tail -30 dex-dev.log` — חפש crash/exit · `cat db/state-snapshot.json | head -c 200` — האם-ה-snapshot תקין (version/height).
- **REMEDY**: `bun mini-services/dex-daemon/…` (ה-launcher-הקנוני) — או המתן-ל-watchdog (דוגם-כל-45s, משחזר-עצמאית — F-6 נסגר: native /proc socket-holder kill, בלי-fuser).
- **VERIFY**: `curl -sf http://127.0.0.1:3010/saos-dex/api/dex/state | head -c 120` מחזיר height>0 · ה-watchdog מדווח revive.
- **נלמד-מ**: chaos3-stack (kill -9 מלא) — המנוע שורד אפס-אובדן-מצב-מחויב, RTO~45s.

## RB-2 · המנוע-חי-אבל-הגובה-קפוא (height stale)
- **SYMPTOM**: proof-runner alert `height-stale` · ה-snapshot-גיל > 120s.
- **DIAGNOSIS**: `tail -30 dex-dev.log` · `ls -la db/state-snapshot.json` (mtime) · אם-המנוע-חי-וקפוא — חשד-HALT מכוון (fail-closed על-אינווריאנטה).
- **REMEDY**: אין-עוקפים! קרא-את-הודעת-ה-HALT בלוג — היא-הראיה. תקן-את-השורש; רק-אז-הפעל-מחדש. אסור-למחוק-ראיות (הכלל-מ-Roast-65-a).
- **VERIFY**: height מתקדם · `bash scripts/saosctl.sh status` מראה 5/5 פורטים וגובה-תואם.

## RB-3 · Snapshot פגום / load-refused
- **SYMPTOM**: `[saos-dex][ALERT] SNAPSHOT SHAPE INVALID` או `STATE UNCANONICAL` באתחול-המנוע.
- **DIAGNOSIS**: `bun scripts/restore-drill.ts` — בודק integrity + קשר-stateRoot↔blockHeader **על-עותק** (אף-נגיעה-במקור).
- **REMEDY**: אם-הקשר-נכשל — המצב-בזיכרון-חתום-ב-blockHeader הוא-האמת; השווה-מול-git-published snapshot (state-push). אין-ג'נזיס-כפוי. אם-ה-DB עצמו-פגום (integrity_check=fail) — שחזר-מה-clone-הקנוני (dex.db בגיט + ≤48s זנב).
- **VERIFY**: restore-drill verdict=PASS · המנוע-עולה-עם `loaded` (לא `corrupt`).
- **נמדד-ב-EXEC-CD-37**: RTO=56ms · tail-אובדן=2-ops · stateRoot שווה-בתים.

## RB-4 · Breaker פתוח / מסילת-עיגון עצורה
- **SYMPTOM**: `state/anchors.json` → breaker.state=open, failures>0 · אין-עיגון-חדש.
- **DIAGNOSIS**: בדוק-בריאות-ה-endpoints-ישירות: `curl -s -X POST https://api.hive.blog -d '{"jsonrpc":"2.0","method":"condenser_api.get_dynamic_global_properties","params":[],"id":1}'`. אם-הם-בריאים — **אין-לעשות-דבר**: ה-breaker חצי-פתיחה-אוטומטי אחרי 5min (BREAKER_COOLDOWN_MS) וה-probe חוזר-לבד.
- **REMEDY**: רק-אם-30+ דקות-פתוח-וה-endpoints-בריאים: הפעל-מחדש-relay (relay-service). אם-ה-endpoints-מתים-אמת — זה-תפקוד-תקין; המסילה תתאושש כשהם חוזרים.
- **VERIFY**: `bun harness/anchor-continuity.ts` → verdict=PASS · breaker=closed · anchored גדל.
- **נלמד-חי (EXEC-CD-37)**: נפתח 06:32 (8×fetch failed) → חצי-פתיחה ~06:37 → **closed, עיגון-חדש נחת 4eecbaa4… אפס-התערבות**.

## RB-5 · RC/בנדווידת' אזל (עיגון-ממתין)
- **SYMPTOM**: relay מדווח RC-חסר (Hive) או BANDWITH_ERROR (TRON) — הזנב-ממתין, לא-נכשל.
- **DIAGNOSIS**: `python3 -c "import json;print(json.load(open('state/anchors.json'))['chains'])"` — pendingFunding/status.
- **REMEDY**: המתן — RC regen ~20%/יום (Hive מתחיל-עצמאית — הוכח-ב-EXEC-CD-36), TRON חינם 600B/יום = עיגון-מלא-1/יום. הסלמה-אופציונלית: +1 TRX לכתובת-הזהות ⇒ staking ≈ 4-5 עיגונים/יום.
- **VERIFY**: anchors.json `anchored` גדל-עצמאית · last-anchor.json מתעדכן.

## RB-6 · אובדן-מפתחות-מלח (.env נהרס / סנדבוקס-מתה)
- **SYMPTOM**: relay `key missing — quiet-disabled` בכל-השרשרות.
- **DIAGNOSIS**: `bun scripts/breakglass-drill.ts` (DRY-RUN) — מוכיח מה-**כספת-בלבד**: מטריצת-סמכות-חיה לכל-שרשרת/תפקיד.
- **REMEDY**: `bun scripts/arm-anchor-keys.ts` — פותח-כספת, מאמת-סמכויות-חי, כותב-.env (0600, gitignored). STEEM יישאר-כנה-סרוב (רוטציה-מתועדת) — זה-תקין.
- **VERIFY**: breakglass verdict=PASS (hive:posting/active/owner + tron-match) · אחרי-חימוש: anchor-continuity PASS.
- **נמדד-ב-EXEC-CD-37**: RTO-מפתחות=1.9s · הכתובת-שחתמה-על-TRON-mainnet נגזרת-מהכספת-בדיוק.

## RB-7 · CI מת (GitHub-דקות-אזלו)
- **SYMPTOM**: כל-ה-Actions-אדומות מאז-10-05 (SAOS-CI-OUTAGE-2026-10-06).
- **DIAGNOSIS**: `gh api repos/roshpinacare-sys/saos-dex/actions/runs?per_page=3` — conclusion=failure מסוג-billing.
- **REMEDY**: אין-לקנות-דקות — **מריץ-עצמאי-מארח-עצמו**: `harness/proof-runner.ts` (קדנס-4h ב-instrumentation + כפתור-בקונסולה). ה-hosted-CI יתעורר-כשהדקות-יתחדשו.
- **VERIFY**: `cat audit-package/proof-pack/latest-proof.json` → run# PASS טרי · proof-ledger.jsonl צומח.

## RB-8 · תהליכי-רקע-נרצחים (nohup-נשחט)
- **SYMPTOM**: קמפיין-ארוך ב-nohup נעלם אחרי-דקות (מתועד-EXEC-CD-34).
- **DIAGNOSIS**: `ps aux | grep <pattern>` — נעלם.
- **REMEDY**: הרצות-**foreground** כשאפשר; לתהליכים-ארוכים — רק-דרך-משפחת-ה-supervisor (dex-daemon/watchdog — ילדים-של-תהליך-שנשאר-חי).
- **VERIFY**: התהליך-חי אחרי-10-דקות · ה-mps-המדוד תואם.

## RB-9 · התנגשות-פורטים / רוח-רפאים-שנייה
- **SYMPTOM**: dev עולה-על-:3011 = כותב-שני-זומבי-על-dex.db.
- **DIAGNOSIS**: `ss -tlnp | grep 3010` — מי-האוחז (cmdline לא-יראה-פורט ב-next-server — השתמש-porth.ts).
- **REMEDY**: `bun mini-services/dex-watchdog/porth.ts 3010` — native /proc socket-holder kill + free-confirmation (F-6). dex-daemon מריץ-זאת-אוטומטית-לפני-spawn.
- **VERIFY**: `ss -tlnp | grep 3010` ריק → spawn-חדש על-הפורט-הנכון.

## RB-10 · פקודות-הפעלה-קנוניות
- סטאטוס-שלם: `bash scripts/saosctl.sh status` (בפועל: `bun scripts/saosctl.ts status`)
- סוללת-הוכחה: `bun scripts/saosctl.ts proof`
- דוח-בוקר: `bun scripts/saosctl.ts report`
- דחיפה-ריבונית: `bash scripts/sovereign-push.sh` (מאגר-האם) · PAT-recipe ל-saos-dex (אפס-טוקן-בלוג)
- ארטיפקטי-הוכחה: `audit-package/proof-pack/` + `MANIFEST.sha256`
