# SAOS-DEX — הבורסה הריבונית של הרשת

> בורסה ריבונית, אוטונומית ואוטומטית על ספר-מקומי — המשך-ישר של ההתחלות מהארכיונים:
> **saos-dex.ts** (ספר-הזמנות כריפליי דטרמיניסטי, ערבות/escrow, מחיר-מייקר) ·
> **grid98.cjs** (מצב-תושב, מיקרו-פעימות, ארנת-חיילים, שער-שוליים, סולם-ערך) ·
> **CHAIN_SPEC.md + kernel.cjs** (טבלת-GAS, שלמים-בלבד, stateRoot).

## מה יש כאן

| רכיב | מימוש | מורשת |
|---|---|---|
| **גרעין דטרמיניסטי** | 21 ops, טבלת-GAS מהמפרט, dedupe קשיח, stateRoot=sha256(canon) | kernel.cjs · CHAIN_SPEC |
| **ספר-הזמנות** | escrow מלא (sell נועל בסיס · buy נועל ציטוט), מילוי במחיר-מייקר, partial fills | saos-dex.ts |
| **בריכות AMM** | x·y=k שלמים, עמלי-30bps (70% LP · 30% אוצר), שימור-ערך בכל-swap | dex-facts · grid98 |
| **ארנה אוטונומית** | 4 חיילים עושי-שוק + טייק-מסתובב + שער-שוליים (edge ≥ עמלה+מינ') + בוטי-רעש | grid98 "זאן-חיילים" |
| **שרשרת-פעימה** | בלוק כל-3 שנ׳ · חותם-מרקל כל-12 בלוקים · עדי-חיילים (attest ×4) · תמונת-מצב תקופתית | saosnet · grid98 |
| **סולם-ערך** | הרמת-רצפה ≤0.5% לצעד — מגובה אך-ורק בעמלות-שנמדדו (feeMeter) | grid98 מדרגות-ערך |
| **עטיפות 1:1** | wrap_mint/burn עם גיבוי-נעול וכיסוי-מדוד | dex-facts (WSTEEM) |
| **THE-DOOR** | relay/relay_ack באפס-גז — רישום-עבודה-חוצה-רשת | kernel 108 |
| **הוכחות** | verify-pack ציבורי: עלים + שורש + חישוב-מרקל עצמאי מחדש | verify-pack discipline |

## ריצה

```bash
bun install
bun run db:push
bun run dev        # פורט 3010
```

- קונסולה: `http://localhost:3010` (RTL עברית, זהות zinc-950 + זהב)
- API: `/api/dex/state · markets · order · cancel · swap · pool · wrap · faucet · arena · wallets · proofs · bench · reset · my-orders`
- הוכחת-יכולת: `GET /api/dex/bench?ops=30000` (מדידה-אמת על מצב-טרי)

## כנות-מלאה (העיקרון שלא נוגעים)

- **ספר-ריבוני מקומי בלבד** — אין כסף אמת, אין עסקאות-חוץ, אין הבטחות תשואה.
- **עיגון-שרשרת-ציבורית** (Steem/Hive/TRON custom_json) דורש מפתחות-מפעיל —
  לא קיימים בסביבה זו **בכוונה**. החותמים כאן עיגון-מקומי כן + עדי-חיילים.
- כל-דחייה כנה ומוחזרת (`insufficient-escrow`, `min-out`, `no-cross`, `harvest-exceeds-measured-fees`).
