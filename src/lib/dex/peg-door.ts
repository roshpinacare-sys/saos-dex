/**
 * peg-door.ts — דלת-המטבעות (Task 72 · THE-COIN-DOOR)
 * ═════════════════════════════════════════════════════════════════════════════
 * דבר-המפעיל: "יש לי קצת TRX (5$) וסול עוד קצת — צריך להגיע לרמה שאפשר לעשות
 * סוואפ פה בדקס ולקבל נתון-שוק-אמת-חי".
 *
 * התשובה — דלת-פקדה ריבונית על הרשת שלנו, בלי-צומת-TRON/סולרה משלנו ובלי-לסמוך
 * על-אף-שרת-חוץ כסמכות:
 *
 *  1. זהויות-פקדה נגזרות מהזרע-הריבוני (אותו-דפוס שהוכח-חי ב-relay-sol):
 *     · TRX: secp256k1 מה-WIF-הריבוני → keccak → base58check (0x41) — כמו tronIdentity
 *     · SOL: ed25519 מ-SOL_PRIVATE_KEY — solIdentity (wallets-registry idx=2)
 *  2. אימות-פקדה מול-RPC-ציבורי (keyless): trongrid gettransactionbyid ל-TRX,
 *     getTransaction ל-SOL — העברה-אמת אל-כתובת-הפקדה שלנו = ראיה.
 *  3. הטבעה מגובה (kernel · wrap_mint external+claim — אותה-מסילה של WBLURT):
 *     1 TRX = 1000µ-WTRX · 1 SOL = 1000µ-WSOL (1 sun = 0.001µ · 1 lamport = 1e-6µ)
 *     — claim = `chain:txid` בטבעת-הדדופ-של-הגרעין (extClaims) = תביעה-חד-פעמית.
 *  4. נתון-שוק-אמת-חי: אורקל-קנוני בגרעין (oracle_set — chain.ts) + הצלבת
 *     בריכה-מול-אורקל (spreadBps + verdict) בדוח-הדלת.
 *  5. פדיון: xfer_free ל"peg-outbox" (הפרדה-גלויה מהמחזור) + attest יעד —
 *     השליחה-האמת-של-המטבע-החוצה היא-מעשה-מפעיל מכתובת-הפקדה (מתועד-כנה).
 *
 * אפס-סודות בפלט (כתובות-ציבוריות בלבד) · גדר-fencedFetch · fail-כנה-תמיד.
 */
import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { solIdentity } from "./relay-sol";
import { fencedFetch } from "./fence";
import type { DexState } from "./kernel";
import { poolMidFor } from "./amm";

const TRON_RPC = "https://api.trongrid.io";
const SOL_RPC = "https://api.mainnet-beta.solana.com";

/** דלק-עיגון: TRON חוסם-מתחת-0.3 TRX (relay.tronSealBroadcast) · SOL חוסם-מתחת
 * לפטור-משכרות+עמלה+מרווח (roast-67 · sol-rent-floor). */
export const TRX_ANCHOR_GAS_SUN = 300_000;
export const SOL_RENT_FLOOR_LAMPORTS = 896_880; // rentExempt(0B)=890,880 + fee 5,000 + margin 1,000

/* ── base58 (אותה-אלגוריתמיקה relay-sol) ── */
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(buf: Uint8Array): string {
  let n = BigInt("0x" + Buffer.from(buf).toString("hex"));
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b === 0) out = B58[0] + out; else break; }
  return out;
}
function b58decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error("bad base58"); n = n * 58n + BigInt(i); }
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const buf = Buffer.from(hex, "hex");
  let pad = 0;
  for (const c of s) { if (c === B58[0]) pad++; else break; }
  return Buffer.concat([Buffer.alloc(pad), buf]);
}

/* ── זהויות-פקדה (פלט-ציבורי בלבד) ── */
export interface DoorIdentities {
  tron: string | null;
  sol: string | null;
  note: string;
}

/** נגזרת-TRON מה-WIF-הריבוני — אותה-מתמטיקה של tronIdentity ב-relay.ts (מקומי
 * כדי-לא-לגרור-את-מודול-ה-steem הכבד לתוך-נתיב-הדלת). */
export function tronIdentityFromWif(wif: string): string | null {
  try {
    const raw = Buffer.from(b58decode(wif.trim()));
    const data = raw.subarray(0, raw.length - 4);
    const priv = data.subarray(1, 33);
    const pub65 = Buffer.from(secp256k1.getPublicKey(priv, false));
    const h = keccak_256(pub65.subarray(1));
    const payload = Buffer.concat([Buffer.from([0x41]), Buffer.from(h.subarray(12))]);
    const sh1 = createHash("sha256").update(payload).digest();
    const chk = createHash("sha256").update(sh1).digest().subarray(0, 4);
    return b58(Buffer.concat([payload, chk]));
  } catch {
    return null;
  }
}

export function depositIdentities(): DoorIdentities {
  const wif = process.env.STEEM_ACTIVE_WIF || "";
  const solKey = (process.env.SOL_PRIVATE_KEY || "").trim();
  let tron: string | null = null;
  if (wif.length >= 51) tron = tronIdentityFromWif(wif);
  let sol: string | null = null;
  if (solKey.length >= 32) {
    try { sol = solIdentity(solKey).address; } catch { sol = null; }
  }
  return {
    tron, sol,
    note: "זהויות-פקדה ריבוניות — נגזרות מהזרע-הריבוני (אותו-דפוס wallets-registry); המפתח-הפרטי אף-פעם לא עוזב את הסביבה",
  };
}

/* ── אימות-פקדות מול-RPC-ציבורי ── */

export interface DepositProof {
  ok: boolean;
  detail: string;
  amountMu: number; // µ-עוגן (1 TRX = 1000µ · 1 SOL = 1000µ)
  error?: string;
}

interface TronTx {
  ret?: { contractRet?: string }[];
  raw_data?: {
    contract?: {
      type?: string;
      parameter?: { value?: { to_address?: string; amount?: number } };
    }[];
  };
}

/** TRX: gettransactionbyid (visible:true → כתובות-base58) · TransferContract ·
 * אל-כתובת-הפקדה שלנו · 1 sun = 0.001µ. */
export async function verifyTrxDeposit(txid: string, expectedAddr: string): Promise<DepositProof> {
  const r = await fencedFetch(`${TRON_RPC}/wallet/gettransactionbyid`, "peg-door.tron-tx", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: txid, visible: true }),
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  if (!r.ok) return { ok: false, detail: "rpc-error", amountMu: 0, error: `trongrid ${r.status}` };
  const j = (await r.json()) as TronTx;
  if (!j || Object.keys(j).length === 0) return { ok: false, detail: "not-found", amountMu: 0, error: "tx unknown to public node (pending or wrong chain?)" };
  const contract = j.raw_data?.contract?.[0];
  if (j.ret?.[0]?.contractRet && j.ret[0].contractRet !== "SUCCESS") return { ok: false, detail: "failed-on-chain", amountMu: 0, error: `contractRet=${j.ret[0].contractRet}` };
  if (contract?.type !== "TransferContract") return { ok: false, detail: "not-a-native-transfer", amountMu: 0, error: `type=${contract?.type ?? "?"} (TRC-20 tokens are not supported on the door — native TRX only)` };
  const v = contract.parameter?.value ?? {};
  if (String(v.to_address ?? "") !== expectedAddr) return { ok: false, detail: "wrong-destination", amountMu: 0, error: "transfer is not addressed to the sovereign deposit identity" };
  const sun = Number(v.amount ?? 0);
  if (!(sun > 0)) return { ok: false, detail: "zero-amount", amountMu: 0 };
  return { ok: true, detail: `TransferContract ${sun} sun → sovereign deposit identity`, amountMu: Math.floor(sun / 1000) };
}

interface SolTx {
  meta?: { err?: unknown; preBalances?: number[]; postBalances?: number[] } | null;
  transaction?: { message?: { accountKeys?: (string | { pubkey?: string })[] } };
}

/** SOL: getTransaction (finalized) — delta-יתרות-על-כתובת-הפקדה (העברת-מערכת
 * native · 1 lamport = 1e-6µ). SPL-טוקנים לא-נתמכים בדלת (כנות). */
export async function verifySolDeposit(txid: string, expectedAddr: string): Promise<DepositProof> {
  const r = await fencedFetch(SOL_RPC, "peg-door.sol-tx", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1,
      method: "getTransaction",
      params: [txid, { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 }],
    }),
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  if (!r.ok) return { ok: false, detail: "rpc-error", amountMu: 0, error: `solana rpc ${r.status}` };
  const j = (await r.json()) as { result?: SolTx | null };
  const tx = j.result;
  if (!tx) return { ok: false, detail: "not-found-or-not-finalized", amountMu: 0, error: "signature unknown to public node yet (or not finalized — retry after a minute)" };
  if (tx.meta?.err) return { ok: false, detail: "failed-on-chain", amountMu: 0, error: JSON.stringify(tx.meta.err).slice(0, 120) };
  const keys = (tx.transaction?.message?.accountKeys ?? []).map((k) => (typeof k === "string" ? k : String(k?.pubkey ?? "")));
  const idx = keys.indexOf(expectedAddr);
  if (idx < 0) return { ok: false, detail: "wrong-destination", amountMu: 0, error: "deposit identity is not a party of this transaction" };
  const pre = tx.meta?.preBalances?.[idx] ?? 0;
  const post = tx.meta?.postBalances?.[idx] ?? 0;
  const lamports = post - pre;
  if (!(lamports > 0)) return { ok: false, detail: "no-incoming-lamports", amountMu: 0, error: `balance delta for the deposit identity is ${lamports} (outgoing or fee-only)` };
  return { ok: true, detail: `+${lamports} lamports → sovereign deposit identity (finalized)`, amountMu: Math.floor(lamports / 1_000_000) };
}

/* ── יתרות-משמורת-חי (TTL-60ש׳ · fail-soft) ── */
export interface Custody { tronSun: number | null; solLamports: number | null; at: number; note: string }
interface CustodyRT { at: number; data: Custody | null; inflight: Promise<Custody> | null }
const gC = globalThis as unknown as { __saosDoorCustody?: CustodyRT };
function custodyRt(): CustodyRT {
  if (!gC.__saosDoorCustody) gC.__saosDoorCustody = { at: 0, data: null, inflight: null };
  return gC.__saosDoorCustody;
}

async function fetchCustody(ids: DoorIdentities): Promise<Custody> {
  const [tronSun, solLamports] = await Promise.all([
    (async (): Promise<number | null> => {
      if (!ids.tron) return null;
      try {
        const r = await fencedFetch(`${TRON_RPC}/v1/accounts/${ids.tron}`, "peg-door.tron-bal", { signal: AbortSignal.timeout(12_000), cache: "no-store" });
        const j = (await r.json()) as { data?: { balance?: number }[] };
        return j?.data?.[0]?.balance ?? 0;
      } catch { return null; }
    })(),
    (async (): Promise<number | null> => {
      if (!ids.sol) return null;
      try {
        const r = await fencedFetch(SOL_RPC, "peg-door.sol-bal", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [ids.sol, { commitment: "confirmed" }] }),
          signal: AbortSignal.timeout(12_000), cache: "no-store",
        });
        const j = (await r.json()) as { result?: { value?: number } };
        return j?.result?.value ?? null;
      } catch { return null; }
    })(),
  ]);
  return {
    tronSun, solLamports, at: Date.now(),
    note: "יתרות-המשמורת-האמת על-כתובות-הפקדה — הגיבוי-הפיזי של העוגנים (WTRX/WSOL)",
  };
}

export async function custodySnapshot(ids: DoorIdentities, maxAgeMs = 60_000): Promise<Custody> {
  const m = custodyRt();
  if (m.data && Date.now() - m.at < maxAgeMs) return m.data;
  if (m.inflight) return m.inflight;
  m.inflight = fetchCustody(ids).then((d) => { m.data = d; m.at = Date.now(); return d; }).finally(() => { m.inflight = null; });
  return m.inflight;
}

/* ── דוח-הדלת ── */
export interface PegRow {
  asset: "WTRX" | "WSOL";
  oracleMu: number | null;   // µ-USDS ל-1-יחידה (קנוני מ-stateRoot)
  oracleAtH: number | null;
  oracleSrc: string | null;
  backingMu: number;          // st.backing — הפקדות-שאומתו והוטבעו
  extClaimMu: number;         // extBack — תביעת-הגיבוי-האחרונה
  pool: { key: string; ra: number; rb: number; midMu: number | null } | null;
  spreadBps: number | null;   // mid מול oracle
  verdict: "NO-POOL" | "NO-ORACLE" | "CONVERGED" | "DRIFT" | "DIVERGENT" | null;
}

export interface DoorReport {
  ok: true;
  at: string;
  identities: DoorIdentities;
  custody: Custody;
  anchors: {
    tron: { haveSun: number | null; needSun: number; gapSun: number | null; note: string };
    sol: { haveLamports: number | null; needLamports: number; gapLamports: number | null; note: string };
  };
  peg: PegRow[];
  outboundNote: string;
  journal: { h: number; action: string; note: string }[];
}

/** הדוח-המלא — קריאה-בלבד מהמצב-הקנוני + קריאות-RPC-ציבורי (TTL). */
export async function doorReport(st: DexState): Promise<DoorReport> {
  const ids = depositIdentities();
  const custody = await custodySnapshot(ids).catch(() => ({
    tronSun: null, solLamports: null, at: Date.now(), note: "מדידת-משמורת נכשלה — fail-כנה",
  }));

  const pegRow = (asset: "WTRX" | "WSOL", pair: string, feedAsset?: string): PegRow => {
    const o = st.oracle?.[feedAsset ?? asset] ?? null;
    const pool = st.pools[pair] ?? null;
    const midMu = pool ? poolMidFor(pool, asset, "USDS") : null;
    let spreadBps: number | null = null;
    let verdict: PegRow["verdict"] = null;
    if (!o) verdict = "NO-ORACLE";
    else if (!pool || !(midMu && midMu > 0)) verdict = "NO-POOL";
    else {
      spreadBps = Math.round(((midMu - o.mu) / o.mu) * 10_000);
      verdict = Math.abs(spreadBps) < 300 ? "CONVERGED" : Math.abs(spreadBps) < 1_500 ? "DRIFT" : "DIVERGENT";
    }
    return {
      asset,
      oracleMu: o?.mu ?? null, oracleAtH: o?.atH ?? null, oracleSrc: o?.src ?? null,
      backingMu: st.backing[asset] ?? 0,
      extClaimMu: st.extBack?.[asset]?.mu ?? 0,
      pool: pool ? { key: pair, ra: pool.ra, rb: pool.rb, midMu: midMu ?? null } : null,
      spreadBps, verdict,
    };
  };

  const journal = st.journal
    .filter((j) => ["wrap_mint_ext", "oracle_set", "pool_open", "attest", "peg_out"].includes(j.action))
    .filter((j) => /WTRX|WSOL|oracle|peg-out|median|TRX|SOL|peg/i.test(j.note ?? ""))
    .slice(-12)
    .reverse()
    .map((j) => ({ h: j.h, action: j.action, note: j.note ?? "" }));

  return {
    ok: true,
    at: new Date().toISOString(),
    identities: ids,
    custody,
    anchors: {
      tron: {
        haveSun: custody.tronSun, needSun: TRX_ANCHOR_GAS_SUN,
        gapSun: custody.tronSun === null ? null : Math.max(0, TRX_ANCHOR_GAS_SUN - custody.tronSun),
        note: "עיגון-TRON חוסם-מתחת-0.3 TRX (רצפת-bandwidth) — העלאת-הפקדה-הראשונה תממן-גם-אותו",
      },
      sol: {
        haveLamports: custody.solLamports, needLamports: SOL_RENT_FLOOR_LAMPORTS,
        gapLamports: custody.solLamports === null ? null : Math.max(0, SOL_RENT_FLOOR_LAMPORTS - custody.solLamports),
        note: "עיגון-SOL דורש פטור-משכרות+עמלה (896,880 lamports) — נמדד-חי ב-roast-67",
      },
    },
    peg: [pegRow("WTRX", "USDS/WTRX"), pegRow("WSOL", "USDS/WSOL")],
    outboundNote: "פדיון = הפרדה-ל-outbox על-הרשת + שליחה-פיזית-מכתובת-הפקדה בידי-המפעיל (מתועד-כנה — המטבע-האמיתי עוזב את-המשמורת רק-בשידור-אמת)",
    journal,
  };
}
