/**
 * chain-stream.ts — THE-CHAIN-STREAM (EXEC-CD-11) · זרם-הרשתות-האמיתיות
 * ═════════════════════════════════════════════════════════════════════════════
 * דבר-המפעיל: "כיצד נוכל להתחבר בדקס לזרם של סולנה, איתריום, בייס ועוד רשתות
 * ומטבעות אמיתיים — תבחן מה יש ומה חסר ותשלים הכל מסודר, בלי בלאגן".
 *
 * הסקר הכנה (מה-היה):
 *  · TRX/SOL — דלת-פקדה חיה (Task 72) · ETH/BSC — רק באימות-bridge (verifyFarTx)
 *  · Base — אפס-כיסוי · פידי-מחיר — median חוצה-מקורות (price-proof)
 *  · אפס-מקום-אחד-שמראה-את-כל-הרשתות-האמת-חי-בו-זמנית.
 *
 * ההשלמה (מה-יש-עכשיו):
 *  · רישום-אחת-מאורגן של 8 רשתות-אמת: Ethereum · Base · BSC · Solana · TRON ·
 *    STEEM · HIVE · BLURT — כולן דרך RPC-ציבורי-keyless בלבד (אפס-מפתחות,
 *    אפס-הרשמות — חוק-הכתר-headcorner נשמר).
 *  · פרובה-חיה-לכל-רשת: גובה-בלוק · גיל-בלוק · גז · chainId-מאומת · epoch-SOL ·
 *    head-גרפני — latency-נמדד-אמת, fail-כנה-לכל-רשת-בנפרד (רשת-מתה לא מורידה את הזרם).
 *  · מחיר-אמת-לכל-רשת: מ-extFeeds (median CoinGecko→CoinPaprika→CryptoCompare→Binance)
 *    — Base נושם-ETH (gas-token שלה הוא ETH אמת).
 *  · אוצר-חי: יתרות-כתובות-הפקדה מ-custodySnapshot (משותף-עם-הדלת — אפס-קריאות-
 *    כפולות). גרפניים: חשבון-headcorner מוצג-כנה (יתרות-העומק-בפאנל-Truth).
 *  · TTL-קאש-30ש׳ + single-flight — כבוד-לצמתים-הציבוריים (rate-limits).
 *
 * אפס-סודות · קריאה-בלבד · אפס-מדיניות-חתימה — הזרם-הוא-עין, לא-יד.
 */
import { fencedFetch } from "./fence";
import { extFeeds } from "./price-proof";
import { depositIdentities, custodySnapshot, type DoorIdentities, type Custody } from "./peg-door";

/* ── רישום-הרשתות — מקור-האמת היחיד לזרם ─────────────────────────────────── */

type FeedKey = "steem" | "hive" | "blurt" | "eth" | "sol" | "bnb" | "trx" | "btc";

interface ChainDef {
  id: string;
  name: string;
  kind: "evm" | "sol" | "tron" | "graphene";
  native: string;
  feed: FeedKey;              // מחיר-אמת מ-extFeeds (Base = ETH — gas-token)
  explorer: string;
  rpc?: string;               // evm/sol/tron
  expectedChainId?: number;   // evm
  condenser?: string;         // graphene
  condensers?: string[];      // graphene — סולם-משלים-כנה (כל-פרובה-אמת; הראשון-שעונה מנצח, כשל-הכל = DOWN גלוי)
  depositAccount?: string;    // graphene — החשבון-הריבוני על הרשת
}

const CHAINS: ChainDef[] = [
  { id: "eth", name: "Ethereum", kind: "evm", native: "ETH", feed: "eth", explorer: "https://etherscan.io", rpc: "https://ethereum-rpc.publicnode.com", expectedChainId: 1 },
  { id: "base", name: "Base", kind: "evm", native: "ETH", feed: "eth", explorer: "https://basescan.org", rpc: "https://mainnet.base.org", expectedChainId: 8453 },
  { id: "bsc", name: "BNB Smart Chain", kind: "evm", native: "BNB", feed: "bnb", explorer: "https://bscscan.com", rpc: "https://bsc-rpc.publicnode.com", expectedChainId: 56 },
  { id: "sol", name: "Solana", kind: "sol", native: "SOL", feed: "sol", explorer: "https://solscan.io", rpc: "https://api.mainnet-beta.solana.com" },
  { id: "trx", name: "TRON", kind: "tron", native: "TRX", feed: "trx", explorer: "https://tronscan.org", rpc: "https://api.trongrid.io" },
  { id: "steem", name: "STEEM", kind: "graphene", native: "STEEM", feed: "steem", explorer: "https://steemscan.com", condenser: "https://api.steemit.com", depositAccount: "headcorner" },
  { id: "hive", name: "Hive", kind: "graphene", native: "HIVE", feed: "hive", explorer: "https://hiveblocks.com", condenser: "https://api.hive.blog", condensers: ["https://api.hive.blog", "https://api.deathwing.me"], depositAccount: "headcorner" },
  { id: "blurt", name: "Blurt", kind: "graphene", native: "BLURT", feed: "blurt", explorer: "https://blurtblockexplorer.com", condenser: "https://blurt-rpc.saboin.com", condensers: ["https://blurt-rpc.saboin.com", "https://rpc.blurt.blog"], depositAccount: "headcorner" },
];

/* ── צורות-הפלט ──────────────────────────────────────────────────────────── */

export interface ChainStreamRow {
  id: string;
  name: string;
  kind: ChainDef["kind"];
  native: string;
  explorer: string;
  connected: boolean;
  latencyMs: number | null;
  /* טלמטריה-חיה (null = לא-נמדד — כנות, לא-אפס-מזויף) */
  blockHeight: number | null;
  blockAgeSec: number | null;
  chainId: number | null;
  chainIdOk: boolean | null;   // evm — הצומת-עצמו מכריז את ה-chainId הנכון
  gasGwei: number | null;
  baseFeeGwei: number | null;
  epochProgressPct: number | null; // sol בלבד
  /* כסף-אמת */
  priceUsd: number | null;
  priceSrc: string | null;
  treasury: {
    address: string | null;
    addressKind: "deposit-identity" | "account" | null;
    balanceNative: number | null;  // ביחידות-אנוש (ETH/SOL/TRX…)
    balanceRaw: number | null;     // wei/lamports/sun — כמו-שנמדד
    usd: number | null;            // balanceNative × priceUsd (רק-כששניהם-חיים)
  } | null;
  error?: string;
}

export interface ChainStream {
  ok: true;
  at: string;
  ttlMs: number;
  chains: ChainStreamRow[];
  summary: {
    connected: number;
    total: number;
    treasuryUsdKnown: number | null; // סכום-הרשתות-שנמדדו (כנות: רק-מה-שחי)
    priceStale: boolean;
    priceSrc: string | null;
  };
}

/* ── עזרי-RPC (כל-הצומת-ציבוריים-keyless · גדר-fencedFetch · timeout-קצוב) ── */

async function jsonRpc<T>(rpc: string, where: string, method: string, params: unknown[] = [], timeoutMs = 10_000): Promise<T> {
  const r = await fencedFetch(rpc, where, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`rpc ${r.status}`);
  const j = (await r.json()) as { result?: T; error?: { message?: string } };
  if (j.error) throw new Error(j.error.message ?? "rpc-error");
  return j.result as T;
}

const hexToNum = (h: string | null | undefined): number | null => {
  if (!h) return null;
  try { return Number(BigInt(h)); } catch { return null; }
};

/* ── פרובות-פר-רשת (fail-כנה-לכל-אחת-בנפרד) ─────────────────────────────── */

interface Probe {
  connected: boolean;
  latencyMs: number | null;
  blockHeight: number | null;
  blockAgeSec: number | null;
  chainId: number | null;
  chainIdOk: boolean | null;
  gasGwei: number | null;
  baseFeeGwei: number | null;
  epochProgressPct: number | null;
  error?: string;
}

async function probeEvm(def: ChainDef): Promise<Probe> {
  const t0 = Date.now();
  try {
    const [chainIdHex, headHex, block, gasHex] = await Promise.all([
      jsonRpc<string>(def.rpc!, "chain-stream.evm-cid", "eth_chainId"),
      jsonRpc<string>(def.rpc!, "chain-stream.evm-head", "eth_blockNumber"),
      jsonRpc<{ timestamp?: string; baseFeePerGas?: string } | null>(def.rpc!, "chain-stream.evm-block", "eth_getBlockByNumber", ["latest", false]),
      jsonRpc<string>(def.rpc!, "chain-stream.evm-gas", "eth_gasPrice").catch(() => null as unknown as string),
    ]);
    const latencyMs = Date.now() - t0;
    const cid = hexToNum(chainIdHex);
    const tsSec = hexToNum(block?.timestamp);
    return {
      connected: true, latencyMs,
      blockHeight: hexToNum(headHex),
      blockAgeSec: tsSec ? Math.max(0, Math.round((Date.now() - tsSec * 1000) / 1000)) : null,
      chainId: cid, chainIdOk: cid === def.expectedChainId,
      gasGwei: hexToNum(gasHex) !== null ? (hexToNum(gasHex) as number) / 1e9 : null,
      baseFeeGwei: hexToNum(block?.baseFeePerGas) !== null ? (hexToNum(block?.baseFeePerGas) as number) / 1e9 : null,
      epochProgressPct: null,
    };
  } catch (e) {
    return { connected: false, latencyMs: Date.now() - t0, blockHeight: null, blockAgeSec: null, chainId: null, chainIdOk: null, gasGwei: null, baseFeeGwei: null, epochProgressPct: null, error: e instanceof Error ? e.message.slice(0, 120) : "evm-probe-failed" };
  }
}

async function probeSol(def: ChainDef): Promise<Probe> {
  const t0 = Date.now();
  try {
    const epoch = await jsonRpc<{ absoluteSlot?: number; blockHeight?: number; epoch?: number; slotIndex?: number; slotsInEpoch?: number }>(def.rpc!, "chain-stream.sol-epoch", "getEpochInfo", [{ commitment: "confirmed" }]);
    const progress = epoch.slotsInEpoch && epoch.slotIndex !== undefined ? Math.round((epoch.slotIndex / epoch.slotsInEpoch) * 1000) / 10 : null;
    return {
      connected: true, latencyMs: Date.now() - t0,
      blockHeight: epoch.blockHeight ?? null,
      blockAgeSec: null, // לסולרה-אין-חותמת-בלוק-זולה-בלי-getBlockTime — ההתקדמות-היא-העדות
      chainId: null, chainIdOk: null, gasGwei: null, baseFeeGwei: null,
      epochProgressPct: progress,
    };
  } catch (e) {
    return { connected: false, latencyMs: Date.now() - t0, blockHeight: null, blockAgeSec: null, chainId: null, chainIdOk: null, gasGwei: null, baseFeeGwei: null, epochProgressPct: null, error: e instanceof Error ? e.message.slice(0, 120) : "sol-probe-failed" };
  }
}

async function probeTron(def: ChainDef): Promise<Probe> {
  const t0 = Date.now();
  try {
    const r = await fencedFetch(`${def.rpc!}/wallet/getnowblock`, "chain-stream.tron-now", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      signal: AbortSignal.timeout(10_000), cache: "no-store",
    });
    if (!r.ok) throw new Error(`trongrid ${r.status}`);
    const j = (await r.json()) as { block_header?: { raw_data?: { number?: number; timestamp?: number } } };
    const num = j.block_header?.raw_data?.number ?? null;
    const ts = j.block_header?.raw_data?.timestamp ?? null;
    return {
      connected: true, latencyMs: Date.now() - t0,
      blockHeight: num,
      blockAgeSec: ts ? Math.max(0, Math.round((Date.now() - ts) / 1000)) : null,
      chainId: null, chainIdOk: null, gasGwei: null, baseFeeGwei: null, epochProgressPct: null,
    };
  } catch (e) {
    return { connected: false, latencyMs: Date.now() - t0, blockHeight: null, blockAgeSec: null, chainId: null, chainIdOk: null, gasGwei: null, baseFeeGwei: null, epochProgressPct: null, error: e instanceof Error ? e.message.slice(0, 120) : "tron-probe-failed" };
  }
}

interface GrapheneDgp { head_block_number?: number; time?: string }

async function probeGraphene(def: ChainDef): Promise<Probe> {
  const t0 = Date.now();
  // EXEC-CD-12: סולם-משלים-כנה — api.hive.blog מתנפק-לרגעים; כל-ניסיון-הוא-פרובה-אמת-מלאה,
  // הראשון-שעונה מנצח; אם-הכל-נופלים → DOWN גלוי (אפס-ירוק-מזויף).
  const endpoints = def.condensers?.length ? def.condensers : [def.condenser!];
  let lastErr: unknown = null;
  for (const rpc of endpoints) {
    try {
      const dgp = await jsonRpc<GrapheneDgp>(rpc, "chain-stream.graphene-dgp", "condenser_api.get_dynamic_global_properties", []);
      const ageSec = dgp.time ? Math.max(0, Math.round((Date.now() - new Date(dgp.time + "Z").getTime()) / 1000)) : null;
      return {
        connected: true, latencyMs: Date.now() - t0,
        blockHeight: dgp.head_block_number ?? null,
        blockAgeSec: ageSec,
        chainId: null, chainIdOk: null, gasGwei: null, baseFeeGwei: null, epochProgressPct: null,
      };
    } catch (e) { lastErr = e; }
  }
  return { connected: false, latencyMs: Date.now() - t0, blockHeight: null, blockAgeSec: null, chainId: null, chainIdOk: null, gasGwei: null, baseFeeGwei: null, epochProgressPct: null, error: lastErr instanceof Error ? lastErr.message.slice(0, 120) : "graphene-probe-failed" };
}

/* ── אוצר-חי (משותף-עם-הדלת — custodySnapshot-TTL, אפס-קריאות-כפולות) ─────── */

function treasuryRow(
  def: ChainDef,
  ids: DoorIdentities,
  custody: Custody | null,
  priceUsd: number | null,
): ChainStreamRow["treasury"] {
  const raw = (v: number | null | undefined): number | null => (typeof v === "number" && v >= 0 ? v : null);
  if (def.kind === "graphene") {
    return {
      address: def.depositAccount ?? null,
      addressKind: "account",
      balanceNative: null, // יתרות-הגרפניים-חיות-בפאנל-ה-Truth (treasury-of-truth) — אפס-שכפול-RPC
      balanceRaw: null,
      usd: null,
    };
  }
  if (def.kind === "evm") {
    const key = def.id as "eth" | "base" | "bsc";
    const wei = custody ? raw(custody.evmWeiByChain?.[key]) : null;
    return {
      address: ids.evm,
      addressKind: "deposit-identity",
      balanceNative: wei !== null ? wei / 1e18 : null,
      balanceRaw: wei,
      usd: wei !== null && priceUsd ? (wei / 1e18) * priceUsd : null,
    };
  }
  if (def.kind === "sol") {
    const lamports = custody ? raw(custody.solLamports) : null;
    return {
      address: ids.sol,
      addressKind: "deposit-identity",
      balanceNative: lamports !== null ? lamports / 1e9 : null,
      balanceRaw: lamports,
      usd: lamports !== null && priceUsd ? (lamports / 1e9) * priceUsd : null,
    };
  }
  // tron
  const sun = custody ? raw(custody.tronSun) : null;
  return {
    address: ids.tron,
    addressKind: "deposit-identity",
    balanceNative: sun !== null ? sun / 1e6 : null,
    balanceRaw: sun,
    usd: sun !== null && priceUsd ? (sun / 1e6) * priceUsd : null,
  };
}

/* ── הזרם — TTL-30ש׳ + single-flight (אותו-דפוס של extFeeds/custody) ──────── */

interface StreamRT { at: number; data: ChainStream | null; inflight: Promise<ChainStream> | null }
const gS = globalThis as unknown as { __saosChainStream?: StreamRT };
function streamRt(): StreamRT {
  if (!gS.__saosChainStream) gS.__saosChainStream = { at: 0, data: null, inflight: null };
  return gS.__saosChainStream;
}

const STREAM_TTL_MS = 30_000;

async function fetchStream(): Promise<ChainStream> {
  const ids = depositIdentities();
  const [feeds, custody] = await Promise.all([
    extFeeds(),
    custodySnapshot(ids).catch(() => null),
  ]);

  const rows: ChainStreamRow[] = await Promise.all(CHAINS.map(async (def): Promise<ChainStreamRow> => {
    const priceUsd = feeds.usd[def.feed] ?? null;
    const priceSrc = feeds.src?.[def.feed] ?? null;
    const probe = def.kind === "evm" ? await probeEvm(def)
      : def.kind === "sol" ? await probeSol(def)
      : def.kind === "tron" ? await probeTron(def)
      : await probeGraphene(def);
    return {
      id: def.id, name: def.name, kind: def.kind, native: def.native, explorer: def.explorer,
      connected: probe.connected, latencyMs: probe.latencyMs,
      blockHeight: probe.blockHeight, blockAgeSec: probe.blockAgeSec,
      chainId: probe.chainId, chainIdOk: probe.chainIdOk,
      gasGwei: probe.gasGwei, baseFeeGwei: probe.baseFeeGwei,
      epochProgressPct: probe.epochProgressPct,
      priceUsd, priceSrc,
      treasury: treasuryRow(def, ids, custody, priceUsd),
      error: probe.error,
    };
  }));

  const usdKnown = rows
    .map((r) => r.treasury?.usd ?? null)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0);

  return {
    ok: true,
    at: new Date().toISOString(),
    ttlMs: STREAM_TTL_MS,
    chains: rows,
    summary: {
      connected: rows.filter((r) => r.connected).length,
      total: rows.length,
      treasuryUsdKnown: usdKnown.length > 0 ? usdKnown.reduce((a, b) => a + b, 0) : null,
      priceStale: Boolean(feeds.stale),
      priceSrc: feeds.ok ? "median-cross-source" : null,
    },
  };
}

/** הזרם-החי — קאש-30ש׳ + single-flight (כבוד-לצמתים-הציבוריים). */
export async function chainStream(): Promise<ChainStream> {
  const m = streamRt();
  if (m.data && Date.now() - m.at < STREAM_TTL_MS) return m.data;
  if (m.inflight) return m.inflight;
  m.inflight = fetchStream()
    .then((d) => { m.at = Date.now(); m.data = d; return d; })
    .finally(() => { m.inflight = null; });
  return m.inflight;
}
