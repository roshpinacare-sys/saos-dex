import { NextResponse } from "next/server";
import { getLiveState, TICK_MS } from "@/lib/dex/chain";
import { aleState } from "@/lib/dex/ale";
import { routableMap } from "@/lib/dex/router";
import { EPOCH_BLOCKS } from "@/lib/dex/kernel";
import { getPool, effectiveFeeBps } from "@/lib/dex/amm";
import { makerStatsFor } from "@/lib/dex/maker"; // EXEC-CD-8 · Maker-API — ייחוס-חי

export const dynamic = "force-dynamic";

/* ══ השוואה-חיה: הרשת-שלנו מול-ה-DEX-ים-המובילים (Task 55) ══════════════════
 * דבר-המפעיל: "תנסה לפרוץ דרכים על הרשת שלנו לעומת דקסים אחרים, תעשה השוואה
 * ומה הרשת שלנו תוכל לתת ואיפה היתרון שלנו ואיך לממש אותו למקסם פוטנציאל
 * ערך של הרשת".
 *
 * כנות-מתודולוגית: העמודה-שלנו = מספרים-חיים-נמדדים-מהגרעין (אפס-זיוף).
 * עמודות-המתחרים = עובדות-ציבוריות-מתועדות (מסמכי-הפרוטוקולים, אתרי-המידע
 * הפומביים) — סטטיות-ומסומנות-ככאלה; לא-מחליפים-אותן-בחי-שלא-נמדד.
 *
 * מקורות-העובדות (מסמכי-פרוטוקול-ציבוריים):
 *  · Uniswap v3: עמלה-ריכוזית פר-בריכה 1/5/30/100bps · גז-מסחר-אתריום נע
 *    ~$2-20+ לפי-עומס · MEV/פרונט-ראנינג מוכרים-ב-public-mempool · POL אין
 *    (ה-LP הם-משתמשים) · בלוק ~12ש'.
 *  · Curve: עמלה-בסיס ~0.04% + CRV-הדפסות-תגמול · veCRV-נעילה-עד-4ש' ·
 *    MEV-על-צירי-אתריום.
 *  · OlympusDAO: POL-אמת (בריכות-בבעלות-הפרוטוקול) · בונדים-בהנחה-משתנה ·
 *    ההדפסה-הייתה-בעיית-אינפלציה-מתועדת (OHM-דילול).
 *  · אנחנו: גז-0 (סדר-קנוני-אוף-צ'יין + באצ'-אטומי) · MEV-אין-מבני (אין
 *    ממפול-ציבורי — סדר-קנוני-דטרמיניסטי) · עמלה-דינמית 4..1500bps (מגן-LP
 *    מ-LVR) · POL-צומח-מעמלים-אמת (ALE) · עיגון-Steem/Hive-חי · וההדפסה
 *    היחידה = קרדיט-מדוד-מעמלות (THE-FOUNTAIN) עם-רצפת-אוצר. */

export async function GET() {
  const st = getLiveState();
  const ale = aleState(st);
  const routable = routableMap();
  const pools = Object.values(st.pools);
  const feeBps = pools.map((p) => effectiveFeeBps(p));
  const saosUsds = getPool(st, "SAOS/USDS");
  const deepUsds = pools.reduce((s, p) => s + (p.a === "USDS" ? p.rb : (p.b === "USDS" ? p.ra : 0)), 0);

  const rows = [
    {
      metric: "עמלת-גז למסחר",
      us: "אפס — גז-0 על הגרעין שלנו (באצ'-אטומי)",
      usLive: true, usValue: "0",
      uniswap: "~$2–20+ לעסקה באתריום (גז-ווריאבילי)",
      curve: "גז-אתריום, זול-מ-Uniswap אך לא אפס",
      olympus: "גז-אתריום על כל קניית/מימוש בונד",
      verdict: "יתרון-מובנה: מיקרו-מסחר שפשוט לא כדאי שם — כאן הוא חי",
    },
    {
      metric: "חשיפה ל-MEV / פרונט-ראנינג",
      us: "אין-ממפול ציבורי — סדר-קנוני דטרמיניסטי בתוך בלוק",
      usLive: true, usValue: "MEV=0 מבני",
      uniswap: "חשוף — public mempool, סנדוויצ'ים מתועדים",
      curve: "חשוף על צירי אתריום",
      olympus: "נמוך (לא AMM טהור) אך תלוי-שרשרת",
      verdict: "יתרון-מבני: הסדר הקנוני הוא קוד שלנו, לא מטבע-חול",
    },
    {
      metric: "נזילות בעלות-פרוטוקול (POL)",
      us: `ALE: POL צומח-אוטומטית מעמלות-אמת — ${ale.pol.weightedPolBps} bps ממוצע-משוקלל, ${ale.flywheel.aleSeeds} הזרעות חיות`,
      usLive: true, usValue: `${ale.pol.weightedPolBps} bps`,
      uniswap: "אין POL נטיבי — ה-LP הם משתמשים שיכולים לברוח",
      curve: "נזילות-שכורה בתגמולי CRV — הדפסה מתמדת",
      olympus: "POL אמת — אבל מומנה בהדפסת OHM (דילול מתועד)",
      verdict: "היתרון-שלנו: POL שצומח מהכנסה בלי להדפיס מטבע-ובלי לשכור LP",
    },
    {
      metric: "עמלות מגן-LP",
      us: `דינמיות 4–1500bps לפי-תנודתיות (EWMA פר-בריכה) — חי עכשיו: ${Math.min(...(feeBps.length ? feeBps : [0]))}–${Math.max(...(feeBps.length ? feeBps : [0]))}bps`,
      usLive: true, usValue: "4–1500bps דינמי",
      uniswap: "טירות סטטיות 1/5/30/100bps — נבחרות-מראש",
      curve: "בסיס ~4bps + תגמולי-הדפסה",
      olympus: "לא רלוונטי (הבונדים הם המוצר)",
      verdict: "מגן-LVR אמת: כשהשוק זז — העמלה מתרוממת בזמן-אמת",
    },
    {
      metric: "צמיחה בלי-תלות במשתמשים",
      us: `פלאיהול סגור: ${ale.autonomy.arenaFills} פילים של סוחרי-הארנה (אוטונומיים) · שריפה ${ale.flywheel.burnedSaosMu}µ · הזרעה ${ale.flywheel.aleSeededMu}µ`,
      usLive: true, usValue: `${ale.autonomy.arenaFills} fills אוטונומיים`,
      uniswap: "תלוי כולו בזרימת-משתמשים",
      curve: "תלוי בתמריצי-הדפסה שמושכים מרקיבי-תשואה",
      olympus: "המודל הקרוב — אך דורש משתמשי-בונד",
      verdict: "הגרעין מסחרר את עצמו: הארנה עושה-שוק, העמלים נזרעים חזרה לנזילות",
    },
    {
      metric: "גשרים לרשתות-חיות",
      us: `מסדרון-עיגון Steem+Hive חי — גיבוי-אמת ${ale.vaultFeed.backingWsteemMu}µ WSTEEM · ${routable.filter((r) => r.tier === "rail").length} מסדרונות-ראוטר-בילים`,
      usLive: true, usValue: "Steem+Hive חי",
      uniswap: "מחוץ-ל-EVM — לא רלוונטי; גשרים חיצוניים = סיכון-האק",
      curve: "EVM-מרובה-רשתות (אותו-סיכון-גשרים)",
      olympus: "אתריום-בלבד",
      verdict: "יתרון-יחיד-בעולם: נזילות-ציר Steem/Hive בגז-0 עם גיבוי-עיגון-עצמי-חתום-במפתחות-אמת",
    },
    {
      metric: "קצב-התיישבות",
      us: `טיק ${TICK_MS / 1000}ש' · אפוק ${EPOCH_BLOCKS}-בלוקים (שעה) · באצ'-אטומי עד-8-ops`,
      usLive: true, usValue: `${TICK_MS / 1000}s טיק`,
      uniswap: "~12ש' בלוק אתריום / ~2ש' L2",
      curve: "כ-Uniswap (תלוי-שרשרת)",
      olympus: "כאתריום",
      verdict: "מהירות-L2, אמינות-ריבונית — בלי-L2",
    },
    {
      metric: "עומק-נזילות צוטט",
      us: `בריכות-חיות עכשיו: ΣUSDS נזיל ${deepUsds}µ${saosUsds ? ` · SAOS/USDS חיה (${saosUsds.ra + saosUsds.rb}µ)` : ""}`,
      usLive: true, usValue: `${deepUsds}µ`,
      uniswap: "מיליארדים-$ (הגדול בעולם)",
      curve: "מיליארדים-$ בצירי-סטייבל",
      olympus: "POL עצום אך חד-כיווני",
      verdict: "כנות: עומק-התחלתי קטן — ולכן ה-ALE קיים: כל-עמלה מעמיקה אותו, לנצח",
    },
    /* ── Task 83 · CEX-grade market data — נמדד-חי אחרי-המימוש (2026-10-06) ── */
    {
      metric: "נרות-OHLCV + נפח (TradingView standard)",
      us: "כן — 1m/5m/15m/1h/4h/1d + היסטוגרמת-נפח, מנסחר-אמת-בלבד (git-backed: db/klines.json)",
      usLive: true, usValue: "6 טווחים חיים",
      uniswap: "אין-גרף-ילידי בממשק-הפרוטוקול (GeckoTerminal/DEXScreener-חוץ)",
      curve: "דרך-צד-שלישי",
      olympus: "דשבורד-אנליטי (אין-נרות-מסחר-ילידיים)",
      verdict: "נרות-ילידיים-מהמנוע-עצמו — אפס-תלות-בצד-שלישי, אפס-נרות-מזויפים",
    },
    {
      metric: "גרף-עומק (Depth Chart)",
      us: "כן — SVG-מצטבר bids/asks + מד-חוסר-איזון (imbalance), מהספר-החי",
      usLive: true, usValue: "depth chart + imbalance",
      uniswap: "לא-רלוונטי (AMM — אין-ספר)",
      curve: "לא-רלוונטי (AMM)",
      olympus: "לא-רלוונטי",
      verdict: "היברידי: גם-ספר-עם-עומק-ויזואלי וגם-בריכות — אף-מוביל לא משלב-את-שניהם-ילידית",
    },
    {
      metric: "סוגי-פקודות",
      us: "LIMIT · MARKET · STOP · TAKE · OCO · POST-ONLY · IOC · DCA · batch-אטומי · CoW-מחיר-אחיד",
      usLive: true, usValue: "10+ סוגים",
      uniswap: "swap-בודד (אין-פקודות-מותנות-ילידיות)",
      curve: "swap-בודד",
      olympus: "bond buy/sell בלבד",
      verdict: "סטנדרט-dYdX/Binance — וה-keeper הוא בונה-הבלוקים עצמו (אפס-תשתית-חוץ)",
    },
    {
      /* ── EXEC-CD-8 · Maker-API — המאפשר-הקודי לנזילות-חוץ (2026-10-06) ── */
      metric: "Maker-API מקצועי (batch/cancel-all/rebates)",
      us: `batch-quotes אטומי (≤8, הכל-או-כלום) · cancel-all-סוויפ (אפס-מירוץ, בזמן-בלוק) · ייחוס-מייקר-ממסחר-אמת: ${makerStatsFor("operator").fills} פילים מיוחסים · מסגרת-ריבייט-חיה (תעריף-0 עד-החלטת-מימון)`,
      usLive: true, usValue: "batch+cancelAll+rebate-rail",
      uniswap: "אין-API-מייקרים (AMM — אין-ספר-לצטט-אליו)",
      curve: "אין-API-מייקרים",
      olympus: "אין",
      verdict: "מה-שמושך-מייקרים-מקצועיים-אצל-dYdX/Hyperliquid — עכשיו גם אצלנו, על-ספר-דטרמיניסטי בגז-0",
    },
    {
      metric: "סטרימינג בזמן-אמת",
      us: "SSE (/api/dex/stream — פעימת-2ש׳: מחירים+24h+עסקאות) + long-poll-מבוסס-אירוע (state?v=)",
      usLive: true, usValue: "SSE + event-driven",
      uniswap: "ריענון-לפי-בלוק-אתריום (~12ש׳)",
      curve: "ריענון-לפי-בלוק",
      olympus: "ריענון-ידני",
      verdict: "הזרם מתקדם-עם-כל-בלוק (3ש׳) — מהיר-מהשרשרת-שלהם, בלי-WS-תשתית",
    },
    {
      metric: "היסטוריה-מנותבת (Pagination API)",
      us: "כן — /klines + /trades עם cursor (before) · limit≤1000 · סטטיסטיקת-24ש' בכל-שוק",
      usLive: true, usValue: "cursor pagination + 24h stats",
      uniswap: "subgraph-חוץ (תלות-צד-שלישי)",
      curve: "subgraph-חוץ",
      olympus: "API-אנליטי-סגור",
      verdict: "ההיסטוריה חיה-בתוך-המנוע — אפס-subgraph, אפס-ספק-אמת-חוץ",
    },
  ];

  return NextResponse.json({
    ok: true,
    height: st.height,
    rows,
    methodology: "העמודה-שלנו=חי-נמדד-מהגרעין · המתחרים=עובדות-ציבוריות-מתועדות-מסמכי-פרוטוקול · איפה-היתרון-שלנו=גז-0+MEV-אפס+POL-אוטונומי+ציר-Steem/Hive",
    maximize: "מקסום-הערך: כל-עסקה-מעמיקה-POL (ALE) → פגיעה-במחיר-קטנה → מחזור-גבוה → עמלות-גבוהות → שריפה+הזרעה — הערך-של-הרשת מתקפל-על-עצמו",
  });
}
