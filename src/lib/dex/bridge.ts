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
 *  · fail-closed: רשת-לא-מוכרת/proofRef-לא-תקין-לרשת/יעד-לא-קיים/סכום-מעל-תקרה →
 *    דחייה. אין-תשלום-מה-escrow בלי-כוונה-pending מתועדת.
 *
 * FIX(Roast-64-c) — ארבעה-סגירות-כסף:
 *  · F1 [HIGH]: verifyFarTx מאמת **קישור** (binding) ולא קיום: נמען+סכום+מקור
 *    מול-הכוונה-הרשומה. כל-רשומה-ברישום נושאת farAddress/farAmount/farMemo/farSource,
 *    וכל-תשלום/שחרור מחויב-אליהם. מסילה-שאינה-מצליחה-להוכיח קישור → דחייה-כנה
 *    ("amount-unverifiable-on-this-rail") — סירוב-כן עדיף על תשלום-פייק.
 *  · F2 [HIGH]: הפנקס שומר **את-החדשים** (slice(-200)) ולא את-הישנים; בנוסף
 *    רישום-קבוע state/bridge-seen.json (proofRef→{intentId,dir,at}) — בדיקת-
 *    כפילות מול-הרישום-בשני-הכיוונים, גיזום-30-יום. proofRef שנסלק פעם-אחת
 *    לא-ניתן-לסליקה-שנייה גם-אחרי-גלישת-חלון-הפנקס.
 *  · F3 [HIGH]: תיקוף-proofRef-פר-רשת: steem|hive=40-hex · eth|bsc|tron=64-hex
 *    (עם/בלי 0x) · sol=base58 32..88 · רשת-לא-מוכרת=דחייה.
 *  · F4 [MED]: SOL=finalized-בלבד (confirmed זה חלון-ריאורג); EVM/TRON דורשים
 *    עומק ≥3 בלוקים מתחת-לראש; עומק-שאינו-נמדד → דחייה ("depth-unmeasurable").
 */
import fs from "fs";
import path from "path";
import { getLiveState, nextNonce, submitOp } from "./chain";
import { bal, ASSETS, type Asset } from "./kernel";
import { assertAllowedHost } from "./fence";

export type FarVerify = { verified: boolean; note: string };

/** FIX(Roast-64-c · F1): קישור-הכוונה — הציפיות-הרשומות-בעת-היצירה, שהמסילה
 * מחויבת-להוכיח על-השרשרת-החוץ לפני-כסף. כל-שדה שאינו-רשום הוא דחייה-כנה. */
export interface FarExpect {
  farAddress?: string; // כתובת/חשבון-היעד-על-הרשת-החוץ (נדרש-בכל-המסילות)
  farAmount?: string;  // סכום-צפוי: יחידות-מינימום (eth/bsc/tron/sol) או מחרוזת-נכס ("10.000 STEEM")
  farMemo?: string;    // תזכיר-צפוי (steem/hive)
  farSource?: string;  // בעלים-המקור-הצפוי (tron owner_address / steem from)
}

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

/* ── FIX(Roast-64-c · F3): תיקוף-proofRef-פר-רשת ─────────────────────────────
 * STEEM/HIVE-txids הם 40-hex (לא-64!) — הסינון-ההיסטורי hex64 היה הורג-את-שתי-
 * המסילות מהלידה. eth/bsc: 0x+64hex או 64-hex · tron: 64-hex · sol: base58. */
const RE_HEX40 = /^[0-9a-f]{40}$/i;
const RE_HEX64 = /^[0-9a-f]{64}$/i;
const RE_HEX64X = /^0x[0-9a-f]{64}$/i;
const RE_B58 = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/;

export function proofOk(chain: string, s: string): boolean {
  const t = String(s || "").trim();
  switch (chain) {
    case "steem":
    case "hive":
      return RE_HEX40.test(t);
    case "eth":
    case "bsc":
      return RE_HEX64X.test(t) || RE_HEX64.test(t);
    case "tron":
      return RE_HEX64.test(t) || RE_HEX64X.test(t);
    case "sol":
      return RE_B58.test(t);
    case "saosnet":
      return RE_HEX64.test(t); // פנימי — אין-שרשרת-חוץ (מסומן-כלא-ניתן-לאימות)
    default:
      return false; // רשת-לא-מוכרת → דחייה
  }
}

const idOk = (s: string): boolean => /^[a-z0-9][a-z0-9-]{0,30}$/.test(s);

/* ── FIX(Roast-64-c · F1) עזרי-TRON: base58→hex + פריקת-העברות ─────────────── */
const TRON_TRANSFER_TOPIC = "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"; // keccak("Transfer(address,address,address)")

async function tronAddrToHex21(addr: string): Promise<string | null> {
  const a = addr.trim();
  if (/^41[0-9a-fA-F]{40}$/.test(a)) return a.toLowerCase();
  try {
    const m = (await import("bs58")) as unknown as { default: { decode(s: string): Uint8Array } };
    const raw = Buffer.from(m.default.decode(a));
    if (raw.length !== 25 || raw[0] !== 0x41) return null;
    return raw.subarray(0, 21).toString("hex").toLowerCase();
  } catch { return null; }
}

type TronTx = { ret?: { contractRet?: string }[]; raw_data?: { contract?: { type?: string; parameter?: { value?: { owner_address?: string; to_address?: string; amount?: number | string } } }[] } };
type TronInfo = { blockNumber?: number; log?: { address?: string; topics?: string[]; data?: string }[] };
type TronHead = { block_header?: { raw_data?: { number?: number } } };

/** פרקי-נכס-גרפני: "123.456 STEEM" → [123.456, "STEEM"]. */
function parseAsset(s: string): [number, string] | null {
  const m = /^\s*([\d,]+(?:\.\d+)?)\s+([A-Za-z]{2,10})\s*$/.exec(String(s || ""));
  if (!m) return null;
  const v = parseFloat(m[1]!.replace(/,/g, ""));
  return Number.isFinite(v) ? [v, m[2]!.toUpperCase()] : null;
}

const subOk = (have: number | null, want: number | null): boolean =>
  have !== null && want !== null && have + 1e-9 >= want;

/** אימות-tx-על-השרשרת-החוץ — **מחויב** (fail-closed): קיום+הצלחה+עומק+נמען+סכום.
 * שגיאה/אי-יכולת-הוכחה = לא-מאומת. אין-תשלום-על-קיום-בלבד (FIX Roast-64-c F1). */
export async function verifyFarTx(chain: string, txid: string, expect: FarExpect = {}): Promise<FarVerify> {
  const tx = String(txid || "").trim();
  try {
    if (chain === "eth" || chain === "bsc") {
      const r = await jsonRpc<{ result?: { status?: string; blockNumber?: string | null } | null }>(RPC[chain]!, { jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [tx] });
      const rec = r?.result;
      if (!rec) return { verified: false, note: "receipt-not-found (טרם-נכרה-או-tx-לא-קיים)" };
      if (rec.status !== "0x1") return { verified: false, note: `tx-failed-on-chain (status=${rec.status})` };
      // FIX(F4): עומק-אישור — הקבלה חייבת לשכב ≥3 בלוקים מתחת לראש; שאינו-נמדד = דחייה
      const head = await jsonRpc<{ result?: string | null }>(RPC[chain]!, { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }).catch(() => null);
      const headN = head?.result ? parseInt(head.result, 16) : NaN;
      const txN = rec.blockNumber ? parseInt(rec.blockNumber, 16) : NaN;
      if (!Number.isFinite(headN) || !Number.isFinite(txN)) return { verified: false, note: "depth-unmeasurable-on-this-rail — refusing (fail-closed)" };
      if (headN - txN < 3) return { verified: false, note: `awaiting-depth (d=${headN - txN} < 3)` };
      // FIX(F1): קישור-נמען+סכום — קיום-הקבלה אינו-ראיה-לתשלום
      if (!expect.farAddress) return { verified: false, note: "recipient-unregistered — אין-קישור-נמען-רשום-על-הכוונה (refused)" };
      const t2 = await jsonRpc<{ result?: { to?: string | null; value?: string | null } | null }>(RPC[chain]!, { jsonrpc: "2.0", id: 1, method: "eth_getTransactionByHash", params: [tx] });
      const body = t2?.result;
      if (!body) return { verified: false, note: "tx-body-not-found" };
      const to = String(body.to ?? "").toLowerCase();
      if (to !== expect.farAddress.trim().toLowerCase()) return { verified: false, note: `wrong-recipient (to=${(to || "null").slice(0, 14)}…) — refused` };
      const wei = typeof body.value === "string" ? BigInt(body.value) : 0n;
      if (wei <= 0n) return { verified: false, note: "amount-unverifiable-on-this-rail (native-value=0 — ERC-20/event לא-ניתן-לקישור-במסילה-זו)" };
      if (!expect.farAmount) return { verified: false, note: "amount-unverifiable-on-this-rail (לא-נרשם-סכום-צפוי-בwei)" };
      if (!/^\d+$/.test(expect.farAmount.trim())) return { verified: false, note: "amount-unverifiable-on-this-rail (farAmount-פורמט-פסול)" };
      if (wei < BigInt(expect.farAmount.trim())) return { verified: false, note: "amount-short-on-chain — refused" };
      return { verified: true, note: `receipt ok @ block ${txN} · depth ${headN - txN} · bound: to+value` };
    }
    if (chain === "steem" || chain === "hive") {
      const r = await jsonRpc<{ result?: { operations?: [string, Record<string, unknown>][] } | null }>(RPC[chain]!, { jsonrpc: "2.0", id: 1, method: "condenser_api.get_transaction", params: [[tx]] });
      const ops = r?.result?.operations;
      if (!Array.isArray(ops)) return { verified: false, note: "tx-not-found (טרם-אינדוקס-או-לא-קיים)" };
      // FIX(F1): נדרש-op-העברה-המקושר לנמען הרשום; סכום/ממו/מקור נאכפים כשהכוונה מקודדת אותם
      if (!expect.farAddress) return { verified: false, note: "recipient-unregistered — אין-קישור-נמען-רשום-על-הכוונה (refused)" };
      const want = expect.farAmount ? parseAsset(expect.farAmount) : null;
      if (expect.farAmount && !want) return { verified: false, note: "amount-unverifiable-on-this-rail (farAmount-פורמט-פסול)" };
      for (const entry of ops) {
        const [name, body] = entry ?? ["", {}];
        if (!["transfer", "transfer_to_vesting", "transfer_from_savings"].includes(name)) continue;
        const to = String(body?.to ?? "").toLowerCase();
        if (to !== expect.farAddress.trim().toLowerCase()) continue;
        if (expect.farSource && String(body?.from ?? "").toLowerCase() !== expect.farSource.trim().toLowerCase()) continue;
        if (want) {
          const got = parseAsset(String(body?.amount ?? ""));
          if (!got || got[1] !== want[1] || !subOk(got[0], want[0])) continue;
        }
        if (expect.farMemo && String(body?.memo ?? "") !== expect.farMemo) continue;
        return { verified: true, note: `get_transaction ok (graphene) · bound: ${name} ${String(body?.amount ?? "?")} → ${to}` };
      }
      return { verified: false, note: "no-bound-op — אין-op-המקושר לנמען/סכום/ממו הרשומים (refused)" };
    }
    if (chain === "tron") {
      const url = new URL(RPC[chain]!); url.pathname = "/wallet/gettransactionbyid";
      const r2 = await jsonRpc<TronTx | { Error?: string }>(url.toString(), { value: tx, visible: false });
      if (!r2 || (r2 as { Error?: string }).Error) return { verified: false, note: "tx-not-found-on-tron" };
      const ret = (r2 as TronTx).ret?.[0]?.contractRet;
      if (ret !== "SUCCESS") return { verified: false, note: `tx-failed-on-tron (ret=${ret ?? "null"})` };
      // FIX(F4): עומק — הפער בין בלוק-האישור לראש-השרשרת ≥3; שאינו-נמדד = דחייה
      const infoUrl = new URL(RPC[chain]!); infoUrl.pathname = "/wallet/gettransactioninfobyid";
      const nowUrl = new URL(RPC[chain]!); nowUrl.pathname = "/wallet/getnowblock";
      const [info, head] = await Promise.all([
        jsonRpc<TronInfo>(infoUrl.toString(), { value: tx, visible: false }).catch(() => null),
        jsonRpc<TronHead>(nowUrl.toString(), {}).catch(() => null),
      ]);
      const txBlock = typeof info?.blockNumber === "number" ? info.blockNumber : NaN;
      const headBlock = Number(head?.block_header?.raw_data?.number);
      if (!Number.isFinite(txBlock) || !Number.isFinite(headBlock)) return { verified: false, note: "depth-unmeasurable-on-this-rail — refusing (fail-closed)" };
      if (headBlock - txBlock < 3) return { verified: false, note: `awaiting-depth (d=${headBlock - txBlock} < 3)` };
      // FIX(F1): קישור — TransferContract (native) או לוג-TRC-20-Transfer מול הרשום
      const contract = (r2 as TronTx).raw_data?.contract?.[0];
      if (!contract?.type) return { verified: false, note: "amount-unverifiable-on-this-rail (contract-unparseable)" };
      if (!expect.farAddress) return { verified: false, note: "recipient-unregistered — אין-קישור-נמען-רשום-על-הכוונה (refused)" };
      const far21 = await tronAddrToHex21(expect.farAddress);
      if (!far21) return { verified: false, note: "far-address-unparseable (לא-base58-ולא-hex41)" };
      const far20 = far21.slice(2);
      if (contract.type === "TransferContract") {
        const v = contract.parameter?.value ?? {};
        const toHex = String(v.to_address ?? "").toLowerCase();
        if (toHex !== far21) return { verified: false, note: `wrong-recipient (to=${toHex.slice(0, 14)}…) — refused` };
        if (expect.farSource) {
          const srcHex = await tronAddrToHex21(expect.farSource);
          if (!srcHex || String(v.owner_address ?? "").toLowerCase() !== srcHex) return { verified: false, note: "wrong-source (owner_address != registered farSource) — refused" };
        }
        if (!expect.farAmount) return { verified: false, note: "amount-unverifiable-on-this-rail (לא-נרשם-סכום-צפוי-בsun)" };
        if (!/^\d+$/.test(expect.farAmount.trim())) return { verified: false, note: "amount-unverifiable-on-this-rail (farAmount-פורמט-פסול)" };
        const amt = Number(v.amount ?? 0);
        if (!(amt >= Number(expect.farAmount.trim()))) return { verified: false, note: "amount-short-on-chain — refused" };
        return { verified: true, note: `gettransactionbyid ok (SUCCESS) · depth ${headBlock - txBlock} · bound: TransferContract to+amount` };
      }
      if (contract.type === "TriggerSmartContract") {
        const logs = Array.isArray(info?.log) ? info!.log! : [];
        const hit = logs.find((lg) =>
          Array.isArray(lg.topics) && (lg.topics[0] ?? "").toLowerCase() === TRON_TRANSFER_TOPIC &&
          (lg.topics[2] ?? "").toLowerCase().endsWith(far20.toLowerCase()),
        );
        if (!hit) return { verified: false, note: "no-binding — אין-לוג-TRC-20-Transfer אל-הכתובת-הרשומה (refused)" };
        if (!expect.farAmount) return { verified: false, note: "amount-unverifiable-on-this-rail (לא-נרשם-סכום-צפוי-ביחידות-הטוקן)" };
        if (!/^\d+$/.test(expect.farAmount.trim())) return { verified: false, note: "amount-unverifiable-on-this-rail (farAmount-פורמט-פסול)" };
        try {
          const dataHex = String(hit.data ?? "0x0");
          const amt = BigInt("0x" + dataHex.replace(/^0x/, "").replace(/^0+(?=\d)/, "") || "0");
          if (amt < BigInt(expect.farAmount.trim())) return { verified: false, note: "amount-short-on-chain — refused" };
        } catch { return { verified: false, note: "amount-unverifiable-on-this-rail (log-data-unparseable)" }; }
        return { verified: true, note: `gettransactionbyid ok (SUCCESS) · depth ${headBlock - txBlock} · bound: TRC-20 Transfer log to+amount` };
      }
      return { verified: false, note: `amount-unverifiable-on-this-rail (contract-type=${contract.type})` };
    }
    if (chain === "sol") {
      const r = await jsonRpc<{ result?: { value?: ({ confirmationStatus?: string; err?: unknown } | null)[] } }>(RPC[chain]!, { jsonrpc: "2.0", id: 1, method: "getSignatureStatuses", params: [[tx], { searchTransactionHistory: true }] });
      const s = r?.result?.value?.[0];
      if (!s) return { verified: false, note: "signature-not-found" };
      if (s.err) return { verified: false, note: "tx-failed-on-chain" };
      // FIX(F4): finalized-בלבד — "confirmed" נמצא-בחלון-ריאורג (אותו-סטנדרט של ה-Relay)
      if (s.confirmationStatus !== "finalized") return { verified: false, note: `awaiting finalized (now: ${s.confirmationStatus ?? "processed"})` };
      // FIX(F1): קישור — הכתובת-הרשומה חייבת להופיע בהודעה (fee-payer/accounts) או בלוגים
      if (!expect.farAddress) return { verified: false, note: "recipient-unregistered — אין-קישור-כתובת-רשום-על-הכוונה (refused)" };
      const g = await jsonRpc<{ result?: { transaction?: { message?: { accountKeys?: string[] } }; meta?: { logMessages?: string[] } } | null }>(RPC[chain]!, { jsonrpc: "2.0", id: 1, method: "getTransaction", params: [[tx], { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 }] });
      if (!g?.result) return { verified: false, note: "tx-body-not-indexed (finalized-אך-הגוף-לא-זמין)" };
      const keys = g.result.transaction?.message?.accountKeys ?? [];
      const logs = g.result.meta?.logMessages ?? [];
      const bound = keys.includes(expect.farAddress) || logs.some((l) => l.includes(expect.farAddress!));
      if (!bound) return { verified: false, note: "no-binding — הכתובת-הרשומה אינה מופיעה בהודעה/לוגים (refused)" };
      return { verified: true, note: "signature ok (finalized) · bound: far-address mentioned in tx accounts/logs" };
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
  farAddress?: string;  // FIX(F1): נמען-החוץ-הרשום — חובה-לקישור
  farAmount?: string;   // FIX(F1): סכום-החוץ-הצפוי (יחידות-מינימום/מחרוזת-נכס)
  farMemo?: string;     // FIX(F1): תזכיר-צפוי (steem/hive)
  farSource?: string;   // FIX(F1): בעלים-המקור-הצפוי (tron/steem)
  proofRef?: string;    // txid/hash-על-הרשת-החוץ (תיקוף-פר-רשת — F3)
  status: "pending" | "paid" | "locked" | "released";
  ourTxRef?: string; // עדות-פעולה-מהגרעין (מזהה-ה-op)
  verified?: boolean; // FIX(Roast-63): האם-ההוכחה-אומתה-על-השרשרת-החוץ
  verifiedNote?: string; // פירוט-האימות (כנות-מלאה)
  at: number; updatedAt: number;
}

interface Ledger { intents: BridgeIntent[] }

/** FIX(Roast-64-c · F2): הפנקס שומר **את-החדשים** — slice(-200). ההיסטורי
 * slice(0,200) שמר את הישנים: אחרי-200-רשומות כוונות-חדשות נעלמו ובדיקת-
 * הכפילות סרקה-חלון-מת (אותו-txid היה-ניתן-לתביעה-חוזרת). */
function readLedger(): Ledger {
  try {
    const raw = JSON.parse(fs.readFileSync(BRIDGE_FILE, "utf8")) as Ledger;
    if (Array.isArray(raw?.intents)) return { intents: raw.intents.slice(-200) };
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

/* ── FIX(Roast-64-c · F2): רישום-proofRef-קבוע (state/bridge-seen.json) ────────
 * proofRef→{intentId,dir,at} — נטען-באתחול-המודול, נשמר-אטומית (tmp+rename)
 * בכל-claim/release. נבדק-בשני-הכיוונים (in+out) בכל-רישום/תביעה, כך-שגם-אחרי
 * גלישת-חלון-200-של-הפנקס אין-סליקה-כפולה. גיזום: רשומות-מעל-30-יום. */
const SEEN_FILE = path.join(process.cwd(), "state", "bridge-seen.json");
const SEEN_TTL_MS = 30 * 24 * 60 * 60_000; // 30 יום
interface SeenEntry { intentId: string; dir: "in" | "out"; at: number }
type SeenRegistry = Record<string, SeenEntry>;
let seenCache: SeenRegistry | null = null;

function seenPrune(m: SeenRegistry): void {
  const cut = Date.now() - SEEN_TTL_MS;
  for (const k of Object.keys(m)) {
    if (!(Number(m[k]?.at) >= cut)) delete m[k];
  }
}

function seenLoad(): SeenRegistry {
  if (seenCache) return seenCache;
  try {
    const raw = JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")) as SeenRegistry;
    seenCache = raw && typeof raw === "object" ? raw : {};
  } catch { /* אין-רישום — פתיחה-נקייה */ }
  seenCache ??= {};
  seenPrune(seenCache);
  return seenCache;
}

function seenSave(): void {
  if (!seenCache) return;
  try {
    fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
    const tmp = SEEN_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(seenCache));
    fs.renameSync(tmp, SEEN_FILE);
  } catch { /* כשל-שמירה לא מפיל — הפנקס הוא הראיה הראשית */ }
}

function seenHas(proofRef: string): boolean {
  return Object.prototype.hasOwnProperty.call(seenLoad(), proofRef);
}

function seenAdd(proofRef: string, intentId: string, dir: "in" | "out"): void {
  const m = seenLoad();
  m[proofRef] = { intentId, dir, at: Date.now() };
  seenPrune(m);
  seenSave();
}

void seenLoad(); // טעינה-באתחול-המודול (לפני-כל-תביעה)

/** תיקוף-farAmount-פר-רשת בעת-הרישום (fail-closed — פורמט-פסול = דחייה). */
function farAmountOk(chain: string, v: string): boolean {
  const t = v.trim();
  if (chain === "eth" || chain === "bsc" || chain === "tron" || chain === "sol" || chain === "saosnet") {
    return /^\d+$/.test(t) && t.length <= 40; // יחידות-מינימום (wei/sun/atoms)
  }
  if (chain === "steem" || chain === "hive") {
    return parseAsset(t) !== null; // "10.000 STEEM"
  }
  return false;
}

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
  seenRefs: number; // FIX(F2): גודל-רישום-הכפילות-הקבוע
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
    seenRefs: Object.keys(seenLoad()).length,
    honesty:
      "FIX(Roast-64-c): סליקה-פנימית דרך-הגרעין (xfer_free אפס-גז) · claim/release מאמתים **קישור** מול-השרשרת-החוץ (נמען+סכום+עומק≥3/finalized) מול-הכוונה-הרשומה — לא-קיום-בלבד · פנקס=200-חדשים + רישום-כפילות-קבוע (bridge-seen.json, 30-יום) · מסילה-שאינה-מצליחה-להוכיח-קישור מחזירה סירוב-כן (amount-unverifiable-on-this-rail)",
  };
}

export type BridgeErr = { ok: false; error: string } | { ok: true; intent: BridgeIntent };

export function registerInbound(p: {
  chain: string; proofRef: string; asset: string; amountMu: number; beneficiary: string;
  farAddress?: string; farAmount?: string; farMemo?: string; farSource?: string;
}): BridgeErr {
  const chain = String(p.chain || "").toLowerCase();
  if (!(FAR_CHAINS as readonly string[]).includes(chain)) return { ok: false, error: `bad-chain (מותר: ${FAR_CHAINS.join("|")})` };
  // FIX(F3): תיקוף-proofRef-פר-רשת (steem/hive=40hex · eth/bsc/tron=64hex · sol=base58)
  if (!proofOk(chain, String(p.proofRef || ""))) return { ok: false, error: `bad-proofRef (40-hex ל-steem/hive · 64-hex ל-eth/bsc/tron · base58 ל-SOL)` };
  if (!ASSETS.includes(p.asset as Asset)) return { ok: false, error: "bad-asset" };
  const amountMu = Math.floor(Number(p.amountMu));
  if (!(amountMu > 0) || amountMu > BRIDGE_CLAIM_CAP) return { ok: false, error: `bad-amount (1..${BRIDGE_CLAIM_CAP}µ)` };
  const beneficiary = String(p.beneficiary || "").toLowerCase();
  if (!idOk(beneficiary) || !accountExists(beneficiary)) return { ok: false, error: "bad-beneficiary (אין-חשבונות-רפאים — המוטב חייב-להיות-בפנקס-החי)" };
  // FIX(F1): קישור-חובה — נמען-חוץ חייב-להירשם; סכום-חוץ חייב-פורמט-תקין-לרשת
  const farAddress = p.farAddress ? String(p.farAddress).trim().slice(0, 96) : undefined;
  if (!farAddress) return { ok: false, error: "far-address-required (FIX-Roast-64-c: אין-תשלום-על-tx-לא-מקושר-לנמען-רשום)" };
  const farAmount = p.farAmount ? String(p.farAmount).trim().slice(0, 64) : undefined;
  if (farAmount !== undefined && !farAmountOk(chain, farAmount)) return { ok: false, error: "bad-farAmount (יחידות-מינימום ל-eth/bsc/tron/sol · מחרוזת-נכס ל-steem/hive)" };
  const proofRef = String(p.proofRef).trim().toLowerCase();
  const l = readLedger();
  // FIX(F2): אנטי-כפילות בשני-הכיוונים — חלון-הפנקס **וגם** הרישום-הקבוע
  if (l.intents.some((i) => i.proofRef === proofRef)) return { ok: false, error: "duplicate-proofRef (אנטי-שימוש-כפול)" };
  if (seenHas(proofRef)) return { ok: false, error: "duplicate-proofRef (רישום-קבוע — כבר-נסלק/נשחרר)" };
  const intent: BridgeIntent = {
    id: `in-${Date.now().toString(36)}-${l.intents.length.toString(36)}`,
    dir: "in", chain, asset: p.asset as Asset, amountMu,
    party: beneficiary, farAddress, farAmount,
    farMemo: p.farMemo ? String(p.farMemo).slice(0, 200) : undefined,
    farSource: p.farSource ? String(p.farSource).trim().slice(0, 96) : undefined,
    proofRef, status: "pending", at: Date.now(), updatedAt: Date.now(),
  };
  l.intents.push(intent); writeLedger(l);
  return { ok: true, intent };
}

/** קישור-הכוונה → ציפיות-האימות (F1). */
function expectOf(i: BridgeIntent): FarExpect {
  return { farAddress: i.farAddress, farAmount: i.farAmount, farMemo: i.farMemo, farSource: i.farSource };
}

export async function claimInbound(p: { id: string }): Promise<BridgeErr> {
  const l = readLedger();
  const intent = l.intents.find((i) => i.id === String(p.id || ""));
  if (!intent || intent.dir !== "in") return { ok: false, error: "intent-not-found" };
  if (intent.status !== "pending") return { ok: false, error: `bad-state:${intent.status}` };
  // FIX(F2): סליקה-כפולה נחסמת גם-מהרישום-הקבוע (גם-אם-הכוונה גלשה-מחלון-הפנקס)
  if (intent.proofRef && seenHas(intent.proofRef)) {
    intent.verifiedNote = "duplicate-proofRef-registry — סליקה-כפולה-נחסמה (fail-closed)";
    intent.updatedAt = Date.now(); writeLedger(l);
    return { ok: false, error: "duplicate-proofRef (רישום-קבוע — כבר-נסלק/נשחרר)" };
  }
  // FIX(Roast-63+64-c): אין-תשלום בלי אימות-חוץ **מחויב** (קיום+הצלחה+נמען+סכום+עומק)
  const v = await verifyFarTx(intent.chain, intent.proofRef ?? "", expectOf(intent));
  intent.verified = v.verified; intent.verifiedNote = v.note;
  if (!v.verified) {
    intent.updatedAt = Date.now(); writeLedger(l);
    return { ok: false, error: `proof-unverified (${v.note}) — ההוכחה-לא-נקשרה-לכוונה-על-השרשרת-החוץ` };
  }
  const st = getLiveState();
  if (bal(st, BRIDGE_ACCOUNT, intent.asset) < intent.amountMu) { intent.updatedAt = Date.now(); writeLedger(l); return { ok: false, error: "escrow-shortfall (ה-escrow-לא-ממומן-מספיק)" }; }
  const r = submitOp({ type: "xfer_free", issuer: BRIDGE_ACCOUNT, nonce: nextNonce("brg"), to: intent.party, asset: intent.asset, amount: intent.amountMu });
  if (!r.queued) { intent.updatedAt = Date.now(); writeLedger(l); return { ok: false, error: r.reason ?? "queue-rejected" }; }
  intent.status = "paid"; intent.ourTxRef = `xfer_free:${intent.id}`; intent.updatedAt = Date.now();
  writeLedger(l);
  if (intent.proofRef) seenAdd(intent.proofRef, intent.id, "in"); // FIX(F2): רישום-קבוע-בסליקה
  return { ok: true, intent };
}

export function lockOutbound(p: {
  issuer: string; asset: string; amountMu: number; chain: string;
  farAddress?: string; farAmount?: string; farMemo?: string; farSource?: string;
}): BridgeErr {
  const issuer = String(p.issuer || "").toLowerCase();
  if (!idOk(issuer) || !accountExists(issuer)) return { ok: false, error: "bad-issuer" };
  if (!ASSETS.includes(p.asset as Asset)) return { ok: false, error: "bad-asset" };
  const amountMu = Math.floor(Number(p.amountMu));
  if (!(amountMu > 0) || amountMu > BRIDGE_CLAIM_CAP) return { ok: false, error: `bad-amount (1..${BRIDGE_CLAIM_CAP}µ)` };
  const chain = String(p.chain || "").toLowerCase();
  if (!(FAR_CHAINS as readonly string[]).includes(chain)) return { ok: false, error: `bad-chain (מותר: ${FAR_CHAINS.join("|")})` };
  // FIX(F1): גם-היציאה נרשמת-עם-קישור-חוץ — השחרור יאומת מולו (בלי-זה: נשאר-locked)
  const farAddress = p.farAddress ? String(p.farAddress).trim().slice(0, 96) : undefined;
  if (!farAddress) return { ok: false, error: "far-address-required (FIX-Roast-64-c: שחרור-לא-מקושר-לנמען-רשום = לא-מאומת)" };
  const farAmount = p.farAmount ? String(p.farAmount).trim().slice(0, 64) : undefined;
  if (farAmount !== undefined && !farAmountOk(chain, farAmount)) return { ok: false, error: "bad-farAmount (יחידות-מינימום ל-eth/bsc/tron/sol · מחרוזת-נכס ל-steem/hive)" };
  const st = getLiveState();
  if (bal(st, issuer, p.asset) < amountMu) return { ok: false, error: "insufficient" };
  const r = submitOp({ type: "xfer_free", issuer, nonce: nextNonce("blo"), to: BRIDGE_ACCOUNT, asset: p.asset as Asset, amount: amountMu });
  if (!r.queued) return { ok: false, error: r.reason ?? "queue-rejected" };
  const l = readLedger();
  const intent: BridgeIntent = {
    id: `out-${Date.now().toString(36)}-${l.intents.length.toString(36)}`,
    dir: "out", chain, asset: p.asset as Asset, amountMu,
    party: issuer, farAddress, farAmount,
    farMemo: p.farMemo ? String(p.farMemo).slice(0, 200) : undefined,
    farSource: p.farSource ? String(p.farSource).trim().slice(0, 96) : undefined,
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
  const farTxid = String(p.farTxid || "").trim();
  // FIX(F3): תיקוף-farTxid-פר-רשת
  if (!proofOk(intent.chain, farTxid)) return { ok: false, error: `bad-farTxid (40-hex ל-steem/hive · 64-hex ל-eth/bsc/tron · base58 ל-SOL)` };
  const ref = farTxid.toLowerCase();
  // FIX(F2): אנטי-כפילות מהרישום-הקבוע (שני-הכיוונים)
  if (seenHas(ref)) return { ok: false, error: "duplicate-proofRef (רישום-קבוע — כבר-נסלק/נשחרר)" };
  // FIX(Roast-63+64-c): השחרור-מסומן-"released" רק-אחרי-אימות-מחויב של ה-txid-על-השרשרת-החוץ
  const v = await verifyFarTx(intent.chain, farTxid, expectOf(intent));
  intent.verified = v.verified; intent.verifiedNote = v.note;
  if (!v.verified) {
    intent.updatedAt = Date.now(); writeLedger(l);
    return { ok: false, error: `farTxid-unverified (${v.note}) — נשאר-locked` };
  }
  intent.status = "released"; intent.proofRef = ref; intent.updatedAt = Date.now();
  writeLedger(l);
  seenAdd(ref, intent.id, "out"); // FIX(F2): רישום-קבוע-בשחרור
  return { ok: true, intent };
}
