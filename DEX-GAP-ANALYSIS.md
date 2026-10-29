# DEX-GAP-ANALYSIS — SAOS-DEX מול מיליארד-דולר (Task 3 · סקר אמת, אפס-המצאות)

> כנות-על: כל-שורה במסמך זה נתמכת במקור ציבורי שנקרא ביום-כתיבתו (2026-10-29), או בקובץ-מדידה
> חי בריפו עצמו. איפה שלא מדדנו — כתוב "לא-נבדק". המסמך לא מבטיח תשואה, לא מבטיח נזילות,
> ולא מסתיר את הפער המספרי בין $10 למיליארדים.

## 0. מקורות (נקראו-חי, curl, אפס-מפתחות)

| פרוטוקול | מקור | מה נאמת |
|---|---|---|
| Uniswap v4 | docs.uniswap.org/contracts/v4/concepts/hooks · …/concepts/dynamic-fees · …/concepts/overview | hooks, dynamic fees, concentrated-liquidity-בירושת-v3, PoolManager singleton |
| UniswapX | github.com/Uniswap/UniswapX (README) | signed orders, fillers compete, Dutch decay reactors, MEV-protected gasless settlement |
| CoW Protocol | docs.cow.fi/cow-protocol/concepts/benefits/mev-protection · …/introduction/fair-combinatorial-auction | UDP, solver competition, CoW P2P |
| Hyperliquid | hyperliquid.gitbook.io/hyperliquid-docs: trading/fees · trading/order-book · trading/market-making.md · hypercore/vaults/protocol-vaults.md | טבלאות-עמלות מלאות, maker-rebates רציפים, CLOB on-chain, HLP |
| dYdX v4 | dydx.exchange/blog/v4-technical-architecture-overview · github.com/dydxprotocol/v4-chain (README) | orderbook in-memory אצל-validators + settlement on-chain, Indexer קריאה-בלבד |
| GMX v2 | docs.gmx.io/docs/providing-liquidity | GLV/GM pools, אורקל-מחיר, LPs=63% מהעמלות (Arb/Avax) |
| SAOS-DEX עצמו | `grids/state/volume-verify.json` · `src/lib/dex/kernel.ts` · `src/lib/dex/book.ts` · `src/lib/dex/amm.ts` · `src/lib/dex/cow.ts` · `src/lib/dex/maker.ts` · `grids/route-graph.mjs` | המדידות-שלנו |

---

## 1. טבלת-הפערים (feature × שחקן) — ✓ / partial / ✗ עם ראיה-שורה

| feature | SAOS-DEX now | Uniswap v4 | Hyperliquid | dYdX v4 | CoW / UniswapX |
|---|---|---|---|---|---|
| **מודל-נזילות** | ✓ לעצמו: orderbook+escrow (`book.ts`) + AMM x·y=k (`amm.ts`) + דלתות-עטיפה 1:1 | ✓ CL מרוכזת פר-tick על PoolManager singleton ("the same concentrated liquidity behavior as Uniswap v3") | ✓ CLOB מלא on-chain — tick/lot שלמים, price-time priority | ✓ orderbook in-memory אצל-validators, לא-בקונצנזוס | ✓ intents מגובים בכל-הנזילות-החוץ דרך solvers |
| **Concentrated liquidity** | ✗ אין-ranges; עומק = מלוא-ה-TVL על-כל-הטווח | ✓ מרכז-היצע בטווח-מחיר (ירושת-v3 חיה) | n/a (CLOB — עומק מוגדר פר-order) | n/a (perp book) | n/a (מבוסס-נזילות-חוץ) |
| **Maker incentives** | partial: ייחוס-מייקר חי (`maker.ts` EXEC-CD-8) + ריבייט-10bps ממומן-גז; פנקס-החית-אוצר נולד היום (`grids/maker-rebate.mjs`) | ✗ אין-ריבייט-מייקר — 100% עמלות ל-LP (dynamic fees "directly accrue to liquidity providers") | ✓ "Maker rebates are paid out continuously on each trade" — −1..−3bps לפי נתח-נפח-מייקר (>0.5%/>1.5%/>3%) | partial (מסמכי-העמלות שנקראו לא פירטו ריבייט-מייקר — לא-נבדק) | ✗ מודל-טייקר-טהור (מייקר = solver, לא משולם-ריבייט) |
| **Fee mechanics** | partial: book 30bps in-kind→אוצר-מלא; AMM דינמי 4..1500bps (EWMA-impact, Task 54) 70/30 | ✓ דינמי per-swap, כל-אחוז (4.9bps דוגמה-רשמית), hooks מתאימים | ✓ טיירות 14d: taker 4.5→2.4bps · maker 1.5→0bps; עמלות → HLP/assistance-fund (HYPE burn)/deployers | partial (טיירות קיימות במסמכים; המספרים לא נאמתו בעמודים-שנקראו) | ✓ אין-עמלת-פרוטוקול-ישירה על-ההתאמה; תגמול-solvers מוסבך |
| **MEV protection** | ✓ מבנית: אין-ממפול ציבורי; בונה-הבלוק=ה-solver; cowSettle מחיר-שווק-אחיד + איסור-מילוי-עצמי (`cow.ts` R17-b) | partial (אין-הגנה-מובנית ב-AMM עצמו; נפתר בשכבת-UniswapX) | partial (CLOB — תלוי-latency, אין-ממפול-חוץ; "no latency advantages" רשמי) | partial (matching אוף-שרשרת → אין-ממפול; proposer מרכזי-לרגע) | ✓ UDP + סליקת-solver + CoW P2P — החזקה-ביותר |
| **Intent / batch auction** | partial: `/api/dex/cow` חי — אצווה-פר-בלוק במחיר-אחיד, pro-rata, fallback בריכה→ספר | partial (דרך-UniswapX: Dutch decay + exclusivity) | ✗ | ✗ | ✓ CoW: fair combinatorial auction רב-זוגית; UniswapX: Dutch reactors |
| **תחרות-solvers** | ✗ solver-יחיד (בונה-הבלוקים) — כנות מתועדת ב-cow.ts | n/a | n/a | n/a | ✓ "independent bonded solvers compete"; איזון-fairness מפורסם |
| **אורקל/סמכות-מחיר** | partial: TWAP מ-mid-בריכות → חותם-מחיר → סולם-keel; REF-edges ב-route-graph | partial (pool-mid בלבד; אין-אורקל-מובנה) | ✓ robust price indices (מסמך-ייעודי) | ✓ oracle פר-שוק (מסמכי-concept; לא-נאמת-עומק) | ✓ GMX-דרך: GM markets נפתחות/נסגרות על index price feed (ר' GMX §3) |
| **דטרמיניזם + ביקורת-צד-שלישי** | ✓ יתרון-אמת: stateRoot=sha256(canonicalJSON), עיגון custom_json + `scripts/verify-anchor.ts` נייד | ✗ (לא-נדרש on-chain) | ✗ (node-קוד פתוח, אין-שורש-מצב-מפורסם-נבדק) | ✗ (indexer read-only; אין-שורש-מצב-ציבורי) | ✗ (settlement on-chain רגיל) |
| **נפח-אמת מדוד** | ✗ הכנות: 36 מילויי-שרשרת, ~$10 (volume-verify: 92.859 STEEM + 9.683 SBD — סכימת-שני-הרגלים כפולה-כנה; notional-אמת ≈ $9.5) | ✓ מיליארדים/יום (מרומז במסמכים; לא-נמדד-כאן) | ✓ טבלת-טיירות מגיעה עד >$7B/14d — סדר-גודל מאומת בטבלה הרשמית | ✓ מיליארדים/יום (לא-נמדד-כאן) | ✓ מיליארדים מצטברים (MEV-$1B הפסד מצוטט במסמכיהם) |
| **סודות/מפתחות** | ✓ אפס-סודות בנתיבי-השוק (key-gate, brake, PLAN-ONLY) | n/a | n/a | n/a | n/a |

**GMX (השוואת-עומק נפרדת, כי הוא מודל-שונה לגמרי):** GLV/GM pools מגבים פרפי-אורקל; LPs מרוויחים 63% מכלל-העמלות (Arbitrum/Avalanche — מסמך רשמי); GLV מזיז נזילות בין-שווקים לפי utilization+caps, כולל JIT. זה המודל הקרוב-ביותר ל-POL שלנו — והראיה ש-POL עם אורקל-אמת הוא מודל-מיליארד לגיטימי, לא תירוץ.

**מה המסמכים לא אומרים (כנות):** אף-אחד מהחמישה לא מפרסם את פיצול maker-driven מול retail flow. הפרוקסי היחיד המדיד: Hyperliquid בונה טיירות-ריבייט על **נתח-נפח-מייקר** (מעיד שזרימת-מייקר מקצועית קיימת ומתומחרת), ו-CoW מתמחר solvers (מעיד שהזרימה שלהם כולה טייקר-מול-solver). ל-SAOS יש יתרון-מדידה: `realmarket.ts` מייחס side:"maker"/"taker" על כל-מילוי-חוץ — אנחנו יכולים **למדוד** את הפיצול שלנו, משהו המנהיגים לא מפרסמים.

---

## 2. הפערים-שאפשר-לסגור-בלי-הון-חוץ (קוד-בלבד, כל-אחד עם קובץ-מטרה)

1. **פנקס-ריבייט-מייקר מתוקצב-חית-אוצר** — נולד היום: `grids/maker-rebate.mjs` (plan-only, SAOS-MAKER-REBATE/1) + selftest. הייחוס קיים (`src/lib/dex/maker.ts` makerFeed/TradeEvent.kind:"fill"), הסליקה-קיימת-כשלד (`rebateMarkPaid` + `/api/dex/maker/rebate-settle`). הפער-הנותר: קורא-חלון-מה-TradeEvents החיים → קריאה-יומית → סליקה-מגובה-מדידה. אפס-הון: התקציב = חית-האוצר על עמלות שכבר-נגבו.
2. **סליקת-split-router אטומית** — `grids/route-graph.mjs` כבר מודד k-נתיבים + מעגלי-Bellman-Ford + ORACLE-ALERT; `grids/state/route-map.json` חי. חסר: ביצוע-מתוכנן (plan→ops אטומיים דרך batch, מגן-minOut, תקציב-יומי `grids/daily-budget.mjs`). רווח = arb-bps נמדד × notional. אפס-הון-חוץ (הארביטראז על הספר-שלנו).
3. **הדוק-עמלה-דינמית לפי-זרימה** — `amm.ts` כבר מחשב EWMA-impact; חסר רק אבחנת order-flow (ריבייט-arb מול-retail כמו-v4 "Order Flow Discrimination") — floor פר-סופק. מגן-LVR על עומק-ה-POL שכבר-קיים.
4. **מדידת-פיצול maker/taker מפורסמת** — `realmarket.ts`/`hivemarket.ts` כבר מייחסים side:"maker"; ספירה-יומית → `grids/state/` + פאנל. המנהיגים לא מפרסמים את זה — אנחנו יכולים.
5. **`/api/dex/metrics` Prometheus** — ARCHITECTURE_ROADMAP M1 פתוח-רשמית; אין-קוד-חוץ, אין-הון.
6. **Signer–Executor הפרדה (M2)** — ממשק-Adaptor מתועד; EnvSigner→FileSigner/HsmSigner בלי-שינוי-Executor.
7. **דציי-Dutch לאצווה** — cow.ts משלם מחיר-אמצע-אחיד מיד; קו-דעיכה זמנית (linear decay + exclusivity) הוא פונקציה-טהורה על `at`/`height` — מושך זרימה סבילה לפני-שיש עומק.

## 3. הפערים-שדורשים-הון (האריתמטיקה-הכנה, בלי-איפור)

**עובד-היסוד:** 36 מילויים, ~$9.5 notional אמת (volume-verify, VERIFIED על-שרשרת). עמלת-30bps על $10/יום = **$0.03/יום**. חית-האוצר (30%) = **$0.009/יום**. זו נקודת-הפתיחה.

**(א) יעד $1,000/יום — שלושה-נתיבים, שלושה-מחירים:**

| נתיב | חוק | נוסחה | מה צריך |
|---|---|---|---|
| עמלות-טייקר (ספר) | fee = notional×30bps → אוצר-מלא | $1000 ÷ 0.0030 | **$333,333/יום** notional |
| עמלות-AMM (חית-אוצר) | income = notional×30bps×30% | $1000 ÷ 0.0009 | **$1,111,111/יום** notional |
| קצה-מייקר (הגרידים שלנו) | profit = notional×edge; edge נטו אחרי-adverse-selection | $1000 ÷ 0.0005 (5bps) | **$2,000,000/יום** notional ממולא |

בגודל-טיקט הנוכחי ($0.28/מילוי-ממוצע) $2M/יום = ~7.1M מילויים/יום — לא-ריאלי; בטיקט $100 → 20,000 מילויים/יום; בטיקט $1,000 → 2,000 מילויים/יום. **המשמעות: בלי להגדיל טיקט, אין כמות-מילויים שמגיעה ליעד.**

**(ב) עמלות-LP מ-TVL — נוסחת-האמת:**
```
feeRevenue/יום = TVL × feeBps × u     כאשר u = notional-יומי ÷ TVL (ניצולת-יומית)
$1000 = TVL × 0.003 × u   ⟹   TVL × u = $333,333
```
- u=100% (לא-ריאלי אפילו למנהיגים): TVL = $333k
- u=20% (שאפתני): TVL = $1.67M
- u=10% (בריא-ל-DEX): TVL = **$3.33M**
- ל-70% ה-LP להרוויח $1000/יום: TVL×u = $476,190 → $4.76M ב-u=10%.

**(ג) עומק-הוא-הון (x·y=k, פורמולת-impact):**
```
impact ≈ 2·v ÷ T     (v=עסקה, T=TVL-בריכה; מתקבל מ-Δp/p = v/R, R=T/2)
```
- עסקה $5,000 ב-impact ≤1%: T = $1,000,000
- עסקה $50,000 ב-impact ≤1%: T = $10,000,000
- כלומר: לקבל-פן $2M/יום של זרימת-מייקר-אמת צריך ספר שמכיל טיקטים של $500–$2,000 בסליפ' סבירה — בבריכה זה עומק של מאות-אלפי-$ לפחות.

**(ד) תמחור-מול-המנהיגים (מהטבלאות-הרשמיות שנקראו):** Hyperliquid base taker = 4.5bps, maker = +1.5bps (וריבייט עד −3bps). ה-30bps שלנו = **6.7× יקר** מהטייקר של המנהיג. כל-עוד אנחנו זוג-סגור-עצמי זה נושא-רווח; ברגע שמתחרים על זרימת-חוץ — ה-30bps יהפכו חומה, לא מוצר. ה-DYN_FEE_MIN_BPS=4 שלנו כבר מיושר לתחתית של v4 (4.9bps דוגמת-הבית) — הנתיב-קיים, רק צריך להפעיל אותו כמדרגות-זרימה.

**סיכום-כנות:** הפער הוא לא קוד — הוא **notional יומי של שני-עד-שלושה-סדרי-גודל ועומק שדורש הון של $333k–$10M לפי-יעד-ה-slip**. בלי-הון: קוד סוגר תשתית-רווח (ריבייט, ראוטר, עמלה-דינמית); עם-הון: התשתית הזאת היא שהופכת כל-$ של עומק להכנסה מדודה.

## 4. Top-3 מכניקות-עדיפות (מדורג לפי רווח-מול-מאמץ)

1. **סליקת-split-router אטומית על route-graph** — הרווח נמדד כבר (arb-profitBps חי ב-route-map.json); חסר רק רגל-ביצוע בתוך גבולות daily-budget + brake. מאמץ: ימים. רווח: ישיר, פרופורציונלי ל-notional, מאומת בקבלות.
2. **ריבייט-מייקר מתוקצב-חית-אוצר** — הפנקס נולד (`grids/maker-rebate.mjs` + selftest); השלב-הבא: קורא-חלון יומי + סליקה-מגובה (`rebateMarkPaid`). למה לפני-הכל: הזרימה-החוץ היחידה שקיימת היום (84 מילויי-חוץ, 15 מייקר — volume-verify) צריכה סיבה להישאר ולגדול, והריבייט הוא הסיבה היחידה שלא דורשת הון.
3. **עמלה-דינמית מבחינת-זרימה (anti-LVR)** — על גבי Task 54 הקיים: floor 4bps למסחר-מייקר-נגדי, עלייה-מהירה ל-arb-טייקר. מגן על העומק הקיים מניקוז מושכל — כל-bps-נשמר = רווח-אוצר בלי שקל-הון נוסף.

## 5. סיכונים-שנמצאו במכניקות-הקיימות (מדווחים, לא מתוקנים — מחוץ לתחום-המשימה)

1. **סטיית-סקאלה ב-maker.ts** — `volMu = floor(price×amountMu)` (מדגם-maker.ts:71) בעוד חוק-ה-notional של-הקרנל הוא `floor(price×amountMu/1000)` (kernel.ts:846, book.ts:134). תוצאה: `rebateDueMu` ב-10bps על הסקאלה-הכפולה = **notional-מלא** (שקול-1000× הכוונה) אם ישולם ב-µ-אמת. לפני-הפעלת-סליקה-חייבת-הכרעה: או רגל-÷1000, או סקאלת-קרדיטים-מוצהרת בכתב.
2. **אסימטריית-חוק-עמלה book/AMM** — בספר 100% העמלה לאוצר (book.ts:159,184); בבריכה 70/30 (amm.ts). פנקס-הריבייט מתוקצב לפי 30%-בלבד — שמרני-בכוונה בשני-הנתיבים; מי שירצה להגדיל-תקרה על-ספר-בלבד חייב לעשות-זאת בהחלטה-מדיניות, לא בקוד.
3. **ספירה-כפולה-קוסמטית ב-volume-verify** — volumeSteem+volumeSbd סופרים שני-רגלי-אותם-מילויים; ה-notional-האמת ≈ צד-אחד.
4. **journal.t בתוך-המצב** (מתועד Roast-63 ב-kernel.ts) — ריפליי דורש שחזור-t; חוב-טכני ידוע, לא-מוסתר.

---
*Task 3 · SAOS sovereign DEX mission · אומת: `node grids/maker-rebate-selftest.mjs` → **PASS (35 laws)**, exit 0 · השינויים לא-נדחפו — ממתינים-לסקירת-המנהל. המסמך הזה אינו יוצר-התחייבות-תשואה ואינו מבטיח נזילות. PLAN-ONLY נשמר.*
