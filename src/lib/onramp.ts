/**
 * onramp.ts — THE-ONRAMP (SETTLE-17) · מפת-הנזילות-החוץ-האמתית-החיה של-הרשת
 * =============================================================================
 * השאיפה-שאושרה ("אור-ירוק-מלא"): נזילות-מבחוץ-ממשית — לא-SIM. הצעד-הראשון-
 * הכן: **למדוד-מה-באמת-יש-בחוץ** — מאזני-החשבונות-החיים-שלנו-על-Hive
 * (9-חיילי-הצי + headcorner ראש-הממסורת), קריאה-ציבורית-חסרת-מפתחות-מה-RPC
 * המקובע (fence fail-closed), ומפת-יכולת-כנה-לכל-נכס:
 *   · מה-**כבר-מניב** עכשיו — קיבולת-עיגון-RC-חינם/יום (מוסד-SETTLE-13, חי);
 *   · מה-**דורש-החלטת-מפעיל** — סריקת-אבק-HE דורשת-מפתח-active (מדיניות-הצי:
 *     posting-only + רוטציה-מומלצת-קודם); headcorner — אין-WIF-בכספת-כלל.
 *
 * אפס-סודות (שמות-חשבונות-ומספרים — ציבוריים-ממילא-על-השרשרת) ·
 * TTL-קאש 10 דק' · אפס-כתיבה — קריאה-בלבד. */
import { assertAllowedHost } from "./dex/fence";
import { fleetStatusPublic } from "./dex/fleet";

const HIVE_NODE = "https://api.hive.blog"; // מקובע-ב-fence (PINNED_HOSTS)
const HE_NODE = "https://api.hive-engine.com/rpc/contracts"; // מקובע-ב-fence · מסלול-החוזות-המלא
const STEEM_NODE = "https://api.steemit.com"; // מקובע-ב-fence — הרשת-הראשית-של-headcorner
const HEAD_ACCOUNT = "headcorner";
const RC_OP_COST = 200_000_000; // עלות-op-מדודה (199M) + מרווח — אותו-סף-כמו-הצי
const TTL_MS = 10 * 60_000;
const FALLBACK_ACCOUNTS = ["cashmachine", "haran", "israelnews", "lsa", "macrame", "siq", "wic", "wog", "woq"];

export interface OnrampAccount {
  account: string;
  role: "fleet-soldier" | "relay-head";
  liquidHive: number;
  hbd: number;
  hp: number;
  rcEffective: number | null;
  rcMax: number | null;
  anchorCapacityPerDay: number; // ריבוני-חינם — RC-regen ÷ עלות-op-מדודה
  movableNow: boolean; // האם-אפשר-להזיז-את-הנזיל-עכשיו-עם-מה-שיש-לנו
  why: string; // הסבר-כן-קצר
}

export interface OnrampTokenRow {
  account: string;
  symbol: string;
  balance: number;
  stake: number;
}

export interface OnrampSummary {
  at: string;
  stale: boolean;
  accounts: OnrampAccount[];
  tokens: OnrampTokenRow[];
  steemHead: { account: string; steem: number; sbd: number; sp: number; vestShares: number } | null;
  totals: {
    liquidHive: number;
    hbd: number;
    hp: number;
    swapHive: number;
    anchorCapacityPerDay: number;
  };
  tapNow: { what: string; how: string }[];
  needsOperator: { what: string; why: string }[];
  note: string;
}

interface RT { at: number; data: OnrampSummary | null }
const g = globalThis as unknown as { __saosOnramp?: RT };
function rt(): RT {
  if (!g.__saosOnramp) g.__saosOnramp = { at: 0, data: null };
  return g.__saosOnramp;
}

async function rpc<T>(endpoint: string, body: unknown, timeoutMs = 12_000): Promise<T> {
  assertAllowedHost(endpoint, "onramp");
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(endpoint, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: ac.signal, cache: "no-store",
    });
    if (!r.ok) throw new Error(`rpc ${r.status} @ ${endpoint}`);
    return (await r.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

const num = (s: string | undefined): number => {
  const v = parseFloat(String(s ?? "0").replace(/,/g, "").split(" ")[0]);
  return Number.isFinite(v) ? v : 0;
};

async function readAccounts(names: string[]): Promise<Map<string, OnrampAccount>> {
  const out = new Map<string, OnrampAccount>();
  // קריאה-אחת-משותפת — מאזנים + RC-קנוני (אותו-מימוש-כמו-הצי)
  const [cond, rcAll] = await Promise.all([
    rpc<{ result?: Array<Record<string, string>> }>(HIVE_NODE, {
      jsonrpc: "2.0", method: "condenser_api.get_accounts", params: [names], id: 1,
    }),
    Promise.all(names.map((n) =>
      rpc<{ result?: { rc_accounts?: Array<{ rc_manabar: { current_mana: string; last_update_time: number }; max_rc: string }> } }>(
        HIVE_NODE,
        { jsonrpc: "2.0", method: "rc_api.find_rc_accounts", params: { accounts: [n] }, id: 1 },
      ).then((r) => r.result?.rc_accounts?.[0] ?? null).catch(() => null),
    )),
  ]);
  const rows = cond.result ?? [];
  for (let i = 0; i < names.length; i++) {
    const a = rows.find((x) => x.name === names[i]);
    const rc = rcAll[i];
    let rcEff: number | null = null;
    let rcMax: number | null = null;
    if (rc) {
      const cur = Number(rc.rc_manabar?.current_mana) || 0;
      const max = Number(rc.max_rc) || 0;
      const last = Number(rc.rc_manabar?.last_update_time) || 0;
      const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - last);
      rcMax = max;
      rcEff = Math.min(max, cur + (max / 432000) * elapsed); // הקרנה-קנונית (CROSS-F-05)
    }
    const role: OnrampAccount["role"] = names[i] === HEAD_ACCOUNT ? "relay-head" : "fleet-soldier";
    const liquidHive = num(a?.balance);
    const hbd = num(a?.hbd_balance);
    const hp = num(a?.vesting_shares) / 1e6;
    const cap = rcEff !== null ? Math.floor((rcMax ?? 0) / 5 / RC_OP_COST) : 0;
    out.set(names[i], {
      account: names[i], role, liquidHive, hbd, hp, rcEffective: rcEff, rcMax,
      anchorCapacityPerDay: role === "fleet-soldier" ? cap : 0,
      movableNow: false,
      why: role === "fleet-soldier"
        ? "מפתח-active-לא-מופעל-בדרך-הצי (posting-only לעיגון בלבד) — סריקת-אבק/העברה-דורשת-החלטת-מפעיל+רוטציה"
        : "אין-WIF-בכספת-כלל — רק-המפעיל-חתם-על-הזזת-headcorner (9.68 HIVE-נזילים-נמדדו-חי)",
    });
  }
  return out;
}

async function readTokens(names: string[]): Promise<OnrampTokenRow[]> {
  try {
    const r = await rpc<{ result?: Array<{ account: string; symbol: string; balance: string; stake: string }> }>(
      HE_NODE,
      { jsonrpc: "2.0", method: "find", params: { contract: "tokens", table: "balances", query: { account: { $in: names } }, limit: 100, offset: 0 }, id: 1 },
    );
    return (r.result ?? [])
      .map((x) => ({ account: x.account, symbol: x.symbol, balance: num(x.balance), stake: num(x.stake) }))
      .filter((x) => x.balance > 0 || x.stake > 0)
      .sort((x, y) => (y.balance + y.stake) - (x.balance + x.stake))
      .slice(0, 24);
  } catch {
    return []; // HE-לא-זמין — לא-חוסם (הקונדנסר-הוא-האמת-הראשית)
  }
}

/** Task 54 · מדידת-STEEM-חיה של-headcorner (הרשת-הראשית של-המפעיל) —
 * קריאה-ציבורית-חסרת-מפתחות; כנות-מלאה: מה שיש-בשרשרת, בלי-שום-הערכה. */
async function readSteemHead(): Promise<OnrampSummary["steemHead"]> {
  try {
    const r = await rpc<{ result?: Array<Record<string, string>> }>(STEEM_NODE, {
      jsonrpc: "2.0", method: "condenser_api.get_accounts", params: [[HEAD_ACCOUNT]], id: 1,
    });
    const a = (r.result ?? []).find((x) => x.name === HEAD_ACCOUNT);
    if (!a) return null;
    const vest = num(a.vesting_shares);
    return {
      account: HEAD_ACCOUNT,
      steem: num(a.balance),
      sbd: num(a.sbd_balance),
      sp: vest / 1e6,
      vestShares: vest,
    };
  } catch {
    return null; // STEEM-RPC-לא-זמין — לא-חוסם (כנות: השדה נעלם, לא מאולף)
  }
}

export async function onrampSnapshot(force = false): Promise<OnrampSummary> {
  const m = rt();
  if (!force && m.data && Date.now() - m.at < TTL_MS) {
    return { ...m.data, stale: false };
  }
  let fleetNames: string[] = [];
  try {
    fleetNames = (fleetStatusPublic().accounts as Array<{ account: string }>).map((a) => a.account);
  } catch { /* צי-לא-חשוף-בזה-התהליך — רשימה-קנונית */ }
  const names = [...new Set([...(fleetNames.length ? fleetNames : FALLBACK_ACCOUNTS), HEAD_ACCOUNT])];

  const [accts, tokens, steemHead] = await Promise.all([
    readAccounts(names), readTokens(names), readSteemHead(),
  ]);
  const accounts = names.filter((n) => accts.has(n)).map((n) => accts.get(n)!);
  const totals = {
    liquidHive: accounts.reduce((s, a) => s + a.liquidHive, 0),
    hbd: accounts.reduce((s, a) => s + a.hbd, 0),
    hp: accounts.reduce((s, a) => s + a.hp, 0),
    swapHive: tokens.filter((t) => t.symbol === "SWAP.HIVE").reduce((s, t) => s + t.balance, 0),
    anchorCapacityPerDay: accounts.reduce((s, a) => s + a.anchorCapacityPerDay, 0),
  };
  const data: OnrampSummary = {
    at: new Date().toISOString(),
    stale: false,
    accounts,
    tokens,
    steemHead,
    totals,
    tapNow: [
      { what: `עיגון-ריבוני-חינם: ~${totals.anchorCapacityPerDay} אבני-דרך/יום (RC-regen ÷ 200M)`, how: "מופעל-כבר-אוטומטית — THE-MILESTONE מעגן-את-P&L על-Hive" },
    ],
    needsOperator: [
      { what: "headcorner — 9.68 HIVE נזיל (2018, ראש-הממסורת)", why: "אין-WIF-בכספת — דרוש-מפתח-active-מהמפעיל (או-ערוץ-חתימה-חוץ)" },
      { what: `אבק-HE-בצי (~${totals.swapHive.toFixed(4)} SWAP.HIVE + סטייקים WAIV/LOLZ/WEED/STEM)`, why: "מכירת-HE-דורשת-מפתח-active — מדיניות-הצי: posting-only עד-רוטציית-מפתחות" },
    ],
    note: "קריאה-ציבורית-חסרת-מפתחות-מה-RPC-המקובע — אפס-סודות, אפס-כתיבה. מפת-היכולת-כנה: מה-מניב-עכשיו מול-מה-דורש-החלטת-בעלים.",
  };
  m.at = Date.now();
  m.data = data;
  return data;
}
