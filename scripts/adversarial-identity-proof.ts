/**
 * adversarial-identity-proof.ts — EXEC-CD-13-AV · הוכחת-שליטה-קריפטוגרפית
 * ═════════════════════════════════════════════════════════════════════════
 * הפרכה: "הצגת-כתובת-נגזרת" ≠ "שליטה-בכתובת". הוכחה-אמיתית = חתימה-ושחזור.
 *  · EVM: חותם-EIP-191 עם-הסקלר-מ-.env → משחזר-את-החותם-מהחתימה →
 *    הכתובת-המשוחזרת חייבת-להיות-זהה-לכתובת-המפורסמת-בדלת.
 *  · TRON: שני-נתיבי-נגזירה-עצמאיים (math-מקומי מול peg-door-של-הדקס-בפועל)
 *    חייבים-להסכים עם-הכתובת-המפורסמת.
 *  · רעננות-כנה: יתרה-ומונה-טרנזקציות-מול-RPC-ציבורי (כתובת-חדשה=0/0).
 * אפס-הדפסות-סודות: רק-כתובות-ציבוריות-ובוליאנים.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

const ENV_PATH = "/home/z/my-project/saos-dex/.env";

function envVal(k: string): string {
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split("\n")) {
    if (line.startsWith(`${k}=`)) return line.slice(k.length + 1).trim();
  }
  return "";
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58encode(buf: Buffer): string {
  let n = BigInt("0x" + (buf.length ? buf.toString("hex") : "00"));
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b === 0) out = "1" + out; else break; }
  return out || "1";
}
function tronAddress(priv: Uint8Array): string {
  const pub65 = Buffer.from(secp256k1.getPublicKey(priv, false));
  const h = keccak_256(pub65.subarray(1));
  const payload = Buffer.concat([Buffer.from([0x41]), Buffer.from(h.subarray(12))]);
  const chk = crypto.createHash("sha256").update(crypto.createHash("sha256").update(payload).digest()).digest().subarray(0, 4);
  return b58encode(Buffer.concat([payload, chk]));
}
function ethAddressFromPub(pub65: Uint8Array): string {
  const h = keccak_256(pub65.subarray(1));
  return "0x" + Buffer.from(h.subarray(12)).toString("hex");
}

async function main(): Promise<void> {
  const scalarHex = envVal("ETH_PRIVATE_KEY");
  if (scalarHex.length !== 64) { console.log("FATAL: ETH_PRIVATE_KEY missing/short in .env (fail-closed)"); process.exit(1); }
  const priv = new Uint8Array(Buffer.from(scalarHex, "hex"));

  /* ── C1: הוכחת-שליטה-EVM (חתימה → שחזור) ──────────────────────────────── */
  const msg = `saos-identity-control-proof:${Date.now()}`;
  const msgBytes = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}${msg}`);
  const digest = keccak_256(msgBytes);
  const sigObj = secp256k1.sign(digest, priv);
  const recoveredPoint = sigObj.recoverPublicKey(digest); // noble-v1: השחזור-על-החתימה-עצמה
  const recoveredPub = recoveredPoint.toRawBytes(false); // uncompressed 65B
  const recoveredAddr = ethAddressFromPub(Buffer.from(recoveredPub));
  const derivedAddr = ethAddressFromPub(Buffer.from(secp256k1.getPublicKey(priv, false)));

  /* הכתובת-המפורסמת — מה-API-הציבורי (מקור-בלתי-תלוי-בסקריפט) */
  const door = await (await fetch("http://localhost:3010/saos-dex/api/dex/door")).json();
  const publishedEvm = door?.identities?.evm ?? null;
  const publishedTron = door?.identities?.tron ?? null;

  const evmControl = !!publishedEvm && recoveredAddr.toLowerCase() === publishedEvm.toLowerCase();
  console.log(`C1-EVM: signed+recovered=${recoveredAddr.slice(0, 12)}… published=${publishedEvm?.slice(0, 12)}… CONTROL=${evmControl ? "PROVEN" : "FALSIFIED"}`);

  /* ── C2: TRON — שני-נתיבי-נגזירה-עצמאיים ──────────────────────────────── */
  const tronLocal = tronAddress(priv);
  // נתיב-בלתי-תלוי: peg-door-של-הדקס-בפועל (אותו-קוד-שמשרת-את-הדלת-בייצור)
  const { tronIdentityFromHexScalar } = await import("../src/lib/dex/peg-door.js");
  const tronViaDex = tronIdentityFromHexScalar(scalarHex);
  const tronAgree = !!tronViaDex && tronLocal === tronViaDex;
  const tronPublished = !!publishedTron && tronLocal === publishedTron;
  console.log(`C2-TRON: local=${tronLocal.slice(0, 10)}… dex-path=${tronViaDex?.slice(0, 10)}… agree=${tronAgree} published-match=${tronPublished ? "PROVEN" : "FALSIFIED"}`);

  /* ── C3: רעננות-כנה מול-RPC-ציבורי (כתובת-חדשה = 0-balance · 0-nonce) ─── */
  try {
    const rpc = (process.env.ETH_RPC_URL || "https://ethereum-rpc.publicnode.com").trim() || "https://ethereum-rpc.publicnode.com";
    const body = (m: string, p: unknown[]) => ({ jsonrpc: "2.0", method: m, params: p, id: 1 });
    const r = await fetch(rpc, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify([body("eth_getBalance", [publishedEvm, "latest"]), body("eth_getTransactionCount", [publishedEvm, "latest"])]),
      signal: AbortSignal.timeout(15_000),
    });
    const [bal, nonce] = (await r.json()) as [{ result?: string }, { result?: string }];
    console.log(`C3-EVM-freshness: balance=${BigInt(bal.result ?? "0x0")} wei · nonce=${parseInt(nonce.result ?? "0x0", 16)} (כתובת-זהות-חדשה — ריקה-כנה)`);
  } catch (e) { console.log(`C3: rpc-err ${e instanceof Error ? e.message.slice(0, 60) : "?"} (לא-קריטי)`); }
}

main().catch((e) => { console.log("FATAL:", e instanceof Error ? e.message : String(e)); process.exit(1); });
