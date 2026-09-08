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
    honesty: "סליקה-פנימית דרך-הגרעין (xfer_free אפס-גז) · OUT/IN-מול-רשתות-חוץ דורש מפתח-ממומן (מגודר) — הסטטוסים כנים",
  };
}

export type BridgeErr = { ok: false; error: string } | { ok: true; intent: BridgeIntent };

export function registerInbound(p: { chain: string; proofRef: string; asset: string; amountMu: number; beneficiary: string; farAddress?: string }): BridgeErr {
  const chain = String(p.chain || "").toLowerCase();
  if (!(FAR_CHAINS as readonly string[]).includes(chain)) return { ok: false, error: `bad-chain (מותר: ${FAR_CHAINS.join("|")})` };
  if (!hex64(String(p.proofRef || ""))) return { ok: false, error: "bad-proofRef (נדרש 64-hex)" };
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

export function claimInbound(p: { id: string }): BridgeErr {
  const l = readLedger();
  const intent = l.intents.find((i) => i.id === String(p.id || ""));
  if (!intent || intent.dir !== "in") return { ok: false, error: "intent-not-found" };
  if (intent.status !== "pending") return { ok: false, error: `bad-state:${intent.status}` };
  const st = getLiveState();
  if (bal(st, BRIDGE_ACCOUNT, intent.asset) < intent.amountMu) return { ok: false, error: "escrow-shortfall (ה-escrow-לא-ממומן-מספיק)" };
  const r = submitOp({ type: "xfer_free", issuer: BRIDGE_ACCOUNT, nonce: nextNonce("brg"), to: intent.party, asset: intent.asset, amount: intent.amountMu });
  if (!r.queued) return { ok: false, error: r.reason ?? "queue-rejected" };
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

export function markReleased(p: { id: string; farTxid: string }): BridgeErr {
  const l = readLedger();
  const intent = l.intents.find((i) => i.id === String(p.id || ""));
  if (!intent || intent.dir !== "out") return { ok: false, error: "intent-not-found" };
  if (intent.status !== "locked") return { ok: false, error: `bad-state:${intent.status}` };
  if (!hex64(String(p.farTxid || ""))) return { ok: false, error: "bad-farTxid (נדרש 64-hex)" };
  intent.status = "released"; intent.proofRef = String(p.farTxid).toLowerCase(); intent.updatedAt = Date.now();
  writeLedger(l);
  return { ok: true, intent };
}
