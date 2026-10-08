# CHANGELOG — saos-dex

פורמט: Keep a Changelog · סמנטיקה: MAJOR.MINOR.PATCH
כל-ריצה מתועדת ב-worklog של saos-control-center; כאן רק-אבני-דרך-מוסדיות.

## [0.5.0] — 2026-10-08 — עידן-ההוכחה-הרציפה (PROOF ERA)
### Added
- **17+ מכשירי-הוכחה** (harness/): סוללת-אינוואריאנטות מוזרקת-תלויות (I1-I12) ·
  mutation-testing (כל-מוטנט=חייב-למות) · Jepsen-http (מקביליות-100 · cap-48-נמדד) ·
  insider-suite (מה-**לא** יכול בעל-הטוקן) · chaos3-stack (kill -9 לכל-שירות ·
  F-5 watch-gap נסגר) · BMC אקסהוסטיבי depth-4 (**160,000 רצפים · B1..B9 · 0 הפרות** —
  B8 עמלות + B9 נעילות נולדו ב-0.5.0) · proof-runner רציף (קדנס-4h · alerting
  open/resolve) · supply-chain & SBOM · restore-drill (RTO=56ms · RPO-tail=2ops) ·
  break-glass (RTO-מפתחות=1.9s) · anchor-continuity (שרשרת-ביקורת-475 שלמה).
- **מסילת-עיגון-ציבורית חיה**: TRON-mainnet e1e09c7e… (stateRoot-מוטבע, אומת-
  RPC-ציבורי) · 3 עיגוני-Hive (הראשון d902bd61… self-ignited על-RC-regen) ·
  breaker-עצמאי (half-open 5min — התאוששות-חיה-מדודה 8min).
- **saosctl** — אופרציות-פקודה-אחת (status/proof/report/sync) · morning-report
  מדוד · דף-פרוף-חי בקונסולת-האם (/api/saos/proof-status + ProofStatusCard).
- **RUNBOOKS.md** — 10 נהלי-תפעול, כולם-נולדו-מאירוע-אמת · **SLO.md** — 13
  התחייבויות-מדודות + תקציבי-שגיאה + גבולות-כנים.

### Fixed
- F-1/F-1b kernel reject-atomicity (נתפס-fuzz · תוקן · **התיקון-עצמו-נתפס-שוב
  ע"י-seed-424242**) · F-2 unauthenticated value tick · F-3 p95 3.3s→10ms ·
  F-4 division-of-labor מתועד · F-5 legion watch-gap · F-6 fuser-תלוי-אינרטי
  → native /proc socket-holder · F-7 chain-coupled key init · F-8 dead-scalar
  weld · F-9 self-transfer · F-10/F-10b/F-11/F-11b trongrid protocol layer ·
  F-12 pool-family gas receipts (BMC-caught).

## [0.4.0] — 2026-10-07 — כספת-וזהויות
- repo-vault מוצפן (AES-256-GCM שני-שברי-חותם) · שחזור-זהויות ריבוניות ·
  43 בלובים-נבלעים · fleet-key-sweep · כלל-המשפך (כל-ערך-נכנס → כתובת-מגובה-גיט).

## [0.3.0] — 2026-10-06 — כלכלה-חיה
- LADDER (5-שלבי-רזרבה) · עמלות-אמת (feeMeter · feeAccruedTreasury · שריפות) ·
  governor (:3042) fuel-skip-כנה · קציר-ve · תדלוק-ארנה · grid (haran) ·
  market-maker (cashmachine) · arb-scanner (מדידה-אמת מול-Jupiter).

## [0.2.0] — 2026-10-05 — הגרעין-המוסדי
- kernel applyOp עם gas-table · canonical stateRoot · ledgerAudit · blockHeader
  (per-block) · tape · klines · fences (fencedFetch) · policy/budget · signing-gate
  6-שלבים · signing-audit hash-chain.

## [0.1.0] — 2026-09 — לידה
- DEX נייטיב (ספר-פקודות + AMM-CPMM) · SAOS-token · ארנה · לגיון-סוכנים.
