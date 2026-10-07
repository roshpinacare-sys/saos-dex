/**
 * restore-sovereign-identities.ts — EXEC-CD-13 · ריפוי-זהויות-הפקדה-הריבוניות
 * ═══════════════════════════════════════════════════════════════════════════
 * רקע: ניקוי-הסנדבוקס שטח את ערכי-הסודות ב-saos-dex/.env (המבנה-שרד, הערכים-
 * התרוקנו) והכספת-האם (VaultKey=0-שורות · fleet_keys.enc-נעלם) —
 * depositIdentities() מחזיר nulls → דלת-הפקדות עיוורת → אף-מטבע-אמת לא יכול
 * להיכנס ("מחובר-באמת" שבור-בנקודה-הקריטית-ביותר).
 *
 * הפתרון-הדוקטריני: מפתח-אחד-פותח-הכל (הסכם-מפתח-האב · Task 69) — מפתח-
 * headcorner (upload/headcorner.txt, שורה-2) הוא הזרע-הריבוני-החי-היחיד-בידינו.
 * ממנו נגזרות זהויות-הפקדה-דטרמיניסטיות (TRON+ETH: אותו-סקלר-secp256k1 —
 * אותו-math של peg-door/roast-76). SOL: ed25519 — לא-נגזר; נשאר כנה-ריק.
 *
 * אמת-מתועדת (רץ-פעם-אחת, הערכים-קבועים-בהיסטוריה):
 *  · הסמכות-החיה-על-השרשראות (STM5HhJD…/STM8c9vp…/BLT5HhJD…) = חומר-הכספת
 *    שאבד — לא-ניתן-לשחזור-כרגע; חתימת-STEEM/HIVE נשארת fail-soft-כנה.
 *  · מפתח-ההסכם אינו-הסמכות-על-השרשרת (נבדק-חי) — ולכן-הוא-לא-נכתב
 *    ל-STEEM_ACTIVE_WIF (השדה-נשאר-כנה-ריק); הוא-נכתב רק-לזהויות-הפקדה.
 *
 * בטיחות:
 *  · אפס-הדפסות-סודות: בוליאנים + קידומות-כתובת-ציבורית-בלבד (כתובת-הפקדה
 *    היא-מידע-ציבורי-מטבען — זה-המוצר).
 *  · ה-.env לעולם לא נכנס לגיט (gitignore — אומת KEYRELAY-3).
 *  · כתיבה רק-לשדות-ריקים — אף-ערך-קיים-לא-נדרס (live-wins).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1"; // אותה-תלות של peg-door — נגזרת-זהה-ביט-מול-ביט
import { keccak_256 } from "@noble/hashes/sha3";

const HEAD_FILE = "/home/z/my-project/upload/headcorner.txt";
const ENV_PATH = "/home/z/my-project/saos-dex/.env";
const UA = "SAOS-Sovereign-Audit/1.0 (+identity-restore)";

/* ── base58 (TRON) ─────────────────────────────────────────────────────────── */
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
function ethAddress(priv: Uint8Array): string {
  const pub65 = Buffer.from(secp256k1.getPublicKey(priv, false));
  const h = keccak_256(pub65.subarray(1));
  return "0x" + Buffer.from(h.subarray(12)).toString("hex"); // lowercase — הנרמול-הקנוני של הדלת
}

async function main(): Promise<void> {
  const lines = fs.readFileSync(HEAD_FILE, "utf8").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const label = (lines[0] || "headcorner").toLowerCase().replace(/\s+/g, "");
  const keyLine = lines[1] ?? lines[0];
  const norm = keyLine.replace(/\s+/g, "").replace(/^P(?=[5KL])/, ""); // מעטפת-Blurt (P5KQ…) ≡ 5KQ… (Task-69b)

  /* WIF → סקלר (checksum-מאומת) */
  const raw = Buffer.from((() => {
    const B = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let n = 0n;
    for (const c of norm) { const i = B.indexOf(c); if (i < 0) throw new Error("b58-char"); n = n * 58n + BigInt(i); }
    let hex = n.toString(16); if (hex.length % 2) hex = "0" + hex;
    const buf = Buffer.from(hex, "hex");
    let pad = 0; for (const c of norm) { if (c === "1") pad++; else break; }
    return Buffer.concat([Buffer.alloc(pad), buf]);
  })());
  const data = raw.subarray(0, raw.length - 4);
  const chkCalc = crypto.createHash("sha256").update(crypto.createHash("sha256").update(data).digest()).digest().subarray(0, 4);
  if (!chkCalc.equals(raw.subarray(raw.length - 4))) throw new Error("wif-checksum-bad");
  if (data[0] !== 0x80) throw new Error(`wif-version-${data[0]}`);
  const priv = new Uint8Array(data.subarray(1, 33));
  const scalarHex = Buffer.from(priv).toString("hex");

  const tron = tronAddress(priv);
  const eth = ethAddress(priv);
  console.log(`key-loaded: label=${label} wif-len=${norm.length} scalar-ok=true`);
  console.log(`derived-identities: tron=${tron.slice(0, 10)}… evm=${eth.slice(0, 12)}… (deposit-addresses — ציבורי-מטבען)`);

  /* תיעוד-כנה: הסמכות-על-השרשרת (מידע-בלבד — לא-קשור-לכתיבה) */
  async function liveActive(endpoint: string): Promise<string | null> {
    try {
      const r = await fetch(endpoint, {
        method: "POST", headers: { "content-type": "application/json", "user-agent": UA },
        body: JSON.stringify({ jsonrpc: "2.0", method: "condenser_api.get_accounts", params: [[label]], id: 1 }),
        signal: AbortSignal.timeout(15_000),
      });
      const j = await r.json() as { result?: { active?: { key_auths?: [string, number][] } }[] };
      return j.result?.[0]?.active?.key_auths?.[0]?.[0] ?? null;
    } catch { return null; }
  }
  const steemActive = await liveActive("https://api.steemit.com");
  console.log(`info: steem-active-authority=${steemActive ? steemActive.slice(0, 12) + "…" : "null"} (= חומר-הכספת-שאבד — לא-נכתב-כאן)`);
  void norm; void scalarHex;

  /* ── כתיבה-ל-.env — רק-שדות-ריקים, אף-דריסה ────────────────────────────── */
  const updates: Record<string, string> = {
    TRON_PRIVATE_KEY: scalarHex,   // EXEC-CD-13: נגזרת-זהות-TRON (שדה-חדש — רשימת-ההיתר-כבר-מכירה)
    ETH_PRIVATE_KEY: scalarHex,    // אותו-סקלר → זהות-EVM (eth/base/bsc) — אותו-math של peg-door
    SAOS_RELAY_AGENT_ACCOUNT: label,
    HIVE_ANCHOR_ACCOUNT: label,
    // STEEM_ACTIVE_WIF / HIVE_ACTIVE_WIF / SOL_PRIVATE_KEY — נשארים-כנה-ריקים
    // (חומר-הסמכות-על-השרשרת=הכספת-שאבדה; ed25519-לא-נגזר-מהסקלר)
  };
  const env = fs.readFileSync(ENV_PATH, "utf8");
  let written = 0; let skippedNonEmpty = 0;
  const out = env.split("\n").map((line) => {
    const eq = line.indexOf("=");
    if (eq <= 0) return line;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (!(k in updates)) return line;
    if (v !== "" && v !== '""') { skippedNonEmpty++; return line; } // live-wins
    written++;
    return `${k}=${updates[k]}`;
  }).join("\n");
  // שדה-חדש (TRON_PRIVATE_KEY) — אם-לא-היה-ב-.env-כלל: מתווסף-בסוף
  const added: string[] = [];
  for (const [k, v] of Object.entries(updates)) {
    if (!env.split("\n").some((l) => l.startsWith(`${k}=`))) { added.push(`${k}=${v}`); written++; }
  }
  fs.writeFileSync(ENV_PATH, (added.length ? out.replace(/\n*$/, "\n") + added.join("\n") + "\n" : out), { mode: 0o600 });
  console.log(`env-written: ${written} fields · skipped-nonempty: ${skippedNonEmpty}${added.length ? ` · appended-new: [${added.map(a => a.split("=")[0]).join(",")}]` : ""}`);
  console.log("RESULT: OK — next DEX env-load will derive deposit identities (tron+evm; sol stays honest-null)");
}

main().catch((e) => { console.log("FATAL:", e instanceof Error ? e.message : String(e)); process.exit(1); });
