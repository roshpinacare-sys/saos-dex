# SAOS PULSE — 2026-09-13 — R17 — חיבור-הגיטהאב-השלם (DEVGATE INTEGRATED)

**trace:** 1a099bd11deb4141 · **דחיפה:** create-only · zero secrets · zero force-push

---

## מצב (מה קרה)

בקשת-הבעלים: *"חיבור לגיטהאב בצורה בטוחה, זמין לכל התיקיות שלנו בגיט, מכל צ'אט, מוכן להחלפת PAT — מה שהוכן בפעם הקודמת לא באמת עבד"*, עם האפליקציה **devgate** שהועלתה כתשתית-המיועדת.

**האבחון הכן של הכישלון הקודם (מדוד, לא תירוץ):**
- ההכנה הקודמת הסתמכה על `core.askpass` בלבד + משתני-סביבה (`GIT_ASKPASS`, `SAOS_GH_TOKEN_FILE`) שכל צ'אט-חדש היה חייב "לזכור" — ולא זכר. **לא היה `credential.helper` גלובלי** — השכבה שהופכת `git push` רגיל לעובדת בכל תיקייה בלי שום הקשר.
- **הטוקן עצמו תקין**: API `/user` → HTTP 200, `roshpinacare-sys`. התקלה הייתה שכבת-החיבור, לא המפתח. שני העותקים (`~/.secrets/github-token` ו-`upload/Roshcaregt.txt`) זהים (fingerprint sha256:22283203).

**מה נבנה — ארבע שכבות:**
1. **שרשרת-אחזור אחידה** (בשני העוזרים): `~/.secrets/github-token` → devgate-broker `github-pat` → `upload/Roshcaregt.txt`. עותק-אחד-אמת ורזרבות.
2. **`credential.helper` גלובלי** (`~/.gitconfig` → `~/.secrets/saos-git-cred.sh`): `git clone/pull/push` רגיל עובד **בכל תיקייה, מכל צ'אט, באפס משתני-סביבה**. הטוקן לעולם לא ב-argv, ב-git-config, בלוגים או בצ'אט.
3. **devgate (v0.12.0) מותקן ורשום**: SecretBroker לפי ADR-005 — הטוקן רשום כ-ref `github-pat` (0600/0700, מחוץ לריפו); מפתח-סוכן `dgk_` (saos-main, coder) נוצר ונשמר `~/.secrets/devgate-agent-key` (0600) **מבלי להדפיסו לצ'אט**; HTTP control plane על :3041 (`/healthz` 200, 401 בלי מפתח).
4. **כלים מנוסחים בריפו-הראשי** (זמינים לכל צ'אט עתידי): `scripts/saos-git-bootstrap.sh` (רופא+מתקין אידמפוטנטי) · `scripts/gh-rotate.sh` (רוטציית-PAT fail-closed) · `scripts/saos-git-cred.sh` · `scripts/saos-git-askpass.sh`.

## ראיות (מדידות חיות, לא סיפורים)

- `saos-git-bootstrap.sh` → **BOOTSTRAP OK** בריצה-ראשונה: קבצים 0600/0700 · gitconfig נכתב · broker ref קיים.
- **הוכחת-כל-תיקייה**: `env -i PATH=... HOME=/home/z git ls-remote` על הריפו-הראשי → **הצלחה** (אפס משתני-סביבה).
- **הוכחת-תיקייה-נייטרלית**: `git clone` של `anchor-baseline` מתוך `/tmp` עם `env -i` → **הצלחה**.
- devgate: `GET :3041/healthz` → `{"status":"ok","version":"0.12.0"}` · `GET /api/v1/tools` עם מפתח-הסוכן → נדחה כראוי ללא-מפתח (401-צפוי נמדד על סבב-הפעלה).
- `devgate secrets list` → `["github-pat"]` — הערך לעולם לא נבדק/הודפס.

## תוכניות — רוטציית ה-PAT (הבעלים, בלי שהטוקן יעבור בצ'אט)

1. **בעלים ב-GitHub-web**: יוצר PAT חדש — מומלץ fine-grained: resource-owner `roshpinacare-sys`, הריפואים השותפים + הריפו-הראשי, הרשאת Contents: Read+Write (וגם Workflows: RW אם יידחפו קבצי-workflow). חלופה-קבילה: classic עם `repo, workflow`.
2. **העלאה-מקומית**: מניחים את הטוקן החדש ב-`/home/z/my-project/upload/new-pat.txt` (כמו ש-Roshcaregt.txt הועלה) — **בלי להדביק אותו בצ'אט**.
3. **הבעלים אומר בצ'אט רק**: "ה-PAT החדש הועלה".
4. **ריצה**: `bash /home/z/my-project/platform-latest/scripts/gh-rotate.sh` — מאמת מול-API (login + הרשאת-push על כל 12 הריפואים) **לפני** כל שינוי, מתקין אטומית לשלוש החנויות (canonical + legacy + broker), מוכיח `ls-remote` בסביבה-נקייה, מדפיס login/scopes/fingerprint בלבד. כישלון = אפס שינוי.
5. **הבעלים שולל את ה-PAT הישן** ב-GitHub-web → הרוטציה נחתמת.

## כנות (מה עדיין לא נפתר — בלי קישוט)

- **תהליך-השרת של devgate (:3041) אינו שורד בין-הפעלות** בסנדבוקס — נמדד: תהליכים-מנותקים נקצרים מחוץ לעץ-האתחול. **שכבת-הקבצים** (טוקן 0600 + gitconfig + עוזרים) היא העמידה ואינה דורשת תהליך כלל; השרת מופעל לפי-צורך בפקודה אחת (`mini-services/devgate-gate`) — נרשם בכנות בקוד ה-wrapper.
- **הטוקן החי עדיין ה-PAT הישן** מתקרית-R11 (היקפים רחבים: admin:org, delete_repo) — עד שהבעלים ישלים את הרוטציה וישלול את הישן. זו כעת **פעולת-הבעלים היחידה** בשרשרת.
- **OAuth-web ("Sign in with GitHub") לא הופעל** — דורש רישום OAuth App עם callback-HTTPS; נרשם כ-רודמאפ (ADR-005: GitHub App = מצב-יעד). נתיב-הרוטציה שנפתח כעת הוא העלאת-קובץ + `gh-rotate.sh`.
- עריכת-ראיות של סבב-401 נמדדה בסבב-הפעלה אחד — בסבבים שאחריו השרת כבה מטעמי-סנדבוקס; ההיגיון (401 בלי-מפתח) נשען על בדיקת-הקוד (auth.py) ונמדד פעם-אחת חיה.

---

**חתימה:** R17 · חיבור-גיטהאב מכל-תיקייה מכל-צ'אט · devgate-משולב · רוטציה מוכנה · zero secrets · create-only
