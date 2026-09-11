/**
 * hive-rail — Task 27 (owner directive: "use the DEX to convert, obtain HIVE").
 * Roast-73 — REBUILD: מבצע-המסילה חזר-לחיים בתוך-הדמון.
 * =============================================================================
 * The REAL-asset conversion rail of the DEX (as opposed to the simulation
 * arena): token → SWAP.HIVE (Hive-Engine market sell) → liquid HIVE
 * (hivepegged withdraw) → HP (transfer_to_vesting).
 *
 * היסטוריה-כנה: הביצוע-ההיסטורי עבר-דרך "חותם-חוץ" (127.0.0.1:3004/sign) —
 * החותם הזה **אינו-קיים עוד** באף-קוד (relay-service נכתב-מחדש ב-roast-66) וכל
 * קריאה-הייתה-תלות-פנטום שנכשלת fail-closed ("rail-not-configured"). מאז
 * Roast-73 הביצוע נעשה-דרך rail-exec.ts — המבצע-הריבוני-בדמון — עם אותן
 * ערבויות: אימות-סמכות-חי מול-השרשרת (WIF→pub), רשימת-ops-מותרים, תחומי-כמות
 * מהיתרות-החיות, שער-RC, ושער-מפעיל בשכבת-ה-API. אפס-סודות בלוגים/תשובות —
 * רק שמות-חשבון, סימבולים, txid.
 */

// FIX(Roast-65-b · H1): ברירת-המחדל 3033 הייתה-הזיה — אין-מאזין-על-3033 (Roast-65-b מדיד).
// FIX(Roast-65-b · H2)+Roast-73: כל-שער-יוצא עובר-דרך-הגדר; הביצוע-עצמו עבר ל-rail-exec.
import { fencedFetch } from "./dex/fence";
import { railExecConfigured, railExecute as execRail, railAccount, type RailRequest, type RailAction } from "./dex/rail-exec";

export type { RailRequest, RailAction };

/** Roast-73: המסילה "מוגדרת" כשהזהות-הריבונית קיימת-בסביבת-הדמון
 * (HIVE_ANCHOR_ACCOUNT + HIVE_ACTIVE_WIF) — לא תלויה-עוד בחותם-חוץ פנטומי. */
export function railConfigured(): boolean {
  return railExecConfigured();
}

/** POST למבצע-הריבוני; מחזיר רק נתונים-ציבוריים (txid / שגיאה מוסברת) */
export async function railExecute(req: RailRequest): Promise<{ ok: boolean; txid?: string; account?: string; error?: string; refused?: string }> {
  const sovereign = railAccount().account;
  if ((req.account || "").toLowerCase() !== (sovereign ?? "")) {
    return {
      ok: false,
      error: `rail-account-mismatch (המסילה מבצעת רק מהזהות-הריבונית שבסביבה — בקשה עבור "${req.account}")`,
      refused: "authority-gate",
    };
  }
  return execRail(req);
}

// ── public read helpers (no keys, no auth — chain data only) ─────────────────
export interface AccountPreview {
  account: string;
  hive: { liquid: number; vests: number; hbd: number; rcPct: number };
  engine: { symbol: string; balance: number }[];
  suggested: RailRequest[];
}

async function rpcNode<T>(node: string, method: string, params: unknown): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12_000);
  try {
    const res = await fencedFetch(node, "hive-rail.rpcNode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
      signal: ctl.signal
    });
    const json = (await res.json()) as { result?: T; error?: { message?: string } };
    if (json.error) throw new Error(json.error.message ?? "rpc error");
    return json.result as T;
  } finally {
    clearTimeout(t);
  }
}

export async function accountPreview(account: string): Promise<AccountPreview | null> {
  const acct = account.toLowerCase();
  type Acc = { balance: string; hbd_balance: string; vesting_shares: string };
  const accs = await rpcNode<Acc[]>("https://api.hive.blog", "condenser_api.get_accounts", [[acct]]);
  const a = accs?.[0];
  if (!a) return null;
  type Rc = { rc_manabar: { current_mana: number }; max_rc: string | number };
  const rc = await rpcNode<{ rc_accounts: Rc[] }>("https://api.hive.blog", "rc_api.find_rc_accounts", { accounts: [acct] });
  const maxRc = Number(rc.rc_accounts[0].max_rc) || 0;
  const rcPct = maxRc ? (100 * rc.rc_accounts[0].rc_manabar.current_mana) / maxRc : 0;
  type Bal = { symbol: string; balance: string };
  const balances = await rpcNode<Bal[]>("https://api.hive-engine.com/rpc/contracts", "find", { contract: "tokens", table: "balances", query: { account: acct }, limit: 1000 });
  const engine = (balances ?? []).filter((b) => Number(b.balance) > 0.0001).map((b) => ({ symbol: b.symbol, balance: Number(b.balance) }));

  const liquid = Number(a.balance.split(" ")[0]);
  const suggested: RailRequest[] = [];
  const swapHive = engine.find((e) => e.symbol === "SWAP.HIVE")?.balance ?? 0;
  const sellable = engine.filter((e) => e.symbol !== "SWAP.HIVE" && e.balance >= 0.5);
  for (const s of sellable) suggested.push({ account: acct, action: "sell", symbol: s.symbol, quantity: s.balance, price: 0 });
  if (swapHive >= 0.001) suggested.push({ account: acct, action: "withdraw" });
  if (liquid >= 0.001) suggested.push({ account: acct, action: "powerup", amount: Math.floor(liquid * 1000) / 1000 });

  return {
    account: acct,
    hive: { liquid, vests: Number(a.vesting_shares.split(" ")[0]), hbd: Number(a.hbd_balance.split(" ")[0]), rcPct },
    engine,
    suggested
  };
}
