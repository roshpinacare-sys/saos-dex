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
import { getPool, poolMid } from "./amm";
import { ASSETS } from "./kernel";

const ANCHORS_FILE = path.join(process.cwd(), "state", "anchors.json");

/** מחיר-נכס ב-µ-USDS ל-1-יחידה-בסיס: בריכה-ישירה ל-USDS → דרך-SAOS → refPrice. */
export function usdsPriceOf(asset: string): number {
  const st = getLiveState();
  if (asset === "USDS") return 1000;
  const direct = getPool(st, [asset, "USDS"].sort().join("/"));
  if (direct) return poolMid(direct);
  const viaSaos = getPool(st, [asset, "SAOS"].sort().join("/"));
  const saosUsds = getPool(st, ["SAOS", "USDS"].sort().join("/"));
  if (viaSaos && saosUsds) {
    const p = poolMid(viaSaos) * poolMid(saosUsds);
    if (p > 0) return Math.floor(p / 1000); // µ-SAOS/יחידה × µ-USDS/SAOS-µ → µ-USDS/יחידה
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
  lines: { asset: string; amountMu: number; price: number; valueUsdsMu: number }[];
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

function bookOf(name: string, role: string, accounts: string[]): PortfolioBook {
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
    lines.push({ asset: a, amountMu: mu, price, valueUsdsMu: v });
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
  const books: PortfolioBook[] = [
    bookOf("core", "עתודת-הליבה: treasury+operator+arena", ["treasury", "operator", "arena"]),
    bookOf("portfolio-b", "התיקייה-השנייה (SETTLE-12, הופעלה בהעברה-חופשית)", ["portfolio-b"]),
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
