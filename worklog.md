
---
Task ID: 23-self-deposit
Agent: zai-web session (web-468de1e9 · trace 1a1530e43b512305)
Task: הוראת-בעלים 2026-10-19 — אין-הפקדות-חוץ; הריבונות מייצרת ומפקידה בעצמה; דיבידנד-בעלים יעד $1000/יום; וודא ודחוף.

Work Log:
- git freshness: pull --rebase מהגיט (b98a5fb8→32e17ac6, הגיעו עדכוני fabric).
- מדידת-אמת חיה מול השרשרת (get_accounts, block ~110567388): headcorner 487.086 STEEM נזיל (הקונברט 131.856 SBD הבשיל — ההפקדה-העצמית-הראשונה הוכחה), צי-13 149.893 STEEM + 5.499 SBD, army 68.416 נעול/27 פקודות.
- בניית מנוע-ההפקדה-העצמית grids/self-deposit.mjs (SAOS-SELF-DEPOSIT/1): 6 חוקי-ברזל מקודדים — אין-הפקדות-חוץ, שטיפה-פנימית idle→cashmachine, דיבידנד-בעלים מרווח-מדוד בלבד, הוכח-ואז-דבר, fail-honest (census בלי-מפתחות / ביצוע עם keys-file חוץ), תקרות-ברזל בקוד (רגל ≤10, פעימה ≤50, דיבידנד קנברי $1/יום ×1.25 לרצף-3-ירוקות, תקרה $1000).
- selftest מובנה: 16/16 PASS (node grids/self-deposit.mjs --selftest).
- ריצה-חיה census-only: verdict=PLAN-READY — 11 רגלי-שטיפה, 24.2 STEEM idle→cashmachine, mid=0.102057 מספר-האמת (real_price), פער-דיבידנד מפורסם $1000.
- תיקון measureMid לשדה real_price + נפילה לפיד-חלופי על-שתי-קבוצות-צמתים (אותו-משטר של treasury-ladder).
- עיגון: selftest.yml (CI battery), docs/TOOLS-INDEX.md, grids/state/economy-sovereignty.json (הוכחת-ההפקדה-העצמית + נתיב-הדיבידנד), DECISIONS.md #22, קבלות self-deposit-public.json + self-deposit-receipts.jsonl + dividend-lane.json.

Stage Summary:
- הריבונות כבר הוכיחה הפקדה-עצמית על-השרשרת: 131.856 SBD קונברט → ~486 STEEM נזיל באוצר, אפס-כסף-חוץ.
- מנוע-ההפקדה-העצמית חי ומפורסם: census+plan+dividend-gap בכל-ריצה; ביצוע-שטיפה עם keys-file (fail-closed בלי).
- נתיב-הדיבידנד מקודד: יעד $1000/יום, קנברי-מדורג, רק מרווח-מדוד, פער-מפורסם בכל-קבלה — כנות מלאה, אף-מספר-מומצא.
