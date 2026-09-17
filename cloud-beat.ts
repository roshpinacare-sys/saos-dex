/**
 * cloud-beat.ts — פעימת-הענן של SAOS-DEX (Task 33)
 * =============================================================================
 * רץ ב-GitHub Actions בריפו הפרטי (אפס-סנדבוקס, אפס-שרת-אמה):
 *   1. מריץ N טיקים סנכרוניים של השרשרת הדטרמיניסטית — המשך ישיר מתמונת-
 *      המצב הקנונית שבריפו (אותה-שרשרת, אותם-שערי-busy/halted — אפס-עקיפה).
 *   2. קורא תביעות-הפקדה חתומות מהספר הציבורי על Steem (RPC גלוי, חסר-מפתח).
 *   3. מאמת חתימת saos1 (secp256k1 compact + הכתובת הנגזרת) ומתאים את ה-
 *      txid מול ספר-ההפקדות הציבורי שמפרסם הצופה ב-Console.
 *   4. מזכה USDS על שרשרת-הדקס לחשבון המשתמש (עד תקרה; מעבר — למפעיל).
 *   5. מבצע commit לקבצי-השרשרת בריפו (הריפו הוא הבית הקנוני) ורק-אז
 *      מפרסם את המצב הציבורי ל-Console (Pages) — סדר-אמת: קודם-השרשרת,
 *      אחר-כך-הפרסום. דחיפה שנדחתה = הרצה-מתנגשת — הפרסום נמנע בכנות.
 *
 * דגם-האמון (מוצהר בגלוי): הפעימה היא ה-relayer — כמו-הלב של SAOS-LIVE.
 * היא חותמת-על-הזיכויים בסמכות-האוצר של השרשרת-שלה, וכל-זיכוי מתועד
 * בספר-החי עם האסמכתא. מי-שמחזיק-את-המטבעות-האמיתיים שהופקדו הוא האוצר
 * (כתובות-הצבא) — USDS הוא זכות-פדיון מתועדת, לא-טענת-גשר-נטול-אמון.
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import bs58 from "bs58";

/* ── סביבה לפני-כל-ייבוא-של-המנוע (db.ts מאמת בטעינת-מודול) ──
 * בכוח-ולא-ב-??=: סביבת-אם (סנדבוקס) מזריקה לפעמים DATABASE_URL של-עצמה
 * (custom.db) — הלב הוא-הבעלים-היחיד של-ה-db-שלו וקובע-אותו תמיד. שומר-ה-db
 * של-המנוע תופס-בדיוק-את-זה אילו-דלף — הכיוון הזה חד-חד-ערכי. */
process.env.DATABASE_URL = `file:${path.join(process.cwd(), "db", "dex.db")}`;

const ROOT = process.cwd();
const DB_DIR = path.join(ROOT, "db");
const CREDITS_FILE = path.join(DB_DIR, "dex-credits.json");
const CLOUD_TICKS = Math.max(60, Math.min(2_000, Number(process.env.CLOUD_TICKS ?? 480)));
const STEEM_NODE = "https://api.steemit.com";
const OP_ID = "saos.weave.live.v1";
/** חשבונות-הממסר הציבוריים (הצי + ראש-המסורת) — מהם נקראות התביעות. */
const RELAY_ACCOUNTS = [
  "cashmachine", "headcorner", "haran", "israelnews", "lsa", "macrame",
  "siq", "wic", "wog", "woq", "tov", "ynet",
];
/** תקרת-זיכוי-אוטומטי להפקדה בודדת (USDS). מעבר-לזה — המפעיל מזכה דרך השער. */
const MAX_AUTO_CREDIT_USDS = 250;
/** יחס-זיכוי למטבעות-יציבים: 1:1. האחרים — לפי-פיד-השוק החי. */
const STABLE_1TO1 = new Set(["USDT", "USDC", "USD", "TUSD", "DAI", "FDUSD"]);
const FEED_BY_CUR: Record<string, string> = {
  ETH: "eth", WETH: "eth", SOL: "sol", WSOL: "sol", BTC: "btc", WBTC: "btc",
  TRX: "trx", WTRX: "trx", STEEM: "steem", WSTEEM: "steem", HIVE: "hive",
};

/* ── קריפטו-עזר: אותן-הגזרות-בדיוק של saos-live (החוזה הקנוני) ── */
const sha256 = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());
const rmd160 = (b: Uint8Array) => new Uint8Array(createHash("ripemd160").update(b).digest());
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const utf8 = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));
const cat = (...bs: Uint8Array[]) => {
  const total = bs.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const b of bs) { out.set(b, o); o += b.length; }
  return out;
};

/** Canonical JSON: מפתחות ממוינים-רקורסיבית, בלי-רווחים. החוזה. */
function canon(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canon((v as Record<string, unknown>)[k])).join(",") + "}";
}

const ADDR_RE = /^saos1[1-9A-HJ-NP-Za-km-z]{33,35}$/;
const PUB_RE = /^STM[1-9A-HJ-NP-Za-km-z]{50}$/;
const SIG_RE = /^[0-9a-f]{130}$/;

function stmToPub33(stm: string): Uint8Array | null {
  try {
    const raw = bs58.decode(stm.slice(3));
    if (raw.length !== 37) return null;
    return new Uint8Array(raw.slice(0, 33));
  } catch { return null; }
}

function addressFromPub33(pub33: Uint8Array): string {
  const payload = rmd160(sha256(pub33));
  const chk = sha256(sha256(payload)).slice(0, 4);
  return "saos1" + bs58.encode(cat(payload, chk));
}

/** אימות-מעטפת saos1: החתימה משחזרת-בדיוק-את-המפתח + הכתובת נגזרת-ממנו. */
function verifyEnvelope(env: Record<string, unknown>): boolean {
  if (typeof env.pub !== "string" || !PUB_RE.test(env.pub)) return false;
  if (typeof env.sig !== "string" || !SIG_RE.test(env.sig)) return false;
  if (typeof env.by !== "string" || !ADDR_RE.test(env.by)) return false;
  const pub33 = stmToPub33(env.pub);
  if (!pub33) return false;
  const { sig, ...sans } = env;
  const digest = sha256(utf8(canon(sans)));
  try {
    const raw = unhex(sig);
    if (raw.length !== 65) return false;
    const rec = raw[0] - 31;
    if (rec < 0 || rec > 3) return false;
    const compact = raw.slice(1, 65);
    const nobleSig = secp256k1.Signature.fromCompact(compact).addRecoveryBit(rec);
    const point = nobleSig.recoverPublicKey(digest);
    const recovered = point.toRawBytes(true);
    if (hex(recovered) !== hex(pub33)) return false;
    return addressFromPub33(pub33) === env.by;
  } catch { return false; }
}

/* ── ספר-זיכויים מקומי (אידמפוטנטיות: אסמכתא-יחידה נזקפת-פעם-אחת) ── */
interface CreditRec {
  id: string; at: string; to: string; cur: string; claimed: string;
  txid: string; chain: string; usds: number; mu: number; rate: number; how: string;
}
interface CreditsLedger {
  version: 1;
  credits: CreditRec[];
  processedTxids: Record<string, 1>;
  processedIds: Record<string, 1>;
  /** הבלוק האחרון שנסרק בסריקת-הרשת (self-serve) — 0 = עדיין לא. */
  lastScanBlock?: number;
}
function loadLedger(): CreditsLedger {
  try {
    const raw = JSON.parse(fs.readFileSync(CREDITS_FILE, "utf8")) as CreditsLedger;
    if (raw && raw.version === 1 && Array.isArray(raw.credits)) return raw;
  } catch { /* ראשון */ }
  return { version: 1, credits: [], processedTxids: {}, processedIds: {} };
}
function saveLedger(l: CreditsLedger): void {
  l.credits = l.credits.slice(-400);
  const tmp = CREDITS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(l, null, 1));
  fs.renameSync(tmp, CREDITS_FILE);
}

/* ── Steem: קריאת-הספר הציבורי (חסר-מפתח, קריאה-בלבד) ── */
/* ── סריקת-רשת: תביעות ששודרו מכל חשבון Steem (self-serve) ──
 * get_account_history רואה רק את חשבונות-הממסר. משתמש שמשדר את התביעה
 * מהחשבון שלו נתפס כאן: סורקים את חלון-הבלוקים מאז-הסריקה האחרונה
 * (JSON-RPC באצוות-10, מדידה: ~1.1s לאצווה) ומלקטים custom_json עם
 * מזהה-הפעולה שלנו מכל כותב שהוא. החתימה הפנימית (saos1) היא הסמכות
 * — התעבורה רק מסיעה. תקרת-חלון: 2400 בלוקים (~2ש'); פער גדול יותר
 * נרשם בכנות וממשיך מההווה. */
const SCAN_BATCH = 10;
const SCAN_MAX_BLOCKS = 2400;
const SCAN_CONCURRENCY = 3;
async function scanNetworkClaims(ledger: CreditsLedger): Promise<Record<string, unknown>[]> {
  let head = 0;
  for (let i = 0; i < 3 && !head; i++) {
    const props = await steemRpc<{ head_block_number?: number }>("condenser_api.get_dynamic_global_properties", []);
    head = Number(props?.head_block_number ?? 0);
    if (!head) await new Promise((r) => setTimeout(r, 2_000));
  }
  if (!head) { console.warn("[cloud-beat] scanNetwork: head unknown — skipped this beat"); return []; }
  const last = Number(ledger.lastScanBlock ?? 0);
  let from = last > 0 ? last - 12 : head - 20; // חפיפת-ביטחון 12 בלוקים
  if (head - from > SCAN_MAX_BLOCKS) {
    console.warn(`[cloud-beat] scan gap ${head - from} blocks > cap — resuming from head-${SCAN_MAX_BLOCKS} (older claims: use the gate relay)`);
    from = head - SCAN_MAX_BLOCKS;
  }
  const out: Record<string, unknown>[] = [];
  const blockNos: number[] = [];
  for (let b = from + 1; b <= head; b++) blockNos.push(b);
  let cursor = 0;
  const worker = async () => {
    while (cursor < blockNos.length) {
      const mine = blockNos.slice(cursor, cursor + SCAN_BATCH);
      cursor += SCAN_BATCH;
      const reqs = mine.map((b, i) => ({ jsonrpc: "2.0", id: i + 1, method: "condenser_api.get_ops_in_block", params: [b, false] }));
      try {
        const ac = new AbortController();
        const tm = setTimeout(() => ac.abort(), 25_000);
        const r = await fetch(STEEM_NODE, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(reqs), signal: ac.signal,
        });
        clearTimeout(tm);
        if (!r.ok) throw new Error(String(r.status));
        const arr = (await r.json()) as Array<{ result?: Array<{ op?: [string, Record<string, unknown>] }> }>;
        for (const res of arr) {
          for (const entry of res?.result ?? []) {
            const op = entry?.op;
            if (!op || op[0] !== "custom_json") continue;
            const body = op[1] as { id?: string; json?: string };
            if (body?.id !== OP_ID || typeof body.json !== "string") continue;
            try { out.push(JSON.parse(body.json) as Record<string, unknown>); } catch { /* הקיפול ידחה בכנות */ }
          }
        }
      } catch {
        await new Promise((r2) => setTimeout(r2, 1_500)); // אצווה אחת נפלה — ממשיכים, הבאה בפעימה הבאה
      }
    }
  };
  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
  ledger.lastScanBlock = head;
  console.log(`[cloud-beat] network scan: blocks ${from + 1}..${head} → ${out.length} envelopes (any-account self-serve)`);
  return out;
}

async function steemRpc<T>(method: string, params: unknown[]): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 15_000);
      const r = await fetch(STEEM_NODE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: attempt + 1, method, params }),
        signal: ac.signal,
      });
      clearTimeout(t);
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as { result?: T };
      if (j.result !== undefined) return j.result;
      throw new Error("no-result");
    } catch (e) {
      if (attempt === 1) { console.warn(`[cloud-beat] steem ${method} failed: ${String(e).slice(0, 80)}`); return null; }
      await new Promise((r2) => setTimeout(r2, 1_200));
    }
  }
  return null;
}

interface DepositEntry {
  txid: string; chain: string; asset: string; amount: number;
  to: string; from?: string; ts?: number; confirmations?: number;
}
async function readPublicDeposits(): Promise<DepositEntry[]> {
  try {
    const r = await fetch("https://roshpinacare-sys.github.io/Console/dex/deposits.json", { cache: "no-store" });
    if (!r.ok) return [];
    const j = (await r.json()) as { deposits?: DepositEntry[] };
    return Array.isArray(j.deposits) ? j.deposits : [];
  } catch { return []; }
}

/* ── עזרי-git (הריצה חיה בתוך-checkout של-Actions) ── */
function git(args: string, opts: { allowFail?: boolean } = {}): string {
  try {
    return execSync(`git ${args}`, { encoding: "utf8", cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    if (opts.allowFail) return "";
    throw e;
  }
}

async function pushWithRetry(dir: string, branch: string, tries = 3): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      execSync(`git push origin ${branch}`, { encoding: "utf8", cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
      return true;
    } catch {
      try {
        execSync(`git pull --rebase --autostash origin ${branch}`, { encoding: "utf8", cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
      } catch { /* ננסה שוב */ }
      await new Promise((r) => setTimeout(r, 1_500));
    }
  }
  return false;
}

/* ═════════════════════════ main ═════════════════════════ */
async function main(): Promise<void> {
  const t0 = Date.now();
  console.log(`[cloud-beat] boot · ticks=${CLOUD_TICKS} · db=${process.env.DATABASE_URL}`);

  const chain = await import("./src/lib/dex/chain");
  const { ensureChain, stepOnce, oracleTickOnce, stopLoops, forceFlush } = chain as {
    ensureChain: () => { pendingLoad: boolean; halted: boolean; haltReason: string | null; st: { height: number } };
    stepOnce: () => Promise<void>;
    oracleTickOnce: (force?: boolean) => Promise<void>;
    stopLoops: () => void;
    forceFlush: () => void;
  };

  const rt = ensureChain();
  const waitLoad = async () => {
    const t = Date.now();
    while (rt.pendingLoad && Date.now() - t < 90_000) await new Promise((r) => setTimeout(r, 300));
  };
  await waitLoad();
  if (rt.halted) {
    console.error(`[cloud-beat] chain HALTED — refusing to advance. reason: ${rt.haltReason ?? "?"}`);
    process.exit(1);
  }
  stopLoops(); // ריצה-עננית: בלי-טיימרי-קיר — צעדים-סנכרוניים בלבד
  const heightBefore = rt.st.height;
  console.log(`[cloud-beat] chain loaded · height ${heightBefore}`);

  // פיד-האורקל: רענון-מחירים חי לפני-הטיקים + בכל-~120 טיקים
  await oracleTickOnce().catch(() => {});
  let ticked = 0;
  for (let i = 0; i < CLOUD_TICKS; i++) {
    await stepOnce();
    ticked++;
    if (rt.halted) {
      console.error(`[cloud-beat] HALTED mid-run after ${ticked} ticks: ${rt.haltReason ?? "?"}`);
      break;
    }
    if (i > 0 && i % 120 === 0) await oracleTickOnce(true).catch(() => {}); // R23: force — פיד-טרי, החלקה-נוספת
  }
  forceFlush();
  const heightAfter = rt.st.height;
  console.log(`[cloud-beat] advanced ${heightBefore} → ${heightAfter} (${ticked} ticks, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  /* ── תביעות-הפקדה מהספר הציבורי: חשבונות-ממסר + סריקת-רשת (self-serve) ── */
  const ledger = loadLedger();
  const envelopes: Record<string, unknown>[] = [];
  const seenIds = new Set<string>();
  const pushEnv = (e: Record<string, unknown>) => {
    const id = typeof e?.id === "string" ? e.id : "";
    if (id) { if (seenIds.has(id)) return; seenIds.add(id); }
    envelopes.push(e);
  };
  for (const acc of RELAY_ACCOUNTS) {
    // מגבלת-condenser: 100 לקריאה. הלב קורא את-100-האחרונות לכל-חשבון-ממסר
    // (תביעות הן-טריות-מטבען; סריקה-עמוקה יותר מתבצעת באימות-העצמאי שבאתר).
    const hist = await steemRpc<Array<[number, { op?: [string, Record<string, unknown>] } ]>>("condenser_api.get_account_history", [acc, -1, 100]);
    if (!Array.isArray(hist)) continue;
    for (const [, entry] of hist) {
      const op = entry?.op;
      if (!op || op[0] !== "custom_json") continue;
      const body = op[1] as { id?: string; json?: string };
      if (body?.id !== OP_ID || typeof body.json !== "string") continue;
      try { pushEnv(JSON.parse(body.json) as Record<string, unknown>); } catch { /* גם-הקיפול-דוחה בכנות */ }
    }
  }
  for (const e of await scanNetworkClaims(ledger)) pushEnv(e);
  console.log(`[cloud-beat] public book: ${envelopes.length} envelopes (12 relay accounts + network scan)`);

  const deposits = await readPublicDeposits();
  const byTxid = new Map(deposits.map((d) => [String(d.txid).toLowerCase(), d]));

  // פיד-שוק לשער-זיכוי מטבעות-לא-יציבים
  let feeds: Record<string, number> = {};
  try {
    const pp = await import("./src/lib/dex/price-proof");
    /* המרה-דו-שלבית (Task 35): טיפוס-המודול האמיתי אינו-חופף-מספיק לחתימה — בלי-unknown
     * המהדר מסרב (TS2352) וחוסם את הבנייה כולה. ההמרה כאן רק מצהירה-על-החלק-שבו-משתמשים. */
    const f = await (pp as unknown as { extFeeds: (force?: boolean) => Promise<Record<string, number>> }).extFeeds(true);
    feeds = f ?? {};
  } catch (e) { console.warn(`[cloud-beat] extFeeds unavailable: ${String(e).slice(0, 60)}`); }

  const { submitOp, nextNonce } = chain as unknown as {
    submitOp: (op: Record<string, unknown>) => { queued: boolean; reason?: string };
    nextNonce: (p: string) => string;
  };

  let credited = 0, skipped = 0;
  for (const env of envelopes) {
    if (env?.k !== "deposit.claim") continue;
    if (typeof env.id !== "string" || ledger.processedIds[env.id]) continue;
    if (!verifyEnvelope(env)) { ledger.processedIds[String(env.id)] = 1; skipped++; continue; }
    const cur = String(env.cur ?? "").toUpperCase();
    const amt = Number(env.amt ?? 0);
    const ref = String(env.ref ?? "").toLowerCase();
    if (!(amt > 0) || !ref) { ledger.processedIds[String(env.id)] = 1; skipped++; continue; }
    const dep = byTxid.get(ref);
    if (!dep) { skipped++; continue; } // עוד-לא-נצפה — תישאר לפעימה-הבאה (לא-נרשמת-כמעובדת)
    if (ledger.processedTxids[dep.txid]) { ledger.processedIds[String(env.id)] = 1; skipped++; continue; }
    const depAsset = String(dep.asset ?? "").toUpperCase();
    if (depAsset && cur !== depAsset && !(cur === "USDT" && depAsset === "USDT")) { skipped++; continue; }
    const depAmt = Number(dep.amount ?? 0);
    if (depAmt > 0 && Math.abs(depAmt - amt) / depAmt > 0.02) { skipped++; continue; } // חוסר-התאמה-בסכום

    // שער: יציבים 1:1 · האחרים לפי-פיד-חי (µUSDS ליחידה)
    let rate = 1;
    if (!STABLE_1TO1.has(cur)) {
      const feed = FEED_BY_CUR[cur];
      const px = feed ? Number(feeds[feed] ?? 0) : 0;
      if (!(px > 0)) { console.warn(`[cloud-beat] no live rate for ${cur} — claim ${String(env.id).slice(0, 10)} waits`); skipped++; continue; }
      rate = px;
    }
    const usds = Math.floor(amt * rate * 100) / 100; // סנטימט-שלמות
    if (usds <= 0) { skipped++; continue; }

    if (usds > MAX_AUTO_CREDIT_USDS) {
      console.warn(`[cloud-beat] claim ${String(env.id).slice(0, 10)} = ${usds} USDS > cap ${MAX_AUTO_CREDIT_USDS} — left for operator (gate)`);
      skipped++;
      continue;
    }

    const to = `u:${String(env.by)}`;
    // יחידות-השרשרת: 1000µ = 1 יחידה (אותו-קנון של המנוע — fmtAmtMu מחלק-ב-1000)
    const mu = Math.floor(usds * 1_000);
    const r = submitOp({
      type: "transfer", issuer: "treasury", nonce: nextNonce("cloudcredit"),
      to, asset: "USDS", amount: mu,
    });
    if (!r.queued) { console.warn(`[cloud-beat] credit op rejected: ${r.reason}`); skipped++; continue; }
    // הזיכוי נכנס-לממפול — בלוק-אחד-נוסף מבצע אותו בפועל
    await stepOnce();
    ledger.processedTxids[dep.txid] = 1;
    ledger.processedIds[String(env.id)] = 1;
    ledger.credits.push({
      id: String(env.id), at: new Date().toISOString(), to, cur, claimed: String(env.amt),
      txid: dep.txid, chain: String(dep.chain ?? ""), usds, mu, rate,
      how: `auto · verified vs ${String(dep.chain ?? "?")} watcher + saos1 sig`,
    });
    credited++;
    console.log(`[cloud-beat] credited ${usds} USDS → ${to} (txid ${dep.txid.slice(0, 14)}…, ${cur})`);
  }
  saveLedger(ledger); // תמיד: lastScanBlock חייב להתקדם גם בלי זיכויים (חלון-הסריקה)
  console.log(`[cloud-beat] claims: ${credited} credited, ${skipped} skipped/waiting`);

  /* ── פקודות-מסחר חתומות מהציבור (dex.order / dex.cancel) ──
   * אותו-מודל-האמון כמו-הזיכויים: המעטפה חתומה-saos1 (החתימה מכסה את
   * כל-השדות), הלב מתרגם אותה ל-op מקומי בשם הבעלים u:<addr>. השרשרת
   * עצמה אוכפת יתרה/נאמנות/תקרת-פקודות — דחייה היא תשובה כנה, לא-שקט. */
  let ordered = 0, cancelled = 0;
  for (const env of envelopes) {
    if (env?.k !== "dex.order" && env?.k !== "dex.cancel") continue;
    if (typeof env.id !== "string" || ledger.processedIds[env.id]) continue;
    if (!verifyEnvelope(env)) { ledger.processedIds[String(env.id)] = 1; continue; }
    const issuer = `u:${String(env.by)}`;
    if (env.k === "dex.order") {
      const base = String(env.base ?? "").toUpperCase();
      const quote = String(env.quote ?? "").toUpperCase();
      const side = env.side === "buy" ? "buy" : env.side === "sell" ? "sell" : "";
      const price = Math.round(Number(env.price ?? 0) * 1000);   // מחיר-אדם → µ-ציטוט ליחידת-בסיס
      const amount = Math.round(Number(env.amount ?? 0) * 1000); // כמות-אדם → µ-בסיס
      const r = submitOp({ type: "order", issuer, nonce: String(env.id), base, quote, side, price, amount });
      if (r.queued) { ordered++; await stepOnce(); console.log(`[cloud-beat] order ${side} ${amount}µ ${base} @${price}µ ${quote} ← ${issuer.slice(0, 18)}…`); }
      else console.warn(`[cloud-beat] order ${String(env.id).slice(0, 10)} rejected: ${r.reason}`);
    } else {
      const orderId = Number(env.orderId ?? 0);
      const r = submitOp({ type: "cancel", issuer, nonce: String(env.id), orderId });
      if (r.queued) { cancelled++; await stepOnce(); console.log(`[cloud-beat] cancel #${orderId} ← ${issuer.slice(0, 18)}…`); }
      else console.warn(`[cloud-beat] cancel ${String(env.id).slice(0, 10)} rejected: ${r.reason}`);
    }
    ledger.processedIds[String(env.id)] = 1;
  }
  if (ordered || cancelled) saveLedger(ledger);

  forceFlush();

  /* ── שלב-האמת: קודם-commit-השרשרת לריפו, ורק-אז-פרסום-הציבורי ── */
  git("config user.name \"dex-beat[bot]\"", { allowFail: true });
  git("config user.email \"dex-beat[bot]@users.noreply.github.com\"", { allowFail: true });
  const chainFiles = ["db/state-snapshot.json", "db/tape.jsonl", "db/dex.db", "db/dex-credits.json"];
  for (const f of chainFiles) git(`add -- ${f}`, { allowFail: true });
  let chainPushed = false;
  const staged = git("diff --cached --name-only", { allowFail: true });
  if (staged) {
    const msg = `dex-beat: ${new Date().toISOString().slice(0, 19)}Z · h${heightBefore}→h${heightAfter} · ${credited} credits · ${ticked} ticks`;
    git(`commit -m "${msg}"`, { allowFail: true });
    chainPushed = await pushWithRetry(ROOT, "main");
    if (!chainPushed) {
      console.error("[cloud-beat] chain push REJECTED (concurrent beat advanced the repo) — publishing SKIPPED honestly; next run continues from remote");
      process.exit(0);
    }
  } else {
    chainPushed = true; // אין-שינוי-שרשרת (למשל: 0-טיקים) — הפרסום עדיין-אמיתי
  }

  /* ── הפרסום הציבורי ל-Console (Pages) ── */
  const CONSOLE_TOKEN = process.env.CONSOLE_TOKEN ?? "";
  if (!CONSOLE_TOKEN) {
    console.warn("[cloud-beat] CONSOLE_TOKEN missing — public state NOT published (chain is committed)");
    process.exit(0);
  }
  const PUB = "/tmp/console-publish";
  execSync(`rm -rf ${PUB} && git clone --depth 5 -q https://x-access-token:${CONSOLE_TOKEN}@github.com/roshpinacare-sys/Console.git ${PUB}`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  const { getState, getMarkets, getPools, getTape, getProofs } = chain as {
    getState: () => Record<string, unknown>;
    getMarkets: () => unknown[];
    getPools: () => unknown[];
    getTape: (n: number) => unknown[];
    getProofs: () => { seals: unknown[]; receipts: unknown[] };
  };
  const st = getState();
  const publicState = {
    ok: true,
    publishedAt: new Date().toISOString(),
    beat: {
      engine: "saos-dex/1.19 cloud-beat · R23 live-anchor",
      runAt: new Date().toISOString(),
      ticks: ticked,
      fromHeight: heightBefore,
      toHeight: heightAfter,
      cadenceMin: 120,
      nextEtaMin: 120,
      creditsThisRun: credited,
      relayLabel: "cloud relayer — treasury-signed credits, all documented in the live book",
    },
    state: st,
    markets: getMarkets(),
    pools: getPools(),
    wallets: (chain as { getWallets: () => { name: string; balances: Record<string, number>; locked: Record<string, number> }[] }).getWallets(),
    orders: (chain as { ensureChain: () => { st: { orders: unknown[] } } }).ensureChain().st.orders.filter((o) => (o as { live?: boolean }).live === true).slice(-300),
    tape: getTape(40),
    seal: (getProofs().seals ?? [])[0] ?? null,
    credits: ledger.credits.slice(-50),
    creditsTotal: ledger.credits.length,
  };
  fs.mkdirSync(path.join(PUB, "dex"), { recursive: true });
  const stateFile = path.join(PUB, "dex", "state.json");
  fs.writeFileSync(stateFile, JSON.stringify(publicState));
  fs.writeFileSync(path.join(PUB, "dex", "credits.json"), JSON.stringify({
    publishedAt: publicState.publishedAt,
    credits: ledger.credits.slice(-200),
  }, null, 1));

  /* Task 35 — המראה הציבורית של הטרמינל ב-Pages: כל קבצי-המראה (world/relay/agent/fleet/
   * portfolio/bridge/onramp/showcase) בצורות ה-API המדויקות של המוצר — בונה-משותף
   * עם הדמון (src/lib/dex/world-snapshot.ts), אפס סטייה — + stub הגון לשאר. */
  const { buildMirrorSnapshots } = await import("./src/lib/dex/world-snapshot");
  for (const [name, body] of Object.entries(await buildMirrorSnapshots())) {
    fs.writeFileSync(path.join(PUB, "dex", `${name}.json`), JSON.stringify(body));
  }
  fs.writeFileSync(path.join(PUB, "dex", "mirror-stub.json"), JSON.stringify({
    ok: false,
    mirror: true,
    note: "Not available in the public mirror — this runs on the sovereign side",
  }));

  execSync('git config user.name "dex-beat[bot]"', { encoding: "utf8", cwd: PUB });
  execSync('git config user.email "dex-beat[bot]@users.noreply.github.com"', { encoding: "utf8", cwd: PUB });
  execSync("git add dex/state.json dex/credits.json dex/world.json dex/relay.json dex/agent.json dex/fleet.json dex/portfolio.json dex/bridge.json dex/onramp.json dex/showcase.json dex/mirror-stub.json", { encoding: "utf8", cwd: PUB, stdio: ["ignore", "pipe", "pipe"] });
  const stagedPub = execSync("git diff --cached --name-only", { encoding: "utf8", cwd: PUB }).trim();
  if (stagedPub) {
    execSync(`git commit -m "dex-beat: h${heightAfter} · ${credited} credits · ${new Date().toISOString().slice(0, 16)}Z"`, { encoding: "utf8", cwd: PUB, stdio: ["ignore", "pipe", "pipe"] });
    const ok = await pushWithRetry(PUB, "main");
    console.log(`[cloud-beat] public state ${ok ? "published" : "PUSH FAILED (will retry next beat)"}`);
  } else {
    console.log("[cloud-beat] public state unchanged");
  }
  console.log(`[cloud-beat] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
}

main().catch((e) => {
  console.error("[cloud-beat] FATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
