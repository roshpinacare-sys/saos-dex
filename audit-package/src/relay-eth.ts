/* relay-eth.ts — מתאם-עיגון Ethereum עבור ה-Relay של SAOS-DEX.
 *
 * מקור: הקוד-החי של המפעיל (steem@main · agent/xwallet.cjs --evm-intent +
 * agent/identity.cjs) — אומת בדפדפן-המתמטיקה שלו ועתה מותאם לממשק-ה-Anchor
 * של ה-Relay (relay.ts). אפס תלות-חדשה: @noble/curves + @noble/hashes + bs58
 * (כבר בשימוש ה-Relay עבור TRON).
 *
 * מסקנות-ארכיטקטוניות (מתועדות ב-WORKLOG_PHASE5.md):
 *  · עקומה: ה-WIF של headcorner הוא secp256k1 — בדיוק עקומת-Ethereum. אך
 *    נגזרת-הזהות שונה (ETH = keccak256(pub-לא-דחוס)[12:], Graphene =
 *    sha256-דחוס → STM…) ולכן ה-ETH משתמש בזהות-הצי הייעודית שלו
 *    (wallets-registry idx=2), נגזרת מהזרע-הריבוני ומעוגנת-כבר-על-השרשרת
 *    (מניפסט txid 9f593bdc…). בידוד-סמכות: ה-Graphene-סמכות אינה נחשפת ל-ETH.
 *  · stateRoot הוא sha256 = 32 בייטים — נכנס כ-bytes32 ללא-המרה (calldata).
 *  · כלכלה: עיגון-EVM עולה גז (בניגוד ל-RC של Steem/Hive). שני-טירות:
 *      1) כוונת-עיגון חתומה EIP-191 — אפס-גז, מאומתת ecrecover (תמיד פעילה)
 *      2) שידור-חי EIP-1559 (calldata = payload) — חמוש אך נעול עד-מימון;
 *         עד-אז: המתנה-כלכלית כנה ("unfunded — pending funding") בדיוק
 *         כמו-ה-TRON, ואינה נספרת ל-breaker.
 *
 * אבטחה: מפתח בזיכרון בלבד מ-.env (gitignored); אפס סודות בלוגים/פלט;
 * אימות-עצמי fail-closed — כתובת-נגזרת חייבת להתאים לכתובת-הצפוי.
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

/* RPC ציבוריים (ללא-מפתח) — ניתנים לעקיפה דרך ETH_RPC_URL */
export const ETH_RPCS = (process.env.ETH_RPC_URL
  ? [process.env.ETH_RPC_URL]
  : ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"]);

export interface EthIdentity { address: string; }

export interface EthAnchorIntent {
  intentHash: string;     // keccak256 של EIP-191(message) — 0x…
  signature: string;      // 0x + 130 hex (r+s+v, v=27+recid) — חתימת personal_sign
  address: string;        // הכתובת החותמת
  verified: boolean;      // אימות-עצמי: החתימה תקפה מול-המפתח-החותם
}

function keccakHex(buf: Uint8Array): string {
  return Buffer.from(keccak_256(buf)).toString("hex");
}

/* keccak-based EIP-55 (checksum) — כמו identity.cjs של המפעיל */
export function checksumAddress(addrLowerNo0x: string): string {
  const a = addrLowerNo0x.toLowerCase();
  const h = keccakHex(Buffer.from(a, "utf8"));
  let out = "";
  for (let i = 0; i < a.length; i++) {
    const nib = parseInt(h[i], 16);
    out += nib >= 8 ? a[i].toUpperCase() : a[i];
  }
  return "0x" + out;
}

/* ── זהות: מפתח-פרטי (hex 32B) → כתובת (EIP-55) ──
 * אותה מתמטיקה כמו scalarToEvmAddress של המפעיל: pub-לא-דחוס → keccak256[12:] */
export function ethIdentity(privHex: string): EthIdentity {
  const priv = Buffer.from(privHex.replace(/^0x/, ""), "hex");
  if (priv.length !== 32) throw new Error("eth key must be 32 bytes");
  const pub = secp256k1.getPublicKey(priv, false);
  const h = keccak_256(pub.subarray(1));
  return { address: checksumAddress(Buffer.from(h.subarray(12)).toString("hex")) };
}

/* ── EIP-191: keccak256("\x19Ethereum Signed Message:\n" + len + msg) ── */
export function eip191MessageHash(msg: string): Uint8Array {
  const body = Buffer.from(`\x19Ethereum Signed Message:\n${msg.length}${msg}`, "utf8");
  return keccak_256(body);
}

/* ── כוונת-עיגון חתומה (אפס-גז) + אימות-עצמי ──
 * SECURITY INTENT: זו הראיה-הקריפטוגרפית שניתנת-לאימות-צד-שלישי בלי גז —
 * כל מי שמחזיק את ה-payload משחזר EIP-191-hash ומריץ ecrecover → כתובת.
 * ה-Relay מקשיח את הכוונה ב-anchors.json (הוכחה-ציבורית, אפס-סודות). */
export function signEthAnchor(payload: unknown, privHex: string): EthAnchorIntent {
  const msg = JSON.stringify(payload);
  const hash = eip191MessageHash(msg);
  const priv = Buffer.from(privHex.replace(/^0x/, ""), "hex");
  const sig = secp256k1.sign(hash, priv, { prehash: false });
  const compact = sig.toCompactRawBytes(); // 64B r+s (low-s — noble מנרמל)
  const v = 27 + (sig.recovery ?? 0);
  const signature = "0x" + Buffer.concat([compact, Buffer.from([v])]).toString("hex");
  const address = ethIdentity(privHex).address;
  const verified = secp256k1.verify(compact, hash, secp256k1.getPublicKey(priv, true));
  return { intentHash: "0x" + Buffer.from(hash).toString("hex"), signature, address, verified };
}

/* ── JSON-RPC מינימלי (אותו-היגיין-timeout כמו relay.ts) ── */
async function rpc<T>(endpoint: string, method: string, params: unknown[], timeoutMs = 20000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: ctrl.signal });
    const json = (await res.json()) as { result?: T; error?: { message?: string } };
    if (json.error) throw new Error(String(json.error.message || "eth rpc error").slice(0, 120));
    return json.result as T;
  } finally {
    clearTimeout(t);
  }
}

/* ── RLP מינימלי (bytes / רשימות) — מספיק לעסקת-EIP-1559 ── */
function rlpScalar(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array(0);
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return Buffer.from(hex, "hex");
}
function rlpEncode(item: Uint8Array | Uint8Array[]): Uint8Array {
  const wrap = (payload: Uint8Array, offset: number): Uint8Array => {
    if (payload.length < 56) return Buffer.concat([Buffer.from([offset + payload.length]), payload]);
    const lenBytes = rlpScalar(BigInt(payload.length));
    return Buffer.concat([Buffer.from([offset + 55 + lenBytes.length]), lenBytes, payload]);
  };
  if (Array.isArray(item)) return wrap(Buffer.concat(item.map(rlpEncode)), 0xc0);
  if (item.length === 1 && item[0] < 0x80) return Buffer.from(item);
  return wrap(Buffer.from(item), 0x80);
}

const utf8ToHex = (s: string) => Buffer.from(s, "utf8").toString("hex");
const pad32 = (b: Uint8Array) => Buffer.concat([Buffer.alloc(32 - b.length), Buffer.from(b)]);

/* ── שידור-עיגון חי (EIP-1559 self-tx, calldata = payload) ──
 * חסם-מימון: יתרה חייבת לכסות gasLimit×gasPrice×2 (מרווח לשני עיגונים) —
 * אחרת נזרק "unfunded" שה-Relay מסווג כהמתנה-כלכלית כנה (לא-כשל-breaker). */
export async function ethSealBroadcast(
  payload: unknown,
  privHex: string,
): Promise<{ txid: string; intent: EthAnchorIntent; address: string }> {
  /* שער-מדיניות (המפעיל): אפס שידור-חי כברירת-מחדל — גז כסף אמת.
   * הטירה-הראשונה (EIP-191 intent) תמיד רצה ומשאירה ראיה-חתומה;
   * השידור נשאר נעול עד-שהמפעיל יחמש אותו מפורשות (ETH_BROADCAST_ENABLED=1). */
  if (process.env.ETH_BROADCAST_ENABLED !== "1") {
    throw new Error("unfunded-policy: live ETH broadcast disabled by operator gate (ETH_BROADCAST_ENABLED) — armed, intents signed (zero gas)");
  }
  const endpoint = ETH_RPCS[0];
  const { address } = ethIdentity(privHex);
  const msg = JSON.stringify(payload);
  const data = utf8ToHex(msg);
  const gasLimit = 60000; // 21000 + calldata (~200B JSON ≈ 3.2k) + מרווח-מוסדי

  const [chainIdHex, balHex, gasHex, nonceHex] = await Promise.all([
    rpc<string>(endpoint, "eth_chainId", []),
    rpc<string>(endpoint, "eth_getBalance", [address, "latest"]),
    rpc<string>(endpoint, "eth_gasPrice", []),
    rpc<string>(endpoint, "eth_getTransactionCount", [address, "pending"]),
  ]);
  const chainId = BigInt(chainIdHex);
  const balance = BigInt(balHex);
  const gasPrice = BigInt(gasHex);
  const nonce = BigInt(nonceHex);
  const maxFee = gasPrice * 2n;
  const maxPriority = 1_000_000_000n; // 1 gwei
  const floor = BigInt(gasLimit) * maxFee * 2n;
  if (balance < floor) {
    throw new Error(`unfunded: ${Number(balance / 10n ** 12n)} mwei < gas floor ${Number(floor / 10n ** 12n)} mwei — pending funding (armed, intent signed)`);
  }

  const to = Buffer.from(address.replace(/^0x/, "").toLowerCase(), "hex");
  const dataBytes = Buffer.from(data, "hex");
  const chainIdB = rlpScalar(chainId);
  const preSign = rlpEncode([
    chainIdB, rlpScalar(nonce), rlpScalar(maxPriority), rlpScalar(maxFee), rlpScalar(BigInt(gasLimit)),
    to, rlpScalar(0n), dataBytes, new Uint8Array(0), // accessList ריק (רשימה-ריקה)
  ]);
  const sig = secp256k1.sign(keccak_256(preSign), Buffer.from(privHex.replace(/^0x/, ""), "hex"), { prehash: false });
  const yParity = sig.recovery ?? 0;
  const signed = rlpEncode([
    chainIdB, rlpScalar(nonce), rlpScalar(maxPriority), rlpScalar(maxFee), rlpScalar(BigInt(gasLimit)),
    to, rlpScalar(0n), dataBytes, new Uint8Array(0),
    rlpScalar(BigInt(yParity)), pad32(sig.toCompactRawBytes().subarray(0, 32)), pad32(sig.toCompactRawBytes().subarray(32, 64)),
  ]);
  const raw = "0x" + Buffer.from(signed).toString("hex");
  const txid = await rpc<string>(endpoint, "eth_sendRawTransaction", [raw], 30000);
  if (!txid || !/^0x[0-9a-f]{64}$/.test(txid)) throw new Error("eth broadcast answered without valid hash (honest)");
  const intent = signEthAnchor(payload, privHex);
  return { txid, intent, address };
}

/* ── verifyOnChain: קריאה-חוזרת מה-RPC הציבורי והשוואת stateRoot+height ──
 * SECURITY INTENT: אי-אמון-עצמי — ה-txid נקרא-חזרה מתשתית-ציבורית, ה-calldata
 * מנותח ומושווה ביט-מול-ביט מול-המקומי. אי-התאמה → ALERT מעליו ב-relay.ts. */
export async function verifyEthAnchor(
  txid: string,
  expected: { height: number; stateRoot: string },
  expectedAddress: string | null,
): Promise<{ ok: boolean; detail: string }> {
  const endpoint = ETH_RPCS[0];
  const tx = await rpc<{ to: string | null; input: string | null; blockNumber: string | null }>(
    endpoint, "eth_getTransactionByHash", [txid], 15000,
  ).catch(() => null);
  if (!tx) return { ok: false, detail: "not indexed: tx unknown to public node yet" };
  if (!tx.input || tx.input === "0x") return { ok: false, detail: "mismatch: tx carries no calldata payload" };
  let parsed: { height?: number; stateRoot?: string };
  try { parsed = JSON.parse(Buffer.from(tx.input.slice(2), "hex").toString("utf8")) as { height?: number; stateRoot?: string }; }
  catch { return { ok: false, detail: "mismatch: calldata is not the anchor payload" }; }
  const rootOk = parsed.stateRoot === expected.stateRoot;
  const heightOk = parsed.height === expected.height;
  if (!rootOk || !heightOk) {
    return { ok: false, detail: `mismatch: on-chain h${parsed.height ?? "?"}/${String(parsed.stateRoot ?? "?").slice(0, 12)}… vs local h${expected.height}/${expected.stateRoot.slice(0, 12)}…` };
  }
  const receipt = await rpc<{ status: string | null; blockNumber: string | null }>(
    endpoint, "eth_getTransactionReceipt", [txid], 15000,
  ).catch(() => null);
  if (!receipt) return { ok: false, detail: "not indexed: tx in mempool — receipt pending" };
  if (receipt.status !== "0x1") return { ok: false, detail: `mismatch: receipt status ${receipt.status ?? "null"} (not success)` };
  return { ok: true, detail: `stateRoot verified on ethereum (block ${BigInt(receipt.blockNumber ?? "0x0")})` + (expectedAddress ? ` · to=${expectedAddress.slice(0, 10)}…` : "") };
}
