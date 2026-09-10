/**
 * hive-rail — Task 27 (owner directive: "use the DEX to convert, obtain HIVE").
 * =============================================================================
 * The REAL-asset conversion rail of the DEX (as opposed to the simulation
 * arena): token → SWAP.HIVE (Hive-Engine market sell) → liquid HIVE
 * (hivepegged withdraw) → HP (transfer_to_vesting).
 *
 * Execution ALWAYS goes through the external signer (http://127.0.0.1:3004 — see
 * below) — the dex process holds NO keys (golden architecture, docs/external-signer.md). The signer
 * enforces:
 *   - authority-verification gate (derive WIF → compare LIVE chain authority,
 *     mismatch ⇒ 403, nothing broadcast);
 *   - op allowlist + amount bounds.
 * This module only prepares PUBLIC payloads and proxies the /sign call.
 *
 * Fail-closed: no SAOS_EXTERNAL_SIGNER_TOKEN ⇒ every mutation refuses (503).
 * Zero secrets in logs/responses — only account names, symbols, txids.
 */

// FIX(Roast-65-b · H1): ברירת-המחדל 3033 הייתה-הזיה — אין-מאזין-על-3033 (Roast-65-b מדיד).
// הפורט-האמתי: ADMIN_PORT=3004 של mini-services/relay-service/index.ts (העתק-קנוני
// מוצהר; נמדד-חי — 127.0.0.1:3004 מאזין). SAOS_EXTERNAL_SIGNER_URL עוקף לחותם-ייעודי.
const SIGNER_URL = (process.env.SAOS_EXTERNAL_SIGNER_URL ?? "http://127.0.0.1:3004").replace(/\/$/, "");
// FIX(Roast-63): כל-שער-יוצא-כאן-עובר-דרך-הגדר (היה-עוקף assertAllowedHost)
import { fencedFetch } from "./dex/fence"; // FIX(Roast-65-b · H2): fencedFetch — גדר + redirect:error מאוכפים-מרכזית
const SIGNER_TOKEN = (process.env.SAOS_EXTERNAL_SIGNER_TOKEN ?? "").trim();

export type RailAction = "sell" | "withdraw" | "powerup" | "transfer";

export interface RailRequest {
  account: string;
  action: RailAction;
  symbol?: string;    // sell
  quantity?: number;  // sell
  price?: number;     // sell (limit price; must match the live bid for instant fill)
  amount?: number;    // powerup/transfer (HIVE)
  to?: string;        // transfer
}

export function railConfigured(): boolean {
  return Boolean(SIGNER_TOKEN);
}

/** FIX(Roast-65-b · H1): נקודת-הקצה-החיתומית-החיה — מיוצאת ל-fence-check/fenceSelftest
 * (מוצלב-מול-מניפסט-הקוראים-שב-fence.ts כדי-שהפין-והקוד-לא-יסטו-זה-מזה-בשקט). */
export function signerEndpointUrl(): string {
  return `${SIGNER_URL}/sign`;
}

function signerHeaders() {
  return { authorization: `Bearer ${SIGNER_TOKEN}`, "content-type": "application/json" };
}

/** POST to the signer /sign; returns only public data (txid / error text) */
export async function railExecute(req: RailRequest): Promise<{ ok: boolean; txid?: string; account?: string; error?: string; refused?: string }> {
  if (!railConfigured()) return { ok: false, error: "rail-not-configured (SAOS_EXTERNAL_SIGNER_TOKEN missing) — fail-closed" };
  const requestId = `dex-27-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const body: Record<string, unknown> = { requestId, network: "HIVE", account: req.account };
  if (req.action === "sell") {
    body.kind = "he_market_sell";
    body.authLevel = "active";
    body.symbol = req.symbol;
    body.quantity = req.quantity;
    body.price = req.price;
  } else if (req.action === "withdraw") {
    body.kind = "he_withdraw";
    body.authLevel = "active";
  } else if (req.action === "powerup") {
    body.kind = "transfer_to_vesting";
    body.authLevel = "active";
    body.amount = req.amount;
    body.to = req.to ?? req.account;
  } else {
    body.kind = "transfer";
    body.authLevel = "active";
    body.amount = req.amount;
    body.to = req.to;
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30_000);
  try {
    const res = await fencedFetch(signerEndpointUrl(), "hive-rail.signer", { method: "POST", headers: signerHeaders(), body: JSON.stringify(body), signal: ctl.signal });
    const json = (await res.json()) as { ok: boolean; txid?: string; account?: string; error?: string; refused?: string };
    return json;
  } catch (e) {
    return { ok: false, error: `signer-unreachable (${String((e as Error)?.message ?? e).slice(0, 100)}) — fail-closed` };
  } finally {
    clearTimeout(t);
  }
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
