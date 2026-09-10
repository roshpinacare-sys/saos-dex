/**
 * portfolio.ts — תיקיית-המטבעות הריבונית (SETTLE-12).
 *
 * מה שהמפעיל ביקש: "רשאי להשתמש במפתחות כדי ליישם מתיקיה אחרת — בזהירות".
 * התרגום-הכנה: שני ספרים על הרשת-שלנו (אפס-תלות בגורם-חוץ):
 *  · BOOK A "core" — עתודת-הליבה (treasury + operator + arena בצבירה).
 *  · BOOK B "portfolio-b" — התיקייה-השנייה: חשבון-עצמאי שהופעל-בהעברה-חופשית
 *    (xfer_free — אפס-גז) מהמפעיל, והוא רשום-בפנקס-הרישום-הציבורי שלנו
 *    (state/anchors.json) כצד-הזיהוי של-התיקייה-השנייה.
 * הערכת-שווי: מחירי-בריכות-חיים (poolMid) → USDS; מסלול דרך-SAOS כשאין-בריכה-
 * ישירה; refPrice כרצפת-מחיר-כנה. אין-float במצב — כל-השוויים במספרים-שלמים-µ.
 *
 * "בזהירות": המודול קורא-רק. אפס-מפתח, אפס-חתימה, אפס-יצירת-כתובות-חוץ-כאן —
 * זהויות-החוץ (TRON/ETH/SOL/BTC) מוצגות-כנה מתוך anchors.json בלבד עם סטטוס
 * "balance-unknown-until-funded". הערכת-שווי של-מה-שלא-נמדד — לא-נטענת.
 */
import fs from "fs";
import path from "path";
import { getLiveState, getPools } from "./chain";
import { getPool, poolMidFor } from "./amm";
import { ASSETS } from "./kernel";
import { routableMap, type RouteTier, LP_PREFIX } from "./router";

const ANCHORS_FILE = path.join(process.cwd(), "state", "anchors.json");

/** FIX(SETTLE-15 price-truth-2): טוקן-LP אינו "מטבע-לא-שווה" — הוא חלק-יחסי
 * מהרזרבות. המפעיל-ראה "צמודים-מוזרים-חסרי-שווי" בתיקייה-השנייה (LP|SAOS/USDS
 * וכד') במחיר-0 שקרי. עכשיו: תמחור-אמת — חלק-יחסי מ-Σ(רזרבה×מחיר-נזיל).
 * מחיר-מוחזר: µ-USDS ל-1µ-LP (×1000 — עקבי-עם-הקונבנציה של valueUsdsMu). */
function lpPriceUsdsMu(lpAsset: string): number {
  const key = lpAsset.slice(3); // "LP|"
  const st = getLiveState();
  const p = getPool(st, key);
  if (!p || p.lp <= 0) return 0;
  const pa = usdsPriceOf(p.a);
  const pb = usdsPriceOf(p.b);
  const total = Math.floor((p.ra * pa) / 1000) + Math.floor((p.rb * pb) / 1000);
  return Math.floor((total * 1000) / p.lp);
}

/** מחיר-נכס ב-µ-USDS ל-1-יחידה-בסיס: בריכה-ישירה ל-USDS → דרך-SAOS → refPrice. */
export function usdsPriceOf(asset: string): number {
  const st = getLiveState();
  if (asset === "USDS") return 1000;
  if (asset.startsWith("LP|")) return lpPriceUsdsMu(asset);
  const direct = getPool(st, [asset, "USDS"].sort().join("/"));
  // FIX(Roast-64 · inverted-portfolio-price): poolMid הגולמי מניח p.a=base — ב-USDS/WSTEEM
  // הערך-היה יחס-הפוך (~1/6M מהאמת). אוריינטציה-מובטחת דרך poolMidFor.
  if (direct) return poolMidFor(direct, asset, "USDS");
  const viaSaos = getPool(st, [asset, "SAOS"].sort().join("/"));
  const saosUsds = getPool(st, ["SAOS", "USDS"].sort().join("/"));
  if (viaSaos && saosUsds) {
    const p = poolMidFor(viaSaos, asset, "SAOS") * poolMidFor(saosUsds, "SAOS", "USDS");
    if (p > 0) return Math.floor(p / 1000); // µ-SAOS/יחידה × µ-USDS/µ-SAOS → µ-USDS/יחידה (×1000)
  }
  return st.assets[asset]?.refPrice ?? 0;
}

/** שווי-ב-µ-USDS של amountMu מנכס (price = µ-USDS ליחידה; amount = µ-בסיס). */
export const valueUsdsMu = (price: number, amountMu: number): number =>
  price > 0 && amountMu > 0 ? Math.floor((price * amountMu) / 1000) : 0;

export interface PortfolioBook {
  name: string; role: string;
  balances: Record<string, number>; // µ
  credits: number;
  valueUsdsMu: number;
  lines: { asset: string; amountMu: number; price: number; valueUsdsMu: number; tier: RouteTier | "lp"; tierNote: string }[];
}

export interface ExternalIdentity {
  chain: string; address: string; status: string;
  note: string; // כנות: מה-מדוד-ומה-לא
}

export interface PortfolioView {
  generatedAt: number;
  prices: Record<string, number>; // µ-USDS ליחידה — כל-הנכסים-הרשומים
  books: PortfolioBook[];
  totalUsdsMu: number;
  external: ExternalIdentity[];
  honesty: string;
}

function bookOf(name: string, role: string, accounts: string[], tiers: Map<string, { tier: RouteTier; routeDesc: string }>): PortfolioBook {
  const st = getLiveState();
  const balances: Record<string, number> = {};
  let credits = 0;
  let totalUsds = 0;
  const lines: PortfolioBook["lines"] = [];
  for (const who of accounts) {
    credits += st.credits[who] ?? 0;
    const w = st.balances[who] ?? {};
    for (const [a, mu] of Object.entries(w)) {
      if (!(mu > 0)) continue;
      balances[a] = (balances[a] ?? 0) + mu;
    }
  }
  for (const [a, mu] of Object.entries(balances)) {
    const price = usdsPriceOf(a);
    const v = valueUsdsMu(price, mu);
    totalUsds += v;
    // SETTLE-15: טירון-נזילות כנה לכל-שורה — המפעיל-רואה מה-ראוטר-ביל ומה-לא
    let tier: RouteTier | "lp" = "none";
    let tierNote = "אין-מסלול-מבצע — רצפת-refPrice בלבד";
    if (a.startsWith(LP_PREFIX)) {
      tier = "lp";
      tierNote = "טוקן-LP — חלק-יחסי מרזרבות-הבריכה; ניתן-לפדות ב-pool_rmw";
    } else {
      const t = tiers.get(a);
      if (t) { tier = t.tier; tierNote = t.routeDesc; }
    }
    lines.push({ asset: a, amountMu: mu, price, valueUsdsMu: v, tier, tierNote });
  }
  lines.sort((x, y) => y.valueUsdsMu - x.valueUsdsMu);
  return { name, role, balances, credits, valueUsdsMu: totalUsds, lines };
}

function externalIdentities(): ExternalIdentity[] {
  const out: ExternalIdentity[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(ANCHORS_FILE, "utf8")) as {
      account?: string; tronIdentity?: string;
      chains?: Record<string, { status?: string; account?: string | null; endpointHost?: string }>;
    };
    if (raw.account) out.push({ chain: "steem+hive", address: raw.account, status: "identity", note: "זהות-פרסום-ריבונית (עיגון custom_json) — הרשות-החתומה נשלפת מ-keyrelay, לא ממאגר-מקומי" });
    if (raw.tronIdentity) out.push({ chain: "tron", address: raw.tronIdentity, status: raw.chains?.tron?.status ?? "unknown", note: "זהות-TRON-נגזרת (SETTLE-10) — unfunded, יתרה-לא-מדודה עד-מימון" });
    for (const c of ["eth", "sol"] as const) {
      const ch = raw.chains?.[c];
      if (ch?.account) out.push({ chain: c, address: ch.account, status: ch.status ?? "unknown", note: "כתובת-עיגון-מה-fence — balance-unknown-until-funded" });
    }
  } catch { /* אין-פנקס — ריק כנה */ }
  return out;
}

export function getPortfolio(): PortfolioView {
  const prices: Record<string, number> = {};
  for (const a of ASSETS) prices[a] = usdsPriceOf(a);
  const tiers = new Map<string, { tier: RouteTier; routeDesc: string }>();
  for (const r of routableMap()) tiers.set(r.asset, { tier: r.tier, routeDesc: r.routeDesc });
  const books: PortfolioBook[] = [
    bookOf("core", "עתודת-הליבה: treasury+operator+arena", ["treasury", "operator", "arena"], tiers),
    // FIX(Roast-63 · M2): כנות — החשבון-reserved-אך-לא-קיים-במצב-החי (יתרות-אפס)
    bookOf("portfolio-b", "התיקייה-השנייה (SETTLE-12 — שמורה-למוסד; טרם-מומנת — יתרות-אפס)", ["portfolio-b"], tiers),
  ];
  const totalUsdsMu = books.reduce((s, b) => s + b.valueUsdsMu, 0);
  return {
    generatedAt: Date.now(),
    prices,
    books,
    totalUsdsMu,
    external: externalIdentities(),
    honesty: "שווי-מדוד-אך-על-ספר-סימולציה-סגור (SIM, REAL-money-audited) · זהויות-חוץ: אפס-יתרות-מדודות עד-מימון · אפס-מפתחות-במודול-זה",
  };
}
