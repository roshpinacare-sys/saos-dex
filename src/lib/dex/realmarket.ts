/**
 * realmarket.ts — מחבר-השוק-האמיתי (Task 62) · THE-REAL-GRID
 * ═════════════════════════════════════════════════════════════════════════════
 * דבר-המפעיל (62): "איפה החיילים עושים את ה-grid על איזה צמדים, מה קורה שם
 * על הרשת, האם יש לזה רווח אמיתי, איך מחברים את זה לשוק אמיתי ולא אשליה".
 *
 * התשובה הכנה:
 *  · הארנה הפנימית (mm.ts) סוחרת SAOS/USDS + WSTEEM/USDS מול סוכנים פנימיים —
 *    סימולציה כנה, אפס-רווח-חוץ (פסק-הדין של truth.ts כבר מציג את זה).
 *  · השוק-האמיתי הראשון של החיילים = **ספר-STSTEEM הפנימי של שרשרת-STEEM**
 *    (limit_order_create) — ספר-ציבורי עם סוחרים-אמיתיים, יישוב-על-השרשרת,
 *    אפס-עמלת-מסחר (דבר-גורר-דבר). ההזמנה-האמת-הראשונה שוגרה-ואומתה (62):
 *    txid b269647e…3a98 · #62091002 · 0.260 SBD → 2.708 STEEM.
 *  · ומסילת-הדלק: **SP-powerdown אמת** (txid 6e881cd4…606) — 1,746.9-SP
 *    משתחררים ב-4 תשלומים-שבועיים (~436.7 SP/שבוע) ישר-ל-STEEM-נזיל של
 *    headcorner, ומשם: גריד-אמת שבועית + גיבוי-WSTEEM אמת. 150-SP נשארים
 *    דלק-RC לעיגונים.
 *
 * חתימה: pure-JS (steem-js) על ה-WIF-הגולמי מ-.env — הנתיב שהוכח-חי-על-השרשרת
 * ב-62 (ה-scalar-הפנימי של bigi מה-WIF-הדחוס K/L — כולל באג-ה-33-בייטים-ההיסטורי
 * של המחולל; אותו-סקלר הוא מה שהסמכויות-על-השרשרת מצפות-לו). אפס-הדפסת-סודות.
 */
import steem from "steem";
import { extFeeds } from "./price-proof";
import { fencedFetch } from "./fence"; // FIX(Roast-63)+FIX(Roast-65-b · H2): גדר + redirect:error מרוכזים

const STEEM_NODES = [
  "https://api.steemit.com",
  "https://api.justyy.com",
  "https://steem-rpc.publicnode.com",
];
const STEEM_CHAIN_ID = "0000000000000000000000000000000000000000000000000000000000000000";
const ACCOUNT = process.env.SAOS_RELAY_AGENT_ACCOUNT || "headcorner";
/** תקופת-powerdown נוכחית ב-STEEM: 4 שבועות (נמדד-חי 62: rate = to_withdraw/4) */
export const POWERDOWN_WEEKS = 4;
/** דלק-RC שנשמר-מחוץ-ל-powerdown (≈150 SP) — עיגוני-STEEM לא נחנקים */
export const RC_FUEL_VESTS = 242_330;

interface GrapheneTx {
  ref_block_num: number;
  ref_block_prefix: number;
  expiration: string;
  operations: [string, Record<string, unknown>][];
  extensions: never[];
}

/* ── RPC ─────────────────────────────────────────────────────────────────── */

async function rpc<T>(node: string, body: unknown, timeoutMs = 8_000): Promise<T> {
  // FIX(Roast-63): הגדר-נאכפת — שער-לא-מקובע = חסימה fail-closed (היה-עוקף) · FIX(Roast-65-b · H2): דרך-fencedFetch (redirect:error)
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fencedFetch(node, "realmarket.rpc", {
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

/* 9-c (2026-10-11): מיוצא עתה לשער-המפתח (grids/key-gate.mjs דרך grid-beat) —
 * אותו-failover מרובה-צמתים לאימות-רשות-החיה. אין-שינוי-התנהגות. */
export async function rpcAny<T>(method: string, params: unknown[]): Promise<T> {
  // FIX(70 ·שידור-כנה): היה-רק-השגיאה-האחרונה — צומת-מת (404-גוף-ריק) מעליף
  // את-הודעת-השרשרת-האמיתית של-הצמתים-החיים. עתה: כל-השגיאות-נאספות-ומדווחות.
  const errs: string[] = [];
  for (const node of STEEM_NODES) {
    try {
      return await rpc<T>(node, { jsonrpc: "2.0", id: 1, method, params });
    } catch (e) {
      errs.push(`${new URL(node).host}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`all-steem-nodes-failed · ${errs.join(" | ")}`);
}

/* ── חתימה-ושידור (הנתיב-המוכח-על-השרשרת) ───────────────────────────────── */

export function activeWif(): string | null {
  const w = process.env.STEEM_ACTIVE_WIF || "";
  return w.length >= 51 ? w : null;
}

export async function signAndBroadcast(ops: [string, Record<string, unknown>][]): Promise<{ txid: string; block: number | null }> {
  const wif = activeWif();
  if (!wif) throw new Error("STEEM_ACTIVE_WIF missing — fail-closed (אין-חתימה, אין-שידור)");
  const dgp = await rpcAny<Record<string, unknown>>("condenser_api.get_dynamic_global_properties", []);
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
  steem.config.set("chain_id", STEEM_CHAIN_ID);
  let signed: GrapheneTx & { signatures?: string[] };
  try {
    // ה-WIF-הגולמי-מ-.env — מנוע-ה-bigi מוציא ממנו את הסקלר-האמיתי (כולל-הבאג-
    // ההיסטורי-33B) — זה בדיוק מה שהסמכויות-על-השרשרת מאמתות. WARN-cosmetic.
    signed = steem.auth.signTransaction(tx, [wif]);
  } finally {
    try { steem.config.set("chain_id", prev ?? STEEM_CHAIN_ID); } catch { /* keep */ }
  }
  const res = await rpcAny<{ id?: string; block_num?: number }>(
    "condenser_api.broadcast_transaction_synchronous",
    [{ ...signed }],
  );
  if (!res?.id) throw new Error("broadcast answered without id (honest)");
  return { txid: res.id, block: res.block_num ?? null };
}

/* ── תמונת-מצב אמת ───────────────────────────────────────────────────────── */

export interface RealFill {
  at: string;
  side: "maker" | "taker";
  paid: string;
  received: string;
  price: string;
  /** R24 · grid-beat: מזהי-ההזמנות מהאירוע — השוואה מדויקת למעקה */
  openOrderid?: number;
  currentOrderid?: number;
}

export interface RealSnapshot {
  ok: boolean;
  at: string;
  account: string;
  chain: "STEEM-internal-market";
  real: true; // ספר-ציבורי, יישוב-על-השרשרת, סוחרים-אמיתיים
  balances: { steem: number; sbd: number; spOwn: number; spDelegatedOut: number };
  spPerVest: number;
  steemUsd: number | null;
  powerdown: {
    active: boolean;
    weeks: number;
    weeklyVests: number;
    weeklySp: number;
    remainingVests: number;
    remainingSp: number;
    remainingWeeks: number;
    nextPayout: string | null;
    rcFuelSp: number;
  };
  book: { bestBid: number | null; bestAsk: number | null; mid: number | null; spreadBps: number | null };
  openOrders: { id: number; sell: string; receive: string; price: string; created: string; expiration: string }[];
  fills: RealFill[];
  verdict: string;
  blocker: string | null;
  error?: string;
}

interface SteemAccount {
  balance: string; sbd_balance: string;
  vesting_shares: string; delegated_vesting_shares: string; received_vesting_shares: string;
  to_withdraw: string | number; vesting_withdraw_rate: string; next_vesting_withdrawal: string;
}

function n(s: string | undefined): number {
  return s ? parseFloat(String(s).replace(/[A-Za-z ]+/g, "")) : 0;
}

async function fetchSnapshot(): Promise<RealSnapshot> {
  const [accArr, dgp, openRaw] = await Promise.all([
    rpcAny<SteemAccount[]>("condenser_api.get_accounts", [[ACCOUNT]]),
    rpcAny<Record<string, unknown>>("condenser_api.get_dynamic_global_properties", []),
    rpcAny<{ orderid: number; sell_price: { base: string; quote: string }; created: string; expiration: string }[]>(
      "condenser_api.get_open_orders", [ACCOUNT],
    ).catch(() => []),
  ]);
  const a = accArr[0];
  const spPerVest = n(String(dgp.total_vesting_fund_steem)) / n(String(dgp.total_vesting_shares));
  const vestOwn = n(a.vesting_shares);
  const delOut = n(a.delegated_vesting_shares);
  // to_withdraw מגיע כ-VESTS-גלמיים: מספר או מחרוזת "N" (עשרוני ×1e6) או "N VESTS".
  // היוריסטיקה: >1e12 = ייצוג-שלם-גלמי (vests×1e6) → חלוקה. אחרת — כבר VESTS.
  const twRaw = parseFloat(String(a.to_withdraw).replace(/[A-Za-z ]/g, "")) || 0;
  const toWithdraw = twRaw > 1e12 ? twRaw / 1e6 : twRaw;
  const rate = n(a.vesting_withdraw_rate);
  const active = rate > 0 && toWithdraw > 0;
  const feeds = await extFeeds().catch(() => null);
  const steemUsd = feeds?.usd.steem ?? null;
  // ספר-אמת
  let bestBid: number | null = null, bestAsk: number | null = null;
  try {
    const book = await rpcAny<{ asks: { real_price: string }[]; bids: { real_price: string }[] }>("condenser_api.get_order_book", [5]);
    bestAsk = book.asks?.[0] ? parseFloat(book.asks[0].real_price) : null;
    bestBid = book.bids?.[0] ? parseFloat(book.bids[0].real_price) : null;
  } catch { /* fail-soft — הספר לא שובר את תמונת-המצב */ }
  const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null;
  const spreadBps = bestBid && bestAsk ? Math.floor(((bestAsk - bestBid) / bestBid) * 10_000) : null;
  // מילויים-אמת (אחרונים)
  // FIX(R24 · silent-fills-loss): condenser מגביל get_account_history ל-100-פעולות
  // לקריאה (נמדד-חי: api.steemit.com ו-justyy דוחים 200 בשגיאה, ה-fail-soft
  // בלע אותה והמילויים נעלמו בשקט). עתה: דפדוף-מדוד — עד-3-דפים של-100,
  // עוצר ברגע שנמצאו 6 מילויים או שההיסטוריה אזלה. כשל-דף = המשך-כנה.
  const fills: RealFill[] = [];
  try {
    let start = -1;
    for (let page = 0; page < 3 && fills.length < 6; page++) {
      const hist = await rpcAny<[number, { op: [string, Record<string, unknown>]; timestamp: string }][]>(
        "condenser_api.get_account_history", [ACCOUNT, start, 100],
      );
      if (!Array.isArray(hist) || hist.length === 0) break;
      for (const [idx, e] of hist) {
        if (e.op[0] !== "fill_order" || fills.length >= 6) continue;
        const o = e.op[1] as Record<string, { amount: string } | string>;
        const openOwner = String(o.open_owner ?? "");
        const isMaker = openOwner === ACCOUNT;
        if (!isMaker && String(o.current_owner ?? "") !== ACCOUNT) continue;
        // FIX(R24 · pays-form): condenser מחזיר current_pays/open_pays כמחרוזת
        // ("0.049 SBD"); הקאסט-הישן חיפש .amount על-מחרוזת וקיבל ריק — המילויים
        // נספרו בלי-סכומים. עתה: שתי-הצורות (מחרוזת-גולמית או אובייקט-amount).
        const paysOf = (x: unknown): string =>
          typeof x === "string" ? x : String((x as { amount?: string })?.amount ?? "");
        const paid = paysOf(o.current_pays);
        const recv = paysOf(o.open_pays);
        const pf = n(paid) / Math.max(1e-12, n(recv));
        const openOid = Number(o.open_orderid ?? 0) || undefined;
        const curOid = Number(o.current_orderid ?? 0) || undefined;
        fills.push({
          at: e.timestamp, side: isMaker ? "maker" : "taker",
          paid, received: recv,
          price: `${pf.toFixed(6)} ${paid.includes("SBD") ? "SBD/STEEM" : "STEEM/SBD"}`,
          openOrderid: openOid, currentOrderid: curOid,
        });
      }
      const firstIdx = hist[0]![0];
      if (firstIdx <= 0) break; // אין עבר נוסף
      start = firstIdx - 100; // דף-הבא: 100 אחורה מהראשון שראינו
      if (start < 0) start = 0;
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
    chain: "STEEM-internal-market",
    real: true,
    balances: {
      steem: n(a.balance), sbd: n(a.sbd_balance),
      spOwn: (vestOwn - delOut) * spPerVest, spDelegatedOut: delOut * spPerVest,
    },
    spPerVest,
    steemUsd,
    powerdown: {
      active,
      weeks: POWERDOWN_WEEKS,
      weeklyVests: rate,
      weeklySp: rate * spPerVest,
      remainingVests: toWithdraw,
      remainingSp: toWithdraw * spPerVest,
      remainingWeeks: active ? Math.max(1, Math.ceil(toWithdraw / Math.max(rate, 1e-9))) : 0,
      nextPayout: active && a.next_vesting_withdrawal?.startsWith("2") ? a.next_vesting_withdrawal : null,
      rcFuelSp: (RC_FUEL_VESTS * spPerVest) || (active ? 0 : Math.max(0, (vestOwn - delOut)) * spPerVest),
    },
    book: { bestBid, bestAsk, mid, spreadBps },
    openOrders,
    fills,
    verdict: active || openOrders.length
      ? "REAL-MARKET-LIVE — סוחרים-אמיתיים, יישוב-על-השרשרת, אפס-עמלה"
      : "REAL-MARKET-READY — ערוץ-אמת פתוח, אין-הזמנה-חיה",
    blocker: null,
  };
}

/* cache — סבלנות-לצמתים-הציבוריים (אותם-צמתים משרתים-את-כל-העולם) */
interface Rt { at: number; data: RealSnapshot | null; inflight: Promise<RealSnapshot> | null }
const g = globalThis as unknown as { __saosRealMarket?: Rt };
function rt(): Rt {
  if (!g.__saosRealMarket) g.__saosRealMarket = { at: 0, data: null, inflight: null };
  return g.__saosRealMarket;
}

export async function realSnapshot(maxAgeMs = 45_000): Promise<RealSnapshot> {
  const r = rt();
  const now = Date.now();
  if (r.data && now - r.at < maxAgeMs) return r.data;
  if (r.inflight) return r.inflight;
  r.inflight = fetchSnapshot()
    .then((s) => { r.data = s; r.at = Date.now(); return s; })
    .finally(() => { r.inflight = null; });
  return r.inflight;
}

/** תמונת-מצב-כנה-גם-בכישלון (אף-פעם לא 500) */
export async function realSnapshotSoft(): Promise<RealSnapshot | { ok: false; error: string }> {
  try {
    return await realSnapshot();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/* ── פעולות-חייל-אמת (מאושרות-מפעיל-בלבד) ───────────────────────────────── */

/** הזמנת-גריד-אמת על ספר-STEEM: מוכר-`sell` ומקבל-לפחות-`receive`. */
export async function realPlaceOrder(params: {
  orderid: number;
  amountToSell: string;   // "0.260 SBD"
  minToReceive: string;   // "2.708 STEEM"
  fillOrKill?: boolean;
  expirationDays?: number; // ברירת-מחדל 27 (תקרת-STEEM)
}): Promise<{ txid: string; block: number | null }> {
  const days = Math.min(Math.max(params.expirationDays ?? 27, 1), 27);
  const expiration = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 19);
  rt().data = null; // אילץ-רענון-אחרי-מוטציה
  return signAndBroadcast([["limit_order_create", {
    owner: ACCOUNT,
    orderid: params.orderid,
    amount_to_sell: params.amountToSell,
    min_to_receive: params.minToReceive,
    fill_or_kill: params.fillOrKill ?? false,
    expiration,
  }]]);
}

export async function realCancelOrder(orderid: number): Promise<{ txid: string; block: number | null }> {
  rt().data = null;
  return signAndBroadcast([["limit_order_cancel", { owner: ACCOUNT, orderid }]]);
}

/** DIRECTIVE-R24 (owner 2026-09-13): **לא עושים powerdown** — כוח-הצי (SP/BP/HP) קדוש:
 * החיילים מדפיסים-פוסטים-מה-RC-שהוא-מזין. חלוקת-הכוח בין STEEM/HIVE/BLURT אינה-תחום-ה-DEX.
 * הפונקציה-נעולה-fail-closed; נדרשת-הוראה-חדשה-מפורשת-מהבעלים-לפתיחה. */
export async function realReplacePowerdown(_vestingShares: string): Promise<{ txid: string; block: number | null }> {
  throw new Error("DIRECTIVE-R24: powerdown forbidden by owner — fleet RC protected; requires explicit new owner instruction to unlock");
}

/** power-up עתידי (דלק-RC מתאושש-מעצמו מתשלומי-השבוע) */
export async function realPowerUp(steemAmount: string, to?: string): Promise<{ txid: string; block: number | null }> {
  rt().data = null;
  return signAndBroadcast([["transfer_to_vesting", { from: ACCOUNT, to: to || ACCOUNT, amount: steemAmount }]]);
}


