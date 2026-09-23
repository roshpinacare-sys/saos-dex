/**
 * hivemarket.ts — רגל-HIVE של THE-REAL-GRID (R99)
 * ═════════════════════════════════════════════════════════════════════════════
 * המשך ישיר של realmarket.ts (הדפוס המוכח של Task 62/R24) על שוק-HIVE הפנימי:
 *   · ספר-ציבורי HIVE/HBD (limit_order_create) — סוחרים-אמיתיים, יישוב-על-השרשרת,
 *     אפס-עמלת-מסחר. אותה דוקטרינת-מייקר בדיוק: מעולם לא מוכרים מתחת לערך
 *     החיצוני; כל קנייה מתחת לקו-הזהות היא עודף מדוד.
 *   · המפתח: HIVE_ACTIVE_WIF (סוד-ריפו) — הוכנס לכספת ב-R99 לאחר אימות
 *     ביט-מול-ביט מול ה-active החי של @headcorner בשרשרת HIVE
 *     (המקור: כספת-הארנק הריבונית; ההעברה ב-sealed-box, אפס הדפסה).
 *   · חתימה מקומית: steem.auth.signTransaction עם chain_id של HIVE (beeab0de…)
 *     ושידור גולמי broadcast_transaction_synchronous — אותו נתיב שהצי הוכיח
 *     חי בעיגוני-HIVE (graphene.ts של הרשת, Tasks 44/79/82).
 *   · שער-RC של HIVE עם רגנרציה-מחושבת — הלקח המדוד (Task 29): ה-manabar
 *     השמור מתעדכן רק בטרנזאקציה של החשבון; קריאה קפואה בלי חישוב = קיפאון-עדן.
 *   · DIRECTIVE-R24 בתוקף גם כאן: לא נפתח powerdown, לא מוחלף, לא נוגעים.
 */
import steem from "steem";
import { extFeeds } from "./price-proof";
import { fencedFetch } from "./fence";

const HIVE_NODES = [
  "https://api.hive.blog",
  "https://api.deathwing.me",
];
const HIVE_CHAIN_ID =
  "beeab0de00000000000000000000000000000000000000000000000000000000";
const ACCOUNT = process.env.SAOS_RELAY_AGENT_ACCOUNT || "headcorner";

/** רצפת-RC לרגל-HIVE — כיסוי לימוד-העלות המדוד של הצי (custom_json ~273M בעומס;
 * limit_order זול מזה — הרצפה שמרנית בכוונה: דילוג-כנה, לא כשל). */
export const HIVE_RC_FLOOR = Number(process.env.HIVE_RC_FLOOR || 300e6);
/** רגנרציית-RC — 5 ימים בשתי השרשראות הגרפניות */
const RC_REGEN_SEC = 432_000;

interface GrapheneTx {
  ref_block_num: number;
  ref_block_prefix: number;
  expiration: string;
  operations: [string, Record<string, unknown>][];
  extensions: never[];
}

/* ── RPC (דרך הגדר — אותם צומתים שה-relay משתמש בהם) ─────────────────────── */

async function hiveRpc<T>(node: string, body: unknown, timeoutMs = 8_000): Promise<T> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fencedFetch(node, "hivemarket.rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
      cache: "no-store",
    });
    const j = await r.json();
    if (j?.error) throw new Error(j.error.message || "rpc-error");
    return j?.result as T;
  } finally {
    clearTimeout(t);
  }
}

async function hiveRpcAny<T>(method: string, params: unknown[]): Promise<T> {
  const errs: string[] = [];
  for (const node of HIVE_NODES) {
    try {
      return await hiveRpc<T>(node, { jsonrpc: "2.0", id: 1, method, params });
    } catch (e) {
      errs.push(`${new URL(node).host}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`all-hive-nodes-failed · ${errs.join(" | ")}`);
}

/* ── מפתח ושער-RC ────────────────────────────────────────────────────────── */

export function hiveActiveWif(): string | null {
  const w = process.env.HIVE_ACTIVE_WIF || "";
  return w.length >= 51 ? w : null;
}

/** שער ה-RC של HIVE — מנה-חיבה עם רגנרציה (דפוס Task 29: קריאה קפואה = קיפאון-עדן;
 * זמן-השרשרת הוא השופט, לא שעון מקומי). */
export async function hiveRcGate(
  floor: number = HIVE_RC_FLOOR
): Promise<{ ok: boolean; mana: number; max: number; reason?: string }> {
  type RcAccount = {
    max_rc: string | number;
    rc_manabar: { current_mana: string | number; last_update_time: number };
  };
  const [accounts, dgp] = await Promise.all([
    hiveRpcAny<RcAccount[]>("condenser_api.find_rc_accounts", [[ACCOUNT]]),
    hiveRpcAny<Record<string, unknown>>("condenser_api.get_dynamic_global_properties", []),
  ]);
  const a = accounts?.[0];
  if (!a) return { ok: false, mana: 0, max: 0, reason: "rc-account-not-found" };
  const max = Number(a.max_rc);
  const now = Math.floor(new Date(String(dgp.time) + "Z").getTime() / 1000);
  const lut = Number(a.rc_manabar.last_update_time);
  const mana = Math.min(
    max,
    Number(a.rc_manabar.current_mana) + Math.max(0, now - lut) * (max / RC_REGEN_SEC)
  );
  if (mana < floor) {
    return {
      ok: false, mana: Math.round(mana), max,
      reason: `rc-gated (mana=${Math.round(mana).toExponential(2)} < floor=${floor.toExponential(2)} — regen budget, honest skip)`,
    };
  }
  return { ok: true, mana: Math.round(mana), max };
}

/* ── חתימה-ושידור (הנתיב המוכח של הצי ל-HIVE) ───────────────────────────── */

export async function hiveSignAndBroadcast(
  ops: [string, Record<string, unknown>][]
): Promise<{ txid: string; block: number | null }> {
  const wif = hiveActiveWif();
  if (!wif) throw new Error("HIVE_ACTIVE_WIF missing — fail-closed (אין-חתימה, אין-שידור)");
  const dgp = await hiveRpcAny<Record<string, unknown>>("condenser_api.get_dynamic_global_properties", []);
  const headBlockNumber = Number(dgp.head_block_number);
  const headBlockId = String(dgp.head_block_id);
  const headTime = new Date(String(dgp.time) + "Z").getTime();
  const tx: GrapheneTx = {
    ref_block_num: headBlockNumber & 0xffff,
    ref_block_prefix: Buffer.from(headBlockId, "hex").readUInt32LE(4),
    expiration: new Date(headTime + 60_000).toISOString().slice(0, 19),
    operations: ops,
    extensions: [],
  };
  const prev = steem.config.get("chain_id");
  steem.config.set("chain_id", HIVE_CHAIN_ID);
  let signed: GrapheneTx & { signatures?: string[] };
  try {
    signed = steem.auth.signTransaction(tx, [wif]);
  } finally {
    try { steem.config.set("chain_id", prev ?? "0000000000000000000000000000000000000000000000000000000000000000"); } catch { /* keep */ }
  }
  const res = await hiveRpcAny<{ id?: string; block_num?: number }>(
    "condenser_api.broadcast_transaction_synchronous",
    [{ ...signed }],
  );
  if (!res?.id) throw new Error("hive broadcast answered without id (honest)");
  return { txid: res.id, block: res.block_num ?? null };
}

/* ── תמונת-מצב אמת ───────────────────────────────────────────────────────── */

export interface HiveFill {
  at: string;
  side: "maker" | "taker";
  paid: string;
  received: string;
  price: string;
  openOrderid?: number;
  currentOrderid?: number;
}

export interface HiveSnapshot {
  ok: boolean;
  at: string;
  account: string;
  chain: "HIVE-internal-market";
  real: true;
  armed: boolean;
  authorityOk: boolean | null;
  rc: { ok: boolean; mana: number; max: number; reason?: string };
  balances: { hive: number; hbd: number; hpOwn: number };
  book: { bestBid: number | null; bestAsk: number | null; mid: number | null; spreadBps: number | null };
  openOrders: { id: number; sell: string; receive: string; price: string; created: string; expiration: string }[];
  fills: HiveFill[];
  powerdown: {
    active: boolean;
    weeklyHp: number;
    remainingHp: number;
    remainingWeeks: number;
    nextPayout: string | null;
  };
  verdict: string;
  blocker: string | null;
  error?: string;
}

interface HiveAccount {
  balance: string;
  hbd_balance: string;
  vesting_shares: string;
  to_withdraw: string | number;
  vesting_withdraw_rate: string;
  next_vesting_withdrawal: string;
  active: { key_auths: [string, number][] };
}

function n(s: string | undefined): number {
  return s ? parseFloat(String(s).replace(/[A-Za-z ]+/g, "")) : 0;
}

async function fetchHiveSnapshot(): Promise<HiveSnapshot> {
  const [accArr, dgp, openRaw, rcGate] = await Promise.all([
    hiveRpcAny<HiveAccount[]>("condenser_api.get_accounts", [[ACCOUNT]]),
    hiveRpcAny<Record<string, unknown>>("condenser_api.get_dynamic_global_properties", []),
    hiveRpcAny<{ orderid: number; sell_price: { base: string; quote: string }; created: string; expiration: string }[]>(
      "condenser_api.get_open_orders", [ACCOUNT]
    ).catch(() => []),
    hiveRcGate().catch(() => null),
  ]);
  const a = accArr[0];
  const hpPerVest = n(String(dgp.total_vesting_fund_hive)) / n(String(dgp.total_vesting_shares));
  const vestOwn = n(a.vesting_shares);
  const twRaw = parseFloat(String(a.to_withdraw).replace(/[A-Za-z ]/g, "")) || 0;
  const toWithdraw = twRaw > 1e12 ? twRaw / 1e6 : twRaw;
  const rate = n(a.vesting_withdraw_rate);
  const pdActive = rate > 0 && toWithdraw > 0;

  // אימות-סמכות: המפתח שבידינו חייב לגזר בדיוק את ה-active הרשום בשרשרת
  let authorityOk: boolean | null = null;
  const wif = hiveActiveWif();
  if (wif) {
    try {
      const pub = steem.auth.wifToPublic(wif);
      const live = a.active?.key_auths?.[0]?.[0];
      authorityOk = !!live && pub === live.replace(/^BLT/, "STM").replace(/^HIVE/, "STM");
    } catch { authorityOk = false; }
  }

  // ספר-אמת
  let bestBid: number | null = null, bestAsk: number | null = null;
  try {
    const book = await hiveRpcAny<{ asks: { real_price: string }[]; bids: { real_price: string }[] }>("condenser_api.get_order_book", [5]);
    bestAsk = book.asks?.[0] ? parseFloat(book.asks[0].real_price) : null;
    bestBid = book.bids?.[0] ? parseFloat(book.bids[0].real_price) : null;
  } catch { /* fail-soft — הספר לא שובר את תמונת-המצב */ }
  const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null;
  const spreadBps = bestBid && bestAsk ? Math.floor(((bestAsk - bestBid) / bestBid) * 10_000) : null;

  // מילויים-אמת (אחרונים) — אותו דפדוף-מדוד של R24
  const fills: HiveFill[] = [];
  try {
    let start = -1;
    for (let page = 0; page < 3 && fills.length < 6; page++) {
      const hist = await hiveRpcAny<[number, { op: [string, Record<string, unknown>]; timestamp: string }][]>(
        "condenser_api.get_account_history", [ACCOUNT, start, 100],
      );
      if (!Array.isArray(hist) || hist.length === 0) break;
      for (const [, e] of hist) {
        if (e.op[0] !== "fill_order" || fills.length >= 6) continue;
        const o = e.op[1] as Record<string, unknown>;
        const openOwner = String(o.open_owner ?? "");
        const isMaker = openOwner === ACCOUNT;
        if (!isMaker && String(o.current_owner ?? "") !== ACCOUNT) continue;
        const paysOf = (x: unknown): string =>
          typeof x === "string" ? x : String((x as { amount?: string })?.amount ?? "");
        const paid = paysOf(o.current_pays);
        const recv = paysOf(o.open_pays);
        const pf = n(paid) / Math.max(1e-12, n(recv));
        fills.push({
          at: e.timestamp, side: isMaker ? "maker" : "taker", paid, received: recv,
          price: `${pf.toFixed(6)} ${paid.includes("HBD") ? "HBD/HIVE" : "HIVE/HBD"}`,
          openOrderid: Number(o.open_orderid ?? 0) || undefined,
          currentOrderid: Number(o.current_orderid ?? 0) || undefined,
        });
      }
      const firstIdx = hist[0]![0];
      if (firstIdx <= 0) break;
      start = Math.max(0, firstIdx - 100);
    }
  } catch { /* fail-soft */ }

  const openOrders = (openRaw ?? []).map((o) => ({
    id: o.orderid,
    sell: o.sell_price?.base ?? "", receive: o.sell_price?.quote ?? "",
    price: (() => {
      const b = n(o.sell_price?.base), q = n(o.sell_price?.quote);
      return b > 0 && q > 0 ? (b / q).toFixed(6) : "?";
    })(),
    created: o.created ?? "", expiration: o.expiration ?? "",
  }));

  return {
    ok: true,
    at: new Date().toISOString(),
    account: ACCOUNT,
    chain: "HIVE-internal-market",
    real: true,
    armed: !!wif,
    authorityOk,
    rc: rcGate ?? { ok: false, mana: 0, max: 0, reason: "rc-gate-unreachable (honest skip)" },
    balances: { hive: n(a.balance), hbd: n(a.hbd_balance), hpOwn: vestOwn * hpPerVest },
    book: { bestBid, bestAsk, mid, spreadBps },
    openOrders,
    fills,
    powerdown: {
      active: pdActive,
      weeklyHp: rate * hpPerVest,
      remainingHp: toWithdraw * hpPerVest,
      remainingWeeks: pdActive ? Math.max(1, Math.ceil(toWithdraw / Math.max(rate, 1e-9))) : 0,
      nextPayout: pdActive && a.next_vesting_withdrawal?.startsWith("2") ? a.next_vesting_withdrawal : null,
    },
    verdict: openOrders.length || fills.length
      ? "REAL-MARKET-LIVE — סוחרים-אמיתיים, יישוב-על-השרשרת, אפס-עמלה"
      : "REAL-MARKET-READY — ערוץ-אמת פתוח, אין-הזמנה-חיה",
    blocker: null,
  };
}

/* cache — סבלנות-לצמתים-הציבוריים */
interface Ht { at: number; data: HiveSnapshot | null; inflight: Promise<HiveSnapshot> | null }
const g = globalThis as unknown as { __saosHiveMarket?: Ht };
function ht(): Ht {
  if (!g.__saosHiveMarket) g.__saosHiveMarket = { at: 0, data: null, inflight: null };
  return g.__saosHiveMarket;
}

export async function hiveSnapshot(maxAgeMs = 45_000): Promise<HiveSnapshot> {
  const r = ht();
  const now = Date.now();
  if (r.data && now - r.at < maxAgeMs) return r.data;
  if (r.inflight) return r.inflight;
  r.inflight = fetchHiveSnapshot()
    .then((s) => { r.data = s; r.at = Date.now(); return s; })
    .finally(() => { r.inflight = null; });
  return r.inflight;
}

/** תמונת-מצב-כנה-גם-בכישלון (אף-פעם לא חוסם את הרגל-השנייה) */
export async function hiveSnapshotSoft(): Promise<HiveSnapshot | { ok: false; error: string }> {
  try {
    return await hiveSnapshot();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/* ── פעולות-חייל-אמת על שוק-HIVE ─────────────────────────────────────────── */

export async function hivePlaceOrder(params: {
  orderid: number;
  amountToSell: string;   // "0.020 HIVE"
  minToReceive: string;   // "0.001200 HBD"
  fillOrKill?: boolean;
  expirationDays?: number;
}): Promise<{ txid: string; block: number | null }> {
  const days = Math.min(Math.max(params.expirationDays ?? 27, 1), 27);
  const expiration = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 19);
  ht().data = null; // אילץ-רענון-אחרי-מוטציה
  return hiveSignAndBroadcast([["limit_order_create", {
    owner: ACCOUNT,
    orderid: params.orderid,
    amount_to_sell: params.amountToSell,
    min_to_receive: params.minToReceive,
    fill_or_kill: params.fillOrKill ?? false,
    expiration,
  }]]);
}

export async function hiveCancelOrder(orderid: number): Promise<{ txid: string; block: number | null }> {
  ht().data = null;
  return hiveSignAndBroadcast([["limit_order_cancel", { owner: ACCOUNT, orderid }]]);
}
