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
 */

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
  /* TRON */
  "api.trongrid.io",
  /* ETH — ברירות-מחדל של ETH_RPCS */
  "ethereum-rpc.publicnode.com", "eth.llamarpc.com",
  /* SOL — ברירת-מחדל של SOL_RPCS (mainnet-beta) */
  "api.mainnet-beta.solana.com",
  /* מקומי (דמון/בדיקות) */
  "127.0.0.1", "localhost",
]);

export function hostOf(endpoint: string): string {
  try { return new URL(endpoint).host; } catch { return ""; }
}

export function hostAllowed(endpoint: string): boolean {
  return PINNED_HOSTS.has(hostOf(endpoint));
}

/** שער-לא-מקובע = זריקה (fail-closed). נקרא לפני כל-fetch יוצא של ה-Relay. */
export function assertAllowedHost(endpoint: string, where: string): void {
  if (!hostAllowed(endpoint)) {
    throw new Error(`fence: host "${hostOf(endpoint)}" אינו מקובע — נחסם fail-closed @ ${where}`);
  }
}

export function pinnedHosts(): string[] {
  return [...PINNED_HOSTS].sort();
}

/* עמדת-אבטחה מוצהרת (נחשפת ב-/api/dex/security — אפס סודות, בוליאנים בלבד) */
export function fencePosture() {
  return {
    fence: "saos-dex/fence/1.0.0+settle11",
    policy: "fail-closed — כל-שער-יוצא חייב-להיות מקובע; שער-לא-מוכר = סירוב מיידי",
    pinnedHosts: pinnedHosts(),
    codePolicy: "no-foreign-code — אפס eval/new-Function/ייבוא-מרחוק (נסרק: scripts/fence-check.ts)",
    verification: "verifyOnChain — כל-עיגון נקרא-חזרה מ-RPC ציבורי בלתי-תלוי (ביט-מול-ביט)",
    gates: {
      operator: {
        configured: !!(process.env.DEX_OPERATOR_TOKEN || "").trim(),
        header: "x-saos-operator",
        behavior: "fail-closed — בלי טוקן: 503 על כל מוטציה",
      },
      consoleGuard: true,
      mutatingRoutesGated: 9,
      bindHost: "127.0.0.1",
    },
    secrets: {
      envGitignored: true,
      vaultOutsideRepo: true,
      logsPolicy: "אפס סודות בלוגים/פלט/קבצים",
      secretScanBeforePush: true,
    },
  };
}
