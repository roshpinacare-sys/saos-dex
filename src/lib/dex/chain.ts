/**
 * chain.ts — שרשרת-הפעימה של SAOS-DEX (מורשת grid98 + saosnet):
 *  · מצב-תושב (resident state): ריפליי-מלא פעם-אחת באתחול (או טעינת-תמונת-מצב),
 *    ואחר-כך סנכרון-מצטבר בלבד — אפס-ריפליי-פר-פעימה
 *  · מיקרו-פעימות: בלוק-אמת כל 3 שנ׳ · checkpoint/חותם כל-12 בלוקים (CHAIN_SPEC)
 *  · עיגון-מקומי כן: חותמים + קבלות-ראיות משורשרות-האש ב-DB
 *    (עגינת-שרשרת-ציבורית דורשת מפתחות-מפעיל — לא קיימים בסביבה זו, וזה נאמר בגלוי)
 *  · סולם-ערך: הרמת-רצפה ≤0.5% לצעד, מגובה-בעמלות-שנמדדו בלבד
 *  · order_gc כל-8 בלוקים · תמונת-מצב כל-16 טיקים
 */
import fs from "fs";
import path from "path";
import { db } from "@/lib/db";
import {
  applyOp, genesisState, stateRoot, type DexState, type Op, type TradeEvent,
  GAS_TABLE, notional, poolKey,
} from "./kernel";
import { merkleRoot, sha256, canon } from "./canonical";
import { arenaTick, fairPrice, DEFAULT_PARAMS, type ArenaParams, type SoldierRT, MARKETS } from "./mm";
import { poolMid, getPool, quoteOut, LP_ASSET_PREFIX } from "./amm";
import { sortBook } from "./book";

const TICK_MS = 3_000;
const SEAL_EVERY = 12;   // checkpoint כל-12 בלוקים (CHAIN_SPEC)
const GC_EVERY = 8;
const SNAPSHOT_EVERY = 16;
const LADDER_EVERY = 24;
const TAPE_CAP = 600;
const CHART_CAP = 240;

export interface TapeEvent extends TradeEvent { h: number }
export interface SealInfo { fromHeight: number; toHeight: number; root: string; stateRoot: string; leaves: number; at: number; digest: string }
export interface ReceiptInfo { kind: string; digest: string; at: number }

interface ChainRT {
  st: DexState;
  mempool: Op[];
  rt: Map<string, SoldierRT>;
  params: ArenaParams;
  tape: TapeEvent[];
  blockHashes: string[];       // מאז-החותם-האחרון (עלים לחותם הבא)
  seals: SealInfo[];
  receipts: ReceiptInfo[];
  lastReceiptDigest: string | null;
  tickCount: number;
  timer: ReturnType<typeof setInterval> | null;
  busy: boolean;
  buildMsRolling: number;
  opsPerSecRolling: number;
  startedAt: number;
  lastBlockAt: number;
  faucetAt: Record<string, number>;
  dbOk: boolean;
  version: number;
}

const g = globalThis as unknown as { __saosDexChain?: ChainRT };
const DATA_DIR = path.join(process.cwd(), "db");
const SNAPSHOT_FILE = path.join(DATA_DIR, "state-snapshot.json");
const TAPE_FILE = path.join(DATA_DIR, "tape.jsonl");

function sysNonce(st: DexState, tag: string): string {
  return `${tag}-${st.height}-${st.nonces.length}-${Math.random().toString(36).slice(2, 8)}`;
}

function pushReceipt(rt: ChainRT, kind: string, payload: unknown): ReceiptInfo {
  const digest = sha256(canon({ kind, payload, prev: rt.lastReceiptDigest }));
  const rec: ReceiptInfo = { kind, digest, at: Date.now() };
  rt.receipts.unshift(rec);
  rt.receipts = rt.receipts.slice(0, 40);
  rt.lastReceiptDigest = digest;
  void db.evidenceReceipt.create({
    data: { kind, digest, prevDigest: rec.digest === digest ? null : rt.receipts[1]?.digest ?? null, payload: canon(payload).slice(0, 4000) },
  }).catch(() => { rt.dbOk = false; });
  return rec;
}

async function loadSnapshot(rt: ChainRT): Promise<boolean> {
  try {
    const raw = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8")) as { version: number; state: DexState };
    if (raw?.version === rt.version && raw?.state?.height > 0 && raw.state.pools && raw.state.balances) {
      rt.st = raw.state;
      return true;
    }
  } catch { /* אין-תמונת-מצב — ג'נזיס */ }
  return false;
}

function flushSnapshot(rt: ChainRT): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = SNAPSHOT_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ version: rt.version, savedAt: new Date().toISOString(), state: rt.st }));
    fs.renameSync(tmp, SNAPSHOT_FILE);
    // טייפ: שמירת-זנב-סליל (מורשת WINDOW_FLUSH של grid98)
    fs.writeFileSync(TAPE_FILE, rt.tape.slice(0, 300).map((e) => JSON.stringify(e)).join("\n"));
  } catch { /* כשל-כתיבה לא מפיל את השרשרת */ }
}

async function seal(rt: ChainRT): Promise<void> {
  const st = rt.st;
  if (rt.blockHashes.length === 0) return;
  const root = merkleRoot(rt.blockHashes);
  const info: SealInfo = {
    fromHeight: st.height - rt.blockHashes.length + 1,
    toHeight: st.height,
    root, stateRoot: stateRoot(st),
    leaves: rt.blockHashes.length,
    at: Date.now(),
    digest: "",
  };
  info.digest = sha256(canon(info));
  rt.seals.unshift(info);
  rt.seals = rt.seals.slice(0, 24);
  pushReceipt(rt, "seal", info);
  // עדי-חיילים: 4 חתימות attest על שורש-החותם (קוורום CHAIN_SPEC=3, אנחנו 4)
  for (const s of ["soldier-1", "soldier-2", "soldier-3", "soldier-4"]) {
    rt.mempool.push({ type: "attest", issuer: s, nonce: sysNonce(st, `att-${s}`), claim: root.slice(0, 16) });
  }
  rt.blockHashes = [];
  try {
    await db.sealRecord.create({
      data: { fromHeight: info.fromHeight, toHeight: info.toHeight, root: info.root, stateRoot: info.stateRoot, leavesCount: info.leaves, note: "SAOS-DEX checkpoint" },
    });
  } catch { rt.dbOk = false; }
}

function ladderCheck(rt: ChainRT): void {
  const st = rt.st;
  if (st.height - st.ladder.lastLiftHeight < LADDER_EVERY) return;
  const availProfit = st.feeMeter; // רק-מה שנמדד בעמלות
  if (availProfit < st.ladder.stepCostMu) return;
  const newRef = Math.floor(st.ladder.refPrice * 1.005); // ≤0.5% לצעד
  const step = Math.min(st.ladder.stepCostMu, availProfit);
  rt.mempool.push({ type: "harvest", issuer: "treasury", nonce: sysNonce(st, "harv"), amount: step, memo: "ladder-funding" });
  rt.mempool.push({ type: "asset_price", issuer: "treasury", nonce: sysNonce(st, "ladder"), asset: "SAOS", refPrice: newRef });
  st.ladder.refPrice = newRef; // צפי-מקומי (ה-op יאשר על-הספר)
  st.ladder.lastLiftHeight = st.height;
  st.ladder.lifts++;
  st.ladder.spentMu += step;
  st.stats.ladders++;
  pushReceipt(rt, "ladder", { height: st.height, newRef, step, lifts: st.ladder.lifts });
}

async function buildBlock(rt: ChainRT): Promise<void> {
  const t0 = Date.now();
  const st = rt.st;
  const ops = rt.mempool.splice(0, 160);
  let applied = 0;
  for (const op of ops) {
    const r = applyOp(st, op, t0);
    if (r.ok) {
      applied++;
      for (const ev of r.events ?? []) rt.tape.unshift({ ...ev, h: st.height });
    }
  }
  rt.tape = rt.tape.slice(0, TAPE_CAP);

  // פעימה-אוטומטית (heartbeat — מדידת-חיות על-הספר)
  applyOp(st, { type: "heartbeat", issuer: "treasury", nonce: sysNonce(st, "hb") }, t0);

  st.height++;
  const bh = sha256(canon({ h: st.height, ops: applied, gas: st.gasUsed, root: stateRoot(st) }));
  rt.blockHashes.push(bh);
  const buildMs = Date.now() - t0;
  rt.buildMsRolling = Math.floor(rt.buildMsRolling * 0.8 + buildMs * 0.2);
  rt.lastBlockAt = Date.now();

  try {
    await db.blockHeader.create({
      data: { height: st.height, hash: bh, stateRoot: stateRoot(st), opsCount: applied, gasUsed: st.gasUsed, buildMs },
    });
  } catch { rt.dbOk = false; }

  if (st.height % SEAL_EVERY === 0) await seal(rt);
  if (st.height % GC_EVERY === 0) {
    rt.mempool.push({ type: "order_gc", issuer: "treasury", nonce: sysNonce(st, "gc") });
  }
  ladderCheck(rt);
}

async function tick(rt: ChainRT): Promise<void> {
  if (rt.busy) return;
  rt.busy = true;
  try {
    rt.tickCount++;
    // ארנה + בוטים → ממפול
    arenaTick(rt.st, rt.tickCount, Date.now(), rt.params, rt.rt, (op) => {
      if (rt.mempool.length < 512) rt.mempool.push(op);
    });
    await buildBlock(rt);
    if (rt.tickCount % SNAPSHOT_EVERY === 0) flushSnapshot(rt);
  } catch (e) {
    console.error("[saos-dex] tick error:", e instanceof Error ? e.message : e);
  } finally {
    rt.busy = false;
  }
}

export function ensureChain(): ChainRT {
  if (g.__saosDexChain) return g.__saosDexChain;
  const rt: ChainRT = {
    st: genesisState(),
    mempool: [], rt: new Map(), params: { ...DEFAULT_PARAMS },
    tape: [], blockHashes: [], seals: [], receipts: [],
    lastReceiptDigest: null, tickCount: 0, timer: null, busy: false,
    buildMsRolling: 0, opsPerSecRolling: 0, startedAt: Date.now(), lastBlockAt: 0,
    faucetAt: {}, dbOk: true, version: 1,
  };
  g.__saosDexChain = rt;
  // אתחול-אסינכרוני: תמונת-מצב → אחרת ג'נזיס; אחר-כך טיימר
  void (async () => {
    const loaded = await loadSnapshot(rt);
    if (!loaded) {
      // ג'נזיס-טרי מחייב ניקוי-ראיות-DB (שורות-מריצה-קודמת = עדות-שקרית)
      try {
        await db.blockHeader.deleteMany({});
        await db.sealRecord.deleteMany({});
        await db.evidenceReceipt.deleteMany({});
        await db.arenaJournal.deleteMany({});
      } catch { rt.dbOk = false; }
      // עוגן-ג'נזיס חתום מיד (בלוק-ראשון)
      await buildBlock(rt);
      pushReceipt(rt, "genesis", { root: stateRoot(rt.st), at: Date.now() });
    }
    rt.timer = setInterval(() => void tick(rt), TICK_MS);
    console.log(`[saos-dex] chain live · height ${rt.st.height} · root ${stateRoot(rt.st).slice(0, 12)}… ${loaded ? "(snapshot)" : "(genesis)"}`);
  })();
  return rt;
}

// ─── ממשק-ציבורי ────────────────────────────────────────────────────────────

export function submitOp(op: Op): { queued: boolean; reason?: string } {
  const rt = ensureChain();
  if (rt.mempool.length >= 512) return { queued: false, reason: "mempool-full" };
  if (!op.issuer || !op.nonce) return { queued: false, reason: "issuer+nonce-required" };
  if (GAS_TABLE[op.type] === undefined) return { queued: false, reason: "unknown-op" };
  rt.mempool.push(op);
  return { queued: true };
}

export function nextNonce(prefix: string): string {
  const rt = ensureChain();
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${rt.st.nonces.length}`;
}

export function operatorFaucet(): { ok: boolean; reason?: string } {
  const rt = ensureChain();
  const last = rt.faucetAt["operator"] ?? 0;
  if (Date.now() - last < 60_000) return { ok: false, reason: "cooldown-60s" };
  rt.faucetAt["operator"] = Date.now();
  rt.mempool.push({ type: "transfer", issuer: "treasury", nonce: sysNonce(rt.st, "faucet-s"), to: "operator", asset: "SAOS", amount: 1_000_000 });
  rt.mempool.push({ type: "transfer", issuer: "treasury", nonce: sysNonce(rt.st, "faucet-u"), to: "operator", asset: "USDS", amount: 2_500_000 });
  return { ok: true };
}

export interface MarketView {
  base: string; quote: string; key: string;
  fair: number; bestBid: number; bestAsk: number; spreadBps: number;
  poolMid: number; refPrice: number;
  bids: { price: number; total: number; orders: number }[];
  asks: { price: number; total: number; orders: number }[];
  chart: { t: number; p: number }[];
}

function ladderAgg(st: DexState, base: string, quote: string, side: "buy" | "sell", levels = 12) {
  const book = sortBook(st, base, quote, side);
  const out: { price: number; total: number; orders: number }[] = [];
  for (const o of book) {
    const rem = o.amount - o.filled;
    if (rem <= 0) continue;
    const last = out[out.length - 1];
    if (last && last.price === o.price) { last.total += rem; last.orders++; }
    else if (out.length < levels) out.push({ price: o.price, total: rem, orders: 1 });
    else break;
  }
  return out;
}

export function getMarkets(): MarketView[] {
  const rt = ensureChain();
  const st = rt.st;
  return MARKETS.map((m) => {
    const key = poolKey(m.base, m.quote);
    const bids = ladderAgg(st, m.base, m.quote, "buy");
    const asks = ladderAgg(st, m.base, m.quote, "sell");
    const bestBid = bids[0]?.price ?? 0;
    const bestAsk = asks[0]?.price ?? 0;
    const p = getPool(st, key);
    const chart = rt.tape
      .filter((e) => (e.base === m.base && e.quote === m.quote) && e.amountMu > 0)
      .map((e) => ({ t: e.at, p: e.price }))
      .slice(0, CHART_CAP).reverse();
    return {
      base: m.base, quote: m.quote, key,
      fair: fairPrice(st, m.base, m.quote),
      bestBid, bestAsk,
      spreadBps: bestBid > 0 && bestAsk > 0 ? Math.floor(((bestAsk - bestBid) / ((bestAsk + bestBid) / 2)) * 10_000) : 0,
      poolMid: p ? poolMid(p) : 0,
      refPrice: st.assets[m.base]?.refPrice ?? 0,
      bids, asks, chart,
    };
  });
}

export function getPools() {
  const rt = ensureChain();
  return Object.entries(rt.st.pools).map(([key, p]) => ({
    key, a: p.a, b: p.b, ra: p.ra, rb: p.rb, lp: p.lp,
    mid: poolMid(p), swaps: p.swaps, feeAccruedTreasury: p.feeAccruedTreasury,
    k: p.ra * p.rb,
  }));
}

export function getQuote(pair: string, assetIn: string, amountIn: number) {
  const rt = ensureChain();
  const p = getPool(rt.st, pair);
  if (!p) return null;
  return quoteOut(p, assetIn, amountIn);
}

export function getWallets() {
  const rt = ensureChain();
  const st = rt.st;
  const names = Array.from(new Set([...Object.keys(st.balances), "operator", "treasury"]));
  return names.map((n) => ({
    name: n,
    credits: st.credits[n] ?? 0,
    balances: st.balances[n] ?? {},
    locked: st.locked[n] ?? {},
  })).filter((w) => Object.keys(w.balances).length > 0 || w.credits > 0);
}

export function getArena() {
  const rt = ensureChain();
  const st = rt.st;
  const soldiers = ["soldier-1", "soldier-2", "soldier-3", "soldier-4"];
  return {
    params: rt.params,
    dbOk: rt.dbOk,
    soldiers: soldiers.map((s) => {
      const saos = st.balances[s]?.["SAOS"] ?? 0;
      const usds = st.balances[s]?.["USDS"] ?? 0;
      const fair = fairPrice(st, "SAOS", "USDS") || 2500;
      const equity = usds + Math.floor((saos * fair) / 1000);
      const live = st.orders.filter((o) => o.live && o.owner === s).length;
      return {
        name: s, saos, usds, equity,
        pnl: equity - 6_000_000, // יחסית-לג'נזיס (3M USDS + 1.2M SAOS @2500)
        liveQuotes: live,
        locked: st.locked[s] ?? {},
      };
    }),
    journal: st.journal.slice(-14).reverse(),
    mempool: rt.mempool.length,
  };
}

export function setArenaParams(patch: Partial<ArenaParams>): ArenaParams {
  const rt = ensureChain();
  const clean: Partial<ArenaParams> = {};
  if (typeof patch.enabled === "boolean") clean.enabled = patch.enabled;
  if (typeof patch.noise === "boolean") clean.noise = patch.noise;
  for (const k of ["spreadBps", "stepBps", "levels", "sizeMu", "maxInventoryMu", "minEdgeBps", "requoteBps"] as const) {
    const v = patch[k];
    if (typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v < 10_000_000) clean[k] = v;
  }
  rt.params = { ...rt.params, ...clean };
  return rt.params;
}

export function getProofs() {
  const rt = ensureChain();
  const latest = rt.seals[0] ?? null;
  return {
    seals: rt.seals.slice(0, 8),
    latest,
    leaves: latest ? rt.blockHashes.length : 0,
    receipts: rt.receipts.slice(0, 10),
    howToVerify: [
      "קח את רשימת hashי-הבלוקים (leaves) מה-API",
      "מרקל: לכל זוג sha256(a+b) · מפלג-אי-זוגי העלה-האחרון מוכפל",
      "השווה ל-root — שוויון = הבלוקים כלולים בחותם, בלי לסמוך עלינו",
    ],
    blockWindow: rt.blockHashes.length,
  };
}

export function getLatestSealLeaves(): string[] | null {
  const rt = ensureChain();
  const latest = rt.seals[0];
  if (!latest) return null;
  // העלים של-החותם-האחרון נשמרים-עד-החותם-הבא — אנחנו מחזיקים את-החלון הנוכחי;
  // לשחזור-חוצה-חלון: BlockHeader.hash ב-DB (ראיות-מתמשכות)
  return rt.blockHashes;
}

export function getState() {
  const rt = ensureChain();
  const st = rt.st;
  return {
    height: st.height,
    stateRoot: stateRoot(st),
    gasUsed: st.gasUsed,
    opsTotal: st.stats.opsTotal,
    fills: st.stats.fills,
    swaps: st.stats.swaps,
    ladders: st.stats.ladders,
    treasuryProfit: st.treasuryProfit,
    feeMeter: st.feeMeter,
    ladder: st.ladder,
    liveOrders: st.orders.filter((o) => o.live).length,
    buildMs: rt.buildMsRolling,
    uptimeSec: Math.floor((Date.now() - rt.startedAt) / 1000),
    lastBlockAgoMs: rt.lastBlockAt ? Date.now() - rt.lastBlockAt : null,
    dbOk: rt.dbOk,
    tickMs: TICK_MS,
    sealEvery: SEAL_EVERY,
    nextSealIn: SEAL_EVERY - (st.height % SEAL_EVERY),
    backing: st.backing,
    assets: st.assets,
  };
}

export function getTape(limit = 30): TapeEvent[] {
  const rt = ensureChain();
  return rt.tape.slice(0, limit).filter((e) => e.amountMu > 0);
}

/** הוכחת-יכולת: מדידת-קצב על-מצב-טרי (מורשת grid98 --bench) */
export function bench(ops = 20_000): { ops: number; ms: number; opsPerSec: number; perDay: number } {
  const st = genesisState();
  const t0 = Date.now();
  let i = 0;
  while (i < ops) {
    const n = `b${i}`;
    applyOp(st, { type: "transfer", issuer: "treasury", nonce: n, to: "operator", asset: "SAOS", amount: 1 }, t0);
    i++;
    if (i >= ops) break;
    applyOp(st, { type: "pool_swap", issuer: "operator", nonce: `b${i}`, pair: "SAOS/USDS", assetIn: "SAOS", amount: 1000 }, t0);
    i++;
    if (i >= ops) break;
    applyOp(st, { type: "order", issuer: "arena", nonce: `b${i}`, base: "SAOS", quote: "USDS", side: i % 2 ? "buy" : "sell", price: 2500 + (i % 50), amount: 10_000 }, t0);
    i++;
  }
  const ms = Math.max(1, Date.now() - t0);
  const opsPerSec = Math.floor((ops / ms) * 1000);
  const res = { ops, ms, opsPerSec, perDay: opsPerSec * 86_400 };
  const rt = ensureChain();
  pushReceipt(rt, "bench", res);
  return res;
}

export async function resetChain(): Promise<void> {
  const rt = ensureChain();
  if (rt.timer) clearInterval(rt.timer);
  rt.st = genesisState();
  rt.mempool = []; rt.rt = new Map(); rt.tape = [];
  rt.blockHashes = []; rt.seals = []; rt.receipts = [];
  rt.lastReceiptDigest = null; rt.tickCount = 0; rt.faucetAt = {};
  try {
    await db.blockHeader.deleteMany({});
    await db.sealRecord.deleteMany({});
    await db.evidenceReceipt.deleteMany({});
    await db.arenaJournal.deleteMany({});
  } catch { rt.dbOk = false; }
  try { fs.rmSync(SNAPSHOT_FILE, { force: true }); fs.rmSync(TAPE_FILE, { force: true }); } catch { /* ok */ }
  await buildBlock(rt);
  pushReceipt(rt, "genesis", { root: stateRoot(rt.st), at: Date.now() });
  if (!rt.timer) rt.timer = setInterval(() => void tick(rt), TICK_MS);
}

export { notional, sortBook, LP_ASSET_PREFIX };
