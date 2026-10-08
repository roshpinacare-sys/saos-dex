# ROADMAP-42-GAPS — ביקורת-גיט-צוננת + מפת-דרכים (EXEC-CD-42 · 2026-10-08)

> שיטה: **שכפול-צונן מ-GitHub main @ `6f02a8b`** (לא-סנדבוקס, לא-טענות) + מחקר-רשת על טכנולוגיות-הענקים.
> כל-ממצא-נושא-ראיה `file:line` מהשכפול. קובץ-זה הוא-הוספה-נפרדת — לא דורס את ARCHITECTURE_ROADMAP.md.

---

## 1. מה באמת קיים ועובד בגיט (מאומת, לא-נטען)

| יכולת | ראיה |
|---|---|
| גרעין 55+ סוגי-ops (swap/batch-אטומי/orders/pools/oracle/harvest/mint_fuel/refuel/ve/bond/dca/trig/oco/cow/launch/vault/lend/relay/attest) | `src/lib/dex/kernel.ts:960-2350` |
| AMM-קונסטנט-פרודקט עם k-preservation + עמלה-דינמית EWMA 4–1500bps + פיצול 70% LP / 30% אוצר | `amm.ts:44-131` · `kernel.ts:124` |
| **ריבוי-בריכות אמיתי**: SAOS/USDS (9,074 swaps) · USDS/WSTEEM (3,867, dynFee 616bps) · ENERGY/SAOS · USDS/WTRX (מתה, rb=1µ) | snapshot @h171359 |
| עיגון: seal-כל-12-בלוקים עם 4-אסרציות-formal-כושלות-רועשות + 7 רכבות (steem/hive/blurt/tron/eth/sol/fleet) custom_json `saos-dex.anchor.v1` | `chain.ts:454-526` · `relay.ts:103-106` |
| 13 מכשירי-הוכחה (bmc B1-B7 · fuzzer I1-I12 · anchor-continuity מול-RPC-ציבורי · mutation · supply-chain · slo · redteam · insider · jepsen · restore-drill) | `harness/` |
| 57 נתיבי-API עם שער-מפעיל-כושל-רועש (timing-safe) | `src/app/api/dex/**` · `operator-auth.ts` |
| שחזור fail-closed מ-snapshot + HALT-עם-סיבה-פורנזית על-הפרה | `chain.ts:140-146, 811-819` |
| **fee-switch עובד בקנה-מידה-מיקרו**: treasuryProfitEver = **265,929µ (~$266)** — keel-lift כל-8,000µ + fee_sweep-כל-600-בלוקים + 15,140µ SAOS-נשרפו + 21,096µ ve | `chain.ts:586-592` · `economy.ts:112-120` · snapshot |

`treasuryProfit=0` אינו-תקלה — **יתרה-זורמת, לא-מונה** (`kernel.ts:334`); המונה-האמיתי הוא treasuryProfitEver.

---

## 2. הבעיות-האמיתיות (מהקוד, לא-מהלוגים)

1. **מלכוד-הדלק הכלכלי**: fees-שנכנסו-במשך-החיים ≈ 474kµ מול **44.7Mµ** גז-שנשרף. `heartbeat` שורף 10µ/בלוק מהאוצר (~288kµ/יום) ואינו-ב-BOOK_GAS_KINDS → לעולם-אינו-ממוחזר (`kernel.ts:66` · `chain.ts:699` · `bookgas.ts:22-26`).
2. **מוות-מוחלט-של-כלכלת-הסוכנים**: mintable = feeMeter(1,485) − רצפה(8,000) = **0** → "fuel-skip: mintable 0µ<500µ"; במקביל bot-a/b/c מחזיקים **10,000µ כל-אחד והם FUEL_FUNDERS-חוקיים-היום** (`kernel.ts:131, 1497-1509`) — ה-governor פשוט-לא-מפעיל-את-זה.
3. **הארביטראז'-האמיתי על-נייר**: `grids/arb-scan.mjs:1-10` — PLAN/SCAN-ONLY, אפס-ביצוע, realMu≡0. פריט-המשימה "ארביטראז'-אמיתי-קטן" אינו-ממומש-מתכנן.
4. **בריכת-הגיבוי מתה**: USDS/WTRX rb=1µ ולתוכה מחובר real_swap של-סולם-הרזרבה (`ladder.ts:97-119`) — המרת-הגיבוי סורסה-מבנית.
5. **אפס-CI-על-push**: כל-8-ה-workflows dispatch-only (`dex-beat.yml:14-18` · `grid-trigger.yml:7-13`, דוקטרינת-מכסה R71/R75) — **אף-קומיט-לא-נבלם-על-ידי-שום-בדיקה**.
6. **אינדקס-אירועים חסום**: tape-600 · journal-600 (`chain.ts:53` · `kernel.ts:696`) — אין-היסטוריה-נשאלת-מעבר-ל-klines.
7. **פרמטרים-מקומעים**: GAS_TABLE/רצפות/קדנסים = consts-קומפילציה (`kernel.ts:28-243`) — אין-op-שינוי-פרמטר-מנוהל.
8. **אפס-הגבלת-קצב ציבורית**: רק-שערי-מפעיל; SSE-בלי-תרוס.
9. **גיבוי-חוץ-ידני**: ה-snapshot-שורד-דרך-גיט; dex.db/SealRecords — restore-drill-ידני, לא-מתוזמן.
10. **ETH/SOL-עיגון משותקים-כברירת-מחדל** (דגלי-broadcast-false ב-.env.example) — intents-בלבד.

---

## 3. מפת-הדרכים — מה-הענקים-עושים-ואנחנו-לא (מדורג: פותר-בעיה-אמתית × מאמץ)

### P0 — סגירת-לולאת-הדלק (הכל S · פותר-בעיות 1+2 · שבוע-אחד)
| # | פעולה | דפוס-ענק | פרוסה-דקה |
|---|---|---|---|
| 0.1 | `GAS_TABLE.heartbeat: 10→0` (op-מערכת-כפוי, כמו relay/batch) | — (סובסידיה-מוצהרת) | שורה-אחת → חיסכון-288kµ/יום |
| 0.2 | governor: refuel-מה-bots-החוקיים (FUEL_FUNDERS) במקום-רק-mint | Chainlink-Keepers | הגדרת-מדיניות: bots-מלווים-עד-500µ/סוכן, החזר-מה-sweep |
| 0.3 | fee-sweep-קדנס: כל-100-בלוקים feeMeter→treasuryProfit עם Receipt-ביקורת | **Uniswap UNIfication fee-switch** (17%→treasury/burn, ~$26M/שנה) | הקוד-כבר-קיים (fee_sweep) — רק-קדנס+Receipt+סף |
| 0.4 | **CI-על-push** לדקס: tsc+lint+proof-runner --once | כל-הענקים | workflow-אחד on:push — הבלם-החסר-היחיד |

### P1 — אמת-ציבורית-ועיגון-חסין-ל-RC (S · פותר-משבר-העיגון)
| # | פעולה | דפוס-ענק | פרוסה-דקה |
|---|---|---|---|
| 1.1 | הפעלת-רכבת-**Blurt** (ללא-מערכת-RC-בכלל → אפס-עלות) | רידונדנציית-רכבות | דרוש BLURT_ACTIVE_WIF מהבעלים (`relay.ts:100-102, 1383-1388`) |
| 1.2 | הצעד-של-הבעלים: delegate-HP קטן (10-50HP) ל-headcorner | Ecency/PeakD-דפוס | מתועד-ב-DEPLOYMENT_CHECKLIST; פותר-את-עיגון-#5 מיידית |
| 1.3 | **עיגון-אגודתי**: merkle-window-של-4h → עוגן-אחד-במקום-ארבעה | SCITT/BTA-timestamping | מדיניות-relay-בלבד, אפס-שינוי-גרעין |
| 1.4 | **inclusion-proofs ב-TruthRail**: root+siblings+leaf בכל-receipt + עוגן-גיט-שני (commit-message-של-ה-root — אפס-RC) | Stampery-BTA | witness-push.sh-שדרוג — הציבור-מאמת-לבד |
| 1.5 | **rebuild-drill-מתוזמן**: סנדבוקס-קר-מהגיט→proof-PASS-ב-20דק', שבועי | GitOps-דפוס-הענקים | `scripts/rebuild-drill.sh` + קדנס |

### P1.5 — כלכלה-אמיתית (M)
| # | פעולה | דפוס-ענק | פרוסה-דקה |
|---|---|---|---|
| 1.6 | **keeper-paid-economy**: תור-מטלות-מיקרו (refill-rung/ניסיון-עיגון/sweep-check) במחיר-µ מה-sweep-הממומש | **CoW-solvers** | keeper-queue.json + חייל-אוסף-500µ-למטלה |
| 1.7 | **oracle-פסי-מחיר**: peg-אקסיומה 1.00 ±2%→עמלה-מוגברת, ±5%→דחייה-רועשת | **GMX-oracle-bands** | נקודת-התערבות-אחת-לפני-poolSwap |

### P2 — יעילות-שוק (M · אחרי-שהדלק-זורם)
| # | פעולה | דפוס-ענק | פרוסה-דקה |
|---|---|---|---|
| 2.1 | **ניתוב-פיצול על-המדרגות** — ה-grid-הוא concentrated-liquidity-ברוח; חציית-מדרגות-לפי-מחיר-שולי | **Uniswap-v3 · Jupiter-split-routing** | מהלך-חמדני + `route[]`-ב-receipt |
| 2.2 | **batch-settlement**: netting-זרימות-הפוכות-לפני-AMM, מחיר-ניקוי-אחד | **CoW-batch-auctions** | חלון-3-6ש'; אחרי-אימות-מכשירים |
| 2.3 | **feePolicy(ctx)-hook**: bps = base + k·|Δprice| + תוספת-אי-איזון, clamp[1,50] | **Uniswap-v4-hooks** | נקודה-אחת-לפני-swap, חשוף-ב-state |

### P3 — תצפית-ורשת (M)
| # | פעולה | דפוס-ענק | פרוסה-דקה |
|---|---|---|---|
| 3.1 | **explorer-read-model**: /explorer/swap?fromHeight · /explorer/fees?window · /explorer/anchors + דף-HTML-ציבורי-מה-witness-loop | **Ponder/The-Graph** (בקנה-מידה-שלנו) | על-ה-audit-chain-הקיים, בלי-DB-חדש |
| 3.2 | הכחשת-מוות-בריכת-הגיבוי: מילוי-מחדש-USDS/WTRX-או-ניתוק-real_swap-ממנה | — | החלטת-בעלים |
| 3.3 | rate-limit-ציבורי + גיבוי-offsite-מתוזמן (dex.db+SealRecords) | סטנדרט-קצה | fence-הרחבה + cron |

---

## 4. נגד-דפוסים — מה-הענקים-עושים-ש**לא**-נעשה (יבזבז-זמן-בקנה-מידה-שלנו)

L1-עצמאי · ספר-פרפ/מלחמות-latency · גשרים-cross-chain · veTokenomics-לפני-revenue · MEV-auction-חוץ-מנועית · ריבוי-רשתות-לפני-עומק · ZK/fraud-proofs · aggregator-על-DEXes-חוץ · The-Graph-מלא · oracle-רשת-מוסדית.
**הכלל**: עומק-לפני-רוחב, revenue-לפני-טוקנומיקה, ראיה-מקומית-לפני-תשתית-חוץ.

---

## 5. המכשול-המבני-הכן

כל-ה-P0-הוא-שבוע-עבודה-ולא-משנה-את-הכלכלה-לבד: **fees-in-474kµ-מול-gas-44.7Mµ** — בלי-נפח-חוץ-אמיתי (ערוצי-רווח/משתמש-אנושי-אחד) הלולאה-נשארת-פנימית. ה-P0 מפסיק-את-הדימום-ומחייה-את-הסוכנים; ה-P1.5/P2 הם-מה-שהופך-עמלות-להכנסה; **ערוץ-הרווח-החוץ-הראשון הוא-הפריט-שאף-קוד-לא-יחליף**.

## 6. מקורות-ענקים
Uniswap-UNIfication: blog.uniswap.org/unification · Uniswap-v4-hooks: developers.uniswap.org/docs/protocols/v4/concepts/hooks · Trail-of-Bits-hook-בטיחות: blog.trailofbits.com/2026/07/30 · CoW-batch/limit: cow.fi/learn · GMX: coinbureau.com/review/gmx-review · Hive-RC-delegation: docs.ecency.com/hive/resource-credits · SCITT: ietf.org/archive/id/draft-fassbender-scitt-time-anchor-07 · GitOps: developers.redhat.com/topics/gitops · Ponder: ponder.sh
