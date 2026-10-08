/**
 * signer.ts — M2 · הפרדת Signer–Executor (ARCHITECTURE_ROADMAP §M2) · גרסה v1
 * ═══════════════════════════════════════════════════════════════════════════════
 * החוזה (M2): זהו **מודול-המפתחות היחיד** במנוע. כל חומר-מפתח-גולמי (WIF /
 * מפתח-פרטי) נקרא מהסביבה, מנורמל, ונחתם **רק כאן**. נתיבי-הביצוע (relay ·
 * rail-exec) מקבלים טרנזקציות-חתומות ותוצרות-סימון — ומשדרים. אפס-סודות
 * בלוג/תשובה/שגיאה — לעולם.
 *
 * Adaptors (אותו-ממשק, החלפה בזמן-ריצה בלי לגעת ב-Executor):
 *   · EnvSigner (היום — .env של הדמון; Next טוען אוטומטית; .env gitignored-אומת)
 *   · FileSigner — keyfile מוצפן + passphrase בזמן-ריצה (עתיד)
 *   · HsmSigner — PKCS#11 / cloud-KMS (עתיד)
 *
 * M2-v2 (מתוכנן, מחוץ לחלון-החימוש): Executor חף-מפתחות לגמרי — RelayKeys
 * יישמר בתוך-המודול וה-executors יקבלו signed-tx בלבד; נדרש שינוי-צורה על-פני
 * כל consumer-י RelayKeys. ה-v1 מרכז כאן את **קריאת** המפתחות (envKey —
 * נקודת-אכיפה יחידה) ואת **ליבות-החתימה** (graphene/blurt/tron).
 *
 * היסטוריית-העברה: הקוד כאן הועבר מילה-במילה מ-relay.ts (normalizeWif /
 * scalarOf / חתימת-graphene / blurt-SDK / tron) — אפס-שינוי סמנטיקת-חתימה.
 */
import { createHash } from "node:crypto";
import { fencedFetch } from "./fence";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const steem = require("steem") as any;

/* ── חוזה-המפתחות: שמות-env של חומר-מפתח (מקור: relay.ts loadKeys) ────────── */
export const KEY_ENV_NAMES: readonly string[] = [
  "SAOS_RELAY_AGENT_ACCOUNT", "STEEM_POSTING_WIF", "STEEM_ACTIVE_WIF",
  "HIVE_POSTING_WIF", "HIVE_ACTIVE_WIF", "BLURT_ACTIVE_WIF",
  "ETH_PRIVATE_KEY", "SOL_PRIVATE_KEY", "ETH_EXPECTED_ADDRESS", "SOL_EXPECTED_ADDRESS",
  "HIVE_ANCHOR_ACCOUNT",
];

/**
 * envKey — **נקודת-האכיפה היחידה**: הקריאה הלגיטימית היחידה של חומר-מפתח
 * מהסביבה בכל-המנוע. קוד-ביצוע שצריך מפתח — פונה לכאן, לא ל-process.env ישירות.
 * טרים-בלבד; לא מתומחת (ה-hash של loadKeys מגלגל לפי-תוכן).
 */
export function envKey(envName: string): string {
  return (process.env[envName] || "").trim();
}

/** טביעת-אצבע של תוכן-חומר-המפתח (למטמון loadKeys — שינוי-מפתח מזוהה מיד). */
export function keyEnvFingerprint(): string {
  const h = createHash("sha256");
  for (const k of KEY_ENV_NAMES) h.update(`${k}\x00${process.env[k] ?? ""}\x00`);
  return h.digest("hex").slice(0, 16);
}

/* ── bs58 (טעינה-עצלה — זהה ל-relay.ts) ───────────────────────────────────── */
interface Bs58Like { decode(s: string): Uint8Array; encode(b: Uint8Array): string }
let bs58Memo: Bs58Like | null = null;
async function bs58lib(): Promise<Bs58Like> {
  if (!bs58Memo) {
    const m = await import("bs58");
    bs58Memo = ((m as unknown as { default?: Bs58Like }).default ?? (m as unknown as Bs58Like));
  }
  return bs58Memo as Bs58Like;
}

/* ── נירמול-WIF (הועבר מילה-במילה מ-relay.ts · SETTLE-10/11) ──────────────── */
async function normalizeWif(wif: string): Promise<string | null> {
  try {
    const b58 = await bs58lib();
    const raw = Buffer.from(b58.decode(wif.trim()));
    if (raw.length < 34 || raw[0] !== 0x80) return null;
    const data = raw.subarray(0, raw.length - 4);
    const chk = raw.subarray(raw.length - 4);
    const calc = createHash("sha256").update(createHash("sha256").update(data).digest()).digest().subarray(0, 4);
    if (!chk.equals(calc)) return null;
    const body = data.subarray(1);
    const scalar = body.length === 33 && body[32] === 0x01 ? body.subarray(0, 32) : body;
    if (scalar.length !== 32) return null;
    const payload = Buffer.concat([Buffer.from([0x80]), scalar]);
    const chk2 = createHash("sha256").update(createHash("sha256").update(payload).digest()).digest().subarray(0, 4);
    return b58.encode(Buffer.concat([payload, chk2]));
  } catch { return null; }
}

/* WIF-מנורמל-בזיכרון (cache — המפתחות כבר בזיכרון דרך envKey) */
const wifCache = new Map<string, string>();
export async function wifNormalized(wif: string): Promise<string | null> {
  const hit = wifCache.get(wif);
  if (hit !== undefined) return hit;
  const n = await normalizeWif(wif);
  if (n) wifCache.set(wif, n);
  return n;
}

/**
 * pubOfWif — גזירת-פומבי מ-WIF (לשער-סמכות G1) בהתאמת-קידומת.
 * BLURT רושמת-BLT (Roast-82): מחליפים קידומת סביב הגזירה ומשחזרים-תמיד.
 * פליטה-פסולה → null (fail-closed — הקורא מדווח כנה).
 */
export function pubOfWif(wif: string, prefix: "STM" | "BLT" = "STM"): string | null {
  try {
    if (prefix === "BLT") {
      const prev = steem.config.get("address_prefix");
      try {
        steem.config.set("address_prefix", "BLT");
        return steem.auth.wifToPublic(wif) || null;
      } finally {
        try { steem.config.set("address_prefix", prev ?? "STM"); } catch { /* keep */ }
      }
    }
    return steem.auth.wifToPublic(wif) || null;
  } catch { return null; }
}

/** deriveScalar — סקלר-פרטי מ-WIF (הועבר מילה-במילה מ-relay.ts scalarOf). */
export async function deriveScalar(wif: string): Promise<Uint8Array> {
  const b58 = await bs58lib();
  const raw = Buffer.from(b58.decode(wif));
  const data = raw.subarray(0, raw.length - 4);
  return data.subarray(1, 33);
}

/* ── חתימת-גרפנה (הועבר מילה-במילה מ-relay.ts grapheneOpsBroadcast) ───────── */
export interface GrapheneSignedTx {
  ref_block_num: number;
  ref_block_prefix: number;
  expiration: string;
  operations: unknown[];
  extensions: unknown[];
  signatures?: string[];
}

const ZERO_CHAIN_ID = "0000000000000000000000000000000000000000000000000000000000000000";

/**
 * signGrapheneTx — חתימת-טרנזקציה-גרפנית על chain-id של השרשרת.
 * ה-Executor בונה את ה-tx (לא חומר-מפתח), החותם כאן בלבד.
 */
export function signGrapheneTx(
  tx: { ref_block_num: number; ref_block_prefix: number; expiration: string; operations: unknown[]; extensions: unknown[] },
  chainId: string,
  wif: string,
): GrapheneSignedTx {
  const prev = steem.config.get("chain_id");
  steem.config.set("chain_id", chainId);
  try {
    return steem.auth.signTransaction(tx, [wif]) as GrapheneSignedTx;
  } finally {
    try { steem.config.set("chain_id", prev ?? ZERO_CHAIN_ID); } catch { /* keep */ }
  }
}

/* ── BLURT — SDK-הרשמי (@beblurt/dblurt) בלבד (Roast-82 — נמדד-חי) ──────────
 * steem-js חותם-טקס-תקני-לכאורה והשרשרת דוחה "tx_missing_active_auth" —
 * פער-סריאליזציה/חתימה-שקט בין-הספריות; הנתיב-הקנוני-של-BLURT הוא-הפתרון. */
let blurtSdkMemo: { client: any; PrivateKey: any } | null = null;
async function blurtSdk(node: string) {
  if (!blurtSdkMemo) {
    const m = await import("@beblurt/dblurt");
    blurtSdkMemo = { client: new (m as any).Client(node), PrivateKey: (m as any).PrivateKey };
  }
  return blurtSdkMemo;
}

/**
 * signAndSendBlurt — חתימה+שידור על BLURT (ה-SDK מצמיד חתימה-לשידור).
 * מוחזר txid תקני בלבד; תשובה-חסרת-id = זריקה-כנה.
 */
export async function signAndSendBlurt(
  node: string, account: string, ops: unknown[], wif: string,
): Promise<{ txid: string }> {
  const sdk = await blurtSdk(node);
  const key = sdk.PrivateKey.fromString(wif);
  const res = await sdk.client.broadcast.sendOperations(ops, key);
  if (res && typeof res.id === "string" && res.id.length >= 40) return { txid: res.id };
  throw new Error("blurt broadcast answered without id (honest)");
}

/* ── TRON — עיגון self-transfer + extra_data=stateRoot (הועבר מ-relay.ts) ─── */

/** JSON-RPC מגודר (זהה ל-relay.ts rpc — משוכפל-כאן למניעת-מעגל-import). */
async function rpc<T>(endpoint: string, body: unknown, timeoutMs = 20000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fencedFetch(endpoint, "signer.rpc", {
      method: "POST", headers: { "Content-Type": "application/json", "user-agent": "saos-dex-signer/1.0 (+sovereign-dex)" }, body: JSON.stringify(body), signal: ctrl.signal,
    });
    const json = (await res.json()) as { result?: T; error?: { message?: string } };
    if (json.error) throw new Error(json.error.message || "rpc error");
    return json.result as T;
  } finally {
    clearTimeout(t);
  }
}

/**
 * tronic — FIX(F-10b · EXEC-CD-35 · נמדד-חי): POST plain-JSON ל-TRON.
 * ה-rpc() למעלה הוא מטיפוס-JSON-RPC (graphene — תשובה {result,error}); trongrid
 * מחזיר **את-האובייקט-ישירות** ({txID,raw_data_hex,…} / {Error:…}) — קריאה-דרך-rpc()
 * החזירה json.result=undefined תמיד → "createtransaction answered without txID"
 * על-כל-עיגון-TRON מאז-ה-M2. עתה: מהדק-plain שמחזיר את-הגוף-כמות-שהוא.
 */
async function tronic<T>(endpoint: string, body: unknown, timeoutMs = 15000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fencedFetch(endpoint, "signer.rpc", {
      method: "POST", headers: { "content-type": "application/json", "user-agent": "saos-dex-signer/1.0 (+sovereign-dex)" }, body: JSON.stringify(body), signal: ctrl.signal,
    });
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

/**
 * signAndSendTron — עיגון-TRON מותנה-מימון (transfer 1 sun + extra_data = stateRoot).
 * כל-הכישלונות-הכנים נשמרים מילה-במילה (classifier של relay תלוי בהם):
 * "unfunded" / "unknown ≠ unfunded" / "success:false" וכו'.
 *
 * FIX(F-8 · EXEC-CD-35): `wif` מקבל שתי-צורות — WIF גרפני (51-52 base58) או
 * מפתח-פרטי-hex (64) — זהות-הכספת-הריבונית (TRON_PRIVATE_KEY). הסקלר נגזר לפי-הצורה.
 * FIX(F-9 · EXEC-CD-35): TRON אוסר-transfer-עצמי ("Cannot transfer TRX to yourself" —
 * נמדד-חי R21). עתה: owner = זהות-העוגן, to = `toAddress` (יעד-רשימה-לבנה-שלנו —
 * זהות-צי ידועה); 1-sun בלבד + extra_data = stateRoot (העיגון-עצמו).
 */
export async function signAndSendTron(
  tronRpcUrl: string, tronAddress: string, stateRoot: string, wif: string,
  toAddress?: string,
): Promise<{ txid: string }> {
  const balRes = await fencedFetch(`${tronRpcUrl}/v1/accounts/${tronAddress}`, "signer.tron.accounts", { signal: AbortSignal.timeout(12000) });
  if (!balRes.ok) throw new Error(`trongrid read failed: HTTP ${balRes.status} — anchor deferred (unknown ≠ unfunded)`);
  const acc = await balRes.json() as { data: { balance?: number }[]; success?: boolean };
  if (acc?.success === false) throw new Error("trongrid success:false — anchor deferred (unknown ≠ unfunded)");
  const balance = acc?.data?.[0]?.balance ?? 0;
  if (balance < 300_000) throw new Error(`unfunded: ${balance} sun (<0.3 TRX bandwidth floor) — queued honestly`);

  const [{ secp256k1 }, b58] = await Promise.all([import("@noble/curves/secp256k1"), bs58lib()]);
  const owner58 = Buffer.from(b58.decode(tronAddress));
  // FIX(F-10 · EXEC-CD-35 · נמדד-חי): /wallet/createtransaction דורש hex **עם קידומת-0x41**
  // (42-תווים) — בלעדיה: "ContractValidateException: Invalid ownerAddress" (היה: hex20 עירום
  // = כל-העיגונים-מתים-על-השער הזה). אימות: אותו-בנייה עם 41-מקדים → txID חוזר.
  const ownerHex = "41" + owner58.subarray(1, 21).toString("hex");
  const to58 = Buffer.from(b58.decode(toAddress ?? tronAddress));
  const toHex = "41" + to58.subarray(1, 21).toString("hex");
  const built = await tronic<{ txID?: string; raw_data?: unknown; raw_data_hex?: string }>(`${tronRpcUrl}/wallet/createtransaction`, {
    to_address: toHex, owner_address: ownerHex, amount: 1, extra_data: Buffer.from(stateRoot, "utf8").toString("hex"),
  }, 15000);
  if (!built?.txID || !built?.raw_data_hex) throw new Error("createtransaction answered without txID/raw_data_hex");

  // FIX(F-8): סקלר לפי-צורת-המפתח — hex-טהור (זהות-הכספת) או WIF (סקלר-גרפני)
  const priv = /^[0-9a-fA-F]{64}$/.test(wif)
    ? new Uint8Array(Buffer.from(wif, "hex"))
    : await deriveScalar(wif);
  const msg = Buffer.from(built.txID, "hex");
  const sig = secp256k1.sign(msg, priv, { prehash: false });
  const compact = sig.toCompactRawBytes();
  // FIX(F-11 · EXEC-CD-35 · נמדד-חי על-מייננט): פורמט-הסיגנטורה של TRON הוא
  // [r(32) ‖ s(32) ‖ v(1)] — ה-recovery **בסוף** (כמו-Ethereum). היה [v, r, s]
  // → "Validate signature error: Header byte out of range" (הצומת קרא את הבייט-האחרון).
  // אימות: e1e09c7e… = העיגון-הראשון-אמת קיבל result:true עם הפורמט הזה.
  const sigBytes = new Uint8Array(65);
  sigBytes.set(compact, 0);
  sigBytes[64] = sig.recovery ?? 0;
  const res = await tronic<{ result?: boolean; txid?: string; message?: string }>(`${tronRpcUrl}/wallet/broadcasttransaction`, {
    txID: built.txID, raw_data: built.raw_data, raw_data_hex: built.raw_data_hex, signature: [Buffer.from(sigBytes).toString("hex")],
    // FIX(F-11b · נמדד-חי): raw_data (האובייקט) חובה לצד raw_data_hex — בלעדיו
    // trongrid מחזיר NullPointerException (ה-broadcast מגיע לצומת בלי-גוף-מנותח).
  }, 15000);
  if (res?.result && res?.txid) return { txid: res.txid };
  throw new Error("tron broadcast rejected: " + (res?.message ? Buffer.from(res.message, "hex").toString("utf8").slice(0, 120) : "unknown"));
}

/** provenance — תיאור-מקור-החתימה לביקורת (אפס-ערכי-גלם — שמות-env בלבד). */
export function signerProvenance(): { adaptor: "EnvSigner"; keySources: readonly string[]; version: string } {
  return { adaptor: "EnvSigner", keySources: KEY_ENV_NAMES, version: "m2-v1" };
}
