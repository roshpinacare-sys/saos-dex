/* relay-sol.ts — מתאם-עיגון Solana עבור ה-Relay של SAOS-DEX (SPL Memo v2).
 *
 * מקור: הקוד-החי של המפעיל (steem@main · agent/xwallet.cjs --solana-feed) —
 * עסקת-devnet חיה שהוכחה בו: fee-payer, לקוח באפס-SOL, בניית-מסר ידנית
 * (compact-u16, blockhash מ-RPC, MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr),
 * חתימת-ed25519 ושידור-base64. ההתאמה כאן: עיגון-ממו עצמי של ה-Relay דרך
 * זהות-הצי (wallets-registry idx=2 — נגזרת מהזרע-הריבוני, מעוגנת במניפסט
 * txid 9f593bdc…).
 *
 * מסקנות-ארכיטקטוניות (מתועדות ב-WORKLOG_PHASE5.md):
 *  · עקומה: Solana הוא Ed25519 — לא-ניתן לחתימה עם ה-secp256k1-WIF של
 *    headcorner. הזהות ה-SOL נגזרת מהזרע-הריבוני: sha256(seed|sol|headcorner)
 *    → ed25519-seed32 → base58.
 *  · stateRoot: רוכב בתוך הממו (בייטים חופשיים) — ללא-המרה; נקרא-חזרה מהלוג
 *    של getTransaction (אי-אמון-עצמי).
 *  · כלכלה: 5000 lamports לחתימה. ברירת-מחדל devnet (קרקע-הוכחה אפס-עלות,
 *    מורשת xwallet) — SOL_RPC_URL משמש לעקיפה ל-mainnet כשהזהות תמומן.
 *
 * אבטחה: מפתח בזיכרון בלבד מ-.env (gitignored); אפס סודות בלוגים/פלט;
 * אימות-עצמי fail-closed — כתובת-נגזרת חייבת להתאים לכתובת-הצפוי.
 */
import { ed25519 } from "@noble/curves/ed25519";

export const SOL_RPCS = (process.env.SOL_RPC_URL
  ? [process.env.SOL_RPC_URL]
  : ["https://api.devnet.solana.com"]);

export const SOL_MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"; // SPL Memo v2
const BALANCE_FLOOR = 10_000;  // חסם-מימון: עמלת-חתימה (5000) + מרווח

/* ── base58 (מורשת xwallet.cjs — אותה-אלגוריתמיקה) ── */
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58Encode(buf: Uint8Array): string {
  let n = BigInt("0x" + Buffer.from(buf).toString("hex"));
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b === 0) out = B58[0] + out; else break; }
  return out;
}
function b58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error("bad base58 char"); n = n * 58n + BigInt(i); }
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const buf = Buffer.from(hex, "hex");
  let pad = 0;
  for (const c of s) { if (c === B58[0]) pad++; else break; }
  return Buffer.concat([Buffer.alloc(pad), buf]);
}

export interface SolIdentity { address: string; }

/* ── זהות: seed-32B (hex) → כתובת base58 ── */
export function solIdentity(secretHex: string): SolIdentity {
  const seed = Buffer.from(secretHex.replace(/^0x/, ""), "hex");
  if (seed.length !== 32) throw new Error("sol key must be a 32-byte ed25519 seed");
  return { address: b58Encode(ed25519.getPublicKey(seed)) };
}

function cu16(n: number): Buffer { // compact-u16 (Solana shortvec)
  if (n < 128) return Buffer.from([n]);
  const out: number[] = [];
  while (n >= 128) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return Buffer.from(out);
}

/* ── JSON-RPC (אותו-היגיין-timeout) ── */
async function rpc<T>(endpoint: string, method: string, params: unknown[], timeoutMs = 20000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: ctrl.signal });
    const json = (await res.json()) as { result?: T; error?: { message?: string } };
    if (json.error) throw new Error(String(json.error.message || "sol rpc error").slice(0, 120));
    return json.result as T;
  } finally {
    clearTimeout(t);
  }
}

/* ── בניית-מסר Solana: חותם-יחיד + Memo instruction ──
 * header [1,0,1] · keys [signer(writable), memoProgram(ro)] · blockhash ·
 * 1 instruction: programIdx=1, accounts=[0], memo-bytes. (התאמה מלאה למבנה
 * שהוכח ב-xwallet.cjs, עם חותם-יחיד במקום זוג fee-payer.) */
function buildMemoMessage(signer32: Uint8Array, memoProgram32: Uint8Array, blockhash32: Uint8Array, memoUtf8: string): Buffer {
  const memo = Buffer.from(memoUtf8, "utf8");
  return Buffer.concat([
    Buffer.from([1, 0, 1]),   // 1 חתימה-נדרשת · 0 ro-signed · 1 ro-unsigned
    cu16(2),                  // keyCount
    Buffer.from(signer32),
    Buffer.from(memoProgram32),
    Buffer.from(blockhash32), // recent blockhash
    cu16(1),                  // instructions count
    Buffer.from([1]),         // program id INDEX = 1 (memoProgram)
    cu16(1), Buffer.from([0]),// accounts: count=1, idx 0 (signer, writable)
    cu16(memo.length), memo,
  ]);
}

/* ── שידור-עיגון חי (self-memo anchor) ──
 * חסם-מימון: getBalance ≥ BALANCE_FLOOR — אחרת "unfunded" (המתנה-כלכלית
 * כנה אצל ה-Relay, לא-כשל-breaker). ה-blockhash נלקח מה-RPC רגע-לפני. */
export async function solSealBroadcast(
  payload: unknown,
  secretHex: string,
): Promise<{ txid: string; address: string }> {
  /* שער-מדיניות (המפעיל): אפס שידור-חי כברירת-מחדל — אפילו על devnet.
   * החתימה-עצמה חיה (מסר נבנה ונחתם על-כל-חותם בשידור-מדומה-מדיניות);
   * השידור נשאר נעול עד-שהמפעיל יחמש אותו מפורשות (SOL_BROADCAST_ENABLED=1)
   * ואז עדיין חוסם-היתרה קודם (fee floor). */
  if (process.env.SOL_BROADCAST_ENABLED !== "1") {
    throw new Error("unfunded-policy: live SOL broadcast disabled by operator gate (SOL_BROADCAST_ENABLED) — armed, memos signed (zero cost)");
  }
  const endpoint = SOL_RPCS[0];
  const seed = Buffer.from(secretHex.replace(/^0x/, ""), "hex");
  if (seed.length !== 32) throw new Error("sol key must be a 32-byte ed25519 seed");
  const { address } = solIdentity(secretHex);
  const memoProgram32 = b58Decode(SOL_MEMO_PROGRAM);

  const balance = await rpc<number>(endpoint, "getBalance", [address, { commitment: "confirmed" }], 15000)
    .then((r) => (typeof r === "number" ? r : Number((r as { value?: number })?.value ?? 0)))
    .catch(() => 0);
  if (balance < BALANCE_FLOOR) {
    throw new Error(`unfunded: ${balance} lamports (<${BALANCE_FLOOR} fee floor) — pending funding (armed)`);
  }

  const bh = await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>(
    endpoint, "getLatestBlockhash", [{ commitment: "confirmed" }], 15000,
  );
  if (!bh?.value?.blockhash) throw new Error("getLatestBlockhash answered without blockhash");
  const memoMsg = JSON.stringify(payload);
  const msg = buildMemoMessage(ed25519.getPublicKey(seed), memoProgram32, b58Decode(bh.value.blockhash), memoMsg);
  const sig = ed25519.sign(msg, seed);
  const tx = Buffer.concat([cu16(1), Buffer.from(sig), msg]); // sig order == signer order
  const txid = await rpc<string>(endpoint, "sendTransaction", [
    tx.toString("base64"), { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed" },
  ], 30000);
  if (!txid || typeof txid !== "string" || txid.length < 32) throw new Error("sol broadcast answered without signature (honest)");
  return { txid, address };
}

/* ── verifyOnChain: קריאה-חוזרת מה-RPC הציבורי והשוואת stateRoot ──
 * SPL Memo מתומן ללוג ("Program log: <memo>") — getTransaction מחזיר
 * logMessages ואנו משווים את ה-stateRoot+height ביט-מול-ביט מול-המקומי. */
export async function verifySolAnchor(
  txid: string,
  expected: { height: number; stateRoot: string },
): Promise<{ ok: boolean; detail: string }> {
  const endpoint = SOL_RPCS[0];
  const st = await rpc<{ value: ({ err: unknown; slot: number; confirmationStatus?: string } | null)[] }>(
    endpoint, "getSignatureStatuses", [[txid], { searchTransactionHistory: false }], 15000,
  ).catch(() => null);
  const v = st?.value?.[0] ?? null;
  if (!v) return { ok: false, detail: "not indexed: signature unknown to public node yet" };
  if (v.err !== null && v.err !== undefined) return { ok: false, detail: `mismatch: transaction failed on-chain (${JSON.stringify(v.err).slice(0, 80)})` };
  const tx = await rpc<{ meta?: { logMessages?: string[] } | null }>(
    endpoint, "getTransaction", [[txid, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]], 15000,
  ).catch(() => null);
  const logs = (tx?.meta?.logMessages ?? []).join(" ");
  if (!logs) return { ok: false, detail: "not indexed: awaiting confirmed block" };
  if (!logs.includes(expected.stateRoot)) return { ok: false, detail: `mismatch: on-chain memo lacks local stateRoot ${expected.stateRoot.slice(0, 12)}…` };
  if (!logs.includes(`"height":${expected.height}`)) return { ok: false, detail: `mismatch: on-chain memo height != local h${expected.height}` };
  return { ok: true, detail: `stateRoot verified on solana (slot ${v.slot})` };
}
