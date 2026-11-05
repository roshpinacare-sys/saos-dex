/**
 * sovereign-quote.ts — מסילת-הציטוט הילידת-השרשרת (W-FRELEASE · 2026-11-05)
 * ═══════════════════════════════════════════════════════════════════════════
 * הבעלים (trace 1a1ab989d8db0a91): "Fixedfloat בנתיים לא עובד בוא נשחרר את זה
 * ונמצא דרכים שאתה יכול ליישם דרך הבלוקצ'יין שלנו לשם זה במקום".
 *
 * התשובה המדידה: הציטוט עובר לשרשרת שלנו —
 *   · STEEM↔SBD — ספר-השוק-הפנימי הציבורי (condenser_api.get_order_book),
 *     אותו-ספר ש-realmarket.ts סוחר-עליו ב-limit_order_create.
 *   · SBD→USD — נכס-העוגן של השרשרת עצמה (ה-SBD הוא הדולר-הקנוני שלנו —
 *     rate 1.0 מוצהר בכנות כהגדרת-פרוטוקול, לא כתחזית).
 *   · STEEM→USD — חוצה-דרך החציון-של-העדים (get_current_median_history_price)
 *     — עוגן-הקונצנזוס של השרשרת, ללא-כל-שירות-חוץ.
 *
 * קריאה-בלבד · אפס-מפתחות · אפס-שירות-חוץ · דרך-הגדר (fencedFetch) ·
 * כישלון = 503 כן, אין-המצאה, אין-מטמון-מזויף.
 */

import { fencedFetch } from "./fence";

const STEEM_NODES = ["https://api.steemit.com", "https://api.justyy.com"];

export type SovereignQuote = {
  provider: "steem-chain";
  rail: "sovereign";
  from: string;
  to: string;
  rate: number; // כמה `to` עבור 1 `from`
  book?: { bid: number; ask: number; mid: number; source: "internal-market" };
  median?: { sbdPerSteem: number; source: "witness-median" };
  notes: string[];
  fetchedAt: string;
};

async function steemRpc(method: string, params: unknown[]): Promise<unknown> {
  let lastErr = "";
  for (const node of STEEM_NODES) {
    try {
      const res = await fencedFetch(
        node,
        `sovereign-quote:${method}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
          signal: AbortSignal.timeout(15000),
        } as RequestInit
      );
      if (!res.ok) { lastErr = `HTTP ${res.status} @ ${node}`; continue; }
      const j = (await res.json()) as { error?: { message?: string }; result?: unknown };
      if (j.error) { lastErr = String(j.error.message ?? "rpc-error").slice(0, 120); continue; }
      return j.result;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(`sovereign-quote: chain RPC failed — ${lastErr}`);
}

function amt(s: unknown): number {
  const m = String(s ?? "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}

/** ספר-השוק-הפנימי: best bid/ask + mid — המחיר-החי של השרשרת שלנו. */
export async function steemSbdBook(): Promise<{ bid: number; ask: number; mid: number }> {
  const book = (await steemRpc("condenser_api.get_order_book", [1])) as {
    bids?: { real_price?: string }[];
    asks?: { real_price?: string }[];
  };
  const bid = amt(book?.bids?.[0]?.real_price); // קוני-STEEM משלמים SBD ל-STEEM
  const ask = amt(book?.asks?.[0]?.real_price); // מוכרי-STEEM דורשים SBD ל-STEEM
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) {
    throw new Error("sovereign-quote: internal-market book empty/unparseable (honest)");
  }
  return { bid, ask, mid: (bid + ask) / 2 };
}

/** עוגן-החציון של העדים — מחיר-ה-SBD:STEEM שהשרשרת עצמה מכריזה. */
export async function witnessMedian(): Promise<number> {
  const med = (await steemRpc("condenser_api.get_current_median_history_price", [])) as {
    base?: string; quote?: string;
  };
  const sbdPerSteem = amt(med?.base) / amt(med?.quote);
  if (!Number.isFinite(sbdPerSteem) || sbdPerSteem <= 0) {
    throw new Error("sovereign-quote: witness median unparseable (honest)");
  }
  return sbdPerSteem;
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * ציטוט-יליד-שרשרת לזוג נתמך. זוגות: steem/sbd · sbd/steem ·
 * steem/usd · usd/steem · sbd/usd · usd/sbd (usd = נכס-העוגן SBD).
 * מחזיר null כשהזוג לא-על-השרשרת — כנות, לא-המצאה.
 */
export async function sovereignQuote(from: string, to: string, amount = 1): Promise<SovereignQuote | null> {
  const f = norm(from);
  const t = norm(to);
  const is = (x: string, ...names: string[]) => names.includes(x);
  const notes: string[] = [];
  const fetchedAt = new Date().toISOString();

  const steemSbd = is(f, "steem") && is(t, "sbd");
  const sbdSteem = is(f, "sbd") && is(t, "steem");
  const steemUsd = is(f, "steem") && is(t, "usd");
  const usdSteem = is(f, "usd") && is(t, "steem");
  const sbdUsd = is(f, "sbd") && is(t, "usd");
  const usdSbd = is(f, "usd") && is(t, "sbd");
  if (!steemSbd && !sbdSteem && !steemUsd && !usdSteem && !sbdUsd && !usdSbd) return null;

  if (steemSbd || sbdSteem) {
    const book = await steemSbdBook();
    notes.push("ספר-השוק-הפנימי של השרשרת (condenser_api.get_order_book) — המסילה שהמייקר שלנו סוחר-עליה");
    return {
      provider: "steem-chain", rail: "sovereign", from: f, to: t,
      rate: steemSbd ? book.mid : 1 / book.mid,
      book: { ...book, source: "internal-market" },
      notes, fetchedAt,
    };
  }
  if (sbdUsd || usdSbd) {
    notes.push("SBD = נכס-העוגן-הדולרי של השרשרת — rate 1.0 היא הגדרת-פרוטוקול, מוצהרת בכנות");
    return {
      provider: "steem-chain", rail: "sovereign", from: f, to: t,
      rate: sbdUsd ? 1 : 1,
      notes, fetchedAt,
    };
  }
  // steem/usd · usd/steem — חוצה-דרך חציון-העדים (עוגן-הקונצנזוס של השרשרת)
  const sbdPerSteem = await witnessMedian();
  notes.push("חציון-העדים (get_current_median_history_price) — עוגן-הקונצנזוס של השרשרת עצמה, ללא-שירות-חוץ");
  return {
    provider: "steem-chain", rail: "sovereign", from: f, to: t,
    rate: steemUsd ? sbdPerSteem : 1 / sbdPerSteem,
    median: { sbdPerSteem, source: "witness-median" },
    notes, fetchedAt,
  };
}

/** רשימת-הזוגות-הנתמכים — לתשובות-503 כנות. */
export const SOVEREIGN_PAIRS = ["steem/sbd", "sbd/steem", "steem/usd", "usd/steem", "sbd/usd", "usd/sbd"];
