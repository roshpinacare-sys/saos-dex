/* fence.ts — הגדר-הריבונית (SETTLE-11) · נעילת-שערים יוצאים (endpoint pinning) fail-closed
 *
 * מול האיומים שהמפעיל קבע: פישינג, סוכנים-זרים, RPC-עוין והרצת-קוד-זר.
 *
 * SECURITY INTENT:
 *  · כל-קריאת-יוצאה של ה-Relay חייבת-לצאת אל שער-מקובע-מראש (pinned host).
 *    שער-לא-מוכר = זריקה fail-closed — אין-שידור, אין-חתימה, אין-דליפה.
 *    זה ההבדל בין "דומיין-טייפוסקווט אחד בתצורה" לבין "המפתח הפעיל שלנו חותם לתוקף".
 *  · מדיניות קוד-זר: אפס. אין eval / new-Function / ייבוא-מרחוק / קוד-מהודס-בזמן-ריצה.
 *    נאכף בסריקה: scripts/fence-check.ts (וגם lint).
 *  · אימות-חוזר מול תשתית-ציבורית עצמאית (verifyOnChain) — גם אם השידור "הצליח",
 *    עיגון לא נחשב אמת עד ש-RPC ציבורי קורא אותו חזרה ביט-מול-ביט.
 *
 * FIX(Roast-65-b · H1): התאמת-מארחים מודעת-פורט —
 *    פין-עירום ("127.0.0.1", "api.steemit.com") מכסה **כל-פורט** על אותו-מארח-שם;
 *    פין-עם-פורט ("127.0.0.1:3004") מכסה רק את אותו host:port בדיוק.
 *    לפני-התיקון: hostOf מחזיר host:port לפורט-לא-סטנדרטי והפינים-המקומיים-העירומים
 *    לא-היו-מתאימים → כל-URL-לוקאלי-עם-פורט (החותם החיצוני של hive-rail!) נזרק-תמיד.
 * FIX(Roast-65-b · M8): אכיפת-scheme — https: חובה מחוץ-ללופבק; http: מותר רק
 *    ללופבק (127.0.0.1/localhost/::1); ws:/wss:/ftp:/data: וכל-scheme-אחר נדחה.
 * FIX(Roast-65-b · H2): fencedFetch — עוזר-מרכזי שמאכף את הגדר **וגם** redirect:"error"
 *    על-כל-קריאה-מגודרת: מארח-מקובע-עוין שעונה 307/308 לא יגרום ל-undici לעקוב
 *    מחוץ-לגדר ולשחזר method+body (עסקאות-חתומות!) אל-URL-שאינו-מקובע.
 * FIX(Roast-65-b · H1/L8): fenceSelftest — בדיקת-ריצה-חיה של-כל-הקוראים-הפנימיים
 *    הלגיטימיים + אכיפת-ה-scheme · fencePosture נגזר-מהמצב-בפועל (אין-עוד-מספרים-קפואים).
 */

import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

/* שערים מוגדרים-סביבה (תצורת-מפעיל מהימנה) מתווספים לקיבוע באתחול */
function envHosts(name: string): string[] {
  const v = (process.env[name] || "").trim();
  if (!v) return [];
  try { return [new URL(v).host]; } catch { return []; }
}

const PINNED_HOSTS = new Set<string>([
  ...envHosts("ETH_RPC_URL"),
  ...envHosts("SOL_RPC_URL"),
  /* גרפני — זהה ל-STEEM_NODES/HIVE_NODES ב-relay.ts (העתק-קנוני מוצהר) */
  "api.steemit.com", "api.justyy.com",
  "api.hive.blog", "api.deathwing.me",
  /* Hive-Engine sidechain — קריאות-מאזנים/שוק של מסילת-ההמרה (hive-rail.ts, Task 27/28) */
  "api.hive-engine.com",
  /* Task 56 · פידי-מחיר-אמת — שוק-ציבורי-חסר-מפתחות (price-proof.ts) */
  "api.coingecko.com",
  /* Task 58 · שרשרת-הפידים-העמידה — מקורות-גיבוי-ציבוריים (מיזוג-פר-נכס) */
  "api.coinpaprika.com", "min-api.cryptocompare.com", "api.binance.com",
  /* Task 4 · BLURT — הרשת-השלישית (blurtHead חי ב-price-proof) */
  "blurt-rpc.saboin.com",
  /* Roast-74 · מסילת-BLURT-רב-רשתית — הצומת-החי-היחיד-שנמדד (blurt.world אבד NXDOMAIN)
   * + מנוע-Steem (הראשי-מת; הפין-שומר-על-נתיב-ה-fail-closed-הממומש) */
  "rpc.blurt.blog",
  "api.steem-engine.net",
  /* TRON */
  "api.trongrid.io",
  /* ETH — ברירות-מחדל של ETH_RPCS */
  "ethereum-rpc.publicnode.com", "eth.llamarpc.com",
  /* SOL — ברירת-מחדל של SOL_RPCS (mainnet-beta) */
  "api.mainnet-beta.solana.com",
  /* FIX(Roast-63): realmarket.ts — רשימת-הצמתים שלו מקובעת-כאן (היה-עוקף-גדר) */
  "steem-rpc.publicnode.com",
  /* FIX(Roast-63): bridge.ts — אימות-הוכחות-חוץ (eth_getTransactionReceipt על-BSC) */
  "bsc-rpc.publicnode.com",
  /* מקומי (דמון/בדיקות) — פין-עירום: מכסה כל-פורט על המארח (FIX(Roast-65-b · H1)) */
  "127.0.0.1", "localhost", "::1",
]);

export function hostOf(endpoint: string): string {
  try { return new URL(endpoint).host; } catch { return ""; }
}

/* FIX(Roast-65-b · H1): פיצול host:port מודע-IPv6 ("[::1]:3004" → host "[::1]", port 3004) */
function splitHostPort(hostport: string): { host: string; port: number | null } {
  const s = hostport.trim();
  if (s.startsWith("[")) {
    const close = s.indexOf("]");
    if (close > 0) {
      const host = s.slice(0, close + 1);
      const rest = s.slice(close + 1);
      if (rest.startsWith(":")) {
        const p = Number(rest.slice(1));
        return { host, port: Number.isFinite(p) && p > 0 ? p : null };
      }
      return { host, port: null };
    }
  }
  const i = s.lastIndexOf(":");
  if (i > 0 && !s.slice(i + 1).includes(":")) {
    const p = Number(s.slice(i + 1));
    if (Number.isFinite(p) && p > 0) return { host: s.slice(0, i), port: p };
  }
  return { host: s, port: null };
}

/** FIX(Roast-65-b · H1): פין-עירום (ללא-פורט) = מארח-בלבד → כל-פורט עליו;
 * פין-עם-פורט = host:port מדויק בלבד. השוואת-מארחים case-insensitive. */
export function hostAllowed(endpoint: string): boolean {
  const hp = hostOf(endpoint);
  if (!hp) return false;
  const req = splitHostPort(hp);
  for (const pin of PINNED_HOSTS) {
    const p = splitHostPort(pin);
    if (p.host.toLowerCase() !== req.host.toLowerCase()) continue;
    if (p.port === null) return true;          // פין-עירום → כל-פורט
    if (p.port === req.port) return true;      // פין-ממוספר → פורט-מדויק
  }
  return false;
}

/* FIX(Roast-65-b · M8): לופבק — המקום-היחיד שבו http: לגיטימי (דמון/חותם-חיצוני/בדיקות) */
const LOOPBACK_HOSTNAMES = new Set<string>(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** שער-לא-מקובע / scheme-אסור = זריקה (fail-closed). נקרא לפני כל-fetch יוצא של ה-Relay.
 * FIX(Roast-65-b · M8): אכיפת-scheme — https בלבד מחוץ-ללופבק; http ללופבק-בלבד;
 * ws:/wss: וכל-scheme-אחר נדחה (fetch לא מיועד אליהם והם פתח-downgrade). */
export function assertAllowedHost(endpoint: string, where: string): void {
  let u: URL;
  try { u = new URL(endpoint); } catch {
    throw new Error(`fence: endpoint פסול ("${endpoint.slice(0, 80)}") — נחסם fail-closed @ ${where}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error(`fence: scheme "${u.protocol}" אסור (ws:/wss:/אחרים נחסמים — https בלבד מחוץ-ללופבק) @ ${where}`);
  }
  if (u.protocol === "http:" && !LOOPBACK_HOSTNAMES.has(u.hostname)) {
    throw new Error(`fence: http:// למארח-לא-לוקאלי ("${u.hostname}") — דרוש https @ ${where}`);
  }
  if (!hostAllowed(endpoint)) {
    throw new Error(`fence: host "${u.host}" אינו מקובע — נחסם fail-closed @ ${where}`);
  }
}

/** FIX(Roast-65-b · H2): ה-fetch-המגודר — הנתיב-המרכזי לכל-קריאה-יוצאת של ה-Relay.
 *  1) assertAllowedHost — שער-לא-מקובע/scheme-אסור = זריקה לפני-שידור.
 *  2) redirect:"error" — נאכף **אחרי**-הפצת-ה-init (לא-ניתן-לעקיפה ע"י הקורא):
 *     מארח-מקובע שעונה 307/308 גורם-reject מידי — undici לא עוקב מחוץ-לגדר
 *     ולא משחזר method+body (עסקאות-חתומות/טוקנים) אל-URL-בלתי-מקובע. */
export async function fencedFetch(url: string, where: string, init: RequestInit = {}): Promise<Response> {
  assertAllowedHost(url, where);
  return fetch(url, { ...init, redirect: "error" });
}

export function pinnedHosts(): string[] {
  return [...PINNED_HOSTS].sort();
}

/* ── FIX(Roast-65-b · H1): fenceSelftest — הוכחת-ריצה שהגדר פתוחה בדיוק לקוראים-הלגיטימיים ──
 * מניפסט-הקוראים-הפנימיים (העתק-קנוני מוצהר — כמו-הפינים; מוצלב-מול-הקוד-ע"י fence-check):
 *  · loopback עם-פורט — פין-עירום מכסה (היה-נזרק-תמיד לפני-H1). Roast-73:
 *    החותם-החוץ של hive-rail אינו-קיים-עוד (בוטל-כנה) — המסילה מבצעת-בדמון
 *    (rail-exec) דרך-הגדר עצמה (HIVE/HE צמתים-מקובעים).
 *  · כל-השערים-החיצוניים-המקובעים (https).
 *  · אכיפת-scheme: http-מחוץ-ללופבק/ws/unpinned → נדחה. */
export interface FenceCase { endpoint: string; expect: "allow" | "reject"; why: string }

export function fenceCallerCases(): FenceCase[] {
  const cases: FenceCase[] = [
    // loopback-http-פין — בדיקות-התנהגות-רגרסיה (Roast-73 כנות: החותם-החוץ של
    // hive-rail אינו-קיים-עוד — הביצוע עבר ל-rail-exec בתוך-הדמון; הפין-עצמו
    // נשאר כלל-גדר-כללי למתקשרי-loopback לגיטימיים)
    { endpoint: "http://127.0.0.1:3004/anything", expect: "allow", why: "loopback-http-פין (החותם-ההיסטורי של-hive-rail עזב — Roast-73; הפין-נשאר-כלל-גדר)" },
    { endpoint: "http://127.0.0.1:3033/anything", expect: "allow", why: "loopback-http-פין-מכסה-כל-פורט (רגרסיית-H1: לפני-התיקון נזרק-תמיד)" },
    { endpoint: "http://localhost:3004/anything", expect: "allow", why: "loopback-http-פין — localhost-כולל-פורט" },
    // relay.ts — גרפני + TRON
    { endpoint: "https://api.steemit.com", expect: "allow", why: "relay.STEEM_NODES[0] · onramp.STEEM_NODE · bridge.steem" },
    { endpoint: "https://api.justyy.com", expect: "allow", why: "relay.STEEM_NODES[1] · realmarket" },
    { endpoint: "https://steem-rpc.publicnode.com", expect: "allow", why: "realmarket.STEEM_NODES[2]" },
    { endpoint: "https://api.hive.blog", expect: "allow", why: "relay.HIVE_NODES[0] · fleet · onramp · bridge.hive · hive-rail.rpcNode" },
    { endpoint: "https://api.deathwing.me", expect: "allow", why: "relay.HIVE_NODES[1] · fleet" },
    { endpoint: "https://api.hive-engine.com/rpc/contracts", expect: "allow", why: "hive-rail.engine · onramp.HE_NODE" },
    { endpoint: "https://api.trongrid.io/v1/accounts/HEAD?visible=true", expect: "allow", why: "relay.tronSealBroadcast (GET יתרה) · bridge.tron" },
    { endpoint: "https://api.trongrid.io/wallet/broadcasttransaction", expect: "allow", why: "relay.tron broadcast" },
    // relay-eth / relay-sol / bridge (EVM)
    { endpoint: "https://ethereum-rpc.publicnode.com", expect: "allow", why: "relay-eth.ETH_RPCS · bridge.eth" },
    { endpoint: "https://eth.llamarpc.com", expect: "allow", why: "relay-eth.ETH_RPCS · bridge" },
    { endpoint: "https://bsc-rpc.publicnode.com", expect: "allow", why: "bridge.bsc (אימות-הוכחות-חוץ)" },
    { endpoint: "https://api.mainnet-beta.solana.com", expect: "allow", why: "relay-sol.SOL_RPCS · bridge.sol" },
    // price-proof פידים + BLURT
    { endpoint: "https://api.coingecko.com/api/v3/simple/price?ids=steem&vs_currencies=usd", expect: "allow", why: "price-proof.coingecko" },
    { endpoint: "https://api.coinpaprika.com/v1/tickers?quotes=USD", expect: "allow", why: "price-proof.coinpaprika" },
    { endpoint: "https://min-api.cryptocompare.com/data/pricemulti", expect: "allow", why: "price-proof.cryptocompare" },
    { endpoint: "https://api.binance.com/api/v3/ticker/price", expect: "allow", why: "price-proof.binance" },
    { endpoint: "https://blurt-rpc.saboin.com", expect: "allow", why: "price-proof.BLURT_NODE (ראש-BLURT)" },
    // אכיפת-scheme/פין (M8+H1) — נדחים חייבים-להידחות בפועל
    { endpoint: "http://api.steemit.com", expect: "reject", why: "M8: http-downgrade למארח-מקובע מחוץ-ללופבק" },
    { endpoint: "http://api.justyy.com", expect: "reject", why: "M8: http-downgrade (pinned-https-host)" },
    { endpoint: "ws://api.hive.blog", expect: "reject", why: "M8: ws אסור" },
    { endpoint: "wss://api.hive.blog", expect: "reject", why: "M8: wss אינו https — נדחה" },
    { endpoint: "https://evil.example.net", expect: "reject", why: "H1: שער-לא-מקובע" },
    { endpoint: "https://api.steemit.com.evil.io", expect: "reject", why: "H1: ספופינג-סיומת — אינו-מארח-מקובע" },
    { endpoint: "not-a-url", expect: "reject", why: "endpoint-פסול" },
  ];
  // פיני-סביבה (תצורת-מפעיל) — אם-מוגדרים, הם-קוראים-לגיטימיים וחייבים-לעבור
  for (const name of ["ETH_RPC_URL", "SOL_RPC_URL"]) {
    const v = (process.env[name] || "").trim();
    if (v) cases.push({ endpoint: v, expect: "allow", why: `pin-סביבה ${name}` });
  }
  return cases;
}

export interface FenceSelftestResult { ok: boolean; ran: number; failures: string[] }

/** בדיקת-ריצה: כל-קריאה-מאושרת אכן עוברת את הגדר וכל-קריאה-אסורה אכן נזרקת.
 * `extra` — קוראים-חיים-נוספים (למשל signerEndpointUrl() מ-hive-rail עם-עקיפת-סביבה). */
export function fenceSelftest(extra: FenceCase[] = []): FenceSelftestResult {
  const failures: string[] = [];
  let ran = 0;
  for (const c of [...fenceCallerCases(), ...extra]) {
    ran += 1;
    let threw: unknown = undefined;
    try { assertAllowedHost(c.endpoint, "fenceSelftest"); } catch (e) { threw = e; }
    if (c.expect === "allow" && threw) {
      failures.push(`ALLOW-FAILED ${c.endpoint.slice(0, 90)} — ${String((threw as Error)?.message ?? threw).slice(0, 140)}`);
    } else if (c.expect === "reject" && !threw) {
      failures.push(`REJECT-FAILED ${c.endpoint.slice(0, 90)} — עבר-את-הגדר בניגוד-למדיניות (${c.why})`);
    }
  }
  return { ok: failures.length === 0, ran, failures };
}

/* ── FIX(Roast-65-b · L8): עמדת-אבטחה נגזרת-מהמצב-בפועל — אין-עוד-מספרים-קפואים ── */

/** נגזרת-חיה: ספירת-ראוטי-מוטציה המגודרים operatorAuth — סריקת-קבצי-route ב-boot.
 * אם-המקור-אינו-זמין (בנדל בלי-src) → נופל-למספר-המאומת-האחרון **עם-תאריך-הגזירה**
 * (ולא מציג-אותו-כאילו-נגזר-עכשיו). */
const GATED_ROUTES_STATIC_FALLBACK = 27; // גזירה 2026-09-11 (Roast-65-e3): rg -l "operatorAuth(" src/app/api | wc -l
function gatedRouteCount(): { count: number; source: string } {
  try {
    const root = path.join(process.cwd(), "src", "app", "api");
    let n = 0;
    const walk = (dir: string): void => {
      let entries: string[] = [];
      try { entries = readdirSync(dir) as string[]; } catch { return; }
      for (const name of entries) {
        const p = path.join(dir, name);
        let isDir = false;
        try { isDir = statSync(p).isDirectory(); } catch { continue; }
        if (isDir) walk(p);
        else if (name === "route.ts" || name === "route.tsx") {
          try {
            if (/operatorAuth\s*\(/.test(readFileSync(p, "utf8"))) n += 1;
          } catch { /* קובץ-לא-קריא — לא נספר */ }
        }
      }
    };
    walk(root);
    if (n > 0) return { count: n, source: "fs-scan src/app/api (operatorAuth-gated route files, live)" };
    return { count: GATED_ROUTES_STATIC_FALLBACK, source: `static-dated 2026-09-11 (fs-scan unavailable/empty — Roast-65-e3 derivation comment)` };
  } catch {
    return { count: GATED_ROUTES_STATIC_FALLBACK, source: "static-dated 2026-09-11 (fs-scan failed — Roast-65-e3 derivation comment)" };
  }
}

/** נגזרת-חיה: .gitignore אכן מכסה .env (כולל-בדיקת-negation-ישיר). */
function envGitignoredState(): { ok: boolean; source: string } {
  try {
    const gi = readFileSync(path.join(process.cwd(), ".gitignore"), "utf8");
    const rules = gi.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
    const ignoresEnv = rules.some((r) => r === ".env" || r === ".env.*" || r === "**/.env" || r === "*.env");
    const unignoresEnv = rules.some((r) => r === "!.env" || r === "!/.env");
    if (ignoresEnv && !unignoresEnv) return { ok: true, source: "fs-scan .gitignore (rule covers .env, no negation)" };
    if (unignoresEnv) return { ok: false, source: "fs-scan .gitignore — negation !.env found (fail-closed)" };
    return { ok: false, source: "fs-scan .gitignore — no rule covering .env (fail-closed)" };
  } catch {
    return { ok: false, source: "unverified — .gitignore unreadable in this runtime (fail-closed)" };
  }
}

/* עמדת-אבטחה מוצהרת (נחשפת ב-/api/dex/security — אפס סודות, בוליאנים בלבד) */
export function fencePosture() {
  const gated = gatedRouteCount();
  const envGi = envGitignoredState();
  const selftest = fenceSelftest();
  return {
    fence: "saos-dex/fence/1.1.0+roast65e3",
    policy: "fail-closed — כל-שער-יוצא חייב-להיות מקובע; שער-לא-מוכר = סירוב מיידי · https-חובה-מחוץ-ללופבק · redirect:error",
    pinnedHosts: pinnedHosts(),
    codePolicy: "no-foreign-code — אפס eval/new-Function/ייבוא-מרחוק (נסרק: scripts/fence-check.ts)",
    verification: "verifyOnChain — כל-עיגון נקרא-חזרה מ-RPC ציבורי בלתי-תלוי (ביט-מול-ביט)",
    selftest: { ok: selftest.ok, ran: selftest.ran, failures: selftest.failures.slice(0, 5) },
    gates: {
      operator: {
        configured: !!(process.env.DEX_OPERATOR_TOKEN || "").trim(),
        header: "x-saos-operator",
        behavior: "fail-closed — בלי טוקן: 503 על כל מוטציה",
      },
      consoleGuard: true,
      mutatingRoutesGated: gated.count,
      mutatingRoutesGatedSource: gated.source, // FIX(Roast-65-b · L8): נגזרת-מוצהרת — לא-מספר-קפוא
      bindHost: "127.0.0.1",
    },
    secrets: {
      envGitignored: envGi.ok,
      envGitignoredSource: envGi.source, // FIX(Roast-65-b · L8): נגזרת-מה-fs-בפועל
      vaultOutsideRepo: true,
      logsPolicy: "אפס סודות בלוגים/פלט/קבצים",
      secretScanBeforePush: true,
    },
  };
}
