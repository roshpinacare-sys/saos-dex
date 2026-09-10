/**
 * bridge.ts — הגשר-הריבוני הדו-כיווני של SAOS-DEX (SETTLE-12).
 *
 * מה שהמפעיל ביקש: "להתממשק עם רשתות אחרות, להישאר עם גישה לחוזים שלנו שם,
 * ולפעול חופשי — דבר-גורר-דבר וגשרים בין הרשתות".
 *
 * הארכיטקטורה-הכנה (אפס-תלות בגורם-חוץ לסליקה-פנימית):
 *  · OUT (withdraw): מי-שרוצה-להוציא נועל נכס בחשבון-ה-escrow הריבוני ("bridge")
 *    דרך xfer_free (אפס-גז) → כוונה-רשומה בפנקס → החוזה-שלנו-שם (SAOSRelay
 *    0xa52D85cA… על ETH-mainnet, או האנקרים custom_json על STEEM/HIVE) מקבל
 *    שחרור-מאומת-מפעיל (מימוש-בפועל דורש מפתח-ממומן — כנות: סטטוס manual).
 *  · IN (deposit): הפקדה-על-החוזה-שלנו-שם (או עיגון) נרשמת-ככוונת-כניסה עם
 *    proofRef (txid/hash של הרשת-החוץ) → claim משלם מה-escrow-הפנימי ב-xfer_free
 *    (אפס-גז — חשבון-ה-escrow לא צריך אפילו קרדיטים) → רשום-כ-paid.
 *  · הפנקס: state/bridge.json (כתיבה-אטומית tmp+rename — אותו-משמעת של
 *    flushSnapshot). הכסף-עצמו זז רק-דרך-הגרעין (xfer_free) → נכלל-ב-stateRoot,
 *    בחותמות-המרקל ובאינווריאנטות-הברזל. הפנקס הוא ראיה-חוץ-מצב בלבד.
 *  · fail-closed: רשת-לא-מוכרת/proofRef-לא-64hex/יעד-לא-קיים/סכום-מעל-תקרה →
 *    דחייה. אין-תשלום-מה-escrow בלי-כוונה-pending מתועדת.
 */
import fs from "fs";
import path from "path";
import { getLiveState, nextNonce, submitOp } from "./chain";
import { bal, ASSETS, type Asset } from "./kernel";
import { assertAllowedHost } from "./fence";

/* FIX(Roast-63 · C2): ההוכחה-נעשית-אמת — claim/release מאמתים-את-ה-txid-מול-השרשרת-החוץ
 * (קיום + הצלחה) לפני-תשלום-escrow. לפני-כן כל-64hex-מומצא היה-מקבל-כסף-אמת.
 * saosnet = פנימי-ללא-שרשרת-חוץ — מסומן-כנה כלא-ניתן-לאימות-חוץ. */
export type FarVerify = { verified: boolean; note: string };

const RPC: Record<string, string> = {
  eth: "https://ethereum-rpc.publicnode.com",
  bsc: "https://bsc-rpc.publicnode.com",
  steem: "https://api.steemit.com",
  hive: "https://api.hive.blog",
  tron: "https://api.trongrid.io",
  sol: "https://api.mainnet-beta.solana.com",
};

async function jsonRpc<T>(url: string, body: unknown, timeoutMs = 10_000): Promise<T> {
  assertAllowedHost(url, "bridge.verifyFarTx");
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal, cache: "no-store" });
    return (await res.json()) as T;
  } finally { clearTimeout(t); }
}

/** אימות-קיום-והצלחה-של-tx-על-השרשרת-החוץ (fail-closed — שגיאה = לא-מאומת). */
export async function verifyFarTx(chain: string, txid: string): Promise<FarVerify> {
  const tx = String(txid || "").trim();
  try {
    if (chain === "eth" || chain === "bsc") {
      const r = await jsonRpc<{ result?: { status?: string; blockNumber?: string | null } | null }>(RPC[chain]!, { jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [tx] });
      const rec = r?.result;
      if (!rec) return { verified: false, note: "receipt-not-found (טרם-נכרה-או-tx-לא-קיים)" };
      if (rec.status !== "0x1") return { verified: false, note: `tx-failed-on-chain (status=${rec.status})` };
      return { verified: true, note: `receipt ok @ block ${parseInt(rec.blockNumber ?? "0x0", 16)}` };
    }
    if (chain === "steem" || chain === "hive") {
      const r = await jsonRpc<{ result?: unknown }>(RPC[chain]!, { jsonrpc: "2.0", id: 1, method: "condenser_api.get_transaction", params: [[tx]] });
      if (!r?.result) return { verified: false, note: "tx-not-found (טרם-אינדוקס-או-לא-קיים)" };
      return { verified: true, note: "get_transaction ok (graphene)" };
    }
    if (chain === "tron") {
      const url = new URL(RPC[chain]!); url.pathname = "/wallet/gettransactionbyid";
      const r2 = await jsonRpc<{ ret?: { contractRet?: string }[] } | { Error?: string }>(url.toString(), { value: tx });
      if (!r2 || (r2 as { Error?: string }).Error) return { verified: false, note: "tx-not-found-on-tron" };
      const ret = (r2 as { ret?: { contractRet?: string }[] }).ret?.[0]?.contractRet;
      if (ret !== "SUCCESS") return { verified: false, note: `tx-failed-on-tron (ret=${ret ?? "null"})` };
      return { verified: true, note: "gettransactionbyid ok (SUCCESS)" };
    }
    if (chain === "sol") {
      const r = await jsonRpc<{ result?: { value?: ({ confirmationStatus?: string; err?: unknown } | null)[] } }>(RPC[chain]!, { jsonrpc: "2.0", id: 1, method: "getSignatureStatuses", params: [[tx], { searchTransactionHistory: true }] });
      const s = r?.result?.value?.[0];
      if (!s) return { verified: false, note: "signature-not-found" };
      if (s.err) return { verified: false, note: "tx-failed-on-chain" };
      const fin = s.confirmationStatus === "finalized" || s.confirmationStatus === "confirmed";
      return fin ? { verified: true, note: `signature ok (${s.confirmationStatus})` } : { verified: false, note: `awaiting (${s.confirmationStatus})` };
    }
    return { verified: false, note: `chain-${chain}-לא-ניתן-לאימות-חוץ (פנימי/לא-נתמך)` };
  } catch (e) {
    return { verified: false, note: `verify-error: ${String((e as Error)?.message ?? e).slice(0, 90)}` };
  }
}

export const BRIDGE_ACCOUNT = "bridge"; // escrow-ריבוני — יתרות-נעולות של-הגשר
export const BRIDGE_CLAIM_CAP = 2_000_000; // תקרת-תשלום/נעילה-פר-כוונה (µ) — גבול-נזק
/** החוזה-שלנו-שם: SAOSRelay על ETH-mainnet (מבוקר-חי: eth_getCode + sha256 runtime — סבב-12-a). */
export const FAR_CONTRACT = { chain: "eth", name: "SAOSRelay", address: "0xa52D85cAa4C04C15cE60d0c582e8C138d16678E6", note: "events-only anchor() — שחרור-ממומש דורש gas-ממומן (כנות)" };
export const FAR_CHAINS = ["eth", "bsc", "tron", "sol", "steem", "hive", "saosnet"] as const;
export type FarChain = (typeof FAR_CHAINS)[number];

const BRIDGE_FILE = path.join(process.cwd(), "state", "bridge.json");

export interface BridgeIntent {
  id: string;
  dir: "in" | "out";
  chain: string;
  asset: Asset;
  amountMu: number;
  party: string; // מוטב-הכניסה / נועל-היציאה (על-הרשת-שלנו)
  farAddress?: string;
  proofRef?: string; // txid/hash-64hex על-הרשת-החוץ
  status: "pending" | "paid" | "locked" | "released";
  ourTxRef?: string; // עדות-פעולה-מהגרעין (מזהה-ה-op)
  verified?: boolean; // FIX(Roast-63): האם-ההוכחה-אומתה-על-השרשרת-החוץ
  verifiedNote?: string; // פירוט-האימות (כנות-מלאה)
  at: number; updatedAt: number;
}

interface Ledger { intents: BridgeIntent[] }

function readLedger(): Ledger {
  try {
    const raw = JSON.parse(fs.readFileSync(BRIDGE_FILE, "utf8")) as Ledger;
    if (Array.isArray(raw?.intents)) return { intents: raw.intents.slice(0, 200) };
  } catch { /* אין-פנקס — חדש */ }
  return { intents: [] };
}

function writeLedger(l: Ledger): void {
  try {
    fs.mkdirSync(path.dirname(BRIDGE_FILE), { recursive: true });
    const tmp = BRIDGE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(l, null, 1));
    fs.renameSync(tmp, BRIDGE_FILE);
  } catch { /* כשל-כתיבה לא מפיל — הכסף בגרעין, הפנקס ראיה */ }
}

const hex64 = (s: string): boolean => /^[0-9a-fA-F]{64}$/.test(s);
// FIX(Roast-63): חתימות-SOL הן-base58 (43..88 תווים) — לא-64hex; הסינון-הישן-חסם-SOL-לגמרי
const b58 = (s: string): boolean => /^[1-9A-HJ-NP-Za-km-z]{43,88}$/.test(s);
const proofOk = (chain: string, s: string): boolean => (chain === "sol" ? b58(s) : hex64(s));
const idOk = (s: string): boolean => /^[a-z0-9][a-z0-9-]{0,30}$/.test(s);

function accountExists(who: string): boolean {
  const st = getLiveState();
  return (st.credits[who] ?? 0) > 0 || Object.keys(st.balances[who] ?? {}).length > 0;
}

export interface BridgeView {
  escrow: Record<string, number>; // יתרות-ה-escrow החיות (µ)
  intents: BridgeIntent[];
  caps: { claimMu: number };
  farContract: typeof FAR_CONTRACT;
  chains: readonly string[];
  honesty: string;
}

export function getBridgeView(): BridgeView {
  const st = getLiveState();
  const escrow: Record<string, number> = {};
  for (const [a, mu] of Object.entries(st.balances[BRIDGE_ACCOUNT] ?? {})) {
    if (mu > 0) escrow[a] = mu;
  }
  return {
    escrow,
    intents: readLedger().intents.slice(-40).reverse(), // הטריים-ראשונה
    caps: { claimMu: BRIDGE_CLAIM_CAP },
    farContract: FAR_CONTRACT,
    chains: FAR_CHAINS,
    honesty: "FIX(Roast-63): סליקה-פנימית דרך-הגרעין (xfer_free אפס-גז) · claim/release מאמתים-את-ההוכחה-מול-השרשרת-החוץ (RPC-מקובע) לפני-כסף · OUT/IN-מול-רשתות-חוץ דורש מפתח-ממומן (מגודר)",
  };
}

export type BridgeErr = { ok: false; error: string } | { ok: true; intent: BridgeIntent };

export function registerInbound(p: { chain: string; proofRef: string; asset: string; amountMu: number; beneficiary: string; farAddress?: string }): BridgeErr {
  const chain = String(p.chain || "").toLowerCase();
  if (!(FAR_CHAINS as readonly string[]).includes(chain)) return { ok: false, error: `bad-chain (מותר: ${FAR_CHAINS.join("|")})` };
  if (!proofOk(chain, String(p.proofRef || ""))) return { ok: false, error: `bad-proofRef (נדרש 64-hex, ול-SOL: base58)` };
  if (!ASSETS.includes(p.asset as Asset)) return { ok: false, error: "bad-asset" };
  const amountMu = Math.floor(Number(p.amountMu));
  if (!(amountMu > 0) || amountMu > BRIDGE_CLAIM_CAP) return { ok: false, error: `bad-amount (1..${BRIDGE_CLAIM_CAP}µ)` };
  const beneficiary = String(p.beneficiary || "").toLowerCase();
  if (!idOk(beneficiary) || !accountExists(beneficiary)) return { ok: false, error: "bad-beneficiary (אין-חשבונות-רפאים — המוטב חייב-להיות-בפנקס-החי)" };
  const proofRef = String(p.proofRef).toLowerCase();
  const l = readLedger();
  if (l.intents.some((i) => i.proofRef === proofRef && i.dir === "in")) return { ok: false, error: "duplicate-proofRef (אנטי-שימוש-כפול)" };
  const intent: BridgeIntent = {
    id: `in-${Date.now().toString(36)}-${l.intents.length.toString(36)}`,
    dir: "in", chain, asset: p.asset as Asset, amountMu,
    party: beneficiary, farAddress: p.farAddress ? String(p.farAddress).slice(0, 66) : undefined,
    proofRef, status: "pending", at: Date.now(), updatedAt: Date.now(),
  };
  l.intents.push(intent); writeLedger(l);
  return { ok: true, intent };
}

export async function claimInbound(p: { id: string }): Promise<BridgeErr> {
  const l = readLedger();
  const intent = l.intents.find((i) => i.id === String(p.id || ""));
  if (!intent || intent.dir !== "in") return { ok: false, error: "intent-not-found" };
  if (intent.status !== "pending") return { ok: false, error: `bad-state:${intent.status}` };
  // FIX(Roast-63 · C2): אין-תשלום-על-64hex-מומצא — חייב-אימות-חוץ-אמת (פרט-ל-saosnet-פנימי)
  const v = await verifyFarTx(intent.chain, intent.proofRef ?? "");
  intent.verified = v.verified; intent.verifiedNote = v.note;
  if (!v.verified) {
    intent.updatedAt = Date.now(); writeLedger(l);
    return { ok: false, error: `proof-unverified (${v.note}) — ההוכחה-לא-אומתה-על-השרשרת-החוץ` };
  }
  const st = getLiveState();
  if (bal(st, BRIDGE_ACCOUNT, intent.asset) < intent.amountMu) { intent.updatedAt = Date.now(); writeLedger(l); return { ok: false, error: "escrow-shortfall (ה-escrow-לא-ממומן-מספיק)" }; }
  const r = submitOp({ type: "xfer_free", issuer: BRIDGE_ACCOUNT, nonce: nextNonce("brg"), to: intent.party, asset: intent.asset, amount: intent.amountMu });
  if (!r.queued) { intent.updatedAt = Date.now(); writeLedger(l); return { ok: false, error: r.reason ?? "queue-rejected" }; }
  intent.status = "paid"; intent.ourTxRef = `xfer_free:${intent.id}`; intent.updatedAt = Date.now();
  writeLedger(l);
  return { ok: true, intent };
}

export function lockOutbound(p: { issuer: string; asset: string; amountMu: number; chain: string; farAddress?: string }): BridgeErr {
  const issuer = String(p.issuer || "").toLowerCase();
  if (!idOk(issuer) || !accountExists(issuer)) return { ok: false, error: "bad-issuer" };
  if (!ASSETS.includes(p.asset as Asset)) return { ok: false, error: "bad-asset" };
  const amountMu = Math.floor(Number(p.amountMu));
  if (!(amountMu > 0) || amountMu > BRIDGE_CLAIM_CAP) return { ok: false, error: `bad-amount (1..${BRIDGE_CLAIM_CAP}µ)` };
  const chain = String(p.chain || "").toLowerCase();
  if (!(FAR_CHAINS as readonly string[]).includes(chain)) return { ok: false, error: `bad-chain (מותר: ${FAR_CHAINS.join("|")})` };
  const st = getLiveState();
  if (bal(st, issuer, p.asset) < amountMu) return { ok: false, error: "insufficient" };
  const r = submitOp({ type: "xfer_free", issuer, nonce: nextNonce("blo"), to: BRIDGE_ACCOUNT, asset: p.asset as Asset, amount: amountMu });
  if (!r.queued) return { ok: false, error: r.reason ?? "queue-rejected" };
  const l = readLedger();
  const intent: BridgeIntent = {
    id: `out-${Date.now().toString(36)}-${l.intents.length.toString(36)}`,
    dir: "out", chain, asset: p.asset as Asset, amountMu,
    party: issuer, farAddress: p.farAddress ? String(p.farAddress).slice(0, 66) : undefined,
    status: "locked", ourTxRef: `xfer_free:${issuer}→bridge`, at: Date.now(), updatedAt: Date.now(),
  };
  l.intents.push(intent); writeLedger(l);
  return { ok: true, intent };
}

export async function markReleased(p: { id: string; farTxid: string }): Promise<BridgeErr> {
  const l = readLedger();
  const intent = l.intents.find((i) => i.id === String(p.id || ""));
  if (!intent || intent.dir !== "out") return { ok: false, error: "intent-not-found" };
  if (intent.status !== "locked") return { ok: false, error: `bad-state:${intent.status}` };
  if (!proofOk(intent.chain, String(p.farTxid || ""))) return { ok: false, error: `bad-farTxid (נדרש 64-hex, ול-SOL: base58)` };
  // FIX(Roast-63 · C2): השחרור-מסומן-"released" רק-אחרי-אימות-ה-txid-על-השרשרת-החוץ
  const v = await verifyFarTx(intent.chain, String(p.farTxid));
  intent.verified = v.verified; intent.verifiedNote = v.note;
  if (!v.verified) {
    intent.updatedAt = Date.now(); writeLedger(l);
    return { ok: false, error: `farTxid-unverified (${v.note}) — נשאר-locked` };
  }
  intent.status = "released"; intent.proofRef = String(p.farTxid).toLowerCase(); intent.updatedAt = Date.now();
  writeLedger(l);
  return { ok: true, intent };
}
