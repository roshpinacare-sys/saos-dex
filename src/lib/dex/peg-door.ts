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
 *     · EVM: ethIdentity — וזהות-אחת משרתת שלוש-רשתות (ETH · Base · BSC) —
 *       כתובת-EVM היא עקומה-בלבד, לא רשת; ה-chainId מאומת-מהטרנזקציה-עצמה.
 *  2. אימות-פקדה מול-RPC-ציבורי (keyless): trongrid gettransactionbyid ל-TRX,
 *     getTransaction ל-SOL, eth_getTransactionReceipt+chainId ל-EVM —
 *     העברה-אמת אל-כתובת-הפקדה שלנו = ראיה.
 *  3. הטבעה מגובה (kernel · wrap_mint external+claim — אותה-מסילה של WBLURT):
 *     1 TRX = 1000µ-WTRX · 1 SOL = 1000µ-WSOL · 1 ETH = 1000µ-WETH ·
 *     1 BNB = 1000µ-WBNB · 1 ETH(Base) = 1000µ-WBASE (1 wei = 1e-15µ)
 *     — claim = `chain:txid` בטבעת-הדדופ-של-הגרעין (extClaims) = תביעה-חד-פעמית.
 *     EXEC-CD-11 · THE-CHAIN-STREAM: הדלת-מורחבת מ-TRX/SOL ל-5 עוגנים על-גבי
 *     5 רשתות-אמת (TRON · Solana · Ethereum · Base · BSC) — אותו-דפוס-כוכב, אפס-חריגות.
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
import { ethIdentity } from "./relay-eth";
import { fencedFetch } from "./fence";
import type { DexState } from "./kernel";
import { poolMidFor } from "./amm";

const TRON_RPC = "https://api.trongrid.io";
const SOL_RPC = "https://api.mainnet-beta.solana.com";
/* EXEC-CD-30 · סולם-גיבוי-SOL: ה-RPC-הראשי (api.mainnet-beta) מגביל-קצת מ-IP-משותף
 * (429 נמדד-חי-בגשר). כל-קריאת-SOL-של-הדלת עוברת-דרך-הסולם — כישלון-ראשי → גיבוי
 * ציבורי (publicnode, מקובע-בגדר). אימות-אמת לא נופל על תקיפת-קצב. */
const SOL_RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"] as const;
const ETH_RPC = "https://ethereum-rpc.publicnode.com";

/* ── EXEC-CD-11 · רשימת-הדלתות — מקור-האמת היחיד (משותף ל-route ולדוח) ────────
 * עוגן→רשת: אפס-שכפול-מיפוי. זהות-הפקדה לכל-הרשתות היא-זהות-הזרע-הריבוני —
 * המיפוי ל-EVM הוא-הכתובת-האחת (עקומה-זהה), ל-TRX/SOL הנגזרות-היעודיות. */
/* EXEC-CD-30 · WUSDC נכנס לדלת — העוגן-השישי: USDC אמיתי על Solana mainnet
 * (SPL, mint EPjFW…) — יציב-ערך שמאומת מול-RPC-ציבורי כמו-כל-עוגן.
 * זהו-השער-הראשון-שמחבר-את-האוצר-האמיתי-של-הכספת (6.35 USDC מה-swap-האמיתי
 * VJud9e1r…) אל-כספת-העתודה של ה-DEX — הצעד-הראשון-בשטיפת-ערך-פנימי→אמיתי. */
export const PEG_ASSETS = { WTRX: "trx", WSOL: "sol", WETH: "eth", WBNB: "bnb", WBASE: "base", WUSDC: "sol-usdc" } as const;
export type PegAsset = keyof typeof PEG_ASSETS;
export type PegChain = (typeof PEG_ASSETS)[PegAsset];

/** Solana USDC mint (mainnet) + SPL-Token program — האימות-מול-RPC-ציבורי בלבד. */
export const USDC_SOL_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export type EvmDoor = "eth" | "base" | "bsc";
export const EVM_DOORS: Record<EvmDoor, { rpc: string; chainId: number; name: string; explorer: string }> = {
  eth: { rpc: ETH_RPC, chainId: 1, name: "Ethereum", explorer: "https://etherscan.io" },
  base: { rpc: "https://mainnet.base.org", chainId: 8453, name: "Base", explorer: "https://basescan.org" },
  bsc: { rpc: "https://bsc-rpc.publicnode.com", chainId: 56, name: "BNB Smart Chain", explorer: "https://bscscan.com" },
};
export const isEvmDoor = (c: string): c is EvmDoor => c === "eth" || c === "base" || c === "bsc";

/** דלק-עיגון: TRON חוסם-מתחת-0.3 TRX (relay.tronSealBroadcast) · SOL חוסם-מתחת
 * לפטור-משכרות+עמלה+מרווח (roast-67 · sol-rent-floor). */
export const TRX_ANCHOR_GAS_SUN = 300_000;
export const SOL_RENT_FLOOR_LAMPORTS = 896_880; // rentExempt(0B)=890,880 + fee 5,000 + margin 1,000

/* EXEC-CD-30 · solRpc — קריאת-RPC-SOL-דרך-הסולם: ראשי → גיבוי. מחזיר-Response
 * הראשון-שאינו-429/5xx; אם-הכל-נכשל — ה-Response-האחרון (כנות-שגיאה). */
async function solRpc(body: unknown, where: string, timeoutMs = 20_000): Promise<Response> {
  let last: Response | null = null;
  for (const rpc of SOL_RPCS) {
    try {
      const r = await fencedFetch(rpc, where, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), cache: "no-store",
      });
      if (r.status !== 429 && r.status < 500) return r;
      last = r;
    } catch (e) { last = null; if (rpc === SOL_RPCS[SOL_RPCS.length - 1]) throw e; }
  }
  return last as Response;
}

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
  evm: string | null;
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

/** EXEC-CD-13 · נגזרת-TRON מסקלר-hex (TRON_PRIVATE_KEY) — אותה-מתמטיקה בדיוק,
 * קלט-סקלר-ישיר במקום-מעטפת-WIF. מפתח-הסכם-האב (headcorner) = הזרע-הריבוני-החי
 * כשחומר-הכספת-אינו-זמין (ניקוי-סנדבוקס). */
export function tronIdentityFromHexScalar(hexScalar: string): string | null {
  try {
    const priv = Buffer.from(hexScalar.replace(/^0x/, "").trim(), "hex");
    if (priv.length !== 32) return null;
    const pub65 = Buffer.from(secp256k1.getPublicKey(new Uint8Array(priv), false));
    const h = keccak_256(pub65.subarray(1));
    const payload = Buffer.concat([Buffer.from([0x41]), Buffer.from(h.subarray(12))]);
    const sh1 = createHash("sha256").update(payload).digest();
    const chk = createHash("sha256").update(sh1).digest().subarray(0, 4);
    return b58(Buffer.concat([payload, chk]));
  } catch {
    return null;
  }
}

/* EXEC-CD-30 · זהויות-הפקדה-הקנוניות = כתובות-כספת-הריפו (חוק-המשפך §6:
 * כל-ערך-נכנס → כתובות-מגובות-גיט). ה-manifest הוא **ציבורי** (כתובות-בלבד —
 * אפס-סודות): האימות-מול-RPC צריך רק את-הכתובת-שאליה-הכסף-נכנס. הנגזרות-מ-env
 * נשארות-נפילה-כנה (תאימות-דלת-היסטורית) אך-העדיפות-היא-לכספת. */
const gVaultIds: { at: number; ids: { tron: string | null; sol: string | null; evm: string | null } | null } = { at: 0, ids: null };
function repoVaultIdentities(): { tron: string | null; sol: string | null; evm: string | null } | null {
  if (gVaultIds.ids && Date.now() - gVaultIds.at < 60_000) return gVaultIds.ids;
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const candidates = [
      path.join(process.cwd(), "repo-vault", "manifest.json"),
      path.join(process.cwd(), "..", "repo-vault", "manifest.json"),
    ];
    for (const p of candidates) {
      if (!fs.existsSync(p)) continue;
      const m = JSON.parse(fs.readFileSync(p, "utf8")) as { kind?: string; networks?: Array<{ network: string; address: string }> };
      if (m?.kind !== "sovereign-repo-vault-manifest" || !Array.isArray(m.networks)) continue;
      const by = (n: string): string | null => (m.networks ?? []).find((x) => x.network === n)?.address ?? null; // EXEC-CD-43: ?? [] — הצרת-הגנה (tsc TS18048), ההגנה-עצמה בשורה-הקודמת
      const ids = { tron: by("tron"), sol: by("solana"), evm: by("evm") };
      gVaultIds.ids = ids; gVaultIds.at = Date.now();
      return ids;
    }
  } catch { /* fail-כנה — נפילה ל-env */ }
  gVaultIds.ids = null; gVaultIds.at = Date.now();
  return null;
}

export function depositIdentities(): DoorIdentities {
  // EXEC-CD-30: הכספת-הריבונית קודמת — זו-הזהות-שאליה-הכסף-האמיתי-נכנס (ושנמדדת-חי)
  const vault = repoVaultIdentities();
  if (vault && (vault.tron || vault.sol || vault.evm)) {
    return {
      tron: vault.tron, sol: vault.sol, evm: vault.evm,
      note: "זהויות-פקדה ריבוניות = כתובות-כספת-הריפו (manifest-ציבורי, אפס-סודות) — חוק-המשפך §6: כל-ערך-נכנס → כתובות-מגובות-גיט · EXEC-CD-11: כתובת-ה-EVM משרתת שלוש-רשתות (eth/base/bsc)",
    };
  }
  const wif = process.env.STEEM_ACTIVE_WIF || "";
  const tronScalar = (process.env.TRON_PRIVATE_KEY || "").trim(); // EXEC-CD-13: נגזרת-ישירה מסקלר-מפתח-הסכם-האב
  const solKey = (process.env.SOL_PRIVATE_KEY || "").trim();
  const ethKey = (process.env.ETH_PRIVATE_KEY || "").trim();
  let tron: string | null = null;
  if (wif.length >= 51) tron = tronIdentityFromWif(wif);
  if (!tron && tronScalar.length >= 32) tron = tronIdentityFromHexScalar(tronScalar); // נפילה-כנה-לסקלר
  let sol: string | null = null;
  if (solKey.length >= 32) {
    try { sol = solIdentity(solKey).address; } catch { sol = null; }
  }
  let evm: string | null = null;
  if (ethKey.length >= 32) {
    try { evm = ethIdentity(ethKey).address; } catch { evm = null; } // אותה-זהות wallet:cashmachine — אומתה-חי ב-roast-76 (ריכוז-10-txids)
  }
  return {
    tron, sol, evm,
    note: "זהויות-פקדה ריבוניות — נגזרות מהזרע-הריבוני (אותו-דפוס wallets-registry); המפתח-הפרטי אף-פעם לא עוזב את הסביבה · EXEC-CD-11: כתובת-ה-EVM משרתת שלוש-רשתות (eth/base/bsc) — אותו-math, אותה-זהות",
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

interface SolTokenBalance { accountIndex: number; mint: string; owner?: string; uiTokenAmount?: { amount?: string; decimals?: number } }
interface SolTx {
  meta?: { err?: unknown; preBalances?: number[]; postBalances?: number[]; preTokenBalances?: SolTokenBalance[] | null; postTokenBalances?: SolTokenBalance[] | null } | null;
  transaction?: { message?: { accountKeys?: (string | { pubkey?: string })[] } };
}

/* EXEC-CD-30 · USDC-SPL: אימות-פקדת-USDC מול-RPC-ציבורי — delta-מטבעות-SPL
 * (preTokenBalances→postTokenBalances) עבור-mint-USDC בבעלות-זהות-הפקדה.
 * סקאלה: USDC = 6-decimals; 1 USDC = 1000µ (אותה-סקאלת-עוגנים: WTRX/WSOL).
 * כנות: רק-delta-חיובי-נטו לבעלות-הזהות; ATA-שנוצר-בטרנזקציה (אין-pre) נספר-מ-0. */
export async function verifySolUsdcDeposit(txid: string, expectedAddr: string): Promise<DepositProof> {
  const r = await solRpc({
    jsonrpc: "2.0", id: 1,
    method: "getTransaction",
    params: [txid, { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 }],
  }, "peg-door.sol-usdc-tx");
  if (!r.ok) return { ok: false, detail: "rpc-error", amountMu: 0, error: `solana rpc ${r.status}` };
  const j = (await r.json()) as { result?: SolTx | null };
  const tx = j.result;
  if (!tx) return { ok: false, detail: "not-found-or-not-finalized", amountMu: 0, error: "signature unknown to public node yet (or not finalized — retry after a minute)" };
  if (tx.meta?.err) return { ok: false, detail: "failed-on-chain", amountMu: 0, error: JSON.stringify(tx.meta.err).slice(0, 120) };
  const sumFor = (rows: SolTokenBalance[] | null | undefined): number =>
    (rows ?? [])
      .filter((t) => t.mint === USDC_SOL_MINT && String(t.owner ?? "") === expectedAddr)
      .reduce((s, t) => s + Number.parseInt(t.uiTokenAmount?.amount ?? "0", 10), 0);
  const pre = sumFor(tx.meta?.preTokenBalances);
  const post = sumFor(tx.meta?.postTokenBalances);
  const delta = post - pre;
  if (!(delta > 0)) return { ok: false, detail: "no-incoming-usdc", amountMu: 0, error: `USDC SPL delta for the deposit identity is ${delta} (outgoing or absent)` };
  return { ok: true, detail: `+${delta} USDC-units (6dec) → sovereign deposit identity (finalized)`, amountMu: Math.floor(delta / 1_000) };
}

/** SOL: getTransaction (finalized) — delta-יתרות-על-כתובת-הפקדה (העברת-מערכת
 * native · 1 lamport = 1e-6µ). SPL-טוקנים לא-נתמכים בדלת (כנות). */
export async function verifySolDeposit(txid: string, expectedAddr: string): Promise<DepositProof> {
  const r = await solRpc({
    jsonrpc: "2.0", id: 1,
    method: "getTransaction",
    params: [txid, { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 }],
  }, "peg-door.sol-tx");
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

/* ── EVM (eth/base/bsc) — אותו-דפוס-אמת, שלוש-רשתות ── */

interface EvmReceipt { status?: string | null; to?: string | null; blockNumber?: string | null }
interface EvmTx { to?: string | null; value?: string | null; chainId?: string | null }

/** EVM: receipt-status=1 + יעד=זהות-הפקדה + chainId מהטרנזקציה-עצמה (פקדה-על
 * רשת-שגויה נדחית כנה) + value→µ. סקאלה: 1 מטבע = 1000µ (1 wei = 1e-15µ) —
 * אותה-סקאלה של WTRX/WSOL. ERC-20 לא-נתמך בדלת (כנות — native בלבד). */
export async function verifyEvmDeposit(chain: EvmDoor, txid: string, expectedAddr: string): Promise<DepositProof> {
  const door = EVM_DOORS[chain];
  try {
    const r = await fencedFetch(door.rpc, `peg-door.evm-receipt-${chain}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txid] }),
      signal: AbortSignal.timeout(15_000), cache: "no-store",
    });
    if (!r.ok) return { ok: false, detail: "rpc-error", amountMu: 0, error: `${chain} rpc ${r.status}` };
    const j = (await r.json()) as { result?: EvmReceipt | null };
    const rec = j.result;
    if (!rec) return { ok: false, detail: "not-found-or-pending", amountMu: 0, error: `receipt unknown to the ${door.name} public node yet (pending? wrong network? retry in a minute)` };
    if (rec.status !== "0x1") return { ok: false, detail: "failed-on-chain", amountMu: 0, error: `receipt status=${rec.status ?? "?"} (reverted or failed)` };
    if (String(rec.to ?? "").toLowerCase() !== expectedAddr.toLowerCase()) return { ok: false, detail: "wrong-destination", amountMu: 0, error: "transfer is not addressed to the sovereign deposit identity (contract-creation or ERC-20 transfer are not the door)" };
    const t = await fencedFetch(door.rpc, `peg-door.evm-tx-${chain}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionByHash", params: [txid] }),
      signal: AbortSignal.timeout(15_000), cache: "no-store",
    });
    const tj = t.ok ? ((await t.json()) as { result?: EvmTx | null }) : null;
    const tx = tj?.result;
    if (tx?.chainId) {
      const cid = Number(BigInt(tx.chainId));
      if (cid !== door.chainId) return { ok: false, detail: "wrong-network", amountMu: 0, error: `tx chainId=${cid} but the ${door.name} door verifies chainId=${door.chainId} — the coin lives on another network` };
    }
    const wei = BigInt(tx?.value ?? "0x0");
    if (!(wei > 0n)) return { ok: false, detail: "zero-amount", amountMu: 0, error: "no native value transferred (plain contract call?)" };
    const amountMu = Math.floor(Number(wei / 1_000_000_000_000_000n));
    if (!(amountMu > 0)) return { ok: false, detail: "dust-below-unit", amountMu: 0, error: `value=${wei} wei is below the smallest mintable unit (1µ = 1e15 wei)` };
    return { ok: true, detail: `+${wei} wei → sovereign deposit identity on ${door.name} (receipt ok${rec.blockNumber ? ` · block ${parseInt(rec.blockNumber, 16)}` : ""})`, amountMu };
  } catch (e) {
    return { ok: false, detail: "rpc-error", amountMu: 0, error: e instanceof Error ? e.message.slice(0, 140) : `${chain}-verify-failed` };
  }
}

/** נתיב-אימות-אחיד לפי-רשת — הדלת-האחת, חמשת-הסורגים.
 * מיפוי-chain→EvmDoor: WBNB-חי-על-BNB-Smart-Chain (door=bsc) — ה-chain-בדלת
 * קרוי-על-שם-המטבע, ה-door-על-שם-הרשת. */
const EVM_CHAIN_TO_DOOR: Record<"eth" | "bnb" | "base", EvmDoor> = { eth: "eth", bnb: "bsc", base: "base" };
export async function verifyPegDeposit(chain: PegChain, txid: string, ids: DoorIdentities): Promise<DepositProof> {
  if (chain === "trx") { if (!ids.tron) return { ok: false, detail: "no-identity", amountMu: 0, error: "TRON deposit identity not derivable" }; return verifyTrxDeposit(txid, ids.tron); }
  if (chain === "sol") { if (!ids.sol) return { ok: false, detail: "no-identity", amountMu: 0, error: "SOL deposit identity not derivable" }; return verifySolDeposit(txid, ids.sol); }
  if (chain === "sol-usdc") { if (!ids.sol) return { ok: false, detail: "no-identity", amountMu: 0, error: "SOL deposit identity not derivable" }; return verifySolUsdcDeposit(txid, ids.sol); } // EXEC-CD-30
  if (!ids.evm) return { ok: false, detail: "no-identity", amountMu: 0, error: "EVM deposit identity not derivable" };
  return verifyEvmDeposit(EVM_CHAIN_TO_DOOR[chain], txid, ids.evm);
}

/* ── יתרות-משמורת-חי (TTL-60ש׳ · fail-soft) ── */
export interface Custody {
  tronSun: number | null; solLamports: number | null; evmWei: number | null; // evmWei = ETH (מורשת-תאימות)
  evmWeiByChain: { eth: number | null; base: number | null; bsc: number | null }; // EXEC-CD-11: מדידה-לכל-רשת-EVM
  usdcUnits: number | null; // EXEC-CD-30: משמורת-USDC-SPL (6-dec raw) על-זהות-ה-SOL
  at: number; note: string;
}
interface CustodyRT { at: number; data: Custody | null; inflight: Promise<Custody> | null }
const gC = globalThis as unknown as { __saosDoorCustody?: CustodyRT };
function custodyRt(): CustodyRT {
  if (!gC.__saosDoorCustody) gC.__saosDoorCustody = { at: 0, data: null, inflight: null };
  return gC.__saosDoorCustody;
}

async function fetchCustody(ids: DoorIdentities): Promise<Custody> {
  const evmBalance = async (door: EvmDoor): Promise<number | null> => {
    if (!ids.evm) return null;
    try {
      const r = await fencedFetch(EVM_DOORS[door].rpc, `peg-door.evm-bal-${door}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [ids.evm, "latest"] }),
        signal: AbortSignal.timeout(12_000), cache: "no-store",
      });
      if (!r.ok) return null; // FIX(R14-a · false-zero) — אותו-דוקטרינה: HTTP-שגיאה = לא-נודע, לא-אפס
      const j = (await r.json()) as { result?: string };
      return j?.result ? Number(BigInt(j.result)) : null;
    } catch { return null; }
  };
  // EXEC-CD-30 · משמורת-USDC: getTokenAccountsByOwner (jsonParsed) → סכימת-חשבונות-ה-USDC
  const usdcUnits = (async (): Promise<number | null> => {
    if (!ids.sol) return null;
    try {
      const r = await solRpc({
        jsonrpc: "2.0", id: 1,
        method: "getTokenAccountsByOwner",
        params: [ids.sol, { programId: SPL_TOKEN_PROGRAM }, { encoding: "jsonParsed", commitment: "confirmed" }],
      }, "peg-door.sol-usdc-bal", 12_000);
      if (!r.ok) return null;
      const j = (await r.json()) as {
        result?: { value?: Array<{ account?: { data?: { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string } } } } } }> };
      };
      let sum = 0; let seen = false;
      for (const acc of j?.result?.value ?? []) {
        const info = acc?.account?.data?.parsed?.info;
        if (info?.mint !== USDC_SOL_MINT) continue;
        seen = true;
        sum += Number.parseInt(info?.tokenAmount?.amount ?? "0", 10);
      }
      return seen ? sum : 0; // אין-חשבון-USDC = אפס-פיזי אמיתי (לא-null)
    } catch { return null; }
  })();
  const [tronSun, solLamports, ethWei, baseWei, bscWei] = await Promise.all([
    (async (): Promise<number | null> => {
      if (!ids.tron) return null;
      try {
        const r = await fencedFetch(`${TRON_RPC}/v1/accounts/${ids.tron}`, "peg-door.tron-bal", { signal: AbortSignal.timeout(12_000), cache: "no-store" });
        // FIX(R14-a · false-zero): fencedFetch לא-זורק-על-HTTP-שגיאה והקוד לא בדק r.ok —
        // גוף-שגיאה/429 (בלי data) נפל ל-`?? 0` והוצג כ"יתרת-משמורת 0" כשהכסף על-השרשרת
        // (נמדד-חי: 2,000,001-TRX על הדלת הוצגו 0). עתה: HTTP-שגיאה או success:false =
        // null (לא-נודע — fail-כנה) ולא-אפס-פיזי-מזויף.
        if (!r.ok) return null;
        const j = (await r.json()) as { data?: { balance?: number }[]; success?: boolean };
        if (j?.success === false) return null;
        return j?.data?.[0]?.balance ?? 0;
      } catch { return null; }
    })(),
    (async (): Promise<number | null> => {
      if (!ids.sol) return null;
      try {
        const r = await solRpc({
          jsonrpc: "2.0", id: 1,
          method: "getBalance",
          params: [ids.sol, { commitment: "confirmed" }],
        }, "peg-door.sol-bal", 12_000);
        const j = (await r.json()) as { result?: { value?: number } };
        return j?.result?.value ?? null;
      } catch { return null; }
    })(),
    (async (): Promise<number | null> => evmBalance("eth"))(),
    (async (): Promise<number | null> => evmBalance("base"))(),
    (async (): Promise<number | null> => evmBalance("bsc"))(),
  ]);
  return {
    tronSun, solLamports, evmWei: ethWei, evmWeiByChain: { eth: ethWei, base: baseWei, bsc: bscWei }, usdcUnits: await usdcUnits, at: Date.now(),
    note: "יתרות-המשמורת-האמת על-כתובות-הפקדה — הגיבוי-הפיזי של העוגנים (WTRX/WSOL/WETH/WBNB/WBASE/WUSDC) — אצל-EVM המשמורת היא גם דלק-העיגון-עצמו (אותה-זהות-כמו-ה-relay)",
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
  asset: PegAsset;
  oracleMu: number | null;   // µ-USDS ל-1-יחידה (קנוני מ-stateRoot)
  oracleAtH: number | null;
  oracleSrc: string | null;
  backingMu: number;          // st.backing — הפקדות-שאומתו והוטבעו
  extClaimMu: number;         // extBack — תביעת-הגיבוי-האחרונה
  pool: { key: string; ra: number; rb: number; midMu: number | null } | null;
  spreadBps: number | null;   // mid מול oracle
  verdict: "NO-POOL" | "NO-ORACLE" | "CONVERGED" | "DRIFT" | "DIVERGENT" | null;
  /* roast-78 · שקיפות-גיבוי-פיזי: המשמורת-היא-גם-דלק-העיגון — כמה-גיבוי-נשאר
   * מעל-התביעות וכמה-עיגונים-חינם נותרו לפני-רצפת-ההגנה. null = לא-רלוונטי/לא-נמדד. */
  custodyLamports: number | null;   // משמורת-פיזית (WSOL בלבד; WTRX-מוחזר-null)
  claimsLamports: number | null;    // תביעות-מוטבעות ב-lamports (backingMu × 1e6)
  headroomLamports: number | null;  // משמורת − תביעות (דלק-העיגון-החופשי)
  runwayAnchors: number | null;     // עיגונים-נותרים עד-רצפת-ההגנה (headroom/5,000)
  /* EXEC-CD-30 · שקיפות-משמורת-טוקן (WUSDC): משמורת-USDC-אמת (6-dec) מול-התביעות
   * המוטבעות (backingMu × 1000) — עוגן-SPL-הראשון-עם-ביקורת-1:1-חיה. */
  custodyTokenUnits: number | null;  // משמורת-USDC-פיזית (WUSDC בלבד)
  claimsTokenUnits: number | null;   // תביעות-מוטבעות ב-USDC-units (backingMu × 1e3)
  headroomTokenUnits: number | null; // משמורת − תביעות (כנות-גיבוי)
}

export interface DoorReport {
  ok: true;
  at: string;
  identities: DoorIdentities;
  custody: Custody;
  anchors: {
    tron: { haveSun: number | null; needSun: number; gapSun: number | null; note: string };
    sol: { haveLamports: number | null; needLamports: number; gapLamports: number | null; note: string };
    /* EXEC-CD-11: עיגון-EVM — relay-eth חמוש-EIP-1559 ונעול-עד-מימון (כנות);
     * המשמורת-על-כתובת-הפקדה היא גם דלק-העיגון-העתידי. */
    evm: { haveWei: { eth: number | null; base: number | null; bsc: number | null }; note: string };
  };
  peg: PegRow[];
  outboundNote: string;
  journal: { h: number; action: string; note: string }[];
}

/** הדוח-המלא — קריאה-בלבד מהמצב-הקנוני + קריאות-RPC-ציבורי (TTL). */
export async function doorReport(st: DexState): Promise<DoorReport> {
  const ids = depositIdentities();
  const custody = await custodySnapshot(ids).catch(() => ({
    tronSun: null, solLamports: null, evmWei: null, evmWeiByChain: { eth: null, base: null, bsc: null } as Custody["evmWeiByChain"], usdcUnits: null as number | null, at: Date.now(), note: "מדידת-משמורת נכשלה — fail-כנה",
  }));

  const SOL_ANCHOR_FEE = 5_000; // lamports לעיגון-ממו-עצמי (roast-67/78 — נמדד-חי)
  const pegRow = (asset: PegAsset, pair: string, feedAsset?: string): PegRow => {
    const o = st.oracle?.[feedAsset ?? asset] ?? null;
    const pool = st.pools[pair] ?? null;
    const midMu = pool ? poolMidFor(pool, asset, "USDS") : null;
    let spreadBps: number | null = null;
    let verdict: PegRow["verdict"] = null;
    if (!o) verdict = "NO-ORACLE";
    else if (!pool || !(midMu && midMu > 0)) verdict = "NO-POOL";
    else {
      // R23 · unit-truth: האורקל ב-µ$-ליחידה אבל midMu ב-mµ-ציטוט-ליחידה — היה פער-סקאלות
      // 1000x שפסק "DIVERGENT" כמעט-תמידית ל-WTRX/WSOL. עכשיו: השוואה באותה-סקאלה.
      const oMilli = Math.round(o.mu / 1000);
      spreadBps = Math.round(((midMu - oMilli) / oMilli) * 10_000);
      verdict = Math.abs(spreadBps) < 300 ? "CONVERGED" : Math.abs(spreadBps) < 1_500 ? "DRIFT" : "DIVERGENT";
    }
    // roast-78 · שקיפות-הגיבוי: חשוב-רק ל-WSOL (המשמורת-ה-SOL היא-גם-דלק-העיגון)
    const custodyLamports = asset === "WSOL" ? custody.solLamports : null;
    const claimsLamports = asset === "WSOL" ? Math.max(0, Math.floor(st.backing[asset] ?? 0)) * 1_000_000 : null;
    const headroomLamports = custodyLamports !== null && claimsLamports !== null
      ? custodyLamports - claimsLamports : null;
    const runwayAnchors = headroomLamports === null
      ? null
      : headroomLamports > 0
        ? Math.floor(headroomLamports / SOL_ANCHOR_FEE)
        : 0;
    // EXEC-CD-30 · שקיפות-WUSDC: משמורת-USDC-אמת מול-התביעות (ביקורת-1:1-חיה)
    const custodyTokenUnits = asset === "WUSDC" ? custody.usdcUnits : null;
    const claimsTokenUnits = asset === "WUSDC" ? Math.max(0, Math.floor(st.backing[asset] ?? 0)) * 1_000 : null;
    const headroomTokenUnits = custodyTokenUnits !== null && claimsTokenUnits !== null
      ? custodyTokenUnits - claimsTokenUnits : null;
    return {
      asset,
      oracleMu: o?.mu ?? null, oracleAtH: o?.atH ?? null, oracleSrc: o?.src ?? null,
      backingMu: st.backing[asset] ?? 0,
      extClaimMu: st.extBack?.[asset]?.mu ?? 0,
      pool: pool ? { key: pair, ra: pool.ra, rb: pool.rb, midMu: midMu ?? null } : null,
      spreadBps, verdict,
      custodyLamports, claimsLamports, headroomLamports, runwayAnchors,
      custodyTokenUnits, claimsTokenUnits, headroomTokenUnits,
    };
  };

  const journal = st.journal
    .filter((j) => ["wrap_mint_ext", "oracle_set", "pool_open", "attest", "peg_out"].includes(j.action))
    .filter((j) => /WTRX|WSOL|WETH|WBNB|WBASE|WUSDC|oracle|peg-out|median|TRX|SOL|ETH|BNB|BASE|USDC|peg/i.test(j.note ?? ""))
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
        note: "עיגון-SOL דורש פטור-משכרות+עמלה (896,880 lamports) — נמדד-חי ב-roast-67 · roast-78: רצפת-הגנת-גיבוי-פעילה — השריפה-נעצרת-כנה ברצף-התביעות-המוטבעות (ראה peg[WSOL].runwayAnchors)",
      },
      evm: {
        haveWei: custody.evmWeiByChain,
        note: "עיגון-EVM (relay-eth) חמוש-EIP-1559 ונעול-עד-מימון — כנות מלאה; המשמורת-על-כתובת-הפקדה היא-גם-דלק-העיגון-העתידי (זהות-אחת, שלוש-רשתות)",
      },
    },
    peg: [
      pegRow("WTRX", "USDS/WTRX"), pegRow("WSOL", "USDS/WSOL"),
      // EXEC-CD-11 · THE-CHAIN-STREAM: שלושת-העוגנים ה-EVM — אותו-דוקטרינה, רשתות-אמת
      pegRow("WETH", "USDS/WETH"), pegRow("WBNB", "USDS/WBNB"), pegRow("WBASE", "USDS/WBASE"),
      // EXEC-CD-30 · העוגן-השישי: USDC-אמת-על-Solana (השער-מ-האוצר-האמיתי)
      pegRow("WUSDC", "USDS/WUSDC"),
    ],
    outboundNote: "פדיון = הפרדה-ל-outbox על-הרשת + שליחה-פיזית-מכתובת-הפקדה בידי-המפעיל (מתועד-כנה — המטבע-האמיתי עוזב את-המשמורת רק-בשידור-אמת)",
    journal,
  };
}
