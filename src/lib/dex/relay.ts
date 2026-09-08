/* relay.ts — "הדלת" — עיגון חותמות SAOS-DEX לשרשראות ציבוריות. · מהדורה-מוסדית
 *
 * מאזין ל-seal() (כל 12 בלוקים), לוקח stateRoot + height, ומשדר custom_json
 * (סמכות active, אפס-עלות — RC) ל-Steem + Hive, וכן עיגון TRON מותנה-מימון.
 *
 * מורשת anchor.cjs / chain_attest.cjs (Task 44/82/89/99 — 64 עיגונים חיים):
 *   · חתימה מקומית: build tx ← dgp, sign (steem.auth, chain_id דינמי), שידור-סינכרוני
 *   · Steem: chain_id אפסים · Hive: beeab0de… · אותו ACTIVE_WIF (הוכח קריפטוגרפית)
 *   · TRON: זהות נגזרת מאותו סקלר secp256k1 — מותנה במימון (כנות: ללא TRX אין שידור)
 *
 * הקשחה-מוסדית (מהדורה זו):
 *   · Circuit Breaker per-chain: כשלים-רצופים קשים → OPEN (הפסקת-ניסיונות) →
 *     half-open (פרובה-יחידה) → הצלחה → CLOSED. תנאי-תקציב (RC-low/unfunded)
 *     אינו כשל-מערכת ואינו סופר ל-breaker.
 *   · Exponential backoff עם jitter (±20%) — לא-דת-מאמץ-תזמון.
 *   · verifyOnChain: אחרי-קבלת-txid — קריאה-חוזרת מה-RPC הציבורי, השוואת
 *     stateRoot+height מול-המקומי. אי-התאמה → ALERT בלוג + מדד-מיסמאץ'.
 *   · Reconciliation: לולאה-תקופתית מאמתת-בדיעבד כל-עיגון ששודר וטרם-אומת.
 *   · אפס סודות בלוגים/פלט/קבצים: מפתחות בזיכרון בלבד מ-.env (gitignored, אומת)
 */
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import type { SealInfo } from "./chain";
import { chaosPartitioned } from "./chaos";

import steemLib from "steem";
import { ethSealBroadcast, verifyEthAnchor, ethIdentity, signEthAnchor } from "./relay-eth";
import { solSealBroadcast, verifySolAnchor, solIdentity } from "./relay-sol";

type GrapheneTx = {
  ref_block_num: number;
  ref_block_prefix: number;
  expiration: string;
  operations: unknown[];
  extensions: unknown[];
};

type SteemLib = {
  config: { get(k: string): string | null; set(k: string, v: string): void };
  auth: { signTransaction(tx: GrapheneTx, keys: string[]): GrapheneTx & { signatures?: string[] } };
};

const steem = steemLib as unknown as SteemLib;
const ZERO_CHAIN_ID = "0000000000000000000000000000000000000000000000000000000000000000";

/* ── קבועים ── */
export const ANCHOR_ID = "saos-dex.anchor.v1";
const HIVE_CHAIN_ID = "beeab0de00000000000000000000000000000000000000000000000000000000";
const STEEM_NODES = ["https://api.steemit.com", "https://api.justyy.com"];
const HIVE_NODES = ["https://api.hive.blog", "https://api.deathwing.me"];
const TRON_RPC = "https://api.trongrid.io";
const RC_MIN = 1_000_000;          // מינימום-שמרטות לפני שידור (custom_json ~190B « 1M)
const RETRY_MAX = 6;
const QUEUE_CAP = 8;

/* Circuit breaker — ספי-מוסד */
const BREAKER_THRESHOLD = 4;        // כשלים-קשים-רצופים → OPEN
const BREAKER_COOLDOWN_MS = 5 * 60_000; // OPEN → half-open (פרובה-יחידה)

/* Verification / reconciliation */
const VERIFY_DELAY_MS = 4_000;      // זמן-התייצבות-אינדוקס אחרי-שידור-סינכרוני
const VERIFY_TRIES = 4;
const VERIFY_GAP_MS = 6_000;
const RECONCILE_EVERY_MS = 90_000;  // לולאת-פיוס תקופתית
const RECONCILE_FIRST_MS = 8_000;   // מחזור-ראשון — מיד-אחרי-עלייה (ריפוי-שאריות)
const RECONCILE_BATCH = 3;          // עד-3 אימותים-בדיעבד למחזור

/* ── סוגים ── */
export type ChainName = "steem" | "hive" | "tron" | "eth" | "sol";
const ALL_CHAINS: ChainName[] = ["steem", "hive", "tron", "eth", "sol"];
/* עיגון-כבד (gas/SOL) ועיגון-RC — רק החותם-החדש-ביותר מעוגן עליהם */
const LATEST_ONLY: ChainName[] = ["hive", "tron", "eth", "sol"];
/* המתנה-כלכלית: RC מתחדש מהר; מימון (TRX/gas/SOL) הוא אירוע-תפעולי איטי */
const econWaitMin = (c: ChainName): number => (c === "steem" || c === "hive" ? 20 : 30);
export type AnchorStatus = "anchored" | "sent-unconfirmed" | "pending" | "failed";
export type BreakerState = "closed" | "open" | "half-open";

export interface AnchorRecord {
  chain: ChainName;
  height: number;
  stateRoot: string;
  digest: string;
  txid: string | null;
  status: AnchorStatus;
  at: string;
  attempt: number;
  verified: boolean | null;   // null = טרם-נבדק · true = אומת ב-RPC · false = מיסמאץ'
  verifiedAt: string | null;
  error?: string;
}

export interface BreakerView {
  state: BreakerState;
  failures: number;
  openedAt: number | null;
  trips: number;
}

export interface RelayChainState {
  enabled: boolean;
  status: AnchorStatus | "idle" | "disabled";
  lastTxid: string | null;
  lastHeight: number | null;
  lastAt: string | null;
  lastError: string | null;
  lastVerifyError: string | null;
  anchored: number;
  verified: number;
  mismatches: number;
  breaker: BreakerView;
}

interface RelayMetrics {
  broadcasts: number;
  verified: number;
  mismatches: number;
  breakerTrips: number;
  economicWaits: number;
  lastVerifyLatencyMs: number | null;
}

interface ChainJobState { attempts: number; rcWaits: number; nextTryAt: number; done: boolean }
interface SealJob {
  info: SealInfo;
  at: string;
  chains: Record<ChainName, ChainJobState>;
}

interface RelayRT {
  jobs: SealJob[];
  processing: boolean;
  records: AnchorRecord[];
  chainState: Record<ChainName, RelayChainState>;
  metrics: RelayMetrics;
  account: string | null;
  tronAddress: string | null;
  ethAddress: string | null;   // זהות-הצי idx=2 (מאומתת מול-ETH_EXPECTED_ADDRESS)
  solAddress: string | null;   // זהות-הצי idx=2 (מאומתת מול-SOL_EXPECTED_ADDRESS)
  ethIntents: { height: number; intentHash: string; signature: string; address: string; verified: boolean }[]; // כוונות-EIP-191 (אפס-גז)
  startedAt: number;
  lastActivityAt: number;
  reconcileStarted: boolean;
}

const g = globalThis as unknown as { __saosDexRelay?: RelayRT };
/* הפרדת-מצב: כלי-בדיקה (scripts/chaos-test.ts) מכוון SAOS_DEX_STATE_DIR לתיקיית-זמן —
 * כך ראיות-בדיקה לעולם לא נוגעות ב-state/anchors.json הציבורי של הדמון החי */
const STATE_DIR = process.env.SAOS_DEX_STATE_DIR
  ? path.resolve(process.env.SAOS_DEX_STATE_DIR)
  : path.join(process.cwd(), "state");
const ANCHORS_FILE = path.join(STATE_DIR, "anchors.json");

/* ── מפתחות: זיכרון-בלבד מ-.env (Next טוען אוטומטית; הקובץ gitignored-אומת) ── */
function loadKeys(): { account: string; steemWif: string; hiveAccount: string; hiveWif: string; ethKey: string | null; solKey: string | null; ethExpected: string | null; solExpected: string | null } | null {
  const account = (process.env.SAOS_RELAY_AGENT_ACCOUNT || "").toLowerCase().trim();
  const steemWif = (process.env.STEEM_ACTIVE_WIF || "").trim();
  const hiveWif = (process.env.HIVE_ACTIVE_WIF || "").trim();
  if (!account || !steemWif || !hiveWif) return null;
  // אפשרות-עוגן-Hive נפרד (חשבון-צבא עם RC גבוה) — ברירת-מחדל: אותה זהות
  const hiveAccount = (process.env.HIVE_ANCHOR_ACCOUNT || account).toLowerCase().trim();
  // ETH/SOL: זהויות-צי (wallets-registry) — אופציונליות; כשקיימות, ה-Relay חמוש
  // (signing-חי מקומי) והשידור נעול-מימון עד-שהכתובות ימומנו (כנות)
  const ethKey = (process.env.ETH_PRIVATE_KEY || "").trim() || null;
  const solKey = (process.env.SOL_PRIVATE_KEY || "").trim() || null;
  const ethExpected = (process.env.ETH_EXPECTED_ADDRESS || "").trim() || null;
  const solExpected = (process.env.SOL_EXPECTED_ADDRESS || "").trim() || null;
  return { account, steemWif, hiveAccount, hiveWif, ethKey, solKey, ethExpected, solExpected };
}

async function bs58lib(): Promise<{ decode(s: string): Uint8Array; encode(b: Uint8Array): string }> {
  const m = (await import("bs58")) as unknown as { default: { decode(s: string): Uint8Array; encode(b: Uint8Array): string } };
  return m.default;
}

/* ── זהות-TRON מהסקלר (פלט-ציבורי בלבד) ── */
async function tronIdentity(wif: string): Promise<string | null> {
  try {
    const [{ secp256k1 }, { keccak_256 }, b58] = await Promise.all([
      import("@noble/curves/secp256k1"),
      import("@noble/hashes/sha3"),
      bs58lib(),
    ]);
    const raw = Buffer.from(b58.decode(wif));
    const data = raw.subarray(0, raw.length - 4);
    const priv = data.subarray(1, 33);
    const pub65 = Buffer.from(secp256k1.getPublicKey(priv, false));
    const h = keccak_256(pub65.subarray(1));
    const payload = Buffer.concat([Buffer.from([0x41]), Buffer.from(h.subarray(12))]);
    const sh1 = createHash("sha256").update(payload).digest();
    const chk = createHash("sha256").update(sh1).digest().subarray(0, 4);
    return b58.encode(Buffer.concat([payload, chk]));
  } catch {
    return null;
  }
}

async function scalarOf(wif: string): Promise<Uint8Array> {
  const b58 = await bs58lib();
  const raw = Buffer.from(b58.decode(wif));
  const data = raw.subarray(0, raw.length - 4);
  return data.subarray(1, 33);
}

/* ── JSON-RPC ── */
async function rpc<T>(endpoint: string, body: unknown, timeoutMs = 20000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
    const json = (await res.json()) as { result?: T; error?: { message?: string } };
    if (json.error) throw new Error(json.error.message || "rpc error");
    return json.result as T;
  } finally {
    clearTimeout(t);
  }
}

async function dgp(endpoint: string) {
  return rpc<{ head_block_number: number; head_block_id: string; time: string }>(endpoint, {
    jsonrpc: "2.0", method: "condenser_api.get_dynamic_global_properties", params: [], id: 1,
  });
}

async function rcMana(endpoint: string, account: string): Promise<number | null> {
  try {
    const r = await rpc<{ rc_accounts: { rc_manabar: { current_mana: string } }[] }>(endpoint, {
      jsonrpc: "2.0", method: "rc_api.find_rc_accounts", params: { accounts: [account] }, id: 1,
    }, 12000);
    return Number(r.rc_accounts?.[0]?.rc_manabar?.current_mana) || 0;
  } catch {
    return null; // צומת-לא זמין — לא חוסם (שער רק כשיש מדידה)
  }
}

/* ── op טרי לכל שידור (signTransaction מוטט את האובייקט — מורשת anchor.cjs) ── */
function buildOp(account: string, payload: unknown): [string, Record<string, unknown>] {
  return ["custom_json", {
    required_auths: [account],
    required_posting_auths: [],
    id: ANCHOR_ID,
    json: JSON.stringify(payload),
  }];
}

/* ── שידור-גרפני אחיד: build ← sign(chain_id) ← broadcast_transaction_synchronous ── */
async function grapheneSealBroadcast(node: string, chainId: string, account: string, payload: unknown, wif: string) {
  const d = await dgp(node);
  const tx: GrapheneTx = {
    ref_block_num: d.head_block_number & 0xffff,
    ref_block_prefix: Buffer.from(d.head_block_id, "hex").readUInt32LE(4),
    expiration: new Date(new Date(d.time + "Z").getTime() + 60000).toISOString().slice(0, 19),
    operations: [buildOp(account, payload)],
    extensions: [],
  };
  const prev = steem.config.get("chain_id");
  steem.config.set("chain_id", chainId);
  let signed: GrapheneTx & { signatures?: string[] };
  try {
    signed = steem.auth.signTransaction(tx, [wif]);
  } finally {
    try { steem.config.set("chain_id", prev ?? ZERO_CHAIN_ID); } catch { /* keep */ }
  }
  const res = await rpc<{ id?: string; block_num?: number }>(node, {
    jsonrpc: "2.0", method: "condenser_api.broadcast_transaction_synchronous", params: [{ ...signed }], id: 1,
  });
  if (res && res.id) return { txid: res.id, block: res.block_num ?? null, confirmed: true };
  throw new Error("sync-broadcast answered without id (honest)");
}

/* ── TRON: עיגון מותנה-מימון (self-transfer 1 sun + extra_data = digest) ── */
async function tronSealBroadcast(tronAddress: string, digest: string, wif: string): Promise<{ txid: string }> {
  const acc = await fetch(`${TRON_RPC}/v1/accounts/${tronAddress}`, { signal: AbortSignal.timeout(12000) }).then((r) => r.json()) as { data: { balance?: number }[] };
  const balance = acc?.data?.[0]?.balance ?? 0;
  if (balance < 300_000) throw new Error(`unfunded: ${balance} sun (<0.3 TRX bandwidth floor) — queued honestly`);

  const [{ secp256k1 }, b58] = await Promise.all([import("@noble/curves/secp256k1"), bs58lib()]);
  const raw58 = Buffer.from(b58.decode(tronAddress));
  const hex20 = raw58.subarray(1, 21).toString("hex");
  const built = await rpc<{ txID?: string; raw_data_hex?: string }>(`${TRON_RPC}/wallet/createtransaction`, {
    to_address: hex20, owner_address: hex20, amount: 1, extra_data: Buffer.from(digest, "utf8").toString("hex"),
  }, 15000);
  if (!built?.txID || !built?.raw_data_hex) throw new Error("createtransaction answered without txID/raw_data_hex");

  const priv = await scalarOf(wif);
  const msg = Buffer.from(built.txID, "hex");
  const sig = secp256k1.sign(msg, priv, { prehash: false });
  const compact = sig.toCompactRawBytes();
  const sigBytes = new Uint8Array(65);
  sigBytes[0] = sig.recovery ?? 0;
  sigBytes.set(compact, 1);
  const res = await rpc<{ result?: boolean; txid?: string; message?: string }>(`${TRON_RPC}/wallet/broadcasttransaction`, {
    txID: built.txID, raw_data_hex: built.raw_data_hex, signature: [Buffer.from(sigBytes).toString("hex")],
  }, 15000);
  if (res?.result && res?.txid) return { txid: res.txid };
  throw new Error("tron broadcast rejected: " + (res?.message ? Buffer.from(res.message, "hex").toString("utf8").slice(0, 120) : "unknown"));
}

/* ══ verifyOnChain — קריאה-חוזרת מה-RPC הציבורי והשוואת stateRoot ════════════
 * SECURITY INTENT: זו עמוד-התווך של אמון-אפס בעצמנו — כל-txid שה-Relay שידר
 * נקרא חזרה מתשתית-ציבורית בלתי-תלויה, ומושווה ביט-מול-ביט מול-המקומי.
 * אי-התאמה = עדות לשחיתות-מצב, עדכון-מטעה או פגיעה-חתימה — ולכן היא נחסמת
 * מלהיחשב "מאומת", נרשמת כ-mismatch במדדים ומדליקה ALERT מיידי ללוג.
 * Steem/Hive: condenser_api.get_transaction(txid) → custom_json(ANCHOR_ID) →
 *             השוואת height+stateRoot מול-החותם המקומי.
 * TRON:       gettransactioninfobyid (אישור-בלוק) + gettransactionbyid
 *             (extra_data מכיל את ה-digest).
 * תשובה: { ok, detail } — ok=false עם detail="not indexed" = נסיון-חוזר מותר
 * (ואינו מיסמאץ' — הרשומה נשארת null ונכנסת לתור-הפיוס).
 */
export async function verifyOnChain(
  chain: ChainName,
  txid: string,
  expected: { height: number; stateRoot: string }
): Promise<{ ok: boolean; detail: string }> {
  // chaos-gate: מחיצה-מוזרקת מדמה ניתוק-RPC מלא — גם על נתיב-הקריאה (אמת-היקף-התקלה)
  if (chaosPartitioned(chain)) return { ok: false, detail: "not indexed: injected network partition (chaos)" };
  if (chain === "eth") {
    return verifyEthAnchor(txid, expected, rtInit().ethAddress);
  }
  if (chain === "sol") {
    return verifySolAnchor(txid, expected);
  }
  if (chain === "tron") {
    const info = await rpc<{ blockNumber?: number; receipt?: { status?: string } }>(
      `${TRON_RPC}/wallet/gettransactioninfobyid`, { value: txid, visible: true }, 15000,
    ).catch(() => null);
    if (!info?.blockNumber) return { ok: false, detail: "not indexed: tron tx awaiting block" };
    const tx = await rpc<{ raw_data?: { extra_data?: string[] } }>(
      `${TRON_RPC}/wallet/gettransactionbyid`, { value: txid, visible: true }, 15000,
    ).catch(() => null);
    const extra = tx?.raw_data?.extra_data?.[0];
    if (!extra) return { ok: true, detail: `confirmed in block ${info.blockNumber} · extra_data not surfaced by node` };
    const payload = Buffer.from(extra, "hex").toString("utf8");
    if (payload.includes(expected.stateRoot)) return { ok: true, detail: `confirmed in block ${info.blockNumber} · extra_data stateRoot match` };
    return { ok: false, detail: `mismatch: extra_data on-chain lacks local stateRoot ${expected.stateRoot.slice(0, 12)}…` };
  }

  const nodes = chain === "steem" ? STEEM_NODES : HIVE_NODES;
  for (const node of nodes) {
    const tx = await rpc<{ operations?: unknown[] }>(node, {
      jsonrpc: "2.0", method: "condenser_api.get_transaction", params: [txid], id: 1,
    }, 15000).catch(() => null);
    if (!tx || !Array.isArray(tx.operations)) continue;
    for (const entry of tx.operations as [string, Record<string, unknown>][]) {
      const [opName, opBody] = entry;
      if (opName !== "custom_json" || opBody?.id !== ANCHOR_ID) continue;
      let parsed: { height?: number; stateRoot?: string };
      try { parsed = JSON.parse(String(opBody.json)) as { height?: number; stateRoot?: string }; }
      catch { return { ok: false, detail: "mismatch: on-chain custom_json unparseable" }; }
      const rootOk = parsed.stateRoot === expected.stateRoot;
      const heightOk = parsed.height === expected.height;
      if (rootOk && heightOk) return { ok: true, detail: `stateRoot verified on ${chain} via ${new URL(node).host}` };
      return {
        ok: false,
        detail: `mismatch: on-chain h${parsed.height ?? "?"}/${String(parsed.stateRoot ?? "?").slice(0, 12)}… vs local h${expected.height}/${expected.stateRoot.slice(0, 12)}…`,
      };
    }
    return { ok: false, detail: `mismatch: tx found but no ${ANCHOR_ID} op inside` };
  }
  return { ok: false, detail: "not indexed: no node returned the transaction yet" };
}

/* ── Circuit breaker ── */
function mkBreaker(): BreakerView { return { state: "closed", failures: 0, openedAt: null, trips: 0 }; }

function breakerAllows(b: BreakerView): boolean {
  if (b.state === "closed") return true;
  if (b.state === "open") {
    if (b.openedAt !== null && Date.now() - b.openedAt >= BREAKER_COOLDOWN_MS) {
      b.state = "half-open"; // פרובה-יחידה תיכף
      return true;
    }
    return false;
  }
  return true; // half-open — מתיר ניסיון-בדיקה (התור טורי, אין-סערת-פרובות)
}

function breakerOnSuccess(b: BreakerView): void {
  b.failures = 0;
  b.openedAt = null;
  b.state = "closed";
}

function breakerOnFailure(rt: RelayRT, chain: ChainName): void {
  const b = rt.chainState[chain].breaker;
  b.failures += 1;
  if (b.state === "half-open" || b.failures >= BREAKER_THRESHOLD) {
    if (b.state !== "open") {
      b.trips += 1;
      rt.metrics.breakerTrips += 1; // מדד-גלובלי — חייב לנוע עם-הפסקה (נקודת-תצפית מוסדית)
    }
    b.state = "open";
    b.openedAt = Date.now();
    // ALERT — מוסדי: פתיחת-breaker היא אירוע-רעש-גבוה
    console.error(`[saos-relay][ALERT] circuit-breaker OPEN on ${chain} · ${b.failures} consecutive hard failures · probe in ${BREAKER_COOLDOWN_MS / 60_000}min`);
  }
}

/* ── backoff אקספוננציאלי עם jitter (±20%) ── */
function backoffMs(attempt: number): number {
  const base = Math.min(20_000 * Math.pow(2, attempt - 1), 15 * 60_000);
  return Math.floor(base * (0.8 + Math.random() * 0.4));
}

/* ── רישום-ציבורי (state/anchors.json — הוכחות בלבד, אפס סודות) ── */
function upsertRecord(rt: RelayRT, rec: AnchorRecord): void {
  const i = rt.records.findIndex((r) => r.chain === rec.chain && r.height === rec.height && r.at === rec.at);
  if (i >= 0) rt.records[i] = { ...rt.records[i], ...rec };
  else rt.records.unshift(rec);
  rt.records = rt.records.slice(0, 60);
}

function persist(rt: RelayRT): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const chainOut = (ALL_CHAINS as ChainName[]).map((c) => {
      const last = rt.records.find((r) => r.chain === c);
      const anchored = rt.records.find((r) => r.chain === c && r.status === "anchored");
      const EXPLORER: Record<ChainName, (id: string) => string> = {
        steem: (id) => `https://steemworld.org/tx/${id}`,
        hive: (id) => `https://hiveblocks.com/tx/${id}`,
        tron: (id) => `https://tronscan.org/#/transaction/${id}`,
        eth: (id) => `https://etherscan.io/tx/${id}`,
        sol: (id) => `https://solscan.io/tx/${id}`,
      };
      const link = anchored?.txid ? EXPLORER[c](anchored.txid) : null;
      return [c, {
        status: rt.chainState[c].status,
        // כשאין-txid והחוסם-הוא-מימון — הסטטוס-הכן "pending funding (armed)"
        pendingFunding: rt.chainState[c].enabled && /unfunded/i.test(rt.chainState[c].lastError ?? ""),
        account: c === "steem" ? rt.account : c === "eth" ? rt.ethAddress : c === "sol" ? rt.solAddress : (loadKeys()?.hiveAccount ?? rt.account),
        lastTxid: last?.txid ?? null,
        lastHeight: last?.height ?? null,
        lastAt: last?.at ?? null,
        lastAnchoredTxid: anchored?.txid ?? null,
        anchored: rt.chainState[c].anchored,
        verified: rt.chainState[c].verified,
        mismatches: rt.chainState[c].mismatches,
        breaker: rt.chainState[c].breaker,
        explorer: link,
        lastError: rt.chainState[c].lastError,
        lastVerifyError: rt.chainState[c].lastVerifyError,
      }];
    });
    const out = {
      updatedAt: new Date().toISOString(),
      anchorId: ANCHOR_ID,
      account: rt.account,
      tronIdentity: rt.tronAddress,
      chains: Object.fromEntries(chainOut),
      totals: {
        anchored: (ALL_CHAINS as ChainName[]).reduce((a, c) => a + rt.chainState[c].anchored, 0),
        verified: rt.metrics.verified,
        mismatches: rt.metrics.mismatches,
        records: rt.records.length,
      },
      records: rt.records.slice(0, 30),
    };
    const tmp = ANCHORS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n");
    fs.renameSync(tmp, ANCHORS_FILE);
  } catch { /* כשל-כתיבה לא מפיל את ה-Relay */ }
}

/* ── אימות-בדיעבד של-txid יחיד (מעדכן רשומה+מדדים; לא-חוסם, לא-זורק) ── */
async function verifyRecord(rt: RelayRT, rec: AnchorRecord): Promise<void> {
  if (!rec.txid) return;
  const t0 = Date.now();
  let last = { ok: false, detail: "unverified" };
  for (let i = 0; i < VERIFY_TRIES; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, VERIFY_GAP_MS));
    try {
      last = await verifyOnChain(rec.chain, rec.txid, { height: rec.height, stateRoot: rec.stateRoot });
    } catch (e) {
      last = { ok: false, detail: String((e as Error)?.message || e).slice(0, 120) };
    }
    if (last.ok || !last.detail.startsWith("not indexed")) break;
  }
  rec.verifiedAt = new Date().toISOString();
  rt.metrics.lastVerifyLatencyMs = Date.now() - t0;
  const indexed = !last.detail.startsWith("not indexed");
  // "טרם-נוכח באינדקס" אינו מיסמאץ' — הרשומה נשארת null ונכנסת לתור-הפיוס (reconcile)
  rec.verified = indexed ? last.ok : null;
  if (!indexed) rec.verifiedAt = null;
  if (last.ok) {
    rt.metrics.verified += 1;
    rt.chainState[rec.chain].verified += 1;
    rt.chainState[rec.chain].lastVerifyError = null;
  } else {
    if (!last.detail.startsWith("not indexed")) {
      rt.metrics.mismatches += 1;
      rt.chainState[rec.chain].mismatches += 1;
      rt.chainState[rec.chain].lastVerifyError = last.detail;
      rec.error = last.detail.slice(0, 180); // הרשומה נושאת-את-הפירוט (ראיה-ציבורית)
      // ALERT — אי-התאמה בין השרשרת-הציבורית למקומי הוא אירוע-חמור
      console.error(`[saos-relay][ALERT] ${rec.chain} h${rec.height} stateRoot verification FAILED · ${last.detail}`);
    }
  }
  upsertRecord(rt, rec);
  persist(rt);
}

function scheduleVerification(rt: RelayRT, rec: AnchorRecord): void {
  void (async () => {
    await new Promise((r) => setTimeout(r, VERIFY_DELAY_MS));
    try { await verifyRecord(rt, rec); } catch { /* לא-חוסם */ }
  })();
}

/* ── Reconciliation: פיוס-תקופתי — כל-עיגון ששודר וטרם-אומת עובר קריאה-חוזרת ── */
function startReconciler(rt: RelayRT): void {
  if (rt.reconcileStarted) return;
  rt.reconcileStarted = true;
  const loop = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, RECONCILE_FIRST_MS)); // מחזור-ראשון מהיר — ריפוי-שאריות מיד
    try {
      const due = rt.records.filter((r) => r.status === "anchored" && r.verified === null && r.txid).slice(0, RECONCILE_BATCH);
      for (const rec of due) {
        try { await verifyRecord(rt, rec); } catch { /* לא-חוסם */ }
      }
    } finally {
      void loop();
    }
  };
  void loop();
}

/* ── עיבוד-תור (לא-חוסם; breaker + backoff-עם-jitter; מצב per-chain) ── */
async function attemptChain(rt: RelayRT, keys: NonNullable<ReturnType<typeof loadKeys>>, job: SealJob, chain: ChainName): Promise<void> {
  const cs = job.chains[chain];
  const b = rt.chainState[chain].breaker;
  if (!breakerAllows(b)) {
    cs.nextTryAt = (b.openedAt ?? Date.now()) + BREAKER_COOLDOWN_MS + 1000; // ה-breaker סגור — נחכה-לפרובה
    return;
  }
  cs.attempts += 1;
  const anchorAccount = chain === "steem" ? keys.account : keys.hiveAccount;
  const rec: AnchorRecord = {
    chain, height: job.info.toHeight, stateRoot: job.info.stateRoot, digest: job.info.digest,
    txid: null, status: "pending", at: job.at, attempt: cs.attempts,
    verified: null, verifiedAt: null,
  };
  try {
    /* chaos-gate — scripts/chaos-test.ts: מחיצת-רשת מוזרקת בתוך-נתיב-הכשל הרגיל.
     * SECURITY INTENT: הזריקה חייבת לעבור בדיוק כמו RPC בלתי-נגיש — catch →
     * breakerOnFailure (בניגוד לתנאי-תקציב) → backoff → רשומה כנה. אינרטי
     * בפרודקשן: chaosPartitioned === false תמיד, אלא אם כלי-בדיקה חימם אותו. */
    if (chaosPartitioned(chain)) {
      throw new Error(`chaos: injected network partition on ${chain} — rpc unreachable (fault-injection)`);
    }
    // payload קנוני משותף לכל-השרשראות — אותם בייטים על כל שרשרת (עיגון-עצמו-עקבי)
    const payload = {
      protocol: "saos-dex/v1", action: "chain-seal", at: job.at,
      height: job.info.toHeight, stateRoot: job.info.stateRoot, digest: job.info.digest,
    };
    if (chain === "tron") {
      if (!rt.tronAddress) rt.tronAddress = await tronIdentity(keys.steemWif);
      if (!rt.tronAddress) throw new Error("tron identity derivation failed");
      const r = await tronSealBroadcast(rt.tronAddress, job.info.digest, keys.steemWif);
      rec.txid = r.txid;
      rec.status = "anchored";
    } else if (chain === "eth") {
      if (!keys.ethKey) throw new Error("eth key missing (disabled)");
      if (!rt.ethAddress) {
        const id = ethIdentity(keys.ethKey);
        if (keys.ethExpected && id.address.toLowerCase() !== keys.ethExpected.toLowerCase()) {
          rt.chainState.eth.enabled = false; // fail-closed — זהות שונה מהמניפסט-המעוגן
          throw new Error("eth identity mismatch: derived address != expected (fail-closed, disabled)");
        }
        rt.ethAddress = id.address;
        console.info(`[saos-relay] eth identity armed: ${id.address} (EIP-191 intents + funded broadcast)`);
      }
      // טירה-1: כוונת-עיגון חתומה EIP-191 — אפס-גז, ראיה-קריפטוגרפית תמידית
      const intent = signEthAnchor(payload, keys.ethKey);
      rt.ethIntents.unshift({ height: job.info.toHeight, intentHash: intent.intentHash, signature: intent.signature, address: intent.address, verified: intent.verified });
      rt.ethIntents = rt.ethIntents.slice(0, 12);
      // טירה-2: שידור-חי — נעול-מימון עד-שהכתובת תמומן (unfunded → המתנה-כלכלית כנה)
      const r = await ethSealBroadcast(payload, keys.ethKey);
      rec.txid = r.txid;
      rec.status = "anchored";
    } else if (chain === "sol") {
      if (!keys.solKey) throw new Error("sol key missing (disabled)");
      if (!rt.solAddress) {
        const id = solIdentity(keys.solKey);
        if (keys.solExpected && id.address !== keys.solExpected) {
          rt.chainState.sol.enabled = false; // fail-closed — זהות שונה מהמניפסט-המעוגן
          throw new Error("sol identity mismatch: derived address != expected (fail-closed, disabled)");
        }
        rt.solAddress = id.address;
        console.info(`[saos-relay] sol identity armed: ${id.address} (SPL-memo anchoring, fee-gated)`);
      }
      const r = await solSealBroadcast(payload, keys.solKey);
      rec.txid = r.txid;
      rec.status = "anchored";
    } else {
      const nodes = chain === "steem" ? STEEM_NODES : HIVE_NODES;
      const chainId = chain === "steem" ? ZERO_CHAIN_ID : HIVE_CHAIN_ID;
      const wif = chain === "steem" ? keys.steemWif : keys.hiveWif;
      if (cs.attempts === 1) {
        const mana = await rcMana(nodes[0], anchorAccount);
        if (mana !== null && mana < RC_MIN) throw new Error(`rc-low: ${mana} < ${RC_MIN} — waiting (honest retry)`);
      }
      // payload מכווץ — RC-תודעתי (כל בייט = כ-580K RC על Hive)
      const r = await grapheneSealBroadcast(nodes[0], chainId, anchorAccount, payload, wif);
      rec.txid = r.txid;
      rec.status = "anchored";
    }
  } catch (e) {
    const msg = String((e as Error)?.message || e).slice(0, 180);
    const economic = /rc-low|has not enough RC|unfunded/i.test(msg);
    if (economic) {
      // חוסר-תקציב = המתנה כלכלית כנה — לא כשל-מערכת (לא נספר ל-breaker); בדיקה-מחדש תקופתית
      cs.attempts = 0;
      cs.rcWaits += 1;
      rt.metrics.economicWaits += 1;
      rec.status = "pending";
      rec.attempt = cs.rcWaits;
      cs.nextTryAt = Date.now() + econWaitMin(chain) * 60_000;
      if (cs.rcWaits > 48) { rec.status = "failed"; cs.done = true; rec.error = msg + " · budget-wait expired (honest)"; }
      else rec.error = msg;
      rt.chainState[chain].lastError = msg;
    } else {
      breakerOnFailure(rt, chain); // כשל-קשי — נספר ל-breaker (עלול לפתוח אותו)
      if (cs.attempts >= RETRY_MAX) {
        rec.status = "failed";
        cs.done = true;
      } else {
        rec.status = "pending";
        cs.nextTryAt = Date.now() + backoffMs(cs.attempts);
      }
      rec.error = msg;
      rt.chainState[chain].lastError = msg;
    }
  }
  upsertRecord(rt, rec);
  if (rec.status !== "pending") cs.done = true;
  rt.chainState[chain].status = rec.status;
  rt.chainState[chain].lastTxid = rec.txid ?? rt.chainState[chain].lastTxid;
  rt.chainState[chain].lastHeight = rec.height;
  rt.chainState[chain].lastAt = rec.at;
  if (rec.status === "anchored") {
    breakerOnSuccess(b);
    rt.chainState[chain].anchored += 1;
    rt.chainState[chain].lastError = null;
    rt.metrics.broadcasts += 1;
    scheduleVerification(rt, rec); // verifyOnChain — קריאה-חוזרת מיד-אחרי-שידור (לא-חוסם)
  }
  rt.lastActivityAt = Date.now();
  persist(rt);
}

async function processQueue(rt: RelayRT): Promise<void> {
  if (rt.processing) return;
  const keys = loadKeys();
  rt.processing = true;
  try {
    if (!keys) return;
    const now = Date.now();
    // עיבוד כל-העבודות מהישן-לחדש — steem מעגן כל-חותם, hive/tron רק-את-החדש-ביותר
    for (const job of [...rt.jobs].reverse()) {
      const due = (ALL_CHAINS as ChainName[]).filter((c) => {
        const cs = job.chains[c];
        return !cs.done && cs.attempts < RETRY_MAX && cs.nextTryAt <= now;
      });
      if (due.length === 0) continue;
      await Promise.all(due.map((c) => attemptChain(rt, keys, job, c).catch(() => { /* לא-חוסם */ })));
    }
    rt.jobs = rt.jobs.filter((j) => !(ALL_CHAINS as ChainName[]).every((c) => j.chains[c].done));
  } finally {
    rt.processing = false;
  }
}

/* ── שחזור-ראיות-ציבוריות מהריצה-הקודמת (state/anchors.json — הוכחות בלבד) ──
 * ה-Relay שורד הפעלות-מחדש: הרשומות חוזרות, המדדים נספרים-מחדש מהן, וכל-עיגון
 * ששודר וטרם-אומת נכנס אוטומטית לתור-הפיוס. */
function restoreRecords(rt: RelayRT): void {
  try {
    const raw = JSON.parse(fs.readFileSync(ANCHORS_FILE, "utf8")) as { records?: Partial<AnchorRecord>[] };
    if (!Array.isArray(raw.records)) return;
    const clean: AnchorRecord[] = [];
    for (const r of raw.records.slice(0, 60)) {
      if (!r || typeof r.chain !== "string" || typeof r.height !== "number" || !r.txid || typeof r.stateRoot !== "string") continue;
      if (!(r.chain === "steem" || r.chain === "hive" || r.chain === "tron" || r.chain === "eth" || r.chain === "sol")) continue;
      clean.push({
        chain: r.chain, height: r.height, stateRoot: r.stateRoot, digest: String(r.digest ?? ""),
        txid: r.txid, status: (r.status === "anchored" ? "anchored" : "pending"),
        at: String(r.at ?? new Date().toISOString()), attempt: Number(r.attempt ?? 1),
        // פסיקה-שמורה-בדיסק אינה אמת-מידה סופית: false נחשב "דורש-אימות-מחדש" (null)
        // כדי-שלולאת-הפיוס תגזור-אותה מחדש מה-RPC (ריפוי-עצמי משאריות-מהדורות-קודמות).
        verified: r.verified === true ? true : null,
        verifiedAt: typeof r.verifiedAt === "string" ? r.verifiedAt : null,
      });
    }
    if (clean.length === 0) return;
    rt.records = clean;
    for (const c of ALL_CHAINS as ChainName[]) {
      const recs = clean.filter((r) => r.chain === c);
      if (recs.length === 0) continue;
      const last = recs[0];
      rt.chainState[c].anchored = recs.filter((r) => r.status === "anchored").length;
      rt.chainState[c].verified = recs.filter((r) => r.verified === true).length;
      rt.chainState[c].mismatches = recs.filter((r) => r.verified === false).length;
      rt.chainState[c].lastTxid = last.txid;
      rt.chainState[c].lastHeight = last.height;
      rt.chainState[c].lastAt = last.at;
      rt.chainState[c].status = last.status;
    }
    rt.metrics.verified = clean.filter((r) => r.verified === true).length;
    rt.metrics.mismatches = clean.filter((r) => r.verified === false).length;
    console.info(`[saos-relay] restored ${clean.length} anchor records from prior run — reconcile queue re-armed`);
  } catch { /* אין-קובץ/פורמט-ישן — פתיחה-נקייה */ }
}

/* ── אתחול-זמן-ריצה (שורד HMR דרך globalThis) ── */
function rtInit(): RelayRT {
  if (g.__saosDexRelay) return g.__saosDexRelay;
  const keys = loadKeys();
  const mk = (on: boolean): RelayChainState => ({
    enabled: on, status: on ? "idle" : "disabled",
    lastTxid: null, lastHeight: null, lastAt: null,
    lastError: null, lastVerifyError: null,
    anchored: 0, verified: 0, mismatches: 0,
    breaker: mkBreaker(),
  });
  const rt: RelayRT = {
    jobs: [], processing: false, records: [],
    chainState: { steem: mk(!!keys), hive: mk(!!keys), tron: mk(!!keys), eth: mk(!!keys?.ethKey), sol: mk(!!keys?.solKey) },
    metrics: { broadcasts: 0, verified: 0, mismatches: 0, breakerTrips: 0, economicWaits: 0, lastVerifyLatencyMs: null },
    account: keys?.account ?? null,
    tronAddress: null,
    ethAddress: null,
    solAddress: null,
    ethIntents: [],
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    reconcileStarted: false,
  };
  g.__saosDexRelay = rt;
  restoreRecords(rt); // ראיות-העיגון מהריצה-הקודמת חוזרות לפני-תחילת-הפיוס
  if (keys) startReconciler(rt); // לולאת-פיוס — רק-כשה-Relay חי
  return rt;
}

/** ה-hook מ-seal() — לא-חוסם, לא-זורק */
export function relaySeal(info: SealInfo): void {
  try {
    const rt = rtInit();
    if (!rt.account) return; // אין-מפתחות — ה-Relay כבוי בכנות
    if (rt.jobs.length >= QUEUE_CAP) rt.jobs.pop(); // החדש-חשוב מהישן — הישן נזרק
    // חותמות-ישנות של עיגון-כבד/RC מסומנות done — רק החותם החדש-ביותר נעגן עליהן (תקציב RC/gas/SOL)
    for (const j of rt.jobs) for (const c of LATEST_ONLY) j.chains[c].done = true;
    rt.jobs.unshift({
      info, at: new Date().toISOString(),
      chains: {
        steem: { attempts: 0, rcWaits: 0, nextTryAt: 0, done: false },
        hive: { attempts: 0, rcWaits: 0, nextTryAt: 0, done: false },
        tron: { attempts: 0, rcWaits: 0, nextTryAt: 0, done: false },
        eth: { attempts: 0, rcWaits: 0, nextTryAt: 0, done: false },
        sol: { attempts: 0, rcWaits: 0, nextTryAt: 0, done: false },
      },
    });
    void processQueue(rt).catch(() => { /* לעולם לא מפיל את השרשרת */ });
  } catch { /* לעולם לא מפיל את השרשרת */ }
}

/** relayAuditVerify — ערוץ-אימות לכלי-ביקורת (ולמבחני-כאוס):
 * מריץ רשומה אחת במלוא-נתיב-האימות — קריאה-חוזרת מה-RPC הציבורי, השוואת
 * stateRoot+height, ALERT בלוג על-מיסמאץ', ועדכון-מדדים (mismatches/verified).
 * SECURITY INTENT: מאפשר להוכיח שהמערכת מזהה stateRoot מזויף ומסרבת לאשר אותו —
 * בלי שידור, בלי חסימה, ובלי גישה למפתחות. מבודד-מצב דרך SAOS_DEX_STATE_DIR.
 */
export async function relayAuditVerify(
  chain: ChainName,
  txid: string,
  expected: { height: number; stateRoot: string }
): Promise<{ ok: boolean; verified: boolean | null; detail: string }> {
  const rt = rtInit();
  const rec: AnchorRecord = {
    chain, height: expected.height, stateRoot: expected.stateRoot, digest: "",
    txid, status: "anchored", at: new Date().toISOString(), attempt: 1,
    verified: null, verifiedAt: null,
  };
  await verifyRecord(rt, rec);
  if (rec.verified === true) return { ok: true, verified: true, detail: "verified on-chain (read-back match)" };
  if (rec.verified === false) return { ok: false, verified: false, detail: rec.error ?? rt.chainState[chain].lastVerifyError ?? "mismatch" };
  return { ok: false, verified: null, detail: "not indexed (pending reconciliation)" };
}

/** מצב-ציבורי ל-API/UI — אפס סודות */
export function relayStatus(): Record<string, unknown> {
  const rt = rtInit();
  return {
    enabled: !!rt.account,
    account: rt.account,
    anchorId: ANCHOR_ID,
    uptimeMs: Date.now() - rt.startedAt,
    lastActivityAt: rt.lastActivityAt,
    queue: rt.jobs.length,
    tronIdentity: rt.tronAddress,
    identities: { eth: rt.ethAddress, sol: rt.solAddress },
    ethIntents: rt.ethIntents.slice(0, 3).map((i) => ({ height: i.height, intentHash: i.intentHash.slice(0, 18) + "…", signature: i.signature.slice(0, 12) + "…", address: i.address, verified: i.verified })),
    metrics: rt.metrics,
    chains: rt.chainState,
    records: rt.records.slice(0, 12).map((r) => ({
      chain: r.chain, height: r.height, status: r.status, txid: r.txid, at: r.at, attempt: r.attempt,
      verified: typeof r.verified === "boolean" ? r.verified : null, verifiedAt: r.verifiedAt ?? null,
      error: r.error ? r.error.slice(0, 90) : undefined,
    })),
  };
}
