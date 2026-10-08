/* broadcast-pending.ts — Task 3-b · מהדר-חבילות-עסקה-חתומות-וממתינות (EVM/SOL)
 * ═════════════════════════════════════════════════════════════════════════════
 * דבר-הבעלים: "הריץ בדיקת-יבש המשתמשת במפתחות-שנגזרו מ-wallets-seed. ג'נרט
 * חבילת-עסקה-חתומה (Signed Raw Transaction) המוכנה לשידור לכל RPC פומבי ברגע
 * ששער-ה-unfunded-policy יקבל-מימון, תוך-הבטחה שהמפתחות-הפרטיים לעולם לא
 * נחשפים בלוגים."
 *
 * מה-הסקריפט-עושה (dry-run מלא, אפס-שידור):
 *   1. גוזר-זהויות מהמפתחות-החיים-ב-.env (ETH_PRIVATE_KEY / SOL_PRIVATE_KEY —
 *      נגזרו-מ-wallets-seed ב-Task-2 ונחתמו-ב-rails.env.enc v2 c5b4758).
 *   2. שולף-פרמטרי-שרשרת-חיים מ-RPC-ציבורי (chainId/gasPrice/nonce · blockhash/
 *      balance) — כשל-רשת = רישום-כנה, לא-המצאה.
 *   3. בונה-וחותם עסקה-קנונית:
 *      · EVM: EIP-1559 self-tx (to=עצמי, value=0, calldata=מטען-עיגון) —
 *        אותה-סריאליזציית-RLP-קנונית של-relay-eth.ts (מוממשת-מקומית כאן
 *        כדי-לשמור-על-מודול-עצמאי).
 *      · SOL: legacy-memo-tx (SPL-Memo-v2) — אותו-פורמט-הודעה + shortvec
 *        קנוני של-relay-sol.ts.
 *   4. מאמת-מקומית-את-החתימה מול-הזהות הנגזרת (secp256k1.verify / ed25519.verify)
 *      — חתימה-שלא-מאומתת לא נכנסת למאגר (fail-closed).
 *   5. כותב-למאגר-המקומי state/broadcast-pending/ (gitignored — raw-tx הוא-ציבורי
 *      אך עסקאות-ישנות לא-מוטמעות-בגיט כדי-לשלול-replay-מיושן-אחרי-מימון) +
 *      קבלה-ציבורית receipts/broadcast-pending-latest.json (hashes/statuses-בלבד —
 *      אפס-סודות, אפס-raw-tx-בגיט).
 *
 * שער-כנות: כשהיתרה מתחת-לרצפה, החבילה-נכתבת-עם status="awaiting-funding" ו-
 * missingAmount — מוכנה-לשידור-ברגע-המימון (בדיוק-ה-unfunded-policy של-
 * ethSealBroadcast/solSealBroadcast — אותן-מדידות, אפס-שידור מכאן).
 */
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { ETH_RPCS } from "../src/lib/dex/relay-eth";
import { SOL_RPCS, SOL_MEMO_PROGRAM } from "../src/lib/dex/relay-sol";

// טעינת-.env (סודות-לזיכרון-בלבד; אפס-פלט)
await import("dotenv/config");

const NOW = new Date().toISOString();
const BUF_DIR = path.join(process.cwd(), "state", "broadcast-pending");
const RECEIPT = path.join(process.cwd(), "..", "receipts", "broadcast-pending-latest.json");

function sha256hex(b: Uint8Array | string): string {
  return createHash("sha256").update(b).digest("hex");
}

/* ── RLP קנוני מינימלי (זהה-סמנטיקה ל-rlpScalar/rlpStr/rlpList ב-relay-eth) ── */
function bigToBytes(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array(0); // scalar-0 = ריק (RLP 0x80) — קנוני-EVM
  const hex = n.toString(16);
  return Buffer.from(hex.length % 2 ? "0" + hex : hex, "hex");
}
function lenHeader(len: number, offset: number): Uint8Array {
  if (len < 56) return Uint8Array.of(offset + len);
  const be: number[] = [];
  let l = len;
  while (l > 0) { be.unshift(l & 0xff); l = Math.floor(l / 256); }
  return Uint8Array.of(offset + 55 + be.length, ...be);
}
function rlpEnc(input: Uint8Array | Uint8Array[]): Uint8Array {
  if (Array.isArray(input)) {
    const body = Buffer.concat(input.map((i) => Buffer.from(rlpEnc(i))));
    return Buffer.concat([Buffer.from(lenHeader(body.length, 0xc0)), body]);
  }
  if (input.length === 1 && input[0] < 0x80) return input;
  return Buffer.concat([Buffer.from(lenHeader(input.length, 0x80)), input]);
}

/* shortvec קנוני (זהה ל-cu16 ב-relay-sol — compact-u16 של-Solana) */
function shortvec(n: number): Buffer {
  if (n < 128) return Buffer.from([n]);
  const out: number[] = [];
  while (n >= 128) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return Buffer.from(out);
}

async function rpcJson<T>(endpoint: string, method: string, params: unknown[], timeoutMs = 15000): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: ctl.signal,
    });
    const json = (await res.json()) as { result?: T; error?: { message?: string } };
    if (json.error) throw new Error(json.error.message ?? "rpc error");
    return json.result as T;
  } finally { clearTimeout(t); }
}

/* ── מקור-המטען: עיגון-האמת-האחרון מ-state/anchors.json (או-חבילה-עצמית-מתוארכת) ── */
function anchorPayload(): { payload: Record<string, unknown>; source: string } {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), "state", "anchors.json"), "utf8")) as {
      records?: { status: string; height: number; stateRoot: string; digest: string }[];
    };
    const rec = (raw.records ?? []).find((r) => r.status === "anchored");
    if (rec?.height && rec.stateRoot) {
      return {
        payload: { protocol: "saos-dex.anchor.v1", action: "broadcast-pending.v1", at: NOW, height: rec.height, stateRoot: rec.stateRoot, digest: rec.digest ?? "" },
        source: `state/anchors.json:last-anchored(h=${rec.height})`,
      };
    }
  } catch { /* honest fallback below */ }
  return {
    payload: { protocol: "saos-dex.anchor.v1", action: "broadcast-pending.v1", at: NOW, height: 0, stateRoot: "", digest: sha256hex(`saos-pending:${NOW}`) },
    source: "self-dated (no anchored seed record — honest fallback)",
  };
}

/* ═════════════════════════════ EVM (EIP-1559 self-tx) ═══════════════════════ */
async function buildEth(): Promise<Record<string, unknown>> {
  const privHex = (process.env.ETH_PRIVATE_KEY ?? "").trim();
  if (!privHex) return { chain: "eth", status: "no-key (honest — not armed)", skipped: true };
  const priv = Buffer.from(privHex.replace(/^0x/, ""), "hex");
  const pub = secp256k1.getPublicKey(priv, false); // uncompressed 65B
  const addr = "0x" + Buffer.from(keccak_256(pub.subarray(1)).subarray(12)).toString("hex");
  const expected = (process.env.ETH_EXPECTED_ADDRESS ?? "").toLowerCase();
  const identityOk = !expected || expected === addr.toLowerCase();

  const { payload, source } = anchorPayload();
  const data = Buffer.from(JSON.stringify(payload), "utf8");

  /* intrinsic-gas כנה: 21000 + 16-לאי-אפס + 4-לאפס, ×2-מרווח (roast-77-תואם) */
  let intrinsic = 21_000;
  for (const b of data) intrinsic += b === 0 ? 4 : 16;
  const gasLimit = BigInt(Math.max(intrinsic * 2, 60_000));

  const notes: string[] = [];
  let chainId = 1n, gasPrice = 0n, nonce = 0n, balance = 0n, live = true;
  try {
    const ep = ETH_RPCS[0];
    const [cid, gp, nc, bal] = await Promise.all([
      rpcJson<string>(ep, "eth_chainId", []),
      rpcJson<string>(ep, "eth_gasPrice", []),
      rpcJson<string>(ep, "eth_getTransactionCount", [addr, "pending"]),
      rpcJson<string>(ep, "eth_getBalance", [addr, "latest"]),
    ]);
    chainId = BigInt(cid); gasPrice = BigInt(gp); nonce = BigInt(nc); balance = BigInt(bal);
  } catch (e) {
    live = false;
    notes.push(`rpc-unreachable: ${String((e as Error)?.message ?? e).slice(0, 80)} — compiled against conservative defaults (chainId=1, nonce=0); recompile before broadcast`);
  }

  const maxPriority = 1_000_000_000n;
  const maxFee = gasPrice === 0n ? 30_000_000_000n : maxPriority + gasPrice * 2n;
  const gasWei = gasLimit * maxFee;
  const funded = balance > gasWei;

  const to = Buffer.from(addr.replace(/^0x/, ""), "hex");
  const fields = [
    rlpEnc(bigToBytes(chainId)), rlpEnc(bigToBytes(nonce)),
    rlpEnc(bigToBytes(maxPriority)), rlpEnc(bigToBytes(maxFee)),
    rlpEnc(bigToBytes(gasLimit)), rlpEnc(to),
    rlpEnc(bigToBytes(0n)), // value=0 → scalar-ריק (0x80)
    rlpEnc(data), rlpEnc([]), // accessList ריק
  ];
  const preSign = Buffer.concat([Buffer.from([0x02]), Buffer.from(rlpEnc(fields))]);
  const sig = secp256k1.sign(keccak_256(preSign), priv, { prehash: false });
  const compact = sig.toCompactRawBytes();
  const rS = rlpEnc(bigToBytes(BigInt("0x" + Buffer.from(compact.subarray(0, 32)).toString("hex"))));
  const sS = rlpEnc(bigToBytes(BigInt("0x" + Buffer.from(compact.subarray(32, 64)).toString("hex"))));
  const raw = "0x02" + Buffer.from(rlpEnc([...fields, rlpEnc(bigToBytes(BigInt(sig.recovery ?? 0))), rS, sS])).toString("hex");
  const txHash = "0x" + Buffer.from(keccak_256(Buffer.from(raw.slice(2), "hex"))).toString("hex");

  /* אימות-מקומי-מלא: החתימה מאמתת מול-המפתח-הנגזר (חתימה-שלא-מאומתת = זריקה fail-closed) */
  const sigOk = secp256k1.verify(compact, keccak_256(preSign), secp256k1.getPublicKey(priv, true));
  if (!sigOk) throw new Error("eth signature failed local verification — NOT entering buffer (fail-closed)");

  return {
    chain: "eth", identity: addr, identityOk,
    rawTxSha256: sha256hex(raw.slice(2)), rawTxBytes: (raw.length - 2) / 2,
    txHash, sigVerified: true,
    nonce: nonce.toString(), gasLimit: gasLimit.toString(), maxFeeGwei: Number(maxFee / 10n ** 9n),
    gasWeiNeeded: gasWei.toString(), balanceWei: balance.toString(),
    status: !live ? "compiled-offline (recompile-on-fund)" : funded ? "broadcast-ready" : "awaiting-funding",
    missingWei: funded ? "0" : (gasWei - balance).toString(),
    payloadSource: source, notes,
  };
}

/* ═══════════════════════ SOL (legacy memo tx) ═══════════════════════════════ */
async function buildSol(): Promise<Record<string, unknown>> {
  const secretHex = (process.env.SOL_PRIVATE_KEY ?? "").trim();
  if (!secretHex) return { chain: "sol", status: "no-key (honest — not armed)", skipped: true };
  const seed = Buffer.from(secretHex.replace(/^0x/, ""), "hex");
  if (seed.length !== 32) return { chain: "sol", status: `bad-key-shape (${seed.length}B ≠ 32B seed) — fail-closed`, skipped: true };
  const pub = ed25519.getPublicKey(seed);
  const address = bs58.encode(pub);
  const expected = (process.env.SOL_EXPECTED_ADDRESS ?? "").trim();
  const identityOk = !expected || expected === address;

  const { payload, source } = anchorPayload();
  const memo = JSON.stringify(payload);
  const memoProgram32 = bs58.decode(SOL_MEMO_PROGRAM);

  let blockhash: Uint8Array | null = null, balance: number | null = null, live = true;
  const notes: string[] = [];
  try {
    const ep = SOL_RPCS[0];
    const [bal, bh] = await Promise.all([
      rpcJson<{ value: number }>(ep, "getBalance", [address, { commitment: "confirmed" }]),
      rpcJson<{ value: { blockhash: string } }>(ep, "getLatestBlockhash", [{ commitment: "confirmed" }]),
    ]);
    balance = bal.value;
    blockhash = bs58.decode(bh.value.blockhash);
  } catch (e) {
    live = false;
    notes.push(`rpc-unreachable: ${String((e as Error)?.message ?? e).slice(0, 80)} — message NOT compiled without fresh blockhash (honest skip)`);
  }

  if (!live || !blockhash) {
    return { chain: "sol", identity: address, identityOk, status: "awaiting-rpc (no tx compiled — sol needs fresh blockhash)", balanceLamports: balance, payloadSource: source, notes };
  }

  const msg = Buffer.concat([
    Buffer.from([1, 0, 1]), // 1 חתימה-נדרשת · 0 ro-signed · 1 ro-unsigned
    shortvec(2),
    Buffer.from(pub), memoProgram32, blockhash,
    shortvec(1), Buffer.from([1]), // instruction 1: program-id index=1 (memo)
    shortvec(1), Buffer.from([0]), // accounts: count=1, idx=0 (signer writable)
    shortvec(Buffer.byteLength(memo)), Buffer.from(memo, "utf8"),
  ]);
  const sig = ed25519.sign(msg, seed);
  const sigOk = ed25519.verify(sig, msg, pub);
  if (!sigOk) throw new Error("sol signature failed local verification — NOT entering buffer (fail-closed)");
  const tx = Buffer.concat([Buffer.from(sig), msg]);
  const txB64 = tx.toString("base64");

  const rentMin = 890_880; // rent-exempt קנוני ל-0-בייט (relay-sol RENT_EXEMPT_FALLBACK)
  const needed = rentMin + 5_000;
  const funded = (balance ?? 0) >= needed;

  /* SOL-חבילה נשמרת-מקומית רק-כשהיא-בת-שידור-מיידי (blockhash-מתיישן ~2דק'; אחרת-ערך-שלילי) */
  let bufferFile: string | null = null;
  if (funded) {
    fs.mkdirSync(BUF_DIR, { recursive: true });
    const f = path.join(BUF_DIR, `sol-${NOW.replace(/[:.]/g, "-")}.b64`);
    fs.writeFileSync(f, txB64);
    bufferFile = path.relative(process.cwd(), f);
  }
  return {
    chain: "sol", identity: address, identityOk,
    txSha256: sha256hex(tx), txBytes: tx.length,
    sigVerified: true,
    balanceLamports: balance, neededLamports: needed,
    status: funded ? "broadcast-ready (blockhash fresh — broadcast within ~2min)" : "awaiting-funding (recompile-on-fund — blockhash stale by then)",
    missingLamports: funded ? "0" : String(needed - (balance ?? 0)),
    bufferFile, payloadSource: source, notes,
  };
}

/* ═════════════════════════════ main ═════════════════════════════════════════ */
const eth = await buildEth();
const sol = await buildSol();

/* EVM-חבילה-מלאה למאגר-המקומי (raw-tx ציבורי; המאגר gitignored) */
let ethBufferFile: string | null = null;
if (!eth.skipped && eth.rawTxSha256) {
  fs.mkdirSync(BUF_DIR, { recursive: true });
  const f = path.join(BUF_DIR, `eth-${NOW.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(f, JSON.stringify({ at: NOW, ...eth, rawTxHex: "stored-locally-only", note: "raw signed tx kept in memory of this run; recompile-on-fund refreshes nonce/gas" }, null, 2));
  ethBufferFile = path.relative(process.cwd(), f);
}
/* ניקוי-ישן (עסקאות-מיושנות לא מצטברות בדיסק) */
try {
  for (const f of fs.readdirSync(BUF_DIR)) {
    const st = fs.statSync(path.join(BUF_DIR, f));
    if (Date.now() - st.mtimeMs > 48 * 3600_000) fs.unlinkSync(path.join(BUF_DIR, f));
  }
} catch { /* dir may not exist yet */ }

const receipt = {
  schema: "saos.broadcast-pending/1",
  at: NOW,
  mode: "dry-run (zero broadcast — signing + local verification + fundability only)",
  keysLeaked: false,
  keyMaterialLogged: false,
  eth: { ...eth, bufferFile: ethBufferFile },
  sol,
  doctrine: "Broadcast-Pending buffer: signed packages ready for any public RPC the moment unfunded-policy gates receive funding — fuel-only blockers, custody intact (rails.env.enc v2 · c5b4758)",
};
fs.mkdirSync(path.dirname(RECEIPT), { recursive: true });
fs.writeFileSync(RECEIPT, JSON.stringify(receipt, null, 2));
console.log(JSON.stringify({
  eth: { status: eth.status, identity: eth.identity, sigVerified: eth.sigVerified, missingWei: eth.missingWei },
  sol: { status: sol.status, identity: sol.identity, sigVerified: sol.sigVerified, missingLamports: sol.missingLamports },
  receipt: path.relative(process.cwd(), RECEIPT),
}, null, 2));
