/**
 * api-url.ts — EXEC-CD-13 · עוזר-כתובות-ה-API של הטרמינל (מקור-אמת-אחד)
 * ═════════════════════════════════════════════════════════════════════
 * הועבר מ-page.tsx כמות-שהוא (בלי-שינוי-התנהגות) כדי שגם רכיבים-חוץ-בקובץ
 * (leading-coins.tsx) ישתמשו-באותו-נתיב בדיוק — בלי-כפילות ובלי-מעגל-ייבוא.
 * · לייב: כל-הקריאות תחת /saos-dex (basePath — כל-הנכסים-דרך-origin-אחד חשוף).
 * · מראה-ציבורי (STATIC): GET-ים ממופים לעותקי-ה-mirror; השאר → stub-הגון
 *   (ok:false כנות במקום 404) — אפס-הבטחת-שווא.
 */

export const isStaticMirror = process.env.NEXT_PUBLIC_STATIC_MIRROR === "1";

export const dexApi = (p: string): string => {
  if (!isStaticMirror) return `/saos-dex${p}`;
  const path = p.split("?")[0];
  const staticMap: Record<string, string> = {
    "/api/dex/state": "/Console/dex/world.json",
    "/api/dex/relay": "/Console/dex/relay.json",
    "/api/dex/agent": "/Console/dex/agent.json",
    "/api/dex/fleet": "/Console/dex/fleet.json",
    "/api/dex/portfolio": "/Console/dex/portfolio.json",
    "/api/dex/bridge": "/Console/dex/bridge.json",
    "/api/dex/onramp": "/Console/dex/onramp.json",
    "/api/dex/showcase": "/Console/dex/showcase.json",
    "/api/dex/chains": "/Console/dex/chains.json",
    "/api/dex/door": "/Console/dex/door.json",
    "/api/dex/settle": "/Console/dex/mirror-stub.json",
  };
  const mapped = staticMap[path];
  // t= — שבירת-מטמון: Pages שומר תשובות ~10ד' לפי-כתובת; כל-סקר לוקח עותק-חי
  if (mapped) return `${mapped}?t=${Date.now()}`;
  // שאר נקודות-ה-API (settle כבד, route/microdose פרמטריות, POST-ים): ה-stub ההגון —
  // ok:false כנות במקום 404, הלקוח נשאר במצב-המתנה המעוצב שלו.
  if (path.startsWith("/api/dex/")) return `/Console/dex/mirror-stub.json?t=${Date.now()}`;
  return `/saos-dex${p}`;
};
